/**
 * Committed civic project progress → how many finished pieces the city shows. Pure and bounded:
 * one piece per recorded step of progress, never an inferred or partial piece.
 */
export const CIVIC_PIECES = Object.freeze({
  "square-benches": { step: 25, max: 4 },
  "promenade-lanterns": { step: 20, max: 5 },
  "market-planters": { step: 20, max: 5 },
  "public-map-boards": { step: 50, max: 2 },
} as const);
export type CivicProjectId = keyof typeof CIVIC_PIECES;

export function civicPieceCount(projectId: CivicProjectId, progress: number | undefined): number {
  const rule = CIVIC_PIECES[projectId];
  const value = typeof progress === "number" && Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
  return Math.min(rule.max, Math.floor(value / rule.step));
}
