import { bindFrozenLearnerExecutions } from './learning-execution.js';
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayLedger } from '../store/world-store.js';
import { methodTask, methodApplicability, validateMethodGrades, methodInput, methodRevisionBasis, type MethodIntake, type LearnerIntake, validateLearnerGrades } from '@meridian/world-kernel';
import { MethodOriginSchema, MethodCaseInputSchema, MethodOutputSchema, type MethodOrigin, type MethodApplicability, type MethodTest, type InventionMethod, type WorldSnapshot, type WorldState, type InventionCommand, type LearnerExecution } from '@meridian/world-schema';
import type { LedgerEntry } from '@meridian/world-ledger';
import { WorkbenchStore, type Receipt } from './artifact-store.js';
import { WorkbenchSession, MODULE_REFERENCE } from './session.js';
import { ContextSchema, FixtureSchema, canonical, digest, sourceDigest, caseInputHash, WorkbenchError, type Executor, type ModuleOutput } from './contract.js';
import { ResponsesWorkbenchTransport, type ProviderReply } from './transport.js';
import { validateToolArguments } from './tool-validation.js';
const runnerHash = sourceDigest(readFileSync(fileURLToPath(new URL('../../../../scripts/containment/workbench-runner.mjs', import.meta.url)), 'utf8'));
function privateDirectory(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isAbsolute(raw) || resolve(raw) !== raw || realpathSync(raw) !== raw) throw new WorkbenchError('unconfigured-workbench');
  const info = lstatSync(raw);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new WorkbenchError('unconfigured-workbench');
  for (let path = dirname(raw);; path = dirname(path)) {
    const parent = lstatSync(path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw new WorkbenchError('unconfigured-workbench');
    if (path === dirname(path)) break;
  }
  return raw;
}
interface Dependencies {
  journalDirectory?:string | undefined;
  authority: InventionMethod['authority'];
  runtime: InventionMethod['runtime'];
  executor: Executor;
  bound?: () => void;
  transport: (session: string, origin?: MethodOrigin) => {
    transport: Pick<ResponsesWorkbenchTransport, 'next'>;
    seal: () => void;
  };
}
const configurations = new WeakMap<object, Dependencies>();
/** Explicit offline host double. Its evidence can never claim a production model, tier or sandbox identity. */
export function createDoubleWorkbenchConfiguration(options: {
  executor: Executor;
  journalDirectory?: string;
  next: (input: Record<string, unknown>[], signal: AbortSignal) => Promise<ProviderReply>;
}): object {
  const configuration = Object.freeze({});
  configurations.set(configuration, {
    journalDirectory:privateDirectory(options.journalDirectory),
    authority: {
      kind: 'configured-double'
    },
    runtime: {
      imageId: `sha256:${'0'.repeat(64)}`,
      runnerHash
    },
    executor: options.executor,
    transport: () => ({
      transport: {
        next: options.next
      },
      seal: () => {}
    })
  });
  return configuration;
}
interface OrdinaryLaunch {
  capability: object;
  command: Extract<InventionCommand, { action: 'author-method' }>;
  origin: MethodOrigin;
  state: MethodApplicability;
  scheduled: boolean;
}
interface Live {
  minute: number;
  origin: MethodOrigin;
  state: MethodApplicability;
  abort: AbortController;
  records?: MethodIntake[];
  accepted: boolean;
}
export interface WorkbenchStart {
  actor: string;
  agendaId: string;
  session: string;
  journalPath: string;
  fixtures: unknown[];
  choice?: NonNullable<MethodOrigin['choice']>;
  revisionBasisTrialId?: string | null;
}
export interface ConfiguredWorkbenchBinding {
  learningActor(capability:object):string|undefined;
  ordinaryActor(capability:object):string|undefined;
  learningStarts():object[];
  startLearning(snapshot:WorldSnapshot,generation:string,capability:object):Promise<object|undefined>;
  acceptLearning(capability:object,generation:string,world:WorldState):boolean;
  learnerIntakes():LearnerIntake[];
  canAuthor(actor: string): boolean;
  ordinaryStarts(): object[];
  ordinaryStart(snapshot: WorldSnapshot, generation: string, capability: object): WorkbenchStart | undefined;
  start(snapshot: WorldSnapshot, generation: string, args: WorkbenchStart): Promise<object | undefined>;
  accept(capability: object, generation: string, world: WorldState): boolean;
  intakes(): MethodIntake[];
  committed(before: WorldSnapshot, after: WorldSnapshot, entries: readonly LedgerEntry[]): void;
  close(): void;
}
export function hasConfiguredWorkbench(store: object): boolean { return validators.has(store); }
const validators = new WeakMap<object, (snapshot: WorldSnapshot, entries: readonly LedgerEntry[]) => void>();
/** Called by every real live commit, including direct stores. Historical replay deliberately has no issuer. */
export function validateNewMethodAdmissions(store: object, snapshot: WorldSnapshot, entries: readonly LedgerEntry[]): void {
  if (!entries.some(e => e.event.type === 'invention-method-changed' && e.event.before === null || e.event.type==='invention-grant-changed'&&e.event.after.method&&e.event.after.method.executions.length>(e.event.before?.method?.executions.length??0))) return;
  const validate = validators.get(store);
  if (!validate) throw new WorkbenchError(entries.some(e=>e.event.type==='invention-method-changed'&&e.event.before===null)?'method-admission-authority':'learner-admission-authority');
  validate(snapshot, entries);
}
export function validateMethodHashes(m: InventionMethod): void {
  const c = m.origin.context;
  if (sourceDigest(m.source) !== m.sourceHash || digest(c) !== m.origin.contextHash || digest({
    source: m.source,
    revision: m.revision,
    parent: m.parentArtifactHash,
    sourceHash: m.sourceHash,
    actor: c.actor,
    session: c.session,
    contextHash: m.origin.contextHash
  }) !== m.artifactHash || m.evaluatorHash !== digest(MODULE_REFERENCE)) throw new WorkbenchError('method-evidence-hash');
  for (const t of m.tests) {
    const {
        fixture,
        executions,
        ...receipt
      } = t,
      {
        hash,
        ...body
      } = receipt;
    if (digest(body) !== hash || digest(fixture) !== t.fixtureHash) throw new WorkbenchError('method-receipt-hash');
    for (const e of executions) if (caseInputHash(e.input) !== e.inputHash || e.first !== null && e.firstHash !== digest(e.first) || e.second !== null && e.secondHash !== digest(e.second)) throw new WorkbenchError('method-execution-hash');
  }
  validateMethodGrades(m);
}
export function validateLearnerHashes(e:LearnerExecution):void {
 if(digest(e.context)!==e.contextHash)throw new WorkbenchError('learner-context-hash');
 const {fixture,executions,hash,...body}=e.test;
 if(digest(body)!==hash||digest(fixture)!==e.test.fixtureHash)throw new WorkbenchError('learner-receipt-hash');
 for(const x of executions)if(caseInputHash(x.input)!==x.inputHash||x.first!==null&&digest(x.first)!==x.firstHash||x.second!==null&&digest(x.second)!==x.secondHash)throw new WorkbenchError('learner-execution-hash');
 validateLearnerGrades(e);
}
export function assertWorkbenchConfiguration(configuration: object): void {
  if (!configurations.has(configuration)) throw new WorkbenchError('unconfigured-workbench');
}
/** The binder receives an opaque host configuration; it returns consumers, never an issuer or serializable trust flag. */
export function bindConfiguredWorkbench(configuration: object, store: object): ConfiguredWorkbenchBinding {
  const deps = configurations.get(configuration);
  if (!deps || validators.has(store)) throw new WorkbenchError('unconfigured-workbench');
  configurations.delete(configuration);
  const capabilities = new WeakMap<object, Live>(),
    live = new Set<Live>(),
    pending: Live[] = [],
    sessions = new Set<string>(),
    launches = new Set<OrdinaryLaunch>(),
    launchCapabilities = new WeakMap<object, OrdinaryLaunch>(),
    ordinaryArguments = new WeakMap<WorkbenchStart, string>();
  const learning=bindFrozenLearnerExecutions(deps);
  let closed = false;
  const intakes = () => pending.flatMap(x => x.records ?? []).map(x => structuredClone(x));
  validators.set(store, (snapshot, entries) => {
    const actual = entries.flatMap(e => e.event.type === 'invention-method-changed' && e.event.before === null ? [e.event] : []),
      expected = intakes();
    if (actual.length > expected.length) throw new WorkbenchError('method-admission-authority');
    for (const session of new Set(actual.map(e => e.after.origin.context.session))) if (actual.filter(e => e.after.origin.context.session === session).length !== expected.filter(m => m.origin.context.session === session).length) throw new WorkbenchError('method-partial-lineage');
    const ids = new Map<string, string>();
    for (const event of actual) {
      const m = event.after;
      const {
          id,
          parentVersionId,
          admittedMinute,
          applicability,
          ...immutable
        } = m,
        raw = expected.find(x => x.artifactHash === m.artifactHash && x.origin.context.session === m.origin.context.session);
      if (!raw) throw new WorkbenchError('method-admission-authority');
      const {
        applicability: _,
        ...frozen
      } = raw;
      if (canonical(immutable) !== canonical(frozen) || admittedMinute !== event.minute || parentVersionId !== (m.parentArtifactHash === null ? null : ids.get(m.parentArtifactHash))) throw new WorkbenchError('method-admission-authority');
      validateMethodHashes(m);
      ids.set(m.artifactHash, id);
    }
    const learned=entries.flatMap(e=>e.event.type==='invention-grant-changed'?e.event.after.method?.executions.slice(e.event.before?.method?.executions.length??0)??[]:[]),authorized=learning.intakes();
    if(learned.length>authorized.length)throw new WorkbenchError('learner-admission-authority');
    for(const e of learned){const {id,admittedMinute,...immutable}=e;if(!authorized.some(x=>canonical(x)===canonical(immutable))||admittedMinute>snapshot.state.canonicalMinute)throw new WorkbenchError('learner-admission-authority');validateLearnerHashes(e);}
  });
  deps.bound?.();
  return {
    learningActor:learning.actor,
    ordinaryActor(capability){const launch=launchCapabilities.get(capability);return !closed&&launch?launch.command.residentId:undefined;},
    learningStarts:learning.starts,startLearning:learning.start,acceptLearning:learning.accept,learnerIntakes:learning.intakes,
    canAuthor(actor) {
      return !closed && !!deps.journalDirectory && live.size + launches.size < 8 && !Array.from(live).some(x => x.origin.context.actor === actor) && !Array.from(launches).some(x => x.command.residentId === actor);
    },
    ordinaryStarts() {
      if (closed) return [];
      return Array.from(launches).filter(item => !item.scheduled).map(item => {
        item.scheduled = true;
        return item.capability;
      });
    },
    ordinaryStart(snapshot, generation, capability) {
      const launch = launchCapabilities.get(capability);
      if (!launch) return;
      launchCapabilities.delete(capability);
      launches.delete(launch);
      const command = launch.command, state = snapshot.state,
        person = state.residents[command.residentId], profile = state.life?.residents[command.residentId];
      if (closed || !deps.journalDirectory || command.generation !== generation || launch.state.state === 'invalidated' || live.size >= 8 || Array.from(live).some(x => x.origin.context.actor === command.residentId)) return;
      privateDirectory(deps.journalDirectory);
      const a = snapshot.state.life?.invention?.agendas[command.agendaId],
        input = methodInput(snapshot.state, command.residentId, command.agendaId);
      const site = a && state.life?.invention?.sites[a.siteId];
      if (!a || a.authoring !== 'executable-v1' || !input || a.needTrialId === null || !site || !person || !profile ||
        person.lifeStage === 'child' || a.ownerId !== command.residentId || ['paused', 'closed'].includes(a.stage) ||
        a.needTrialId !== launch.origin.context.need || a.siteId !== launch.origin.context.site || site.revision !== command.siteRevision ||
        person.placeId !== site.placeId || profile.needs.energy < 20 ||
        launch.state.state === 'completed-origin-task' && profile.task !== null ||
        !methodRevisionBasis(state, command.residentId, a.id, command.revisionBasisTrialId) ||
        methodApplicability(launch.origin, launch.state, state, state, state.canonicalMinute).state === 'invalidated') return;
      const args: WorkbenchStart = {
        actor: command.residentId,
        agendaId: command.agendaId,
        session: command.sessionId,
        journalPath: join(deps.journalDirectory, `${command.sessionId}.workbench.json`),
        fixtures: [{
          id: 'current',
          cases: [{
            envelope: input.envelope,
            skill: input.skill,
            condition: input.condition
          }]
        }],
        revisionBasisTrialId: command.revisionBasisTrialId,
        choice: {
          requestId: command.requestId,
          observedMinute: command.observedMinute,
          generation: command.generation,
          agendaRevision: command.agendaRevision,
          siteRevision: command.siteRevision,
          task: structuredClone(command.task)
        }
      };
      ordinaryArguments.set(args, digest(args));
      return args;
    },
    async start(snapshot, generation, args) {
      if (Object.keys(snapshot.state.life?.invention?.methods ?? {}).length + intakes().length >= 64) return;
      if (closed || live.size >= 8 || sessions.has(args.session) || Object.values(snapshot.state.life?.invention?.methods ?? {}).some(m => m.origin.context.session === args.session) || existsSync(args.journalPath)) throw new WorkbenchError('unconfigured-workbench');
      const state = snapshot.state,
        i = state.life?.invention,
        a = i?.agendas[args.agendaId],
        need = a?.needTrialId && i?.trials[a.needTrialId],
        p = state.life?.residents[args.actor],
        site = a && i?.sites[a.siteId];
      if (!a || !need || !p || !site || !state.residents[args.actor] || state.residents[args.actor]!.lifeStage === 'child' || a.ownerId !== args.actor || ['paused', 'closed'].includes(a.stage) || a.candidateIds.some(id=>!i?.designs[id]?.methodApplication) || need.actorId !== args.actor || need.siteId !== a.siteId || need.mode !== 'baseline' || !['passed', 'quality-rejected'].includes(need.outcome)) throw new WorkbenchError('invalid-method-origin');
      const expectedOrdinary = ordinaryArguments.get(args);
      if (expectedOrdinary !== undefined || args.choice !== undefined) {
        ordinaryArguments.delete(args);
        if (expectedOrdinary === undefined || expectedOrdinary !== digest(args) || state.residents[args.actor]!.placeId !== site.placeId || p.needs.energy < 20) throw new WorkbenchError('invalid-method-origin');
      }
      const materials = {
        stone: Math.min(6, Math.max(0, (state.life!.ventures!.resources.stone?.stock ?? 0) - (state.life!.ventures!.resources.stone?.active.reduce((n, r) => n + r.quantity, 0) ?? 0))),
        timber: Math.min(6, Math.max(0, (state.life!.ventures!.resources.timber?.stock ?? 0) - (state.life!.ventures!.resources.timber?.active.reduce((n, r) => n + r.quantity, 0) ?? 0)))
      };
      const revisionTrial=args.revisionBasisTrialId?i?.trials[args.revisionBasisTrialId]:undefined;
      const context = ContextSchema.parse({
        actor: args.actor,
        session: args.session,
        generation,
        minute: state.canonicalMinute,
        need: need.id,
        site: a.siteId,
        siteRevision: site.revision,
        envelope: need.operation,
        skill: p.skills.building,
        condition: 100,
        materials,
        evidence: [{trial:need.id,quality:need.quality,duration:need.duration},...(revisionTrial&&revisionTrial.actorId===args.actor?[{trial:revisionTrial.id,quality:revisionTrial.quality,duration:revisionTrial.duration}]:[])]
      });
      const origin = MethodOriginSchema.parse({
        context,
        contextHash: digest(context),
        sourceSequence: snapshot.ledgerBaseSequence,
        sourceLedgerHash: snapshot.ledgerBaseHash,
        agendaId: a.id,
        agendaRevision: a.revision,
        task: methodTask(p.task),
        ...(args.choice?{choice:structuredClone(args.choice)}:{})
      });
      const status: Live = {
        minute: state.canonicalMinute,
        origin,
        state: {
          revision: 0,
          state: 'available',
          reason: 'none'
        },
        abort: new AbortController(),
        accepted: false
      };
      // Origin is validated against the actual canonical source before any provider request.
      if (methodApplicability(origin, status.state, state, state, state.canonicalMinute).state === 'invalidated') throw new WorkbenchError('invalid-method-origin');
      live.add(status);
      sessions.add(args.session);
      let dispatched: unknown;
      const submitted: ReturnType<WorkbenchStore['submit']>[] = [],
        runs: {
          source: string;
          input: ReturnType<typeof MethodCaseInputSchema.parse>;
          output: ModuleOutput | null;
          rawHash: string | null;
          status: 'valid-output' | 'invalid-output' | 'execution-failed';
        }[] = [],
        receipts: Receipt[] = [],
        observedTests = new Map<string, typeof runs>();
      const fixtures = args.fixtures.map(f => FixtureSchema.parse(f));
      const configured = deps.transport(args.session, origin),
        journal = WorkbenchStore.open(args.journalPath, context);
      const executor: Executor = {
        async run(source, input, signal) {
          const observed = {
            source,
            input: MethodCaseInputSchema.parse(input),
            output: null as ModuleOutput | null,
            rawHash: null as string | null,
            status: 'execution-failed' as 'valid-output' | 'invalid-output' | 'execution-failed'
          };
          runs.push(observed);
          const output = await deps.executor.run(source, input, signal);
          observed.rawHash = digest(output);
          const parsed = MethodOutputSchema.safeParse(output);
          observed.output = parsed.success ? structuredClone(parsed.data) : null;
          observed.status = parsed.success ? 'valid-output' : 'invalid-output';
          return output;
        }
      };
      const session = new WorkbenchSession(journal, fixtures, executor),
        test = session.test.bind(session),
        submit = session.submit.bind(session);
      session.submit = raw => {
        if (canonical(raw) !== canonical(dispatched)) throw new WorkbenchError('unobserved-method');
        const artifact = submit(raw);
        submitted.push(structuredClone(artifact));
        return artifact;
      };
      session.test = async (raw, signal) => {
        const start = runs.length,
          receipt = await test(raw, signal);
        receipts.push(structuredClone(receipt));
        observedTests.set(receipt.hash, structuredClone(runs.slice(start)));
        return receipt;
      };
      const transport = {
        async next(input: Record<string, unknown>[], signal: AbortSignal) {
          const reply = await configured.transport.next(input, signal);
          const valid = validateToolArguments(reply.call);
          dispatched = valid.ok && valid.call.name === 'submit_module' ? structuredClone(valid.call.args) : undefined;
          return reply;
        }
      } as ResponsesWorkbenchTransport;
      try {
        const result = await session.run(transport, status.abort.signal);
        if (closed || status.abort.signal.aborted || result.termination !== 'proposed' || !result.proposal || status.state.state === 'invalidated') return;
        const saved = journal.snapshot(),
          selected = saved.artifacts.findIndex(x => x.hash === result.proposal!.artifact);
        if (selected < 0 || canonical(saved.artifacts) !== canonical(submitted) || saved.receipts.length !== receipts.length || canonical(saved.receipts) !== canonical(receipts) || receipts.length > 8) throw new WorkbenchError('unobserved-method');
        const records: MethodIntake[] = [];
        for (const artifact of saved.artifacts.slice(0, selected + 1)) {
          const tests = receipts.filter(r => r.artifact === artifact.hash).map(r => {
            const fixture = fixtures.find(f => f.id === r.fixtureSet && digest(f) === r.fixtureHash);
            if (!fixture) throw new WorkbenchError('unobserved-method');
            const observed = observedTests.get(r.hash);
            if (!observed) throw new WorkbenchError('unobserved-method');
            let cursor = 0;
            const executions: MethodTest['executions'] = fixture.cases.map(c => {
              const input = {
                  ...c,
                  materials: context.materials
                },
                firstRun = observed[cursor++],
                secondRun = firstRun?.status === 'execution-failed' ? undefined : observed[cursor++];
              if (!firstRun || [firstRun, secondRun].some(x => x && (x.source !== artifact.source || caseInputHash(x.input) !== caseInputHash(input)))) throw new WorkbenchError('unobserved-method');
              const first = firstRun.output,
                second = secondRun?.output ?? null;
              return {
                input,
                inputHash: caseInputHash(input),
                firstStatus: firstRun.status,
                secondStatus: secondRun?.status ?? 'not-run',
                first,
                second,
                firstHash: firstRun.rawHash,
                secondHash: secondRun?.rawHash ?? null
              };
            });
            if (cursor !== observed.length) throw new WorkbenchError('unobserved-method');
            return {
              ...r,
              fixture,
              executions
            };
          });
          if (!tests.length) throw new WorkbenchError('method-partial-lineage');
          records.push({
            authorId: context.actor,
            source: artifact.source,
            sourceHash: artifact.sourceHash,
            artifactHash: artifact.hash,
            revision: artifact.revision,
            parentArtifactHash: artifact.parent,
            origin,
            authority: deps.authority,
            interface: 'design-v1',
            evaluator: 1,
            evaluatorHash: digest(MODULE_REFERENCE),
            runtime: deps.runtime,
            tests,
            selectedReceiptHash: artifact.hash === result.proposal.artifact ? result.proposal.receipt : tests.at(-1)!.hash,
            admissionBasis: {
              minute: status.minute,
              applicability: structuredClone(status.state)
            },
            applicability: structuredClone(status.state)
          });
        }
        status.records = records;
        const capability = Object.freeze({});
        capabilities.set(capability, status);
        return capability;
      } finally {
        configured.seal();
        if (!status.records) live.delete(status);
      }
    },
    accept(capability, generation, world) {
      const status = capabilities.get(capability);
      if (closed || !status || status.accepted || status.origin.context.generation !== generation || status.state.state === 'invalidated' || !status.records) return false;
      status.accepted = true;
      if (Object.keys(world.life?.invention?.methods ?? {}).length + intakes().length + status.records.length > 64) {
        live.delete(status);
        return false;
      }
      pending.push(status);
      return true;
    },
    intakes,
    committed(before, _after, entries) {

      let head = before,
        chunk: LedgerEntry[] = [];
      for (const entry of entries) {
        chunk.push(entry);
        if (entry.event.type !== 'clock-advanced') continue;
        const next = replayLedger(head, chunk),
          admitted = new Set(chunk.flatMap(e => e.event.type === 'invention-method-changed' && e.event.before === null ? [e.event.after.origin.context.session] : []));
        learning.committed(head,next,chunk);
        // Mint only from this successfully committed minute, anchored to its pre-minute observation.
        if (deps.journalDirectory) for (const record of chunk) {
          const event = record.event;
          if (event.type !== 'invention-command-resolved' || event.outcome !== 'accepted' || event.command?.action !== 'author-method') continue;
          const command = event.command, state = head.state, a = state.life?.invention?.agendas[command.agendaId],
            need = a?.needTrialId && state.life?.invention?.trials[a.needTrialId], input = methodInput(state, command.residentId, command.agendaId);
          if (!a || !need || !input || command.observedMinute !== state.canonicalMinute || live.size + launches.size >= 8 || Array.from(launches).some(x => x.command.residentId === command.residentId)) continue;
          const context = ContextSchema.parse({
            actor: command.residentId, session: command.sessionId, generation: command.generation,
            minute: state.canonicalMinute, need: need.id, site: a.siteId, siteRevision: command.siteRevision,
            ...input, evidence: [{ trial: need.id, quality: need.quality, duration: need.duration }]
          });
          const origin = MethodOriginSchema.parse({
            context, contextHash: digest(context), sourceSequence: head.ledgerBaseSequence,
            sourceLedgerHash: head.ledgerBaseHash, agendaId: a.id, agendaRevision: command.agendaRevision,
            task: structuredClone(command.task)
          });
          const capability = Object.freeze({}), launch: OrdinaryLaunch = {
            capability, command: structuredClone(command), origin,
            state: { revision: 0, state: 'available', reason: 'none' }, scheduled: false
          };
          launches.add(launch);
          launchCapabilities.set(capability, launch);
        }
        // A replacement stays invalid even when a later minute returns to null/the same shape.
        for (const launch of launches) {
          launch.state = methodApplicability(launch.origin, launch.state, head.state, next.state, next.state.canonicalMinute);
          const state = next.state, a = state.life?.invention?.agendas[launch.command.agendaId], site = a && state.life?.invention?.sites[a.siteId];
          // A completed task permits the stable observation intention, not an unrelated new task.
          const newTask = state.life?.residents[launch.command.residentId]?.task;
          const replacedIntention = chunk.some(record => {
            const event = record.event;
            return event.type === 'invention-command-resolved' && event.outcome === 'accepted' && event.residentId === launch.command.residentId && event.command?.action === 'agenda';
          });
          if (launch.state.state === 'completed-origin-task' && newTask !== null) launch.state = { revision: launch.state.revision + 1, state: 'invalidated', reason: 'task-replaced' };
          if (replacedIntention || a?.stage === 'paused' || !site || site.revision !== launch.command.siteRevision || state.residents[launch.command.residentId]?.placeId !== site.placeId) launch.state = { revision: launch.state.revision + 1, state: 'invalidated', reason: 'origin-invalid' };
          if (launch.state.state === 'invalidated') {
            launches.delete(launch);
            launchCapabilities.delete(launch.capability);
          }
        }
        for (const item of live) {
          if (admitted.has(item.origin.context.session)) {
            live.delete(item);
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            continue;
          }
          item.minute = next.state.canonicalMinute;
          item.state = methodApplicability(item.origin, item.state, head.state, next.state, next.state.canonicalMinute);
          if (item.records) for (const record of item.records) {
            record.applicability = structuredClone(item.state);
            record.admissionBasis = {
              minute: item.minute,
              applicability: structuredClone(item.state)
            };
          }
          if (item.state.state === 'invalidated') {
            item.abort.abort();
            live.delete(item);
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
          }
        }
        head = next;
        chunk = [];
      }
    },
    close() {
      closed = true;
      learning.close();
      for (const item of live) item.abort.abort();
      live.clear();
      for (const launch of launches) launchCapabilities.delete(launch.capability);
      launches.clear();
      pending.splice(0);
      validators.delete(store);
    }
  };
}
