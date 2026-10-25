import { z } from "zod";

/**
 * Meridian Central circuit (Transport Ruling, 22 Oct 2026). One grand station on the city's south waterfront,
 * ONE outbound crossing over the water, ordered stations through the developed outer districts, ONE return
 * crossing, back to Central. Supersedes the eight visual-only radial lines.
 *
 * Canonical state is optional and versioned: a world without `life.transit` stays byte-identical. The route is
 * a list of charted frontier parcels (ring/slot ids) and the stops along it; the single vehicle's timetable is
 * a pure integer function of the route, its saved anchor minute and the canonical world minute, so its position
 * at any minute is reproducible from saved state without writing an event every minute. A rider's trip is a
 * `TransitRide`, saved on the resident's task inside a `TransitJourney` and checked against that same saved
 * vehicle state minute by minute.
 *
 * Kept free of anything but zod so the public viewer shares the exact timetable it renders.
 */

/** At most one stop per outer district (compass octant). */
export const TRANSIT_MAX_STOPS = 8;
/** Parcels the route may pass through, landing to landing. */
export const TRANSIT_MAX_PATH = 2048;
/** Minutes the vehicle waits at Meridian Central, and at each outer stop. */
export const TRANSIT_CENTRAL_DWELL_MINUTES = 3;
export const TRANSIT_STOP_DWELL_MINUTES = 1;
/** Minutes from Central's platform across the water to a landing beside Central's bearing (and back). */
export const TRANSIT_CROSSING_MINUTES = 2;
/** Rail speed over charted ground, in scene units per minute (integer hop lengths below). */
export const TRANSIT_UNITS_PER_MINUTE = 120;
/**
 * Minutes on foot between any city place and Central's platform. Same figure as the spatial lane's walk from
 * anywhere in the city to the outer quay (FRONTIER_QUAY_WALK_MINUTES), so the city side has one walking rule.
 */
export const TRANSIT_CENTRAL_WALK_MINUTES = 6;
/**
 * Minutes on foot per charted parcel crossed between a station and a founded place, plus one step down from the
 * platform. Same figure as the spatial lane's FRONTIER_GROUND_STEP_MINUTES, so frontier ground has one rule.
 */
export const TRANSIT_GROUND_STEP_MINUTES = 4;
/**
 * Clockwise from Central's bearing (due south, the boundary between ring-1 slots 3 and 4): the order a circuit
 * over a fully charted first ring visits the outer districts. District d is the compass octant ring-1 slot d
 * spans; every parcel of district d descends from ring-1 slot d.
 */
export const TRANSIT_DISTRICT_ORDER: readonly number[] = [4, 5, 6, 7, 0, 1, 2, 3];
/** Mirrors the frontier geometry (ring 1 begins 58 out, rings are 10 wide) as integers only. */
const RING_INNER_EDGE = 58;
const RING_STEP = 10;
const RADIAL_HOP_UNITS = RING_STEP;
/** The crossings run round the water channel (radius 50) to reach a landing away from Central's bearing. */
const CHANNEL_RADIUS = 50;

const minute = z.number().int().nonnegative();
const id = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const PARCEL_ID = /^parcel:([1-9][0-9]?):(0|[1-9][0-9]{0,2})$/;

export interface TransitCell { ring: number; slot: number }

/** Ring and slot of a canonical parcel id, or undefined for anything else. */
export function parseTransitParcel(id: string): TransitCell | undefined {
  const match = PARCEL_ID.exec(id);
  if (!match) return undefined;
  const ring = Number(match[1]), slot = Number(match[2]);
  return ring <= 64 && slot < 8 * ring ? { ring, slot } : undefined;
}

/** The compass octant (outer district) a parcel lies in: every ring-r slot sits wholly inside one. */
export function transitDistrict(cell: TransitCell): number {
  return Math.floor(cell.slot / cell.ring);
}

/**
 * Two parcels the frontier itself connects: neighbours on one ring (ring r holds 8r slots, wrapping), or a parcel
 * and its one inward parent on the ring before (slot s of ring r has parent floor(s·(r−1)/r)). This is the
 * kernel frontier's own grid (a parcel is revealed from its parent), and exactly the spatial lane's
 * `frontierParcelsShareEdge`, so rail and walkers share one notion of connected ground. Corners never connect.
 */
export function transitCellsAdjacent(a: TransitCell, b: TransitCell): boolean {
  if (a.ring === b.ring) {
    const span = 8 * a.ring, apart = (((a.slot - b.slot) % span) + span) % span;
    return apart === 1 || apart === span - 1;
  }
  const [inner, outer] = a.ring < b.ring ? [a, b] : [b, a];
  return outer.ring === inner.ring + 1 && Math.floor((outer.slot * inner.ring) / outer.ring) === inner.slot;
}

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/**
 * Integer length of one hop along the rail: 10 between rings, else the arc between neighbouring slot centres
 * at the ring's middle radius (π approximated as 355/113, so every engine computes the same minutes).
 */
export function transitHopUnits(a: TransitCell, b: TransitCell): number {
  if (a.ring !== b.ring) return RADIAL_HOP_UNITS;
  const middle = RING_INNER_EDGE + RING_STEP * a.ring - RING_STEP / 2;
  return ceilDiv(middle * 2 * 355, 113 * 8 * a.ring);
}

/** One eighth of the water channel: the crossing's extra run per ring-1 slot between Central and a landing. */
const CHANNEL_UNITS_PER_SLOT = ceilDiv(CHANNEL_RADIUS * 2 * 355, 113 * 8);

/**
 * Whole ring-1 slots a crossing runs round the channel between Central's bearing (the boundary of ring-1 slots
 * 3 and 4) and a landing, the shorter way round. Zero for the landings either side of Central.
 */
export function transitChannelSlots(landing: TransitCell): number {
  return Math.min((landing.slot + 4) % 8, (11 - landing.slot) % 8);
}

/** Minutes one crossing takes: the short hop over the water plus its run round the channel. */
export function transitCrossingMinutes(landing: TransitCell): number {
  return TRANSIT_CROSSING_MINUTES + ceilDiv(transitChannelSlots(landing) * CHANNEL_UNITS_PER_SLOT, TRANSIT_UNITS_PER_MINUTE);
}

/**
 * Why a course is not a lawful circuit (empty when it is): it lands on two different ring-1 parcels, every step
 * is a connected pair, and its stops are increasing positions on different parcels, one per district.
 */
export function transitCourseIssues(path: readonly TransitCell[], stops: readonly number[]): string[] {
  const issues: string[] = [];
  const first = path[0], last = path.at(-1);
  if (!first || !last || first.ring !== 1 || last.ring !== 1 || first.slot === last.slot) issues.push("the circuit lands on two different ring-1 parcels");
  for (let i = 1; i < path.length; i += 1) if (!transitCellsAdjacent(path[i - 1]!, path[i]!)) issues.push(`transit path step ${i} is not a connected pair`);
  if (stops.some((stop, i) => stop >= path.length || (i > 0 && stop <= stops[i - 1]!))) issues.push("transit stops are increasing positions on the path");
  else {
    const stopCells = stops.map((stop) => path[stop]!);
    if (new Set(stopCells.map((c) => `${c.ring}:${c.slot}`)).size !== stopCells.length) issues.push("each transit stop is a different parcel");
    if (new Set(stopCells.map(transitDistrict)).size !== stopCells.length) issues.push("one transit stop per district");
  }
  return issues;
}

const ParcelIdSchema = z.string().regex(PARCEL_ID).refine((id) => parseTransitParcel(id) !== undefined, { message: "transit parcel must name an existing ring slot" });

/**
 * The circuit beyond the water: `path` runs from the outbound landing (a ring-1 parcel) through connected
 * charted parcels to the return landing (a different ring-1 parcel); `stops` are indices into it, in order.
 */
export const TransitRouteSchema = z.object({
  path: z.array(ParcelIdSchema).min(2).max(TRANSIT_MAX_PATH),
  stops: z.array(z.number().int().nonnegative()).min(1).max(TRANSIT_MAX_STOPS),
}).strict().superRefine((route, context) => {
  const cells = route.path.map(parseTransitParcel);
  if (cells.some((cell) => cell === undefined)) return;
  for (const message of transitCourseIssues(cells as TransitCell[], route.stops)) context.addIssue({ code: "custom", message });
});
export type TransitRoute = z.infer<typeof TransitRouteSchema>;

/**
 * Commissioned transit (versioned, optional on `life`). `route` is the circuit in service (null until one can
 * be admitted); `pending` a newer circuit the vehicle adopts when it next stands at Central; `anchorMinute` the
 * minute its current timetable began there; `revision` counts adopted circuits.
 */
export const TransitStateSchema = z.object({
  version: z.literal(1),
  commissionedMinute: minute,
  revision: z.number().int().nonnegative(),
  anchorMinute: minute,
  route: TransitRouteSchema.nullable(),
  pending: TransitRouteSchema.nullable(),
}).strict().superRefine((transit, context) => {
  if (transit.anchorMinute < transit.commissionedMinute) context.addIssue({ code: "custom", message: "the timetable cannot begin before commissioning" });
  if ((transit.route === null) !== (transit.revision === 0)) context.addIssue({ code: "custom", message: "revision counts adopted circuits" });
  if (transit.pending !== null && transit.route === null) context.addIssue({ code: "custom", message: "a pending circuit waits for one in service" });
});
export type TransitState = z.infer<typeof TransitStateSchema>;

/** A provisional rail platform is infrastructure, never a founded district or a resident-built home. */
export const TransitLandingSchema = z.object({
  id: z.string().regex(/^landing-1-[0-7]$/), name: z.string().min(1).max(160), kind: z.literal("civic"),
}).strict();
export type TransitLanding = z.infer<typeof TransitLandingSchema>;
export const transitLandingPlaceId = (parcelId: string): string => parcelId.replace(/^parcel:/, "landing-").replace(":", "-");

/** One-time zero-minute commissioning of Meridian Central and its circuit. */
export const TransitCommissionedEventSchema = z.object({
  type: z.literal("transit-commissioned"), minute, after: TransitStateSchema, landings: z.array(TransitLandingSchema).max(8).optional(),
}).strict().refine((event) => event.after.commissionedMinute === event.minute && event.after.anchorMinute === event.minute, { message: "commissioning happens at its own minute" });
/** The circuit changed: a newly developed district became pending, or the vehicle adopted it at Central. */
export const TransitChangedEventSchema = z.object({
  type: z.literal("transit-changed"), minute, before: TransitStateSchema, after: TransitStateSchema, landings: z.array(TransitLandingSchema).max(8).optional(),
}).strict().refine((event) => event.before.commissionedMinute === event.after.commissionedMinute, { message: "commissioning is fixed" });

/** The route as the timetable reads it: ring/slot cells and stop positions, canonical or public. */
export interface TransitCourse { path: readonly TransitCell[]; stops: readonly number[] }
/** `stop` is an index into `course.stops`; null is Meridian Central. */
export type TransitSegment =
  | { kind: "dwell"; stop: number | null; start: number; minutes: number }
  | { kind: "run"; from: number | null; to: number | null; start: number; minutes: number };
export interface TransitTimetable { cycleMinutes: number; segments: TransitSegment[] }

export function transitCourse(route: TransitRoute): TransitCourse {
  return { path: route.path.map((id) => parseTransitParcel(id)!), stops: route.stops };
}

function travelUnits(path: readonly TransitCell[], from: number, to: number): number {
  let units = 0;
  for (let i = from + 1; i <= to; i += 1) units += transitHopUnits(path[i - 1]!, path[i]!);
  return units;
}

/**
 * One full circuit from Central: wait, cross out, call at every stop in order, cross back. Every duration is a
 * whole number of minutes, so canonical minute arithmetic never needs floating point. Segment 0 is Central's
 * dwell; stop i's dwell is segment 2 + 2i.
 */
export function transitTimetable(course: TransitCourse): TransitTimetable {
  const segments: TransitSegment[] = [];
  let clock = 0;
  const push = (segment: TransitSegment) => { segments.push(segment); clock += segment.minutes; };
  const minutes = (units: number) => ceilDiv(units, TRANSIT_UNITS_PER_MINUTE);
  push({ kind: "dwell", stop: null, start: clock, minutes: TRANSIT_CENTRAL_DWELL_MINUTES });
  push({ kind: "run", from: null, to: 0, start: clock, minutes: transitCrossingMinutes(course.path[0]!) + minutes(travelUnits(course.path, 0, course.stops[0]!)) });
  for (let i = 0; i < course.stops.length; i += 1) {
    push({ kind: "dwell", stop: i, start: clock, minutes: TRANSIT_STOP_DWELL_MINUTES });
    const here = course.stops[i]!, next = course.stops[i + 1];
    if (next === undefined) push({ kind: "run", from: i, to: null, start: clock, minutes: minutes(travelUnits(course.path, here, course.path.length - 1)) + transitCrossingMinutes(course.path.at(-1)!) });
    else push({ kind: "run", from: i, to: i + 1, start: clock, minutes: Math.max(1, minutes(travelUnits(course.path, here, next))) });
  }
  return { cycleMinutes: clock, segments };
}

const offsetIn = (cycle: number, anchorMinute: number, minuteNow: number) => ((minuteNow - anchorMinute) % cycle + cycle) % cycle;

/** Where the vehicle is at a whole canonical minute: the segment it is in and the minutes elapsed within it. */
export function transitVehicleAt(timetable: TransitTimetable, anchorMinute: number, minuteNow: number): { segment: number; elapsed: number } {
  const offset = offsetIn(timetable.cycleMinutes, anchorMinute, minuteNow);
  const segment = timetable.segments.findIndex((s) => offset >= s.start && offset < s.start + s.minutes);
  return { segment, elapsed: offset - timetable.segments[segment]!.start };
}

/** True at a minute when the vehicle stands at Central at the very start of its circuit. */
export function transitAtCentralStart(transit: Pick<TransitState, "route" | "anchorMinute">, minuteNow: number): boolean {
  if (!transit.route) return true;
  return offsetIn(transitTimetable(transitCourse(transit.route)).cycleMinutes, transit.anchorMinute, minuteNow) === 0;
}

type Service = Pick<TransitState, "revision" | "anchorMinute" | "route" | "pending">;

/**
 * The service the vehicle runs at `minuteNow`, read from the record saved at the end of minute `minuteNow` or the
 * minute before: a pending circuit due to go into service this very minute (the vehicle stands at Central at
 * the start of a circuit) is treated as adopted, exactly as `stepTransit` adopts it when no district develops
 * in this same minute.
 */
export function transitServiceAt(transit: Service, minuteNow: number): Service {
  if (!transit.pending || !transitAtCentralStart(transit, minuteNow)) return transit;
  return { revision: transit.revision + 1, anchorMinute: minuteNow, route: transit.pending, pending: null };
}

/**
 * A rider's trip on the circuit: stand aboard at `from` from `boardMinute` while the vehicle waits there, leave
 * with it at `departMinute`, step off at `to` at `arriveMinute`. Stations are named by their parcel; null is
 * Meridian Central. A ride never passes through Central, so it always finishes within the circuit it boarded,
 * before any newer circuit is adopted.
 */
export const TransitRideSchema = z.object({
  revision: z.number().int().positive(),
  from: ParcelIdSchema.nullable(),
  to: ParcelIdSchema.nullable(),
  boardMinute: minute,
  departMinute: minute,
  arriveMinute: minute,
}).strict().refine((ride) => ride.from !== ride.to && ride.boardMinute < ride.departMinute && ride.departMinute < ride.arriveMinute, { message: "a ride boards, departs and arrives somewhere else, in that order" });
export type TransitRide = z.infer<typeof TransitRideSchema>;

/** Stop index of a station on a route (-1 when it is not a stop), or null for Central. */
const stopOf = (route: TransitRoute, station: string | null) => station === null ? null : route.stops.findIndex((i) => route.path[i] === station);

/** True when `to` is ahead of `from` on the route (both stops, or one of them Central, never both). */
function servedOn(route: TransitRoute, from: string | null, to: string | null): boolean {
  const fromStop = stopOf(route, from), toStop = stopOf(route, to);
  return fromStop !== -1 && toStop !== -1 && !(fromStop === null && toStop === null) && !(fromStop !== null && toStop !== null && toStop <= fromStop);
}

/** The ride in the circuit starting at `cycleStart`, for a rider ready at `readyMinute`, if the vehicle has not left yet. */
function rideOn(route: TransitRoute, cycleStart: number, revision: number, from: string | null, to: string | null, readyMinute: number): TransitRide | undefined {
  if (!servedOn(route, from, to)) return undefined;
  const fromStop = stopOf(route, from), toStop = stopOf(route, to);
  const timetable = transitTimetable(transitCourse(route));
  const dwell = timetable.segments[fromStop === null ? 0 : 2 + 2 * fromStop!]!;
  const departMinute = cycleStart + dwell.start + dwell.minutes;
  if (departMinute <= readyMinute) return undefined;
  return {
    revision, from, to,
    boardMinute: Math.max(readyMinute, cycleStart + dwell.start),
    departMinute,
    arriveMinute: cycleStart + (toStop === null ? timetable.cycleMinutes : timetable.segments[2 + 2 * toStop!]!.start),
  };
}

/**
 * The first ride from `from` to `to` for a rider at the platform from `readyMinute`, planned at `nowMinute` from
 * the transit record saved then (see `transitServiceAt`): in the circuit running now if the vehicle has not left
 * that station yet, otherwise in a later circuit — the pending one first if a newer circuit is waiting, then
 * that one repeating. Undefined when there is no circuit, a station is not on it, `to` is not ahead of `from`, or
 * the rider would be ready before `nowMinute`. A ride boarding in a later circuit is a forecast (residents may
 * develop another district before then), so the carrier checks it with `transitRideHolds` every minute.
 */
export function planTransitRide(transit: Service, from: string | null, to: string | null, readyMinute: number, nowMinute: number): TransitRide | undefined {
  const service = transitServiceAt(transit, nowMinute);
  if (!service.route || readyMinute < nowMinute || nowMinute < service.anchorMinute) return undefined;
  let route = service.route, revision = service.revision, pending = service.pending;
  let cycle = transitTimetable(transitCourse(route)).cycleMinutes;
  let cycleStart = nowMinute - offsetIn(cycle, service.anchorMinute, nowMinute);
  for (;;) {
    if (servedOn(route, from, to)) {
      // Each later circuit waits at every station again, so this ends once a circuit starts after `readyMinute`.
      const ride = rideOn(route, cycleStart, revision, from, to, readyMinute);
      if (ride) return ride;
    } else if (!pending) return undefined;
    cycleStart += cycle;
    if (pending) {
      route = pending; revision += 1; pending = null;
      cycle = transitTimetable(transitCourse(route)).cycleMinutes;
    }
  }
}

/**
 * True when, by the transit record saved at the end of `minuteNow` or the minute before, the vehicle is running
 * the saved ride at `minuteNow`: same circuit revision, and the same board/depart/arrive minutes in the circuit
 * the vehicle is on. Arriving at Central ends that circuit, and the vehicle may adopt its next one that very
 * minute, which still completes the ride. False outside the ride's minutes, or for a ride the vehicle never ran.
 */
export function transitRideHolds(transit: Service, ride: TransitRide, minuteNow: number): boolean {
  if (minuteNow < ride.boardMinute || minuteNow > ride.arriveMinute) return false;
  const service = transitServiceAt(transit, minuteNow);
  if (!service.route) return false;
  const arrivingAtCentral = ride.to === null && minuteNow === ride.arriveMinute;
  if (arrivingAtCentral && service.anchorMinute === minuteNow && service.revision === ride.revision + 1) return true;
  if (service.revision !== ride.revision) return false;
  const cycle = transitTimetable(transitCourse(service.route)).cycleMinutes;
  let cycleStart = minuteNow - offsetIn(cycle, service.anchorMinute, minuteNow);
  if (arrivingAtCentral && cycleStart === minuteNow) cycleStart -= cycle;
  if (cycleStart < service.anchorMinute) return false;
  const replanned = rideOn(service.route, cycleStart, service.revision, ride.from, ride.to, ride.boardMinute);
  return replanned !== undefined && replanned.boardMinute === ride.boardMinute && replanned.departMinute === ride.departMinute && replanned.arriveMinute === ride.arriveMinute;
}

/**
 * A resident's lawful crossing of the water, saved on the task that needs it (journeys policy 1, only in a world
 * with commissioned transit). The resident sets out from `fromPlaceId` (their canonical location until arrival),
 * walks to the platform, rides the saved `ride`, walks on, and arrives at the task's place at `arrivesMinute`.
 * City side: Central's platform; frontier side: the station serving the founded place, over charted ground.
 */
export const TransitJourneySchema = z.object({
  policy: z.literal(1),
  fromPlaceId: id,
  ride: TransitRideSchema,
  arrivesMinute: minute,
}).strict().refine((journey) => (journey.ride.from === null) !== (journey.ride.to === null) && journey.ride.arriveMinute <= journey.arrivesMinute, {
  message: "a journey crosses the water once, through Central, and arrives after its ride",
});
export type TransitJourney = z.infer<typeof TransitJourneySchema>;

export type TransitJourneyPhase = "to-platform" | "aboard" | "onward" | "arrived";
/** Where a journey stands at a whole minute: walking to the platform, aboard (waiting or riding), walking on, or there. */
export function transitJourneyPhase(journey: { ride: Pick<TransitRide, "boardMinute" | "arriveMinute">; arrivesMinute: number }, minuteNow: number): TransitJourneyPhase {
  if (minuteNow >= journey.arrivesMinute) return "arrived";
  if (minuteNow < journey.ride.boardMinute) return "to-platform";
  return minuteNow < journey.ride.arriveMinute ? "aboard" : "onward";
}
