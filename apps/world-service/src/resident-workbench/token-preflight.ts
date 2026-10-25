import { LIMITS } from './contract.js';
import { TransportError, networkPhase, type GenerationPayload, type TokenPreflight } from './transport.js';
import { closedDiagnostic, diagnosticFor } from './diagnostic.js';
export const COUNT_ENDPOINT='https://api.openai.com/v1/responses/input_tokens';
/** Only source-documented token-bearing count fields. All continuation/reasoning items are inside input. */
export function countPayload(payload:GenerationPayload):GenerationPayload {
 const body:Record<string,unknown>={model:payload.model,input:payload.input};
 for(const key of ['instructions','tools','tool_choice','parallel_tool_calls','reasoning','text'])if(payload[key]!==undefined)body[key]=payload[key];
 // No conversation/server state: all response/reasoning items must be supplied in input.
 const known=['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','store','stream','max_output_tokens','service_tier'];
 if(Object.keys(payload).some(k=>!known.includes(k)))throw new TransportError('input-budget',null,{version:1,category:'local-validation',status:null,validation:'payload',input:null});
 return body;
}
export async function boundedJson(response:Response,signal:AbortSignal,cap:number=LIMITS.responseBytes):Promise<any>{
 if(!response.ok||response.redirected||!response.body){await response.body?.cancel().catch(()=>{});throw new TransportError('unavailable',null,closedDiagnostic(!response.ok?'http-status':response.redirected?'redirect':'missing-body',!response.ok?response.status:null));}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){signal.throwIfAborted();const c=await reader.read();signal.throwIfAborted();if(c.done)break;bytes+=c.value.byteLength;if(bytes>cap)throw new TransportError('response-budget',null,closedDiagnostic('response-budget'));chunks.push(c.value);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new TransportError('malformed',null,closedDiagnostic('malformed-json'));}}
 catch(error){throw new TransportError(error instanceof TransportError?error.code:'unavailable',null,diagnosticFor(error,'network-failure'));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export class CountingPreflight implements TokenPreflight {
 private readonly request:typeof fetch;
 constructor(request:typeof fetch){this.request=request;}
 async check(payload:GenerationPayload,signal:AbortSignal):Promise<void>{
  await networkPhase(signal,async phaseSignal=>{
   phaseSignal.throwIfAborted();const body=countPayload(payload);
   let response:Response;try{response=await this.request(COUNT_ENDPOINT,{method:'POST',redirect:'error',signal:phaseSignal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch(error){if(error instanceof TransportError)throw error;throw new TransportError('unavailable',null,diagnosticFor(error,'network-failure'));}
   const count=await boundedJson(response,phaseSignal,4096);
   if(count?.object!=='response.input_tokens'||!Number.isSafeInteger(count.input_tokens)||count.input_tokens<0||count.input_tokens>8192)throw new TransportError('input-budget',null,closedDiagnostic('response-shape'));
  });
 }
}
