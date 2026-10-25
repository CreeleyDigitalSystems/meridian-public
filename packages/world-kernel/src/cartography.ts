import type { ChartEntry, ResidentLifeProfile, WorldState } from "@meridian/world-schema";

/**
 * Cartography: residents who map the city for real.
 *
 * A cartographer's "work" used to be a generic ten-minute task that changed nothing. Now they walk
 * to a place, survey it, and record what is actually there — who is standing in it and how far
 * each project at it has come — read from committed state at the minute the survey finishes. The
 * chart is shared by every cartographer, so the city is mapped collectively, and each entry keeps
 * its surveyor. The world keeps changing (upkeep wears projects, meetings move people), so charts go
 * stale and there is always something left to re-survey.
 *
 * Deterministic and bounded: the chart holds at most one entry per public place.
 */

export const CARTOGRAPHER_OCCUPATION = "Cartographer";
/** Committed minutes a survey takes, the same order as a shift of ordinary work. */
export const SURVEY_MINUTES = 12;
/**
 * A chart entry older than this, in committed minutes, is worth surveying again. Eight world hours:
 * measured, ten cartographers chart all 125 public places in about 480 minutes, so a longer window
 * leaves them nothing to survey for most of the day and they fall back into plain work. Eight hours
 * also means a place is re-charted at a different time of day, when it genuinely looks different.
 */
export const CHART_STALE_MINUTES = 480;
/** How many places a cartographer is offered at once, keeping the decision menu small. */
export const MAX_SURVEY_OPTIONS = 3;
const MAX_SEEN = 3;
const MAX_PROJECTS = 8;

export function isCartographer(profile: ResidentLifeProfile): boolean {
  return profile.skills.occupation === CARTOGRAPHER_OCCUPATION;
}

/** Places worth charting: everywhere except private homes. */
export function isChartable(state: WorldState, placeId: string): boolean {
  const place = Object.hasOwn(state.places, placeId) ? state.places[placeId] : undefined;
  return place !== undefined && place.kind !== "residence";
}

/**
 * The places this cartographer should survey next, best first: somewhere never charted before
 * somewhere merely stale; where they already stand before anywhere else; public places before
 * workplaces; then the oldest survey, then id. A place another resident is already surveying is
 * skipped, so several cartographers spread across the city instead of converging on one target.
 */
export function surveyTargets(state: WorldState, residentId: string): string[] {
  const life = state.life;
  if (!life) return [];
  const charts = life.charts ?? {};
  const here = state.residents[residentId]?.placeId;
  const claimed = new Set<string>();
  for (const profile of Object.values(life.residents)) {
    if (profile.residentId !== residentId && profile.task?.kind === "survey") claimed.add(profile.task.placeId);
  }
  const minute = state.canonicalMinute;
  const candidates = Object.keys(state.places).filter((placeId) => {
    if (!isChartable(state, placeId) || claimed.has(placeId)) return false;
    const entry = Object.hasOwn(charts, placeId) ? charts[placeId] : undefined;
    return entry === undefined || minute - entry.surveyedMinute >= CHART_STALE_MINUTES;
  });
  const rank = (placeId: string) => {
    const entry = Object.hasOwn(charts, placeId) ? charts[placeId] : undefined;
    return [
      entry === undefined ? 0 : 1,
      placeId === here ? 0 : 1,
      state.places[placeId]!.kind === "workplace" ? 1 : 0,
      entry?.surveyedMinute ?? -1,
    ];
  };
  return candidates.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return a.localeCompare(b);
  }).slice(0, MAX_SURVEY_OPTIONS);
}

/** What a surveyor finds at a place right now. Pure: reads committed state, invents nothing. */
export function observePlace(state: WorldState, placeId: string, surveyorId: string, minute: number): ChartEntry {
  const present = Object.values(state.residents).filter((resident) => resident.placeId === placeId).map((resident) => resident.id).sort();
  const projects = Object.values(state.life?.projects ?? {})
    .filter((project) => project.placeId === placeId)
    .map((project) => ({ projectId: project.id, progress: project.progress }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
    .slice(0, MAX_PROJECTS);
  return { placeId, surveyorId, surveyedMinute: minute, present: present.length, seen: present.slice(0, MAX_SEEN), projects };
}

/** A memory worth keeping: the place by name and the facts found there, within the memory cap. */
export function describeChart(state: WorldState, entry: ChartEntry): string {
  const name = Object.hasOwn(state.places, entry.placeId) ? state.places[entry.placeId]!.name : entry.placeId;
  // `present` counts the surveyor too; the memory reports who else was there, not herself.
  const surveyorHere = state.residents[entry.surveyorId]?.placeId === entry.placeId;
  const others = Math.max(0, entry.present - (surveyorHere ? 1 : 0));
  const people = others === 0 ? "nobody else there" : others === 1 ? "1 other person there" : `${others} others there`;
  const built = entry.projects.map((p) => {
    const label = Object.hasOwn(state.life?.projects ?? {}, p.projectId) ? state.life!.projects[p.projectId]!.label : p.projectId;
    return `${label.toLowerCase()} at ${p.progress}%`;
  });
  const fact = `Charted ${name}: ${people}${built.length ? `; ${built.join(", ")}` : ""}.`;
  return Array.from(fact).length <= 240 ? fact : `${Array.from(fact).slice(0, 239).join("")}…`;
}
