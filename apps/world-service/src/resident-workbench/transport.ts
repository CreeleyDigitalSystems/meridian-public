import { LIMITS, TOOLS, WorkbenchError } from './contract.js';
import { closedDiagnostic, diagnosticFor, readDiagnostic, type FailureDiagnostic } from './diagnostic.js';

export interface Usage { inputTokens:number; outputTokens:number; totalTokens:number }
export interface ToolCall { type:'function_call'; call_id:string; name:string; arguments:string }
export interface ProviderReply { output:Record<string,unknown>[]; call:ToolCall; usage:Usage }
export class TransportError extends WorkbenchError {
  readonly usage:Usage|null;
  readonly diagnostic:FailureDiagnostic;
  constructor(code:string, usage:Usage|null = null, diagnostic:FailureDiagnostic=closedDiagnostic('unknown')) { super(code); this.usage = usage; this.diagnostic=readDiagnostic(diagnostic)??closedDiagnostic('unknown'); }
}
/** A real model tokenizer may reject here. Byte caps alone are not token/spend enforcement. */
export type GenerationPayload=Readonly<Record<string,unknown>>;
export interface TokenPreflight { check(payload:GenerationPayload,signal:AbortSignal):Promise<void> }
export interface PhaseObservation {phase:'count'|'generation';startedAt:number;latencyMs:number;termination:'completed'|'request-deadline'|'session-deadline'|'aborted'|'failed';completed:boolean;diagnostic?:FailureDiagnostic}
/** Finite client ownership. Cancellation seals guarded requests synchronously; late results are never adopted. */
export async function networkPhase<T>(signal:AbortSignal,operation:(signal:AbortSignal)=>Promise<T>,observe?:(value:Omit<PhaseObservation,'phase'>)=>void):Promise<T> {
 const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]),startedAt=Date.now();
 const timer=setTimeout(()=>controller.abort(new WorkbenchError('request-deadline')),LIMITS.requestMs);
 let onAbort:()=>void=()=>{},termination:PhaseObservation['termination']='completed',diagnostic:FailureDiagnostic|undefined;
 try {
  combined.throwIfAborted();
  const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(combined.reason);combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();});
  return await Promise.race([operation(combined),aborted]);
 }catch(error){termination=combined.aborted?(combined.reason instanceof WorkbenchError&&['request-deadline','session-deadline'].includes(combined.reason.code)?combined.reason.code as 'request-deadline'|'session-deadline':'aborted'):'failed';diagnostic=combined.aborted?closedDiagnostic(termination==='failed'?'unknown':termination as 'request-deadline'|'session-deadline'|'aborted'):diagnosticFor(error);throw combined.aborted?combined.reason:error;}
 finally{clearTimeout(timer);combined.removeEventListener('abort',onAbort);observe?.({startedAt,latencyMs:Math.max(0,Date.now()-startedAt),termination,completed:termination==='completed',...(diagnostic?{diagnostic}:{})});}
}
export function freezePayload<T>(value:T):T {if(value&&typeof value==='object'){for(const v of Object.values(value))freezePayload(v);Object.freeze(value);}return value;}
export function generationPayload(model:string,input:Record<string,unknown>[]):GenerationPayload {
 return freezePayload(JSON.parse(JSON.stringify({model,store:false,stream:false,max_output_tokens:LIMITS.outputTokens,
  service_tier:'default',reasoning:{effort:'low'},parallel_tool_calls:false,tools:TOOLS,tool_choice:'required',input})) as GenerationPayload);
}

export class ResponsesWorkbenchTransport {
  #key:string;
  #model:string;
  #request:typeof fetch;
  #phases:PhaseObservation[]=[];
  phaseObservations():PhaseObservation[]{return structuredClone(this.#phases);}
  private readonly preflight:TokenPreflight|undefined;

  constructor(configuration:{apiKey:string; model:string}, request:typeof fetch = fetch, preflight?:TokenPreflight) {
    this.#key = configuration.apiKey.trim();
    this.#model = configuration.model.trim();
    this.#request = request;
    this.preflight = preflight;
    if (!this.#key || !this.#model) throw new TypeError('explicit model and key required');
  }

  async next(input:Record<string,unknown>[], signal:AbortSignal):Promise<ProviderReply> {
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > LIMITS.inputBytes) throw new TransportError('input-budget');
    const payload=generationPayload(this.#model,input);
    if(Buffer.byteLength(JSON.stringify(payload))>LIMITS.inputBytes)throw new TransportError('input-budget');
    if(this.preflight)await networkPhase(signal,phaseSignal=>this.preflight!.check(payload,phaseSignal),value=>this.#phases.push({phase:'count',...value}));
    signal.throwIfAborted();
    return networkPhase(signal,phaseSignal=>this.generate(payload,phaseSignal),value=>this.#phases.push({phase:'generation',...value}));
  }

  private async generate(payload:GenerationPayload,signal:AbortSignal):Promise<ProviderReply> {
    let response:Response;
    try { response = await this.#request('https://api.openai.com/v1/responses', {
      method:'POST', redirect:'error', signal,
      headers:{'content-type':'application/json', authorization:`Bearer ${this.#key}`},
      body:JSON.stringify(payload),
    }); } catch(error) {if(error instanceof TransportError)throw error;throw new TransportError('unavailable',null,diagnosticFor(error,'network-failure'));}
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new TransportError('unavailable',null,closedDiagnostic(!response.ok?'http-status':response.redirected?'redirect':'missing-body',!response.ok?response.status:null));
    }
    const reader = response.body.getReader(), chunks:Uint8Array[] = [];
    let bytes = 0, raw:any;
    try {
      for (;;) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > LIMITS.responseBytes) throw new TransportError('response-budget',null,closedDiagnostic('response-budget'));
        chunks.push(chunk.value);
      }
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new TransportError('malformed',null,closedDiagnostic('malformed-json')); }
    } catch(error) {throw new TransportError(error instanceof TransportError?error.code:'unavailable',null,diagnosticFor(error,'network-failure'));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }

    const u = raw?.usage, numbers = [u?.input_tokens, u?.output_tokens, u?.total_tokens];
    if (!numbers.every(n => Number.isSafeInteger(n) && n >= 0) || u.total_tokens !== u.input_tokens + u.output_tokens) throw new TransportError('invalid-usage',null,closedDiagnostic('response-shape'));
    const usage = {inputTokens:u.input_tokens, outputTokens:u.output_tokens, totalTokens:u.total_tokens};
    const reject = (code:string):never => { throw new TransportError(code,usage,closedDiagnostic('response-shape')); };
    if (u.output_tokens > LIMITS.outputTokens) reject('output-budget');
    if (raw.status !== 'completed') reject(raw.status === 'incomplete' ? 'incomplete' : 'malformed');
    if (!Array.isArray(raw.output)) reject('malformed');
    if (raw.output.some((x:any) => x?.type === 'message' && Array.isArray(x.content) && x.content.some((c:any) => c?.type === 'refusal'))) reject('refusal');
    const calls = raw.output.filter((x:any) => x?.type === 'function_call');
    if (calls.length > 1) reject('multiple-calls');
    if (calls.length !== 1 || raw.output.some((x:any) => !x || !['function_call','reasoning'].includes(x.type))) reject('malformed');
    const call = calls[0];
    if (typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > 128 || typeof call.name !== 'string'
      || typeof call.arguments !== 'string' || (call.status !== undefined && call.status !== 'completed')) reject('malformed');
    if (!TOOLS.some(t => t.name === call.name)) reject('unknown-tool');
    // Known-tool argument JSON/schema validation belongs to the session's bounded repair boundary.
    // Preserve the exact original argument string in volatile continuation; never persist it as diagnostics.
    // Required reasoning and response items remain private in-memory continuation, never journal/prose.
    return {output:raw.output, call, usage};
  }
}
