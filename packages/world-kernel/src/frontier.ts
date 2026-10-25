import { FRONTIER_SHIFT_MINUTES, FRONTIER_CHART_EFFORT, type FrontierBuildKind, type FrontierParcel, type ResidentLifeProfile, type ResidentLifeState, type ResidentTask, type WorldEvent, type WorldState } from "@meridian/world-schema";
import { availableStock, type ReservationLedger } from "./discovery-core.js";

/**
 * The frontier (constitution D-8): ground beyond the charted city, under fog.
 *
 * Parcels sit in concentric rings around the city; ring r holds 8r slots, and each parcel in ring r+1
 * has exactly one inward parent. A parcel exists in state only once revealed — ring 1 when the
 * frontier opens, a parcel's outward children when it is charted — so the grid is unbounded but only
 * as large as residents have made it (D-5). "If fog, can't cross" (D-6): fog lifts only through
 * finished work by residents who chose it (P-25, A-32), never by time.
 */

/** Committed minutes one shift at the edge takes, for the cartographer and for anyone helping. */
export const FRONTIER_TASK_MINUTES = FRONTIER_SHIFT_MINUTES;
/** Effort a finished shift adds: a cartographer's skill counts double. */
export const FRONTIER_LEAD_EFFORT = 2;
export const FRONTIER_HELP_EFFORT = 1;
/** Where residents work the edge from: the city's waterside, facing the fog. */
export const FRONTIER_WORK_PLACE_ID = "city-promenade";
/** How many fog parcels a cartographer is offered at once, keeping the decision menu small. */
export const MAX_FRONTIER_OPTIONS = 2;
export const MAX_FRONTIER_RING = 64;
const MAX_CONTRIBUTORS = 8;

const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

export function frontierParcelId(ring: number, slot: number): string {
  return `parcel:${ring}:${slot}`;
}

/** The slots in ring r+1 whose inward parent is slot `slot` of ring r. */
export function outwardSlots(ring: number, slot: number): number[] {
  if (ring >= MAX_FRONTIER_RING) return [];
  const result: number[] = [];
  for (let next = 0; next < 8 * (ring + 1); next += 1) if (Math.floor((next * ring) / (ring + 1)) === slot) result.push(next);
  return result;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

/** The compass direction of a parcel's centre from the city, so a resident's choice reads as a place. */
export function frontierDirection(parcel: Pick<FrontierParcel, "ring" | "slot">): string {
  const degrees = ((parcel.slot + 0.5) / (8 * parcel.ring)) * 360;
  return COMPASS[Math.round(degrees / 45) % 8]!;
}

export function frontierParcelName(parcel: Pick<FrontierParcel, "ring" | "slot">): string {
  return `the fog to the ${frontierDirection(parcel)} (ring ${parcel.ring})`;
}

function fogParcel(ring: number, slot: number): FrontierParcel {
  return { id: frontierParcelId(ring, slot), ring, slot, state: "fog", effort: 0, contributors: [] };
}

const byPosition = (a: FrontierParcel, b: FrontierParcel) => a.ring - b.ring || a.slot - b.slot;

/** Effort already on its way to each parcel: shifts under way that will add to it when they finish. */
function effortUnderWay(state: WorldState): Map<string, number> {
  const pending = new Map<string, number>();
  for (const profile of Object.values(state.life?.residents ?? {})) {
    const task = profile.task;
    if (!task?.parcelId || (task.kind !== "chart-frontier" && task.kind !== "help-chart")) continue;
    pending.set(task.parcelId, (pending.get(task.parcelId) ?? 0) + (task.kind === "chart-frontier" ? FRONTIER_LEAD_EFFORT : FRONTIER_HELP_EFFORT));
  }
  return pending;
}

/** True when the work already done and under way will lift this parcel's fog: nobody else is needed there. */
const covered = (parcel: FrontierParcel, pending: Map<string, number>) => parcel.effort + (pending.get(parcel.id) ?? 0) >= FRONTIER_CHART_EFFORT;

/**
 * Fog parcels a cartographer should work next: the most-worked first (finish what was started), then
 * inner rings, then slot. A parcel whose fog will already lift from shifts under way is skipped, so
 * several cartographers spread across the edge instead of piling onto one parcel.
 */
export function frontierTargets(state: WorldState, reachable: (parcel: FrontierParcel) => boolean = () => true): FrontierParcel[] {
  const frontier = state.life?.frontier;
  if (!frontier) return [];
  const pending = effortUnderWay(state);
  return Object.values(frontier).filter((p) => p.state === "fog" && !covered(p, pending) && reachable(p)).sort((a, b) => b.effort - a.effort || byPosition(a, b)).slice(0, MAX_FRONTIER_OPTIONS);
}

/** Fog parcels someone other than this resident is working right now: the only ones they may join (R-3). */
export function frontierBeingCharted(state: WorldState, residentId: string, leading: (task: ResidentTask) => boolean = () => true, reachable: (parcel: FrontierParcel) => boolean = () => true): FrontierParcel[] {
  const life = state.life;
  const frontier = life?.frontier;
  if (!life || !frontier) return [];
  const ids = new Set<string>();
  for (const profile of Object.values(life.residents)) {
    if (profile.residentId !== residentId && profile.task?.kind === "chart-frontier" && profile.task.parcelId && leading(profile.task)) ids.add(profile.task.parcelId);
  }
  const pending = effortUnderWay(state);
  return [...ids].map((id) => own(frontier, id)).filter((p): p is FrontierParcel => p !== undefined && p.state === "fog" && !covered(p, pending) && reachable(p)).sort(byPosition);
}

/**
 * A finished shift at the edge. Adds effort to a parcel still under fog; when the effort is complete the
 * fog lifts and the parcel's outward children appear under fog. A parcel someone else finished first
 * takes no more effort. Returns what happened, for the resident's memory.
 */
export function applyFrontierWork(life: ResidentLifeState, parcelId: string, residentId: string, effort: number, minute: number): "worked" | "charted" | "already-charted" | "missing" {
  const frontier = life.frontier;
  const parcel = frontier ? own(frontier, parcelId) : undefined;
  if (!frontier || !parcel) return "missing";
  if (parcel.state === "charted") return "already-charted";
  const contributors = parcel.contributors.includes(residentId) || parcel.contributors.length >= MAX_CONTRIBUTORS ? parcel.contributors : [...parcel.contributors, residentId].sort();
  const total = Math.min(FRONTIER_CHART_EFFORT, parcel.effort + effort);
  if (total < FRONTIER_CHART_EFFORT) {
    frontier[parcelId] = { ...parcel, effort: total, contributors };
    return "worked";
  }
  frontier[parcelId] = { ...parcel, state: "charted", effort: total, contributors, chartedMinute: minute };
  for (const slot of outwardSlots(parcel.ring, parcel.slot)) {
    const id = frontierParcelId(parcel.ring + 1, slot);
    if (!Object.hasOwn(frontier, id)) frontier[id] = fogParcel(parcel.ring + 1, slot);
  }
  return "charted";
}

/**
 * One-time zero-minute migration that opens the frontier on an existing city-life-2 world: ring 1,
 * eight parcels, all under fog. A world that already has a frontier, or no waterside to work from,
 * is returned unchanged.
 */
export function migrateFrontier(input: WorldState): { state: WorldState; event?: Extract<WorldEvent, { type: "frontier-opened" }> } {
  if (input.engineVersion !== "city-life-2" || !input.life || input.life.frontier || !Object.hasOwn(input.places, FRONTIER_WORK_PLACE_ID)) return { state: input };
  const parcels: Record<string, FrontierParcel> = {};
  for (let slot = 0; slot < 8; slot += 1) parcels[frontierParcelId(1, slot)] = fogParcel(1, slot);
  const state = structuredClone(input);
  state.life!.frontier = structuredClone(parcels);
  return { state, event: { type: "frontier-opened", minute: input.canonicalMinute, parcels } };
}

/**
 * Building on charted ground (D-8 slice 2). A bounded catalogue of public places (A-P36): a Builder, or
 * anyone with real building skill, founds one on a free charted parcel, paying its materials from the
 * city stores at once; anyone may choose to join the crew (R-3); when the work is done the place exists
 * and residents can meet there. Homes and workplaces wait for a later slice.
 */
export interface FrontierBuildSpec { kind: FrontierBuildKind; label: string; stone: number; timber: number; effort: number }
export const FRONTIER_BUILDS: readonly FrontierBuildSpec[] = Object.freeze([
  { kind: "gathering-hall", label: "Gathering Hall", stone: 6, timber: 4, effort: 12 },
  { kind: "garden-terrace", label: "Garden Terrace", stone: 2, timber: 2, effort: 8 },
  { kind: "lookout", label: "Lookout", stone: 6, timber: 2, effort: 10 },
  { kind: "market-stalls", label: "Market Stalls", stone: 2, timber: 4, effort: 8 },
  { kind: "workshop", label: "Workshop", stone: 4, timber: 4, effort: 10 },
  { kind: "home", label: "Home", stone: 3, timber: 3, effort: 8 },
]);
export const FRONTIER_BUILD_SKILL = 40;
const BUILDER_OCCUPATION = "Builder";

const spec = (kind: FrontierBuildKind) => FRONTIER_BUILDS.find((s) => s.kind === kind)!;
const stock = (life: ResidentLifeState, resourceId: string) => {
  const resource = life.ventures && Object.hasOwn(life.ventures.resources, resourceId) ? life.ventures.resources[resourceId] : undefined;
  return resource ? availableStock(resource as ReservationLedger) : 0;
};

export function canBuild(profile: ResidentLifeProfile): boolean {
  return profile.skills.occupation === BUILDER_OCCUPATION || profile.skills.building >= FRONTIER_BUILD_SKILL;
}

/** The founded place's id and public name, fixed by the parcel. */
export function frontierPlace(parcel: Pick<FrontierParcel, "ring" | "slot">, kind: FrontierBuildKind): { id: string; name: string; kind: "civic" | "residence" } {
  // From ring 2 a compass direction spans several parcels, so the plot number keeps every name unique.
  return { id: `frontier-${parcel.ring}-${parcel.slot}`, name: `${spec(kind).label}, ${frontierDirection(parcel)} (ring ${parcel.ring}, plot ${parcel.slot + 1})`, kind: kind === "home" ? "residence" : "civic" };
}

/**
 * Empty frontier homes this resident may move into (slice 3). Only an adult who lives alone moves:
 * nobody who shares a home leaves it on their own, so families and children stay together (F-6, H-15).
 * Engine-driven residents move only into a home they helped build; a model resident may choose any (R-6).
 */
export function homesToMoveInto(state: WorldState, residentId: string): { parcel: FrontierParcel; placeId: string }[] {
  const frontier = state.life?.frontier;
  const resident = Object.hasOwn(state.residents, residentId) ? state.residents[residentId] : undefined;
  if (!frontier || !resident || resident.lifeStage === "child") return [];
  const residents = Object.values(state.residents);
  if (residents.some((r) => r.id !== residentId && r.homePlaceId === resident.homePlaceId)) return [];
  return Object.values(frontier)
    .filter((p) => p.builtKind === "home" && p.placeId && p.placeId !== resident.homePlaceId && !residents.some((r) => r.homePlaceId === p.placeId))
    .sort(byPosition).map((parcel) => ({ parcel, placeId: parcel.placeId! }));
}

/** Moves a resident's home, and every home block of their day with it. Returns false if the move is no longer possible. */
export function moveHome(state: WorldState, residentId: string, placeId: string): boolean {
  if (!homesToMoveInto(state, residentId).some((h) => h.placeId === placeId)) return false;
  const resident = state.residents[residentId]!;
  const previous = resident.homePlaceId;
  state.residents[residentId] = {
    ...resident, homePlaceId: placeId,
    schedule: resident.schedule.map((entry) => entry.placeId === previous ? { ...entry, placeId } : entry),
  };
  return true;
}

/** Free charted ground nearest the city first: charted, nothing standing and nothing being built. */
export function freeFrontierParcel(state: WorldState, reachable: (parcel: FrontierParcel) => boolean = () => true): FrontierParcel | undefined {
  const frontier = state.life?.frontier;
  if (!frontier) return undefined;
  return Object.values(frontier).filter((p) => p.state === "charted" && !p.build && !p.placeId && reachable(p)).sort(byPosition)[0];
}

/** What this resident could found right now, and where: every catalogue entry the stores can pay for. */
export function foundingOptions(state: WorldState, residentId: string, reachable: (parcel: FrontierParcel) => boolean = () => true): { parcel: FrontierParcel; spec: FrontierBuildSpec }[] {
  const life = state.life;
  const profile = life && own(life.residents, residentId);
  if (!life?.frontier || !profile || !canBuild(profile)) return [];
  if (Object.values(life.frontier).some((p) => p.build?.proposerId === residentId)) return [];
  const parcel = freeFrontierParcel(state, reachable);
  if (!parcel) return [];
  return FRONTIER_BUILDS.filter((s) => stock(life, "stone") >= s.stone && stock(life, "timber") >= s.timber).map((s) => ({ parcel, spec: s }));
}

/** Builds under way, nearest first: anyone may take a shift on one, founder and crew included. */
export function buildsUnderWay(state: WorldState): FrontierParcel[] {
  const frontier = state.life?.frontier;
  if (!frontier) return [];
  return Object.values(frontier).filter((p) => p.build).sort(byPosition);
}

export function frontierBuildLabel(kind: FrontierBuildKind): string {
  return FRONTIER_BUILDS.find((s) => s.kind === kind)!.label;
}

/** Starts a build: the founder pays its materials from the stores at once. False if they can no longer be paid. */
export function startFrontierBuild(life: ResidentLifeState, parcelId: string, kind: FrontierBuildKind, residentId: string, minute: number): boolean {
  const parcel = life.frontier && own(life.frontier, parcelId);
  const s = spec(kind);
  if (!parcel || parcel.state !== "charted" || parcel.build || parcel.placeId) return false;
  if (stock(life, "stone") < s.stone || stock(life, "timber") < s.timber) return false;
  life.ventures!.resources["stone"]!.stock -= s.stone;
  life.ventures!.resources["timber"]!.stock -= s.timber;
  life.frontier![parcelId] = { ...parcel, build: { kind, proposerId: residentId, startedMinute: minute, effort: 0, crew: [] } };
  return true;
}

/**
 * A finished building shift. Builders add 2, everyone else 1; when the catalogue effort is reached the
 * place is founded and returned, and the parcel records it.
 */
export function applyBuildWork(state: WorldState, parcelId: string, residentId: string, minute: number): { outcome: "worked" | "founded" | "gone"; place?: { id: string; name: string; kind: "civic" | "residence" } } {
  const life = state.life!;
  const parcel = life.frontier && own(life.frontier, parcelId);
  if (!parcel?.build) return { outcome: "gone" };
  const profile = life.residents[residentId]!;
  const build = parcel.build;
  const crew = build.crew.includes(residentId) || build.crew.length >= MAX_CONTRIBUTORS ? build.crew : [...build.crew, residentId].sort();
  const effort = Math.min(spec(build.kind).effort, build.effort + (profile.skills.occupation === BUILDER_OCCUPATION ? 2 : 1));
  if (effort < spec(build.kind).effort) {
    life.frontier![parcelId] = { ...parcel, build: { ...build, effort, crew } };
    return { outcome: "worked" };
  }
  const place = frontierPlace(parcel, build.kind);
  const { build: _finished, ...rest } = parcel;
  const builtBy = [...new Set([build.proposerId, ...crew])].sort();
  life.frontier![parcelId] = { ...rest, placeId: place.id, builtKind: build.kind, builtBy };
  // A new record, never a write into the shared one: the minute's working state shares `places` with
  // its input, and the minute's place-founded event is found by comparing the two.
  state.places = { ...state.places, [place.id]: place };
  return { outcome: "founded", place };
}
