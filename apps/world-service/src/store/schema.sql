CREATE TABLE IF NOT EXISTS ledger(
  sequence INTEGER PRIMARY KEY,
  previous_hash TEXT,
  hash TEXT,
  event_json TEXT
);

CREATE TABLE IF NOT EXISTS snapshots(
  sequence INTEGER PRIMARY KEY,
  state_json TEXT,
  state_hash TEXT,
  created_at TEXT,
  canonical_minute INTEGER
);

-- Derived index of accepted local-model decisions (rebuildable from the ledger; never the record).
-- kind/label come from the first same-resident same-minute resident-life-changed after the decision;
-- resolved = 1 once that event has been seen (its task may still leave kind/label null).
CREATE TABLE IF NOT EXISTS ai_decisions(
  sequence INTEGER PRIMARY KEY,
  resident_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  option_id TEXT NOT NULL,
  kind TEXT,
  label TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ai_decisions_pending ON ai_decisions(resident_id, minute) WHERE resolved = 0;

CREATE TABLE IF NOT EXISTS ai_index_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Private derived public lane. Source watermark/registry never leave the writer.
CREATE TABLE IF NOT EXISTS public_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS public_checkpoint(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy_version INTEGER NOT NULL,status TEXT NOT NULL,
 source_sequence INTEGER NOT NULL,source_hash TEXT NOT NULL,checkpoint_json TEXT NOT NULL,base_json TEXT NOT NULL,registry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_outbox(cursor INTEGER PRIMARY KEY,event_json TEXT NOT NULL,source_sequence INTEGER NOT NULL,source_hash TEXT NOT NULL);

-- Canonical transaction boundaries, independent of mutable public transport metadata.
-- They preserve actual multi-event/multi-minute commits after snapshot retention prunes checkpoints.
CREATE TABLE IF NOT EXISTS canonical_commits(
 sequence INTEGER PRIMARY KEY, previous_sequence INTEGER NOT NULL,
 previous_hash TEXT NOT NULL, hash TEXT NOT NULL, state_hash TEXT NOT NULL
);
-- The actual verified canonical head at the one-time public epoch activation.
CREATE TABLE IF NOT EXISTS canonical_public_epoch(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), stream_id TEXT NOT NULL,
 source_sequence INTEGER NOT NULL, source_hash TEXT NOT NULL
);

-- Separate cognition epoch: old private intention/decision journals cannot seed this lane.
CREATE TABLE IF NOT EXISTS public_cognition_policy(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,
 source_sequence INTEGER NOT NULL,source_hash TEXT NOT NULL,cutoff_minute INTEGER NOT NULL
);

-- Versioned admission semantics, bound to an actual canonical commit boundary.
-- previous_version=0 denotes a fresh policy2 baseline, 1 an honest 0.3 cutover.
-- Original activation, ledger and transport history are never replaced.
CREATE TABLE IF NOT EXISTS canonical_public_policy(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,previous_version INTEGER NOT NULL,
 stream_id TEXT NOT NULL,source_sequence INTEGER NOT NULL,source_hash TEXT NOT NULL,
 prior_cursor INTEGER NOT NULL,prior_revision TEXT
);

-- Exact bounded policy1 bytes retained privately at cutover, before outbox pruning.
-- This is a comparison target, never independent canonical evidence.
CREATE TABLE IF NOT EXISTS public_policy_archive(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,
 checkpoint_row_json TEXT NOT NULL,outbox_json TEXT NOT NULL
);
