import type { WorldEvent, WorldState } from "@meridian/world-schema";
import {
  addObservation, createObservationStore, evaluateExperiment, isMinute, isNonNegativeSafeInteger, isValidId,
  pinEvidence, pinnedObservationIds, releaseEvidence, validateObservationStore,
  type EvidenceEvaluation, type Observation, type ObservationStore, type Rejection, type Result, type Verdict,
} from "./discovery-core.js";

/**
 * Isolated discovery adapter (fixture integration, not yet durable).
 *
 * Derives engine-owned observations from COMMITTED life transitions and keeps
 * bounded per-resident discovery state in a versioned reader structure that
 * lives beside — not inside — WorldState. Nothing here is persisted by the
 * store, emitted as a WorldEvent, or read by the inspector in this slice; see
 * docs/research/2026-09-06-discovery-integration-results.md for the exact
 * compatibility gap that keeps it isolated.
 *
 * Grounding rules (all from committed state/events, never from model text):
 *  - arriving at a project's place yields a reading of that project's progress;
 *  - completing your own tending yields a reading of the new progress and an
 *    interference record in the same minute (you changed it);
 *  - being present when someone else's tending lands yields a reading and an
 *    interference record (you saw it change, not who thought what).
 * Readings are the committed values after the minute's events.
 */
export const DISCOVERY_FORMAT_VERSION = 1 as const;
export const DISCOVERY_LIMITS = Object.freeze({ maxOutcomes: 16, maxActiveHypotheses: 8, initialConfidence: 60, projectCapacity: 100 });

export type HypothesisStatus = "active" | "supported" | "refuted" | "inconclusive" | "abandoned";
export interface DiscoveryHypothesis {
  experimentId: string; projectId: string; placeId: string; expectedRatePerMinute: number;
  confidence: number; status: HypothesisStatus; proposedMinute: number; deadlineMinute: number; concludedMinute: number | null;
}
export interface DiscoveryOutcome {
  experimentId: string; minute: number; verdict: Verdict | "abandoned"; code: string; reason: string;
  confidenceBefore: number; confidenceAfter: number; expectedDelta: number | null; observedDelta: number | null;
  interferenceIds: string[]; evidenceIds: string[];
}
export interface ResidentDiscovery { store: ObservationStore; hypotheses: DiscoveryHypothesis[]; outcomes: DiscoveryOutcome[] }
export interface DiscoveryLedger { formatVersion: typeof DISCOVERY_FORMAT_VERSION; residents: Record<string, ResidentDiscovery> }

const reject = (code: Rejection["code"], reason: string): Rejection => ({ ok: false, code, reason });
const accept = <T>(value: T): Result<T> => ({ ok: true, value });
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sortedKeys = (record: Record<string, unknown>) => Object.keys(record).sort();

export function createDiscoveryLedger(): DiscoveryLedger {
  return { formatVersion: DISCOVERY_FORMAT_VERSION, residents: {} };
}

/**
 * Reader with an explicit format guard. `undefined`/`null` means a save that
 * predates discovery and opens as an empty ledger; a higher format version is
 * refused rather than partially read.
 */
export function openDiscoveryLedger(raw: unknown): Result<DiscoveryLedger> {
  if (raw === undefined || raw === null) return accept(createDiscoveryLedger());
  if (!isPlainObject(raw)) return reject("CORRUPT_STATE", "discovery ledger must be an object");
  if (raw.formatVersion !== DISCOVERY_FORMAT_VERSION) {
    return reject("CORRUPT_STATE", `unsupported discovery format ${String(raw.formatVersion)}; this reader supports ${DISCOVERY_FORMAT_VERSION}`);
  }
  if (!isPlainObject(raw.residents)) return reject("CORRUPT_STATE", "discovery ledger residents must be an object");
  const residents: Record<string, ResidentDiscovery> = {};
  for (const id of sortedKeys(raw.residents)) {
    if (!isValidId(id)) return reject("INVALID_ID", `discovery resident key "${id}" is not a valid identifier`);
    const entry = raw.residents[id];
    if (!isPlainObject(entry) || !Array.isArray(entry.hypotheses) || !Array.isArray(entry.outcomes)) return reject("CORRUPT_STATE", `discovery entry for "${id}" is malformed`);
    const store = validateObservationStore(entry.store);
    if (!store.ok) return store;
    if (store.value.residentId !== id) return reject("RESIDENT_MISMATCH", `discovery store for "${id}" belongs to "${store.value.residentId}"`);
    for (const h of entry.hypotheses as unknown[]) {
      if (!isPlainObject(h) || !isValidId(h.experimentId) || !isValidId(h.projectId) || !isValidId(h.placeId) || !isNonNegativeSafeInteger(h.expectedRatePerMinute)
        || typeof h.confidence !== "number" || !Number.isInteger(h.confidence) || h.confidence < 0 || h.confidence > 100
        || !["active", "supported", "refuted", "inconclusive", "abandoned"].includes(String(h.status)) || !isMinute(h.proposedMinute) || !isMinute(h.deadlineMinute)
        || !(h.concludedMinute === null || isMinute(h.concludedMinute))) return reject("CORRUPT_STATE", `discovery hypothesis for "${id}" is malformed`);
    }
    if ((entry.outcomes as unknown[]).length > DISCOVERY_LIMITS.maxOutcomes) return reject("CORRUPT_STATE", `discovery outcomes for "${id}" exceed ${DISCOVERY_LIMITS.maxOutcomes}`);
    residents[id] = structuredClone({ store: store.value, hypotheses: entry.hypotheses as DiscoveryHypothesis[], outcomes: entry.outcomes as DiscoveryOutcome[] });
  }
  return accept({ formatVersion: DISCOVERY_FORMAT_VERSION, residents });
}

function entryFor(ledger: DiscoveryLedger, residentId: string): Result<ResidentDiscovery> {
  const existing = Object.hasOwn(ledger.residents, residentId) ? ledger.residents[residentId] : undefined;
  if (existing) return accept(structuredClone(existing));
  const store = createObservationStore(residentId);
  if (!store.ok) return store;
  return accept({ store: store.value, hypotheses: [], outcomes: [] });
}

export interface ObservedMinute {
  ledger: DiscoveryLedger;
  observations: { residentId: string; observation: Observation }[];
  rejected: { residentId: string; code: string; reason: string }[];
}

/**
 * Ingest exactly one committed minute (before → after with that minute's
 * events). Multi-minute jumps must be ingested step by step so presence and
 * readings stay bound to their own minute.
 */
export function observeCommittedMinute(ledger: DiscoveryLedger, before: WorldState, after: WorldState, events: readonly WorldEvent[]): Result<ObservedMinute> {
  const minute = after.canonicalMinute;
  if (minute !== before.canonicalMinute + 1) return reject("INVALID_MINUTE", `observe one committed minute at a time (${before.canonicalMinute} → ${minute})`);
  if (events.some((event) => event.minute !== minute)) return reject("INVALID_MINUTE", "events must belong to the committed minute");
  if (!after.life) return accept({ ledger: structuredClone(ledger), observations: [], rejected: [] });
  const life = after.life;
  const changed = new Map<string, number>();
  for (const event of events) if (event.type === "life-project-changed") changed.set(event.projectId, event.after.progress);
  const actors = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "resident-life-changed") continue;
    const memory = event.after.memories.at(-1);
    if (memory && memory.minute === minute && memory.outcome === "garden-tended" && memory.projectId) {
      if (!actors.has(memory.projectId)) actors.set(memory.projectId, new Set());
      actors.get(memory.projectId)!.add(event.residentId);
    }
  }
  const next: DiscoveryLedger = { formatVersion: DISCOVERY_FORMAT_VERSION, residents: { ...ledger.residents } };
  const observations: ObservedMinute["observations"] = [];
  const rejected: ObservedMinute["rejected"] = [];
  const projects = sortedKeys(life.projects).map((id) => life.projects[id]!);
  for (const residentId of sortedKeys(after.residents)) {
    const here = after.residents[residentId]!.placeId;
    const wasHere = before.residents[residentId]?.placeId === here;
    const pending: Observation[] = [];
    for (const project of projects) {
      if (project.placeId !== here) continue;
      const progress = changed.get(project.id) ?? project.progress;
      const reading: Observation = { kind: "measurement", id: `m:${residentId}:${project.id}:${minute}`, residentId, placeId: project.placeId, subjectId: project.id, minute, value: progress };
      if (!wasHere) pending.push(reading);
      if (changed.has(project.id)) {
        if (wasHere) pending.push(reading);
        pending.push({ kind: "interference", id: `i:${residentId}:${project.id}:${minute}`, residentId, placeId: project.placeId, subjectId: project.id, minute });
      }
    }
    if (!pending.length) continue;
    const entry = entryFor(next, residentId);
    if (!entry.ok) { rejected.push({ residentId, code: entry.code, reason: entry.reason }); continue; }
    let store = entry.value.store;
    for (const observation of pending) {
      const added = addObservation(store, observation, minute);
      if (!added.ok) { rejected.push({ residentId, code: added.code, reason: added.reason }); continue; }
      store = added.value.store;
      if (!added.value.idempotent) observations.push({ residentId, observation });
    }
    next.residents[residentId] = { ...entry.value, store };
  }
  return accept({ ledger: next, observations, rejected });
}

export interface HypothesisProposal { experimentId: string; projectId: string; expectedRatePerMinute: number; deadlineMinute: number; evidenceIds: readonly string[] }

/** Admits a hypothesis only after its cited evidence is pinned; identity and minute come from committed state. */
export function proposeHypothesis(ledger: DiscoveryLedger, state: WorldState, residentId: string, proposal: HypothesisProposal): Result<DiscoveryLedger> {
  if (!isValidId(residentId) || !Object.hasOwn(state.residents, residentId)) return reject("INVALID_ID", "unknown resident");
  if (!isValidId(proposal.experimentId)) return reject("INVALID_ID", "experimentId is not a valid identifier");
  const project = state.life && Object.hasOwn(state.life.projects, proposal.projectId) ? state.life.projects[proposal.projectId] : undefined;
  if (!project) return reject("INVALID_HYPOTHESIS", `unknown project "${proposal.projectId}"`);
  if (!isNonNegativeSafeInteger(proposal.expectedRatePerMinute)) return reject("INVALID_HYPOTHESIS", "expectedRatePerMinute must be a non-negative safe integer");
  if (!isMinute(proposal.deadlineMinute) || proposal.deadlineMinute <= state.canonicalMinute) return reject("INVALID_MINUTE", "deadline must be after the current committed minute");
  const entry = entryFor(ledger, residentId);
  if (!entry.ok) return entry;
  if (entry.value.hypotheses.some((h) => h.experimentId === proposal.experimentId)) return reject("CONFLICTING_DUPLICATE", `experiment "${proposal.experimentId}" already exists`);
  if (entry.value.hypotheses.filter((h) => h.status === "active").length >= DISCOVERY_LIMITS.maxActiveHypotheses) return reject("PIN_OWNER_LIMIT", `at most ${DISCOVERY_LIMITS.maxActiveHypotheses} active hypotheses`);
  const pinned = pinEvidence(entry.value.store, proposal.experimentId, [...proposal.evidenceIds]);
  if (!pinned.ok) return pinned;
  const hypothesis: DiscoveryHypothesis = {
    experimentId: proposal.experimentId, projectId: project.id, placeId: project.placeId, expectedRatePerMinute: proposal.expectedRatePerMinute,
    confidence: DISCOVERY_LIMITS.initialConfidence, status: "active", proposedMinute: state.canonicalMinute, deadlineMinute: proposal.deadlineMinute, concludedMinute: null,
  };
  return accept({ formatVersion: DISCOVERY_FORMAT_VERSION, residents: { ...ledger.residents, [residentId]: { ...entry.value, store: pinned.value.store, hypotheses: [...entry.value.hypotheses, hypothesis] } } });
}

export interface HypothesisEvaluation { residentId: string; experimentId: string; evaluation: EvidenceEvaluation; concluded: boolean }

/**
 * Evaluates every active hypothesis against the resident's own retained
 * readings of the subject from its pinned baseline onward. A verdict
 * concludes the hypothesis and releases its pins; insufficient evidence keeps
 * it active until its deadline, when it is abandoned honestly.
 */
export function evaluateHypotheses(ledger: DiscoveryLedger, state: WorldState): Result<{ ledger: DiscoveryLedger; evaluations: HypothesisEvaluation[] }> {
  const minute = state.canonicalMinute;
  const next: DiscoveryLedger = { formatVersion: DISCOVERY_FORMAT_VERSION, residents: { ...ledger.residents } };
  const evaluations: HypothesisEvaluation[] = [];
  for (const residentId of sortedKeys(ledger.residents)) {
    const entry = structuredClone(ledger.residents[residentId]!);
    let changed = false;
    for (const hypothesis of entry.hypotheses) {
      if (hypothesis.status !== "active") continue;
      // Evidence is the pinned baseline citation(s) plus the resident's own later readings of the
      // same subject. Readings older than the baseline belong to earlier hypotheses, not this one.
      const pinned = new Set(entry.store.pins.find((grant) => grant.ownerPlanId === hypothesis.experimentId)?.observationIds ?? []);
      const baseline = Math.min(...entry.store.observations.filter((o) => pinned.has(o.id)).map((o) => o.minute));
      for (const observation of entry.store.observations) {
        if (observation.placeId === hypothesis.placeId && observation.subjectId === hypothesis.projectId && observation.minute >= baseline) pinned.add(observation.id);
      }
      const evidenceIds = [...pinned].sort();
      const evaluation = evaluateExperiment(
        { experimentId: hypothesis.experimentId, residentId, placeId: hypothesis.placeId, subjectId: hypothesis.projectId, expectedRatePerMinute: hypothesis.expectedRatePerMinute, capacity: DISCOVERY_LIMITS.projectCapacity },
        entry.store, evidenceIds, hypothesis.confidence,
      );
      const expired = minute >= hypothesis.deadlineMinute;
      const concluded = evaluation.verdict !== "rejected" || expired;
      evaluations.push({ residentId, experimentId: hypothesis.experimentId, evaluation, concluded });
      if (!concluded) continue;
      const verdict: DiscoveryOutcome["verdict"] = evaluation.verdict === "rejected" ? "abandoned" : evaluation.verdict;
      const confidenceAfter = evaluation.confidenceAfter ?? hypothesis.confidence;
      entry.outcomes = [...entry.outcomes, {
        experimentId: hypothesis.experimentId, minute, verdict, code: evaluation.code, reason: evaluation.reason,
        confidenceBefore: hypothesis.confidence, confidenceAfter, expectedDelta: evaluation.expectedDelta, observedDelta: evaluation.observedDelta,
        interferenceIds: [...evaluation.interferenceIds], evidenceIds,
      }].slice(-DISCOVERY_LIMITS.maxOutcomes);
      hypothesis.status = verdict; hypothesis.confidence = confidenceAfter; hypothesis.concludedMinute = minute;
      const released = releaseEvidence(entry.store, hypothesis.experimentId);
      if (released.ok) entry.store = released.value.store;
      changed = true;
    }
    if (!changed) continue;
    // Retain every active hypothesis and only the most recent concluded ones (bounded like outcomes).
    const active = entry.hypotheses.filter((h) => h.status === "active");
    const concluded = entry.hypotheses.filter((h) => h.status !== "active").slice(-DISCOVERY_LIMITS.maxOutcomes);
    entry.hypotheses = entry.hypotheses.filter((h) => active.includes(h) || concluded.includes(h));
    next.residents[residentId] = entry;
  }
  return accept({ ledger: next, evaluations });
}

/** Read-only summary of what a resident's ledger actually records; empty when nothing is committed. */
export function residentDiscoverySummary(ledger: DiscoveryLedger, residentId: string): { readings: number; interference: number; pinned: number; hypotheses: DiscoveryHypothesis[]; latestOutcome: DiscoveryOutcome | null } {
  const entry = Object.hasOwn(ledger.residents, residentId) ? ledger.residents[residentId] : undefined;
  if (!entry) return { readings: 0, interference: 0, pinned: 0, hypotheses: [], latestOutcome: null };
  return {
    readings: entry.store.observations.filter((o) => o.kind === "measurement").length,
    interference: entry.store.observations.filter((o) => o.kind === "interference").length,
    pinned: pinnedObservationIds(entry.store).length,
    hypotheses: structuredClone(entry.hypotheses),
    latestOutcome: entry.outcomes.length ? structuredClone(entry.outcomes[entry.outcomes.length - 1]!) : null,
  };
}
