/**
 * Meridian discovery core — pure, dependency-free, erasable TypeScript.
 *
 * Provenance: adapted from the staged Claude implementation at
 * CLAUDE_IMPLEMENTATION/2026-09-06-discovery/discovery-core.ts (SHA-256
 * dbb251987b9a23cb8938b16346d9ac2cd1c235b72684076034ebff06c999ff2b), recorded in
 * archive/recovered-source-manifests/2026-09-06-claude-discovery-core.json.
 * Strict indexed-access guards were added and one evidenced policy revision: the
 * interference window is exclusive at the first reading (see evaluateExperiment). This
 * module is not yet part of WorldStateSchema, WorldEventSchema or the store:
 * see discovery-adapter.ts for the isolated fixture integration.
 *
 * Scope (see WORK_BRIEF.md): bounded evidence/experimentation contracts that
 * an adapter can later feed from the existing minute kernel. Nothing here is
 * live world state. No I/O, no Date.now, no randomness, no globals mutated.
 *
 * Every function:
 *   - never mutates its arguments (inputs may be deep-frozen);
 *   - returns detached, JSON-compatible plain data;
 *   - validates structure and invariants before acting;
 *   - fails atomically (a rejection leaves the caller's state untouched and
 *     the returned "unchanged" state deep-equal to the input).
 *
 * All exported syntax is erasable: no enums, no parameter properties,
 * no namespaces, no decorators.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  MAX_OBSERVATIONS: 64,
  MAX_PINNED_OBSERVATIONS: 48,
  MAX_PLAN_REFERENCES: 48,
  MAX_PIN_OWNERS: 16,
  MAX_ID_LENGTH: 200,
  MAX_REVISION_LENGTH: 64,
  MAX_EVIDENCE_REFERENCES: 48,
  MAX_ACTIVE_RESERVATIONS: 128,
  MAX_TERMINAL_RESERVATIONS: 128,
  CONFIDENCE_MIN: 0,
  CONFIDENCE_MAX: 100,
  CONFIDENCE_STEP: 20,
} as const);

export type RejectionCode =
  // generic / structural
  | 'INVALID_SHAPE'
  | 'INVALID_ID'
  | 'INVALID_MINUTE'
  | 'INVALID_VALUE'
  | 'CORRUPT_STATE'
  | 'UNSAFE_ARITHMETIC'
  // observation store
  | 'RESIDENT_MISMATCH'
  | 'FUTURE_DATA'
  | 'STALE_ADMISSION'
  | 'CONFLICTING_DUPLICATE'
  | 'CAPACITY_EXHAUSTED'
  | 'MISSING_EVIDENCE'
  | 'CONFLICTING_GRANT'
  | 'PIN_LIMIT'
  | 'PLAN_REFERENCE_LIMIT'
  | 'PIN_OWNER_LIMIT'
  // envelopes
  | 'INVALID_CONTEXT'
  | 'INVALID_ENVELOPE'
  | 'ENVELOPE_USED'
  | 'STALE_ENVELOPE'
  | 'REVISION_MISMATCH'
  | 'UNKNOWN_ENVELOPE'
  | 'INVALID_ACTION'
  | 'UNKNOWN_ACTION_TYPE'
  | 'FORBIDDEN_FIELD'
  | 'FOREIGN_REFERENCE'
  // experiments
  | 'INVALID_HYPOTHESIS'
  | 'INVALID_CONFIDENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'FOREIGN_EVIDENCE'
  | 'MISMATCHED_EVIDENCE'
  | 'INCONSISTENT_EVIDENCE'
  | 'INTERFERENCE_OBSERVED'
  | 'SATURATION'
  | 'MATCH'
  | 'MISMATCH'
  // reservations
  | 'MINUTE_REGRESSION'
  | 'RESOURCE_MISMATCH'
  | 'GRANT_MINUTE_MISMATCH'
  | 'STALE_SEQUENCE'
  | 'ACTIVE_LIMIT'
  | 'INSUFFICIENT_STOCK'
  | 'UNKNOWN_RESERVATION'
  | 'RESERVATION_EXPIRED'
  | 'ALREADY_CONSUMED'
  | 'NOT_ACTIVE';

export type Rejection = {
  readonly ok: false;
  readonly code: RejectionCode;
  readonly reason: string;
};
export type Accepted<T> = { readonly ok: true; readonly value: T };
export type Result<T> = Accepted<T> | Rejection;

function reject(code: RejectionCode, reason: string): Rejection {
  return { ok: false, code, reason };
}
function accept<T>(value: T): Accepted<T> {
  return { ok: true, value };
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RESERVED_IDS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Identifier: 1..200 ASCII chars from [A-Za-z0-9._:-], first alphanumeric, not prototype-reserved. */
export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LIMITS.MAX_ID_LENGTH &&
    ID_PATTERN.test(value) &&
    !RESERVED_IDS.includes(value)
  );
}

/** Minute: non-negative safe integer. */
export function isMinute(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Returns null when `obj` has exactly `expected` keys, otherwise a reason. */
function exactKeys(obj: Record<string, unknown>, expected: readonly string[], label: string): string | null {
  const keys = Object.keys(obj);
  for (const k of expected) {
    if (!keys.includes(k)) return `${label}: missing field "${k}"`;
  }
  for (const k of keys) {
    if (!expected.includes(k)) return `${label}: unexpected field "${k}"`;
  }
  return null;
}

/** ASCII code-point order (IDs are validated ASCII so code-unit order == code-point order). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Structural deep clone for JSON-compatible plain data. Result is unfrozen and detached. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = deepClone((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}

/** Structural deep equality for JSON-compatible plain data. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      const key = ka[i];
      if (key === undefined || key !== kb[i]) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/** Recursively freezes plain data in place and returns it. Utility for tests/adapters. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[k]);
    }
    Object.freeze(value);
  }
  return value;
}

function sumSafe(values: readonly number[]): number | null {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1 + 2. Observation store with bounded evidence pinning
// ---------------------------------------------------------------------------

export type ObservationKind = 'measurement' | 'interference';

export type MeasurementObservation = {
  readonly kind: 'measurement';
  readonly id: string;
  readonly residentId: string;
  readonly placeId: string;
  readonly subjectId: string;
  readonly minute: number;
  /** Finite number. Only measurements carry a value. */
  readonly value: number;
};

export type InterferenceObservation = {
  readonly kind: 'interference';
  readonly id: string;
  readonly residentId: string;
  readonly placeId: string;
  readonly subjectId: string;
  readonly minute: number;
};

export type Observation = MeasurementObservation | InterferenceObservation;

export type PinGrant = {
  readonly ownerPlanId: string;
  /** Sorted, de-duplicated observation IDs (each exists in the store). */
  readonly observationIds: readonly string[];
};

export type ObservationStore = {
  readonly version: 1;
  readonly residentId: string;
  /** Canonically sorted by (minute asc, id code-point asc). Unique IDs. */
  readonly observations: readonly Observation[];
  /** Canonically sorted by ownerPlanId. Unique owners. */
  readonly pins: readonly PinGrant[];
};

const MEASUREMENT_KEYS = ['kind', 'id', 'residentId', 'placeId', 'subjectId', 'minute', 'value'] as const;
const INTERFERENCE_KEYS = ['kind', 'id', 'residentId', 'placeId', 'subjectId', 'minute'] as const;

function compareObservations(a: Observation, b: Observation): number {
  if (a.minute !== b.minute) return a.minute < b.minute ? -1 : 1;
  return compareIds(a.id, b.id);
}

export function validateObservation(value: unknown): Result<Observation> {
  if (!isPlainObject(value)) return reject('INVALID_SHAPE', 'observation must be a plain object');
  const kind = value.kind;
  if (kind !== 'measurement' && kind !== 'interference') {
    return reject('INVALID_SHAPE', 'observation.kind must be "measurement" or "interference"');
  }
  const keyError = exactKeys(value, kind === 'measurement' ? MEASUREMENT_KEYS : INTERFERENCE_KEYS, 'observation');
  if (keyError) return reject('INVALID_SHAPE', keyError);
  for (const field of ['id', 'residentId', 'placeId', 'subjectId'] as const) {
    if (!isValidId(value[field])) return reject('INVALID_ID', `observation.${field} is not a valid identifier`);
  }
  if (!isMinute(value.minute)) return reject('INVALID_MINUTE', 'observation.minute must be a non-negative safe integer');
  if (kind === 'measurement') {
    if (!isFiniteNumber(value.value)) return reject('INVALID_VALUE', 'measurement.value must be a finite number');
    return accept({
      kind: 'measurement',
      id: value.id as string,
      residentId: value.residentId as string,
      placeId: value.placeId as string,
      subjectId: value.subjectId as string,
      minute: value.minute,
      value: value.value,
    });
  }
  return accept({
    kind: 'interference',
    id: value.id as string,
    residentId: value.residentId as string,
    placeId: value.placeId as string,
    subjectId: value.subjectId as string,
    minute: value.minute,
  });
}

export function createObservationStore(residentId: unknown): Result<ObservationStore> {
  if (!isValidId(residentId)) return reject('INVALID_ID', 'residentId is not a valid identifier');
  return accept({ version: 1, residentId, observations: [], pins: [] });
}

/** Distinct pinned observation IDs across all plan owners, sorted. */
export function pinnedObservationIds(store: ObservationStore): string[] {
  const set = new Set<string>();
  for (const grant of store.pins) for (const id of grant.observationIds) set.add(id);
  return [...set].sort(compareIds);
}

export function totalPinnedCount(store: ObservationStore): number {
  return pinnedObservationIds(store).length;
}

/**
 * Lists invariant violations (empty array == healthy). Checks structure as well
 * as ordering, uniqueness, bounds, ownership and reference integrity.
 */
export function checkStoreInvariants(value: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(value)) return ['store must be a plain object'];
  const keyError = exactKeys(value, ['version', 'residentId', 'observations', 'pins'], 'store');
  if (keyError) return [keyError];
  if (value.version !== 1) problems.push('store.version must be 1');
  if (!isValidId(value.residentId)) problems.push('store.residentId is not a valid identifier');
  if (!Array.isArray(value.observations)) return [...problems, 'store.observations must be an array'];
  if (!Array.isArray(value.pins)) return [...problems, 'store.pins must be an array'];

  const observations = value.observations as unknown[];
  if (observations.length > LIMITS.MAX_OBSERVATIONS) problems.push(`store holds more than ${LIMITS.MAX_OBSERVATIONS} observations`);
  const ids = new Set<string>();
  let previous: Observation | null = null;
  for (let i = 0; i < observations.length; i += 1) {
    const checked = validateObservation(observations[i]);
    if (!checked.ok) {
      problems.push(`observations[${i}]: ${checked.reason}`);
      continue;
    }
    const obs = checked.value;
    if (obs.residentId !== value.residentId) problems.push(`observations[${i}] belongs to another resident`);
    if (ids.has(obs.id)) problems.push(`observations[${i}] duplicates id "${obs.id}"`);
    ids.add(obs.id);
    if (previous && compareObservations(previous, obs) >= 0) problems.push(`observations[${i}] breaks canonical (minute, id) ordering`);
    previous = obs;
  }

  const pins = value.pins as unknown[];
  if (pins.length > LIMITS.MAX_PIN_OWNERS) problems.push(`store has more than ${LIMITS.MAX_PIN_OWNERS} pin owners`);
  const owners = new Set<string>();
  const distinct = new Set<string>();
  let previousOwner: string | null = null;
  for (let i = 0; i < pins.length; i += 1) {
    const grant = pins[i];
    if (!isPlainObject(grant)) {
      problems.push(`pins[${i}] must be a plain object`);
      continue;
    }
    const grantKeyError = exactKeys(grant, ['ownerPlanId', 'observationIds'], `pins[${i}]`);
    if (grantKeyError) {
      problems.push(grantKeyError);
      continue;
    }
    if (!isValidId(grant.ownerPlanId)) {
      problems.push(`pins[${i}].ownerPlanId is not a valid identifier`);
      continue;
    }
    const owner = grant.ownerPlanId;
    if (owners.has(owner)) problems.push(`pins[${i}] duplicates owner "${owner}"`);
    owners.add(owner);
    if (previousOwner !== null && compareIds(previousOwner, owner) >= 0) problems.push(`pins[${i}] breaks owner ordering`);
    previousOwner = owner;
    if (!Array.isArray(grant.observationIds)) {
      problems.push(`pins[${i}].observationIds must be an array`);
      continue;
    }
    const refs = grant.observationIds as unknown[];
    if (refs.length > LIMITS.MAX_PLAN_REFERENCES) problems.push(`pins[${i}] holds more than ${LIMITS.MAX_PLAN_REFERENCES} references`);
    let previousRef: string | null = null;
    for (let j = 0; j < refs.length; j += 1) {
      const ref = refs[j];
      if (!isValidId(ref)) {
        problems.push(`pins[${i}].observationIds[${j}] is not a valid identifier`);
        continue;
      }
      if (!ids.has(ref)) problems.push(`pins[${i}] references missing observation "${ref}" (dangling)`);
      if (previousRef !== null && compareIds(previousRef, ref) >= 0) problems.push(`pins[${i}] references not sorted/unique`);
      previousRef = ref;
      distinct.add(ref);
    }
  }
  if (distinct.size > LIMITS.MAX_PINNED_OBSERVATIONS) problems.push(`more than ${LIMITS.MAX_PINNED_OBSERVATIONS} distinct pinned observations`);
  return problems;
}

export function validateObservationStore(value: unknown): Result<ObservationStore> {
  const problems = checkStoreInvariants(value);
  if (problems.length > 0) return reject('CORRUPT_STATE', problems.join('; '));
  return accept(deepClone(value as ObservationStore));
}

export type AddObservationOutcome = {
  readonly store: ObservationStore;
  /** Observation evicted to make room, if any. */
  readonly evicted: Observation | null;
  /** True when an identical observation was already present (no change). */
  readonly idempotent: boolean;
};

/**
 * Admits an observation into the resident's store at `committedMinute`.
 * The observation minute must equal the committed minute: later is FUTURE_DATA,
 * earlier is STALE_ADMISSION. At capacity the oldest UNPINNED observation
 * (minute asc, then id code-point asc) is evicted; pins are never evicted.
 */
export function addObservation(store: unknown, observation: unknown, committedMinute: unknown): Result<AddObservationOutcome> {
  const checkedStore = validateObservationStore(store);
  if (!checkedStore.ok) return checkedStore;
  const checkedObs = validateObservation(observation);
  if (!checkedObs.ok) return checkedObs;
  if (!isMinute(committedMinute)) return reject('INVALID_MINUTE', 'committedMinute must be a non-negative safe integer');
  const working = checkedStore.value;
  const obs = checkedObs.value;
  if (obs.residentId !== working.residentId) {
    return reject('RESIDENT_MISMATCH', `observation belongs to "${obs.residentId}", store belongs to "${working.residentId}"`);
  }
  if (obs.minute > committedMinute) {
    return reject('FUTURE_DATA', `observation minute ${obs.minute} is after committed minute ${committedMinute}`);
  }
  if (obs.minute < committedMinute) {
    return reject('STALE_ADMISSION', `observation minute ${obs.minute} is before committed minute ${committedMinute}`);
  }
  const existing = working.observations.find((o) => o.id === obs.id);
  if (existing) {
    if (deepEqual(existing, obs)) return accept({ store: working, evicted: null, idempotent: true });
    return reject('CONFLICTING_DUPLICATE', `observation id "${obs.id}" already exists with different content`);
  }

  let evicted: Observation | null = null;
  let observations: Observation[] = [...working.observations];
  if (observations.length >= LIMITS.MAX_OBSERVATIONS) {
    const pinned = new Set(pinnedObservationIds(working));
    // observations are canonically sorted, so the first unpinned entry is the eviction candidate
    const candidate = observations.find((o) => !pinned.has(o.id));
    if (!candidate) return reject('CAPACITY_EXHAUSTED', 'store is full and every observation is pinned');
    evicted = candidate;
    observations = observations.filter((o) => o.id !== candidate.id);
  }
  observations.push(obs);
  observations.sort(compareObservations);
  return accept({
    store: { version: 1, residentId: working.residentId, observations, pins: working.pins },
    evicted,
    idempotent: false,
  });
}

export type PinOutcome = {
  readonly store: ObservationStore;
  readonly idempotent: boolean;
  /** Distinct pinned observation IDs after the operation. */
  readonly pinnedTotal: number;
};

/**
 * Atomically grants `ownerPlanId` references to the listed observations.
 * Validation of every ID happens before any change; a rejection leaves the
 * store unchanged. Repeating the same owner+set is idempotent; a different set
 * for an existing owner is CONFLICTING_GRANT (release first).
 */
export function pinEvidence(store: unknown, ownerPlanId: unknown, observationIds: unknown): Result<PinOutcome> {
  const checkedStore = validateObservationStore(store);
  if (!checkedStore.ok) return checkedStore;
  const working = checkedStore.value;
  if (!isValidId(ownerPlanId)) return reject('INVALID_ID', 'ownerPlanId is not a valid identifier');
  if (!Array.isArray(observationIds)) return reject('INVALID_SHAPE', 'observationIds must be an array');
  const known = new Set(working.observations.map((o) => o.id));
  const wanted = new Set<string>();
  for (let i = 0; i < observationIds.length; i += 1) {
    const id = observationIds[i];
    if (!isValidId(id)) return reject('INVALID_ID', `observationIds[${i}] is not a valid identifier`);
    if (!known.has(id)) return reject('MISSING_EVIDENCE', `observation "${id}" is not in this resident's store`);
    wanted.add(id);
  }
  if (wanted.size === 0) return reject('INVALID_SHAPE', 'observationIds must name at least one observation');
  const sortedWanted = [...wanted].sort(compareIds);
  if (sortedWanted.length > LIMITS.MAX_PLAN_REFERENCES) {
    return reject('PLAN_REFERENCE_LIMIT', `a plan may reference at most ${LIMITS.MAX_PLAN_REFERENCES} observations`);
  }
  const existing = working.pins.find((g) => g.ownerPlanId === ownerPlanId);
  if (existing) {
    if (deepEqual([...existing.observationIds], sortedWanted)) {
      return accept({ store: working, idempotent: true, pinnedTotal: totalPinnedCount(working) });
    }
    return reject('CONFLICTING_GRANT', `plan "${ownerPlanId}" already holds a different evidence set; release it first`);
  }
  if (working.pins.length >= LIMITS.MAX_PIN_OWNERS) {
    return reject('PIN_OWNER_LIMIT', `at most ${LIMITS.MAX_PIN_OWNERS} plans may hold pins`);
  }
  const distinct = new Set(pinnedObservationIds(working));
  for (const id of sortedWanted) distinct.add(id);
  if (distinct.size > LIMITS.MAX_PINNED_OBSERVATIONS) {
    return reject('PIN_LIMIT', `granting would pin ${distinct.size} distinct observations; limit is ${LIMITS.MAX_PINNED_OBSERVATIONS}`);
  }
  const pins = [...working.pins, { ownerPlanId, observationIds: sortedWanted }].sort((a, b) => compareIds(a.ownerPlanId, b.ownerPlanId));
  return accept({
    store: { version: 1, residentId: working.residentId, observations: working.observations, pins },
    idempotent: false,
    pinnedTotal: distinct.size,
  });
}

export type ReleaseOutcome = {
  readonly store: ObservationStore;
  /** IDs that are no longer pinned by ANY plan after this release. */
  readonly unpinned: readonly string[];
  readonly idempotent: boolean;
};

/** Removes only `ownerPlanId`'s references. Shared references stay pinned. Unknown owner is a no-op. */
export function releaseEvidence(store: unknown, ownerPlanId: unknown): Result<ReleaseOutcome> {
  const checkedStore = validateObservationStore(store);
  if (!checkedStore.ok) return checkedStore;
  const working = checkedStore.value;
  if (!isValidId(ownerPlanId)) return reject('INVALID_ID', 'ownerPlanId is not a valid identifier');
  const existing = working.pins.find((g) => g.ownerPlanId === ownerPlanId);
  if (!existing) return accept({ store: working, unpinned: [], idempotent: true });
  const pins = working.pins.filter((g) => g.ownerPlanId !== ownerPlanId);
  const next: ObservationStore = { version: 1, residentId: working.residentId, observations: working.observations, pins };
  const stillPinned = new Set(pinnedObservationIds(next));
  const unpinned = existing.observationIds.filter((id) => !stillPinned.has(id));
  return accept({ store: next, unpinned, idempotent: false });
}

// ---------------------------------------------------------------------------
// 3. Observation envelope validation (no cryptography; IDs do not sign anything)
// ---------------------------------------------------------------------------

export type ObservationEnvelope = {
  readonly envelopeId: string;
  readonly residentId: string;
  readonly observedMinute: number;
  /** Non-empty printable ASCII, at most LIMITS.MAX_REVISION_LENGTH chars. */
  readonly revision: string;
  readonly used: boolean;
};

/** Engine-side truth the envelope must match exactly. */
export type EngineContext = {
  readonly residentId: string;
  readonly committedMinute: number;
  readonly revision: string;
  /** Observation IDs this resident owns (from their store). Used for reference checks. */
  readonly ownedObservationIds: readonly string[];
};

export type ObserveSlots = {
  readonly placeId: string;
  readonly subjectId: string;
};

export type ProposeExperimentSlots = {
  readonly experimentId: string;
  readonly placeId: string;
  readonly subjectId: string;
  /** Hypothesised regeneration rate per minute, non-negative safe integer. */
  readonly expectedRatePerMinute: number;
  /** Resident-owned observation IDs offered as evidence (may be empty; at most 48, unique). */
  readonly evidenceObservationIds: readonly string[];
};

export type CancelExperimentSlots = {
  readonly experimentId: string;
};

export type EnvelopeActionType = 'observe' | 'propose-experiment' | 'cancel-experiment';

export type EnvelopeAction =
  | { readonly envelopeId: string; readonly actionType: 'observe'; readonly slots: ObserveSlots }
  | { readonly envelopeId: string; readonly actionType: 'propose-experiment'; readonly slots: ProposeExperimentSlots }
  | { readonly envelopeId: string; readonly actionType: 'cancel-experiment'; readonly slots: CancelExperimentSlots };

export type EnvelopeDecision =
  | {
      readonly status: 'accepted';
      readonly consumed: true;
      /** Detached single-use envelope state with used = true. */
      readonly envelope: ObservationEnvelope;
      readonly action: EnvelopeAction;
    }
  | {
      readonly status: 'rejected';
      /**
       * True when the envelope was well-identified (structurally valid, unused, exactly
       * matching the engine context, and named by the action) but the action failed
       * validation: the envelope is then spent so the payload cannot be retried against it.
       * False when the envelope itself could not be trusted (malformed, used, stale,
       * revision/resident mismatch, or not named by the action): it is returned unchanged.
       */
      readonly consumed: boolean;
      /** Detached envelope state, or null when the envelope was malformed. */
      readonly envelope: ObservationEnvelope | null;
      readonly code: RejectionCode;
      readonly reason: string;
    };

const ENVELOPE_KEYS = ['envelopeId', 'residentId', 'observedMinute', 'revision', 'used'] as const;
const CONTEXT_KEYS = ['residentId', 'committedMinute', 'revision', 'ownedObservationIds'] as const;
const ACTION_KEYS = ['envelopeId', 'actionType', 'slots'] as const;
const OBSERVE_SLOT_KEYS = ['placeId', 'subjectId'] as const;
const PROPOSE_SLOT_KEYS = ['experimentId', 'placeId', 'subjectId', 'expectedRatePerMinute', 'evidenceObservationIds'] as const;
const CANCEL_SLOT_KEYS = ['experimentId'] as const;
/** Field names that must never appear in resident-supplied slots (measurements/dates/identity are engine-owned). */
const FORBIDDEN_SLOT_KEYS: readonly string[] = [
  'value', 'values', 'measurement', 'minute', 'observedMinute', 'committedMinute',
  'date', 'timestamp', 'time', 'residentId', 'revision', 'used',
];
const REVISION_PATTERN = /^[\x21-\x7e]+$/;

export function isValidRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= LIMITS.MAX_REVISION_LENGTH && REVISION_PATTERN.test(value);
}

export function validateEnvelope(value: unknown): Result<ObservationEnvelope> {
  if (!isPlainObject(value)) return reject('INVALID_ENVELOPE', 'envelope must be a plain object');
  const keyError = exactKeys(value, ENVELOPE_KEYS, 'envelope');
  if (keyError) return reject('INVALID_ENVELOPE', keyError);
  if (!isValidId(value.envelopeId)) return reject('INVALID_ENVELOPE', 'envelope.envelopeId is not a valid identifier');
  if (!isValidId(value.residentId)) return reject('INVALID_ENVELOPE', 'envelope.residentId is not a valid identifier');
  if (!isMinute(value.observedMinute)) return reject('INVALID_ENVELOPE', 'envelope.observedMinute must be a non-negative safe integer');
  if (!isValidRevision(value.revision)) return reject('INVALID_ENVELOPE', 'envelope.revision must be a non-empty bounded printable string');
  if (typeof value.used !== 'boolean') return reject('INVALID_ENVELOPE', 'envelope.used must be a boolean');
  return accept({
    envelopeId: value.envelopeId as string,
    residentId: value.residentId as string,
    observedMinute: value.observedMinute,
    revision: value.revision as string,
    used: value.used,
  });
}

export function validateEngineContext(value: unknown): Result<EngineContext> {
  if (!isPlainObject(value)) return reject('INVALID_CONTEXT', 'context must be a plain object');
  const keyError = exactKeys(value, CONTEXT_KEYS, 'context');
  if (keyError) return reject('INVALID_CONTEXT', keyError);
  if (!isValidId(value.residentId)) return reject('INVALID_CONTEXT', 'context.residentId is not a valid identifier');
  if (!isMinute(value.committedMinute)) return reject('INVALID_CONTEXT', 'context.committedMinute must be a non-negative safe integer');
  if (!isValidRevision(value.revision)) return reject('INVALID_CONTEXT', 'context.revision must be a non-empty bounded printable string');
  if (!Array.isArray(value.ownedObservationIds)) return reject('INVALID_CONTEXT', 'context.ownedObservationIds must be an array');
  const owned: string[] = [];
  for (const id of value.ownedObservationIds as unknown[]) {
    if (!isValidId(id)) return reject('INVALID_CONTEXT', 'context.ownedObservationIds contains an invalid identifier');
    owned.push(id);
  }
  return accept({
    residentId: value.residentId as string,
    committedMinute: value.committedMinute,
    revision: value.revision as string,
    ownedObservationIds: owned,
  });
}

function checkForbiddenSlotKeys(slots: Record<string, unknown>): string | null {
  for (const key of Object.keys(slots)) {
    if (FORBIDDEN_SLOT_KEYS.includes(key)) return `slots.${key} is engine-owned and may not be supplied by a resident`;
  }
  return null;
}

function validateSlots(actionType: EnvelopeActionType, slots: unknown, context: EngineContext): Result<EnvelopeAction['slots']> {
  if (!isPlainObject(slots)) return reject('INVALID_ACTION', 'action.slots must be a plain object');
  const forbidden = checkForbiddenSlotKeys(slots);
  if (forbidden) return reject('FORBIDDEN_FIELD', forbidden);
  if (actionType === 'observe') {
    const keyError = exactKeys(slots, OBSERVE_SLOT_KEYS, 'observe slots');
    if (keyError) return reject('INVALID_ACTION', keyError);
    if (!isValidId(slots.placeId)) return reject('INVALID_ID', 'slots.placeId is not a valid identifier');
    if (!isValidId(slots.subjectId)) return reject('INVALID_ID', 'slots.subjectId is not a valid identifier');
    return accept({ placeId: slots.placeId as string, subjectId: slots.subjectId as string });
  }
  if (actionType === 'cancel-experiment') {
    const keyError = exactKeys(slots, CANCEL_SLOT_KEYS, 'cancel-experiment slots');
    if (keyError) return reject('INVALID_ACTION', keyError);
    if (!isValidId(slots.experimentId)) return reject('INVALID_ID', 'slots.experimentId is not a valid identifier');
    return accept({ experimentId: slots.experimentId as string });
  }
  const keyError = exactKeys(slots, PROPOSE_SLOT_KEYS, 'propose-experiment slots');
  if (keyError) return reject('INVALID_ACTION', keyError);
  for (const field of ['experimentId', 'placeId', 'subjectId'] as const) {
    if (!isValidId(slots[field])) return reject('INVALID_ID', `slots.${field} is not a valid identifier`);
  }
  if (!isNonNegativeSafeInteger(slots.expectedRatePerMinute)) {
    return reject('INVALID_VALUE', 'slots.expectedRatePerMinute must be a non-negative safe integer');
  }
  if (!Array.isArray(slots.evidenceObservationIds)) return reject('INVALID_ACTION', 'slots.evidenceObservationIds must be an array');
  const evidence = slots.evidenceObservationIds as unknown[];
  if (evidence.length > LIMITS.MAX_EVIDENCE_REFERENCES) {
    return reject('INVALID_ACTION', `slots.evidenceObservationIds may hold at most ${LIMITS.MAX_EVIDENCE_REFERENCES} references`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < evidence.length; i += 1) {
    const id = evidence[i];
    if (!isValidId(id)) return reject('INVALID_ID', `slots.evidenceObservationIds[${i}] is not a valid identifier`);
    if (seen.has(id)) return reject('INVALID_ACTION', `slots.evidenceObservationIds[${i}] duplicates "${id}"`);
    seen.add(id);
    if (!context.ownedObservationIds.includes(id)) {
      return reject('FOREIGN_REFERENCE', `slots.evidenceObservationIds[${i}] "${id}" is not owned by this resident`);
    }
  }
  return accept({
    experimentId: slots.experimentId as string,
    placeId: slots.placeId as string,
    subjectId: slots.subjectId as string,
    expectedRatePerMinute: slots.expectedRatePerMinute,
    evidenceObservationIds: [...seen],
  });
}

/**
 * Validates an incoming resident action against an engine-issued envelope and
 * the engine's current context. Pure: neither `envelope` nor `action` is
 * mutated; the returned envelope is a detached copy.
 *
 * Consumption rule (tested): a well-identified envelope is consumed on accept
 * AND on reject. An envelope that fails identity (malformed, used, stale,
 * mismatched resident/revision, or not named by the action) is never consumed.
 */
export function validateEnvelopeAction(envelope: unknown, action: unknown, context: unknown): EnvelopeDecision {
  const checkedContext = validateEngineContext(context);
  if (!checkedContext.ok) {
    return { status: 'rejected', consumed: false, envelope: null, code: checkedContext.code, reason: checkedContext.reason };
  }
  const ctx = checkedContext.value;
  const checkedEnvelope = validateEnvelope(envelope);
  if (!checkedEnvelope.ok) {
    return { status: 'rejected', consumed: false, envelope: null, code: checkedEnvelope.code, reason: checkedEnvelope.reason };
  }
  const env = checkedEnvelope.value;
  const unchanged = (code: RejectionCode, reason: string): EnvelopeDecision => ({
    status: 'rejected', consumed: false, envelope: { ...env }, code, reason,
  });
  if (env.used) return unchanged('ENVELOPE_USED', `envelope "${env.envelopeId}" has already been used`);
  if (env.residentId !== ctx.residentId) {
    return unchanged('RESIDENT_MISMATCH', `envelope resident "${env.residentId}" does not match current resident "${ctx.residentId}"`);
  }
  if (env.observedMinute !== ctx.committedMinute) {
    const direction = env.observedMinute < ctx.committedMinute ? 'stale' : 'future';
    return unchanged('STALE_ENVELOPE', `envelope minute ${env.observedMinute} is ${direction} relative to committed minute ${ctx.committedMinute}`);
  }
  if (env.revision !== ctx.revision) {
    return unchanged('REVISION_MISMATCH', `envelope revision "${env.revision}" does not match current revision "${ctx.revision}"`);
  }
  if (!isPlainObject(action)) return unchanged('INVALID_ACTION', 'action must be a plain object');
  if (action.envelopeId !== env.envelopeId) {
    return unchanged('UNKNOWN_ENVELOPE', 'action does not name the engine-issued envelope');
  }

  // From here the envelope is well-identified: any rejection consumes it.
  const spent: ObservationEnvelope = { ...env, used: true };
  const consumedReject = (code: RejectionCode, reason: string): EnvelopeDecision => ({
    status: 'rejected', consumed: true, envelope: spent, code, reason,
  });
  const keyError = exactKeys(action, ACTION_KEYS, 'action');
  if (keyError) return consumedReject('INVALID_ACTION', keyError);
  const actionType = action.actionType;
  if (actionType !== 'observe' && actionType !== 'propose-experiment' && actionType !== 'cancel-experiment') {
    return consumedReject('UNKNOWN_ACTION_TYPE', 'action.actionType must be observe, propose-experiment or cancel-experiment');
  }
  const checkedSlots = validateSlots(actionType, action.slots, ctx);
  if (!checkedSlots.ok) return consumedReject(checkedSlots.code, checkedSlots.reason);
  const validated = { envelopeId: env.envelopeId, actionType, slots: checkedSlots.value } as EnvelopeAction;
  return { status: 'accepted', consumed: true, envelope: spent, action: validated };
}

// ---------------------------------------------------------------------------
// 4. Experiment evaluator
// ---------------------------------------------------------------------------

export type ExperimentHypothesis = {
  readonly experimentId: string;
  readonly residentId: string;
  readonly placeId: string;
  readonly subjectId: string;
  /** Non-negative safe integer units per minute. */
  readonly expectedRatePerMinute: number;
  /** Known stock capacity, positive safe integer. */
  readonly capacity: number;
};

export type Verdict = 'supported' | 'refuted' | 'inconclusive' | 'rejected';
export type ConfidenceChange = -20 | 0 | 20;

export type EvidenceEvaluation = {
  readonly experimentId: string | null;
  /**
   * supported: every measurement matched the linear prediction and nothing confounded it.
   *   This supports the resident's BELIEF; it is not proof of an objective law.
   * refuted: an unconfounded measurement diverged from the prediction (belief refuted).
   * inconclusive: saturation or observed interference makes the test uninformative.
   * rejected: the evidence or hypothesis was unusable (missing, foreign, mismatched, unsafe).
   */
  readonly verdict: Verdict;
  readonly code: RejectionCode;
  readonly reason: string;
  readonly intervalStart: number | null;
  readonly intervalEnd: number | null;
  readonly expectedDelta: number | null;
  readonly observedDelta: number | null;
  readonly measurementsUsed: number;
  /** Interference observations (same place+subject) recorded within the interval, inclusive. */
  readonly interferenceIds: readonly string[];
  readonly confidenceBefore: number | null;
  readonly confidenceAfter: number | null;
  readonly confidenceChange: ConfidenceChange;
};

const HYPOTHESIS_KEYS = ['experimentId', 'residentId', 'placeId', 'subjectId', 'expectedRatePerMinute', 'capacity'] as const;

export function validateHypothesis(value: unknown): Result<ExperimentHypothesis> {
  if (!isPlainObject(value)) return reject('INVALID_HYPOTHESIS', 'hypothesis must be a plain object');
  const keyError = exactKeys(value, HYPOTHESIS_KEYS, 'hypothesis');
  if (keyError) return reject('INVALID_HYPOTHESIS', keyError);
  for (const field of ['experimentId', 'residentId', 'placeId', 'subjectId'] as const) {
    if (!isValidId(value[field])) return reject('INVALID_HYPOTHESIS', `hypothesis.${field} is not a valid identifier`);
  }
  if (!isNonNegativeSafeInteger(value.expectedRatePerMinute)) {
    return reject('INVALID_HYPOTHESIS', 'hypothesis.expectedRatePerMinute must be a non-negative safe integer');
  }
  if (!isPositiveSafeInteger(value.capacity)) return reject('INVALID_HYPOTHESIS', 'hypothesis.capacity must be a positive safe integer');
  return accept({
    experimentId: value.experimentId as string,
    residentId: value.residentId as string,
    placeId: value.placeId as string,
    subjectId: value.subjectId as string,
    expectedRatePerMinute: value.expectedRatePerMinute,
    capacity: value.capacity,
  });
}

export function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= LIMITS.CONFIDENCE_MIN && value <= LIMITS.CONFIDENCE_MAX;
}

/** Clamped confidence update; `before` must already be a valid confidence. */
export function applyConfidenceChange(before: number, change: ConfidenceChange): number {
  const next = before + change;
  if (next < LIMITS.CONFIDENCE_MIN) return LIMITS.CONFIDENCE_MIN;
  if (next > LIMITS.CONFIDENCE_MAX) return LIMITS.CONFIDENCE_MAX;
  return next;
}

/**
 * Evaluates a linear-regeneration hypothesis against engine-owned measurements
 * held in the resident's store. Only the listed evidence IDs are used as
 * measurements; interference is looked up across the WHOLE store for the same
 * place+subject inside the measured interval so a resident cannot hide it by
 * omission. Nothing outside the store is consulted.
 */
export function evaluateExperiment(hypothesis: unknown, store: unknown, evidenceIds: unknown, confidenceBefore: unknown): EvidenceEvaluation {
  const confidenceValid = isConfidence(confidenceBefore);
  const base = {
    intervalStart: null,
    intervalEnd: null,
    expectedDelta: null,
    observedDelta: null,
    measurementsUsed: 0,
    interferenceIds: [] as string[],
    confidenceBefore: confidenceValid ? (confidenceBefore as number) : null,
    confidenceAfter: confidenceValid ? (confidenceBefore as number) : null,
    confidenceChange: 0 as ConfidenceChange,
  };
  const rejected = (experimentId: string | null, code: RejectionCode, reason: string): EvidenceEvaluation => ({
    experimentId, verdict: 'rejected', code, reason, ...base,
  });

  const checkedHypothesis = validateHypothesis(hypothesis);
  if (!checkedHypothesis.ok) return rejected(null, checkedHypothesis.code, checkedHypothesis.reason);
  const hyp = checkedHypothesis.value;
  if (!confidenceValid) return rejected(hyp.experimentId, 'INVALID_CONFIDENCE', 'confidenceBefore must be an integer between 0 and 100');
  const checkedStore = validateObservationStore(store);
  if (!checkedStore.ok) return rejected(hyp.experimentId, checkedStore.code, checkedStore.reason);
  const owned = checkedStore.value;
  if (owned.residentId !== hyp.residentId) {
    return rejected(hyp.experimentId, 'FOREIGN_EVIDENCE', `store belongs to "${owned.residentId}", hypothesis to "${hyp.residentId}"`);
  }
  if (!Array.isArray(evidenceIds)) return rejected(hyp.experimentId, 'INVALID_SHAPE', 'evidenceIds must be an array');
  if (evidenceIds.length > LIMITS.MAX_EVIDENCE_REFERENCES) {
    return rejected(hyp.experimentId, 'INVALID_SHAPE', `at most ${LIMITS.MAX_EVIDENCE_REFERENCES} evidence references are accepted`);
  }
  const byId = new Map(owned.observations.map((o) => [o.id, o] as const));
  const measurements: MeasurementObservation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < evidenceIds.length; i += 1) {
    const id = evidenceIds[i];
    if (!isValidId(id)) return rejected(hyp.experimentId, 'INVALID_ID', `evidenceIds[${i}] is not a valid identifier`);
    if (seen.has(id)) continue;
    seen.add(id);
    const obs = byId.get(id);
    if (!obs) return rejected(hyp.experimentId, 'MISSING_EVIDENCE', `observation "${id}" is not in the resident's store`);
    if (obs.placeId !== hyp.placeId || obs.subjectId !== hyp.subjectId) {
      return rejected(hyp.experimentId, 'MISMATCHED_EVIDENCE', `observation "${id}" is about a different place or subject`);
    }
    if (obs.kind === 'measurement') measurements.push(obs);
  }
  if (measurements.length < 2) {
    return rejected(hyp.experimentId, 'INSUFFICIENT_EVIDENCE', 'at least two measurements of the subject are required');
  }
  measurements.sort(compareObservations);
  for (let i = 1; i < measurements.length; i += 1) {
    const current = measurements[i], previous = measurements[i - 1];
    if (current && previous && current.minute === previous.minute) {
      return rejected(hyp.experimentId, 'INCONSISTENT_EVIDENCE', `two measurements share minute ${current.minute}`);
    }
  }
  for (const m of measurements) {
    if (!isNonNegativeSafeInteger(m.value)) {
      return rejected(hyp.experimentId, 'INCONSISTENT_EVIDENCE', `measurement "${m.id}" is not a non-negative integer stock value`);
    }
    if (m.value > hyp.capacity) {
      return rejected(hyp.experimentId, 'INCONSISTENT_EVIDENCE', `measurement "${m.id}" (${m.value}) exceeds known capacity ${hyp.capacity}`);
    }
  }

  const first = measurements[0];
  const last = measurements[measurements.length - 1];
  // Guarded for strict indexed access; unreachable after the length check above.
  if (!first || !last) return rejected(hyp.experimentId, 'INSUFFICIENT_EVIDENCE', 'at least two measurements of the subject are required');
  const span = last.minute - first.minute;
  const expectedDelta = hyp.expectedRatePerMinute * span;
  if (!Number.isSafeInteger(expectedDelta)) {
    return rejected(hyp.experimentId, 'UNSAFE_ARITHMETIC', `expected delta ${hyp.expectedRatePerMinute} * ${span} is not a safe integer`);
  }
  const predictedFinal = first.value + expectedDelta;
  if (!Number.isSafeInteger(predictedFinal)) {
    return rejected(hyp.experimentId, 'UNSAFE_ARITHMETIC', 'predicted final stock is not a safe integer');
  }
  const observedDelta = last.value - first.value;
  const interferenceIds = owned.observations
    // Window is exclusive at the first reading and inclusive at the last: a reading is the
    // committed value after that minute's events, so interference in the first minute is
    // already reflected in the first value, while interference in the last minute is not
    // separable from the last reading. (Adapter-evidenced revision of the staged policy.)
    .filter((o) => o.kind === 'interference' && o.placeId === hyp.placeId && o.subjectId === hyp.subjectId && o.minute > first.minute && o.minute <= last.minute)
    .map((o) => o.id);
  const filled = {
    experimentId: hyp.experimentId,
    intervalStart: first.minute,
    intervalEnd: last.minute,
    expectedDelta,
    observedDelta,
    measurementsUsed: measurements.length,
    interferenceIds,
    confidenceBefore: confidenceBefore as number,
  };
  const finish = (verdict: Verdict, code: RejectionCode, reason: string, change: ConfidenceChange): EvidenceEvaluation => ({
    ...filled, verdict, code, reason, confidenceAfter: applyConfidenceChange(confidenceBefore as number, change), confidenceChange: change,
  });

  if (interferenceIds.length > 0) {
    return finish('inconclusive', 'INTERFERENCE_OBSERVED', `interference recorded within minutes ${first.minute}..${last.minute}: ${interferenceIds.join(', ')}`, 0);
  }
  if (first.value >= hyp.capacity) {
    return finish('inconclusive', 'SATURATION', 'stock already at capacity at the first measurement; hidden regeneration cannot be inferred', 0);
  }
  if (predictedFinal > hyp.capacity) {
    return finish('inconclusive', 'SATURATION', `prediction ${predictedFinal} exceeds capacity ${hyp.capacity}; linear gain can only be tested below capacity`, 0);
  }
  for (const m of measurements) {
    const predicted = first.value + hyp.expectedRatePerMinute * (m.minute - first.minute);
    if (m.value !== predicted) {
      return finish('refuted', 'MISMATCH', `measurement "${m.id}" at minute ${m.minute} was ${m.value}, linear belief predicted ${predicted}; belief refuted (no interference was recorded, but unobserved interference is not ruled out)`, -20);
    }
  }
  return finish('supported', 'MATCH', `all ${measurements.length} measurements matched the linear prediction (delta ${expectedDelta} over ${span} minutes) without recorded interference; belief supported, not proven`, 20);
}

// ---------------------------------------------------------------------------
// 5. Resource reservation reducer
// ---------------------------------------------------------------------------

export type ReservationStatus = 'active' | 'consumed' | 'released' | 'expired';

export type ReservationRequest = {
  readonly requestId: string;
  readonly planId: string;
  readonly resourceId: string;
  readonly residentId: string;
  /** Positive safe integer. */
  readonly quantity: number;
  /** Must equal the committed minute at which the grant is applied. */
  readonly grantedMinute: number;
  /** Strictly after grantedMinute; the reservation no longer holds at this minute. */
  readonly expiryMinute: number;
  /** Strictly increasing per ledger; the authoritative replay guard. */
  readonly sequence: number;
};

export type ReservationRecord = ReservationRequest & {
  readonly status: ReservationStatus;
  readonly terminalMinute: number | null;
  /** Ledger event ordinal assigned when the record left the active set. */
  readonly terminalSequence: number | null;
};

export type ReservationLedger = {
  readonly version: 1;
  readonly resourceId: string;
  /** Physical committed stock, non-negative safe integer. Only consumption reduces it. */
  readonly stock: number;
  /** Last committed minute this ledger was reduced at. Never regresses. */
  readonly committedMinute: number;
  /** Highest request sequence ever granted (or idempotently observed). */
  readonly lastRequestSequence: number;
  /** Count of state transitions; orders terminal retention. */
  readonly eventSequence: number;
  /** Sorted by sequence asc. Every record status === 'active' and expiryMinute > committedMinute. */
  readonly active: readonly ReservationRecord[];
  /** Sorted by terminalSequence asc. Bounded retention of consumed/released/expired records. */
  readonly terminal: readonly ReservationRecord[];
};

export type ReservationCommand =
  | { readonly type: 'grant'; readonly request: ReservationRequest }
  | { readonly type: 'consume'; readonly requestId: string }
  | { readonly type: 'release'; readonly requestId: string }
  /** Advances the committed minute only (sweeps expiries). */
  | { readonly type: 'advance' };

export type ReservationEffect =
  | { readonly type: 'granted'; readonly requestId: string; readonly quantity: number; readonly minute: number }
  | { readonly type: 'consumed'; readonly requestId: string; readonly quantity: number; readonly stockBefore: number; readonly stockAfter: number; readonly minute: number }
  | { readonly type: 'released'; readonly requestId: string; readonly quantity: number; readonly minute: number }
  | { readonly type: 'expired'; readonly requestId: string; readonly quantity: number; readonly minute: number }
  | { readonly type: 'retention-evicted'; readonly requestId: string; readonly status: ReservationStatus };

export type ReservationOutcome = {
  readonly before: ReservationLedger;
  readonly after: ReservationLedger;
  readonly effects: readonly ReservationEffect[];
  /** True when the command was a matching duplicate and caused no transition (expiry sweeps may still occur). */
  readonly idempotent: boolean;
  /** Stock minus active reservations after the command. */
  readonly available: number;
};

const REQUEST_KEYS = ['requestId', 'planId', 'resourceId', 'residentId', 'quantity', 'grantedMinute', 'expiryMinute', 'sequence'] as const;
const RECORD_KEYS = [...REQUEST_KEYS, 'status', 'terminalMinute', 'terminalSequence'] as const;
const LEDGER_KEYS = ['version', 'resourceId', 'stock', 'committedMinute', 'lastRequestSequence', 'eventSequence', 'active', 'terminal'] as const;

export function validateReservationRequest(value: unknown): Result<ReservationRequest> {
  if (!isPlainObject(value)) return reject('INVALID_SHAPE', 'request must be a plain object');
  const keyError = exactKeys(value, REQUEST_KEYS, 'request');
  if (keyError) return reject('INVALID_SHAPE', keyError);
  for (const field of ['requestId', 'planId', 'resourceId', 'residentId'] as const) {
    if (!isValidId(value[field])) return reject('INVALID_ID', `request.${field} is not a valid identifier`);
  }
  if (!isPositiveSafeInteger(value.quantity)) return reject('INVALID_VALUE', 'request.quantity must be a positive safe integer');
  if (!isMinute(value.grantedMinute)) return reject('INVALID_MINUTE', 'request.grantedMinute must be a non-negative safe integer');
  if (!isMinute(value.expiryMinute)) return reject('INVALID_MINUTE', 'request.expiryMinute must be a non-negative safe integer');
  if (value.expiryMinute <= value.grantedMinute) return reject('INVALID_MINUTE', 'request.expiryMinute must be after grantedMinute');
  if (!isPositiveSafeInteger(value.sequence)) return reject('INVALID_VALUE', 'request.sequence must be a positive safe integer');
  return accept({
    requestId: value.requestId as string,
    planId: value.planId as string,
    resourceId: value.resourceId as string,
    residentId: value.residentId as string,
    quantity: value.quantity,
    grantedMinute: value.grantedMinute,
    expiryMinute: value.expiryMinute,
    sequence: value.sequence,
  });
}

function requestOf(record: ReservationRecord): ReservationRequest {
  return {
    requestId: record.requestId,
    planId: record.planId,
    resourceId: record.resourceId,
    residentId: record.residentId,
    quantity: record.quantity,
    grantedMinute: record.grantedMinute,
    expiryMinute: record.expiryMinute,
    sequence: record.sequence,
  };
}

function validateRecord(value: unknown, label: string): Result<ReservationRecord> {
  if (!isPlainObject(value)) return reject('CORRUPT_STATE', `${label} must be a plain object`);
  const keyError = exactKeys(value, RECORD_KEYS, label);
  if (keyError) return reject('CORRUPT_STATE', keyError);
  const { status, terminalMinute, terminalSequence, ...request } = value;
  const checked = validateReservationRequest(request);
  if (!checked.ok) return reject('CORRUPT_STATE', `${label}: ${checked.reason}`);
  if (status !== 'active' && status !== 'consumed' && status !== 'released' && status !== 'expired') {
    return reject('CORRUPT_STATE', `${label}.status is invalid`);
  }
  if (status === 'active') {
    if (terminalMinute !== null || terminalSequence !== null) return reject('CORRUPT_STATE', `${label} is active but has terminal fields`);
  } else {
    if (!isMinute(terminalMinute)) return reject('CORRUPT_STATE', `${label}.terminalMinute must be a minute`);
    if (!isPositiveSafeInteger(terminalSequence)) return reject('CORRUPT_STATE', `${label}.terminalSequence must be a positive safe integer`);
  }
  return accept({ ...checked.value, status, terminalMinute: terminalMinute as number | null, terminalSequence: terminalSequence as number | null });
}

export function checkLedgerInvariants(value: unknown): string[] {
  if (!isPlainObject(value)) return ['ledger must be a plain object'];
  const keyError = exactKeys(value, LEDGER_KEYS, 'ledger');
  if (keyError) return [keyError];
  const problems: string[] = [];
  if (value.version !== 1) problems.push('ledger.version must be 1');
  if (!isValidId(value.resourceId)) problems.push('ledger.resourceId is not a valid identifier');
  if (!isNonNegativeSafeInteger(value.stock)) problems.push('ledger.stock must be a non-negative safe integer');
  if (!isMinute(value.committedMinute)) problems.push('ledger.committedMinute must be a minute');
  if (!isNonNegativeSafeInteger(value.lastRequestSequence)) problems.push('ledger.lastRequestSequence must be a non-negative safe integer');
  if (!isNonNegativeSafeInteger(value.eventSequence)) problems.push('ledger.eventSequence must be a non-negative safe integer');
  if (!Array.isArray(value.active) || !Array.isArray(value.terminal)) return [...problems, 'ledger.active and ledger.terminal must be arrays'];
  if (problems.length > 0) return problems;

  const ids = new Set<string>();
  const sequences = new Set<number>();
  const activeQuantities: number[] = [];
  let previousSeq = 0;
  (value.active as unknown[]).forEach((raw, i) => {
    const checked = validateRecord(raw, `active[${i}]`);
    if (!checked.ok) {
      problems.push(checked.reason);
      return;
    }
    const rec = checked.value;
    if (rec.status !== 'active') problems.push(`active[${i}] has status ${rec.status}`);
    if (rec.resourceId !== value.resourceId) problems.push(`active[${i}] is for another resource`);
    if (rec.expiryMinute <= (value.committedMinute as number)) problems.push(`active[${i}] expired at ${rec.expiryMinute} but was not swept`);
    if (ids.has(rec.requestId)) problems.push(`active[${i}] duplicates requestId "${rec.requestId}"`);
    ids.add(rec.requestId);
    if (sequences.has(rec.sequence)) problems.push(`active[${i}] duplicates sequence ${rec.sequence}`);
    sequences.add(rec.sequence);
    if (rec.sequence <= previousSeq) problems.push(`active[${i}] breaks sequence ordering`);
    previousSeq = rec.sequence;
    if (rec.sequence > (value.lastRequestSequence as number)) problems.push(`active[${i}] sequence exceeds lastRequestSequence`);
    activeQuantities.push(rec.quantity);
  });
  if ((value.active as unknown[]).length > LIMITS.MAX_ACTIVE_RESERVATIONS) problems.push(`more than ${LIMITS.MAX_ACTIVE_RESERVATIONS} active reservations`);
  let previousTerminal = 0;
  (value.terminal as unknown[]).forEach((raw, i) => {
    const checked = validateRecord(raw, `terminal[${i}]`);
    if (!checked.ok) {
      problems.push(checked.reason);
      return;
    }
    const rec = checked.value;
    if (rec.status === 'active') problems.push(`terminal[${i}] has status active`);
    if (rec.resourceId !== value.resourceId) problems.push(`terminal[${i}] is for another resource`);
    if (ids.has(rec.requestId)) problems.push(`terminal[${i}] duplicates requestId "${rec.requestId}"`);
    ids.add(rec.requestId);
    if (sequences.has(rec.sequence)) problems.push(`terminal[${i}] duplicates sequence ${rec.sequence}`);
    sequences.add(rec.sequence);
    if (rec.sequence > (value.lastRequestSequence as number)) problems.push(`terminal[${i}] sequence exceeds lastRequestSequence`);
    const ts = rec.terminalSequence as number;
    if (ts <= previousTerminal) problems.push(`terminal[${i}] breaks terminalSequence ordering`);
    previousTerminal = ts;
    if (ts > (value.eventSequence as number)) problems.push(`terminal[${i}] terminalSequence exceeds eventSequence`);
  });
  if ((value.terminal as unknown[]).length > LIMITS.MAX_TERMINAL_RESERVATIONS) problems.push(`more than ${LIMITS.MAX_TERMINAL_RESERVATIONS} terminal reservations retained`);
  const reserved = sumSafe(activeQuantities);
  if (reserved === null) problems.push('active quantities overflow safe integer range');
  else if (reserved > (value.stock as number)) problems.push(`active reservations (${reserved}) exceed stock (${value.stock})`);
  return problems;
}

export function validateReservationLedger(value: unknown): Result<ReservationLedger> {
  const problems = checkLedgerInvariants(value);
  if (problems.length > 0) return reject('CORRUPT_STATE', problems.join('; '));
  return accept(deepClone(value as ReservationLedger));
}

export function createReservationLedger(resourceId: unknown, stock: unknown, committedMinute: unknown): Result<ReservationLedger> {
  if (!isValidId(resourceId)) return reject('INVALID_ID', 'resourceId is not a valid identifier');
  if (!isNonNegativeSafeInteger(stock)) return reject('INVALID_VALUE', 'stock must be a non-negative safe integer');
  if (!isMinute(committedMinute)) return reject('INVALID_MINUTE', 'committedMinute must be a non-negative safe integer');
  return accept({ version: 1, resourceId, stock, committedMinute, lastRequestSequence: 0, eventSequence: 0, active: [], terminal: [] });
}

/** Stock minus quantities held by active reservations (the ledger is assumed swept). */
export function availableStock(ledger: ReservationLedger): number {
  const reserved = sumSafe(ledger.active.map((r) => r.quantity));
  return reserved === null ? 0 : ledger.stock - reserved;
}

type MutableLedger = {
  version: 1;
  resourceId: string;
  stock: number;
  committedMinute: number;
  lastRequestSequence: number;
  eventSequence: number;
  active: ReservationRecord[];
  terminal: ReservationRecord[];
};

function retire(ledger: MutableLedger, record: ReservationRecord, status: ReservationStatus, terminalMinute: number): void {
  ledger.eventSequence += 1;
  ledger.active = ledger.active.filter((r) => r.requestId !== record.requestId);
  ledger.terminal.push({ ...record, status, terminalMinute, terminalSequence: ledger.eventSequence });
}

function trimRetention(ledger: MutableLedger, effects: ReservationEffect[]): void {
  while (ledger.terminal.length > LIMITS.MAX_TERMINAL_RESERVATIONS) {
    const oldest = ledger.terminal.shift() as ReservationRecord;
    effects.push({ type: 'retention-evicted', requestId: oldest.requestId, status: oldest.status });
  }
}

/**
 * Pure reducer over an isolated reservation ledger for ONE resource.
 *
 * Replay/dedup guarantees:
 *  - Grants require request.sequence > ledger.lastRequestSequence. A request
 *    whose record has aged out of terminal retention therefore cannot be
 *    re-granted (STALE_SEQUENCE), so retention limits never enable replayed
 *    consumption. A retained matching duplicate is idempotent (no transition).
 *  - Consume/release act only on active records; a retained consumed record
 *    makes a second consume idempotent, an evicted one is UNKNOWN_RESERVATION.
 *    Either way stock is reduced at most once per request.
 *  - Expiry is swept first at every reduction: a reservation whose
 *    expiryMinute <= committedMinute no longer holds stock and cannot be consumed.
 */
export function reduceReservation(ledger: unknown, command: unknown, committedMinute: unknown): Result<ReservationOutcome> {
  const checkedLedger = validateReservationLedger(ledger);
  if (!checkedLedger.ok) return checkedLedger;
  const before = checkedLedger.value;
  if (!isMinute(committedMinute)) return reject('INVALID_MINUTE', 'committedMinute must be a non-negative safe integer');
  if (committedMinute < before.committedMinute) {
    return reject('MINUTE_REGRESSION', `committed minute ${committedMinute} is before ledger minute ${before.committedMinute}`);
  }
  if (!isPlainObject(command)) return reject('INVALID_SHAPE', 'command must be a plain object');
  const type = command.type;
  if (type === 'advance') {
    const keyError = exactKeys(command, ['type'], 'command');
    if (keyError) return reject('INVALID_SHAPE', keyError);
  } else if (type === 'grant') {
    const keyError = exactKeys(command, ['type', 'request'], 'command');
    if (keyError) return reject('INVALID_SHAPE', keyError);
  } else if (type === 'consume' || type === 'release') {
    const keyError = exactKeys(command, ['type', 'requestId'], 'command');
    if (keyError) return reject('INVALID_SHAPE', keyError);
    if (!isValidId(command.requestId)) return reject('INVALID_ID', 'command.requestId is not a valid identifier');
  } else {
    return reject('INVALID_SHAPE', 'command.type must be grant, consume, release or advance');
  }
  // Validate the grant request fully before touching the working copy so failures are atomic.
  let request: ReservationRequest | null = null;
  if (type === 'grant') {
    const checked = validateReservationRequest(command.request);
    if (!checked.ok) return checked;
    request = checked.value;
    if (request.resourceId !== before.resourceId) {
      return reject('RESOURCE_MISMATCH', `request is for "${request.resourceId}", ledger is for "${before.resourceId}"`);
    }
  }

  const working: MutableLedger = { ...deepClone(before), active: [...before.active], terminal: [...before.terminal] };
  const effects: ReservationEffect[] = [];
  working.committedMinute = committedMinute;
  // Sweep expiries deterministically (expiry asc, id asc) — a reservation no longer holds at its expiry minute.
  const expired = working.active
    .filter((r) => r.expiryMinute <= committedMinute)
    .sort((a, b) => (a.expiryMinute !== b.expiryMinute ? a.expiryMinute - b.expiryMinute : compareIds(a.requestId, b.requestId)));
  for (const rec of expired) {
    retire(working, rec, 'expired', rec.expiryMinute);
    effects.push({ type: 'expired', requestId: rec.requestId, quantity: rec.quantity, minute: rec.expiryMinute });
  }

  let idempotent = false;
  const findRecord = (id: string): ReservationRecord | undefined =>
    working.active.find((r) => r.requestId === id) ?? working.terminal.find((r) => r.requestId === id);

  if (type === 'grant' && request) {
    const existing = findRecord(request.requestId);
    if (existing) {
      if (!deepEqual(requestOf(existing), request)) {
        return reject('CONFLICTING_DUPLICATE', `request "${request.requestId}" already exists with different content`);
      }
      idempotent = true;
    } else {
      if (request.grantedMinute !== committedMinute) {
        return reject('GRANT_MINUTE_MISMATCH', `request.grantedMinute ${request.grantedMinute} must equal committed minute ${committedMinute}`);
      }
      if (request.sequence <= working.lastRequestSequence) {
        return reject('STALE_SEQUENCE', `request.sequence ${request.sequence} is not above ledger sequence ${working.lastRequestSequence}`);
      }
      if (working.active.length >= LIMITS.MAX_ACTIVE_RESERVATIONS) {
        return reject('ACTIVE_LIMIT', `at most ${LIMITS.MAX_ACTIVE_RESERVATIONS} reservations may be active`);
      }
      const reserved = sumSafe(working.active.map((r) => r.quantity));
      if (reserved === null) return reject('UNSAFE_ARITHMETIC', 'active quantities overflow safe integer range');
      const available = working.stock - reserved;
      if (request.quantity > available) {
        return reject('INSUFFICIENT_STOCK', `requested ${request.quantity}, only ${available} of ${working.stock} available`);
      }
      working.lastRequestSequence = request.sequence;
      working.eventSequence += 1;
      working.active = [...working.active, { ...request, status: 'active', terminalMinute: null, terminalSequence: null }];
      effects.push({ type: 'granted', requestId: request.requestId, quantity: request.quantity, minute: committedMinute });
    }
  } else if (type === 'consume') {
    const id = command.requestId as string;
    const existing = findRecord(id);
    if (!existing) return reject('UNKNOWN_RESERVATION', `no retained reservation "${id}"`);
    if (existing.status === 'consumed') {
      idempotent = true;
    } else if (existing.status === 'expired') {
      return reject('RESERVATION_EXPIRED', `reservation "${id}" expired at minute ${existing.expiryMinute}`);
    } else if (existing.status === 'released') {
      return reject('NOT_ACTIVE', `reservation "${id}" was released and cannot be consumed`);
    } else {
      const stockBefore = working.stock;
      const stockAfter = stockBefore - existing.quantity;
      if (!isNonNegativeSafeInteger(stockAfter)) return reject('UNSAFE_ARITHMETIC', 'consumption would drive stock negative');
      working.stock = stockAfter;
      retire(working, existing, 'consumed', committedMinute);
      effects.push({ type: 'consumed', requestId: id, quantity: existing.quantity, stockBefore, stockAfter, minute: committedMinute });
    }
  } else if (type === 'release') {
    const id = command.requestId as string;
    const existing = findRecord(id);
    if (!existing) return reject('UNKNOWN_RESERVATION', `no retained reservation "${id}"`);
    if (existing.status === 'consumed') {
      return reject('ALREADY_CONSUMED', `reservation "${id}" was consumed; consumed stock cannot be released`);
    }
    if (existing.status === 'released' || existing.status === 'expired') {
      idempotent = true;
    } else {
      retire(working, existing, 'released', committedMinute);
      effects.push({ type: 'released', requestId: id, quantity: existing.quantity, minute: committedMinute });
    }
  } else {
    idempotent = effects.length === 0;
  }

  trimRetention(working, effects);
  const after: ReservationLedger = { ...working, active: working.active, terminal: working.terminal };
  const problems = checkLedgerInvariants(after);
  if (problems.length > 0) return reject('CORRUPT_STATE', `reducer produced an invalid ledger: ${problems.join('; ')}`);
  return accept({ before, after, effects, idempotent, available: availableStock(after) });
}
