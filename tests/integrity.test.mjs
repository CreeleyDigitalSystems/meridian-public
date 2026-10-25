import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openSyntheticWorld } from '../apps/world-service/src/demo/engine.ts';
import { validateNewMethodAdmissions, validateMethodHashes, validateLearnerHashes } from '../apps/world-service/src/demo/admission-policy.ts';

const scratch = fileURLToPath(new URL('../.test-data/', import.meta.url));
mkdirSync(scratch, { recursive: true });

test('a corrupt synthetic ledger refuses cold restart instead of resetting or continuing a fallback head', () => {
  const directory = mkdtempSync(join(scratch, 'corrupt-'));
  let world;
  try {
    world = openSyntheticWorld(directory);
    world.advance(3);
    world.close();
    const db = new DatabaseSync(join(directory, 'synthetic.sqlite'));
    db.prepare('UPDATE ledger SET hash=? WHERE sequence=(SELECT max(sequence) FROM ledger)').run('1'.repeat(64));
    db.close();
    assert.throws(() => openSyntheticWorld(directory));
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('without an execution authority the demo refuses method and executable lesson admissions', () => {
  const directory = mkdtempSync(join(scratch, 'authority-'));
  let world;
  try {
    world = openSyntheticWorld(directory);
    const snapshot = world.snapshot();
    // Explicit unsupported boundary input: this is not a valid authored method or a claimed execution.
    snapshot.state.life.invention = { methods: { unsupported: {} } };
    assert.throws(() => validateNewMethodAdmissions({}, snapshot, []), /unavailable/);
    assert.throws(() => validateMethodHashes({}));
    assert.throws(() => validateLearnerHashes({}));
  } finally { world?.close(); rmSync(directory, { recursive: true, force: true }); }
});
