import { InventionMethodSchema, MethodTaskSchema, type InventionMethod, type MethodOrigin, type MethodApplicability, type ResidentTask, type WorldState, type WorldEvent } from '@meridian/world-schema';
import { deriveAssemblyDesign, evaluateAssembly } from './invention-evaluator.js';
import { assemblyOperation, inventionDeltas } from './invention.js';
import { FRONTIER_LEAD_EFFORT, FRONTIER_HELP_EFFORT } from './frontier.js';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type MethodIntake = Omit<InventionMethod, 'id' | 'parentVersionId' | 'admittedMinute'>;
export function methodTask(task: ResidentTask | null): MethodOrigin['task'] {
  if (!task) return null;
  const {
    label: _,
    progress: __,
    blocker: ___,
    decisionSource: ____,
    ...identity
  } = task;
  return MethodTaskSchema.parse(Object.fromEntries(Object.entries(identity).filter(([, v]) => v !== undefined)));
}
/** Existing canonical success records, scoped to the exact task. Unsupported teaching/wait states have no success witness. */
function completedOriginTask(origin: MethodOrigin, before: WorldState, after: WorldState, minute: number): boolean {
  const task = origin.task,
    actor = origin.context.actor,
    old = before.life?.residents[actor],
    next = after.life?.residents[actor];
  if (!task || !old || !next || !same(methodTask(old.task), task) || minute < task.endsMinute) return false;
  const memories = next.memories.filter(m => m.minute === minute);
  if (memories.some(m => m.outcome === 'interrupted' || m.outcome === 'venture-failed' && m.ventureId === task.ventureId)) return false;
  const memory = (outcome: string) => memories.some(m => m.outcome === outcome);
  const purpose = (gain: number) => next.needs.purpose === Math.min(100, Math.max(0, old.needs.purpose - 1) + gain);
  const source = (world: WorldState, id: string | undefined) => id ? world.life?.ventures?.projects[id] ?? world.life?.ventures?.retired.find(v => v.id === id) : undefined;
  const oldSource = source(before, task.ventureId),
    newSource = source(after, task.ventureId);
  const paidComplete = !!oldSource && !!newSource && oldSource.outcome === null && newSource.placeId === task.placeId && newSource.status === 'completed' && newSource.outcome?.minute === minute && newSource.outcome.reason === 'all-steps-complete' && newSource.steps.every(s => s.status === 'done' && same(s.consumed, s.requires));
  if (task.kind === 'assembly-trial') {
    const previous = before.life?.invention?.jobs[task.inventionId!],
      job = after.life?.invention?.jobs[task.inventionId!],
      trial = job?.resultTrialId ? after.life?.invention?.trials[job.resultTrialId] : undefined;
    return paidComplete && !!previous && ['invited', 'working'].includes(previous.status) && previous.actorId === actor && previous.ventureId === task.ventureId && !!job && ['passed', 'quality-rejected'].includes(job.status) && job.endedMinute === minute && !!trial && !before.life?.invention?.trials[trial.id] && trial.actorId === actor && trial.ventureId === task.ventureId && trial.endedMinute === minute && trial.siteId === job.siteId && after.life?.invention?.sites[job.siteId]?.placeId === task.placeId;
  }
  if (task.kind === 'invention-build') {
    const previous = before.life?.invention?.designs[task.inventionId!],
      design = after.life?.invention?.designs[task.inventionId!];
    return paidComplete && previous?.status === 'building' && previous.authorId === actor && previous.ventureId === task.ventureId && design?.status === 'built' && design.ventureId === task.ventureId && after.life?.invention?.sites[design.input.site]?.placeId === task.placeId && Object.values(after.life?.invention?.artifacts ?? {}).some(a => a.designId === design.id && a.builderId === actor && a.completedMinute === minute && !before.life?.invention?.artifacts[a.id]);
  }
  // Teaching has no enabled paid settlement in this increment. A waiting request is not a successful lesson/operation.
  if (task.kind === 'invention-teach' || task.kind === 'wait-tool') return false;
  if (task.kind === 'venture-work') {
    if (!oldSource || !newSource || oldSource.outcome || newSource.outcome && newSource.outcome.result !== 'completed' || oldSource.placeId !== task.placeId) return false;
    const member = oldSource.proposerId === actor || oldSource.participants.some(p => p.residentId === actor && p.consent === 'accepted');
    if (!member) return false;
    const settled = oldSource.steps.some(step => step.status === 'running' && step.startedMinute !== null && step.startedMinute <= task.startedMinute && newSource.steps.some(s => s.id === step.id && s.status === 'done' && s.completedMinute === minute && same(s.requires, s.consumed)));
    const running = oldSource.steps.some(step => step.status === 'running' && step.startedMinute !== null && step.startedMinute <= minute && step.startedMinute + step.durationMinutes >= minute) && newSource.status === 'active' && purpose(10);
    return minute === task.endsMinute && (settled || running);
  }
  if (minute !== task.endsMinute) return false;
  if (task.kind === 'invention-travel') return task.inventionId === origin.agendaId && after.life?.invention?.sites[origin.context.site]?.placeId === task.placeId && before.residents[actor]?.placeId !== task.placeId && after.residents[actor]?.placeId === task.placeId;
  if (task.kind === 'chart-frontier' || task.kind === 'help-chart') {
    const parcel = before.life?.frontier?.[task.parcelId!],
      updated = after.life?.frontier?.[task.parcelId!],
      lead = task.kind === 'chart-frontier',
      effort = lead ? FRONTIER_LEAD_EFFORT : FRONTIER_HELP_EFFORT;
    return !!parcel && parcel.state === 'fog' && !!updated && updated.effort >= Math.min(6, parcel.effort + effort) && (updated.contributors.includes(actor) || parcel.contributors.length === 8) && purpose(lead ? 25 : 15) && memories.some(m => m.parcelId === task.parcelId && (m.outcome === 'frontier-surveyed' || m.outcome === 'frontier-charted' && updated.state === 'charted' && updated.chartedMinute === minute));
  }
  if (task.kind === 'survey') return memories.some(m => m.outcome === 'place-charted' && m.placeId === task.placeId) && after.life?.charts?.[task.placeId]?.surveyedMinute === minute && purpose(25);
  if (task.kind === 'build') {
    const parcel = before.life?.frontier?.[task.parcelId!],
      updated = after.life?.frontier?.[task.parcelId!];
    return !!parcel?.build && !!updated && memories.some(m => m.parcelId === task.parcelId && (m.outcome === 'build-worked' && purpose(20) && (updated.build !== undefined && updated.build.effort > parcel.build!.effort || !!updated.placeId && !!after.places[updated.placeId] && !before.places[updated.placeId]) || m.outcome === 'place-founded' && purpose(30) && !!updated.placeId && !!after.places[updated.placeId] && !before.places[updated.placeId]));
  }
  if (task.kind === 'handover' || task.kind === 'return-tool') {
    const previous = before.life?.commitments[task.commitmentId!],
      current = after.life?.commitments[task.commitmentId!],
      returning = task.kind === 'return-tool';
    return !!previous && !!current && previous.status === (returning ? 'returning' : 'meeting') && current.status === (returning ? 'returned' : 'loaned') && current.resourceId === task.resourceId && [current.requesterId, current.lenderId].includes(actor) && after.life?.resources[current.resourceId]?.ownerId === (returning ? current.lenderId : current.requesterId) && memories.some(m => m.resourceId === task.resourceId && m.partnerId === task.partnerId && (returning ? m.outcome === 'tool-returned' : ['tool-lent', 'tool-received'].includes(m.outcome)));
  }
  if (task.kind === 'use-tool') return purpose(30) && memories.some(m => m.outcome === 'garden-tended' && m.projectId === task.projectId && m.resourceId === task.resourceId) && after.life?.resources[task.resourceId!]?.ownerId === actor;
  if (task.kind === 'socialise') return memories.some(m => m.outcome === 'socialised' && m.partnerId === task.partnerId) && after.life?.residents[task.partnerId!]?.memories.some(m => m.minute === minute && m.outcome === 'socialised' && m.partnerId === actor) === true;
  if (task.kind === 'rest') return memory('rested');
  if (task.kind === 'work') return memory('work-completed') && purpose(25) && next.skills.work === Math.min(100, old.skills.work + 1);
  return false;
}
/** Only closed, canonically recorded success outcomes witness completion; elapsed time/null alone never do. */
export function methodApplicability(origin: MethodOrigin, prior: MethodApplicability, before: WorldState, after: WorldState, minute: number): MethodApplicability {
  if (prior.state === 'invalidated') return prior;
  const i = after.life?.invention,
    a = i?.agendas[origin.agendaId],
    c = origin.context;
  const invalid = (reason: MethodApplicability['reason']): MethodApplicability => ({
    revision: prior.revision + 1,
    state: 'invalidated',
    reason
  });
  if (!a || a.ownerId !== c.actor || a.siteId !== c.site || a.needTrialId !== c.need || a.stage === 'closed' || a.candidateIds.some(id => !i?.designs[id]?.methodApplication)) return invalid('agenda-closed');
  const need = i?.trials[c.need],
    job = need && Object.values(i!.jobs).find(j => j.resultTrialId === need.id);
  if (!need || need.actorId !== c.actor || need.siteId !== c.site || need.mode !== 'baseline' || !job) return invalid('origin-invalid');
  const target = assemblyOperation(job.operation).template.consequence.projectId;
  if ((after.life?.projects[target]?.progress ?? 100) >= 100) return invalid('need-resolved');
  if (prior.state === 'completed-origin-task') return prior;
  const old = before.life?.residents[c.actor],
    next = after.life?.residents[c.actor];
  if (!old || !next) return invalid('origin-invalid');
  if (same(methodTask(next.task), origin.task)) return prior;
  if (completedOriginTask(origin, before, after, minute)) return {
    revision: prior.revision + 1,
    state: 'completed-origin-task',
    reason: 'task-completed'
  };
  return invalid('task-replaced');
}
/** Pure grade validation, never executable source evaluation. Hash/observation authority is additionally checked by the host store. */
export function validateMethodGrades(m: Pick<InventionMethod,'origin'|'artifactHash'|'tests'|'selectedReceiptHash'>): void {
  const c = m.origin.context;
  if (new Set(m.tests.map(t => t.hash)).size !== m.tests.length || new Set(m.tests.map(t => t.fixtureHash)).size !== m.tests.length) throw Error('method duplicate tests');
  for (const t of m.tests) {
    if (t.results.length !== t.fixture.cases.length || t.executions.length !== t.results.length || t.fixture.id !== t.fixtureSet || t.actor !== c.actor || t.session !== c.session || t.contextHash !== m.origin.contextHash || t.artifact !== m.artifactHash || t.passed !== t.results.every(r => r.passed)) throw Error('method test association');
    for (const [index, r] of t.results.entries()) {
      const e = t.executions[index]!,
        fc = t.fixture.cases[index]!;
      if (!same(e.input, {
        ...fc,
        materials: c.materials
      }) || e.inputHash !== r.inputHash) throw Error('method fixture input');
      for (const [status, output] of [[e.firstStatus, e.first], [e.secondStatus, e.second]] as const) if (status === 'valid-output' !== (output !== null)) throw Error('method execution status');
      for (const [status, hash] of [[e.firstStatus, e.firstHash], [e.secondStatus, e.secondHash]] as const) if ((status === 'valid-output' || status === 'invalid-output') !== (hash !== null)) throw Error('method execution hash status');
      let observedCode: string;
      if (e.firstStatus === 'execution-failed' || e.secondStatus === 'execution-failed') observedCode = 'execution-failed';else if (e.firstStatus === 'not-run' || e.secondStatus === 'not-run') throw Error('method missing repeat');else if (e.firstHash !== e.secondHash) observedCode = 'nondeterministic';else if (e.firstStatus === 'invalid-output' || e.secondStatus === 'invalid-output') observedCode = 'invalid-output';else if (!same(e.first, e.second)) throw Error('method output identity');else {
        const output = e.first!,
          design = {
            grammar: 1 as const,
            evaluator: 1 as const,
            need: c.need,
            site: c.site,
            parent: null,
            ...output
          };
        observedCode = deriveAssemblyDesign(design).ok && evaluateAssembly(design, e.input.envelope, e.input.skill, e.input.condition).ok ? 'measured' : 'invalid-graph';
      }
      if (observedCode !== r.code) throw Error('method observation category');
      if (r.code !== 'measured') {
        if (r.passed || r.quality !== null || r.duration !== null || r.design !== null) throw Error('method failure grade');
        continue;
      }
      if (!r.design || !same(e.first, r.design) || !same(e.second, r.design)) throw Error('method repeat execution');
      const d = {
        grammar: 1 as const,
        evaluator: 1 as const,
        need: c.need,
        site: c.site,
        parent: null,
        ...r.design
      };
      const cost = deriveAssemblyDesign(d),
        score = evaluateAssembly(d, e.input.envelope, e.input.skill, e.input.condition);
      if (!cost.ok || !score.ok) throw Error('method invalid graph');
      const claim = r.design.claim,
        n = claim.metric === 'quality-points' ? score.value.quality : score.value.duration;
      const passed = score.value.passed && (claim.relation === 'at-most' ? n <= claim.value : n >= claim.value) && cost.value.bom.stone <= e.input.materials.stone && cost.value.bom.timber <= e.input.materials.timber;
      if (r.quality !== score.value.quality || r.duration !== score.value.duration || r.passed !== passed) throw Error('method altered grade');
    }
  }
  const selected = m.tests.find(t => t.hash === m.selectedReceiptHash);
  // Failed tested parents remain evidence; only the final selected version needs a passing selected receipt.
  if (!selected) throw Error('method selected receipt');
}
export function applyMethodMinute(before: WorldState, after: WorldState, minute: number, intakes: readonly MethodIntake[] = []): WorldEvent[] {
  const i = after.life?.invention;
  if (!i) {
    if (intakes.length) throw Error('method invention absent');
    return [];
  }
  if (!i.methods && !intakes.length) return [];
  const old = structuredClone(i);
  for (const m of Object.values(i.methods ?? {})) m.applicability = methodApplicability(m.origin, m.applicability, before, after, minute);
  const admissible = intakes.filter(m => methodApplicability(m.origin, m.applicability, before, after, minute).state !== 'invalidated');
  if (admissible.length) {
    if (Object.keys(i.methods ?? {}).length + admissible.length > 64 || i.nextSequence > Number.MAX_SAFE_INTEGER - admissible.length) throw Error('method capacity');
    i.methods ??= {};
    const ids = new Map<string, string>();
    for (const raw of admissible) {
      const id = `invention:method:${i.nextSequence++}`,
        parent = raw.parentArtifactHash === null ? null : ids.get(raw.parentArtifactHash);
      if (parent === undefined) throw Error('method partial lineage');
      const m = InventionMethodSchema.parse({
        ...structuredClone(raw),
        id,
        parentVersionId: parent,
        admittedMinute: minute
      });
      if (Object.values(i.methods).some(x => x.artifactHash === m.artifactHash && x.origin.context.session === m.origin.context.session)) throw Error('method duplicate');
      if (m.origin.context.minute > before.canonicalMinute || m.authorId !== m.origin.context.actor || !after.residents[m.authorId]) throw Error('method origin');
      if (m.applicability.state === 'invalidated') throw Error('method invalid origin');
      const valid = methodApplicability(m.origin, m.applicability, before, after, minute);
      if (valid.state === 'invalidated') throw Error('method invalid origin');
      m.applicability = valid;
      validateMethodGrades(m);
      i.methods[id] = m;
      ids.set(m.artifactHash, id);
    }
  }
  return inventionDeltas(old, i, minute);
}

/** Current available resources are numeric inputs, never borrowed from an old receipt. */
export function methodInput(world: WorldState, actor: string, agendaId: string) {
  const a = world.life?.invention?.agendas[agendaId],
    need = a?.needTrialId && world.life?.invention?.trials[a.needTrialId],
    p = world.life?.residents[actor];
  if (!a || !need || !p) return undefined;
  const available = (id: string) => {
    const r = world.life?.ventures?.resources[id];
    return Math.min(6, Math.max(0, (r?.stock ?? 0) - (r?.active.reduce((n, r) => n + r.quantity, 0) ?? 0)));
  };
  return {
    envelope: structuredClone(need.operation),
    skill: p.skills.building,
    condition: 100,
    materials: {
      timber: available('timber'),
      stone: available('stone')
    }
  };
}
/** Only the selected successful leaf and exact CURRENT numeric input may supply a new graph. */
export function methodSelection(world: WorldState, actor: string, agendaId: string, versionId: string) {
  const i = world.life?.invention,
    a = i?.agendas[agendaId],
    m = i?.methods?.[versionId],
    input = methodInput(world, actor, agendaId);
  if (!a || !m || !input || m.authorId !== actor || m.origin.agendaId !== agendaId || m.origin.context.need !== a.needTrialId || m.origin.context.site !== a.siteId || m.applicability.state === 'invalidated' || methodApplicability(m.origin, m.applicability, world, world, world.canonicalMinute).state === 'invalidated' || Object.values(i?.methods ?? {}).some(x => x.origin.context.session === m.origin.context.session && x.revision > m.revision)) return undefined;
  const receipt = m.tests.find(t => t.hash === m.selectedReceiptHash);
  if (!receipt?.passed) return undefined;
  const index = receipt.executions.findIndex((e, n) => same(e.input, input) && receipt.results[n]?.passed && receipt.results[n]?.code === 'measured');
  if (index < 0) return undefined;
  const execution = receipt.executions[index]!,
    result = receipt.results[index]!;
  if (!result.design || !execution.firstHash) return undefined;
  return {
    method: m,
    receipt,
    index,
    execution,
    result,
    input
  };
}
/** A paid failed experiment can motivate a fresh session; it never erases old owned work. */
export function methodRevisionBasis(world: WorldState, actor: string, agendaId: string, trialId: string | null): boolean {
  const i = world.life?.invention,
    a = i?.agendas[agendaId];
  if (!i || !a) return false;
  if (trialId === null) return a.candidateIds.length < 2;
  const t = i.trials[trialId];
  return !!t && t.actorId === actor && t.siteId === a.siteId && t.mode === 'assisted' && t.designId !== null && a.candidateIds.includes(t.designId) && t.endedMinute <= world.canonicalMinute && (t.outcome === 'quality-rejected' || t.claimVerdict === 'refuted');
}
