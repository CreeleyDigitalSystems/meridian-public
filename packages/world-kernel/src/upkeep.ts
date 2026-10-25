import type { ResidentLifeState } from "@meridian/world-schema";

/**
 * Finished work wears. Without this a completed city offers its residents nothing but work and
 * rest: every venture template is withheld while its project sits at 100, so the menu collapses.
 *
 * Wear is deterministic and rides the existing `life-project-changed` event, which the minute
 * already emits by diffing projects. No new event type, so older readers stay compatible.
 */

/** How often finished work wears, in committed minutes. */
export const UPKEEP_INTERVAL_MINUTES = 120;
/** Progress each maintained project loses at an upkeep minute. One venture roughly repairs one wear. */
export const UPKEEP_WEAR = 20;
/**
 * Wear never takes a project below this: a city that needs maintaining must not look abandoned.
 * 50 is deliberate — it is the largest piece step in the renderer (the map boards), so every
 * civic improvement keeps at least one finished piece standing however long it is neglected.
 */
export const UPKEEP_FLOOR = 50;

/** True on the minutes when finished work wears. Minute 0 is the founding, never a wear minute. */
export function isUpkeepMinute(minute: number): boolean {
  return minute > 0 && minute % UPKEEP_INTERVAL_MINUTES === 0;
}

/**
 * Wears every project above the floor, in place. Returns the ids worn, in id order.
 * Purely a function of the minute and the current progress, so replay reproduces it exactly.
 */
export function applyUpkeep(life: ResidentLifeState, minute: number): string[] {
  if (!isUpkeepMinute(minute)) return [];
  const worn: string[] = [];
  for (const id of Object.keys(life.projects).sort()) {
    const project = life.projects[id]!;
    if (project.progress <= UPKEEP_FLOOR) continue;
    project.progress = Math.max(UPKEEP_FLOOR, project.progress - UPKEEP_WEAR);
    worn.push(id);
  }
  return worn;
}
