import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AdmissionRegistrySchema, PublicSnapshotSchema, PublicEventSchema, publicCanonicalJson, publicFactKey, publicKeyString, MAX_PUBLIC_BYTES, type PublicSnapshot, type PublicEvent, type WorldSnapshot, type AdmissionRegistry } from '@meridian/world-schema';
import { approveFocusedCognition, createAdmissionRegistry, createPublicBaseline, derivePublicCommit, publicRevision, type VerifiedPublicObservation, type ApprovedPublicFacts, type PublicProjectionPolicy } from '../public-world-projection.js';
export const PUBLIC_OUTBOX_RETENTION = 128;
export class PublicProjectionUnavailableError extends Error {
  constructor() {
    super('public projection unavailable');
  }
}
export class PublicCursorError extends Error {
  constructor() {
    super('resync-required');
  }
}
export interface CanonicalPublicHistory {
  baseline: WorldSnapshot;
  transitions: Iterable<{
    after: WorldSnapshot;
    evidence: Iterable<VerifiedPublicObservation>;
  }>;
}
type CanonicalSource = (anchor: {
  sequence: number;
  hash: string;
}, head: WorldSnapshot) => CanonicalPublicHistory;
interface Checkpoint {
  snapshot: PublicSnapshot;
  base: PublicSnapshot;
  registry: AdmissionRegistry;
  sequence: number;
  hash: string;
  policy: PublicProjectionPolicy;
  privacyFloor: number;
}
function decode(value: unknown): unknown {
  if (typeof value !== 'string') throw new PublicProjectionUnavailableError();
  return JSON.parse(value);
}
/** Caller-tunable bounds for one writer-side public feed capture. Defaults are the format-1 ceilings. */
export interface PublicFeedCaptureLimits {
  /** Retained events, at most the outbox retention (128). */
  maxEvents?: number;
  /** Aggregate encoded bytes of retained events (16 MiB). */
  maxEventBytes?: number;
  /** Encoded bytes a cold capture may replay to advance its base before falling back to a snapshot-only capture. */
  maxColdBytes?: number;
}
export interface PublicFeedCapturedSnapshot {
  readonly cursor: number;
  readonly revision: string;
  readonly minute: number;
  /** Exact publicCanonicalJson bytes. */
  readonly json: string;
}
export interface PublicFeedCapturedEvent {
  readonly cursor: number;
  readonly revision: string;
  /** Exact stored outbox bytes (publicCanonicalJson). */
  readonly json: string;
  readonly bytes: number;
}
/**
 * Detached public-only capture at one verified canonical head. Strings are immutable copies, so
 * the publisher can serialize them outside the writer queue. Contains no registry, canonical
 * anchor, private source sequence/hash or raw row.
 */
export interface PublicFeedCapture {
  readonly policy: 2;
  readonly streamId: string;
  readonly privacyFloor: number;
  readonly base: PublicFeedCapturedSnapshot;
  readonly head: PublicFeedCapturedSnapshot;
  /** Contiguous base.cursor+1..head.cursor; empty when base is head. */
  readonly events: readonly PublicFeedCapturedEvent[];
  /** 'snapshot-only' is the honest bounded fallback: base is head and replay starts at head. */
  readonly mode: 'replay' | 'snapshot-only';
  readonly acquisition: {
    readonly path: 'warm' | 'cold';
    readonly appliedEvents: number;
    readonly appliedBytes: number;
  };
}
class FeedAcquisitionError extends Error {
  constructor() {
    super('public feed suffix unavailable');
  }
}
interface FeedChain {
  epoch: number;
  streamId: string;
  privacyFloor: number;
  base: {
    snapshot: PublicSnapshot;
    json: string;
  };
  events: PublicFeedCapturedEvent[];
  head: PublicSnapshot;
  headJson: string;
}
function captured(s: PublicSnapshot, json: string): PublicFeedCapturedSnapshot {
  return Object.freeze({
    cursor: s.cursor,
    revision: s.revision,
    minute: s.minute,
    json
  });
}
/** The transaction belongs to WorldStore. There is no independent post-commit writer. */
export class PublicWorldStore {
  #cache: {
    version: number;
    checkpoint: Checkpoint;
  } | undefined;
  #unavailableVersion: number | undefined;
  // Feed captures reuse their validated chain only while no cold verification, rollback or
  // invalidation has occurred since; every such event starts a new epoch.
  #epoch = 0;
  #feed: FeedChain | undefined;
  readonly db: DatabaseSync;
  readonly canonicalSource: CanonicalSource;
  constructor(db: DatabaseSync, canonicalSource: CanonicalSource) {
    this.db = db;
    this.canonicalSource = canonicalSource;
  }
  invalidate(): void {
    this.#cache = undefined;
    this.#unavailableVersion = undefined;
    this.#epoch++;
    this.#feed = undefined;
  }
  #version(): number {
    return this.db.prepare('PRAGMA data_version').get()!.data_version as number;
  }
  #apply(s: PublicSnapshot, e: PublicEvent): PublicSnapshot {
    if (e.streamId !== s.streamId || e.cursor !== s.cursor + 1 || e.previousRevision !== s.revision || e.minute < s.minute) throw new PublicProjectionUnavailableError();
    const facts = new Map(s.facts.map(f => [publicKeyString(publicFactKey(f)), f])),
      seen = new Set<string>();
    for (const op of e.operations) {
      const key = publicKeyString(op.op === 'put' ? publicFactKey(op.fact) : op.key);
      if (seen.has(key)) throw new PublicProjectionUnavailableError();
      seen.add(key);
      if (op.op === 'put') facts.set(key, op.fact);else if (!facts.delete(key)) throw new PublicProjectionUnavailableError();
    }
    const next = PublicSnapshotSchema.parse({
      schemaVersion: 1,
      catalogueVersion: 1,
      streamId: s.streamId,
      cursor: e.cursor,
      revision: e.revision,
      minute: e.minute,
      facts: [...facts.values()].sort((a, b) => publicKeyString(publicFactKey(a)) < publicKeyString(publicFactKey(b)) ? -1 : publicKeyString(publicFactKey(a)) > publicKeyString(publicFactKey(b)) ? 1 : 0)
    });
    if (publicRevision(next) !== next.revision) throw new PublicProjectionUnavailableError();
    return next;
  }
  #read(head: WorldSnapshot): Checkpoint {
    // Startup/readiness callers also use this owner. The supplied canonical head may precede
    // this read; exact source association below either proves the same head or refuses it.
    const ownsRead = !this.db.isTransaction;
    if (ownsRead) this.db.exec('BEGIN');
    try { return this.#readPinned(head); }
    finally { if (ownsRead) this.db.exec('ROLLBACK'); }
  }
  #precheck(): void {
    if (this.db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new PublicProjectionUnavailableError();
    // octet_length on a native TEXT column uses SQLite's stored byte length without loading
    // the body. CAST/length/substr/JSON_each do not provide that allocation guarantee.
    const textFields = (table: string, fields: readonly string[], maximum: number) => {
      for (const field of fields) for (const row of this.db.prepare(`SELECT typeof(${field}) AS type, octet_length(${field}) AS bytes FROM ${table} LIMIT 129`).iterate()) {
        if (row.type !== 'text' || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > maximum) throw new PublicProjectionUnavailableError();
      }
    };
    textFields('public_checkpoint', ['checkpoint_json', 'base_json', 'registry_json'], MAX_PUBLIC_BYTES);
    // The legacy archive is one TEXT value and cannot be streamed by this Node SQLite API.
    // This supports exact small archives defensively; maximal archives remain unsupported.
    textFields('public_policy_archive', ['checkpoint_row_json', 'outbox_json'], 4 * MAX_PUBLIC_BYTES);
    let count = 0;
    for (const row of this.db.prepare('SELECT typeof(event_json) AS type, octet_length(event_json) AS bytes FROM public_outbox ORDER BY cursor LIMIT 129').iterate()) {
      if (++count > PUBLIC_OUTBOX_RETENTION || row.type !== 'text' || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_PUBLIC_BYTES) throw new PublicProjectionUnavailableError();
    }
  }
  #readPinned(head: WorldSnapshot): Checkpoint {
    const version = this.#version();
    if (this.db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new PublicProjectionUnavailableError();
    if (this.#unavailableVersion === version) throw new PublicProjectionUnavailableError();
    if (this.#cache?.version === version) return this.#cache.checkpoint;
    this.#epoch++;
    this.#feed = undefined;
    try {
      this.#precheck();
      const row = this.db.prepare('SELECT * FROM public_checkpoint WHERE singleton=1').get();
      const epoch = this.db.prepare('SELECT * FROM canonical_public_epoch WHERE singleton=1').get();
      const cutover = this.db.prepare('SELECT * FROM canonical_public_policy WHERE singleton=1').get();
      const archive = this.db.prepare('SELECT * FROM public_policy_archive WHERE singleton=1').get();
      if (archive && archive.version !== 1 || cutover?.previous_version !== 1 && archive) throw new PublicProjectionUnavailableError();
      const policy: PublicProjectionPolicy = cutover ? 2 : 1;
      const marker = this.db.prepare('SELECT version FROM public_policy WHERE singleton=1').get();
      if (cutover && (cutover.version !== 2 || ![0, 1].includes(cutover.previous_version as number) || cutover.stream_id !== epoch?.stream_id || !Number.isSafeInteger(cutover.source_sequence) || !Number.isSafeInteger(cutover.prior_cursor) || cutover.prior_cursor as number < 0)) throw new PublicProjectionUnavailableError();
      if (!row || !epoch || marker?.version !== policy || row.policy_version !== policy || row.status !== 'ready' || !Number.isSafeInteger(epoch.source_sequence) || typeof epoch.source_hash !== 'string' || typeof epoch.stream_id !== 'string') throw new PublicProjectionUnavailableError();
      const snapshot = PublicSnapshotSchema.parse(decode(row.checkpoint_json)),
        base = PublicSnapshotSchema.parse(decode(row.base_json)),
        registry = AdmissionRegistrySchema.parse(decode(row.registry_json));
      if (row.source_sequence !== head.ledgerBaseSequence || row.source_hash !== head.ledgerBaseHash || snapshot.streamId !== epoch.stream_id) throw new PublicProjectionUnavailableError();
      const source = this.canonicalSource({
        sequence: epoch.source_sequence as number,
        hash: epoch.source_hash
      }, head);
      const expectedRegistry = createAdmissionRegistry();
      let expected = createPublicBaseline(source.baseline.state, expectedRegistry, epoch.stream_id, cutover?.previous_version === 0 ? 2 : 1);
      // Stored cursors only plan which independently derived snapshots to retain. Their full
      // content, source and exact retained-window position are proved below. No event bodies
      // are queued while replaying canonical history.
      let expectedBase: PublicSnapshot | undefined = base.cursor === expected.cursor ? expected : undefined;
      const archivedRow = archive ? decode(archive.checkpoint_row_json) as Record<string, unknown> : undefined;
      const archivedBase = archivedRow ? PublicSnapshotSchema.parse(decode(archivedRow.base_json)) : undefined;
      let expectedArchivedBase = archivedBase?.cursor === expected.cursor ? expected : undefined;
      const expectedRows: {
        cursor: number;
        bytes: number;
        digest: string;
        sequence: number;
        hash: string;
      }[] = [];
      let activePolicy: PublicProjectionPolicy = cutover?.previous_version === 0 ? 2 : 1;
      let associated = false;
      let privacyFloor = 0;
      const accept = (next: ReturnType<typeof derivePublicCommit>, head: WorldSnapshot) => {
        expected = next.snapshot;
        if (next.event) {
          const json = publicCanonicalJson(next.event);
          expectedRows.push({
            cursor: next.event.cursor,
            bytes: Buffer.byteLength(json),
            digest: createHash('sha256').update(json).digest('hex'),
            sequence: head.ledgerBaseSequence,
            hash: head.ledgerBaseHash
          });
          if (expectedRows.length > PUBLIC_OUTBOX_RETENTION) expectedRows.shift();
          if (expected.cursor === base.cursor) expectedBase = expected;
          if (expected.cursor === archivedBase?.cursor) expectedArchivedBase = expected;
        }
      };
      const associate = (at: WorldSnapshot) => {
        if (!cutover || cutover.source_sequence !== at.ledgerBaseSequence) return;
        if (associated || cutover.source_hash !== at.ledgerBaseHash || cutover.prior_cursor !== expected.cursor) throw new PublicProjectionUnavailableError();
        if (cutover.previous_version === 0) {
          if (at.ledgerBaseSequence !== source.baseline.ledgerBaseSequence || cutover.prior_cursor !== 0 || cutover.prior_revision !== null) throw new PublicProjectionUnavailableError();
        } else {
          if (cutover.prior_revision !== expected.revision || !archive) throw new PublicProjectionUnavailableError();
          const expectedOldRow = {
            singleton: 1,
            policy_version: 1,
            status: 'ready',
            source_sequence: at.ledgerBaseSequence,
            source_hash: at.ledgerBaseHash,
            checkpoint_json: publicCanonicalJson(expected),
            base_json: publicCanonicalJson(expectedArchivedBase),
            registry_json: publicCanonicalJson(expectedRegistry)
          };
          if (!expectedArchivedBase || archivedBase!.cursor !== expected.cursor - expectedRows.length || publicCanonicalJson(archivedRow) !== publicCanonicalJson(expectedOldRow)) throw new PublicProjectionUnavailableError();
          const oldRows = decode(archive.outbox_json);
          if (!Array.isArray(oldRows) || oldRows.length !== expectedRows.length) throw new PublicProjectionUnavailableError();
          for (let i = 0; i < oldRows.length; i++) {
            const actual = oldRows[i], want = expectedRows[i]!;
            if (!actual || typeof actual !== 'object' || Object.keys(actual).sort().join(',') !== 'cursor,event_json,source_hash,source_sequence' || actual.cursor !== want.cursor || actual.source_sequence !== want.sequence || actual.source_hash !== want.hash || typeof actual.event_json !== 'string' || Buffer.byteLength(actual.event_json) !== want.bytes || createHash('sha256').update(actual.event_json).digest('hex') !== want.digest) throw new PublicProjectionUnavailableError();
          }
          accept(derivePublicCommit(expected, at.state, expectedRegistry, [], 2), at);
        }
        privacyFloor = expected.cursor;
        activePolicy = 2;
        associated = true;
      };
      associate(source.baseline);
      for (const transition of source.transitions) {
        accept(derivePublicCommit(expected, transition.after.state, expectedRegistry, transition.evidence, activePolicy), transition.after);
        associate(transition.after);
      }
      if (cutover && !associated) throw new PublicProjectionUnavailableError();
      let rowIndex = 0;
      for (const actual of this.db.prepare('SELECT cursor,event_json,source_sequence,source_hash FROM public_outbox ORDER BY cursor LIMIT 129').iterate()) {
        const want = expectedRows[rowIndex++];
        if (!want || actual.cursor !== want.cursor || actual.source_sequence !== want.sequence || actual.source_hash !== want.hash || typeof actual.event_json !== 'string') throw new PublicProjectionUnavailableError();
        const json = publicCanonicalJson(PublicEventSchema.parse(decode(actual.event_json)));
        if (Buffer.byteLength(json) !== want.bytes || createHash('sha256').update(json).digest('hex') !== want.digest) throw new PublicProjectionUnavailableError();
      }
      if (rowIndex !== expectedRows.length || !expectedBase || base.cursor !== expected.cursor - expectedRows.length || publicCanonicalJson(snapshot) !== publicCanonicalJson(expected) || publicCanonicalJson(base) !== publicCanonicalJson(expectedBase) || publicCanonicalJson(registry) !== publicCanonicalJson(expectedRegistry)) throw new PublicProjectionUnavailableError();
      const checkpoint = {
        snapshot,
        base,
        registry,
        sequence: head.ledgerBaseSequence,
        hash: head.ledgerBaseHash,
        policy,
        privacyFloor
      };
      this.#cache = {
        version,
        checkpoint
      };
      return checkpoint;
    } catch {
      this.#unavailableVersion = version;
      throw new PublicProjectionUnavailableError();
    }
  }
  #write(c: Checkpoint): void {
    this.#unavailableVersion = undefined;
    this.db.prepare(`INSERT INTO public_checkpoint(singleton,policy_version,status,source_sequence,source_hash,checkpoint_json,base_json,registry_json) VALUES(1,?,'ready',?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET policy_version=excluded.policy_version,status='ready',source_sequence=excluded.source_sequence,source_hash=excluded.source_hash,checkpoint_json=excluded.checkpoint_json,base_json=excluded.base_json,registry_json=excluded.registry_json`).run(c.policy, c.sequence, c.hash, publicCanonicalJson(c.snapshot), publicCanonicalJson(c.base), publicCanonicalJson(c.registry));
    this.#cache = {
      version: this.#version(),
      checkpoint: c
    };
  }
  initialize(head: WorldSnapshot): void {
    if (this.db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new PublicProjectionUnavailableError();
    const marker = this.db.prepare('SELECT version FROM public_policy WHERE singleton=1').get(),
      row = this.db.prepare('SELECT singleton FROM public_checkpoint').get(),
      epoch = this.db.prepare('SELECT singleton FROM canonical_public_epoch').get();
    if (marker || row || epoch || this.db.prepare('SELECT singleton FROM canonical_public_policy UNION ALL SELECT singleton FROM public_policy_archive LIMIT 1').get()) {
      this.#read(head);
      if (this.needsPolicyUpgrade()) this.#upgrade(head);
      return;
    }
    if (this.db.prepare('SELECT cursor FROM public_outbox LIMIT 1').get()) throw new PublicProjectionUnavailableError();
    const registry = createAdmissionRegistry(),
      streamId = randomUUID();
    let snapshot: PublicSnapshot;
    try {
      snapshot = createPublicBaseline(head.state, registry, streamId);
    } catch {
      throw new PublicProjectionUnavailableError();
    }
    // Authoritative activation association is written once at the verified canonical head.
    // Never repair it from a replacement public snapshot or reset an existing epoch.
    this.db.prepare('INSERT INTO canonical_public_epoch(singleton,stream_id,source_sequence,source_hash) VALUES(1,?,?,?)').run(streamId, head.ledgerBaseSequence, head.ledgerBaseHash);
    this.db.prepare('INSERT INTO public_policy(singleton,version) VALUES(1,2)').run();
    this.db.prepare('INSERT INTO canonical_public_policy(singleton,version,previous_version,stream_id,source_sequence,source_hash,prior_cursor,prior_revision) VALUES(1,2,0,?,?,?,0,NULL)').run(streamId, head.ledgerBaseSequence, head.ledgerBaseHash);
    this.#write({
      snapshot,
      base: snapshot,
      registry,
      sequence: head.ledgerBaseSequence,
      hash: head.ledgerBaseHash,
      policy: 2,
      privacyFloor: 0
    });
  }
  needsPolicyUpgrade(): boolean {
    return this.db.prepare('SELECT version FROM public_policy WHERE singleton=1').get()?.version === 1;
  }
  #upgrade(head: WorldSnapshot): void {
    // Called only inside the owning canonical transaction, after independent old-policy validation.
    const checkpoint = structuredClone(this.#read(head));
    let next: ReturnType<typeof derivePublicCommit>;
    try {
      next = derivePublicCommit(checkpoint.snapshot, head.state, checkpoint.registry, [], 2);
    } catch {
      throw new PublicProjectionUnavailableError();
    }
    // Preserve only the genuinely retained old window, with its original serialized bytes.
    // It stays private even as the ordinary public outbox rolls past that window.
    const oldRow = this.db.prepare('SELECT * FROM public_checkpoint WHERE singleton=1').get();
    const oldRows = this.db.prepare('SELECT * FROM public_outbox ORDER BY cursor LIMIT 129').all();
    this.db.prepare('INSERT INTO public_policy_archive(singleton,version,checkpoint_row_json,outbox_json) VALUES(1,1,?,?)').run(publicCanonicalJson(oldRow), publicCanonicalJson(oldRows));
    this.db.prepare('INSERT INTO canonical_public_policy(singleton,version,previous_version,stream_id,source_sequence,source_hash,prior_cursor,prior_revision) VALUES(1,2,1,?,?,?,?,?)').run(checkpoint.snapshot.streamId, head.ledgerBaseSequence, head.ledgerBaseHash, checkpoint.snapshot.cursor, checkpoint.snapshot.revision);
    if (next.event) this.#append(checkpoint, next.event, head);
    this.db.prepare('UPDATE public_policy SET version=2 WHERE singleton=1').run();
    this.#write({
      ...checkpoint,
      snapshot: next.snapshot,
      policy: 2,
      privacyFloor: next.snapshot.cursor
    });
  }
  #append(checkpoint: Checkpoint, event: PublicEvent, head: WorldSnapshot): void {
    this.db.prepare('INSERT INTO public_outbox(cursor,event_json,source_sequence,source_hash) VALUES(?,?,?,?)').run(event.cursor, publicCanonicalJson(event), head.ledgerBaseSequence, head.ledgerBaseHash);
    if (event.cursor - checkpoint.base.cursor > PUBLIC_OUTBOX_RETENTION) {
      const row = this.db.prepare('SELECT cursor,event_json FROM public_outbox ORDER BY cursor LIMIT 1').get()!;
      checkpoint.base = this.#apply(checkpoint.base, PublicEventSchema.parse(decode(row.event_json)));
      this.db.prepare('DELETE FROM public_outbox WHERE cursor=?').run(row.cursor as number);
    }
  }
  /** A corrupt derived lane stays unavailable. Canonical/private history may still advance. */
  advance(base: WorldSnapshot, head: WorldSnapshot, evidence: () => readonly VerifiedPublicObservation[]): PublicEvent | undefined {
    let checkpoint: Checkpoint;
    let next: ReturnType<typeof derivePublicCommit>;
    // Only admission failures are isolated. SQL writes from initialization must propagate.
    try {
      this.initialize(base);
    } catch (error) {
      if (!(error instanceof PublicProjectionUnavailableError)) throw error;
      this.markUnavailable();
      return undefined;
    }
    try {
      checkpoint = this.#read(base);
      if (checkpoint.sequence !== base.ledgerBaseSequence || checkpoint.hash !== base.ledgerBaseHash) throw new PublicProjectionUnavailableError();
      // Clone: rollback must not mutate cached admission assignments or the previous checkpoint.
      checkpoint = structuredClone(checkpoint);
      next = derivePublicCommit(checkpoint.snapshot, head.state, checkpoint.registry, evidence());
    } catch {
      this.markUnavailable();
      return undefined;
    }
    if (next.event) this.#append(checkpoint, next.event, head);
    this.#write({
      snapshot: next.snapshot,
      base: checkpoint.base,
      registry: checkpoint.registry,
      sequence: head.ledgerBaseSequence,
      hash: head.ledgerBaseHash,
      policy: checkpoint.policy,
      privacyFloor: checkpoint.privacyFloor
    });
    return next.event;
  }
  markUnavailable(): void {
    // This is still a transactional database write. Its failure must roll back both lanes.
    this.db.prepare("UPDATE public_checkpoint SET status='unavailable' WHERE singleton=1").run();
    this.invalidate();
  }
  snapshot(head: WorldSnapshot): PublicSnapshot {
    const c = this.#read(head),
      marker = this.db.prepare('SELECT version FROM public_policy WHERE singleton=1').get();
    if (c.policy !== 2 || marker?.version !== c.policy || c.sequence !== head.ledgerBaseSequence || c.hash !== head.ledgerBaseHash) throw new PublicProjectionUnavailableError();
    return structuredClone(c.snapshot);
  }
  cognition(head: WorldSnapshot, focusedResidentIds: readonly string[] = []): {
    facts: ApprovedPublicFacts;
    registry: AdmissionRegistry;
  } {
    this.snapshot(head);
    const checkpoint = this.#read(head);
    if (checkpoint.policy !== 2) throw new PublicProjectionUnavailableError();
    return {
      facts: approveFocusedCognition(head.state,{
        minute: checkpoint.snapshot.minute,
        facts: structuredClone(checkpoint.snapshot.facts)
      } as ApprovedPublicFacts,checkpoint.registry,focusedResidentIds),
      registry: structuredClone(checkpoint.registry)
    };
  }
  page(head: WorldSnapshot, query: {
    before?: number;
    limit: number;
  }): {
    events: PublicEvent[];
    nextCursor: number | null;
  } {
    this.snapshot(head);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 || query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) throw new PublicCursorError();
    const floor = this.#read(head).privacyFloor;
    const rows = this.db.prepare('SELECT event_json FROM public_outbox WHERE cursor < ? AND cursor > ? ORDER BY cursor DESC LIMIT ?').all(query.before ?? Number.MAX_SAFE_INTEGER, floor, query.limit + 1);
    const events: PublicEvent[] = [];
    let bytes = 256;
    for (const row of rows.slice(0, query.limit)) {
      if (typeof row.event_json !== 'string') throw new PublicProjectionUnavailableError();
      bytes += Buffer.byteLength(row.event_json);
      if (bytes > MAX_PUBLIC_BYTES) {
        if (!events.length) throw new PublicCursorError();
        break;
      }
      events.push(PublicEventSchema.parse(decode(row.event_json)));
    }
    return {
      events,
      nextCursor: rows.length > events.length ? events.at(-1)?.cursor ?? null : null
    };
  }
  /**
   * Writer-only bounded public feed capture at the verified canonical head. The checkpoint is
   * associated with canonical history by #read (cold replay, or this connection's own committed
   * transaction). The retained window is chosen from encoded row sizes, then events are read one
   * row at a time; the base advances only by whole validated events, never past the privacy floor
   * from below. Warm captures reuse the previously validated chain and apply only new rows.
   * A suffix that cannot be verified within budget yields an explicit snapshot-only capture.
   */
  capture(head: WorldSnapshot, limits: PublicFeedCaptureLimits = {}): PublicFeedCapture {
    const maxEvents = limits.maxEvents ?? PUBLIC_OUTBOX_RETENTION,
      maxEventBytes = limits.maxEventBytes ?? MAX_PUBLIC_BYTES,
      maxColdBytes = limits.maxColdBytes ?? 4 * MAX_PUBLIC_BYTES;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > PUBLIC_OUTBOX_RETENTION || !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 0 || maxEventBytes > MAX_PUBLIC_BYTES || !Number.isSafeInteger(maxColdBytes) || maxColdBytes < 0) throw new RangeError('invalid public feed capture limits');
    const c = this.#read(head),
      marker = this.db.prepare('SELECT version FROM public_policy WHERE singleton=1').get();
    if (c.policy !== 2 || marker?.version !== 2 || c.sequence !== head.ledgerBaseSequence || c.hash !== head.ledgerBaseHash) throw new PublicProjectionUnavailableError();
    const top = c.snapshot,
      floor = c.privacyFloor,
      lower = Math.max(c.base.cursor, floor);
    if (lower > top.cursor) throw new PublicProjectionUnavailableError();
    const chain = this.#feed?.epoch === this.#epoch && this.#feed.streamId === top.streamId && this.#feed.privacyFloor === floor && this.#feed.head.cursor <= top.cursor ? this.#feed : undefined;
    let appliedEvents = 0,
      appliedBytes = 0;
    try {
      // Plan the retained window from encoded sizes alone; no event body is loaded to choose it.
      const sizes = this.db.prepare('SELECT cursor, typeof(event_json) AS type, octet_length(event_json) AS bytes FROM public_outbox WHERE cursor > ? ORDER BY cursor DESC LIMIT ?').all(lower, PUBLIC_OUTBOX_RETENTION + 1);
      let keep = 0,
        keptBytes = 0;
      for (const row of sizes) {
        if (row.cursor !== top.cursor - keep || row.type !== 'text' || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes)) throw new FeedAcquisitionError();
        if (keep >= maxEvents || keptBytes + row.bytes > maxEventBytes) break;
        keep++;
        keptBytes += row.bytes;
      }
      const baseCursor = top.cursor - keep;
      const chainEvent = (cursor: number) => chain?.events[cursor - chain.base.snapshot.cursor - 1];
      const chainRevision = (cursor: number) => chain && cursor === chain.base.snapshot.cursor ? chain.base.snapshot.revision : chainEvent(cursor)?.revision;
      const knownJson = (s: PublicSnapshot) => chain?.base.snapshot === s ? chain.base.json : chain?.head === s ? chain.headJson : undefined;
      let base: FeedChain['base'];
      if (baseCursor === top.cursor) base = {
        snapshot: top,
        json: knownJson(top) ?? publicCanonicalJson(top)
      };else if (chain && chain.base.snapshot.cursor === baseCursor) base = chain.base;else if (baseCursor === c.base.cursor) base = {
        snapshot: c.base,
        json: knownJson(c.base) ?? publicCanonicalJson(c.base)
      };else {
        let snapshot = chain && chain.base.snapshot.cursor > c.base.cursor && chain.base.snapshot.cursor < baseCursor ? chain.base.snapshot : c.base;
        while (snapshot.cursor < baseCursor) {
          const cursor = snapshot.cursor + 1,
            json = chainEvent(cursor)?.json ?? this.#outboxEventJson(cursor);
          appliedBytes += Buffer.byteLength(json);
          if (appliedBytes > maxColdBytes) throw new FeedAcquisitionError();
          snapshot = this.#apply(snapshot, PublicEventSchema.parse(JSON.parse(json)));
          appliedEvents++;
        }
        base = {
          snapshot,
          json: publicCanonicalJson(snapshot)
        };
      }
      const events: PublicFeedCapturedEvent[] = [];
      let running = base.snapshot,
        path: 'warm' | 'cold' = 'cold';
      if (chain && chain.head.cursor >= baseCursor && chainRevision(baseCursor) === base.snapshot.revision) {
        path = 'warm';
        for (let cursor = baseCursor + 1; cursor <= chain.head.cursor; cursor++) {
          const event = chainEvent(cursor);
          if (event?.cursor !== cursor) throw new FeedAcquisitionError();
          events.push(event);
        }
        if (chain.head.cursor > baseCursor) running = chain.head;
      }
      for (let cursor = running.cursor + 1; cursor <= top.cursor; cursor++) {
        const json = this.#outboxEventJson(cursor),
          event = PublicEventSchema.parse(JSON.parse(json)),
          bytes = Buffer.byteLength(json);
        running = this.#apply(running, event);
        appliedEvents++;
        appliedBytes += bytes;
        events.push(Object.freeze({
          cursor,
          revision: event.revision,
          json,
          bytes
        }));
      }
      // #apply recomputed every revision from content, so the replayed chain ends exactly at the
      // verified head when stream, cursor and revision agree; no second full serialization is needed.
      if (events.length !== keep || events.reduce((n, e) => n + e.bytes, 0) !== keptBytes || running.streamId !== top.streamId || running.cursor !== top.cursor || running.revision !== top.revision) throw new FeedAcquisitionError();
      const headJson = knownJson(top) ?? publicCanonicalJson(top);
      this.#feed = {
        epoch: this.#epoch,
        streamId: top.streamId,
        privacyFloor: floor,
        base,
        events,
        head: top,
        headJson
      };
      return Object.freeze({
        policy: 2,
        streamId: top.streamId,
        privacyFloor: floor,
        base: captured(base.snapshot, base.json),
        head: captured(top, headJson),
        events: Object.freeze([...events]),
        mode: 'replay',
        acquisition: Object.freeze({
          path,
          appliedEvents,
          appliedBytes
        })
      });
    } catch {
      // The head remains the verified checkpoint. No partial suffix is ever reported.
      this.#feed = undefined;
      const headJson = publicCanonicalJson(top),
        only = captured(top, headJson);
      return Object.freeze({
        policy: 2,
        streamId: top.streamId,
        privacyFloor: floor,
        base: only,
        head: only,
        events: Object.freeze([]),
        mode: 'snapshot-only',
        acquisition: Object.freeze({
          path: 'cold',
          appliedEvents,
          appliedBytes
        })
      });
    }
  }
  #outboxEventJson(cursor: number): string {
    const row = this.db.prepare('SELECT event_json FROM public_outbox WHERE cursor=?').get(cursor);
    if (typeof row?.event_json !== 'string' || Buffer.byteLength(row.event_json) > MAX_PUBLIC_BYTES) throw new FeedAcquisitionError();
    return row.event_json;
  }
  eventsAfter(head: WorldSnapshot, cursor: number, limit = PUBLIC_OUTBOX_RETENTION): PublicEvent[] {
    const snapshot = this.snapshot(head),
      c = this.#read(head);
    if (!Number.isSafeInteger(cursor) || cursor < Math.max(c.base.cursor, c.privacyFloor) || cursor > snapshot.cursor || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000 || snapshot.cursor - cursor > limit) throw new PublicCursorError();
    let bytes = 0;
    const events: PublicEvent[] = [];
    for (const row of this.db.prepare('SELECT event_json FROM public_outbox WHERE cursor>? ORDER BY cursor LIMIT ?').all(cursor, limit)) {
      if (typeof row.event_json !== 'string') throw new PublicProjectionUnavailableError();
      bytes += Buffer.byteLength(row.event_json);
      if (bytes > MAX_PUBLIC_BYTES) throw new PublicCursorError();
      events.push(PublicEventSchema.parse(decode(row.event_json)));
    }
    return events;
  }
}
