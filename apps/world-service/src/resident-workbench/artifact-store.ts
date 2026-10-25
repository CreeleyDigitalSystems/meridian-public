import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContextSchema, JournalSchema, TerminationSchema, MetricSchema, LIMITS, SubmitSchema, sourceDigest, digest, canonical, caseInputHash, isHostIntervention, WorkbenchError, type WorkbenchContext, type ModuleOutput, type ToolArgumentFailure } from './contract.js';

export interface Artifact {
  hash:string; actor:string; session:string; contextHash:string; source:string; sourceHash:string; revision:number; parent:string|null;
}
export interface CaseResult {
  inputHash:string; passed:boolean; code:'measured'|'execution-failed'|'invalid-output'|'invalid-graph'|'nondeterministic';
  quality:number|null; duration:number|null; design:ModuleOutput|null;
}
export interface Receipt {
  hash:string; actor:string; session:string; contextHash:string; artifact:string; fixtureSet:string; fixtureHash:string; passed:boolean; results:CaseResult[];
}
export interface Observation {
  actor:string; generation:string; minute:number; need:string; site:string; siteRevision:number; contextHash:string;
}
export interface BridgeProposal {
  kind:'workbench-method'; artifact:string; receipt:string; sourceHash:string; observation:Observation; design:ModuleOutput; hash:string;
}
export interface Metric {
  request:number; inputTokens:number|null; outputTokens:number|null; totalTokens:number|null; latencyMs:number; termination:string;
  toolFailure?:ToolArgumentFailure|undefined;
}
interface Journal {
  version:1; context:WorkbenchContext; createdAt:number; artifacts:Artifact[]; receipts:Receipt[]; proposals:BridgeProposal[];
  requests:number; metrics:Metric[]; termination:string|null;
}
function freeze<T>(value:T):T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const invalid = ():never => { throw new WorkbenchError('invalid-journal'); };

export class WorkbenchStore {
  readonly context:WorkbenchContext;
  readonly contextHash:string;
  /** The observed need's case identity. Only a passing result with this hash can be proposed. */
  readonly currentInputHash:string;
  readonly path:string;
  #state:Journal;
  #diskHash:string|undefined;

  private constructor(path:string, state:Journal) {
    this.path = path;
    this.#state = state;
    this.context = freeze(structuredClone(state.context));
    this.contextHash = digest(this.context);
    this.currentInputHash = caseInputHash(this.context);
    this.#diskHash = existsSync(path) ? digest(state) : undefined;
  }

  static open(path:string, raw:unknown):WorkbenchStore {
    const context = ContextSchema.parse(raw);
    let state:Journal;
    if (existsSync(path)) {
      if (statSync(path).size > 1800000) invalid();
      state = JournalSchema.parse(JSON.parse(readFileSync(path,'utf8')));
      if (digest(state.context) !== digest(context)) invalid();
    } else state = {version:1, context, createdAt:Date.now(), artifacts:[], receipts:[], proposals:[], requests:0, metrics:[], termination:null};
    const store = new WorkbenchStore(path,state);
    store.validate();
    if (!existsSync(path)) store.save();
    return store;
  }

  private currentCase(receipt:Receipt) {
    return receipt.results.find(result => result.inputHash === this.currentInputHash);
  }

  private validate() {
    const s = JournalSchema.parse(this.#state);
    if (s.metrics.length > s.requests || s.metrics.some((m,i) => m.request > s.requests || (i > 0 && m.request <= s.metrics[i-1]!.request))) invalid();
    const sources = new Set<string>(), receipts = new Set<string>(), tested = new Set<string>();
    for (const [i,a] of s.artifacts.entries()) {
      const {hash,...value} = a;
      if (a.actor !== this.context.actor || a.session !== this.context.session || a.contextHash !== this.contextHash
        || a.revision !== i+1 || a.parent !== (i ? s.artifacts[i-1]!.hash : null) || digest(value) !== hash
        || sourceDigest(a.source) !== a.sourceHash || sources.has(a.sourceHash)) invalid();
      sources.add(a.sourceHash);
    }
    for (const r of s.receipts) {
      const {hash,...value} = r, test = `${r.artifact}:${r.fixtureHash}`;
      if (r.actor !== this.context.actor || r.session !== this.context.session || r.contextHash !== this.contextHash
        || !s.artifacts.some(a => a.hash === r.artifact) || r.passed !== r.results.every(x => x.passed)
        || digest(value) !== hash || receipts.has(hash) || tested.has(test)) invalid();
      receipts.add(hash);
      tested.add(test);
    }
    for (const p of s.proposals) {
      const {hash,...value} = p, r = s.receipts.find(r => r.hash === p.receipt && r.artifact === p.artifact && r.passed);
      if (digest(value) !== hash || !r || p.sourceHash !== s.artifacts.find(a => a.hash === p.artifact)?.sourceHash
        || canonical(p.observation) !== canonical(this.observation()) || canonical(p.design) !== canonical(this.currentCase(r)?.design)) invalid();
    }
  }

  private save() {
    // One owning host writer. Reject a reopened stale instance before it can replace a newer revision.
    const changed = existsSync(this.path) ? digest(JSON.parse(readFileSync(this.path,'utf8'))) !== this.#diskHash : this.#diskHash !== undefined;
    if (changed) throw new WorkbenchError('stale-writer');
    const temporary = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), {recursive:true, mode:0o700});
    writeFileSync(temporary, JSON.stringify(this.#state), {mode:0o600});
    renameSync(temporary, this.path);
    this.#diskHash = digest(this.#state);
  }

  /** Private host inspection only: this contains source and canonical host bindings. */
  snapshot():Journal { return structuredClone(this.#state); }
  observation():Observation {
    const c = this.context;
    return {actor:c.actor, generation:c.generation, minute:c.minute, need:c.need, site:c.site, siteRevision:c.siteRevision, contextHash:this.contextHash};
  }
  /** The only anonymous summary surface: counts and a closed termination code. */
  summary() {
    return {kind:'workbench-summary' as const, versions:this.#state.artifacts.length, tests:this.#state.receipts.length,
      passed:this.#state.receipts.filter(r => r.passed).length, proposed:this.#state.proposals.length === 1,
      requests:this.#state.requests, termination:this.#state.termination, requiresHostIntervention:isHostIntervention(this.#state.termination)};
  }
  artifact(hash:string) {
    const a = this.#state.artifacts.find(a => a.hash === hash);
    if (!a) throw new WorkbenchError('unknown-artifact');
    return structuredClone(a);
  }
  assertActive() {
    const termination = this.#state.termination;
    if (termination && isHostIntervention(termination)) throw new WorkbenchError(termination);
    if (termination) throw new WorkbenchError('terminated');
    if (Date.now() - this.#state.createdAt >= LIMITS.sessionMs) throw new WorkbenchError('session-deadline');
  }

  submit(raw:unknown):Artifact {
    this.assertActive();
    const value = SubmitSchema.parse(raw), s = this.#state, sourceHash = sourceDigest(value.source);
    if (s.proposals.length || s.artifacts.length >= LIMITS.versions || value.revision !== s.artifacts.length+1
      || value.parent !== (s.artifacts.at(-1)?.hash ?? null) || s.artifacts.some(a => a.sourceHash === sourceHash)) throw new WorkbenchError('invalid-lineage');
    const content = {...value, sourceHash, actor:this.context.actor, session:this.context.session, contextHash:this.contextHash};
    const artifact = {...content, hash:digest(content)};
    s.artifacts.push(artifact);
    this.save();
    return structuredClone(artifact);
  }

  receipt(value:Omit<Receipt,'hash'|'actor'|'session'|'contextHash'>):Receipt {
    this.assertActive();
    if (this.#state.proposals.length || this.#state.receipts.length >= LIMITS.receipts) throw new WorkbenchError('receipt-cap');
    this.artifact(value.artifact);
    const content = {...structuredClone(value), actor:this.context.actor, session:this.context.session, contextHash:this.contextHash};
    const receipt = {...content, hash:digest(content)};
    if (this.#state.receipts.some(r => r.artifact === receipt.artifact && r.fixtureHash === receipt.fixtureHash)) throw new WorkbenchError('duplicate-test');
    this.#state.receipts.push(receipt);
    this.save();
    return structuredClone(receipt);
  }

  propose(artifact:string, receipt:string):BridgeProposal {
    this.assertActive();
    if (this.#state.proposals.length) throw new WorkbenchError('duplicate-proposal');
    const a = this.artifact(artifact), r = this.#state.receipts.find(r => r.hash === receipt && r.artifact === a.hash && r.passed);
    if (!r) throw new WorkbenchError('invalid-evidence');
    const current = this.currentCase(r);
    if (!current?.passed || !current.design) throw new WorkbenchError('no-current-case');
    const value = {kind:'workbench-method' as const, artifact, receipt, sourceHash:a.sourceHash,
      observation:this.observation(), design:structuredClone(current.design)};
    const proposal = {...value, hash:digest(value)};
    this.#state.proposals.push(proposal);
    this.save();
    return freeze(structuredClone(proposal));
  }

  beginRequest() {
    this.assertActive();
    if (this.#state.requests >= LIMITS.requests) throw new WorkbenchError('request-budget');
    this.#state.requests++;
    this.save();
    return this.#state.requests;
  }
  metric(metric:Metric) { MetricSchema.parse(metric); this.#state.metrics.push(structuredClone(metric)); this.save(); }
  /** The first final code wins. Only a real unconfirmed removal may supersede a less severe one; host intervention is never cleared. */
  terminate(code:string):string {
    TerminationSchema.parse(code);
    const prior = this.#state.termination;
    if (prior === null || (code === 'cleanup-failed' && prior !== 'cleanup-failed')) {
      this.#state.termination = code;
      this.save();
    }
    return this.#state.termination ?? code;
  }
}
