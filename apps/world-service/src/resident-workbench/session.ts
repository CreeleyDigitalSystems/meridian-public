import { deriveAssemblyDesign, evaluateAssembly } from '@meridian/world-kernel';
import { InventionDesignInputSchema } from '@meridian/world-schema';
import { WorkbenchStore, type CaseResult, type Receipt, type BridgeProposal } from './artifact-store.js';
import { FixtureSchema, LIMITS, OutputSchema, ProposeSchema, TestSchema, digest, canonical, caseInputHash, isHostIntervention, WorkbenchError, type Executor, type FixtureSet, type ModuleOutput, type ToolArgumentFailure } from './contract.js';
import { composeWorkbenchRequest } from '../resident-request-composer.js';
import { ResponsesWorkbenchTransport, TransportError, type Usage } from './transport.js';
import { validateToolArguments, type ValidatedTool } from './tool-validation.js';

export const MODULE_REFERENCE = `Write an ESM export function design(input) returning exactly {parts,claim}. Input contains envelope, skill, condition, materials. Tools: submit_module, test_module, propose_method. Tests and grading belong to trusted host. These are inert proposals, with no world effects.
Grammar: 2..6 ordered parts {n,k,x,y,r,parent}; n is zero-based index, root base with parent null; other kinds support/guide/clamp/tray with earlier parent index, orthogonally adjacent unique coordinates0..5; r is axis0 or1. Stone parts base/support have mass4, other timber parts mass1. Carried descendant mass cannot exceed capacity base8/support6/other2. Material cost counts stone/timber parts. Build minutes=2+2*partCount+sum(carried mass at each support), maximum32.
Immutable evaluator1: g=floor(min(2,guide count matching envelope axis)*condition/100), h likewise clamp with max2, t likewise tray max1, s likewise support max2; extra=max(0,partCount-4). Quality=clamp(60+floor(skill/5)+5g+7h+2s-5*load-2*extra,0,100). Duration=clamp(nominalMinutes+ceil(pieces/2)+max(0,load-s)-g-h-t+extra,2,16). Required quality is envelope.precision. Claims are {metric:'duration-minutes' or 'quality-points',relation:'at-most' or 'at-least',value:integer1..100}. A passing claim must also meet required quality and available materials. No graph is guaranteed to win.
Source <=8192 UTF8 bytes; at most8 immutable revisions. Revisions parent the preceding artifact hash. Use approved fixture references only. Saved tests are trusted measurements; public evidence indices are scoped to this input, never authority to change world state.`;
export function judgeWorkbenchOutput(output: ModuleOutput, input: {envelope:FixtureSet['cases'][number]['envelope']; skill:number; condition:number; materials:{stone:number; timber:number}}, need:string, site:string) {
    const design = InventionDesignInputSchema.parse({grammar:1, evaluator:1, need:need, parent:null, site:site, ...output});
    const cost = deriveAssemblyDesign(design), score = evaluateAssembly(design, input.envelope, input.skill, input.condition);
    if (!cost.ok || !score.ok) return null;
    const claim = design.claim, value = claim.metric === 'quality-points' ? score.value.quality : score.value.duration;
    const qualityMet = score.value.passed, claimMet = claim.relation === 'at-most' ? value <= claim.value : value >= claim.value;
    const materialsMet = cost.value.bom.stone <= input.materials.stone && cost.value.bom.timber <= input.materials.timber;
    return {quality:score.value.quality, duration:score.value.duration, passed:qualityMet && claimMet && materialsMet, qualityMet, claimMet, materialsMet};
  }
let activeSession = false;

export class WorkbenchSession {
  #fixtures: FixtureSet[];
  #busy = false;
  readonly store: WorkbenchStore;
  private readonly executor: Executor;

  constructor(store: WorkbenchStore, fixtures: unknown[], executor: Executor) {
    this.store = store;
    this.executor = executor;
    if (fixtures.length > 8) throw new WorkbenchError('fixture-cap');
    this.#fixtures = fixtures.map(f => FixtureSchema.parse(f));
    if (new Set(this.#fixtures.map(f => f.id)).size !== this.#fixtures.length) throw new WorkbenchError('duplicate-fixtures');
  }

  submit(raw: unknown) { return this.store.submit(raw); }

  async test(raw: unknown, signal?: AbortSignal): Promise<Receipt> {
    this.store.assertActive();
    if (this.#busy) throw new WorkbenchError('busy');
    const args = TestSchema.parse(raw), artifact = this.store.artifact(args.artifact);
    const fixture = this.#fixtures.find(f => f.id === args.fixtureSet);
    if (!fixture) throw new WorkbenchError('unknown-fixture');
    const receipts = this.store.snapshot().receipts;
    if (receipts.some(r => r.artifact === artifact.hash && r.fixtureHash === digest(fixture))) throw new WorkbenchError('duplicate-test');
    if (receipts.length >= LIMITS.receipts) throw new WorkbenchError('receipt-cap');
    this.#busy = true;
    const lifetime = new AbortController();
    const remaining = Math.max(0, LIMITS.sessionMs - (Date.now() - this.store.snapshot().createdAt));
    const deadline = setTimeout(() => lifetime.abort(new WorkbenchError('session-deadline')), remaining);
    const executionSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const runFresh = async (input:unknown) => {
      this.store.assertActive();
      executionSignal.throwIfAborted();
      return this.executor.run(artifact.source, input, executionSignal);
    };
    try {
      const results: CaseResult[] = [];
      for (const c of fixture.cases) {
        // Explicit public numeric input only. Never pass host IDs, the suite or another holdout.
        const input = {envelope:c.envelope, skill:c.skill, condition:c.condition, materials:this.store.context.materials};
        const base = {inputHash:caseInputHash(input), passed:false, quality:null, duration:null, design:null};
        let first: unknown, second: unknown;
        try {
          first = await runFresh(input);
          second = await runFresh(input);
        } catch (error) {
          // A host fault is never the module's result: no receipt, no feedback, blocked until operator recovery.
          if (error instanceof WorkbenchError && isHostIntervention(error.code)) {
            this.store.terminate(error.code);
            throw error;
          }
          if (error instanceof WorkbenchError && error.code === 'session-deadline') throw error;
          if (executionSignal.aborted) {
            const expired = executionSignal.reason instanceof WorkbenchError && executionSignal.reason.code === 'session-deadline';
            throw new WorkbenchError(expired ? 'session-deadline' : 'aborted');
          }
          results.push({...base, code:'execution-failed'});
          continue;
        }
        if (canonical(first) !== canonical(second)) { results.push({...base, code:'nondeterministic'}); continue; }
        const parsed = OutputSchema.safeParse(first);
        if (!parsed.success) { results.push({...base, code:'invalid-output'}); continue; }
        const judged = this.#judge(parsed.data, input);
        if (!judged) { results.push({...base, code:'invalid-graph'}); continue; }
        results.push({inputHash:base.inputHash, code:'measured', quality:judged.quality, duration:judged.duration, passed:judged.passed, design:parsed.data});
      }
      return this.store.receipt({artifact:artifact.hash, fixtureSet:fixture.id, fixtureHash:digest(fixture), passed:results.every(r => r.passed), results});
    } finally { clearTimeout(deadline); this.#busy = false; }
  }

  /** The trusted host judgement of one validated module output on one case input; measurement and feedback share it. */
  #judge(output: ModuleOutput, input: {envelope:FixtureSet['cases'][number]['envelope']; skill:number; condition:number; materials:{stone:number; timber:number}}) { return judgeWorkbenchOutput(output,input,this.store.context.need,this.store.context.site); }

  /**
   * Closed measured feedback for one receipt. Each tested case carries exactly the numeric input the module received,
   * derived from the validated fixture bound to the receipt by fixture hash and case input hash, never from model text.
   * `current` marks the observed need's case: only a passing current case can be proposed. A measured result is re-judged
   * from its stored design and case input, so its facets explain exactly the recorded pass/fail. Null when unverifiable.
   */
  #feedback(receipt: Receipt) {
    const fixture = this.#fixtures.find(f => f.id === receipt.fixtureSet && digest(f) === receipt.fixtureHash);
    const materials = this.store.context.materials, current = this.store.currentInputHash, tested = new Map<string, FixtureSet['cases'][number] & {materials: typeof materials}>();
    for (const c of fixture?.cases ?? []) {
      const input = {envelope:c.envelope, skill:c.skill, condition:c.condition, materials};
      tested.set(caseInputHash(input), input);
    }
    const results = [];
    for (const {code, quality, duration, passed, inputHash, design} of receipt.results) {
      const input = tested.get(inputHash);
      if (!input) return null;
      let facets = {qualityMet:null as boolean|null, claimMet:null as boolean|null, materialsMet:null as boolean|null};
      if (code === 'measured') {
        const judged = (() => { try { return design ? this.#judge(design, input) : null; } catch { return null; } })();
        if (!judged || judged.quality !== quality || judged.duration !== duration || judged.passed !== passed) return null;
        facets = {qualityMet:judged.qualityMet, claimMet:judged.claimMet, materialsMet:judged.materialsMet};
      }
      results.push({code, quality, duration, passed, inputHash, current:inputHash === current, case:input, ...facets});
    }
    return results;
  }

  propose(raw: unknown): BridgeProposal {
    const args = ProposeSchema.parse(raw), receipt = this.store.snapshot().receipts.find(r => r.hash === args.receipt);
    const fixture = receipt && this.#fixtures.find(f => f.id === receipt.fixtureSet);
    if (!fixture || digest(fixture) !== receipt!.fixtureHash) throw new WorkbenchError('stale-evidence');
    return this.store.propose(args.artifact, args.receipt);
  }

  requestPreview(): Record<string, unknown>[] {
    const c = this.store.context, saved = this.store.snapshot(), latest = saved.artifacts.at(-1);
    const context = {envelope:c.envelope, skill:c.skill, condition:c.condition, materials:c.materials,
      evidence:c.evidence.map((e, i) => ({reference:i+1, quality:e.quality, duration:e.duration}))};
    return composeWorkbenchRequest({context,
      fixtureSets:this.#fixtures.map(f => f.id), saved:{
        latest:latest ? {hash:latest.hash, source:latest.source, sourceHash:latest.sourceHash, revision:latest.revision, parent:latest.parent} : null,
        versions:saved.artifacts.map(({hash, revision, parent}) => ({hash, revision, parent})),
        tests:saved.receipts.flatMap(r => { const results = this.#feedback(r); return results ? [{hash:r.hash, artifact:r.artifact, passed:r.passed, results}] : []; }).slice(-8),
      }},MODULE_REFERENCE).messages;
  }

  private async execute(call: ValidatedTool, signal: AbortSignal): Promise<{output: unknown; proposal?: BridgeProposal}> {
    switch (call.name) {
      case 'submit_module': {
        const a = this.submit(call.args);
        return {output:{artifact:a.hash, revision:a.revision, parent:a.parent}};
      }
      case 'test_module': {
        const r = await this.test(call.args, signal), results = this.#feedback(r);
        if (!results) throw new WorkbenchError('stale-evidence');
        return {output:{receipt:r.hash, artifact:r.artifact, passed:r.passed, results}};
      }
      case 'propose_method': {
        const proposal = this.propose(call.args);
        return {output:{proposal:proposal.hash}, proposal};
      }
      default: throw new WorkbenchError('unknown-tool');
    }
  }

  async run(transport: ResponsesWorkbenchTransport, signal?: AbortSignal): Promise<{termination:string; proposal?:BridgeProposal}> {
    // A final session is immutable: a re-run or reopen reports it and writes no request, metric or termination.
    const finished = this.store.snapshot();
    if (finished.termination) return {termination:finished.termination, ...(finished.proposals[0] ? {proposal:finished.proposals[0]} : {})};
    // A crash after recording the third failure but before final termination cannot buy another turn on reopen.
    if(finished.metrics.filter(m=>m.toolFailure!==undefined).length>=3)return {termination:this.store.terminate('invalid-tool-arguments')};
    if (activeSession) throw new WorkbenchError('workbench-busy');
    activeSession = true;
    const controller = new AbortController();
    const remaining = Math.max(0, LIMITS.sessionMs - (Date.now() - this.store.snapshot().createdAt));
    const timer = setTimeout(() => controller.abort(new WorkbenchError('session-deadline')), remaining);
    const onAbort = () => controller.abort(new WorkbenchError('aborted'));
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    const input:Record<string,unknown>[] = [], callIds = new Set<string>();
    let termination = 'malformed', proposal: BridgeProposal | undefined;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        input.splice(0,2,...this.requestPreview());
        const request = this.store.beginRequest(), start = Date.now();
        let abortRequest:(()=>void)|undefined;
        let usage: Usage | null = null, providerLatency: number | undefined, metricTermination = 'completed', toolFailure:ToolArgumentFailure|undefined;
        const requestController = new AbortController(), combined = AbortSignal.any([controller.signal, requestController.signal]);
        const deadline = setTimeout(() => requestController.abort(new WorkbenchError('request-deadline')), 2 * LIMITS.requestMs);
        try {
          // A turn has at most two separately bounded network phases. This outer cap also bounds injected transports.
          const reply = await Promise.race([transport.next(input, combined), new Promise<never>((_, reject) => {
            if (combined.aborted) reject(combined.reason);
            else {abortRequest=()=>reject(combined.reason);combined.addEventListener('abort',abortRequest,{once:true});}
          })]);
          usage = reply.usage;
          providerLatency = Math.max(0, Date.now() - start);
          clearTimeout(deadline);
          if (callIds.has(reply.call.call_id)) throw new WorkbenchError('duplicate-call-id');
          callIds.add(reply.call.call_id);
          let output: unknown;
          const validation=validateToolArguments(reply.call);
          if(!validation.ok){
            toolFailure=validation.failure;
            metricTermination='invalid-tool-arguments';
            if(this.store.snapshot().metrics.filter(m=>m.toolFailure!==undefined).length>=2)throw new WorkbenchError('invalid-tool-arguments');
            output={error:'invalid-tool-arguments',failure:toolFailure};
          }else try { const result = await this.execute(validation.call, controller.signal); output = result.output; proposal = result.proposal; }
          catch (error) {
            if (error instanceof WorkbenchError && isHostIntervention(error.code)) throw error;
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error instanceof WorkbenchError && ['unknown-fixture','unknown-artifact','invalid-evidence','invalid-lineage','duplicate-test','stale-evidence','no-current-case','duplicate-proposal'].includes(error.code)) output = {error:error.code};
            else if (error instanceof WorkbenchError && error.code === 'stale-observation') throw error;
            else throw new WorkbenchError('invalid-tool-arguments');
          }
          input.push(...reply.output, {type:'function_call_output', call_id:reply.call.call_id, output:JSON.stringify(output)});
          if (proposal) { termination = 'proposed'; break; }
        } catch (error) {
          if (error instanceof TransportError) usage = error.usage;
          metricTermination = error instanceof WorkbenchError ? error.code : combined.aborted
            ? (combined.reason instanceof WorkbenchError ? combined.reason.code : 'aborted') : 'unavailable';
          throw new WorkbenchError(metricTermination);
        } finally {
          clearTimeout(deadline);
          if(abortRequest)combined.removeEventListener('abort',abortRequest);
          this.store.metric({request, inputTokens:usage?.inputTokens??null, outputTokens:usage?.outputTokens??null,
            totalTokens:usage?.totalTokens??null, latencyMs:providerLatency??Math.max(0,Date.now()-start), termination:metricTermination,...(toolFailure?{toolFailure}:{})});
        }
      }
    } catch (error) { termination = error instanceof WorkbenchError ? error.code : controller.signal.aborted ? 'aborted' : 'malformed'; }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { termination = this.store.terminate(termination); } finally { activeSession = false; }
    }
    return {termination, ...(proposal ? {proposal} : {})};
  }
}
