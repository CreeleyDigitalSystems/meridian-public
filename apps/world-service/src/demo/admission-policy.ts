import type { WorldSnapshot } from '@meridian/world-schema';
import type { LedgerEntry } from '@meridian/world-ledger';
import { hasConfiguredWorkbench, validateNewMethodAdmissions as validateConfiguredAdmissions } from '../resident-workbench/trusted-completion.js';
export { validateMethodHashes, validateLearnerHashes } from '../resident-workbench/trusted-completion.js';

/** This synthetic demo has no executor or admission authority. Unsupported executable work refuses. */
export function validateNewMethodAdmissions(store: object, snapshot: WorldSnapshot, entries: readonly LedgerEntry[]): void {
  if (hasConfiguredWorkbench(store)) return validateConfiguredAdmissions(store, snapshot, entries);
  const invention = snapshot.state.life?.invention;
  if (Object.keys(invention?.methods ?? {}).length || Object.values(invention?.grants ?? {}).some(g => g.method)
      || entries.some(e => e.event.type === 'invention-method-changed'
        || e.event.type === 'invention-grant-changed' && e.event.after.method)) {
    throw new Error('Executable method admission is unavailable in the synthetic demo');
  }
}
