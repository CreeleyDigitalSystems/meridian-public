import type { GrantMethod, InventionCommand, InventionCommandReason, InventionGrant, LearnerExecution, VentureLedger, WorldState, WorldEvent } from '@meridian/world-schema';
import { LearnerExecutionSchema } from '@meridian/world-schema';
import { methodInput, methodTask, validateMethodGrades } from './invention-method.js';
import { deriveAssemblyDesign } from './invention-evaluator.js';
import { abandonProject, proposeProject, respondToInvitation, type ProjectLedger } from './project-lifecycle.js';
import { inventionDeltas } from './invention.js';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const LESSON_MINUTES = 4;
export function teachingWindow(c: {
  roster: number;
  roundMinutes: number;
} | undefined): number | null {
  if (!c || !Number.isSafeInteger(c.roster) || c.roster < 2 || c.roster > 512 || !Number.isSafeInteger(c.roundMinutes) || c.roundMinutes < 1 || c.roundMinutes > 100000) return null;
  return 12 * c.roundMinutes + LESSON_MINUTES;
}
export function teachableMethod(w: WorldState, actor: string, artifactId: string, trialId: string) {
  const i = w.life?.invention,
    a = i?.artifacts[artifactId],
    d = a && i?.designs[a.designId],
    app = d?.methodApplication,
    t = i?.trials[trialId],
    m = app && i?.methods?.[app.methodVersionId];
  if (!i || !a || a.ownerId !== actor || a.builderId !== actor || a.condition === 0 || !d || d.authorId !== actor || d.status !== 'built' || !app || 'kind' in app || !m || m.authorId !== actor || !t || t.actorId !== actor || t.artifactId !== a.id || t.designId !== d.id || t.mode !== 'assisted' || t.outcome !== 'passed' || !t.useful || t.claimVerdict === 'refuted' || t.endedMinute > w.canonicalMinute) return;
  return {
    artifact: a,
    design: d,
    method: m,
    application: app,
    trial: t
  };
}
export function activeMethodGrant(w: WorldState, g: InventionGrant | undefined, minute = w.canonicalMinute): g is InventionGrant & {
  method: GrantMethod;
} {
  if (!g?.method || !['accepted', 'demonstrated'].includes(g.status) || minute >= g.expiresMinute || !g.method.acceptance) return false;
  const proof = teachableMethod(w, g.teacherId, g.method.teacherArtifactId, g.trialId);
  return !!proof && proof.method.id === g.method.methodVersionId && proof.method.sourceHash === g.method.sourceHash && proof.method.artifactHash === g.method.artifactHash && same(proof.method.authority, g.method.authority) && proof.application.receiptHash === g.method.receiptHash;
}
export function completedMethodLesson(w: WorldState, g: InventionGrant | undefined) {
  if (!activeMethodGrant(w, g)) return false;
  const l = g.method.lessons.at(-1);
  // This closed terminal was validated against the actual paid venture when committed.
  // Bounded generic venture retirement does not erase the immutable canonical lesson.
  return !!l && l.status === 'completed' && l.startedMinute !== null && l.endedMinute !== null && l.endedMinute - l.startedMinute === LESSON_MINUTES;
}
function choice(c: Extract<InventionCommand, {
  action: 'offer-method' | 'grant-choice';
}>, agendaRevision = 0) {
  return {
    requestId: c.requestId,
    observedMinute: c.observedMinute,
    generation: c.generation,
    agendaRevision,
    siteRevision: c.siteRevision,
    task: structuredClone(c.task)
  };
}
const alloc = (w: WorldState, kind: string) => `invention:${kind}:${w.life!.invention!.nextSequence++}`;
export function learnerExecutionCurrent(w: WorldState, g: InventionGrant, e: LearnerExecution, minute = w.canonicalMinute) {
  const a = w.life?.invention?.agendas[e.agendaId],
    p = w.life?.residents[g.learnerId],
    site = a && w.life?.invention?.sites[a.siteId],
    input = a && methodInput(w, g.learnerId, a.id);
  return completedMethodLesson(w, g) && minute < g.expiresMinute && e.grantId === g.id && e.methodVersionId === g.method!.methodVersionId && e.learnerId === g.learnerId && a?.ownerId === g.learnerId && !['paused', 'closed'].includes(a.stage) && a.siteId === w.life?.invention?.designs[g.designId]?.input.site && a.needTrialId === e.context.need && a.revision === e.agendaRevision && site?.revision === e.siteRevision && w.residents[g.learnerId]?.placeId === site.placeId && !!p && p.needs.energy >= 20 && same(methodTask(p.task), e.task) && same(input, e.input) && e.sourceHash === g.method!.sourceHash && e.artifactHash === g.method!.artifactHash;
}
export function failedReproduction(w: WorldState, actor: string, designId: string) {
  const i = w.life?.invention,
    d = i?.designs[designId];
  return !!d && d.authorId === actor && !!d.methodApplication && 'kind' in d.methodApplication && (d.status === 'failed' || Object.values(i!.trials).some(t => t.designId === designId && t.actorId === actor && t.mode === 'assisted' && (t.outcome === 'quality-rejected' || t.claimVerdict === 'refuted')));
}
export function mayRetestGrant(w: WorldState, actor: string, agendaId: string, grantId: string) {
  const a = w.life?.invention?.agendas[agendaId];
  return !!a && (a.grantId === null || a.grantId === grantId || a.candidateIds.every(id => failedReproduction(w, actor, id))) && a.candidateIds.every(id => {
    const app = w.life?.invention?.designs[id]?.methodApplication;
    return !!app && 'kind' in app && (app.grantId === grantId || failedReproduction(w, actor, id));
  });
}
export function applyLearningCommand(w: WorldState, c: InventionCommand, minute: number): InventionCommandReason | undefined {
  if (c.action !== 'offer-method' && c.action !== 'grant-choice') return undefined;
  const i = w.life!.invention!,
    actor = c.residentId,
    p = w.life!.residents[actor]!,
    site = i.sites[c.siteId]!;
  if (!same(methodTask(p.task), c.task)) return 'stale';
  if (i.nextSequence > Number.MAX_SAFE_INTEGER - 16) return 'record-cap';
  if (c.action === 'offer-method') {
    const proof = teachableMethod(w, actor, c.artifactId, c.trialId),
      window = teachingWindow(c.cadence);
    if (!proof || proof.method.id !== c.methodVersionId || proof.artifact.siteId !== site.id || proof.artifact.revision !== c.artifactRevision || !window) return 'unavailable';
    if (!w.residents[c.learnerId] || w.residents[c.learnerId]!.lifeStage === 'child' || c.learnerId === actor) return 'consent-required';
    if (!same(methodTask(w.life!.residents[c.learnerId]!.task), c.peerTask)) return 'stale';
    if (Object.keys(i.grants).length >= 256 || minute > Number.MAX_SAFE_INTEGER - window) return 'record-cap';
    if (Object.values(i.grants).some(g => g.teacherId === actor && g.learnerId === c.learnerId && g.method?.methodVersionId === c.methodVersionId && ['offered', 'accepted', 'demonstrated'].includes(g.status) && g.expiresMinute > minute)) return 'conflicting-duplicate';
    if ([actor, c.learnerId].some(party => Object.values(i.grants).filter(g => [g.teacherId, g.learnerId].includes(party) && ['offered', 'accepted', 'demonstrated'].includes(g.status) && g.expiresMinute > minute).length >= 2)) return 'record-cap';
    const id = alloc(w, 'grant');
    i.grants[id] = {
      id,
      revision: 0,
      teacherId: actor,
      learnerId: c.learnerId,
      designId: proof.design.id,
      trialId: c.trialId,
      status: 'offered',
      expiresMinute: minute + window,
      reproductionArtifactId: null,
      reproductionTrialId: null,
      method: {
        methodVersionId: proof.method.id,
        sourceHash: proof.method.sourceHash,
        artifactHash: proof.method.artifactHash,
        authority: structuredClone(proof.method.authority),
        receiptHash: proof.application.receiptHash,
        teacherArtifactId: proof.artifact.id,
        cadence: structuredClone(c.cadence),
        offer: choice(c),
        invitationId: `${id}:lesson:1`,
        acceptance: null,
        lessons: [],
        executions: []
      }
    };
    return 'legal-command';
  }
  const g = i.grants[c.grantId],
    m = g?.method;
  if (!g || !m || i.designs[g.designId]?.input.site !== c.siteId) return 'unknown-reference';
  if (g.revision !== c.grantRevision || g.revision > Number.MAX_SAFE_INTEGER - 16) return 'stale';
  if (actor !== g.teacherId && actor !== g.learnerId) return 'consent-required';
  const peer = actor === g.teacherId ? g.learnerId : g.teacherId;
  if (!same(methodTask(w.life!.residents[peer]?.task ?? null), c.peerTask)) return 'stale';
  if (c.choice === 'revoke') {
    if (!['offered', 'accepted', 'demonstrated'].includes(g.status)) return 'unavailable';
    g.status = 'revoked';
    g.revision++;
    return 'legal-command';
  }
  if (minute >= g.expiresMinute || g.status === 'revoked' || g.status === 'declined') return 'consent-required';
  if (c.choice === 'accept' || c.choice === 'decline') {
    if (actor !== g.learnerId || m.acceptance !== null || !['offered', 'accepted'].includes(g.status)) return 'consent-required';
    if (!teachableMethod(w, g.teacherId, m.teacherArtifactId, g.trialId)) return 'unavailable';
    g.status = c.choice === 'decline' ? 'declined' : 'accepted';
    if (c.choice === 'accept') m.acceptance = choice(c, c.agendaRevision ?? 0);
    g.revision++;
    return 'legal-command';
  }
  if (!activeMethodGrant(w, g, minute)) return 'consent-required';
  if (c.choice === 'invite-lesson') {
    if (actor !== g.teacherId || m.lessons.at(-1)?.status !== 'interrupted' || m.lessons.at(-1)?.invitationId !== m.invitationId || m.lessons.length >= 8) return 'unavailable';
    m.invitationId = `${g.id}:lesson:${m.lessons.length + 1}`;
    m.acceptance = null;
    g.revision++;
    return 'legal-command';
  }
  if (c.choice === 'start-lesson') {
    if (actor !== g.teacherId || m.lessons.some(l => l.invitationId === m.invitationId) || m.lessons.length >= 8 || g.expiresMinute <= minute + LESSON_MINUTES) return 'unavailable';
    if ([g.teacherId, g.learnerId].some(id => w.life!.residents[id]!.task || w.life!.residents[id]!.needs.energy < 20 || w.residents[id]!.placeId !== site.placeId)) return 'unavailable';
    const v = proposeProject(w.life!.ventures as ProjectLedger, {
      id: m.invitationId,
      label: 'Consented frozen method lesson',
      placeId: site.placeId,
      proposerId: g.teacherId,
      invitees: [g.learnerId],
      steps: [{
        id: 'lesson',
        label: 'Practice one frozen method together',
        durationMinutes: LESSON_MINUTES,
        requires: []
      }],
      consentDeadlineMinute: minute + 1,
      deadlineMinute: minute + LESSON_MINUTES + 1
    }, minute);
    if (!v.ok) return 'record-cap';
    const accepted = respondToInvitation(v.value, m.invitationId, g.learnerId, 'accepted', minute);
    if (!accepted.ok) return 'unavailable';
    w.life!.ventures = accepted.value.ledger as VentureLedger;
    m.lessons.push({
      invitationId: m.invitationId,
      ventureId: m.invitationId,
      startedMinute: null,
      endedMinute: null,
      status: 'working',
      acceptance: structuredClone(m.acceptance!),
      start: choice(c, c.agendaRevision ?? 0)
    });
    for (const id of [g.teacherId, g.learnerId]) {
      w.life!.residents[id]!.task = {
        kind: 'invention-teach',
        label: 'Learn one method together',
        startedMinute: minute,
        endsMinute: minute + LESSON_MINUTES,
        placeId: site.placeId,
        partnerId: id === g.teacherId ? g.learnerId : g.teacherId,
        ventureId: m.invitationId,
        inventionId: g.id,
        decisionSource: 'engine'
      };
      w.residents[id] = {
        ...w.residents[id]!,
        activity: 'work'
      };
    }
    g.revision++;
    return 'legal-command';
  }
  const a = c.agendaId === null ? undefined : i.agendas[c.agendaId];
  if (actor !== g.learnerId || !completedMethodLesson(w, g) || !a || a.ownerId !== actor || a.siteId !== c.siteId || a.revision !== c.agendaRevision || !a.needTrialId || ['paused', 'closed'].includes(a.stage) || p.needs.energy < 20 || w.residents[actor]!.placeId !== site.placeId) return 'unavailable';
  if (!mayRetestGrant(w, actor, a.id, g.id) || c.choice !== 'retest' && a.grantId !== g.id) return 'unavailable';
  if (c.choice === 'retest') {
    if (p.task) return 'unavailable';
    if (m.executions.length >= 8) return 'record-cap';
    a.grantId = g.id;
    a.engaged = true;
    a.stage = 'reproduce';
    a.revision++;
    return 'legal-command';
  }
  if (c.choice !== 'adopt-reproduction' || !c.executionId) return 'invalid-payload';
  const e = m.executions.find(e => e.id === c.executionId),
    result = e?.test.results[0],
    run = e?.test.executions[0];
  if (!e || !learnerExecutionCurrent(w, g, e) || !e.test.passed || !result?.passed || !result.design || !run?.firstHash) return 'unavailable';
  if (Object.values(i.designs).some(d => d.methodApplication && 'kind' in d.methodApplication && d.methodApplication.executionId === e.id)) return 'conflicting-duplicate';
  if (a.candidateIds.length && !a.candidateIds.every(id => {
    const d = i.designs[id]!;
    return d.status === 'failed' || Object.values(i.trials).some(t => t.designId === id && t.actorId === actor && t.mode === 'assisted' && (t.outcome === 'quality-rejected' || t.claimVerdict === 'refuted'));
  })) return 'unavailable';
  if (Object.keys(i.designs).length >= 512) return 'record-cap';
  const parent = a.candidateIds.at(-1) ?? null,
    input = {
      grammar: 1 as const,
      evaluator: 1 as const,
      need: a.needTrialId,
      site: a.siteId,
      parent,
      ...structuredClone(result.design)
    },
    mechanics = deriveAssemblyDesign(input);
  if (!mechanics.ok) return 'invalid-payload';
  const id = alloc(w, 'design');
  i.designs[id] = {
    id,
    authorId: actor,
    createdMinute: minute,
    input,
    ...mechanics.value,
    status: 'validated',
    ventureId: null,
    methodApplication: {
      kind: 'reproduction',
      grantId: g.id,
      executionId: e.id,
      teacherId: g.teacherId,
      methodVersionId: m.methodVersionId,
      authority: structuredClone(m.authority),
      receiptHash: e.test.hash,
      caseIndex: 0,
      inputHash: run.inputHash,
      outputHash: run.firstHash,
      adoption: choice(c, a.revision),
      revisionBasisTrialId: parent ? Object.values(i.trials).find(t => t.designId === parent && t.actorId === actor && t.mode === 'assisted' && (t.outcome === 'quality-rejected' || t.claimVerdict === 'refuted'))?.id ?? null : null
    }
  };
  a.candidateIds = [id];
  a.selectedDesignId = null;
  a.grantId = g.id;
  a.stage = 'build';
  a.revision++;
  return 'legal-command';
}
export function expireMethodGrants(w: WorldState, minute: number) {
  for (const g of Object.values(w.life?.invention?.grants ?? {})) if (g.method && ['offered', 'accepted', 'demonstrated'].includes(g.status) && (minute >= g.expiresMinute || !teachableMethod(w, g.teacherId, g.method.teacherArtifactId, g.trialId))) {
    g.status = 'revoked';
    g.revision++;
  }
}
export function gateMethodLessons(w: WorldState, minute: number, frozen: ReadonlySet<string>, handled: Set<string>) {
  for (const g of Object.values(w.life?.invention?.grants ?? {})) {
    const l = g.method?.lessons.at(-1);
    if (l?.status !== 'working') continue;
    const v = w.life!.ventures!.projects[l.ventureId];
    if (!v) continue;
    const invalid = !activeMethodGrant(w, g, minute) || [g.teacherId, g.learnerId].some(id => {
      const p = w.life!.residents[id],
        task = p?.task;
      return !p || w.residents[id]?.lifeStage === 'child' || w.residents[id]?.placeId !== v.placeId || p.needs.energy === 0 || frozen.has(id) || task?.kind !== 'invention-teach' || task.inventionId !== g.id || task.ventureId !== v.id || task.partnerId !== (id === g.teacherId ? g.learnerId : g.teacherId);
    });
    if (invalid) {
      const aborted = abandonProject(w.life!.ventures as ProjectLedger, v.id, minute);
      if (!aborted.ok) throw Error(aborted.reason);
      w.life!.ventures = aborted.value.ledger as VentureLedger;
      for (const id of [g.teacherId, g.learnerId]) handled.add(id);
    }
  }
}
export function settleMethodLessons(w: WorldState, minute: number, handled: Set<string>) {
  const i = w.life?.invention;
  if (!i) return;
  for (const g of Object.values(i.grants)) {
    const l = g.method?.lessons.at(-1);
    if (l?.status === 'working') {
      const v = w.life!.ventures!.projects[l.ventureId] ?? w.life!.ventures!.retired.find(v => v.id === l.ventureId);
      if (!v) throw Error('lesson source missing');
      let changed = false;
      if (l.startedMinute === null && v.steps[0]!.startedMinute !== null) {
        l.startedMinute = v.steps[0]!.startedMinute;
        changed = true;
      }
      if (v.outcome) {
        l.endedMinute = minute;
        l.status = v.status === 'completed' ? 'completed' : 'interrupted';
        changed = true;
        for (const id of [g.teacherId, g.learnerId]) {
          if (w.life!.residents[id]!.task?.ventureId === l.ventureId) w.life!.residents[id]!.task = null;
          handled.add(id);
        }
      }
      if (changed) g.revision++;
    }
    if (g.status === 'accepted' && activeMethodGrant(w, g, minute)) {
      const t = Object.values(i.trials).find(t => t.endedMinute === minute && t.actorId === g.learnerId && t.mode === 'assisted' && t.purpose === 'trial-only' && t.useful && t.outcome === 'passed' && t.designId && i.designs[t.designId]?.methodApplication && 'kind' in i.designs[t.designId]!.methodApplication! && (i.designs[t.designId]!.methodApplication as {
        grantId?: string;
      }).grantId === g.id);
      if (t) {
        g.status = 'demonstrated';
        g.reproductionArtifactId = t.artifactId;
        g.reproductionTrialId = t.id;
        g.revision++;
      }
    }
  }
}
export type LearnerIntake = Omit<LearnerExecution, 'id' | 'admittedMinute'>;
export function applyLearnerMinute(before: WorldState, after: WorldState, minute: number, intakes: readonly LearnerIntake[] = []): WorldEvent[] {
  const i = after.life?.invention;
  if (!i) {
    if (intakes.length) throw Error('learner invention absent');
    return [];
  }
  const previous = structuredClone(i);
  for (const raw of intakes) {
    const g = i.grants[raw.grantId];
    if (!g?.method || g.method.executions.length >= 8 || !learnerExecutionCurrent(before, g, {
      ...raw,
      id: 'pending',
      admittedMinute: minute
    }) || !learnerExecutionCurrent(after, g, {
      ...raw,
      id: 'pending',
      admittedMinute: minute
    }, minute)) continue;
    if (g.method.executions.some(e => e.choice.requestId === raw.choice.requestId)) continue;
    const id = alloc(after, 'execution'),
      e = LearnerExecutionSchema.parse({
        ...structuredClone(raw),
        id,
        admittedMinute: minute
      });
    g.method.executions.push(e);
    g.revision++;
  }
  return inventionDeltas(previous, i, minute);
}
/** Pure historical validation. Execution authority and hashes are additionally checked by the configured store closure. */
export function validateLearnerGrades(e: LearnerExecution) {
  if (e.learnerId !== e.context.actor || e.context.generation !== e.generation || e.observedMinute !== e.context.minute || e.choice.observedMinute >= e.observedMinute || e.choice.generation !== e.generation || e.choice.siteRevision !== e.siteRevision || !same(e.input, {
    envelope: e.context.envelope,
    skill: e.context.skill,
    condition: e.context.condition,
    materials: e.context.materials
  }) || e.test.executions.length !== 1 || !same(e.test.executions[0]!.input, e.input)) throw Error('learner execution context');
  validateMethodGrades({
    origin: {
      context: e.context,
      contextHash: e.contextHash,
      sourceSequence: e.sourceSequence,
      sourceLedgerHash: e.sourceLedgerHash,
      agendaId: e.agendaId,
      agendaRevision: e.agendaRevision,
      task: e.task
    },
    artifactHash: e.artifactHash,
    tests: [e.test],
    selectedReceiptHash: e.test.hash
  });
}
export function validateGrantEvent(w: WorldState, event: Extract<WorldEvent, {
  type: 'invention-grant-changed';
}>) {
  const g = event.after,
    m = g.method,
    old = event.before;
  if (!m) throw Error('unobserved legacy grant change');
  if (!old) {
    if (g.status !== 'offered' || g.revision !== 0 || m.offer.observedMinute + 1 !== event.minute || g.expiresMinute !== event.minute + teachingWindow(m.cadence)! || m.acceptance || m.lessons.length || m.executions.length || m.invitationId !== `${g.id}:lesson:1`) throw Error('grant offer origin');
  } else {
    if (!old.method || g.revision <= old.revision) throw Error('grant revision');
    const immutable = (x: InventionGrant) => {
      const {
        revision,
        status,
        reproductionArtifactId,
        reproductionTrialId,
        method,
        ...rest
      } = x;
      const {
        invitationId,
        acceptance,
        lessons,
        executions,
        ...pinned
      } = method!;
      return {
        rest,
        pinned
      };
    };
    if (!same(immutable(old), immutable(g)) || ['revoked', 'declined'].includes(old.status) && g.status !== old.status) throw Error('immutable grant source');
    if (m.lessons.length < old.method.lessons.length || m.executions.length < old.method.executions.length || old.method.executions.some((e, n) => !same(e, m.executions[n]))) throw Error('immutable learner evidence');
    if (old.reproductionArtifactId !== null && g.reproductionArtifactId !== old.reproductionArtifactId || old.reproductionTrialId !== null && g.reproductionTrialId !== old.reproductionTrialId) throw Error('immutable reproduction attribution');
  }
  for (const l of m.lessons) {
    const v = w.life!.ventures!.projects[l.ventureId] ?? w.life!.ventures!.retired.find(v => v.id === l.ventureId);
    if (!v && old?.method?.lessons.some(previous => same(previous, l)) && l.status !== 'working') continue;
    if (!v || v.id !== l.invitationId || v.proposerId !== g.teacherId || v.participants.length !== 1 || v.participants[0]?.residentId !== g.learnerId || v.participants[0].consent !== 'accepted' || v.steps.length !== 1 || v.steps[0]!.id !== 'lesson' || v.steps[0]!.durationMinutes !== LESSON_MINUTES || v.steps[0]!.requires.length || v.steps[0]!.consumed.length || l.acceptance.observedMinute >= l.start.observedMinute + 1 || l.start.observedMinute + 1 !== v.proposedMinute || l.startedMinute !== v.steps[0]!.startedMinute) throw Error('lesson actual consent or source');
    if (l.status === 'completed' ? v.status !== 'completed' || l.startedMinute === null || l.endedMinute !== v.outcome?.minute || l.endedMinute! - l.startedMinute !== LESSON_MINUTES : l.status === 'interrupted' ? !v.outcome || v.status === 'completed' || l.endedMinute !== v.outcome.minute : l.endedMinute !== null || v.outcome !== null) throw Error('lesson paid terminal');
  }
  for (const e of m.executions) {
    if (e.grantId !== g.id || e.methodVersionId !== m.methodVersionId || e.sourceHash !== m.sourceHash || e.artifactHash !== m.artifactHash || !same(e.authority, m.authority) || e.learnerId !== g.learnerId || e.admittedMinute > event.minute || e.observedMinute >= e.admittedMinute || e.observedMinute >= g.expiresMinute) throw Error('learner grant association');
    validateLearnerGrades(e);
  }
  if (g.reproductionTrialId !== null) {
    const t = w.life!.invention!.trials[g.reproductionTrialId],
      a = g.reproductionArtifactId && w.life!.invention!.artifacts[g.reproductionArtifactId],
      d = a && w.life!.invention!.designs[a.designId];
    if (!t || !a || !d || t.actorId !== g.learnerId || a.ownerId !== g.learnerId || t.artifactId !== a.id || !t.useful || t.outcome !== 'passed' || t.endedMinute >= g.expiresMinute || !d.methodApplication || !('kind' in d.methodApplication) || d.methodApplication.grantId !== g.id) throw Error('grant earned demonstration');
  }
}
