import type { ResidentVisualState } from './projection-visuals.js';
export { ADULT_PRESENTATION_CATALOGUE, COMPLEXION_TONE, selectAdultPresentation, resolveResidentPresentation } from '../../world-schema/src/resident-appearance.js';
/** Procedural rigs are the chosen public-demo representation. No model URL or failed-load fallback. */
export function residentModelUrl(_resident: Partial<ResidentVisualState>): undefined { return undefined; }
export function selectSkinnedResidents(_ranked: readonly string[], _current: readonly string[], _capacity: number): string[] { return []; }
