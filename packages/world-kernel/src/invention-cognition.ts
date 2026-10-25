import { planResidentTravel } from "./resident-travel.js";
import { activeMethodGrant } from './invention-learning.js';
import type { InventionAgenda, InventionCommand, InventionCommandReason, InventionState, WorldState } from '@meridian/world-schema';
import { InventionContinuationSchema } from '@meridian/world-schema';
import { methodTask, methodSelection, methodRevisionBasis } from './invention-method.js';
import { assemblyOperation, startInventionPhysical, validateInventionDesign } from './invention.js';

/** A nominal service window, not a wall-clock latency guarantee. Unknown clocks fail closed. */
export function consultationWindow(roster: number, interval: number | undefined, tick: number | undefined, deadline: number): number | null {
  if (![roster, interval, tick, deadline].every(n => Number.isSafeInteger(n) && n! > 0) || roster > 20 || deadline >= interval!) return null;
  const window = 3 * roster * (Math.ceil(interval! / tick!) + 1) + Math.ceil(deadline / tick!) + 2;
  return Number.isSafeInteger(window) && window <= 10000000 ? window : null;
}
const live = (status: string) => status === 'requested' || status === 'accepted';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function allocate(i: InventionState, kind: string) {
  if (i.nextSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('invention sequence exhausted');
  return `invention:${kind}:${i.nextSequence++}`;
}
export function applyInventionCognition(world: WorldState, c: InventionCommand, minute: number): InventionCommandReason | undefined {
  if (c.action !== 'agenda' && c.action !== 'candidate' && c.action !== 'consult-request' && c.action !== 'consult-reply' && c.action !== 'author-method' && c.action !== 'adopt-version') return undefined;
  const i = world.life!.invention!,
    actor = c.residentId;
  if (i.nextSequence > Number.MAX_SAFE_INTEGER - 16 || minute > Number.MAX_SAFE_INTEGER - 10000000) return 'record-cap';
  if (c.action === 'consult-reply') {
    const consultation = i.consultations[c.consultationId];
    if (!consultation || consultation.siteId !== c.siteId) return 'unknown-reference';
    if (consultation.revision >= Number.MAX_SAFE_INTEGER - 8) return 'record-cap';
    if (consultation.revision !== c.consultationRevision || !(live(consultation.status) || c.response === 'withdraw' && consultation.status === 'answered') || c.response !== 'withdraw' && minute >= consultation.expiresMinute) return 'stale';
    if (c.response === 'withdraw') {
      if (actor !== consultation.requesterId && actor !== consultation.peerId) return 'consent-required';
      if (c.answer !== null) return 'invalid-payload';
      consultation.status = 'withdrawn';
    } else {
      if (actor !== consultation.peerId) return 'consent-required';
      if (c.response !== 'answer' && c.answer !== null) return 'invalid-payload';
      if (c.response === 'accept') {
        if (consultation.status !== 'requested') return 'unavailable';
        consultation.status = 'accepted';
        consultation.expiresMinute = minute + c.windowMinutes;
      } else if (c.response === 'decline') consultation.status = 'declined';else {
        const answer = c.answer;
        if (consultation.status !== 'accepted' || !answer || answer.speakerId !== actor || new Set(answer.sourceTrialIds).size !== answer.sourceTrialIds.length) return 'invalid-payload';
        const permitted = (id: string) => !!i.trials[id] && (i.trials[id]!.actorId === actor || id === consultation.needTrialId);
        if (!answer.sourceTrialIds.every(permitted) || answer.certainty === 'observed' && !answer.sourceTrialIds.length) return 'consent-required';
        consultation.answer = structuredClone(answer);
        consultation.status = 'answered';
      }
    }
    consultation.revision++;
    const agenda = Object.values(i.agendas).find(a => a.consultationId === consultation.id);
    if (agenda) {
      agenda.revision++;
      if (!live(consultation.status) && agenda.stage !== 'paused' && agenda.stage !== 'closed') agenda.stage = 'compare';
    }
    return 'legal-command';
  }
  const agendaId = c.agendaId;
  let agenda = agendaId === null ? undefined : i.agendas[agendaId];
  if (agenda && (agenda.ownerId !== actor || agenda.siteId !== c.siteId)) return 'consent-required';
  if (agendaId !== null && !agenda) return 'unknown-reference';
  if (agenda && agenda.revision >= Number.MAX_SAFE_INTEGER - 8) return 'record-cap';
  if (agenda && (agenda.revision !== c.agendaRevision || agenda.stage === 'closed')) return 'stale';
  if (c.action === 'author-method' || c.action === 'adopt-version') {
    if(agenda?.grantId)return 'unavailable';
    const profile = world.life!.residents[actor]!,
      person = world.residents[actor]!;
    if (!agenda || !agenda.needTrialId || agenda.stage === 'paused' || !same(methodTask(profile.task), c.task)) return 'stale';
    if (agenda.candidateIds.some(id => !i.designs[id]?.methodApplication)) return 'unavailable';
    if (!methodRevisionBasis(world, actor, agenda.id, c.revisionBasisTrialId)) return 'unavailable';
    if (c.action === 'author-method') {
      if (Object.keys(i.methods ?? {}).length >= 64) return 'record-cap';
      if (profile.needs.energy < 20 || person.placeId !== i.sites[agenda.siteId]!.placeId) return 'unavailable';
      const need = i.trials[agenda.needTrialId],
        job = Object.values(i.jobs).find(j => j.resultTrialId === need?.id);
      if (!need || !job || need.actorId !== actor || need.mode !== 'baseline' || !['passed', 'quality-rejected'].includes(need.outcome) || (world.life!.projects[assemblyOperation(job.operation).template.consequence.projectId]?.progress ?? 100) >= 100) return 'unavailable';
      agenda.authoring = 'executable-v1';
      agenda.engaged = true;
      if (agenda.continuation?.status !== 'running') agenda.continuation = {
        kind: 'observe',
        designId: null,
        artifactId: null,
        artifactRevision: null,
        operation: null,
        purpose: null,
        comparisonTrialId: null,
        status: 'pending',
        sourceId: null
      };
      agenda.revision++;
      return 'legal-command';
    }
    if (agenda.authoring !== 'executable-v1' || person.placeId !== i.sites[agenda.siteId]!.placeId || profile.needs.energy < 20) return 'unavailable';
    const selected = methodSelection(world, actor, agenda.id, c.methodVersionId);
    if (!selected) return 'unavailable';
    if (agenda.candidateIds.some(id => {
      const d = i.designs[id]!,
        m = d.methodApplication && i.methods?.[d.methodApplication.methodVersionId];
      return m?.origin.context.session === selected.method.origin.context.session || same(d.input.parts, selected.result.design!.parts);
    })) return 'conflicting-duplicate';
    const basis = c.revisionBasisTrialId === null ? null : i.trials[c.revisionBasisTrialId]!,
      input = {
        grammar: 1 as const,
        evaluator: 1 as const,
        need: agenda.needTrialId,
        site: agenda.siteId,
        parent: basis?.designId ?? null,
        ...structuredClone(selected.result.design!)
      };
    const valid = validateInventionDesign(world, input, actor, c.revisionBasisTrialId);
    if (!valid.ok) return 'invalid-payload';
    if (Object.keys(i.designs).length >= 512) return 'record-cap';
    const id = allocate(i, 'design');
    i.designs[id] = {
      id,
      authorId: actor,
      createdMinute: minute,
      input,
      ...valid.value,
      status: 'validated',
      ventureId: null,
      methodApplication: {
        methodVersionId: selected.method.id,
        authority: structuredClone(selected.method.authority),
        receiptHash: selected.receipt.hash,
        caseIndex: selected.index,
        inputHash: selected.execution.inputHash,
        outputHash: selected.execution.firstHash!,
        adoption: {
          requestId: c.requestId,
          observedMinute: c.observedMinute,
          generation: c.generation,
          agendaRevision: c.agendaRevision,
          siteRevision: c.siteRevision,
          task: structuredClone(c.task)
        },
        revisionBasisTrialId: c.revisionBasisTrialId
      }
    };
    if (basis) {
      agenda.candidateIds = agenda.candidateIds.map(x => x === basis.designId ? id : x);
      if (agenda.selectedDesignId === basis.designId) agenda.selectedDesignId = null;
    } else agenda.candidateIds.push(id);
    agenda.engaged = true;
    agenda.stage = 'compare';
    agenda.revision++;
    return 'legal-command';
  }
  if (c.action === 'agenda') {
    if (c.choice === 'pause' || c.choice === 'resume' || c.choice === 'withdraw') {
      if (!agenda || c.designId !== null || c.operation !== null || c.purpose !== null || c.artifactId !== null || c.artifactRevision !== null || c.comparisonTrialId !== null) return 'invalid-payload';
      if (c.choice === 'withdraw') {
        agenda.stage = 'closed';
        if (agenda.continuation?.status !== 'running') delete agenda.continuation;
        const consultation = agenda.consultationId && i.consultations[agenda.consultationId];
        if (consultation && live(consultation.status)) {
          consultation.status = 'withdrawn';
          consultation.revision++;
        }
      } else agenda.stage = c.choice === 'pause' ? 'paused' : agenda.continuation?.kind === 'build' ? 'build' : agenda.needTrialId ? 'compare' : 'observe';
      agenda.revision++;
      return 'legal-command';
    }
    if (agenda?.continuation?.status === 'running') return 'unavailable';
    const continuation = InventionContinuationSchema.safeParse({
      kind: c.choice,
      designId: c.designId,
      artifactId: c.artifactId,
      artifactRevision: c.artifactRevision,
      operation: c.operation,
      purpose: c.purpose,
      comparisonTrialId: c.comparisonTrialId,
      status: 'pending',
      sourceId: null
    });
    if (!continuation.success) return 'invalid-payload';
    if (c.choice === 'build') {
      const design = c.designId && i.designs[c.designId];
      if (!agenda || (agenda.grantId?agenda.candidateIds.length!==1||!activeMethodGrant(world,i.grants[agenda.grantId],minute):agenda.candidateIds.length!==2) || !design || design.authorId !== actor || design.status !== 'validated' || !agenda.candidateIds.includes(design.id)) return 'unavailable';
    }
    if (c.choice === 'operate') {
      if (!c.operation || assemblyOperation(c.operation).template.placeId !== i.sites[c.siteId]!.placeId) return 'unknown-reference';
      if (agenda && agenda.trialIds.length >= 8) return 'record-cap';
      if (c.comparisonTrialId !== null) {
        const comparison = i.trials[c.comparisonTrialId];
        if (!comparison || comparison.actorId !== actor || comparison.mode !== 'baseline' || comparison.siteId !== c.siteId || !['passed', 'quality-rejected'].includes(comparison.outcome) || comparison.buildingSkill !== world.life!.residents[actor]!.skills.building || !same(comparison.operation, assemblyOperation(c.operation).envelope)) return 'invalid-payload';
      }
    }
    if (c.choice === 'operate' && c.artifactId !== null) {
      const a = i.artifacts[c.artifactId];
      if (!a || a.revision !== c.artifactRevision || a.siteId !== c.siteId) return 'stale';
      if (a.ownerId !== actor && a.access !== 'public-consented') return 'consent-required';
    }
    if (!agenda) {
      if (Object.values(i.agendas).some(a => a.ownerId === actor && a.stage !== 'closed')) return 'unavailable';
      if (Object.keys(i.agendas).length >= 128 || c.agendaRevision !== null) return 'record-cap';
      const id = allocate(i, 'agenda');
      agenda = {
        id,
        engaged: true,
        ownerId: actor,
        siteId: c.siteId,
        revision: 0,
        needTrialId: null,
        stage: 'observe',
        candidateIds: [],
        selectedDesignId: null,
        consultationId: null,
        trialIds: [],
        grantId: null,
        blocked: 'none'
      };
      i.agendas[id] = agenda;
    }
    agenda.engaged = true;
    agenda.continuation = continuation.data;
    agenda.stage = c.choice === 'build' ? 'build' : c.artifactId ? 'test' : 'observe';
    if (c.choice === 'build') agenda.selectedDesignId = c.designId;
    agenda.blocked = 'none';
    agenda.revision++;
    return 'legal-command';
  }
  if (!agenda || !agenda.needTrialId || agenda.stage === 'paused') return 'unavailable';
  if (c.action === 'candidate') {
    if (agenda.grantId || agenda.authoring || agenda.candidateIds.length >= 2 || c.input.need !== agenda.needTrialId || c.input.site !== agenda.siteId) return 'unavailable';
    if (agenda.candidateIds.some(id => same(i.designs[id]!.input.parts, c.input.parts))) return 'conflicting-duplicate';
    const valid = validateInventionDesign(world, c.input, actor);
    if (!valid.ok) return 'invalid-payload';
    if (Object.keys(i.designs).length >= 512) return 'record-cap';
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
    agenda.engaged = true;
    agenda.candidateIds.push(id);
    agenda.stage = 'compare';
    agenda.revision++;
    return 'legal-command';
  }
  if (c.action === 'consult-request') {
    if (!world.residents[c.peerId] || world.residents[c.peerId]!.lifeStage === 'child' || c.peerId === actor) return 'unknown-reference';
    if (Object.keys(i.consultations).length >= 256) return 'record-cap';
    if ([actor, c.peerId].some(id => Object.values(i.consultations).filter(x => live(x.status) && (x.requesterId === id || x.peerId === id)).length >= 2)) return 'record-cap';
    if (agenda.consultationId && live(i.consultations[agenda.consultationId]!.status)) return 'unavailable';
    const id = allocate(i, 'consultation');
    i.consultations[id] = {
      id,
      revision: 0,
      requesterId: actor,
      peerId: c.peerId,
      siteId: c.siteId,
      needTrialId: agenda.needTrialId,
      question: c.question,
      status: 'requested',
      createdMinute: minute,
      expiresMinute: minute + c.windowMinutes,
      answer: null
    };
    agenda.consultationId = id;
    agenda.stage = 'consult';
    agenda.revision++;
    return 'legal-command';
  }
  return 'invalid-payload';
}
export function expireInventionConsultations(world: WorldState, minute: number) {
  const i = world.life?.invention;
  if (!i) return;
  for (const c of Object.values(i.consultations)) if (live(c.status) && minute >= c.expiresMinute) {
    c.status = 'expired';
    c.revision++;
    const a = Object.values(i.agendas).find(a => a.consultationId === c.id);
    if (a && a.stage !== 'closed' && a.stage !== 'paused') {
      a.stage = 'compare';
      a.revision++;
    }
  }
}
function blocked(a: InventionAgenda, value: InventionAgenda['blocked']) {
  if (a.blocked !== value) {
    a.blocked = value;
    a.revision++;
  }
}
/** Existing automatic-choice boundary only; no model decisions, stale command or second runner. */
export function continueResidentAgenda(world: WorldState, actor: string, minute: number): boolean {
  const i = world.life?.invention,
    profile = world.life?.residents[actor],
    person = world.residents[actor];
  const a = i && Object.values(i.agendas).find(a => a.ownerId === actor && a.engaged && a.stage !== 'closed' && a.stage !== 'paused');
  if (!i || !a || !profile || !person || profile.task) return false;
  if (profile.needs.energy < 40) {
    const travel=planResidentTravel(world,actor,person.homePlaceId,minute);
    if(!travel)return false;
    const {minutes,...legs}=travel;
    profile.task = {
      kind: 'rest',
      label: 'Recover before chosen assembly work',
      startedMinute: minute,
      endsMinute: minute + 8 + minutes,
      placeId: person.homePlaceId,
      decisionSource: 'engine', ...legs
    };
    world.residents[actor] = {
      ...person,
      placeId: travel.minutes ? person.placeId : person.homePlaceId,
      activity: 'home'
    };
    return true;
  }
  const site = i.sites[a.siteId]!;
  if (person.placeId !== site.placeId) {
    const travel=planResidentTravel(world,actor,site.placeId,minute);
    if(!travel)return false;
    const {minutes,...legs}=travel;
    profile.task = {
      kind: 'invention-travel',
      label: world.life!.transit ? 'Travel to the public workpad' : 'Simulated travel to public workpad',
      startedMinute: minute,
      endsMinute: minute + (minutes || 1),
      placeId: site.placeId,
      inventionId: a.id,
      decisionSource: 'engine', ...legs
    };
    world.residents[actor] = {
      ...person,
      activity: 'leisure'
    };
    return true;
  }
  const c = a.continuation;
  if (!c || c.kind === 'observe' || c.status === 'running') return true;
  const choice = c.kind === 'build' ? {
    action: 'build' as const,
    designId: c.designId!
  } : {
    action: 'operate' as const,
    operation: c.operation!,
    purpose: c.purpose!,
    artifactId: c.artifactId,
    artifactRevision: c.artifactRevision,
    comparisonTrialId: c.comparisonTrialId
  };
  const result = startInventionPhysical(world, {
    residentId: actor,
    siteId: a.siteId,
    ...choice
  }, minute);
  if (result !== 'legal-command') {
    blocked(a, result === 'resources-unavailable' ? 'resources' : result === 'consent-required' ? 'consent' : result === 'record-cap' ? 'record-cap' : 'busy');
    return true;
  }
  const task = world.life!.residents[actor]!.task;
  if (!task?.ventureId) throw new Error('continuation lacks actual paid source');
  c.status = 'running';
  c.sourceId = task.ventureId;
  a.revision++;
  return true;
}
export function settleResidentAgendas(world: WorldState) {
  const i = world.life?.invention;
  if (!i) return;
  for (const a of Object.values(i.agendas)) {
    const c = a.continuation;
    if (c?.status !== 'running') continue;
    const d = Object.values(i.designs).find(d => d.ventureId === c.sourceId),
      job = Object.values(i.jobs).find(j => j.ventureId === c.sourceId);
    if (d && ['built', 'failed'].includes(d.status)) {
      delete a.continuation;
      if (a.stage !== 'paused' && a.stage !== 'closed') a.stage = d.status === 'built' ? 'test' : 'review';
      a.revision++;
    }
    if (job && !['invited', 'working'].includes(job.status)) {
      if (job.resultTrialId) {
        if (a.trialIds.length < 8) a.trialIds.push(job.resultTrialId);else blocked(a, 'record-cap');
        if (job.mode === 'baseline') a.needTrialId = job.resultTrialId;
      }
      delete a.continuation;
      if (a.stage !== 'paused' && a.stage !== 'closed') a.stage = job.mode === 'baseline' ? 'consult' : 'review';
      a.revision++;
    }
  }
}
export function pauseResidentAgenda(world: WorldState, actor: string) {
  const a = Object.values(world.life?.invention?.agendas ?? {}).find(a => a.ownerId === actor && a.stage !== 'closed' && a.stage !== 'paused');
  if (a && a.continuation?.status !== 'running') {
    a.stage = 'paused';
    a.revision++;
  }
}
