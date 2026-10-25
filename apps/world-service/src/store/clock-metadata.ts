import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@meridian/world-ledger";

function checksum(epochMilliseconds: number, genesisStateHash: string): string {
  return createHash("sha256").update(canonicalJson({ version: 1, epochMilliseconds, genesisStateHash })).digest("hex");
}

export function insertClockMetadata(database: DatabaseSync, epochMilliseconds: number, genesisStateHash: string): void {
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) throw new RangeError("invalid clock epoch");
  // Called only inside the initial-snapshot transaction. No migration on ordinary open.
  database.exec(`
    CREATE TABLE world_clock (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL CHECK(version = 1),
      epoch_ms INTEGER NOT NULL CHECK(epoch_ms >= 0 AND epoch_ms <= 9007199254740991),
      genesis_state_hash TEXT NOT NULL,
      metadata_hash TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER world_clock_no_update BEFORE UPDATE ON world_clock
      BEGIN SELECT RAISE(ABORT, 'world clock is immutable'); END;
    CREATE TRIGGER world_clock_no_delete BEFORE DELETE ON world_clock
      BEGIN SELECT RAISE(ABORT, 'world clock is immutable'); END;
  `);
  database.prepare("INSERT INTO world_clock VALUES (1, 1, ?, ?, ?)")
    .run(epochMilliseconds, genesisStateHash, checksum(epochMilliseconds, genesisStateHash));
}

export function readClockEpoch(database: DatabaseSync): number | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_clock'").get()) return undefined;
  const rows = database.prepare("SELECT id, version, epoch_ms, genesis_state_hash, metadata_hash FROM world_clock LIMIT 2").all();
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== 1 || row.version !== 1 ||
      typeof row.epoch_ms !== "number" || !Number.isSafeInteger(row.epoch_ms) || row.epoch_ms < 0 ||
      typeof row.genesis_state_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.genesis_state_hash) ||
      row.metadata_hash !== checksum(row.epoch_ms, row.genesis_state_hash)) {
    throw new Error("invalid world clock metadata");
  }
  const genesis = database.prepare("SELECT state_json, state_hash FROM snapshots WHERE sequence = 0").get();
  if (!genesis || typeof genesis.state_json !== "string" || genesis.state_hash !== row.genesis_state_hash ||
      createHash("sha256").update(genesis.state_json).digest("hex") !== row.genesis_state_hash) {
    throw new Error("world clock genesis binding mismatch");
  }
  return row.epoch_ms;
}
