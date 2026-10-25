import {PrefixRawHasher,assertPrefixProvenance,loadRootPrefixReceipt,prefixRuntime,publishRootPrefixReceipt,requireRootPublisher,typedRowsDigest,type PrefixProofOptions,type PrefixProofReceipt,type PrefixProvenance,type PrefixVerification,type RawPrefix} from '../demo/private-prefix-unavailable.js';
import { validateNewMethodAdmissions, validateMethodHashes, validateLearnerHashes } from '../demo/admission-policy.js';
import { createDiscoveryLedger, observeCommittedMinute, validateInventionEvent, validateInventionMinute, validateTransitCommissioning, validateTransitMinute, transitLandings, validateWardrobeMinute } from '@meridian/world-kernel';
import type { VerifiedPublicObservation } from '../public-world-projection.js';
import { PublicWorldStore, PublicProjectionUnavailableError, type PublicFeedCapture, type PublicFeedCaptureLimits } from './public-world-store.js';
import type { PublicEvent, PublicSnapshot } from '@meridian/world-schema';
import { slowTimer } from "../slow-log.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import { insertClockMetadata, readClockEpoch } from "./clock-metadata.js";

import {
  GENESIS_HASH,
  canonicalJson,
  verifyLedger,
  type LedgerEntry,
} from "@meridian/world-ledger";
import {
  AI_DECISION_HISTORY_MAX_LIMIT,
  WorldEventSchema,
  assertOriginalPresentations,
  parseWorldSnapshot,
  type AiDecisionRow,
  type WorldEvent,
  type WorldSnapshot,
  type WorldState,
} from "@meridian/world-schema";

export interface LedgerRow {
  sequence: unknown;
  previous_hash: unknown;
  hash: unknown;
  event_json: unknown;
}

interface SnapshotRow {
  sequence: unknown;
  state_json: unknown;
  state_hash: unknown;
}

export class WorldIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorldIntegrityError";
  }
}

export class EmptyWorldStoreError extends WorldIntegrityError {
  constructor() {
    super("world store is empty");
    this.name = "EmptyWorldStoreError";
  }
}

/**
 * A cursor a client asked to resume from cannot be served: out of range, or so far behind that
 * replaying it would be unbounded work. Distinct from WorldIntegrityError on purpose, because
 * client input must never be mistaken for a damaged ledger.
 */
export class LedgerCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCursorError";
  }
}

function integrityError(message: string, cause?: unknown): WorldIntegrityError {
  return new WorldIntegrityError(message, cause === undefined ? undefined : { cause });
}

function isAcceptedModelDecision(event: WorldEvent): boolean {
  return event.type === "resident-action-resolved" && event.source === "local-model" && event.outcome === "accepted";
}

/**
 * The derived AI-decision index is missing or behind the verified head (a file written without it,
 * or a rebuild that could not run). History is refused rather than served by scanning the ledger.
 * Not a WorldIntegrityError: the ledger itself is fine.
 */
export class AiDecisionIndexUnavailableError extends Error {
  constructor() {
    super("AI decision index is not complete at the verified head");
    this.name = "AiDecisionIndexUnavailableError";
  }
}

/** Every query aiDecisionHistory runs against the derived index (exported so tests can EXPLAIN them). */
export const AI_DECISION_HISTORY_SQL = {
  indexedThrough: "SELECT value FROM ai_index_meta WHERE key = 'indexedThrough'",
  count: "SELECT COUNT(*) AS total FROM ai_decisions WHERE sequence <= ?",
  page: "SELECT sequence, resident_id, minute, option_id, kind, label FROM ai_decisions WHERE sequence <= ? ORDER BY sequence DESC LIMIT ?",
} as const;

/**
 * Snapshot retention. Snapshots are checkpoints (the hash-chained ledger is the record), so a store
 * keeps: genesis (sequence 0), the newest SNAPSHOT_KEEP_NEWEST, and for each 60-world-minute hour
 * (floor(state.canonicalMinute / 60)) the first snapshot (lowest sequence) of that hour. The
 * snapshot the verified cache points at is never deleted.
 */
export const SNAPSHOT_KEEP_NEWEST = 60;
export const SNAPSHOT_HOUR_MINUTES = 60;
/**
 * A snapshot's world minute for the release-time pruneSnapshots only: the stored column, or (rows
 * written before the column existed) one json_extract of that row. The per-commit prune never uses
 * it: it reads the column alone, so rows written before retention (NULL) are never deleted there.
 */
const SNAPSHOT_MINUTE = "COALESCE(canonical_minute, json_extract(state_json, '$.state.canonicalMinute'))";

/**
 * The per-commit prune: only the snapshot that just left the newest window is considered, and it is
 * deleted unless it is genesis or the first of its world hour. World minutes never decrease with
 * sequence and first-of-hour rows are never pruned, so "first of its hour" is exactly "its nearest
 * older snapshot is in an earlier hour". Every statement is a primary-key lookup or a bounded
 * primary-key range (exported so tests can EXPLAIN them). Only the stored canonical_minute is read:
 * a row written before retention (NULL minute), or one whose older neighbour is, is kept, so
 * pre-release checkpoints are only ever removed by the gated pruneSnapshots.
 */
export const SNAPSHOT_RETENTION_SQL = {
  leavingWindow: `SELECT sequence, canonical_minute AS minute FROM snapshots WHERE sequence < ? ORDER BY sequence DESC LIMIT 1 OFFSET ${SNAPSHOT_KEEP_NEWEST - 1}`,
  previous: `SELECT canonical_minute AS minute FROM snapshots WHERE sequence < ? ORDER BY sequence DESC LIMIT 1`,
  remove: "DELETE FROM snapshots WHERE sequence = ?",
} as const;

/**
 * The fields of a ledger event the AI-decision index reads: either a schema-parsed WorldEvent
 * (commit path) or the raw JSON of a canonical ledger row (rebuild path).
 */
interface IndexableEvent {
  type?: unknown;
  source?: unknown;
  outcome?: unknown;
  residentId?: unknown;
  minute?: unknown;
  optionId?: unknown;
  after?: unknown;
}

/** The task fields of a resident-life-changed `after` profile, or undefined when it has no task. */
function indexedTask(after: unknown): { decisionSource?: unknown; kind?: unknown; label?: unknown } | undefined {
  if (typeof after !== "object" || after === null || !("task" in after)) return undefined;
  const task = after.task;
  return typeof task === "object" && task !== null ? task : undefined;
}

function hashStateJson(stateJson: string): string {
  return createHash("sha256").update(stateJson).digest("hex");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw integrityError(`invalid ${field}`);
  return value;
}

function requireSequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw integrityError(`invalid ${field}`);
  }
  return value;
}

/**
 * Ledger events at rest (14 Oct 2026). New rows store the canonical event JSON zlib-compressed, as a BLOB in
 * the same column; rows written earlier are TEXT, and the offline converter (scripts/compress-ledger.mjs)
 * rewrites them. Both decode to the identical canonical text, which parsing still checks byte for byte, so
 * hashes, replay and every reader are unchanged. The canonical event was ~80% resident profiles repeated
 * before and after; at rest it shrinks about six times.
 */
export function encodeLedgerEvent(json: string): Uint8Array {
  return deflateSync(Buffer.from(json, "utf8"), { level: 6 });
}

export function decodeLedgerEvent(value: unknown, field = "ledger event JSON"): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return inflateSync(value).toString("utf8");
    } catch (error) {
      throw integrityError(`invalid ${field}`, error);
    }
  }
  throw integrityError(`invalid ${field}`);
}

/** Bytes a row's event will occupy once decoded, for the verification window's memory bound. */
function decodedLedgerBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  // zlib keeps the canonical JSON roughly six times smaller; budget generously rather than inflate twice.
  return value instanceof Uint8Array ? value.byteLength * 8 : 0;
}

function parseLedgerRows(rows: readonly LedgerRow[]): LedgerEntry[] {
  return rows.map((row) => {
    const sequence = requireSequence(row.sequence, "ledger sequence");
    if (sequence === 0) throw integrityError("ledger sequence must be positive");
    const eventJson = decodeLedgerEvent(row.event_json);

    try {
      const event = WorldEventSchema.parse(JSON.parse(eventJson));
      if (canonicalJson(event) !== eventJson) {
        throw integrityError(`ledger event ${sequence} is not canonically encoded`);
      }
      return {
        sequence,
        previousHash: requireString(row.previous_hash, "ledger previous hash"),
        hash: requireString(row.hash, "ledger hash"),
        event,
      };
    } catch (error) {
      if (error instanceof WorldIntegrityError) throw error;
      throw integrityError(`invalid ledger event at sequence ${sequence}`, error);
    }
  });
}

function parseInputEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  try {
    return entries.map((entry) => ({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      hash: entry.hash,
      event: WorldEventSchema.parse(entry.event),
    }));
  } catch (error) {
    throw integrityError("invalid ledger entry input", error);
  }
}

/** Entries verified per window. Bounds peak memory during verification; the guarantee is unchanged. */
export const LEDGER_VERIFY_WINDOW = 2_000;
/**
 * Second bound on a window, in UTF-8 bytes, because rows vary in size: a few large events must not
 * defeat the row cap. A single row larger than this is still verified on its own.
 */
export const LEDGER_VERIFY_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * Verifies a hash chain from a row stream in bounded windows instead of materialising every
 * event. Each window is checked by the same verifier, anchored to the previous window's hash,
 * and window boundaries additionally require consecutive sequences, so a skipped, reordered or
 * rewritten entry fails exactly as it does for a single array. Peak memory is one window.
 */
export function verifyLedgerRowStream(
  rows: Iterable<LedgerRow>,
  options: { baseHash?: string | undefined; window?: number; windowBytes?: number } = {},
): { last: LedgerEntry | undefined; count: number } {
  const window = options.window ?? LEDGER_VERIFY_WINDOW;
  const windowBytes = options.windowBytes ?? LEDGER_VERIFY_WINDOW_BYTES;
  if (!Number.isSafeInteger(window) || window < 1) throw integrityError("ledger verification window must be a positive integer");
  if (!Number.isSafeInteger(windowBytes) || windowBytes < 1) throw integrityError("ledger verification byte budget must be a positive integer");
  let anchor = options.baseHash;
  let last: LedgerEntry | undefined;
  let count = 0;
  let buffer: LedgerRow[] = [];
  let bufferedBytes = 0;
  const flush = (): void => {
    if (buffer.length === 0) return;
    bufferedBytes = 0;
    const entries = parseLedgerRows(buffer);
    buffer = [];
    const first = entries[0]!;
    if (last !== undefined && first.sequence !== last.sequence + 1) {
      throw integrityError(`ledger verification failed at sequence ${first.sequence}: missing sequence`);
    }
    // The first window keeps the caller's semantics: no base hash means from genesis at sequence 1.
    if (anchor === undefined) failUnlessLedgerVerifies(entries);
    else failUnlessLedgerVerifies(entries, anchor);
    last = entries.at(-1)!;
    anchor = last.hash;
    count += entries.length;
  };
  for (const row of rows) {
    const rowBytes = decodedLedgerBytes(row.event_json);
    if (buffer.length > 0 && bufferedBytes + rowBytes > windowBytes) flush();
    buffer.push(row);
    bufferedBytes += rowBytes;
    if (buffer.length >= window) flush();
  }
  flush();
  return { last, count };
}

function failUnlessLedgerVerifies(entries: readonly LedgerEntry[], baseHash?: string): void {
  const result = baseHash === undefined ? verifyLedger(entries) : verifyLedger(entries, baseHash);
  if (!result.ok) {
    throw integrityError(
      `ledger verification failed at sequence ${result.sequence}: ${result.reason}`,
    );
  }
}

function applyWorldEvent(state: WorldState, event: WorldEvent): void {
  switch (event.type) {
    case "invention-enabled":
    case "invention-method-changed":
    case "invention-site-changed":
    case "invention-agenda-changed":
    case "invention-consultation-changed":
    case "invention-design-changed":
    case "invention-artifact-changed":
    case "invention-trial-changed":
    case "invention-grant-changed":
    case "invention-job-changed":
    case "invention-counters-changed":
    case "invention-command-resolved":
      applyInventionDelta(state, event, false);
      return;
    case "resident-appearances-migrated":
      applyAppearanceMigration(state, event, false);
      return;
    case "civic-projects-migrated":
      applyCivicMigration(state, event, false);
      return;
    case "wardrobe-opened":
      applyWardrobeOpened(state, event, false);
      return;
    case "family-formed":
      applyFamilyFormed(state, event, false);
      return;
    case "resident-life-changed":
    case "life-resource-changed":
    case "life-project-changed":
    case "life-commitment-changed":
      applyLifeDelta(state, event, false);
      return;
    case "life-chart-changed":
      applyChartDelta(state, event, false);
      return;
    case "life-frontier-changed":
      applyFrontierDelta(state, event, false);
      return;
    case "frontier-opened":
      applyFrontierOpened(state, event, false);
      return;
    case "frontier-access-enabled":
      applyFrontierAccessEnabled(state, event, false);
      return;
    case "place-founded":
      applyPlaceFounded(state, event, false);
      return;
    case "resident-moved-home":
      applyResidentMovedHome(state, event, false);
      return;
    case "resident-action-resolved":
      if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("action resolution minute mismatch");
      return;
    case "venture-changed":
    case "venture-resource-changed":
    case "venture-counters-changed":
      applyVentureDelta(state, event, false);
      return;
    case "transit-commissioned":
      applyTransitCommissioned(state, event, false);
      return;
    case "transit-changed":
      applyTransitDelta(state, event, false);
      return;
    case "clock-advanced":
      if (
        event.fromMinute !== state.canonicalMinute ||
        event.toMinute !== event.fromMinute + 1 ||
        event.minute !== event.toMinute
      ) {
        throw integrityError(`clock replay mismatch at minute ${event.minute}`);
      }
      state.canonicalMinute = event.toMinute;
      return;
    case "resident-activity-changed": {
      const resident = state.residents[event.residentId];
      if (
        event.minute !== state.canonicalMinute + 1 ||
        resident === undefined ||
        resident.activity !== event.fromActivity
      ) {
        throw integrityError(`resident activity replay mismatch for ${event.residentId}`);
      }
      resident.activity = event.toActivity;
      return;
    }
    case "resident-location-changed": {
      const resident = state.residents[event.residentId];
      if (
        event.minute !== state.canonicalMinute + 1 ||
        resident === undefined ||
        resident.placeId !== event.fromPlaceId
      ) {
        throw integrityError(`resident location replay mismatch for ${event.residentId}`);
      }
      resident.placeId = event.toPlaceId;
      return;
    }
    case "construction-stage-progressed":
      if (
        event.minute !== state.canonicalMinute + 1 ||
        state.construction.id !== event.constructionId ||
        state.construction.stage !== event.fromStage
      ) {
        throw integrityError(`construction replay mismatch for ${event.constructionId}`);
      }
      state.construction.stage = event.toStage;
      return;
    default: {
      // Every event type must replay. An unlisted type would otherwise be skipped silently, the
      // replayed world would stop matching the committed snapshot, and the clock would halt.
      const unhandled: never = event;
      throw integrityError(`no replay rule for event ${(unhandled as WorldEvent).type}`);
    }
  }
}

type AppearanceMigration = Extract<WorldEvent, { type: "resident-appearances-migrated" }>;

/** Replays the one-time zero-minute migration without changing the world clock. */
function applyAppearanceMigration(state: WorldState, event: AppearanceMigration, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute) throw integrityError("appearance migration minute mismatch");
  for (const [residentId, appearance] of Object.entries(event.assignments)) {
    const profile = state.life.residents[residentId];
    if (!profile) throw integrityError(`appearance migration unknown resident ${residentId}`);
    if (!reverse) {
      if (profile.appearance !== undefined) throw integrityError(`appearance migration already assigned ${residentId}`);
      profile.appearance = structuredClone(appearance);
      continue;
    }
    if (canonicalJson(profile.appearance) !== canonicalJson(appearance)) throw integrityError(`appearance migration reversal mismatch for ${residentId}`);
    delete profile.appearance;
  }
}

type CivicMigration = Extract<WorldEvent, { type: "civic-projects-migrated" }>;

/** Replays (or reverses) the one-time zero-minute civic project migration without changing the world clock. */
function applyCivicMigration(state: WorldState, event: CivicMigration, reverse: boolean): void {
  if (!state.life || state.engineVersion !== "city-life-2" || event.minute !== state.canonicalMinute) throw integrityError("civic migration minute mismatch");
  for (const [projectId, project] of Object.entries(event.projects)) {
    const current = Object.hasOwn(state.life.projects, projectId) ? state.life.projects[projectId] : undefined;
    if (!reverse) {
      if (current !== undefined) throw integrityError(`civic migration project already exists ${projectId}`);
      state.life.projects[projectId] = structuredClone(project);
      continue;
    }
    if (canonicalJson(current) !== canonicalJson(project)) throw integrityError(`civic migration reversal mismatch for ${projectId}`);
    delete state.life.projects[projectId];
  }
}

type WardrobeOpened = Extract<WorldEvent, { type: "wardrobe-opened" }>;

/** Replays (or reverses) the one-time zero-minute wardrobe cutover without changing the world clock. */
function applyWardrobeOpened(state: WorldState, event: WardrobeOpened, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute) throw integrityError("wardrobe opening minute mismatch");
  if (!reverse) {
    if (state.life.wardrobe !== undefined) throw integrityError("wardrobe already opened");
    if (event.wardrobe.originals) {
      try { assertOriginalPresentations(state.residents, event.wardrobe.originals); }
      catch (error) { throw integrityError("wardrobe original presentation mismatch", error); }
    }
    state.life.wardrobe = structuredClone(event.wardrobe);
    return;
  }
  if (canonicalJson(state.life.wardrobe) !== canonicalJson(event.wardrobe)) throw integrityError("wardrobe opening reversal mismatch");
  delete state.life.wardrobe;
}

type FamilyFormed = Extract<WorldEvent, { type: "family-formed" }>;

/** Replays (or reverses) the one-time family formation without changing the world clock. */
function applyFamilyFormed(state: WorldState, event: FamilyFormed, reverse: boolean): void {
  const life = state.life;
  if (!life || state.engineVersion !== "city-life-2" || event.minute !== state.canonicalMinute) throw integrityError("family formation minute mismatch");
  const apply = <T>(record: Record<string, T>, label: string, entries: Record<string, { before: T | null; after: T }>): void => {
    for (const [id, change] of Object.entries(entries)) {
      const expected = reverse ? change.after : change.before, replacement = reverse ? change.before : change.after;
      const current = Object.hasOwn(record, id) ? record[id] : null;
      if (canonicalJson(current ?? null) !== canonicalJson(expected)) throw integrityError(`family formation ${reverse ? "reversal" : "replay"} mismatch for ${label} ${id}`);
      if (replacement === null) delete record[id]; else record[id] = structuredClone(replacement);
    }
  };
  apply(state.residents, "resident", event.residents);
  apply(state.places, "place", event.places);
  apply(life.residents, "life profile", event.lifeProfiles);
}

type InventionEvent = Extract<WorldEvent, { type: `invention-${string}` }>;
function applyInventionDelta(state: WorldState, raw: WorldEvent, reverse: boolean): void {
  const event = raw as InventionEvent;
  if (event.type === 'invention-enabled') {
    if (event.minute !== state.canonicalMinute || !state.life) throw integrityError('invention enable minute mismatch');
    if (reverse) {
      if (canonicalJson(state.life.invention) !== canonicalJson(event.after)) throw integrityError('invention enable reversal mismatch');
      validateInventionEvent(state, event);
      delete state.life.invention;
    } else {
      if (state.life.invention !== undefined) throw integrityError('invention already enabled');
      validateInventionEvent(state, event);
      state.life.invention = structuredClone(event.after);
    }
    return;
  }
  if (event.minute !== state.canonicalMinute + 1 || !state.life) throw integrityError('invention delta minute mismatch');
  if (event.type === 'invention-command-resolved') {
    if (event.outcome === 'accepted' && (!state.life.invention || !state.residents[event.residentId] || state.residents[event.residentId]!.lifeStage === 'child')) throw integrityError('invention accepted actor mismatch');
    return;
  }
  if (!state.life.invention) throw integrityError('invention absent');
  const invention = state.life.invention;
  if (event.type === 'invention-counters-changed') {
    if (invention.nextSequence !== (reverse ? event.after : event.before) || event.after <= event.before) throw integrityError('invention counter mismatch');
    invention.nextSequence = reverse ? event.before : event.after;
    return;
  }
  const sections = {
    'invention-method-changed': 'methods',
    'invention-site-changed': 'sites',
    'invention-agenda-changed': 'agendas',
    'invention-consultation-changed': 'consultations',
    'invention-design-changed': 'designs',
    'invention-artifact-changed': 'artifacts',
    'invention-trial-changed': 'trials',
    'invention-grant-changed': 'grants',
    'invention-job-changed': 'jobs'
  } as const;
  if(event.type==='invention-method-changed'){validateMethodHashes(event.after);invention.methods??={};}
  if(event.type==='invention-grant-changed')for(const e of event.after.method?.executions??[])validateLearnerHashes(e);
  const record = invention[sections[event.type]] as Record<string, unknown>,
    expected = reverse ? event.after : event.before,
    replacement = reverse ? event.before : event.after;
  if (event.recordId !== event.after.id || canonicalJson(record[event.recordId] ?? null) !== canonicalJson(expected)) throw integrityError('invention previous value mismatch');
  try {
    validateInventionEvent(state, event);
  } catch (error) {
    throw integrityError('invention derivation mismatch', error);
  }
  if (replacement === null) delete record[event.recordId];else record[event.recordId] = structuredClone(replacement);
  if(reverse&&event.type==='invention-method-changed'&&Object.keys(record).length===0)delete invention.methods;
}

type VentureDelta = Extract<WorldEvent, { type: "venture-changed" | "venture-resource-changed" | "venture-counters-changed" }>;
const TERMINAL_VENTURE = new Set(["completed", "failed", "abandoned"]);

/** Replay (or reverse) a venture delta against `life.ventures`, mirroring the kernel's bounded retired list. */
function applyVentureDelta(state: WorldState, event: VentureDelta, reverse: boolean): void {
  const ventures = state.life?.ventures;
  if (!ventures || event.minute !== state.canonicalMinute + 1) throw integrityError("venture replay minute mismatch");
  if (event.type === "venture-counters-changed") {
    const expected = reverse ? event.after : event.before, replacement = reverse ? event.before : event.after;
    if (ventures.nextSequence !== expected.nextSequence || ventures.nextRequestSequence !== expected.nextRequestSequence) throw integrityError("venture counters mismatch");
    ventures.nextSequence = replacement.nextSequence; ventures.nextRequestSequence = replacement.nextRequestSequence;
    return;
  }
  if (event.type === "venture-resource-changed") {
    const expected = reverse ? event.after : event.before, replacement = reverse ? event.before : event.after;
    const current = Object.hasOwn(ventures.resources, event.resourceId) ? ventures.resources[event.resourceId] : null;
    if (canonicalJson(current) !== canonicalJson(expected)) throw integrityError(`venture resource ${reverse ? "reversal" : "replay"} mismatch for ${event.resourceId}`);
    if (replacement === null) delete ventures.resources[event.resourceId]; else ventures.resources[event.resourceId] = structuredClone(replacement);
    return;
  }
  const id = event.ventureId;
  if (!reverse) {
    const current = Object.hasOwn(ventures.projects, id) ? ventures.projects[id] : null;
    if (canonicalJson(current) !== canonicalJson(event.before)) throw integrityError(`venture replay previous value mismatch for ${id}`);
    if (event.after === null) { delete ventures.projects[id]; return; }
    if (event.after.id !== id) throw integrityError(`venture id mismatch for ${id}`);
    if (TERMINAL_VENTURE.has(event.after.status)) {
      if (event.evicted && (ventures.retired.length !== 32 || canonicalJson(ventures.retired[0]) !== canonicalJson(event.evicted))) {
        throw integrityError('venture eviction before-image mismatch');
      }
      delete ventures.projects[id]; ventures.retired = [...ventures.retired, structuredClone(event.after)].slice(-32);
    }
    else ventures.projects[id] = structuredClone(event.after);
    return;
  }
  if (event.after !== null && TERMINAL_VENTURE.has(event.after.status)) {
    const last = ventures.retired.at(-1);
    if (canonicalJson(last) !== canonicalJson(event.after)) throw integrityError(`venture reversal retired mismatch for ${id}`);
    ventures.retired = ventures.retired.slice(0, -1);
    if (event.evicted) {
      if (ventures.retired.length !== 31 || ventures.retired.some(v => v.id === event.evicted!.id) || Object.hasOwn(ventures.projects, event.evicted.id)) {
        throw integrityError('venture eviction reversal mismatch');
      }
      ventures.retired.unshift(structuredClone(event.evicted));
    }
  } else {
    const current = Object.hasOwn(ventures.projects, id) ? ventures.projects[id] : null;
    if (canonicalJson(current) !== canonicalJson(event.after)) throw integrityError(`venture reversal value mismatch for ${id}`);
  }
  if (event.before === null) delete ventures.projects[id]; else ventures.projects[id] = structuredClone(event.before);
}

type LifeDelta = Extract<WorldEvent, { type: "resident-life-changed" | "life-resource-changed" | "life-project-changed" | "life-commitment-changed" }>;

function applyLifeDelta(state: WorldState, event: LifeDelta, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("life replay minute mismatch");
  const expected = reverse ? event.after : event.before;
  const replacement = reverse ? event.before : event.after;
  const [record, id]: [Record<string, unknown>, string] = event.type === "resident-life-changed"
    ? [state.life.residents, event.residentId]
    : event.type === "life-resource-changed" ? [state.life.resources, event.resourceId]
    : event.type === "life-project-changed" ? [state.life.projects, event.projectId]
    : [state.life.commitments, event.commitmentId];
  const current = Object.hasOwn(record, id) ? record[id] : null;
  if (canonicalJson(current) !== canonicalJson(expected)) throw integrityError(`life ${reverse ? "reversal" : "replay"} previous value mismatch for ${id}`);
  if (replacement === null) delete record[id];
  else {
    const entityId = "residentId" in replacement ? replacement.residentId : replacement.id;
    if (entityId !== id) throw integrityError(`life entity id mismatch for ${id}`);
    record[id] = structuredClone(replacement);
  }
}

type FrontierDelta = Extract<WorldEvent, { type: "life-frontier-changed" }>;

/**
 * Frontier parcels (D-8), replayed or reversed like charts: a parcel first appears with a null `before`,
 * and reversing the last parcel removes `life.frontier` entirely so a derived base stays byte-identical.
 */
function applyFrontierDelta(state: WorldState, event: FrontierDelta, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("frontier replay minute mismatch");
  const expected = reverse ? event.after : event.before;
  const replacement = reverse ? event.before : event.after;
  const frontier = state.life.frontier;
  const current = frontier && Object.hasOwn(frontier, event.parcelId) ? frontier[event.parcelId]! : null;
  if (canonicalJson(current) !== canonicalJson(expected)) throw integrityError(`frontier ${reverse ? "reversal" : "replay"} previous value mismatch for ${event.parcelId}`);
  if (replacement === null) {
    if (frontier) {
      delete frontier[event.parcelId];
      if (Object.keys(frontier).length === 0) delete state.life.frontier;
    }
    return;
  }
  if (replacement.id !== event.parcelId) throw integrityError(`frontier parcel mismatch for ${event.parcelId}`);
  state.life.frontier = { ...(frontier ?? {}), [event.parcelId]: structuredClone(replacement) };
}

type ResidentMovedHome = Extract<WorldEvent, { type: "resident-moved-home" }>;

/** A resident's home and the home blocks of their day change together (frontier homes, D-8 slice 3). */
function applyResidentMovedHome(state: WorldState, event: ResidentMovedHome, reverse: boolean): void {
  if (event.minute !== state.canonicalMinute + 1) throw integrityError("home move minute mismatch");
  const resident = Object.hasOwn(state.residents, event.residentId) ? state.residents[event.residentId] : undefined;
  const expected = reverse ? event.after : event.before;
  const replacement = reverse ? event.before : event.after;
  if (!resident || canonicalJson({ homePlaceId: resident.homePlaceId, schedule: resident.schedule }) !== canonicalJson(expected)) throw integrityError(`home move ${reverse ? "reversal" : "replay"} previous value mismatch for ${event.residentId}`);
  if (!Object.hasOwn(state.places, replacement.homePlaceId) || state.places[replacement.homePlaceId]!.kind !== "residence") throw integrityError(`home move to a place that is not a home: ${replacement.homePlaceId}`);
  state.residents[event.residentId] = { ...resident, homePlaceId: replacement.homePlaceId, schedule: structuredClone(replacement.schedule) };
}

type PlaceFounded = Extract<WorldEvent, { type: "place-founded" }>;

/** A place residents built on the frontier appears (or, reversed, disappears while nobody refers to it). */
function applyPlaceFounded(state: WorldState, event: PlaceFounded, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("place founding minute mismatch");
  const current = Object.hasOwn(state.places, event.placeId) ? state.places[event.placeId] : undefined;
  if (!reverse) {
    if (current !== undefined) throw integrityError(`founded place already exists ${event.placeId}`);
    state.places[event.placeId] = structuredClone(event.place);
    return;
  }
  if (canonicalJson(current ?? null) !== canonicalJson(event.place)) throw integrityError(`place founding reversal mismatch for ${event.placeId}`);
  if (Object.values(state.residents).some((r) => r.placeId === event.placeId || r.homePlaceId === event.placeId || r.workPlaceId === event.placeId)) throw integrityError(`founded place still occupied on reversal ${event.placeId}`);
  delete state.places[event.placeId];
}

type FrontierOpened = Extract<WorldEvent, { type: "frontier-opened" }>;

/** Replays (or reverses) the one-time zero-minute opening of the frontier without changing the world clock. */
function applyFrontierOpened(state: WorldState, event: FrontierOpened, reverse: boolean): void {
  if (!state.life || state.engineVersion !== "city-life-2" || event.minute !== state.canonicalMinute) throw integrityError("frontier opening minute mismatch");
  if (!reverse) {
    if (state.life.frontier) throw integrityError("frontier already open");
    state.life.frontier = structuredClone(event.parcels);
    return;
  }
  if (canonicalJson(state.life.frontier ?? null) !== canonicalJson(event.parcels)) throw integrityError("frontier opening reversal mismatch");
  delete state.life.frontier;
}

type FrontierAccessEnabled = Extract<WorldEvent, { type: "frontier-access-enabled" }>;

/** Replays (or reverses) the one-time zero-minute frontier access cutover without changing the world clock. */
function applyFrontierAccessEnabled(state: WorldState, event: FrontierAccessEnabled, reverse: boolean): void {
  if (!state.life || state.engineVersion !== "city-life-2" || event.minute !== state.canonicalMinute) throw integrityError("frontier access minute mismatch");
  if (!reverse) {
    if (state.life.frontierAccess) throw integrityError("frontier access already enabled");
    if (!state.life.frontier) throw integrityError("frontier access requires an open frontier");
    state.life.frontierAccess = structuredClone(event.after);
    return;
  }
  if (canonicalJson(state.life.frontierAccess ?? null) !== canonicalJson(event.after)) throw integrityError("frontier access reversal mismatch");
  delete state.life.frontierAccess;
}

type ChartDelta = Extract<WorldEvent, { type: "life-chart-changed" }>;

/**
 * Surveyed places, replayed or reversed like any other life entity. Charts are absent from a world
 * until its first survey, so reversing that survey removes the key entirely rather than leaving an
 * empty object: a derived base must be byte-identical to the snapshot it was committed from.
 */
function applyChartDelta(state: WorldState, event: ChartDelta, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("chart replay minute mismatch");
  const expected = reverse ? event.after : event.before;
  const replacement = reverse ? event.before : event.after;
  const charts = state.life.charts;
  const current = charts && Object.hasOwn(charts, event.placeId) ? charts[event.placeId]! : null;
  if (canonicalJson(current) !== canonicalJson(expected)) throw integrityError(`chart ${reverse ? "reversal" : "replay"} previous value mismatch for ${event.placeId}`);
  if (replacement === null) {
    if (charts) {
      delete charts[event.placeId];
      if (Object.keys(charts).length === 0) delete state.life.charts;
    }
    return;
  }
  if (replacement.placeId !== event.placeId) throw integrityError(`chart place mismatch for ${event.placeId}`);
  state.life.charts = { ...(charts ?? {}), [event.placeId]: structuredClone(replacement) };
}

type TransitCommissioned = Extract<WorldEvent, { type: "transit-commissioned" }>;
type TransitChanged = Extract<WorldEvent, { type: "transit-changed" }>;

/**
 * Replays (or reverses) the one-time zero-minute commissioning of Meridian Central. Forward replay also requires
 * the event to be exactly what the kernel commissions from the world it lands on; reversing removes
 * `life.transit` so a derived base stays byte-identical.
 */
function applyTransitCommissioned(state: WorldState, event: TransitCommissioned, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute) throw integrityError("transit commissioning minute mismatch");
  if (!reverse) {
    if (state.life.transit) throw integrityError("transit already commissioned");
    try {
      validateTransitCommissioning(state, event);
    } catch (error) {
      throw integrityError("transit commissioning does not match its world", error);
    }
    applyTransitLandings(state, event.landings, false);
    state.life.transit = structuredClone(event.after);
    return;
  }
  if (canonicalJson(state.life.transit ?? null) !== canonicalJson(event.after)) throw integrityError("transit commissioning reversal mismatch");
  applyTransitLandings(state, event.landings, true);
  delete state.life.transit;
}

/** Only transit's derived provisional platforms can add these non-residential anchors. */
function applyTransitLandings(state: WorldState, landings: Extract<WorldEvent, { type: "transit-commissioned" }>["landings"], reverse: boolean): void {
  for (const place of landings ?? []) {
    if (reverse) {
      if (canonicalJson(state.places[place.id] ?? null) !== canonicalJson(place)) throw integrityError("landing reversal mismatch");
      delete state.places[place.id];
    } else {
      if (Object.hasOwn(state.places, place.id)) throw integrityError("landing already exists");
      state.places[place.id] = structuredClone(place);
    }
  }
}

/** A minute's transit change, replayed or reversed by exact before/after; its derivation is checked per minute in replay. */
function applyTransitDelta(state: WorldState, event: TransitChanged, reverse: boolean): void {
  if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("transit replay minute mismatch");
  const expected = reverse ? event.after : event.before;
  if (canonicalJson(state.life.transit ?? null) !== canonicalJson(expected)) throw integrityError(`transit ${reverse ? "reversal" : "replay"} previous value mismatch`);
  if (!reverse && canonicalJson(event.landings ?? []) !== canonicalJson(transitLandings(state, event.after.route))) throw integrityError("transit landing provenance mismatch");
  applyTransitLandings(state, event.landings, reverse);
  state.life.transit = structuredClone(reverse ? event.before : event.after);
}

function replay(snapshot: WorldSnapshot, entries: Iterable<LedgerEntry>, checkpoint?: WorldSnapshot): WorldSnapshot {
  if (Array.isArray(entries) && entries.length === 0) return snapshot;

  const state = structuredClone(snapshot.state);
  let minuteBase = state.life?.invention ? structuredClone(state) : undefined;
  // Transit at the start of the minute: its end-of-minute record must be what the kernel derives (absent: no cost).
  let transitBase = state.life?.transit;
  let minuteEvents: WorldEvent[] = [];
  let lastEntry: LedgerEntry | undefined;
  for (const entry of entries) {
    lastEntry = entry;
    minuteEvents.push(entry.event);
    applyWorldEvent(state, entry.event);
    if (entry.event.type === 'invention-enabled') minuteBase = structuredClone(state);
    if (entry.event.type === 'transit-commissioned') {
      transitBase = state.life?.transit;
      // Add only the validated zero-minute commission to the prior conservation base.
      // Copying current state would absorb any preceding upcoming-minute deltas (including
      // unearned invention allocations) before their clock/conservation check.
      if (minuteBase) applyTransitCommissioned(minuteBase, entry.event, false);
    }
    if (entry.event.type === 'clock-advanced') {
      try {
        if (minuteBase) validateInventionMinute(minuteBase, state, entry.event.minute, minuteEvents);
      } catch (error) {
        throw integrityError('invention minute conservation mismatch', error);
      }
      try {
        validateTransitMinute(transitBase, state, entry.event.minute, minuteEvents);
      } catch (error) {
        throw integrityError('transit minute provenance mismatch', error);
      }
      try {
        // Only after the explicit wardrobe cutover; earlier history is never reinterpreted.
        validateWardrobeMinute(state, minuteEvents);
      } catch (error) {
        throw integrityError('wardrobe provenance mismatch', error);
      }
      minuteBase = state.life?.invention ? structuredClone(state) : undefined;
      transitBase = state.life?.transit;
      minuteEvents = [];
    }
    if (checkpoint && entry.sequence === checkpoint.ledgerBaseSequence && canonicalJson({snapshotVersion:snapshot.snapshotVersion,state,ledgerBaseSequence:entry.sequence,ledgerBaseHash:entry.hash}) !== canonicalJson(checkpoint)) {
      throw integrityError("prefix proof checkpoint replay mismatch");
    }
  }
  if (!lastEntry) return snapshot;

  try {
    return parseWorldSnapshot({
      snapshotVersion: snapshot.snapshotVersion,
      state,
      ledgerBaseSequence: lastEntry.sequence,
      ledgerBaseHash: lastEntry.hash,
    });
  } catch (error) {
    throw integrityError("replayed world does not satisfy the snapshot schema", error);
  }
}

/** Derived observation limits may be narrower than canonical IDs. Call only inside the public failure boundary. */
function deriveCanonicalPublicEvidence(base: WorldSnapshot, entries: readonly LedgerEntry[]): VerifiedPublicObservation[] {
  const evidence: VerifiedPublicObservation[] = [];
  let before = base;
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    while (end < entries.length && entries[end]!.event.minute === entries[start]!.event.minute) end++;
    const group = entries.slice(start, end),
      after = replay(before, group);
    if (after.state.canonicalMinute === before.state.canonicalMinute + 1) {
      const observed = observeCommittedMinute(createDiscoveryLedger(), before.state, after.state, group.map(e => e.event));
      if (!observed.ok || observed.value.rejected.length) throw new PublicProjectionUnavailableError();
      for (const {
        residentId,
        observation: o
      } of observed.value.observations) {
        const project = after.state.life?.projects[o.subjectId];
        if (project) evidence.push({
          residentId,
          projectId: o.subjectId,
          placeId: o.placeId,
          minute: o.minute,
          value: o.kind === 'measurement' ? o.value : project.progress,
          evidenceKind: o.kind === 'measurement' ? 'measured' : 'witnessed-change'
        });
      }
    }
    before = after;
    start = end;
  }
  return evidence;
}

/** Verified replay of ledger entries onto a snapshot; exported for derived read-only sidecars. */
export function replayLedger(snapshot: WorldSnapshot, entries: readonly LedgerEntry[]): WorldSnapshot {
  return replay(snapshot, parseInputEntries(entries));
}

/** Read-only historical reversal. Validates both directions; it never supplies authority for a new live commit. */
export function reverseLedger(snapshotInput:WorldSnapshot,entries:readonly LedgerEntry[]):WorldSnapshot {
  const snapshot=parseWorldSnapshot(snapshotInput),accepted=parseInputEntries(entries);
  if(!accepted.length)return snapshot;
  const first=accepted[0]!,last=accepted.at(-1)!;
  if(snapshot.ledgerBaseSequence!==last.sequence||snapshot.ledgerBaseHash!==last.hash)throw integrityError('reverse ledger tail mismatch');
  failUnlessLedgerVerifies(accepted,first.previousHash);
  const base=deriveTransitionBase(snapshot,accepted,first.sequence-1,first.previousHash);
  if(canonicalJson(replay(base,accepted))!==canonicalJson(snapshot))throw integrityError('reverse ledger forward mismatch');
  return base;
}

function deriveTransitionBase(finalSnapshot: WorldSnapshot, entries: readonly LedgerEntry[], baseSequence: number, baseHash: string): WorldSnapshot {
  function* reverse() { for (let i = entries.length - 1; i >= 0; i--) yield entries[i]!; }
  return deriveTransitionBaseFromReverse(finalSnapshot, reverse(), baseSequence, baseHash);
}

function deriveTransitionBaseFromReverse(
  finalSnapshot: WorldSnapshot,
  reverseEntries: Iterable<LedgerEntry>,
  baseSequence: number,
  baseHash: string,
): WorldSnapshot {
  const state = structuredClone(finalSnapshot.state);

  for (const entry of reverseEntries) {
    const event = entry.event;
    switch (event.type) {
      case "invention-enabled":
      case "invention-method-changed":
    case "invention-site-changed":
      case "invention-agenda-changed":
      case "invention-consultation-changed":
      case "invention-design-changed":
      case "invention-artifact-changed":
      case "invention-trial-changed":
      case "invention-grant-changed":
      case "invention-job-changed":
      case "invention-counters-changed":
      case "invention-command-resolved":
        applyInventionDelta(state, event, true);
        break;
      case "resident-appearances-migrated":
        applyAppearanceMigration(state, event, true);
        break;
      case "civic-projects-migrated":
        applyCivicMigration(state, event, true);
        break;
      case "wardrobe-opened":
        applyWardrobeOpened(state, event, true);
        break;
      case "family-formed":
        applyFamilyFormed(state, event, true);
        break;
      case "resident-life-changed":
      case "life-resource-changed":
      case "life-project-changed":
      case "life-commitment-changed":
        applyLifeDelta(state, event, true);
        break;
      case "life-chart-changed":
        applyChartDelta(state, event, true);
        break;
      case "life-frontier-changed":
        applyFrontierDelta(state, event, true);
        break;
      case "frontier-opened":
        applyFrontierOpened(state, event, true);
        break;
      case "frontier-access-enabled":
        applyFrontierAccessEnabled(state, event, true);
        break;
      case "place-founded":
        applyPlaceFounded(state, event, true);
        break;
      case "resident-moved-home":
        applyResidentMovedHome(state, event, true);
        break;
      case "resident-action-resolved":
        if (!state.life || event.minute !== state.canonicalMinute + 1) throw integrityError("action resolution reversal minute mismatch");
        break;
      case "venture-changed":
      case "venture-resource-changed":
      case "venture-counters-changed":
        applyVentureDelta(state, event, true);
        break;
      case "transit-commissioned":
        applyTransitCommissioned(state, event, true);
        break;
      case "transit-changed":
        applyTransitDelta(state, event, true);
        break;
      case "clock-advanced":
        if (state.canonicalMinute !== event.toMinute || event.toMinute !== event.fromMinute + 1 || event.minute !== event.toMinute) throw integrityError("clock reversal mismatch");
        state.canonicalMinute = event.fromMinute;
        break;
      case "resident-activity-changed": {
        const resident = state.residents[event.residentId];
        if (resident === undefined || resident.activity !== event.toActivity || event.minute !== state.canonicalMinute + 1) {
          throw integrityError(`unknown resident ${event.residentId}`);
        }
        resident.activity = event.fromActivity;
        break;
      }
      case "resident-location-changed": {
        const resident = state.residents[event.residentId];
        if (resident === undefined || resident.placeId !== event.toPlaceId || event.minute !== state.canonicalMinute + 1) {
          throw integrityError(`unknown resident ${event.residentId}`);
        }
        resident.placeId = event.fromPlaceId;
        break;
      }
      case "construction-stage-progressed":
        if (state.construction.id !== event.constructionId || state.construction.stage !== event.toStage || event.minute !== state.canonicalMinute + 1) {
          throw integrityError(`unknown construction ${event.constructionId}`);
        }
        state.construction.stage = event.fromStage;
        break;
      default: {
        const unhandled: never = event;
        throw integrityError(`no reversal rule for event ${(unhandled as WorldEvent).type}`);
      }
    }
  }

  try {
    return parseWorldSnapshot({
      snapshotVersion: finalSnapshot.snapshotVersion,
      state,
      ledgerBaseSequence: baseSequence,
      ledgerBaseHash: baseHash,
    });
  } catch (error) {
    throw integrityError("cannot derive a valid transition base", error);
  }
}

function parseStoredSnapshot(row: SnapshotRow): WorldSnapshot {
  const sequence = requireSequence(row.sequence, "snapshot sequence");
  const stateJson = requireString(row.state_json, "snapshot state JSON");
  const stateHash = requireString(row.state_hash, "snapshot state hash");

  if (hashStateJson(stateJson) !== stateHash) {
    throw integrityError(`snapshot state hash mismatch at sequence ${sequence}`);
  }

  try {
    const snapshot = parseWorldSnapshot(JSON.parse(stateJson));
    if (canonicalJson(snapshot) !== stateJson) {
      throw integrityError(`snapshot ${sequence} is not canonically encoded`);
    }
    if (snapshot.ledgerBaseSequence !== sequence) {
      throw integrityError(`snapshot sequence mismatch at sequence ${sequence}`);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof WorldIntegrityError) throw error;
    throw integrityError(`invalid snapshot at sequence ${sequence}`, error);
  }
}

/**
 * How long a commit or read waits for another connection's lock before failing. SQLite's default,
 * unchanged by node:sqlite on Node 24.19 and 26.7, is zero: any external reader holding a shared lock
 * (an operator's read-only inspection, a deployment verifying the ledger) made the next commit fail
 * at once with "database is locked", and the rehearsal clock then stopped for good while health still
 * reported integrity ok. Bounded, because node:sqlite waits synchronously: a stuck reader can stall
 * this process for at most this long rather than freezing the world indefinitely.
 */
export const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 2_000;

export class WorldStore {
  static open(path: string, options: {prefixProof?: PrefixProofOptions} = {}): WorldStore {
    const proof = options.prefixProof ? loadRootPrefixReceipt(options.prefixProof) : undefined;
    const database = new DatabaseSync(path);
    try {
      database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`);
      database.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
      // Files written before snapshot retention lack the column; adding it is a schema-only change.
      // Existing rows keep NULL until pruneSnapshots fills them (json_extract once per row).
      const columns = database.prepare("PRAGMA table_info(snapshots)").all() as { name?: unknown }[];
      if (!columns.some((column) => column.name === "canonical_minute")) {
        database.exec("ALTER TABLE snapshots ADD COLUMN canonical_minute INTEGER");
      }
      const store = new WorldStore(database, proof, options.prefixProof?.onProgress);
      store.#ensureAiDecisionIndex();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  readonly #database: DatabaseSync;
  readonly #public: PublicWorldStore;
  readonly #prefixProof: PrefixProofReceipt | undefined;
  readonly #prefixProgress: ((event: PrefixVerification) => void) | undefined;
  #prefixMetrics: PrefixVerification | undefined;
  #rootCollect = false;
  #fullRawEvidence: RawPrefix | undefined;
  get prefixVerification(): PrefixVerification | undefined {return this.#prefixMetrics ? structuredClone(this.#prefixMetrics) : undefined;}

  /** Root-only publication. Fresh RO owner: no inherited cache, schema migration, provider or listener. */
  static mintPrefixProof(options: {databasePath:string;receiptPath:string;provenance:PrefixProvenance;onProgress?:(event:PrefixVerification)=>void}): {receiptSha256:string;verification:PrefixVerification} {
    requireRootPublisher(options.receiptPath);assertPrefixProvenance(options.provenance);
    let progressFailed=false;
    const progress=options.onProgress?(event:PrefixVerification)=>{try{options.onProgress!(event);}catch(error){progressFailed=true;throw error;}}:undefined;
    const runtime=prefixRuntime(),database=new DatabaseSync(options.databasePath,{readOnly:true}),store=new WorldStore(database,undefined,progress);store.#rootCollect=true;
    let receipt:PrefixProofReceipt;
    try {
      database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`);database.exec('BEGIN');const version=store.#dataVersion();
      const world=store.loadVerifiedWorld(),raw=store.#fullRawEvidence,verification=store.#prefixMetrics,head=store.#proofHead();
      if(progressFailed||!raw||!verification||verification.path!=='full'||!verification.complete||raw.count<1||raw.sequence!==world.ledgerBaseSequence||raw.sequence!==head.sequence||raw.hash!==world.ledgerBaseHash||raw.hash!==head.hash||verification.suffixSchemaRows!==0)throw integrityError('root proof requires exact full head checkpoint verification');
      const anchor=store.#proofSnapshot(raw.sequence),identity=store.#proofIdentity();
      if(canonicalJson(anchor.snapshot)!==canonicalJson(world)||store.#dataVersion()!==version)throw integrityError('root proof changed during verification');
      database.exec('ROLLBACK');if(store.#dataVersion()!==version||canonicalJson(prefixRuntime())!==canonicalJson(runtime))throw integrityError('root proof source or database changed');
      receipt={format:1,policy:'private-prefix-v1',provenance:structuredClone(options.provenance),runtime,anchor:{...raw,snapshotDigest:anchor.digest,minute:world.state.canonicalMinute},...identity,verification:structuredClone(verification)};
    } finally {try{if(database.isTransaction)database.exec('ROLLBACK');}finally{database.close();}}
    // No root authority is published until the read transaction and SQLite owner positively close.
    return {receiptSha256:publishRootPrefixReceipt(options.receiptPath,receipt!),verification:structuredClone(receipt!.verification)};
  }
  #closed = false;
  // Fully verified or locally committed snapshots are cached. External SQLite
  // commits invalidate them through data_version; reopening verifies history first.
  #verified: { snapshot: WorldSnapshot; dataVersion: number } | undefined;
  // Accepted local-model decision count at a verified head. Valid only while SQLite's
  // data_version is unchanged; local commits roll it forward from the committed entries
  // instead of rescanning, external changes drop it, and it is never served for a
  // different head than the one it was counted for.
  #decisionCount: { dataVersion: number; asOfSequence: number; total: number } | undefined;

  // Prepared once per store: the rebuild runs them once per candidate ledger row.
  #aiIndexStatements: { insert: StatementSync; resolve: StatementSync } | undefined;
  #retentionStatements: { leavingWindow: StatementSync; previous: StatementSync; remove: StatementSync } | undefined;

  private constructor(database: DatabaseSync, proof?: PrefixProofReceipt, onProgress?: (event:PrefixVerification)=>void) {
    this.#database = database;this.#prefixProof=proof;this.#prefixProgress=onProgress;
    this.#public = new PublicWorldStore(database, (anchor,head) => this.#canonicalPublicHistory(anchor,head));
  }

  commitTransition(snapshotInput: WorldSnapshot, entries: readonly LedgerEntry[], clock: {
    initializeEpochMilliseconds?: number;
    expectedEpochMilliseconds?: number;
  } = {}): PublicEvent | undefined {
    this.#requireOpen();
    const timer = slowTimer("store.commitTransition");
    if (clock.initializeEpochMilliseconds !== undefined && clock.expectedEpochMilliseconds !== undefined) {
      throw integrityError("clock initialization and resume are mutually exclusive");
    }

    let snapshot: WorldSnapshot;
    try {
      snapshot = parseWorldSnapshot(snapshotInput);
    } catch (error) {
      throw integrityError("invalid snapshot input", error);
    }

    const acceptedEntries = parseInputEntries(entries);
    validateNewMethodAdmissions(this,snapshot,acceptedEntries);
    timer.lap("parse");
    const dataVersion = this.#dataVersion();
    const cached = this.#cachedSnapshot(dataVersion);
    // Cold cache: verify the committed chain in windows rather than materialising every event.
    const currentEntry = cached ? undefined : verifyLedgerRowStream(this.#allLedgerRowsIterator()).last;
    const currentSequence = cached?.ledgerBaseSequence ?? currentEntry?.sequence ?? 0;
    if(currentSequence===0&&!this.#hasSnapshots()){
      const admitted=new Set(acceptedEntries.flatMap(e=>e.event.type==='invention-method-changed'&&e.event.before===null?[e.event.recordId]:[]));
      if(Object.keys(snapshot.state.life?.invention?.methods??{}).some(id=>!admitted.has(id)))throw integrityError('method-admission-authority');
      const grants=new Set(acceptedEntries.flatMap(e=>e.event.type==='invention-grant-changed'&&e.event.before===null?[e.event.recordId]:[]));
      if(Object.keys(snapshot.state.life?.invention?.grants??{}).some(id=>!grants.has(id)))throw integrityError('grant-bootstrap-authority');
    }
    const currentHash = cached?.ledgerBaseHash ?? currentEntry?.hash ?? GENESIS_HASH;
    timer.lap(cached ? "cacheHit" : "coldChainVerify");

    if (acceptedEntries.length > 0) {
      if (acceptedEntries[0]?.sequence !== currentSequence + 1) {
        throw integrityError(`ledger suffix must begin at sequence ${currentSequence + 1}`);
      }
      failUnlessLedgerVerifies(acceptedEntries, currentHash);
    }

    const finalEntry = acceptedEntries.at(-1);
    const expectedSequence = finalEntry?.sequence ?? currentSequence;
    const expectedHash = finalEntry?.hash ?? currentHash;
    if (
      snapshot.ledgerBaseSequence !== expectedSequence ||
      snapshot.ledgerBaseHash !== expectedHash
    ) {
      throw integrityError("snapshot ledger base does not match the committed transition");
    }

    let transitionBase: WorldSnapshot;
    if (cached) {
      transitionBase = cached;
    } else if (!this.#hasSnapshots()) {
      transitionBase = deriveTransitionBase(
        snapshot,
        acceptedEntries,
        currentSequence,
        currentHash,
      );
    } else {
      transitionBase = this.loadVerifiedWorld();
      if (
        transitionBase.ledgerBaseSequence !== currentSequence ||
        transitionBase.ledgerBaseHash !== currentHash
      ) {
        throw integrityError("current ledger tail cannot be replayed from a verified snapshot");
      }
    }

    timer.lap("transitionBase");
    const verifiedFinal = replay(transitionBase, acceptedEntries);
    if (canonicalJson(verifiedFinal) !== canonicalJson(snapshot)) {
      throw integrityError("snapshot state does not match the supplied ledger transition");
    }

    const stateJson = canonicalJson(snapshot);
    const stateHash = hashStateJson(stateJson);
    timer.lap("replayAndCompare");
    this.#database.exec("BEGIN IMMEDIATE");
    timer.lap("beginImmediate");
    try {
      // Validation above must still describe the database now protected by the
      // write lock. Never commit against a concurrently changed cached history.
      if (this.#dataVersion() !== dataVersion) {
        this.#verified = undefined;
        throw integrityError("database changed during transition verification");
      }
      if (clock.initializeEpochMilliseconds !== undefined) {
        if (this.#hasSnapshots() || currentSequence !== 0 || acceptedEntries.length !== 0 || snapshot.state.canonicalMinute !== 0) {
          throw integrityError("clock initialization requires an empty minute-zero world");
        }
        insertClockMetadata(this.#database, clock.initializeEpochMilliseconds, stateHash);
      } else {
        const epoch = this.loadClockEpoch();
        if (epoch !== clock.expectedEpochMilliseconds) throw integrityError("clock epoch does not match commit mode");
      }
      timer.lap("clockCheck");
      const insertLedger = this.#database.prepare(
        "INSERT INTO ledger(sequence, previous_hash, hash, event_json) VALUES (?, ?, ?, ?)",
      );
      for (const entry of acceptedEntries) {
        insertLedger.run(
          entry.sequence,
          entry.previousHash,
          entry.hash,
          encodeLedgerEvent(canonicalJson(entry.event)),
        );
      }
      timer.lap("insertLedger");
      // Derived AI-decision index, in the same transaction: rolled forward only from a complete
      // index at the previous head, otherwise left behind (history refuses; the next open rebuilds).
      if (this.#indexedThrough() === currentSequence) {
        for (const entry of acceptedEntries) this.#indexEvent(entry.sequence, entry.event);
        this.#setIndexedThrough(snapshot.ledgerBaseSequence);
      }
      timer.lap("aiIndex");

      this.#database
        .prepare(
          "INSERT INTO snapshots(sequence, state_json, state_hash, created_at, canonical_minute) VALUES (?, ?, ?, ?, ?)",
        )
        .run(snapshot.ledgerBaseSequence, stateJson, stateHash, new Date().toISOString(), snapshot.state.canonicalMinute);
      timer.lap("insertSnapshot");
      this.#pruneLeavingSnapshot(snapshot.ledgerBaseSequence);
      timer.lap("pruneSnapshot");
      // Actual canonical transaction boundaries remain independent of the derived
      // public outbox. Reopen validation replays these ranges, not public claims.
      this.#database.prepare("INSERT INTO canonical_commits(sequence,previous_sequence,previous_hash,hash,state_hash) VALUES(?,?,?,?,?)")
        .run(snapshot.ledgerBaseSequence,currentSequence,currentHash,snapshot.ledgerBaseHash,stateHash);
      const publicEvent = this.#public.advance(transitionBase, snapshot, () => deriveCanonicalPublicEvidence(transitionBase,acceptedEntries));
      this.#database.exec("COMMIT");
      timer.lap("commit");
      const previousCount = this.#decisionCount;
      const committedVersion = this.#dataVersion();
      this.#verified = { snapshot: structuredClone(snapshot), dataVersion: committedVersion };
      this.#decisionCount = previousCount !== undefined && previousCount.dataVersion === dataVersion && previousCount.asOfSequence === currentSequence
        ? { dataVersion: committedVersion, asOfSequence: snapshot.ledgerBaseSequence, total: previousCount.total + acceptedEntries.filter((entry) => isAcceptedModelDecision(entry.event)).length }
        : undefined;
      timer.done({ entries: acceptedEntries.length, sequence: snapshot.ledgerBaseSequence, stateBytes: stateJson.length });
      return publicEvent;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original persistence error.
      }
      this.#public.invalidate();
      throw error;
    }
  }

  /** Reconstruct from the verified canonical head; no stored public facts are evidence. */
  #canonicalPublicHistory(anchor: {
    sequence: number;
    hash: string;
  }, head: WorldSnapshot) {
    if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 0 || anchor.sequence > head.ledgerBaseSequence) throw new PublicProjectionUnavailableError();
    const records = (direction: 'ASC' | 'DESC') => this.#database.prepare(`SELECT sequence,previous_sequence,previous_hash,hash,state_hash FROM canonical_commits WHERE sequence>? AND sequence<=? ORDER BY sequence ${direction}`).iterate(anchor.sequence, head.ledgerBaseSequence);
    // A fresh iterable per pass; no entire canonical-commit range is materialised. Each row
    // is schema/canonical/hash checked, including the exact base, sequence and terminal hash.
    const entriesFor = (row: Record<string, unknown>, direction: 'ASC' | 'DESC' = 'ASC'): Iterable<LedgerEntry> => ({
      [Symbol.iterator]: function* () {
        const sequence = requireSequence(row.sequence, 'canonical commit sequence'), previous = requireSequence(row.previous_sequence, 'canonical commit base');
        if (previous >= sequence) throw new PublicProjectionUnavailableError();
        let count = 0, cursor = direction === 'ASC' ? previous : sequence + 1;
        let hash = requireString(direction === 'ASC' ? row.previous_hash : row.hash, 'canonical commit hash');
        const sql = `SELECT sequence,previous_hash,hash,event_json FROM ledger WHERE sequence>? AND sequence<=? ORDER BY sequence ${direction}`;
        for (const raw of database.prepare(sql).iterate(previous, sequence)) {
          const entry = parseLedgerRows([raw as unknown as LedgerRow])[0]!;
          if (entry.sequence !== cursor + (direction === 'ASC' ? 1 : -1) || (direction === 'ASC' ? entry.previousHash : entry.hash) !== hash) throw new PublicProjectionUnavailableError();
          failUnlessLedgerVerifies([entry], entry.previousHash);
          cursor = entry.sequence;
          hash = direction === 'ASC' ? entry.hash : entry.previousHash;
          count++;
          yield entry;
        }
        if (count !== sequence - previous || hash !== (direction === 'ASC' ? row.hash : row.previous_hash)) throw new PublicProjectionUnavailableError();
      }
    });
    const database = this.#database;
    // Historical observations keep their original event-minute grouping. This is NOT a
    // conservation boundary: complete-commit replay below keeps its original context through
    // clock-advanced, including interleaved zero-minute migrations.
    function* minutes(entries: Iterable<LedgerEntry>): Generator<LedgerEntry[]> {
      let group: LedgerEntry[] = [];
      for (const entry of entries) {
        if (group.length && entry.event.minute !== group[0]!.event.minute) { yield group; group = []; }
        group.push(entry);
      }
      if (group.length) yield group;
    }
    // A fresh replayable source, drained once by the bounded projection accumulator. It keeps
    // exact minute/commit evidence without a commit-sized observation array or resident scans.
    const evidenceFor = (base: WorldSnapshot, row: Record<string, unknown>): Iterable<VerifiedPublicObservation> => ({
      [Symbol.iterator]: function* () {
        let before = base;
        for (const group of minutes(entriesFor(row))) {
          const after = replay(before, group);
          if (after.state.canonicalMinute === before.state.canonicalMinute + 1) {
            const observed = observeCommittedMinute(createDiscoveryLedger(), before.state, after.state, group.map(e => e.event));
            if (!observed.ok || observed.value.rejected.length) throw new PublicProjectionUnavailableError();
            for (const { residentId, observation: o } of observed.value.observations) {
              const project = after.state.life?.projects[o.subjectId];
              if (project) yield { residentId, projectId: o.subjectId, placeId: o.placeId, minute: o.minute, value: o.kind === 'measurement' ? o.value : project.progress, evidenceKind: o.kind === 'measurement' ? 'measured' : 'witnessed-change' };
            }
          }
          before = after;
        }
      }
    });
    let baseline = head;
    for (const raw of records('DESC')) {
      const row = raw as Record<string, unknown>;
      if (row.sequence !== baseline.ledgerBaseSequence || row.hash !== baseline.ledgerBaseHash || row.state_hash !== hashStateJson(canonicalJson(baseline))) throw new PublicProjectionUnavailableError();
      baseline = deriveTransitionBaseFromReverse(baseline, entriesFor(row, 'DESC'), requireSequence(row.previous_sequence, 'canonical commit base'), requireString(row.previous_hash, 'canonical commit base hash'));
    }
    if (baseline.ledgerBaseSequence !== anchor.sequence || baseline.ledgerBaseHash !== anchor.hash) throw new PublicProjectionUnavailableError();
    function* transitions() {
      let before = baseline;
      for (const raw of records('ASC')) {
        const row = raw as Record<string, unknown>;
        if (row.previous_sequence !== before.ledgerBaseSequence || row.previous_hash !== before.ledgerBaseHash) throw new PublicProjectionUnavailableError();
        // Stream the entire original commit through ONE replay context. Event.minute may
        // move backward for supported zero-minute migrations before the next clock event.
        const after = replay(before, entriesFor(row));
        if (row.hash !== after.ledgerBaseHash || row.state_hash !== hashStateJson(canonicalJson(after))) throw new PublicProjectionUnavailableError();
        yield {
          after,
          evidence: evidenceFor(before, row)
        };
        before = after;
      }
      if (canonicalJson(before) !== canonicalJson(head)) throw new PublicProjectionUnavailableError();
    }
    return {
      baseline,
      transitions: transitions()
    };
  }

  initializePublicProjection(): void {
    let began = false;
    try {
      // Current policy metadata only needs validation. A legacy policy upgrade
      // needs the owning write transaction; a busy writer may defer that upgrade.
      if (this.#database.prepare("SELECT singleton FROM public_policy UNION ALL SELECT singleton FROM public_checkpoint LIMIT 1").get() || this.#database.prepare("SELECT cursor FROM public_outbox LIMIT 1").get()) {
        if (!this.#public.needsPolicyUpgrade()) { this.publicSnapshot(); return; }
      }
      this.#database.exec("BEGIN IMMEDIATE");
      began = true;
      const head = this.loadVerifiedWorld();
      if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
      this.#public.initialize(head);
      this.#database.exec("COMMIT");
      began = false;
    } catch (error) {
      if (began) this.#database.exec("ROLLBACK");
      this.#public.invalidate();
      // A reader may open beside the owning writer's pending transaction. Defer
      // the upgrade if BEGIN cannot acquire its lock; never hide a write failure.
      const lockUnavailable = !began && error instanceof Error && 'errcode' in error && (error.errcode === 5 || error.errcode === 6);
      if (!(error instanceof PublicProjectionUnavailableError) && !lockUnavailable) throw error;
    }
  }

  publicCognition(focusedResidentIds: readonly string[] = []) {
    const head = this.loadVerifiedWorld();
    if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
    const admitted = this.#public.cognition(head,focusedResidentIds);
    this.#database.prepare('INSERT INTO public_cognition_policy(singleton,version,source_sequence,source_hash,cutoff_minute) VALUES(1,1,?,?,?) ON CONFLICT(singleton) DO NOTHING').run(head.ledgerBaseSequence, head.ledgerBaseHash, head.state.canonicalMinute);
    const marker = this.#database.prepare('SELECT * FROM public_cognition_policy WHERE singleton=1').get()!;
    const anchor = marker.source_sequence === 0 ? GENESIS_HASH : this.#database.prepare('SELECT hash FROM ledger WHERE sequence=?').get(marker.source_sequence!)?.hash;
    if (marker.version !== 1 || marker.source_hash !== anchor || typeof marker.cutoff_minute !== 'number' || !Number.isSafeInteger(marker.cutoff_minute) || marker.cutoff_minute < 0 || marker.cutoff_minute > head.state.canonicalMinute || typeof marker.source_sequence !== 'number' || !Number.isSafeInteger(marker.source_sequence) || marker.source_sequence < 0 || marker.source_sequence > head.ledgerBaseSequence) throw new PublicProjectionUnavailableError();
    return { ...admitted, cutoffMinute: marker.cutoff_minute };
  }

  publicSnapshot(): PublicSnapshot {
    const head = this.loadVerifiedWorld();
    if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
    return this.#public.snapshot(head);
  }

  publicEventPage(query: {
    before?: number;
    limit: number;
  }): {
    events: PublicEvent[];
    nextCursor: number | null;
  } {
    const head = this.loadVerifiedWorld();
    if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
    return this.#public.page(head, query);
  }

  /** Writer-only bounded public feed capture at the verified writable head; see PublicWorldStore.capture. */
  capturePublicFeed(limits?: PublicFeedCaptureLimits): PublicFeedCapture {
    // An independent read transaction pins precheck, canonical association and suffix to one
    // committed database snapshot. A capture can never inspect an owning write transaction.
    if (this.#database.isTransaction) throw new PublicProjectionUnavailableError();
    this.#database.exec("BEGIN");
    try {
      const head = this.loadVerifiedWorld();
      if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
      return this.#public.capture(head, limits);
    } finally {
      this.#database.exec("ROLLBACK"); // Read-only: no canonical or derived write took place.
    }
  }

  publicEventsAfter(cursor: number, options: {
    limit?: number;
  } = {}): PublicEvent[] {
    const head = this.loadVerifiedWorld();
    if (this.loadLedgerSuffixAfter(head.ledgerBaseSequence).length) throw new PublicProjectionUnavailableError();
    return this.#public.eventsAfter(head, cursor, options.limit);
  }

  loadVerifiedWorld(): WorldSnapshot {
    this.#requireOpen();
    const dataVersion = this.#dataVersion();
    const cached = this.#cachedSnapshot(dataVersion);
    if (cached) return structuredClone(cached);
    this.#prefixMetrics = undefined;
    this.#fullRawEvidence = undefined;
    if (this.#prefixProof) return this.#loadRootVerifiedWorld(dataVersion);
    const snapshotRows = this.#snapshotRows();
    let foundSnapshot = false;

    for (const row of snapshotRows) {
      foundSnapshot = true;
      try {
        const snapshot = parseStoredSnapshot(row);
        const baseSequence = snapshot.ledgerBaseSequence;
        // Streamed in windows: a long history no longer has to fit in memory to be verified.
        const hasher=this.#rootCollect?new PrefixRawHasher():undefined;
        const rows=this.#ledgerRowsThroughIterator(baseSequence),progress=this.#prefixProgress;
        function* observed():IterableIterator<LedgerRow>{let count=0;for(const row of rows){hasher?.add(row);count++;if(progress&&count%LEDGER_VERIFY_WINDOW===0)progress({path:'full',prefixRawRows:hasher?count:0,prefixRawBytes:0,prefixSchemaRows:Math.max(0,count-LEDGER_VERIFY_WINDOW),suffixSchemaRows:0,suffixReplayRows:0,headSequence:baseSequence,complete:false});yield row;}}
        const verifiedPrefix=verifyLedgerRowStream(hasher?observed():rows),baseEntry=verifiedPrefix.last;
        const raw=hasher?.finish();
        const actualBaseHash = baseEntry?.hash ?? GENESIS_HASH;
        if (
          (baseSequence > 0 && baseEntry?.sequence !== baseSequence) ||
          snapshot.ledgerBaseHash !== actualBaseHash
        ) {
          throw integrityError(`snapshot ledger base mismatch at sequence ${baseSequence}`);
        }

        try {
          const suffix = parseLedgerRows(this.#ledgerRowsAfter(baseSequence));
          if (suffix.length > 0 && suffix[0]?.sequence !== baseSequence + 1) {
            throw integrityError(`ledger suffix does not follow snapshot ${baseSequence}`);
          }
          failUnlessLedgerVerifies(suffix, snapshot.ledgerBaseHash);
          const verified = replay(snapshot, suffix);
          // Never cache a fallback checkpoint when its suffix failed verification,
          // or when another SQLite connection changed history during this read.
          if (this.#dataVersion() === dataVersion) {
            this.#verified = { snapshot: structuredClone(verified), dataVersion };
            const head=this.#proofHead();
            this.#prefixMetrics={path:'full',prefixRawRows:raw?.count??0,prefixRawBytes:raw?.bytes??0,prefixSchemaRows:verifiedPrefix.count,suffixSchemaRows:suffix.length,suffixReplayRows:suffix.length,headSequence:verified.ledgerBaseSequence,complete:verified.ledgerBaseSequence===head.sequence&&verified.ledgerBaseHash===head.hash};
            this.#fullRawEvidence=raw;this.#prefixProgress?.(structuredClone(this.#prefixMetrics));
          }
          return verified;
        } catch (error) {
          if (this.#rootCollect) throw error; // Mint never treats a fallback as full proof.
          return snapshot;
        }
      } catch (error) {
        if (this.#rootCollect) throw error;
        // A damaged checkpoint is skipped; an older verified snapshot may still replay the chain.
      }
    }

    if (!foundSnapshot && !this.#hasLedgerRows()) {
      throw new EmptyWorldStoreError();
    }
    throw integrityError("no valid snapshot and ledger chain found");
  }

  #proofHead(): {sequence:number;hash:string} {
    const row=this.#database.prepare('SELECT sequence,hash FROM ledger ORDER BY sequence DESC LIMIT 1').get();
    return row?{sequence:requireSequence(row.sequence,'proof head'),hash:requireString(row.hash,'proof head hash')}:{sequence:0,hash:GENESIS_HASH};
  }
  #proofSnapshot(sequence:number): {snapshot:WorldSnapshot;digest:string} {
    const row=this.#database.prepare('SELECT sequence,state_json,state_hash FROM snapshots WHERE sequence=?').get(sequence) as SnapshotRow|undefined;
    if(!row)throw integrityError('prefix proof anchor snapshot missing');
    return {snapshot:parseStoredSnapshot(row),digest:typedRowsDigest([{sequence:row.sequence,state_json:row.state_json,state_hash:row.state_hash}])};
  }
  #proofIdentity(): {genesisDigest:string;clockDigest:string;epoch:number|null} {
    const genesis=this.#proofSnapshot(0),exists=this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_clock'").get();
    const clock=exists?this.#database.prepare('SELECT id,version,epoch_ms,genesis_state_hash,metadata_hash FROM world_clock ORDER BY id').iterate() as Iterable<Record<string,unknown>>:[];
    return {genesisDigest:genesis.digest,clockDigest:typedRowsDigest(clock),epoch:this.loadClockEpoch()??null};
  }
  *#proofSuffix(sequence:number,hash:string,metrics:PrefixVerification):IterableIterator<LedgerEntry> {
    const rows=this.#database.prepare('SELECT sequence,previous_hash,hash,event_json FROM ledger WHERE sequence>? ORDER BY sequence').iterate(sequence) as Iterable<LedgerRow>;
    let expected=sequence+1,previous=hash,buffer:LedgerRow[]=[],bytes=0;
    const flush=():LedgerEntry[]=>{if(!buffer.length)return [];if(buffer[0]!.sequence!==expected)throw integrityError('prefix proof suffix must start at anchor plus one');const check=verifyLedgerRowStream(buffer,{baseHash:previous}),entries=parseLedgerRows(buffer);if(!check.last)throw integrityError('prefix proof empty suffix window');previous=check.last.hash;expected=check.last.sequence+1;metrics.suffixSchemaRows+=check.count;buffer=[];bytes=0;return entries;};
    for(const row of rows){const rowBytes=decodedLedgerBytes(row.event_json);if(buffer.length&&bytes+rowBytes>LEDGER_VERIFY_WINDOW_BYTES)for(const e of flush())yield e;buffer.push(row);bytes+=rowBytes;if(buffer.length>=LEDGER_VERIFY_WINDOW)for(const e of flush())yield e;}
    for(const e of flush())yield e;
  }
  #loadRootVerifiedWorld(dataVersion:number):WorldSnapshot {
    const receipt=this.#prefixProof!,ownsRead=!this.#database.isTransaction;if(ownsRead)this.#database.exec('BEGIN');
    const metrics:PrefixVerification={path:'root-prefix',prefixRawRows:0,prefixRawBytes:0,prefixSchemaRows:0,suffixSchemaRows:0,suffixReplayRows:0,headSequence:0,complete:false};let verified:WorldSnapshot;
    try {
      const head=this.#proofHead(),hasher=new PrefixRawHasher();if(head.sequence<receipt.anchor.sequence)throw integrityError('prefix proof truncated head');
      for(const row of this.#ledgerRowsThroughIterator(receipt.anchor.sequence)){hasher.add(row);metrics.prefixRawRows++;if(metrics.prefixRawRows%LEDGER_VERIFY_WINDOW===0)this.#prefixProgress?.(structuredClone(metrics));}
      const raw=hasher.finish();metrics.prefixRawBytes=raw.bytes;
      if(canonicalJson(raw)!==canonicalJson({count:receipt.anchor.count,sequence:receipt.anchor.sequence,hash:receipt.anchor.hash,digest:receipt.anchor.digest,bytes:receipt.anchor.bytes}))throw integrityError('prefix proof raw history mismatch');
      const identity=this.#proofIdentity();if(canonicalJson(identity)!==canonicalJson({genesisDigest:receipt.genesisDigest,clockDigest:receipt.clockDigest,epoch:receipt.epoch}))throw integrityError('prefix proof genesis or clock mismatch');
      const anchor=this.#proofSnapshot(receipt.anchor.sequence);if(anchor.digest!==receipt.anchor.snapshotDigest||anchor.snapshot.ledgerBaseHash!==receipt.anchor.hash||anchor.snapshot.state.canonicalMinute!==receipt.anchor.minute)throw integrityError('prefix proof anchor mismatch');
      let checkpoint:WorldSnapshot|undefined;
      for(const row of this.#snapshotRows()){if(requireSequence(row.sequence,'proof checkpoint sequence')>head.sequence)throw integrityError('prefix proof snapshot ahead of actual head');try{const parsed=parseStoredSnapshot(row);if(parsed.ledgerBaseSequence>=receipt.anchor.sequence){checkpoint=parsed;break;}}catch{/* Preserve damaged-checkpoint tolerance; the protected anchor remains mandatory. */}}
      if(!checkpoint)throw integrityError('prefix proof no valid checkpoint');
      const source=this.#proofSuffix(receipt.anchor.sequence,receipt.anchor.hash,metrics);
      function* replayEntries():IterableIterator<LedgerEntry>{for(const entry of source){metrics.suffixReplayRows++;yield entry;}}
      verified=replay(anchor.snapshot,replayEntries(),checkpoint);
      if(verified.ledgerBaseSequence!==head.sequence||verified.ledgerBaseHash!==head.hash||this.#dataVersion()!==dataVersion)throw integrityError('prefix proof did not reach stable writable head');
      metrics.headSequence=head.sequence;metrics.complete=true;
    } finally {if(ownsRead)this.#database.exec('ROLLBACK');}
    if(this.#dataVersion()!==dataVersion)throw integrityError('database changed during prefix proof verification');
    this.#prefixProgress?.(structuredClone(metrics));if(this.#dataVersion()!==dataVersion)throw integrityError('database changed after prefix proof verification');
    this.#verified={snapshot:structuredClone(verified!),dataVersion};this.#prefixMetrics=metrics;return verified!;
  }

  loadClockEpoch(): number | undefined {
    this.#requireOpen();
    try { return readClockEpoch(this.#database); }
    catch (error) { throw integrityError("world clock metadata unavailable or corrupt", error); }
  }

  /** An older valid fallback is not a writable head when any ledger tail is damaged. */
  loadRealtimeWorld(): { epochMilliseconds: number; snapshot: WorldSnapshot } {
    this.#requireOpen();
    const dataVersion = this.#dataVersion();
    const epochMilliseconds = this.loadClockEpoch();
    if (epochMilliseconds === undefined) throw integrityError("world has no real-time epoch");
    const snapshot = this.loadVerifiedWorld();
    if (this.loadLedgerSuffixAfter(snapshot.ledgerBaseSequence).length !== 0 || this.#dataVersion() !== dataVersion) {
      throw integrityError("real-time world is not at a verified writable head");
    }
    return { epochMilliseconds, snapshot };
  }

  loadLedgerSuffixAfter(sequence: number, options: { limit?: number } = {}): LedgerEntry[] {
    this.#requireOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw integrityError("invalid ledger suffix sequence");
    }
    // A caller that replays to a client bounds how far behind a cursor may be. Being too far
    // behind is the caller's problem to handle, never evidence that the ledger is damaged.
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw integrityError("ledger replay limit must be a positive integer");
      const pending = this.#countLedgerAfter(sequence);
      if (pending > options.limit) {
        throw new LedgerCursorError(`cursor ${sequence} is ${pending} events behind the head; resync from a snapshot`);
      }
    }
    const dataVersion = this.#dataVersion();
    const cached = this.#cachedSnapshot(dataVersion);
    if (cached) {
      if (sequence >= cached.ledgerBaseSequence) return [];
      const anchor = sequence === 0 ? GENESIS_HASH : this.#database.prepare("SELECT hash FROM ledger WHERE sequence = ?").get(sequence)?.hash;
      if (typeof anchor !== "string") throw integrityError("missing event cursor anchor");
      const suffix = parseLedgerRows(this.#ledgerRowsAfter(sequence));
      failUnlessLedgerVerifies(suffix, anchor);
      if (this.#dataVersion() !== dataVersion) {
        this.#verified = undefined;
        throw integrityError("database changed during suffix verification");
      }
      return suffix;
    }
    // Cold cache: verify the prefix in windows, then materialise only the requested suffix.
    // A cursor at or beyond the head returns nothing, exactly as a whole-chain read did.
    const head = this.#headSequence();
    if (sequence >= head) return [];
    const verifiedPrefix = verifyLedgerRowStream(this.#ledgerRowsThroughIterator(sequence));
    const coldAnchor = sequence === 0 ? GENESIS_HASH : verifiedPrefix.last?.hash;
    if (typeof coldAnchor !== "string" || (sequence > 0 && verifiedPrefix.last?.sequence !== sequence)) {
      throw integrityError("missing event cursor anchor");
    }
    const coldSuffix = parseLedgerRows(this.#ledgerRowsAfter(sequence));
    // Splitting the chain must not weaken it: the suffix has to continue the prefix exactly.
    if (coldSuffix[0]?.sequence !== sequence + 1) {
      throw integrityError(`ledger suffix does not follow sequence ${sequence}`);
    }
    failUnlessLedgerVerifies(coldSuffix, coldAnchor);
    if (this.#dataVersion() !== dataVersion) {
      this.#verified = undefined;
      throw integrityError("database changed during suffix verification");
    }
    return coldSuffix;
  }

  /**
   * Read-only history of accepted local-model decisions, newest first, bounded
   * to the verified ledger head (never the unverified tail). Served from the derived
   * `ai_decisions` index, which must be complete at exactly that head; nothing scans
   * the ledger. Labels come only from the same minute's first committed resident-life
   * change after the decision, when its task carries `decisionSource: "local-model"`.
   */
  aiDecisionHistory(query: { before?: number | undefined; limit: number }): { total: number; asOfSequence: number; rows: AiDecisionRow[]; nextCursor: number | null } {
    this.#requireOpen();
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > AI_DECISION_HISTORY_MAX_LIMIT) throw new RangeError("invalid history limit");
    if (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) throw new RangeError("invalid history cursor");
    const head = this.loadVerifiedWorld();
    const dataVersion = this.#dataVersion();
    const asOfSequence = head.ledgerBaseSequence;
    // loadVerifiedWorld may return an older verified checkpoint when the tail is damaged;
    // history must not be served from such a head. Verifying the suffix throws on damage,
    // and any surviving unverified rows beyond the head also refuse the request.
    if (this.loadLedgerSuffixAfter(asOfSequence).length !== 0) throw integrityError("history head is not at the verified ledger tail");
    if (this.#indexedThrough() !== asOfSequence) throw new AiDecisionIndexUnavailableError();
    let counted: number;
    if (this.#decisionCount !== undefined && this.#decisionCount.dataVersion === dataVersion && this.#decisionCount.asOfSequence === asOfSequence) {
      counted = this.#decisionCount.total;
    } else {
      const scanned = this.#database.prepare(AI_DECISION_HISTORY_SQL.count).get(asOfSequence)?.total;
      if (typeof scanned !== "number" || !Number.isSafeInteger(scanned)) throw integrityError("history count unavailable");
      counted = scanned;
      this.#decisionCount = { dataVersion, asOfSequence, total: scanned };
    }
    const upper = query.before === undefined ? asOfSequence : Math.min(asOfSequence, query.before - 1);
    const pageRows = this.#database
      .prepare(AI_DECISION_HISTORY_SQL.page)
      .all(upper, query.limit + 1) as unknown as { sequence: unknown; resident_id: unknown; minute: unknown; option_id: unknown; kind: unknown; label: unknown }[];
    const rows: AiDecisionRow[] = [];
    for (const raw of pageRows.slice(0, query.limit)) {
      const sequence = requireSequence(raw.sequence, "history sequence");
      const kind = raw.kind === null ? null : requireString(raw.kind, "history kind") as AiDecisionRow["kind"];
      const label = raw.label === null ? null : requireString(raw.label, "history label");
      rows.push({ sequence, minute: requireSequence(raw.minute, "history minute"), residentId: requireString(raw.resident_id, "history resident"), optionId: requireString(raw.option_id, "history option"), kind, label });
    }
    if (this.#dataVersion() !== dataVersion) throw integrityError("database changed during history read");
    const last = rows.at(-1);
    return { total: counted, asOfSequence, rows, nextCursor: pageRows.length > query.limit && last !== undefined ? last.sequence : null };
  }

  /**
   * Rebuild the derived AI-decision index from the whole ledger in one streamed pass and one
   * transaction, then mark it complete through the ledger head. The ledger is only read.
   */
  rebuildAiDecisionIndex(): { rows: number; ms: number } {
    this.#requireOpen();
    const started = performance.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec("DELETE FROM ai_decisions");
      // Canonical ledger JSON spells event types literally, so this cheap filter is a superset of
      // both event types; each candidate is still checked on its parsed top-level fields. Compressed
      // rows cannot be searched in SQL, so they are decoded and filtered the same way here.
      const candidates = this.#database
        .prepare("SELECT sequence, event_json FROM ledger WHERE typeof(event_json) = 'blob' OR instr(event_json, '\"resident-action-resolved\"') > 0 OR instr(event_json, '\"resident-life-changed\"') > 0 ORDER BY sequence ASC")
        .iterate() as unknown as IterableIterator<{ sequence: unknown; event_json: unknown }>;
      for (const row of candidates) {
        const sequence = requireSequence(row.sequence, "ledger sequence");
        const text = decodeLedgerEvent(row.event_json);
        if (!text.includes('"resident-action-resolved"') && !text.includes('"resident-life-changed"')) continue;
        let event: IndexableEvent;
        try {
          event = JSON.parse(text) as IndexableEvent;
        } catch (error) {
          throw integrityError(`invalid ledger event at sequence ${sequence}`, error);
        }
        this.#indexEvent(sequence, event);
      }
      this.#setIndexedThrough(this.#headSequence());
      const rows = this.#database.prepare("SELECT COUNT(*) AS total FROM ai_decisions").get()?.total;
      this.#database.exec("COMMIT");
      this.#decisionCount = undefined;
      return { rows: typeof rows === "number" ? rows : 0, ms: Math.round(performance.now() - started) };
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  /**
   * Apply the full retention rule to every existing snapshot row in one transaction (release-time
   * cleanup of files written before retention; Task 3 runs it, then VACUUMs). Rows without
   * canonical_minute are read once with json_extract: on a file of ~13k 1 MB legacy rows that reads
   * every snapshot once (the one-off cost); only the kept rows are then written with their minute.
   * Never VACUUMs; ledger rows are untouched.
   * `keepNewest` exists for tests; production always uses SNAPSHOT_KEEP_NEWEST.
   */
  pruneSnapshots(keepNewest: number = SNAPSHOT_KEEP_NEWEST): { kept: number; deleted: number; ms: number } {
    this.#requireOpen();
    if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) throw new RangeError("invalid snapshot retention window");
    const started = performance.now();
    const protectedSequence = this.#cachedSnapshot(this.#dataVersion())?.ledgerBaseSequence ?? -1;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      // Minutes are read into a temporary table rather than written back to every legacy row:
      // rewriting a 1 MB row to add one integer would journal the whole row. Only kept rows are updated.
      this.#database.exec("DROP TABLE IF EXISTS temp.snapshot_minutes");
      this.#database.exec("CREATE TEMP TABLE snapshot_minutes(sequence INTEGER PRIMARY KEY, minute)");
      this.#database.exec(`INSERT INTO temp.snapshot_minutes(sequence, minute) SELECT sequence, ${SNAPSHOT_MINUTE} FROM snapshots`);
      const deleted = this.#database.prepare(`
        DELETE FROM snapshots WHERE sequence NOT IN (
          SELECT 0
          UNION SELECT sequence FROM (SELECT sequence FROM snapshot_minutes ORDER BY sequence DESC LIMIT ?)
          UNION SELECT MIN(sequence) FROM snapshot_minutes WHERE typeof(minute) = 'integer' AND minute >= 0 GROUP BY minute / ${SNAPSHOT_HOUR_MINUTES}
          UNION SELECT sequence FROM snapshot_minutes WHERE typeof(minute) <> 'integer' OR minute < 0
          UNION SELECT ?
          UNION SELECT ?
        )`).run(keepNewest, protectedSequence, this.#prefixProof?.anchor.sequence ?? -1).changes;
      this.#database.exec("UPDATE snapshots SET canonical_minute = (SELECT minute FROM snapshot_minutes WHERE snapshot_minutes.sequence = snapshots.sequence) WHERE canonical_minute IS NULL");
      this.#database.exec("DROP TABLE temp.snapshot_minutes");
      const kept = this.#database.prepare("SELECT COUNT(*) AS total FROM snapshots").get()?.total;
      this.#database.exec("COMMIT");
      return { kept: typeof kept === "number" ? kept : 0, deleted: Number(deleted), ms: Math.round(performance.now() - started) };
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  /** The committed genesis snapshot (sequence 0) and its stored hash: the canonical identity anchor for derived sidecars. */
  loadGenesisSnapshot(): { snapshot: WorldSnapshot; stateHash: string } {
    this.#requireOpen();
    const row = this.#database.prepare("SELECT sequence, state_json, state_hash FROM snapshots WHERE sequence = 0").get() as unknown as SnapshotRow | undefined;
    if (row === undefined) throw integrityError("world has no genesis snapshot");
    return { snapshot: parseStoredSnapshot(row), stateHash: requireString(row.state_hash, "snapshot state hash") };
  }

  /** A committed checkpoint at an exact ledger sequence (hash-verified), or undefined when none was written there. */
  loadSnapshotAt(sequence: number): WorldSnapshot | undefined {
    this.#requireOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw integrityError("invalid snapshot sequence");
    const row = this.#database.prepare("SELECT sequence, state_json, state_hash FROM snapshots WHERE sequence = ?").get(sequence) as unknown as SnapshotRow | undefined;
    return row === undefined ? undefined : parseStoredSnapshot(row);
  }

  /** The stored ledger hash at a sequence (GENESIS_HASH for 0), or undefined when the sequence does not exist. */
  ledgerHashAt(sequence: number): string | undefined {
    this.#requireOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw integrityError("invalid ledger sequence");
    if (sequence === 0) return GENESIS_HASH;
    const hash = this.#database.prepare("SELECT hash FROM ledger WHERE sequence = ?").get(sequence)?.hash;
    return typeof hash === "string" ? hash : undefined;
  }

  /** Diagnostics: whether the next history count can be served without a ledger scan. */
  get decisionCountCached(): boolean {
    return this.#decisionCount !== undefined && this.#decisionCount.dataVersion === this.#dataVersion();
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  /** On open: a missing or incomplete index (not at the ledger head) is rebuilt once, logged. */
  #ensureAiDecisionIndex(): void {
    const head = this.#headSequence();
    if (this.#indexedThrough() === head) return;
    try {
      const { rows, ms } = this.rebuildAiDecisionIndex();
      if (head > 0) process.stderr.write(`${JSON.stringify({ aiIndexRebuilt: rows, ms })}\n`);
    } catch (error) {
      // Opening the world never depends on the derived index; history refuses until it is rebuilt.
      process.stderr.write(`${JSON.stringify(error instanceof Error ? { aiIndexRebuildFailed: error.name, message: error.message } : { aiIndexRebuildFailed: "unknown" })}\n`);
    }
  }

  /**
   * Per-commit retention, inside commitTransition's transaction: the one snapshot that the insert
   * at `headSequence` pushed out of the newest window is deleted unless it is genesis or the first
   * of its world hour. Older rows are left for pruneSnapshots. A NULL (pre-retention) or otherwise
   * unreadable minute, on the leaving row or its older neighbour, keeps the row.
   */
  #pruneLeavingSnapshot(headSequence: number): void {
    const statements = this.#retentionStatements ??= {
      leavingWindow: this.#database.prepare(SNAPSHOT_RETENTION_SQL.leavingWindow),
      previous: this.#database.prepare(SNAPSHOT_RETENTION_SQL.previous),
      remove: this.#database.prepare(SNAPSHOT_RETENTION_SQL.remove),
    };
    const leaving = statements.leavingWindow.get(headSequence) as { sequence?: unknown; minute?: unknown } | undefined;
    if (leaving === undefined) return;
    const sequence = leaving.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) return;
    if (sequence === this.#prefixProof?.anchor.sequence) return;
    const minute = leaving.minute;
    if (typeof minute !== "number" || !Number.isSafeInteger(minute) || minute < 0) return;
    const previous = (statements.previous.get(sequence) as { minute?: unknown } | undefined)?.minute;
    if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0) return;
    if (Math.floor(previous / SNAPSHOT_HOUR_MINUTES) !== Math.floor(minute / SNAPSHOT_HOUR_MINUTES)) return;
    statements.remove.run(sequence);
  }

  #indexedThrough(): number | undefined {
    const value = this.#database.prepare(AI_DECISION_HISTORY_SQL.indexedThrough).get()?.value;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  #setIndexedThrough(sequence: number): void {
    this.#database
      .prepare("INSERT INTO ai_index_meta(key, value) VALUES ('indexedThrough', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(sequence));
  }

  /**
   * Apply one ledger event, in sequence order, to the index. An accepted model decision adds an
   * unresolved row. A resident-life-changed event is the first match (same resident and minute,
   * later sequence) for every still-unresolved decision it can match: it resolves them, with the
   * task's kind/label only when that task carries local-model attribution, else null.
   */
  #indexEvent(sequence: number, event: IndexableEvent): void {
    const statements = this.#aiIndexStatements ??= {
      insert: this.#database.prepare("INSERT INTO ai_decisions(sequence, resident_id, minute, option_id) VALUES (?, ?, ?, ?)"),
      resolve: this.#database.prepare("UPDATE ai_decisions SET kind = ?, label = ?, resolved = 1 WHERE resolved = 0 AND resident_id = ? AND minute = ? AND sequence < ?"),
    };
    if (event.type === "resident-action-resolved" && event.source === "local-model" && event.outcome === "accepted") {
      statements.insert.run(sequence, requireString(event.residentId, "decision resident"), requireSequence(event.minute, "decision minute"), requireString(event.optionId, "decision option"));
    } else if (event.type === "resident-life-changed") {
      const task = indexedTask(event.after);
      const attributed = task?.decisionSource === "local-model";
      statements.resolve.run(
          attributed ? requireString(task.kind, "task kind") : null,
          attributed ? requireString(task.label, "task label") : null,
          requireString(event.residentId, "life resident"),
          requireSequence(event.minute, "life minute"),
          sequence,
        );
    }
  }

  #allLedgerRowsIterator(): IterableIterator<LedgerRow> {
    return this.#database
      .prepare(
        "SELECT sequence, previous_hash, hash, event_json FROM ledger ORDER BY sequence ASC",
      )
      .iterate() as unknown as IterableIterator<LedgerRow>;
  }

  #countLedgerAfter(sequence: number): number {
    const value = this.#database.prepare("SELECT COUNT(*) AS pending FROM ledger WHERE sequence > ?").get(sequence)?.pending;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
  }

  #headSequence(): number {
    const value = this.#database.prepare("SELECT MAX(sequence) AS head FROM ledger").get()?.head;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
  }

  #hasLedgerRows(): boolean {
    return this.#database.prepare("SELECT 1 FROM ledger LIMIT 1").get() !== undefined;
  }

  #dataVersion(): number {
    const value = this.#database.prepare("PRAGMA data_version").get()?.data_version;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw integrityError("SQLite data version unavailable");
    return value;
  }

  #cachedSnapshot(dataVersion: number): WorldSnapshot | undefined {
    if (this.#verified?.dataVersion !== dataVersion) this.#verified = undefined;
    return this.#verified?.snapshot;
  }

  #ledgerRowsThroughIterator(sequence: number): IterableIterator<LedgerRow> {
    return this.#database
      .prepare(
        "SELECT sequence, previous_hash, hash, event_json FROM ledger WHERE sequence <= ? ORDER BY sequence ASC",
      )
      .iterate(sequence) as unknown as IterableIterator<LedgerRow>;
  }

  #ledgerRowsThrough(sequence: number): LedgerRow[] {
    return this.#database
      .prepare(
        "SELECT sequence, previous_hash, hash, event_json FROM ledger WHERE sequence <= ? ORDER BY sequence ASC",
      )
      .all(sequence) as unknown as LedgerRow[];
  }

  #ledgerRowsAfter(sequence: number): LedgerRow[] {
    return this.#database
      .prepare(
        "SELECT sequence, previous_hash, hash, event_json FROM ledger WHERE sequence > ? ORDER BY sequence ASC",
      )
      .all(sequence) as unknown as LedgerRow[];
  }

  #hasSnapshots(): boolean {
    return this.#database.prepare("SELECT 1 FROM snapshots LIMIT 1").get() !== undefined;
  }

  #snapshotRows(): IterableIterator<SnapshotRow> {
    return this.#database
      .prepare("SELECT sequence, state_json, state_hash FROM snapshots ORDER BY sequence DESC")
      .iterate() as unknown as IterableIterator<SnapshotRow>;
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("WorldStore is closed");
  }
}
