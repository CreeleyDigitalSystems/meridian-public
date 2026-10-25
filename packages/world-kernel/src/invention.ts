import { applyLearningCommand, activeMethodGrant, gateMethodLessons, settleMethodLessons, validateGrantEvent } from './invention-learning.js';
import { methodApplicability, validateMethodGrades } from './invention-method.js';
import { applyInventionCognition } from './invention-cognition.js';
import { isUpkeepMinute, UPKEEP_FLOOR, UPKEEP_WEAR } from "./upkeep.js";
import { inventionMethodCollectionProblems, InventionCommandSchema, type InventionCommand, type InventionCommandReason, type InventionDesign, type InventionJob, type InventionState, type WorldState, type WorldEvent, type AssemblyOperation, type AssemblyEnvelope, type VentureLedger } from '@meridian/world-schema';
import { applyResidentLifeMinute, VENTURE_TEMPLATES } from './resident-life.js';
import { abandonProject, proposeProject, type ProjectLedger, type ProjectStepPlan } from './project-lifecycle.js';
import { deriveAssemblyDesign, evaluateAssembly, type AssemblyResult } from './invention-evaluator.js';
/** Dimensions are the versioned simulation envelope. BOM, remainder and consequence come only from authored recipes. */
const DIMENSIONS = {
  'garden-plant': {
    template: 'garden-beds',
    step: 'plant',
    pieces: 2,
    load: 1,
    precision: 60,
    axis: 0
  },
  'lantern-post': {
    template: 'promenade-lanterns',
    step: 'post',
    pieces: 1,
    load: 3,
    precision: 70,
    axis: 1
  },
  'market-box': {
    template: 'market-planters',
    step: 'box',
    pieces: 3,
    load: 2,
    precision: 70,
    axis: 0
  },
  'map-frame': {
    template: 'public-map-boards',
    step: 'frame',
    pieces: 4,
    load: 2,
    precision: 75,
    axis: 0
  }
} as const;
export function assemblyOperation(operation: AssemblyOperation) {
  const dimension = DIMENSIONS[operation],
    template = VENTURE_TEMPLATES.find(t => t.id === dimension.template)!;
  const step = template.steps.find(s => s.id === dimension.step)!;
  const envelope: AssemblyEnvelope = {
    pieces: dimension.pieces,
    load: dimension.load,
    precision: dimension.precision,
    axis: dimension.axis,
    nominalMinutes: step.durationMinutes
  };
  return {
    template,
    step,
    envelope,
    remainder: template.steps.reduce((n, s) => n + (s.id === step.id ? 0 : s.durationMinutes), 0)
  };
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const activeJob = (j: InventionJob) => j.status === 'working' || j.status === 'invited';
export function inventionAssociated(state: WorldState, ventureId: string) {
  const i = state.life?.invention;
  return !!i && (Object.values(i.jobs).some(j => j.ventureId === ventureId) || Object.values(i.designs).some(d => d.ventureId === ventureId) || Object.values(i.grants).some(g=>g.method?.lessons.some(l=>l.ventureId===ventureId)));
}
function occupiedSlots(i: InventionState, siteId: string): number {
  return Object.values(i.artifacts).filter(a => a.siteId === siteId).length + Object.values(i.designs).filter(d => d.status === 'building' && d.input.site === siteId).length;
}
function allocate(i: InventionState, kind: string) {
  if (i.nextSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('invention sequence exhausted');
  return `invention:${kind}:${i.nextSequence++}`;
}
export function enableInvention(input: WorldState): {
  state: WorldState;
  events: WorldEvent[];
  blocked?: 'unavailable';
} {
  if (input.life?.invention) return {
    state: input,
    events: []
  };
  if (!input.life?.ventures) return {
    state: input,
    events: [],
    blocked: 'unavailable'
  };
  const candidate = Object.keys(input.places).sort().find(placeId => input.places[placeId]!.kind === 'civic' && Object.keys(DIMENSIONS).some(op => {
    const {
      template,
      step
    } = assemblyOperation(op as AssemblyOperation);
    return template.placeId === placeId && (input.life!.projects[template.consequence.projectId]?.progress ?? 100) < 100 && step.requires.every(r => {
      const ledger = input.life!.ventures!.resources[r.resourceId];
      return ledger && ledger.stock - ledger.active.reduce((n, x) => n + x.quantity, 0) >= r.quantity;
    });
  }));
  if (!candidate) return {
    state: input,
    events: [],
    blocked: 'unavailable'
  };
  const i: InventionState = {
    version: 1,
    nextSequence: 1,
    sites: {},
    agendas: {},
    consultations: {},
    designs: {},
    artifacts: {},
    trials: {},
    jobs: {},
    grants: {}
  };
  const id = 'invention:site:0';
  i.sites[id] = {
    id,
    placeId: candidate,
    revision: 0,
    access: 'public-adults',
    capacity: 4
  };
  const state = structuredClone(input);
  state.life!.invention = i;
  return {
    state,
    events: [{
      type: 'invention-enabled',
      minute: input.canonicalMinute,
      before: null,
      after: structuredClone(i)
    }]
  };
}
export function validateInventionDesign(world: WorldState, input: unknown, actor: string, revisionBasisTrialId: string | null = null): AssemblyResult<{
  bom: {
    timber: number;
    stone: number;
  };
  buildMinutes: number;
}> {
  const mechanics = deriveAssemblyDesign(input);
  if (!mechanics.ok) return mechanics;
  const data = input as InventionDesign['input'],
    i = world.life?.invention,
    person = world.residents[actor],
    site = i?.sites[data.site],
    need = i?.trials[data.need];
  if (!i || !person || person.lifeStage === 'child' || !site || world.places[site.placeId]?.kind !== 'civic' || !need || need.actorId !== actor || need.siteId !== site.id || need.mode !== 'baseline' || !['passed', 'quality-rejected'].includes(need.outcome)) return {
    ok: false,
    reason: 'unknown need, adult or public site'
  };
  if (data.parent !== null) {
    const parent = i.designs[data.parent];
    if (!parent || parent.authorId !== actor || parent.input.need !== data.need || parent.input.site !== data.site || (parent.status !== 'failed' && !(revisionBasisTrialId && i.trials[revisionBasisTrialId]?.designId===parent.id && i.trials[revisionBasisTrialId]?.actorId===actor && i.trials[revisionBasisTrialId]?.mode==='assisted' && (i.trials[revisionBasisTrialId]?.outcome==='quality-rejected'||i.trials[revisionBasisTrialId]?.claimVerdict==='refuted')))) return {
      ok: false,
      reason: 'invalid failed-parent lineage'
    };
  }
  return mechanics;
}
export function inventionTemplateUsed(world: WorldState, templateId: string, minute: number, cooldown: number) {
  const i = world.life?.invention;
  return !!i && Object.values(i.jobs).some(j => {
    if (j.purpose !== 'production' || assemblyOperation(j.operation).template.id !== templateId) return false;
    return activeJob(j) || j.endedMinute !== null && minute - j.endedMinute < cooldown;
  });
}
function recipeBusy(world: WorldState, operation: AssemblyOperation, minute: number) {
  const {
      template
    } = assemblyOperation(operation),
    v = world.life!.ventures!,
    cooldown = 'cooldownMinutes' in template ? template.cooldownMinutes : 0;
  return Object.values(v.projects).some(p => p.id.endsWith(`:${template.id}`)) || v.retired.some(p => p.id.endsWith(`:${template.id}`) && p.outcome && minute - p.outcome.minute < cooldown) || inventionTemplateUsed(world, template.id, minute, cooldown);
}
function propose(world: WorldState, id: string, actor: string, siteId: string, steps: ProjectStepPlan[], minute: number): InventionCommandReason {
  const i = world.life!.invention!,
    ledger = world.life!.ventures!;
  // Protect source evidence and reservation capacity; never splice or force an extra retired slot.
  if (Object.keys(ledger.projects).length >= 16 || ledger.nextSequence >= Number.MAX_SAFE_INTEGER || ledger.nextRequestSequence > Number.MAX_SAFE_INTEGER - 12 || minute > Number.MAX_SAFE_INTEGER - 121) return 'record-cap';
  const bom = steps.flatMap(s => s.requires).reduce<Record<string, number>>((n, r) => ({
    ...n,
    [r.resourceId]: (n[r.resourceId] ?? 0) + r.quantity
  }), {});
  if (Object.entries(bom).some(([id, n]) => !ledger.resources[id] || ledger.resources[id]!.stock - ledger.resources[id]!.active.reduce((sum, r) => sum + r.quantity, 0) < n)) return 'resources-unavailable';
  const result = proposeProject(ledger as ProjectLedger, {
    id,
    label: 'Assembly work',
    placeId: i.sites[siteId]!.placeId,
    proposerId: actor,
    invitees: [],
    steps,
    consentDeadlineMinute: minute + 1,
    deadlineMinute: minute + 120
  }, minute);
  if (!result.ok) return 'resources-unavailable';
  world.life!.ventures = result.value as VentureLedger;
  return 'legal-command';
}
function aggregate(operation: AssemblyOperation, production: boolean) {
  const {
      template,
      step
    } = assemblyOperation(operation),
    totals: {
      timber: number;
      stone: number;
    } = {
      timber: 0,
      stone: 0
    };
  for (const s of production ? template.steps : [step]) for (const r of s.requires) totals[r.resourceId as 'timber' | 'stone'] += r.quantity;
  return totals;
}
const requirements = (bom: {
  timber: number;
  stone: number;
}) => Object.entries(bom).filter(([, n]) => n > 0).map(([resourceId, quantity]) => ({
  resourceId,
  quantity
}));
function constructionSteps(d: InventionDesign): ProjectStepPlan[] {
  const steps: ProjectStepPlan[] = [];
  if (d.bom.stone) steps.push({
    id: 'stone',
    label: 'Fabricate stone base and supports',
    durationMinutes: d.bom.stone,
    requires: [{
      resourceId: 'stone',
      quantity: d.bom.stone
    }]
  });
  if (d.bom.timber) steps.push({
    id: 'timber',
    label: 'Fabricate timber aids',
    durationMinutes: d.bom.timber,
    requires: [{
      resourceId: 'timber',
      quantity: d.bom.timber
    }]
  });
  steps.push({
    id: 'assembly',
    label: 'Assemble original aid',
    durationMinutes: d.buildMinutes - d.bom.stone - d.bom.timber,
    requires: []
  });
  return steps;
}
function bindTask(world: WorldState, actor: string, ventureId: string, inventionId: string, kind: 'invention-build' | 'assembly-trial', minute: number, duration: number, siteId: string) {
  const placeId = world.life!.invention!.sites[siteId]!.placeId;
  world.life!.residents[actor]!.task = {
    kind,
    label: kind === 'invention-build' ? 'Build an assembly aid' : 'Controlled assembly work',
    startedMinute: minute,
    endsMinute: minute + duration,
    placeId,
    ventureId,
    inventionId,
    decisionSource: 'engine'
  };
  world.residents[actor] = {
    ...world.residents[actor]!,
    activity: 'work'
  };
}
/** Mutates only the minute's already-cloned working state, under the life kernel's shared actor guards. */
export function applyInventionCommand(world: WorldState, raw: InventionCommand, minute: number, generation: string | undefined): InventionCommandReason {
  const parsed = InventionCommandSchema.safeParse(raw);
  if (!parsed.success) return 'invalid-payload';
  const c = parsed.data;
  if (c.observedMinute !== world.canonicalMinute || generation === undefined || c.generation !== generation) return 'stale';
  const i = world.life?.invention,
    site = i?.sites[c.siteId],
    person = world.residents[c.residentId],
    profile = world.life?.residents[c.residentId];
  if (!i || !site || !person || !profile) return 'unknown-reference';
  if (site.revision !== c.siteRevision) return 'stale';
  if(profile.task?.kind==="frontier-return" && !(c.action==="grant-choice"&&["accept","decline","revoke","invite-lesson"].includes(c.choice)||c.action==="consult-reply"||c.action==="interrupt"))return "unavailable";
  if (person.lifeStage === 'child' || world.places[site.placeId]?.kind !== 'civic') return 'unavailable';
  const learning = applyLearningCommand(world,c,minute);
  if(learning!==undefined)return learning;
  const cognitive = applyInventionCognition(world, c, minute);
  if (cognitive !== undefined) return cognitive;
  if (person.placeId !== site.placeId) return 'unavailable';
  const actor = c.residentId;
  if (c.action === 'interrupt') {
    const v = world.life!.ventures!.projects[c.ventureId];
    if (!v || v.proposerId !== actor || !inventionAssociated(world, v.id)) return 'unknown-reference';
    const abandoned = abandonProject(world.life!.ventures as ProjectLedger, v.id, minute);
    if (!abandoned.ok) return 'unavailable';
    world.life!.ventures = abandoned.value.ledger as VentureLedger;
    return 'legal-command';
  }
  if (c.action === 'share') {
    const a = i.artifacts[c.artifactId];
    if (!a) return 'unknown-reference';
    if (a.revision !== c.artifactRevision) return 'stale';
    if (a.ownerId !== actor) return 'consent-required';
    if (a.revision >= Number.MAX_SAFE_INTEGER - 3) return 'record-cap';
    if (a.access === c.access) return 'legal-command';
    a.access = c.access;
    a.revision++;
    return 'legal-command';
  }
  if (i.nextSequence > Number.MAX_SAFE_INTEGER - 8 - Object.values(i.jobs).filter(activeJob).length) return 'record-cap';
  if (profile.task || profile.needs.energy < 20) return 'unavailable';
  if (c.action === 'design') {
    if (Object.keys(i.designs).length >= 512) return 'record-cap';
    if (c.input.site !== site.id) return 'unknown-reference';
    const valid = validateInventionDesign(world, c.input, actor);
    if (!valid.ok) return 'invalid-payload';
    let agenda = Object.values(i.agendas).find(a => a.ownerId === actor && a.stage !== 'closed');
    if (!agenda) {
      if (Object.keys(i.agendas).length >= 128) return 'record-cap';
      const id = allocate(i, 'agenda');
      agenda = {
        id,
        ownerId: actor,
        revision: 0,
        siteId: site.id,
        needTrialId: c.input.need,
        stage: 'compare',
        candidateIds: [],
        selectedDesignId: null,
        consultationId: null,
        trialIds: [],
        grantId: null,
        blocked: 'none'
      };
      i.agendas[id] = agenda;
    }
    if (agenda.authoring || agenda.siteId !== site.id || agenda.needTrialId !== c.input.need || agenda.candidateIds.length >= 2) return 'unavailable';
    if (agenda.candidateIds.some(id => equal(i.designs[id]!.input, c.input))) return 'conflicting-duplicate';
    const id = allocate(i, 'design');
    i.designs[id] = {
      id,
      authorId: actor,
      createdMinute: minute,
      input: structuredClone(c.input),
      ...valid.value,
      status: 'validated',
      ventureId: null
    };
    agenda.candidateIds.push(id);
    agenda.revision++;
    return 'legal-command';
  }
  if (c.action !== 'build' && c.action !== 'operate') return 'invalid-payload';
  return startInventionPhysical(world, c, minute);
}
export function startInventionPhysical(world: WorldState, c: {
  residentId: string;
  siteId: string;
} & ({
  action: 'build';
  designId: string;
} | {
  action: 'operate';
  operation: AssemblyOperation;
  purpose: 'trial-only' | 'production';
  artifactId: string | null;
  artifactRevision: number | null;
  comparisonTrialId: string | null;
}), minute: number): InventionCommandReason {
  const i = world.life!.invention!,
    site = i.sites[c.siteId],
    actor = c.residentId,
    profile = world.life!.residents[actor],
    person = world.residents[actor];
  if (!site || !profile || !person || person.lifeStage === 'child' || person.placeId !== site.placeId || world.places[site.placeId]?.kind !== 'civic') return 'unavailable';
  if (i.nextSequence > Number.MAX_SAFE_INTEGER - 16 || profile.task || profile.needs.energy < 20) return 'unavailable';
  if (c.action === 'build') {
    const d = i.designs[c.designId],
      agenda = Object.values(i.agendas).find(a => a.ownerId === actor && a.candidateIds.includes(c.designId));
    if (!d || d.authorId !== actor || d.input.site !== site.id) return 'unknown-reference';
    if (d.status !== 'validated' || !agenda || (agenda.grantId?agenda.candidateIds.length!==1||!d.methodApplication||!('kind'in d.methodApplication)||d.methodApplication.grantId!==agenda.grantId||!activeMethodGrant(world,i.grants[agenda.grantId],minute):agenda.candidateIds.length!==2)) return 'unavailable';
    if (occupiedSlots(i, site.id) >= site.capacity || Object.keys(i.artifacts).length + Object.values(i.designs).filter(d => d.status === 'building').length >= 128) return 'record-cap';
    const id = `invention:build:${i.nextSequence}`;
    const steps = constructionSteps(d);
    const result = propose(world, id, actor, site.id, steps, minute);
    if (result !== 'legal-command') return result;
    allocate(i, 'build');
    d.status = 'building';
    d.ventureId = id;
    agenda.selectedDesignId = d.id;
    agenda.stage = 'build';
    agenda.revision++;
    bindTask(world, actor, id, d.id, 'invention-build', minute, d.buildMinutes, site.id);
    return 'legal-command';
  }
  if (Object.keys(i.jobs).length >= 256 || Object.keys(i.trials).length + Object.values(i.jobs).filter(activeJob).length >= 1024) return 'record-cap';
  const {
    template,
    envelope,
    remainder
  } = assemblyOperation(c.operation);
  if (template.placeId !== site.placeId) return 'unknown-reference';
  const production = c.purpose === 'production',
    target = world.life!.projects[template.consequence.projectId];
  if (production && (!target || target.placeId !== site.placeId || target.progress >= 100 || recipeBusy(world, c.operation, minute) || Object.keys(world.life!.ventures!.projects).length >= 2)) return 'unavailable';
  const a = c.artifactId === null ? null : i.artifacts[c.artifactId];
  if (c.artifactId !== null && !a) return 'unknown-reference';
  if (a && a.revision >= Number.MAX_SAFE_INTEGER - 3) return 'record-cap';
  if (a && (a.siteId !== site.id || a.condition === 0 || a.revision !== c.artifactRevision)) return 'stale';
  if (!a && c.artifactRevision !== null) return 'invalid-payload';
  if (a && a.ownerId !== actor && a.access !== 'public-consented') return 'consent-required';
  if (a && Object.values(i.jobs).some(j => activeJob(j) && j.artifactId === a.id)) return 'unavailable';
  const comparison = c.comparisonTrialId === null ? null : i.trials[c.comparisonTrialId];
  if (c.comparisonTrialId !== null && (!comparison || comparison.actorId !== actor || comparison.mode !== 'baseline' || comparison.siteId !== site.id || !['passed', 'quality-rejected'].includes(comparison.outcome) || comparison.buildingSkill !== profile.skills.building || !equal(comparison.operation, envelope))) return 'invalid-payload';
  const evaluated = evaluateAssembly(a ? i.designs[a.designId]!.input : null, envelope, profile.skills.building, a?.condition ?? 100);
  if (!evaluated.ok) return 'invalid-payload';
  const id = `invention:job:${i.nextSequence}`,
    ventureId = `invention:operation:${i.nextSequence}`,
    duration = evaluated.value.duration + (production ? remainder : 0),
    bom = aggregate(c.operation, production);
  const result = propose(world, ventureId, actor, site.id, [{
    id: 'controlled',
    label: 'Paid controlled operation',
    durationMinutes: duration,
    requires: requirements(bom)
  }], minute);
  if (result !== 'legal-command') return result;
  allocate(i, 'job');
  i.jobs[id] = {
    id,
    ventureId,
    actorId: actor,
    siteId: site.id,
    operation: c.operation,
    mode: a ? 'assisted' : 'baseline',
    purpose: c.purpose,
    artifactId: a?.id ?? null,
    comparisonTrialId: comparison?.id ?? null,
    targetProjectId: production ? template.consequence.projectId : null,
    revision: 0,
    buildingSkill: profile.skills.building,
    startingCondition: a?.condition ?? 100,
    startedMinute: null,
    endedMinute: null,
    status: 'invited',
    resultTrialId: null,
    appliedProgress: 0,
    ...(a&&i.designs[a.designId]?.methodApplication&&'kind'in i.designs[a.designId]!.methodApplication!&&i.grants[(i.designs[a.designId]!.methodApplication as {grantId:string}).grantId]?.status!=='demonstrated'&&activeMethodGrant(world,i.grants[(i.designs[a.designId]!.methodApplication as {grantId:string}).grantId],minute)?{grantId:(i.designs[a.designId]!.methodApplication as {grantId:string}).grantId}:{})
  };
  if (a) a.revision++;
  bindTask(world, actor, ventureId, id, 'assembly-trial', minute, duration, site.id);
  return 'legal-command';
}
/** BEFORE generic advance: presence and the actual task are mandatory on each paid minute. */
export function gateInventionWork(world: WorldState, minute: number, frozen: ReadonlySet<string>, handled: Set<string>) {
  const i = world.life?.invention;
  if (!i) return;
  gateMethodLessons(world,minute,frozen,handled);
  for (const v of Object.values(world.life!.ventures!.projects)) {
    if(Object.values(i.grants).some(g=>g.method?.lessons.some(l=>l.ventureId===v.id)))continue;
    if (!inventionAssociated(world, v.id)) continue;
    const profile = world.life!.residents[v.proposerId]!,
      person = world.residents[v.proposerId]!,
      task = profile.task;
    const job = Object.values(i.jobs).find(j => j.ventureId === v.id && activeJob(j)),
      artifact = job?.artifactId ? i.artifacts[job.artifactId] : null,
      construction=Object.values(i.designs).find(d=>d.ventureId===v.id),
      dependent=job?.grantId??(construction?.methodApplication&&'kind'in construction.methodApplication?construction.methodApplication.grantId:undefined),
      revoked = !!dependent&&!activeMethodGrant(world,i.grants[dependent],minute) || artifact && artifact.ownerId !== v.proposerId && artifact.access !== 'public-consented';
    if (revoked || !person || person.lifeStage === 'child' || person.placeId !== v.placeId || profile.needs.energy === 0 || frozen.has(v.proposerId) || !task || task.ventureId !== v.id || !['invention-build', 'assembly-trial'].includes(task.kind)) {
      const aborted = abandonProject(world.life!.ventures as ProjectLedger, v.id, minute);
      if (!aborted.ok) throw new Error(aborted.reason);
      world.life!.ventures = aborted.value.ledger as VentureLedger;
      handled.add(v.proposerId);
    }
  }
}
/** AFTER the sole advanceProjects call: account completion, artifact creation, measurements and civic effect once. */
export function settleInventionWork(world: WorldState, minute: number, handled: Set<string>) {
  const i = world.life?.invention,
    v = world.life?.ventures;
  if (!i || !v) return;
  const record = (id: string) => v.projects[id] ?? v.retired.find(x => x.id === id);
  for (const d of Object.values(i.designs).filter(d => d.status === 'building')) {
    const project = record(d.ventureId!)!;
    if (!project) throw new Error('missing invention construction');
    if (project.outcome) {
      d.status = project.status === 'completed' ? 'built' : 'failed';
      const profile = world.life!.residents[d.authorId]!;
      if (profile.task?.ventureId === project.id) profile.task = null;
      handled.add(d.authorId);
      if (d.status === 'built') {
        const slot = [0, 1, 2, 3].find(slot => !Object.values(i.artifacts).some(a => a.siteId === d.input.site && a.slot === slot));
        if (slot === undefined) throw new Error('artifact slot lost');
        const id = allocate(i, 'artifact');
        i.artifacts[id] = {
          id,
          designId: d.id,
          builderId: d.authorId,
          ownerId: d.authorId,
          custodianId: d.authorId,
          siteId: d.input.site,
          slot,
          revision: 0,
          condition: 100,
          completedMinute: minute,
          access: 'owner-only'
        };
      }
    }
  }
  for (const job of Object.values(i.jobs).filter(activeJob)) {
    const project = record(job.ventureId);
    if (!project) throw new Error('missing invention operation');
    const step = project.steps[0]!;
    if (job.startedMinute === null && step.startedMinute !== null) {
      job.startedMinute = step.startedMinute;
      job.status = 'working';
      job.revision++;
    }
    if (!project.outcome) continue;
    const complete = project.status === 'completed',
      {
        envelope,
        template
      } = assemblyOperation(job.operation),
      artifact = job.artifactId ? i.artifacts[job.artifactId]! : null,
      design = artifact ? i.designs[artifact.designId]! : null;
    const result = evaluateAssembly(design?.input ?? null, envelope, job.buildingSkill, job.startingCondition);
    if (!result.ok) throw new Error(result.reason);
    if (job.startedMinute === null) {
      const withdrawnGrant=!!job.grantId&&i.grants[job.grantId]?.status==='revoked';
      const queuedGrant=withdrawnGrant&&minute===project.proposedMinute+1&&project.steps.every(s=>s.startedMinute===null);
      if (complete || minute !== project.proposedMinute&&!queuedGrant || project.steps.some(s => s.consumed.length)) throw new Error('invalid no-start interruption');
      job.status = withdrawnGrant?'revoked':'interrupted';
      job.endedMinute = minute;
      job.revision++;
      if (artifact) artifact.revision++; // Release the exclusive association without recording fictitious use/wear.
      const profile = world.life!.residents[job.actorId]!;
      if (profile.task?.ventureId === job.ventureId) profile.task = null;
      handled.add(job.actorId);
      continue;
    }
    const elapsed = minute - job.startedMinute;
    if (elapsed < 1) throw new Error('measured operation has no paid minute');
    job.status = complete ? result.value.passed ? 'passed' : 'quality-rejected' : (job.grantId&&i.grants[job.grantId]?.status==='revoked'||artifact && artifact.ownerId !== job.actorId && artifact.access !== 'public-consented') ? 'revoked' : 'interrupted';
    job.endedMinute = minute;
    job.revision++;
    if (complete && result.value.passed && job.purpose === 'production') {
      const target = world.life!.projects[job.targetProjectId!]!;
      const before = target.progress;
      target.progress = Math.min(100, before + template.consequence.progress);
      job.appliedProgress = target.progress - before;
    }
    const consumed = {
      timber: 0,
      stone: 0
    };
    for (const s of project.steps) for (const r of s.consumed) consumed[r.resourceId as 'timber' | 'stone'] += r.quantity;
    const comparison = job.comparisonTrialId ? i.trials[job.comparisonTrialId]! : null;
    const useful = complete && result.value.passed && comparison !== null && (comparison.outcome === 'quality-rejected' || comparison.outcome === 'passed' && result.value.duration < comparison.duration);
    let claimVerdict: 'none' | 'supported' | 'refuted' = 'none';
    if (design && complete) {
      const claim = design.input.claim,
        value = claim.metric === 'duration-minutes' ? result.value.duration : result.value.quality;
      claimVerdict = (claim.relation === 'at-most' ? value <= claim.value : value >= claim.value) ? 'supported' : 'refuted';
    }
    const id = allocate(i, 'trial');
    job.resultTrialId = id;
    i.trials[id] = {
      id,
      actorId: job.actorId,
      siteId: job.siteId,
      designId: design?.id ?? null,
      artifactId: artifact?.id ?? null,
      ventureId: job.ventureId,
      stepId: step.id,
      mode: job.mode,
      purpose: job.purpose,
      evaluator: 1,
      operation: envelope,
      buildingSkill: job.buildingSkill,
      startingCondition: job.startingCondition,
      startedMinute: job.startedMinute ?? project.proposedMinute,
      endedMinute: minute,
      outcome: job.status,
      quality: complete ? result.value.quality : 0,
      duration: complete ? result.value.duration : Math.min(32, elapsed),
      consumed,
      claimVerdict,
      comparisonTrialId: job.comparisonTrialId,
      useful: useful && (job.purpose !== 'production' || job.appliedProgress > 0)
    };
    if (artifact) {
      artifact.condition = Math.max(0, artifact.condition - Math.max(1, envelope.load));
      artifact.revision++;
    }
    const profile = world.life!.residents[job.actorId]!;
    if (profile.task?.ventureId === job.ventureId) profile.task = null;
    handled.add(job.actorId);
  }
  settleMethodLessons(world,minute,handled);
}
const SECTIONS = [['methods', 'invention-method-changed'], ['sites', 'invention-site-changed'], ['agendas', 'invention-agenda-changed'], ['consultations', 'invention-consultation-changed'], ['designs', 'invention-design-changed'], ['artifacts', 'invention-artifact-changed'], ['jobs', 'invention-job-changed'], ['trials', 'invention-trial-changed'], ['grants', 'invention-grant-changed']] as const;
export function inventionDeltas(before: InventionState | undefined, after: InventionState | undefined, minute: number): WorldEvent[] {
  if (!before || !after) return [];
  const events: WorldEvent[] = [];
  for (const [section, type] of SECTIONS) for (const [recordId, value] of Object.entries(after[section]??{})) {
    const old = ((before[section]??{}) as Record<string, unknown>)[recordId] ?? null;
    if (!equal(old, value)) events.push({
      type,
      minute,
      recordId,
      before: old,
      after: structuredClone(value)
    } as WorldEvent);
  }
  if (before.nextSequence !== after.nextSequence) events.push({
    type: 'invention-counters-changed',
    minute,
    before: before.nextSequence,
    after: after.nextSequence
  });
  // Withdrawal is authoritative before a dependent job terminal is validated.
  // Earned demonstration stays after its newly measured trial.
  return [...events.filter(e=>e.type==='invention-grant-changed'&&e.after.status==='revoked'),...events.filter(e=>!(e.type==='invention-grant-changed'&&e.after.status==='revoked'))];
}
/** Honest derived accounting; experiments are separate sunk costs, never repaid by a single useful run. */
export function inventionNetValue(world: WorldState, trialId: string) {
  const i = world.life?.invention,
    t = i?.trials[trialId];
  if (!i || !t) return null;
  const d = t.designId ? i.designs[t.designId] : null,
    b = t.comparisonTrialId ? i.trials[t.comparisonTrialId] : null;
  const experiments = Object.values(i.trials).filter(x => x.actorId === t.actorId && x.purpose === 'trial-only');
  const saved = b && b.outcome === 'passed' && t.outcome === 'passed' ? b.duration - t.duration : 0;
  return {
    constructionMaterials: d?.bom ?? null,
    constructionMinutes: d?.buildMinutes ?? 0,
    experimentMaterials: experiments.reduce((n, x) => ({
      timber: n.timber + x.consumed.timber,
      stone: n.stone + x.consumed.stone
    }), {
      timber: 0,
      stone: 0
    }),
    experimentMinutes: experiments.reduce((n, x) => n + x.endedMinute - x.startedMinute, 0),
    productionPaidMinutes: t.purpose === 'production' ? t.endedMinute - t.startedMinute : null,
    theoreticalConstructionBreakEvenExcludingExperiments: d && saved > 0 ? Math.ceil(d.buildMinutes / saved) : null
  };
}

/** Validate derivation at the historical transition while the paid source is still present. */
export function validateInventionEvent(world: WorldState, event: WorldEvent): void {
  if (!event.type.startsWith('invention-')) return;
  const bad = (message: string): never => {
    throw new Error(`invention integrity: ${message}`);
  };
  if (event.type === 'invention-enabled') {
    const previous = structuredClone(world);
    delete previous.life!.invention;
    const expected = enableInvention(previous);
    if (expected.blocked || !equal(expected.state.life!.invention, event.after)) bad('unreviewed enablement');
    return;
  }
  if (event.type === 'invention-command-resolved') return;
  if(event.type==='invention-method-changed'){
    validateMethodGrades(event.after);
    if(event.before){const {applicability:_,...a}=event.before,{applicability:__,...b}=event.after;if(!equal(a,b)||event.before.applicability.state==='invalidated'&&!equal(event.before.applicability,event.after.applicability))bad('immutable method');}
    else if(event.after.admittedMinute!==event.minute||event.after.origin.context.minute>=event.minute||event.after.admissionBasis.minute<event.after.origin.context.minute||event.after.admissionBasis.applicability.state==='invalidated'||event.after.applicability.state==='invalidated')bad('method admission time or invalid origin');
    return;
  }
  if(event.type==='invention-grant-changed'){validateGrantEvent(world,event);return;}
  if (event.type==='invention-site-changed') bad('capability not enabled in this increment');
  const i = world.life?.invention;
  if (!i) bad('invention absent');
  const source = (id: string) => world.life!.ventures!.projects[id] ?? world.life!.ventures!.retired.find(v => v.id === id);
  const paidSource = (v: NonNullable<ReturnType<typeof source>>) => {
    for (const step of v.steps) {
      if (step.status === 'done' && !equal(step.requires, step.consumed) || step.status !== 'done' && step.consumed.length) bad('source consumption mismatch');
      for (const r of step.consumed) {
        const reservation = world.life!.ventures!.resources[r.resourceId]?.terminal.find(x => x.requestId === `${v.id}:${step.id}:${r.resourceId}`);
        if (!reservation || reservation.planId !== v.id || reservation.residentId !== v.proposerId || reservation.quantity !== r.quantity || reservation.status !== 'consumed' || reservation.terminalMinute !== step.completedMinute) bad('source material not actually settled');
      }
    }
  };
  if (event.type === 'invention-design-changed') {
    const d = event.after,
      mechanics = deriveAssemblyDesign(d.input);
    if (!mechanics.ok || !equal(mechanics.value.bom, d.bom) || mechanics.value.buildMinutes !== d.buildMinutes) bad('altered construction accounting');
    if (event.before) {
      const {
          status: _,
          ventureId: __,
          ...old
        } = event.before,
        {
          status: ___,
          ventureId: ____,
          ...next
        } = d;
      if (!equal(old, next) || event.before.status === 'built' || event.before.status === 'failed' || event.before.status === 'building' && !['built', 'failed'].includes(d.status)) bad('immutable design or invalid transition');
    } else if (d.status !== 'validated' || d.createdMinute !== event.minute || !validateInventionDesign(world, d.input, d.authorId, d.methodApplication?.revisionBasisTrialId??null).ok) bad('unvalidated design admission');
    if (d.ventureId) {
      const v = source(d.ventureId);
      if (!v || v.proposerId !== d.authorId || v.placeId !== i!.sites[d.input.site]?.placeId || v.steps.reduce((n, s) => n + s.durationMinutes, 0) !== d.buildMinutes) bad('construction source mismatch');
      if (v && (!equal(v.steps.map(({
        id,
        label,
        durationMinutes,
        requires
      }) => ({
        id,
        label,
        durationMinutes,
        requires
      })), constructionSteps(d)) || v.participants.length)) bad('altered construction source');
      if (v) paidSource(v);
      if (d.status === 'built' && (v!.status !== 'completed' || v!.steps.some(s => !equal(s.requires, s.consumed)))) bad('unpaid artifact');
    }
  }
  if (event.type === 'invention-job-changed') {
    const j = event.after,
      v = source(j.ventureId),
      {
        envelope,
        template,
        remainder
      } = assemblyOperation(j.operation),
      a = j.artifactId ? i!.artifacts[j.artifactId] : null,
      design = a ? i!.designs[a.designId] : null;
    if (!v || v.proposerId !== j.actorId || v.participants.length || v.placeId !== i!.sites[j.siteId]?.placeId || template.placeId !== v.placeId || v.steps.length !== 1) bad('job has no actual paid source');
    if (v) paidSource(v);
    const result = evaluateAssembly(design?.input ?? null, envelope, j.buildingSkill, j.startingCondition);
    if (!result.ok) bad('invalid controlled job');
    if (j.ventureId !== j.id.replace('invention:job:', 'invention:operation:')) bad('job/source id mismatch');
    const expectedDuration = (result.ok ? result.value.duration : 0) + (j.purpose === 'production' ? remainder : 0);
    if (v!.steps[0]!.durationMinutes !== expectedDuration || !equal(v!.steps[0]!.requires, requirements(aggregate(j.operation, j.purpose === 'production')))) bad('altered paid-job inputs');
    if (j.targetProjectId !== (j.purpose === 'production' ? template.consequence.projectId : null) || j.appliedProgress > template.consequence.progress) bad('altered civic association');
    if (event.before) {
      const mutable = new Set(['status', 'revision', 'startedMinute', 'endedMinute', 'resultTrialId', 'appliedProgress']);
      for (const key of Object.keys(j) as (keyof InventionJob)[]) if (!mutable.has(key) && !equal(event.before[key], j[key])) bad('immutable job inputs');
      if (!activeJob(event.before) || j.revision <= event.before.revision || event.before.startedMinute !== null && j.startedMinute !== event.before.startedMinute) bad('terminal replay or revision mismatch');
    } else if (v!.proposedMinute !== event.minute || j.buildingSkill !== world.life!.residents[j.actorId]?.skills.building || j.mode === 'assisted' && !a || j.mode === 'baseline' && j.artifactId !== null) bad('job admission mismatch');
    if (activeJob(j)) {
      if (v!.outcome || j.appliedProgress !== 0 || j.resultTrialId !== null || j.endedMinute !== null) bad('active job mismatch');
    } else {
      if (!v!.outcome || j.endedMinute !== event.minute || j.endedMinute !== v!.outcome.minute || j.startedMinute !== v!.steps[0]!.startedMinute) bad('terminal job source mismatch');
      if (j.startedMinute === null) {
        const withdrawnGrant=!!j.grantId&&i!.grants[j.grantId]?.status==='revoked';const queuedGrant=withdrawnGrant&&event.minute===v!.proposedMinute+1&&v!.steps.every(s=>s.startedMinute===null);
        if (j.resultTrialId !== null || j.status !== (withdrawnGrant?'revoked':'interrupted') || v!.proposedMinute !== event.minute&&!queuedGrant || v!.steps.some(s => s.consumed.length) || j.appliedProgress !== 0) bad('forged no-start interruption');
      } else if (j.resultTrialId === null || event.minute - j.startedMinute < 1) bad('started job missing measured trial');
      const expected = v!.status === 'completed' ? result.ok && result.value.passed ? 'passed' : 'quality-rejected' : (j.grantId&&i!.grants[j.grantId]?.status==='revoked'||a && a.ownerId !== j.actorId && a.access !== 'public-consented') ? 'revoked' : 'interrupted';
      if (j.status !== expected || j.status !== 'passed' && j.appliedProgress !== 0 || j.purpose === 'trial-only' && j.appliedProgress !== 0) bad('functional outcome mismatch');
    }
  }
  if (event.type === 'invention-artifact-changed') {
    const a = event.after,
      d = i!.designs[a.designId];
    if (!d || d.status !== 'built' || a.builderId !== d.authorId || a.siteId !== d.input.site) bad('artifact source mismatch');
    if (!event.before) {
      const v = d?.ventureId ? source(d.ventureId) : null;
      if (!v || v.status !== 'completed' || v.outcome?.minute !== event.minute || a.condition !== 100 || a.completedMinute !== event.minute || a.ownerId !== a.builderId || a.custodianId !== a.builderId || a.access !== 'owner-only' || a.revision !== 0) bad('unpaid artifact creation');
    } else {
      const mutable = new Set(['condition', 'revision', 'access']);
      for (const key of Object.keys(a) as (keyof typeof a)[]) if (!mutable.has(key) && !equal(event.before[key], a[key])) bad('immutable artifact');
      if (a.revision <= event.before.revision || a.condition > event.before.condition) bad('artifact revision/wear');
    }
  }
  if (event.type === 'invention-trial-changed') {
    const t = event.after,
      j = Object.values(i!.jobs).find(j => j.resultTrialId === t.id),
      v = source(t.ventureId);
    if (!j || !v || v.steps[0]?.id !== t.stepId) bad('new trial lacks paid source');
    const {
        envelope
      } = assemblyOperation(j!.operation),
      design = t.designId ? i!.designs[t.designId] : null,
      result = evaluateAssembly(design?.input ?? null, envelope, j!.buildingSkill, j!.startingCondition),
      complete = v!.status === 'completed';
    if (!result.ok || !equal(envelope, t.operation) || t.evaluator !== 1 || t.actorId !== j!.actorId || t.siteId !== j!.siteId || t.mode !== j!.mode || t.purpose !== j!.purpose || t.artifactId !== j!.artifactId || t.designId !== (j!.artifactId ? i!.artifacts[j!.artifactId]!.designId : null) || t.outcome !== j!.status || t.buildingSkill !== j!.buildingSkill || t.startingCondition !== j!.startingCondition || t.comparisonTrialId !== j!.comparisonTrialId || t.endedMinute !== j!.endedMinute || t.startedMinute !== (j!.startedMinute ?? v!.proposedMinute)) bad('trial association mismatch');
    const elapsed = t.endedMinute - t.startedMinute,
      duration = complete && result.ok ? result.value.duration : Math.min(32, elapsed),
      quality = complete && result.ok ? result.value.quality : 0;
    const consumed = {
      timber: 0,
      stone: 0
    };
    for (const s of v!.steps) for (const r of s.consumed) consumed[r.resourceId as 'timber' | 'stone'] += r.quantity;
    if (elapsed < 1) bad('trial has no paid minute');
    if (t.duration !== duration || t.quality !== quality || !equal(t.consumed, consumed) || complete && elapsed !== v!.steps[0]!.durationMinutes) bad('unpaid or altered measurement');
    const b = t.comparisonTrialId ? i!.trials[t.comparisonTrialId] : null;
    if (b && (b.actorId !== t.actorId || b.mode !== 'baseline' || b.buildingSkill !== t.buildingSkill || b.siteId !== t.siteId || !equal(b.operation, t.operation) || !['passed', 'quality-rejected'].includes(b.outcome))) bad('invalid comparison stratum');
    const useful = t.outcome === 'passed' && !!b && (b.outcome === 'quality-rejected' || b.outcome === 'passed' && t.duration < b.duration) && (t.purpose !== 'production' || j!.appliedProgress > 0);
    if (t.useful !== useful) bad('unsupported benefit');
    let verdict = 'none';
    if (design && complete) {
      const c = design.input.claim,
        n = c.metric === 'duration-minutes' ? duration : quality;
      verdict = (c.relation === 'at-most' ? n <= c.value : n >= c.value) ? 'supported' : 'refuted';
    }
    if (t.claimVerdict !== verdict) bad('claim verdict mismatch');
  }
}

/** Whole-minute checks bind counters and the actual civic delta to the same canonical transition. */
export function validateInventionMinute(before: WorldState, after: WorldState, minute: number, events?: readonly WorldEvent[]): void {
  const a = before.life?.invention,
    b = after.life?.invention;
  if (!a || !b) return;
  const methodProblems = inventionMethodCollectionProblems(b.methods);
  if (methodProblems.length) throw new Error(methodProblems.join(';'));
  const cognitive = events?.some(e => e.type === 'invention-command-resolved' && e.command) || Object.values(b.agendas).some(x => x.engaged || x.continuation || Object.hasOwn(x, 'continuation')) || Object.keys(b.consultations).length > 0 || Object.values(a.agendas).some(x => x.engaged || x.continuation);
  if (cognitive && events !== undefined) {
    const commands = events.flatMap(e => e.type === 'invention-command-resolved' && e.command ? [e.command] : []);
    const resolutions = events.filter(e => e.type === 'resident-action-resolved');
    const proposals = resolutions.filter(e => e.reason !== 'legal-option' || !before.life!.residents[e.residentId]?.task).map(e => ({
      residentId: e.residentId,
      observedMinute: e.reason === 'stale-observation' ? before.canonicalMinute - 1 : before.canonicalMinute,
      optionId: e.optionId,
      source: e.source
    }));
    const nextActions = resolutions.filter(e => e.reason === 'legal-option' && e.source === 'local-model' && before.life!.residents[e.residentId]?.task).map(e => ({
      residentId: e.residentId,
      optionId: e.optionId,
      source: 'local-model' as const
    }));
    const generations = new Set(events.flatMap(e => e.type === 'invention-command-resolved' && e.executionGeneration ? [e.executionGeneration] : []));
    if (generations.size > 1) throw new Error('invention command provenance generation mismatch');
    const expected = applyResidentLifeMinute(before, minute, proposals, nextActions, commands, [...generations][0]).state.life!.invention;
    const normalized=structuredClone(b);delete normalized.methods;const plain=structuredClone(expected!);delete plain.methods;plain.nextSequence+=Object.values(b.methods??{}).filter(m=>!a.methods?.[m.id]).length;
    for(const [id,g]of Object.entries(normalized.grants)){const prior=plain.grants[id];if(!g.method||!prior?.method)continue;const added=g.method.executions.slice(prior.method.executions.length);if(added.length){g.method.executions=g.method.executions.slice(0,prior.method.executions.length);g.revision-=added.length;plain.nextSequence+=added.length;}}
    if (!equal(plain, normalized)) throw new Error('invention cognitive transition provenance mismatch');
  }
  for(const m of Object.values(b.methods??{})){const old=a.methods?.[m.id];if(!old&&m.admissionBasis.minute!==before.canonicalMinute)throw Error('method admission basis minute');if(!equal(methodApplicability(m.origin,old?.applicability??m.admissionBasis.applicability,before,after,minute),m.applicability))throw Error('method applicability transition');}
  // Admission binds evaluator inputs to the pre-minute object, including attempts
  // that become terminal before starting. Later wear/revision deltas are not an
  // authority for the condition with which this job was admitted.
  for (const job of Object.values(b.jobs)) {
    if (Object.hasOwn(a.jobs, job.id)) continue;
    const artifact = job.artifactId === null ? undefined : a.artifacts[job.artifactId];
    const startingCondition = job.mode === 'baseline' ? 100 : artifact?.condition;
    if (startingCondition === undefined || job.startingCondition !== startingCondition) {
      throw new Error('invention admission starting condition mismatch');
    }
  }
  const expected: number[] = [];
  for (const section of ['agendas', 'consultations', 'designs', 'artifacts', 'jobs', 'trials', 'grants','methods'] as const) for (const id of Object.keys(b[section]??{})) if (!Object.hasOwn(a[section]??{}, id)) {
    const kind = section === 'agendas' ? 'agenda' : section === 'consultations' ? 'consultation' : section === 'designs' ? 'design' : section === 'artifacts' ? 'artifact' : section === 'jobs' ? 'job' : section === 'trials' ? 'trial' : section==='methods'?'method':'grant';
    const match = new RegExp(`^invention:${kind}:([1-9][0-9]*)$`).exec(id);
    if (!match) throw new Error('invention engine id mismatch');
    expected.push(Number(match[1]));
  }
  for (const d of Object.values(b.designs)) if (d.ventureId && a.designs[d.id]?.ventureId === null) {
    const match = /^invention:build:([1-9][0-9]*)$/.exec(d.ventureId);
    if (!match) throw new Error('invention construction id mismatch');
    expected.push(Number(match[1]));
  }
  for(const g of Object.values(b.grants))for(const e of g.method?.executions??[])if(!a.grants[g.id]?.method?.executions.some(old=>old.id===e.id)){const match=/^invention:execution:([1-9][0-9]*)$/.exec(e.id);if(!match)throw Error('learner execution id');expected.push(Number(match[1]));}
  expected.sort((x, y) => x - y);
  if (b.nextSequence - a.nextSequence !== expected.length || expected.some((n, index) => n !== a.nextSequence + index)) throw new Error('invention allocation conservation mismatch');
  for (const artifact of Object.values(b.artifacts)) {
    const old = a.artifacts[artifact.id];
    if (!old) continue;
    const jobs = Object.values(b.jobs).filter(j => j.artifactId === artifact.id),
      wear = jobs.filter(j => j.endedMinute === minute && j.startedMinute !== null).reduce((n, j) => n + Math.max(1, assemblyOperation(j.operation).envelope.load), 0),
      admissions = jobs.filter(j => !a.jobs[j.id]).length,
      terminals = jobs.filter(j => j.endedMinute === minute).length,
      sharing = old.access === artifact.access ? 0 : 1;
    if (artifact.condition !== Math.max(0, old.condition - wear) || artifact.revision !== old.revision + admissions + terminals + sharing) throw new Error('invention exclusive-use/wear mismatch');
  }
  for (const j of Object.values(b.jobs)) if (j.endedMinute === minute && j.status === 'passed' && j.purpose === 'production') {
    const target = after.life!.projects[j.targetProjectId!]!,
      previous = before.life!.projects[j.targetProjectId!]!,
      {
        template
      } = assemblyOperation(j.operation);
    // Existing upkeep happens before any work in a minute. New-production template admission excludes another venture of that recipe.
    let start = isUpkeepMinute(minute) && previous.progress > UPKEEP_FLOOR ? Math.max(UPKEEP_FLOOR, previous.progress - UPKEEP_WEAR) : previous.progress;
    for (const p of Object.values(before.life!.residents)) if (p.task?.kind === 'use-tool' && p.task.projectId === previous.id && after.life!.residents[p.residentId]!.memories.some(m => m.minute === minute && m.outcome === 'garden-tended' && m.projectId === previous.id)) start = Math.min(100, start + 10);
    const applicable = Math.min(template.consequence.progress, 100 - start);
    if (j.appliedProgress !== applicable || target.progress !== start + applicable) throw new Error('invention actual civic consequence mismatch');
  }
}
