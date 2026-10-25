import type { FrontierParcel, FrontierWorksite, ResidentActionProposal, TransitJourney, ResidentTask, WorldEvent, WorldState } from "@meridian/world-schema";
import { planTransitJourney, transitPlaceParcel } from "./transit-journey.js";
import { transitStationFor } from "./transit.js";
import { transitServiceAt, transitLandingPlaceId, TRANSIT_CENTRAL_WALK_MINUTES, TRANSIT_GROUND_STEP_MINUTES, frontierGroundDistance } from "@meridian/world-schema";
import {
  FRONTIER_TASK_MINUTES, FRONTIER_WORK_PLACE_ID, buildsUnderWay, foundingOptions, frontierBeingCharted, frontierParcelId,
  frontierTargets, outwardSlots, type FrontierBuildSpec,
} from "./frontier.js";

/**
 * Frontier access, policy 1 (spatial coherence): residents must physically be at the frontier to work it.
 *
 * Before this policy every chart, help and build shift was worked from the city promenade, whatever parcel it
 * named, and earned at completion without a location check. Under policy 1 a shift is worked at a real
 * worksite, reached by timed travel, and earns only while the resident is there:
 *
 * - From the city, a resident walks out to the outer quay facing a ring-1 sector and charts that sector across
 *   the channel. Nothing beyond ring 1 is reachable from the city: no canonical crossing exists yet. The
 *   Transport Ruling's one-loop circuit (a separate lane) is the intended crossing; until it lands, this policy
 *   grants none.
 * - From a founded frontier place (charted ground beyond the water), a resident walks across connected charted
 *   parcels: to a charted parcel bordering the fog to chart it, or onto a build's own parcel to build. Each
 *   parcel crossed adds a step, so the walk grows with ring distance.
 *
 * Pure and deterministic: positions are canonical parcels and places, never renderer geometry.
 */

export const FRONTIER_ACCESS_POLICY = 1;
/** Minutes to walk from anywhere in the city out to the outer quay facing a ring-1 sector. */
export const FRONTIER_QUAY_WALK_MINUTES = TRANSIT_CENTRAL_WALK_MINUTES;
/** Minutes to cross one charted parcel on foot, and to step out to a worksite's edge. */
export const FRONTIER_GROUND_STEP_MINUTES = TRANSIT_GROUND_STEP_MINUTES;

const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;
const byPosition = (a: FrontierParcel, b: FrontierParcel) => a.ring - b.ring || a.slot - b.slot;
const FRONTIER_PLACE = /^frontier-(\d+)-(\d+)$/;

export function frontierAccessEnabled(state: WorldState): boolean {
  return state.life?.frontierAccess !== undefined;
}

/**
 * One-time zero-minute cutover to policy 1 on a city-life-2 world whose frontier is open. Shifts already under
 * way keep the semantics they were accepted under; only shifts begun after this minute travel. A world already
 * under the policy, or without an open frontier or a waterside, is returned unchanged.
 */
export function enableFrontierAccess(input: WorldState): { state: WorldState; event?: Extract<WorldEvent, { type: "frontier-access-enabled" }> } {
  if (input.engineVersion !== "city-life-2" || !input.life?.frontier || input.life.frontierAccess || !Object.hasOwn(input.places, FRONTIER_WORK_PLACE_ID)) return { state: input };
  const state = structuredClone(input);
  state.life!.frontierAccess = { version: 1, enabledMinute: input.canonicalMinute };
  return { state, event: { type: "frontier-access-enabled", minute: input.canonicalMinute, after: { version: 1, enabledMinute: input.canonicalMinute } } };
}

/** Parcels that share an edge with this one: both ring neighbours, the inward parent and the outward children. */
export function frontierNeighbourIds(ring: number, slot: number): string[] {
  const span = 8 * ring;
  const ids = [frontierParcelId(ring, (slot + 1) % span), frontierParcelId(ring, (slot + span - 1) % span)];
  if (ring > 1) ids.push(frontierParcelId(ring - 1, Math.floor((slot * (ring - 1)) / ring)));
  for (const child of outwardSlots(ring, slot)) ids.push(frontierParcelId(ring + 1, child));
  return [...new Set(ids)];
}

/** The charted parcel a resident stands on: only when their current place is a place founded on it. In the city, undefined. */
export function frontierGroundOf(state: WorldState, residentId: string): FrontierParcel | undefined {
  const place = state.residents[residentId]?.placeId;
  return place ? transitPlaceParcel(state, place) : undefined;
}

/** Hops across connected charted ground from `start`, breadth first. Fog and unrevealed parcels are never crossed. */
function groundHops(frontier: Readonly<Record<string, FrontierParcel>>, start: FrontierParcel): Map<string, number> {
  const hops = new Map<string, number>([[start.id, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const parcel = queue[index]!;
    const next = hops.get(parcel.id)! + 1;
    for (const id of frontierNeighbourIds(parcel.ring, parcel.slot)) {
      const neighbour = own(frontier, id);
      if (hops.has(id) || neighbour?.state !== "charted") continue;
      hops.set(id, next);
      queue.push(neighbour);
    }
  }
  return hops;
}

/** Where a shift would be worked, how long the walk there takes, and the place the resident occupies while there. */
export interface FrontierRoute { site: FrontierWorksite; travelMinutes: number; placeId: string; journey?: TransitJourney }

export interface FrontierReach {
  /** Route to a worksite bordering this fog parcel, or undefined when none can be reached. */
  fog(parcel: FrontierParcel): FrontierRoute | undefined;
  /** Route onto this charted parcel (a build's own site), or undefined when it cannot be reached. */
  ground(parcel: FrontierParcel): FrontierRoute | undefined;
}

/** One resident's reach under policy 1, computed from where they stand now. */
export function frontierReach(state: WorldState, residentId: string, minute = state.canonicalMinute + 1): FrontierReach {
  const frontier = state.life?.frontier ?? {};
  const resident = own(state.residents, residentId);
  const standing = frontierGroundOf(state, residentId);
  const inCity = resident !== undefined && standing === undefined && Object.hasOwn(state.places, FRONTIER_WORK_PLACE_ID);
  let hops: Map<string, number> | undefined;
  const hopsTo = (id: string) => (hops ??= standing ? groundHops(frontier, standing) : new Map()).get(id);
  const walk = (parcelHops: number) => (parcelHops + 1) * FRONTIER_GROUND_STEP_MINUTES;
  const crossing = (parcel: FrontierParcel): FrontierRoute | undefined => {
    const transit = state.life?.transit;
    if (!inCity || !transit) return undefined;
    const reach = transitStationFor(frontier, transitServiceAt(transit, minute).route, parcel.id);
    if (!reach) return undefined;
    const station = frontier[reach.station]!;
    const placeId = station.placeId ?? transitLandingPlaceId(reach.station);
    const toStation = planTransitJourney(state, residentId, placeId, minute);
    if (!toStation) return undefined;
    const arrivesMinute = toStation.arrivesMinute + (reach.walk.length - 1) * FRONTIER_GROUND_STEP_MINUTES;
    return { site: { kind: "ground", parcelId: parcel.id }, travelMinutes: arrivesMinute - minute, placeId,
      journey: { ...toStation, arrivesMinute } };
  };
  return {
    fog(parcel) {
      if (!resident || parcel.state !== "fog") return undefined;
      // The quays face ring 1 across the channel; the city reaches nothing further without a crossing.
      if (inCity) {
        if (parcel.ring === 1) return { site: { kind: "quay", sector: parcel.slot }, travelMinutes: FRONTIER_QUAY_WALK_MINUTES, placeId: FRONTIER_WORK_PLACE_ID };
        return frontierNeighbourIds(parcel.ring, parcel.slot).map(id => frontier[id]).filter((p): p is FrontierParcel => p?.state === "charted").sort(byPosition).map(crossing).filter((r): r is FrontierRoute => !!r).sort((a,b) => a.travelMinutes - b.travelMinutes)[0];
      }
      if (!standing) return undefined;
      const edges = frontierNeighbourIds(parcel.ring, parcel.slot).map((id) => own(frontier, id))
        .filter((p): p is FrontierParcel => p?.state === "charted" && hopsTo(p.id) !== undefined).sort(byPosition);
      const nearest = edges.reduce<FrontierParcel | undefined>((best, p) => best === undefined || hopsTo(p.id)! < hopsTo(best.id)! ? p : best, undefined);
      return nearest && { site: { kind: "ground", parcelId: nearest.id }, travelMinutes: walk(hopsTo(nearest.id)!), placeId: resident.placeId };
    },
    ground(parcel) {
      if (!resident || parcel.state !== "charted") return undefined;
      if (inCity) return crossing(parcel);
      if (!standing) return undefined;
      const parcelHops = hopsTo(parcel.id);
      return parcelHops === undefined ? undefined : { site: { kind: "ground", parcelId: parcel.id }, travelMinutes: walk(parcelHops), placeId: resident.placeId };
    },
  };
}

/** The frontier part of one resident's menu: the legacy global choices without the policy, reachable ones with it. */
export interface FrontierMenu {
  chartTargets(): FrontierParcel[];
  helpTargets(): FrontierParcel[];
  foundingOptions(): { parcel: FrontierParcel; spec: FrontierBuildSpec }[];
  buildSite(): FrontierParcel | undefined;
}

export function frontierMenu(state: WorldState, residentId: string): FrontierMenu {
  if (!frontierAccessEnabled(state)) {
    return {
      chartTargets: () => frontierTargets(state),
      helpTargets: () => frontierBeingCharted(state, residentId),
      foundingOptions: () => foundingOptions(state, residentId),
      buildSite: () => buildsUnderWay(state)[0],
    };
  }
  const reach = frontierReach(state, residentId);
  const fog = (p: FrontierParcel) => reach.fog(p) !== undefined;
  const ground = (p: FrontierParcel) => reach.ground(p) !== undefined;
  let targets: FrontierParcel[] | undefined;
  return {
    chartTargets: () => (targets ??= frontierTargets(state, fog)),
    // Someone is out at the edge right now: their own shift has arrived, not merely set out.
    helpTargets: () => frontierBeingCharted(state, residentId, (task) => task.trip?.phase === "working", fog),
    foundingOptions: () => foundingOptions(state, residentId, ground),
    buildSite: () => buildsUnderWay(state).find(ground),
  };
}

/**
 * A new frontier shift under policy 1: travelling from the resident's current place until arrival, then a full
 * shift at the worksite. Undefined when the worksite cannot be reached, so nothing is started or paid.
 */
export function frontierShiftTask(state: WorldState, residentId: string, kind: "chart-frontier" | "help-chart" | "build", label: string, parcelId: string, minute: number, source: ResidentActionProposal["source"]): ResidentTask | undefined {
  const parcel = own(state.life?.frontier ?? {}, parcelId);
  const resident = own(state.residents, residentId);
  if (!parcel || !resident) return undefined;
  const reach = frontierReach(state, residentId, minute);
  const route = kind === "build" ? reach.ground(parcel) : reach.fog(parcel);
  if (!route) return undefined;
  const arrivesMinute = minute + route.travelMinutes;
  return {
    kind, label, startedMinute: minute, endsMinute: arrivesMinute + FRONTIER_TASK_MINUTES, placeId: route.placeId, parcelId,
    trip: { policy: 1, site: route.site, fromPlaceId: resident.placeId, phase: "travelling", arrivesMinute },
    ...(route.journey ? { journey: route.journey } : {}),
    decisionSource: source,
  };
}

/**
 * One committed minute of a policy-1 shift. A traveller still at their starting place walks on, and arrives at
 * `arrivesMinute`, taking up the worksite's place; a worker must still be at it. Returns false when the resident
 * is no longer where the shift needs them: the shift then ends with no effort, reward or evidence, so leaving
 * and returning cannot count as uninterrupted work.
 */
export function keepFrontierShift(state: WorldState, residentId: string, minute: number): boolean {
  const task = state.life?.residents[residentId]?.task;
  const resident = own(state.residents, residentId);
  const trip = task?.trip;
  if (!task || !trip || !resident) return false;
  if (trip.phase === "working") return resident.placeId === task.placeId;
  if (resident.placeId !== trip.fromPlaceId) return false;
  if (minute < trip.arrivesMinute) return true;
  trip.phase = "working";
  state.residents[residentId] = { ...resident, placeId: task.placeId, activity: "work" };
  return true;
}

/** Settle credit first, then reserve the physical return. No material, district, ownership or earned result changes. */
export function frontierReturnTask(state:WorldState,residentId:string,completed:ResidentTask,minute:number):ResidentTask|undefined {
 const trip=completed.trip,person=state.residents[residentId];
 if(!state.life?.transit||!trip||trip.phase!=="working"||!person||!completed.parcelId)return undefined;
 let duration:number,destination:string;
 if(trip.site.kind==="quay") {duration=FRONTIER_QUAY_WALK_MINUTES;destination=trip.fromPlaceId;}
 else {
   const anchor=transitPlaceParcel(state,completed.placeId);
   const hops=anchor?frontierGroundDistance(state.life.frontier??{},trip.site.parcelId,anchor.id):undefined;
   if(hops===undefined)throw new Error("settled frontier shift lost its admitted return ground");
   duration=(hops+1)*FRONTIER_GROUND_STEP_MINUTES;destination=completed.placeId;
 }
 return {kind:"frontier-return",label:"Return from the frontier worksite",startedMinute:minute,endsMinute:minute+duration,placeId:destination,decisionSource:"engine",
   returnTrip:{policy:1,site:structuredClone(trip.site),fromPlaceId:person.placeId,arrivesMinute:minute+duration,targetParcelId:completed.parcelId,sourceStartedMinute:completed.startedMinute}};
}
/** Return physics belongs to committed time, including minutes with an invalid decision; earned work is never repeated. */
export function keepFrontierReturn(state:WorldState,residentId:string,minute:number):boolean {
 const profile=state.life?.residents[residentId],task=profile?.task,back=task?.returnTrip,person=state.residents[residentId];
 if(!profile||!task||!back||!person||person.placeId!==back.fromPlaceId)return false;
 if(minute>=back.arrivesMinute){state.residents[residentId]={...person,placeId:task.placeId,activity:"leisure"};profile.task=null;}
 return true;
}
