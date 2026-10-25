import {
  checkLedgerInvariants, createReservationLedger, isMinute, isPositiveSafeInteger, isValidId, reduceReservation,
  type Rejection, type ReservationEffect, type ReservationLedger, type Result,
} from "./discovery-core.js";

/**
 * Pure project/invention lifecycle kernel (Slice 2).
 *
 * Projects move proposed → planning → resourcing → active → completed, or end
 * in failed/abandoned. Every resource claim goes through the reservation
 * reducer from discovery-core (atomic grants, expiry, consume-once, idempotent
 * release, sequence replay guard). Consent is explicit per invited resident:
 * accepted or declined by their own action, or expired at the consent deadline
 * (consent-timeout). Absence is never acceptance. Partial failure keeps what a
 * finished step consumed and releases unused grants exactly once. Records are
 * bounded; the reader fails closed on unknown versions. No randomness, no time
 * source, no narrative: outcomes are status transitions with reasons.
 *
 * This kernel does not touch WorldState, the canonical schema, the store or the
 * live runtime. Persistence exists only as an isolated synthetic fixture.
 */
export const PROJECT_LEDGER_FORMAT_VERSION = 1 as const;
export const PROJECT_LIMITS = Object.freeze({ maxActive: 16, maxRetired: 32, maxSteps: 8, maxParticipants: 8, maxRequirementsPerStep: 4, maxHistory: 12 });

export type ProjectStatus = "proposed" | "planning" | "resourcing" | "active" | "completed" | "failed" | "abandoned";
export type ConsentState = "invited" | "accepted" | "declined" | "expired";
export type StepStatus = "pending" | "running" | "done" | "aborted";
export type OutcomeReason = "all-steps-complete" | "consent-declined" | "consent-timeout" | "resources-unavailable" | "unknown-resource" | "deadline-passed" | "participant-withdrew" | "abandoned-by-proposer";
export const TERMINAL_STATUSES: readonly ProjectStatus[] = ["completed", "failed", "abandoned"];

export interface ProjectRequirement { resourceId: string; quantity: number }
export interface ProjectStepPlan { id: string; label: string; durationMinutes: number; requires: ProjectRequirement[] }
export interface ProjectStep extends ProjectStepPlan { status: StepStatus; startedMinute: number | null; completedMinute: number | null; consumed: ProjectRequirement[] }
export interface Participant { residentId: string; consent: ConsentState; invitedMinute: number; respondedMinute: number | null }
export interface ProjectRecord {
  id: string; label: string; placeId: string; proposerId: string;
  status: ProjectStatus; sequence: number; proposedMinute: number; consentDeadlineMinute: number; deadlineMinute: number;
  steps: ProjectStep[]; participants: Participant[];
  outcome: { minute: number; result: "completed" | "failed" | "abandoned"; reason: OutcomeReason } | null;
  history: { minute: number; status: ProjectStatus }[];
}
export interface ProjectLedger {
  formatVersion: typeof PROJECT_LEDGER_FORMAT_VERSION;
  nextSequence: number;
  nextRequestSequence: number;
  resources: Record<string, ReservationLedger>;
  projects: Record<string, ProjectRecord>;
  retired: ProjectRecord[];
}
export interface ProjectProposal { id: string; label: string; placeId: string; proposerId: string; invitees: readonly string[]; steps: readonly ProjectStepPlan[]; consentDeadlineMinute: number; deadlineMinute: number }
export type ProjectEffect =
  | { type: "status"; projectId: string; minute: number; from: ProjectStatus; to: ProjectStatus; reason?: OutcomeReason }
  | { type: "step"; projectId: string; minute: number; stepId: string; status: StepStatus }
  | { type: "consent"; projectId: string; minute: number; residentId: string; consent: ConsentState }
  | { type: "reservation"; projectId: string; resourceId: string; effect: ReservationEffect };
export interface ProjectAdvance { ledger: ProjectLedger; effects: ProjectEffect[] }

const reject = (code: Rejection["code"], reason: string): Rejection => ({ ok: false, code, reason });
const accept = <T>(value: T): Result<T> => ({ ok: true, value });
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sortedProjects = (ledger: ProjectLedger): ProjectRecord[] => Object.values(ledger.projects).sort((a, b) => a.sequence - b.sequence);
const requestIdFor = (projectId: string, stepId: string, resourceId: string) => `${projectId}:${stepId}:${resourceId}`;
const clone = <T>(value: T): T => structuredClone(value);

export function createProjectLedger(): ProjectLedger {
  return { formatVersion: PROJECT_LEDGER_FORMAT_VERSION, nextSequence: 1, nextRequestSequence: 1, resources: {}, projects: {}, retired: [] };
}

function validateRecord(value: unknown): value is ProjectRecord {
  if (!isPlainObject(value)) return false;
  const statuses: ProjectStatus[] = ["proposed", "planning", "resourcing", "active", "completed", "failed", "abandoned"];
  if (!isValidId(value.id) || !isValidId(value.placeId) || !isValidId(value.proposerId) || typeof value.label !== "string" || !value.label.length || value.label.length > 160) return false;
  if (!statuses.includes(value.status as ProjectStatus) || !isPositiveSafeInteger(value.sequence) || !isMinute(value.proposedMinute) || !isMinute(value.consentDeadlineMinute) || !isMinute(value.deadlineMinute)) return false;
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > PROJECT_LIMITS.maxSteps || !Array.isArray(value.participants) || value.participants.length > PROJECT_LIMITS.maxParticipants || !Array.isArray(value.history) || value.history.length > PROJECT_LIMITS.maxHistory) return false;
  for (const step of value.steps as unknown[]) {
    if (!isPlainObject(step) || !isValidId(step.id) || typeof step.label !== "string" || !isPositiveSafeInteger(step.durationMinutes) || !Array.isArray(step.requires) || !Array.isArray(step.consumed)) return false;
    if (!["pending", "running", "done", "aborted"].includes(String(step.status))) return false;
    for (const requirement of [...(step.requires as unknown[]), ...(step.consumed as unknown[])]) if (!isPlainObject(requirement) || !isValidId(requirement.resourceId) || !isPositiveSafeInteger(requirement.quantity)) return false;
  }
  for (const participant of value.participants as unknown[]) {
    if (!isPlainObject(participant) || !isValidId(participant.residentId) || !["invited", "accepted", "declined", "expired"].includes(String(participant.consent)) || !isMinute(participant.invitedMinute)) return false;
  }
  if (value.outcome !== null && !isPlainObject(value.outcome)) return false;
  return true;
}

/** Fail-closed reader: unknown versions, malformed records or invalid reservation ledgers are rejected. */
export function openProjectLedger(raw: unknown): Result<ProjectLedger> {
  if (!isPlainObject(raw)) return reject("CORRUPT_STATE", "project ledger must be an object");
  if (raw.formatVersion !== PROJECT_LEDGER_FORMAT_VERSION) return reject("CORRUPT_STATE", `unsupported project ledger format ${String(raw.formatVersion)}; this reader supports ${PROJECT_LEDGER_FORMAT_VERSION}`);
  if (!isPositiveSafeInteger(raw.nextSequence) || !isPositiveSafeInteger(raw.nextRequestSequence)) return reject("CORRUPT_STATE", "project ledger counters are invalid");
  if (!isPlainObject(raw.resources) || !isPlainObject(raw.projects) || !Array.isArray(raw.retired)) return reject("CORRUPT_STATE", "project ledger sections are invalid");
  for (const [id, ledger] of Object.entries(raw.resources)) {
    const problems = checkLedgerInvariants(ledger);
    if (!isValidId(id) || problems.length) return reject("CORRUPT_STATE", `resource ledger "${id}": ${problems.join("; ") || "invalid id"}`);
    if ((ledger as ReservationLedger).resourceId !== id) return reject("CORRUPT_STATE", `resource ledger key "${id}" does not match its resourceId`);
  }
  if (Object.keys(raw.projects).length > PROJECT_LIMITS.maxActive || raw.retired.length > PROJECT_LIMITS.maxRetired) return reject("CORRUPT_STATE", "project ledger exceeds its bounds");
  for (const [id, record] of Object.entries(raw.projects)) {
    if (!validateRecord(record) || record.id !== id || TERMINAL_STATUSES.includes(record.status)) return reject("CORRUPT_STATE", `active project "${id}" is malformed or terminal`);
  }
  for (const record of raw.retired) if (!validateRecord(record) || !TERMINAL_STATUSES.includes(record.status)) return reject("CORRUPT_STATE", "retired project is malformed or not terminal");
  return accept(clone(raw as unknown as ProjectLedger)); // every field validated above
}

/** Declares the committed stock of one resource. Repeating the same declaration is idempotent; a different stock is rejected. */
export function declareResource(ledger: ProjectLedger, resourceId: string, stock: number, minute: number): Result<ProjectLedger> {
  const existing = Object.hasOwn(ledger.resources, resourceId) ? ledger.resources[resourceId] : undefined;
  if (existing) return existing.stock === stock ? accept(clone(ledger)) : reject("CONFLICTING_DUPLICATE", `resource "${resourceId}" already declared with stock ${existing.stock}`);
  const created = createReservationLedger(resourceId, stock, minute);
  if (!created.ok) return created;
  return accept({ ...clone(ledger), resources: { ...clone(ledger.resources), [resourceId]: created.value } });
}

export function proposeProject(ledger: ProjectLedger, proposal: ProjectProposal, minute: number): Result<ProjectLedger> {
  if (!isMinute(minute)) return reject("INVALID_MINUTE", "minute must be a non-negative safe integer");
  if (!isValidId(proposal.id) || !isValidId(proposal.placeId) || !isValidId(proposal.proposerId)) return reject("INVALID_ID", "project, place and proposer ids must be valid identifiers");
  if (typeof proposal.label !== "string" || !proposal.label.length || proposal.label.length > 160) return reject("INVALID_SHAPE", "label must be 1..160 characters");
  if (Object.hasOwn(ledger.projects, proposal.id) || ledger.retired.some((p) => p.id === proposal.id)) return reject("CONFLICTING_DUPLICATE", `project "${proposal.id}" already exists`);
  if (Object.keys(ledger.projects).length >= PROJECT_LIMITS.maxActive) return reject("ACTIVE_LIMIT", `at most ${PROJECT_LIMITS.maxActive} projects may be open`);
  if (!isMinute(proposal.consentDeadlineMinute) || !isMinute(proposal.deadlineMinute) || proposal.consentDeadlineMinute <= minute || proposal.deadlineMinute < proposal.consentDeadlineMinute) return reject("INVALID_MINUTE", "consent deadline must be after now and the project deadline must not precede it");
  if (proposal.steps.length < 1 || proposal.steps.length > PROJECT_LIMITS.maxSteps) return reject("INVALID_SHAPE", `a project needs 1..${PROJECT_LIMITS.maxSteps} steps`);
  const stepIds = new Set<string>();
  for (const step of proposal.steps) {
    if (!isValidId(step.id) || stepIds.has(step.id) || typeof step.label !== "string" || !step.label.length || step.label.length > 160 || !isPositiveSafeInteger(step.durationMinutes)) return reject("INVALID_SHAPE", `step "${String(step.id)}" is malformed or duplicated`);
    stepIds.add(step.id);
    if (step.requires.length > PROJECT_LIMITS.maxRequirementsPerStep) return reject("INVALID_SHAPE", `step "${step.id}" requires too many resources`);
    const seen = new Set<string>();
    for (const r of step.requires) {
      if (!isValidId(r.resourceId) || seen.has(r.resourceId) || !isPositiveSafeInteger(r.quantity)) return reject("INVALID_SHAPE", `step "${step.id}" has an invalid or duplicate requirement`);
      seen.add(r.resourceId);
    }
  }
  if (proposal.invitees.length > PROJECT_LIMITS.maxParticipants) return reject("INVALID_SHAPE", `at most ${PROJECT_LIMITS.maxParticipants} invitees`);
  const invitees = new Set<string>();
  for (const id of proposal.invitees) {
    if (!isValidId(id) || id === proposal.proposerId || invitees.has(id)) return reject("INVALID_ID", "invitees must be distinct valid residents other than the proposer");
    invitees.add(id);
  }
  const record: ProjectRecord = {
    id: proposal.id, label: proposal.label, placeId: proposal.placeId, proposerId: proposal.proposerId,
    status: "proposed", sequence: ledger.nextSequence, proposedMinute: minute, consentDeadlineMinute: proposal.consentDeadlineMinute, deadlineMinute: proposal.deadlineMinute,
    steps: proposal.steps.map((s) => ({ id: s.id, label: s.label, durationMinutes: s.durationMinutes, requires: s.requires.map((r) => ({ resourceId: r.resourceId, quantity: r.quantity })), status: "pending", startedMinute: null, completedMinute: null, consumed: [] })),
    participants: [...invitees].sort().map((residentId) => ({ residentId, consent: "invited", invitedMinute: minute, respondedMinute: null })),
    outcome: null, history: [{ minute, status: "proposed" }],
  };
  return accept({ ...clone(ledger), nextSequence: ledger.nextSequence + 1, projects: { ...clone(ledger.projects), [proposal.id]: record } });
}

interface Working { ledger: ProjectLedger; effects: ProjectEffect[] }

/** Applies one reservation command to a resource ledger inside the working copy; records non-idempotent effects. */
function reserve(work: Working, projectId: string, resourceId: string, command: Parameters<typeof reduceReservation>[1], minute: number): Result<void> {
  const resource = work.ledger.resources[resourceId];
  if (!resource) return reject("UNKNOWN_RESERVATION", `resource "${resourceId}" is not declared`);
  const reduced = reduceReservation(resource, command, minute);
  if (!reduced.ok) return reduced;
  work.ledger.resources[resourceId] = reduced.value.after;
  for (const effect of reduced.value.effects) work.effects.push({ type: "reservation", projectId, resourceId, effect });
  return accept(undefined);
}

/** Requests every reservation a step needs. Any denial releases the grants made in this call (never earlier consumption) and reports the failure. */
function requestStep(work: Working, project: ProjectRecord, step: ProjectStep, minute: number): Result<void> {
  const granted: string[] = [];
  for (const requirement of step.requires) {
    const requestId = requestIdFor(project.id, step.id, requirement.resourceId);
    const sequence = work.ledger.nextRequestSequence;
    const result = reserve(work, project.id, requirement.resourceId, { type: "grant", request: { requestId, planId: project.id, resourceId: requirement.resourceId, residentId: project.proposerId, quantity: requirement.quantity, grantedMinute: minute, expiryMinute: project.deadlineMinute + 1, sequence } }, minute);
    if (!result.ok) {
      for (const resourceId of granted) reserve(work, project.id, resourceId, { type: "release", requestId: requestIdFor(project.id, step.id, resourceId) }, minute);
      return result;
    }
    work.ledger.nextRequestSequence += 1;
    granted.push(requirement.resourceId);
  }
  return accept(undefined);
}

/** Releases every unconsumed grant a project holds; consumed reservations are untouched. Idempotent. */
function releaseUnused(work: Working, project: ProjectRecord, minute: number): void {
  for (const step of project.steps) {
    if (step.status === "done") continue;
    for (const requirement of step.requires) {
      const requestId = requestIdFor(project.id, step.id, requirement.resourceId);
      const resource = work.ledger.resources[requirement.resourceId];
      if (!resource || !resource.active.some((r) => r.requestId === requestId)) continue;
      reserve(work, project.id, requirement.resourceId, { type: "release", requestId }, minute);
    }
  }
}

function transition(work: Working, project: ProjectRecord, to: ProjectStatus, minute: number, reason?: OutcomeReason): void {
  const from = project.status;
  project.status = to;
  project.history = [...project.history, { minute, status: to }].slice(-PROJECT_LIMITS.maxHistory);
  work.effects.push(reason ? { type: "status", projectId: project.id, minute, from, to, reason } : { type: "status", projectId: project.id, minute, from, to });
}

function conclude(work: Working, project: ProjectRecord, result: "completed" | "failed" | "abandoned", reason: OutcomeReason, minute: number): void {
  for (const step of project.steps) {
    if (step.status === "running" || step.status === "pending") {
      if (step.status === "running") { step.status = "aborted"; work.effects.push({ type: "step", projectId: project.id, minute, stepId: step.id, status: "aborted" }); }
    }
  }
  releaseUnused(work, project, minute);
  project.outcome = { minute, result, reason };
  transition(work, project, result, minute, reason);
  delete work.ledger.projects[project.id];
  work.ledger.retired = [...work.ledger.retired, project].slice(-PROJECT_LIMITS.maxRetired);
}

function startStep(work: Working, project: ProjectRecord, step: ProjectStep, minute: number): void {
  step.status = "running"; step.startedMinute = minute;
  work.effects.push({ type: "step", projectId: project.id, minute, stepId: step.id, status: "running" });
}

/** An invited resident answers from their own context. Declining fails the project now; absence is handled only by the consent deadline. */
export function respondToInvitation(ledger: ProjectLedger, projectId: string, residentId: string, response: "accepted" | "declined", minute: number): Result<ProjectAdvance> {
  if (!isMinute(minute)) return reject("INVALID_MINUTE", "minute must be a non-negative safe integer");
  const source = Object.hasOwn(ledger.projects, projectId) ? ledger.projects[projectId] : undefined;
  if (!source) return reject("UNKNOWN_RESERVATION", `project "${projectId}" is not open`);
  const work: Working = { ledger: clone(ledger), effects: [] };
  const project = work.ledger.projects[projectId]!;
  const participant = project.participants.find((p) => p.residentId === residentId);
  if (!participant) return reject("INVALID_ID", `resident "${residentId}" was not invited to "${projectId}"`);
  if (participant.consent !== "invited") return reject("NOT_ACTIVE", `resident "${residentId}" already answered (${participant.consent})`);
  if (minute >= project.consentDeadlineMinute && response === "accepted") return reject("RESERVATION_EXPIRED", "the consent deadline has passed; the project will time out");
  participant.consent = response; participant.respondedMinute = minute;
  work.effects.push({ type: "consent", projectId, minute, residentId, consent: response });
  if (response === "declined") conclude(work, project, "failed", "consent-declined", minute);
  return accept({ ledger: work.ledger, effects: work.effects });
}

/** A participant who accepted leaves an active project: the project fails now, finished steps stay consumed, unused grants are released once. */
export function withdrawParticipant(ledger: ProjectLedger, projectId: string, residentId: string, minute: number): Result<ProjectAdvance> {
  if (!isMinute(minute)) return reject("INVALID_MINUTE", "minute must be a non-negative safe integer");
  if (!Object.hasOwn(ledger.projects, projectId)) return reject("UNKNOWN_RESERVATION", `project "${projectId}" is not open`);
  const work: Working = { ledger: clone(ledger), effects: [] };
  const project = work.ledger.projects[projectId]!;
  const participant = project.participants.find((p) => p.residentId === residentId);
  if (!participant || participant.consent !== "accepted") return reject("NOT_ACTIVE", `resident "${residentId}" is not an accepted participant`);
  conclude(work, project, "failed", "participant-withdrew", minute);
  return accept({ ledger: work.ledger, effects: work.effects });
}

export function abandonProject(ledger: ProjectLedger, projectId: string, minute: number): Result<ProjectAdvance> {
  if (!isMinute(minute)) return reject("INVALID_MINUTE", "minute must be a non-negative safe integer");
  if (!Object.hasOwn(ledger.projects, projectId)) return reject("UNKNOWN_RESERVATION", `project "${projectId}" is not open`);
  const work: Working = { ledger: clone(ledger), effects: [] };
  conclude(work, work.ledger.projects[projectId]!, "abandoned", "abandoned-by-proposer", minute);
  return accept({ ledger: work.ledger, effects: work.effects });
}

/**
 * Advances every open project to `minute` in proposal order. Reservation
 * expiries are swept first; then, per project: deadline → planning → resourcing
 * (reserve step 1, wait for consent) → active (run steps, consume on completion,
 * reserve the next step) → completed. Each failure names its reason.
 */
export function advanceProjects(ledger: ProjectLedger, minute: number, ready: (projectId: string) => boolean = () => true): Result<ProjectAdvance> {
  if (!isMinute(minute)) return reject("INVALID_MINUTE", "minute must be a non-negative safe integer");
  const work: Working = { ledger: clone(ledger), effects: [] };
  for (const resourceId of Object.keys(work.ledger.resources).sort()) {
    const swept = reserve(work, "", resourceId, { type: "advance" }, minute);
    if (!swept.ok) return swept;
  }
  for (const project of sortedProjects(work.ledger)) {
    if (minute >= project.deadlineMinute && project.status !== "completed") { conclude(work, project, "failed", "deadline-passed", minute); continue; }
    if (project.status === "proposed") {
      const unknown = project.steps.flatMap((s) => s.requires).find((r) => !Object.hasOwn(work.ledger.resources, r.resourceId));
      if (unknown) { conclude(work, project, "failed", "unknown-resource", minute); continue; }
      transition(work, project, "planning", minute);
    }
    if (project.status === "planning") {
      const requested = requestStep(work, project, project.steps[0]!, minute);
      if (!requested.ok) { conclude(work, project, "failed", "resources-unavailable", minute); continue; }
      transition(work, project, "resourcing", minute);
    }
    if (project.status === "resourcing") {
      let timedOut = false;
      for (const participant of project.participants) {
        if (participant.consent === "invited" && minute >= project.consentDeadlineMinute) { participant.consent = "expired"; participant.respondedMinute = minute; work.effects.push({ type: "consent", projectId: project.id, minute, residentId: participant.residentId, consent: "expired" }); timedOut = true; }
      }
      if (timedOut) { conclude(work, project, "failed", "consent-timeout", minute); continue; }
      if (project.participants.every((p) => p.consent === "accepted") && ready(project.id)) { transition(work, project, "active", minute); startStep(work, project, project.steps[0]!, minute); }
    }
    if (project.status === "active") {
      const running = project.steps.find((s) => s.status === "running");
      if (!running || running.startedMinute === null || minute < running.startedMinute + running.durationMinutes) continue;
      for (const requirement of running.requires) {
        const consumed = reserve(work, project.id, requirement.resourceId, { type: "consume", requestId: requestIdFor(project.id, running.id, requirement.resourceId) }, minute);
        if (!consumed.ok) { conclude(work, project, "failed", "resources-unavailable", minute); break; }
      }
      if (project.status !== "active") continue;
      running.status = "done"; running.completedMinute = minute; running.consumed = running.requires.map((r) => ({ ...r }));
      work.effects.push({ type: "step", projectId: project.id, minute, stepId: running.id, status: "done" });
      const next = project.steps.find((s) => s.status === "pending");
      if (!next) { conclude(work, project, "completed", "all-steps-complete", minute); continue; }
      const requested = requestStep(work, project, next, minute);
      if (!requested.ok) { conclude(work, project, "failed", "resources-unavailable", minute); continue; }
      startStep(work, project, next, minute);
    }
  }
  return accept({ ledger: work.ledger, effects: work.effects });
}

/** Read-only view: open projects in proposal order followed by retired ones, oldest first. */
export function listProjects(ledger: ProjectLedger): ProjectRecord[] {
  return [...sortedProjects(ledger), ...ledger.retired].map((p) => clone(p));
}
