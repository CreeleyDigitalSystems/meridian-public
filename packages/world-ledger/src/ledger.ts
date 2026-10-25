import { createHash } from "node:crypto";

import type { WorldEvent } from "@meridian/world-schema";

import { canonicalJson } from "./canonical-json.js";

export const GENESIS_HASH = "0".repeat(64);

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface LedgerEntry {
  sequence: number;
  previousHash: string;
  event: WorldEvent;
  hash: string;
}

export type LedgerVerification =
  | { ok: true }
  | {
      ok: false;
      sequence: number;
      reason: "previous hash mismatch" | "missing sequence" | "hash mismatch" | "invalid entries";
    };

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hashBody(sequence: number, previousHash: string, event: unknown): string {
  const body = canonicalJson({ sequence, previousHash, event });
  return createHash("sha256").update(body).digest("hex");
}

function snapshotEvent(event: WorldEvent): WorldEvent {
  return JSON.parse(canonicalJson(event)) as WorldEvent;
}

export function appendLedger(previousHash: string, sequence: number, event: WorldEvent): LedgerEntry {
  if (!isHash(previousHash)) {
    throw new TypeError("previousHash must be a lowercase SHA-256 hash");
  }
  if (!isSequence(sequence)) {
    throw new TypeError("sequence must be a positive safe integer");
  }

  const eventSnapshot = snapshotEvent(event);
  return {
    sequence,
    previousHash,
    event: eventSnapshot,
    hash: hashBody(sequence, previousHash, eventSnapshot),
  };
}

function failure(
  sequence: number,
  reason: Extract<LedgerVerification, { ok: false }>['reason'],
): LedgerVerification {
  return { ok: false, sequence, reason };
}

export function verifyLedger(entries: readonly unknown[], baseHash = GENESIS_HASH): LedgerVerification {
  if (!Array.isArray(entries)) {
    return failure(0, "invalid entries");
  }
  if (entries.length === 0) {
    return { ok: true };
  }

  const hasExplicitBaseHash = arguments.length > 1;
  let previousHash = baseHash;
  let expectedSequence = 1;

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === null || typeof entry !== "object") {
        return failure(expectedSequence, "missing sequence");
      }

      const { sequence, previousHash: entryPreviousHash, event, hash } = entry as Record<string, unknown>;
      if (index === 0 && hasExplicitBaseHash && isSequence(sequence)) {
        expectedSequence = sequence;
      }

      if (!isSequence(sequence) || sequence !== expectedSequence) {
        return failure(typeof sequence === "number" ? sequence : expectedSequence, "missing sequence");
      }
      if (!isHash(previousHash) || entryPreviousHash !== previousHash) {
        return failure(sequence, "previous hash mismatch");
      }

      if (!isHash(hash) || hashBody(sequence, entryPreviousHash, event) !== hash) {
        return failure(sequence, "hash mismatch");
      }

      previousHash = hash;
      expectedSequence += 1;
    }
  } catch {
    return failure(expectedSequence, "hash mismatch");
  }

  return { ok: true };
}
