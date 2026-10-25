import type { InventionCommand, InventionMethod, LearnerExecution, WorldSnapshot, WorldState } from '@meridian/world-schema';
import { MethodCaseInputSchema, MethodOutputSchema } from '@meridian/world-schema';
import { completedMethodLesson, learnerExecutionCurrent, methodInput, methodTask, validateLearnerGrades, type LearnerIntake } from '@meridian/world-kernel';
import { type Executor, canonical, caseInputHash, digest, WorkbenchError, isHostIntervention } from './contract.js';
import { judgeWorkbenchOutput } from './session.js';
interface LiveLearning {
  command: Extract<InventionCommand, {
    action: 'grant-choice';
  }>;
  generation: string;
  valid: boolean;
  scheduled: boolean;
  abort: AbortController;
  record?: LearnerIntake;
  accepted: boolean;
  need: string;
  agendaRevision: number;
  siteRevision: number;
  inputHash: string;
}
/** Private volatile execution-only observation. Never a WorkbenchStore, provider session, source submission or replay hook. */
export function bindFrozenLearnerExecutions(deps: {
  executor: Executor;
  runtime: InventionMethod['runtime'];
  authority: InventionMethod['authority'];
}) {
  const launches = new Map<object, LiveLearning>(),
    capabilities = new WeakMap<object, LiveLearning>(),
    active = new Set<LiveLearning>(),
    pending = new Set<LiveLearning>();
  let closed = false;
  const recordFor = (x: LiveLearning, w: WorldState): LearnerExecution | undefined => x.record ? {
    ...x.record,
    id: 'pending',
    admittedMinute: w.canonicalMinute + 1
  } : undefined;
  const validCommand = (x: LiveLearning, w: WorldState) => {
    const c = x.command,
      g = w.life?.invention?.grants[c.grantId],
      a = c.agendaId === null ? undefined : w.life?.invention?.agendas[c.agendaId],
      p = w.life?.residents[c.residentId],
      input = a && methodInput(w, c.residentId, a.id);
    return x.valid && completedMethodLesson(w, g) && g?.learnerId === c.residentId && g.revision >= c.grantRevision && !!a && a.ownerId === c.residentId && a.needTrialId !== null && !['paused', 'closed'].includes(a.stage) && a.grantId === g.id && a.needTrialId === x.need && a.revision === x.agendaRevision && w.life?.invention?.sites[c.siteId]?.revision === x.siteRevision && !!input && caseInputHash(input) === x.inputHash && w.residents[c.residentId]?.placeId === w.life?.invention?.sites[c.siteId]?.placeId && p?.needs.energy! >= 20 && canonical(methodTask(p?.task ?? null)) === canonical(c.task);
  };
  const result = {
    /** Scheduling identity only; this does not consume or freshen execution authority. */
    actor(capability:object):string|undefined {const x=launches.get(capability);return !closed&&x?x.command.residentId:undefined;},
    starts() {
      return Array.from(launches).filter(([, x]) => !x.scheduled).map(([cap, x]) => {
        x.scheduled = true;
        return cap;
      });
    },
    intakes() {
      return Array.from(pending).flatMap(x => x.record ? [structuredClone(x.record)] : []);
    },
    async start(snapshot: WorldSnapshot, generation: string, capability: object): Promise<object | undefined> {
      const x = launches.get(capability);
      if (!x) return;
      launches.delete(capability);
      const w = snapshot.state,
        c = x.command,
        g = w.life?.invention?.grants[c.grantId],
        a = c.agendaId && w.life?.invention?.agendas[c.agendaId],
        m = g?.method && w.life?.invention?.methods?.[g.method.methodVersionId],
        input = a && methodInput(w, c.residentId, a.id);
      if (closed || x.generation !== generation || !validCommand(x, w) || !g?.method || !a || !m || !input || g.method.executions.length >= 8 || active.size) return;
      active.add(x);
      const context = {
        actor: c.residentId,
        session: c.sessionId,
        generation,
        minute: w.canonicalMinute,
        need: a.needTrialId!,
        site: a.siteId,
        siteRevision: c.siteRevision,
        ...structuredClone(input),
        evidence: []
      };
      const contextHash = digest(context),
        run = {
          input: MethodCaseInputSchema.parse(input),
          inputHash: caseInputHash(input),
          firstStatus: 'execution-failed' as 'valid-output' | 'invalid-output' | 'execution-failed',
          secondStatus: 'execution-failed' as 'valid-output' | 'invalid-output' | 'execution-failed',
          first: null as ReturnType<typeof MethodOutputSchema.parse> | null,
          second: null as ReturnType<typeof MethodOutputSchema.parse> | null,
          firstHash: null as string | null,
          secondHash: null as string | null
        };
      try {
        for (const position of ['first', 'second'] as const) {
          x.abort.signal.throwIfAborted();
          try {
            const output = await deps.executor.run(m.source, structuredClone(input), x.abort.signal),
              parsed = MethodOutputSchema.safeParse(output);
            run[`${position}Hash`] = digest(output);
            run[`${position}Status`] = parsed.success ? 'valid-output' : 'invalid-output';
            run[position] = parsed.success ? structuredClone(parsed.data) : null;
          } catch (error) {
            if (error instanceof WorkbenchError && isHostIntervention(error.code)) throw error;
            if (x.abort.signal.aborted) throw error;
            run[`${position}Status`] = 'execution-failed';
          }
        }
        const base = {
            inputHash: run.inputHash,
            passed: false,
            quality: null,
            duration: null,
            design: null
          },
          grade = run.firstStatus === 'execution-failed' || run.secondStatus === 'execution-failed' ? {
            ...base,
            code: 'execution-failed' as const
          } : run.firstHash !== run.secondHash ? {
            ...base,
            code: 'nondeterministic' as const
          } : run.firstStatus === 'invalid-output' || run.secondStatus === 'invalid-output' ? {
            ...base,
            code: 'invalid-output' as const
          } : (() => {
            const score = judgeWorkbenchOutput(run.first!, input, context.need, context.site);
            return score ? {
              inputHash: run.inputHash,
              passed: score.passed,
              quality: score.quality,
              duration: score.duration,
              design: run.first,
              code: 'measured' as const
            } : {
              ...base,
              code: 'invalid-graph' as const
            };
          })();
        const fixture = {
            id: 'learner-current',
            cases: [{
              envelope: input.envelope,
              skill: input.skill,
              condition: input.condition
            }]
          },
          body = {
            actor: c.residentId,
            session: c.sessionId,
            contextHash,
            artifact: m.artifactHash,
            fixtureSet: fixture.id,
            fixtureHash: digest(fixture),
            passed: grade.passed,
            results: [grade]
          };
        x.record = {
          grantId: g.id,
          methodVersionId: m.id,
          learnerId: c.residentId,
          generation,
          agendaId: a.id,
          agendaRevision: a.revision,
          siteRevision: c.siteRevision,
          task: methodTask(w.life!.residents[c.residentId]!.task),
          context,
          contextHash,
          choice: {
            requestId: c.requestId,
            observedMinute: c.observedMinute,
            generation,
            agendaRevision: c.agendaRevision!,
            siteRevision: c.siteRevision,
            task: structuredClone(c.task)
          },
          observedMinute: w.canonicalMinute,
          sourceSequence: snapshot.ledgerBaseSequence,
          sourceLedgerHash: snapshot.ledgerBaseHash,
          input: structuredClone(input),
          sourceHash: m.sourceHash,
          artifactHash: m.artifactHash,
          runtime: structuredClone(deps.runtime),
          authority: structuredClone(m.authority),
          executionAuthority: deps.authority.kind === 'configured-double' ? 'configured-double' : 'configured-runtime',
          test: {
            ...body,
            hash: digest(body),
            fixture,
            executions: [run]
          }
        };
        validateLearnerGrades({
          ...x.record,
          id: 'pending',
          admittedMinute: w.canonicalMinute + 1
        });
        if (closed || x.abort.signal.aborted || !x.valid) {
          delete x.record;
          return;
        }
        const capability = Object.freeze({});
        capabilities.set(capability, x);
        return capability;
      } finally {
        if (!x.record) active.delete(x);
      }
    },
    accept(capability: object, generation: string, w: WorldState) {
      const x = capabilities.get(capability),
        record = x && recordFor(x, w),
        g = record && w.life?.invention?.grants[record.grantId];
      if (closed || !x || x.accepted || x.generation !== generation || !record || !g || !learnerExecutionCurrent(w, g, record)) {
        if (x) active.delete(x);
        return false;
      }
      x.accepted = true;
      pending.add(x);
      return true;
    },
    committed(before: WorldSnapshot, after: WorldSnapshot, events: readonly {
      event: unknown;
    }[]) {
      const w = after.state;
      for (const x of [...active, ...launches.values()]) {
        const c = x.command,
          g = w.life?.invention?.grants[c.grantId];
        if (g?.method?.executions.some(e => e.context.session === c.sessionId)) {
          active.delete(x);
          pending.delete(x);
          continue;
        }
        if (!validCommand(x, w) || x.record && !learnerExecutionCurrent(w, g!, recordFor(x, w)!)) {
          x.valid = false;
          x.abort.abort();
          active.delete(x);
          pending.delete(x);
          for (const [cap, y] of launches) if (y === x) launches.delete(cap);
        }
      }
      for (const {
        event: raw
      } of events) {
        const e = raw as {
          type: string;
          outcome?: string;
          command?: InventionCommand;
        };
        if (e.type !== 'invention-command-resolved' || e.outcome !== 'accepted' || e.command?.action !== 'grant-choice' || e.command.choice !== 'retest') continue;
        const c = e.command;
        if (closed || active.size + launches.size >= 8 || Array.from(launches.values()).some(x => x.command.residentId === c.residentId) || c.observedMinute !== before.state.canonicalMinute) continue;
        const a = c.agendaId === null ? undefined : w.life?.invention?.agendas[c.agendaId],
          input = a && methodInput(w, c.residentId, a.id);
        if (!a?.needTrialId || !input) continue;
        const x: LiveLearning = {
          command: structuredClone(c),
          generation: c.generation,
          valid: true,
          scheduled: false,
          abort: new AbortController(),
          accepted: false,
          need: a.needTrialId,
          agendaRevision: a.revision,
          siteRevision: c.siteRevision,
          inputHash: caseInputHash(input)
        };
        if (!validCommand(x, w)) continue;
        launches.set(Object.freeze({}), x);
      }
    },
    close() {
      closed = true;
      for (const x of active) x.abort.abort();
      active.clear();
      pending.clear();
      launches.clear();
    }
  };
  return result;
}
