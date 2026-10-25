import { FRONTIER_INNER_EDGE, frontierParcelPosition } from "./frontier-visuals.js";

/**
 * Meridian Central and its circuit as the scene draws them (Transport Ruling, 22 Oct 2026). The circuit itself is
 * canonical: the web app reads it from the public `transit.state` fact and the shared timetable, and this module
 * only lays it out. Central stands on the water off the south promenade; the rail leaves it ONCE over the water
 * to the outbound landing, runs over the charted parcels of the route calling at each station, and comes back
 * ONCE over the water from the return landing. Outbound and return keep separate tracks round the channel, so
 * the two crossings never meet. Geometry only: no React, no Three.
 */

/** The circuit at the public minute: its parcels and stops, and where the shared timetable puts the vehicle. */
export interface TransitCircuitVisual {
  revision: number;
  /** Null while Central is commissioned but no circuit can run yet: the vehicle waits inside Central. */
  route: { path: readonly { ring: number; slot: number }[]; stops: readonly number[] } | null;
  vehicle: TransitVehicleVisual;
}
/** `at`, `from`, `to` are stop indices; null is Meridian Central. `progress` runs 0 → 1 along a run. */
export type TransitVehicleVisual =
  | { kind: "dwell"; at: number | null }
  | { kind: "run"; from: number | null; to: number | null; progress: number };

/** Rail height: above the tallest frontier building (the lookout, 8 on ground at 0.56). */
export const TRANSIT_RAIL_Y = 9;
/** Central's platforms, between the two tracks, in the water south of the promenade (the quay ends at 41.5). */
export const MERIDIAN_CENTRAL: readonly [number, number] = [0, 50];
/** Central's plinth on the water [x0, x1, z0, z1], and the pier joining it to the promenade. */
export const MERIDIAN_CENTRAL_RECT: readonly [number, number, number, number] = [-10, 10, 43.5, 56.5];
export const MERIDIAN_CENTRAL_PIER: readonly [number, number, number, number] = [-3, 3, 41, 43.5];
/** Outbound and return tracks round the water channel, either side of Central's platforms. */
const OUTBOUND_TRACK = 48, RETURN_TRACK = 52;
/** A station stands this far before its parcel's centre along the rail, clear of the founded building. */
export const TRANSIT_STATION_SETBACK = 5;
const ARC_STEP = 2;

type Point = readonly [number, number];
export interface CircuitLayout {
  /** The rail from Central round the circuit back to Central, as a polyline on the ground plane. */
  points: Point[];
  /** Cumulative length at each point. */
  lengths: number[];
  /** Distance along the rail of each stop's station. */
  stations: number[];
  /** Total rail length; Central sits at 0 and again at `total`. */
  total: number;
}

const bearingPoint = (bearing: number, radius: number): Point => [Math.sin(bearing) * radius, -Math.cos(bearing) * radius];
const slotBearing = (ring: number, slot: number) => (slot + 0.5) * Math.PI * 2 / (8 * ring);
const middleRadius = (ring: number) => FRONTIER_INNER_EDGE + (ring - 0.5) * 10;
const CENTRAL_BEARING = Math.PI;

/** Points along a circle from one bearing to another, turning `direction` (+1 clockwise), excluding the start. */
function arc(from: number, to: number, radius: number, direction: 1 | -1): Point[] {
  const sweep = direction === 1 ? ((to - from) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) : ((from - to) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const steps = Math.max(1, Math.ceil(sweep * radius / ARC_STEP));
  return Array.from({ length: steps }, (_, i) => bearingPoint(from + direction * sweep * (i + 1) / steps, radius));
}

/** The shorter way round the channel between Central's bearing and a ring-1 landing: +1 clockwise. */
function channelDirection(landingSlot: number): 1 | -1 {
  return (landingSlot + 4) % 8 <= (11 - landingSlot) % 8 ? 1 : -1;
}

/** Lays the canonical route out as rail: Central → outbound crossing → parcels → return crossing → Central. */
export function circuitLayout(route: NonNullable<TransitCircuitVisual["route"]>): CircuitLayout {
  const points: Point[] = [MERIDIAN_CENTRAL, bearingPoint(CENTRAL_BEARING, OUTBOUND_TRACK)];
  const centres: number[] = [];
  const first = route.path[0]!, last = route.path.at(-1)!;
  const out = slotBearing(1, first.slot);
  points.push(...arc(CENTRAL_BEARING, out, OUTBOUND_TRACK, channelDirection(first.slot)));
  points.push(frontierParcelPosition(1, first.slot));
  centres.push(points.length - 1);
  for (let i = 1; i < route.path.length; i += 1) {
    const a = route.path[i - 1]!, b = route.path[i]!;
    if (a.ring === b.ring) {
      // Along the ring between neighbouring slot centres, the short way (they are adjacent).
      const from = slotBearing(a.ring, a.slot), to = slotBearing(b.ring, b.slot);
      const clockwise = ((to - from) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) <= Math.PI ? 1 : -1;
      points.push(...arc(from, to, middleRadius(a.ring), clockwise).slice(0, -1));
    }
    points.push(frontierParcelPosition(b.ring, b.slot));
    centres.push(points.length - 1);
  }
  const back = slotBearing(1, last.slot);
  points.push(bearingPoint(back, RETURN_TRACK));
  points.push(...arc(back, CENTRAL_BEARING, RETURN_TRACK, channelDirection(last.slot) === 1 ? -1 : 1));
  points.push(MERIDIAN_CENTRAL);
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  const stations = route.stops.map((index) => Math.max(0, lengths[centres[index]!]! - TRANSIT_STATION_SETBACK));
  return { points, lengths, stations, total: lengths.at(-1)! };
}

/** Position and heading (radians, about +y, 0 facing +z) at a distance along the rail. */
export function circuitPointAt(layout: CircuitLayout, distance: number): { x: number; z: number; heading: number } {
  const s = Math.min(Math.max(distance, 0), layout.total);
  let i = 1;
  while (i < layout.points.length - 1 && layout.lengths[i]! < s) i += 1;
  const a = layout.points[i - 1]!, b = layout.points[i]!;
  const span = layout.lengths[i]! - layout.lengths[i - 1]!;
  const t = span > 0 ? (s - layout.lengths[i - 1]!) / span : 0;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, heading: Math.atan2(b[0] - a[0], b[1] - a[1]) };
}

/** Where along the rail the timetable puts the vehicle: at a station while it waits, eased between them. */
export function vehicleDistance(layout: CircuitLayout, vehicle: TransitVehicleVisual): number {
  const at = (stop: number | null, arriving: boolean) => stop === null ? (arriving ? layout.total : 0) : layout.stations[stop]!;
  if (vehicle.kind === "dwell") return at(vehicle.at, false);
  const k = Math.min(Math.max(vehicle.progress, 0), 1), eased = k * k * (3 - 2 * k);
  const from = at(vehicle.from, false), to = at(vehicle.to, true);
  return from + (to - from) * eased;
}

type Foot = [number, number, number];
/** Top of the platform decks (Central's hall and every station's tower), where riders wait and step aboard. */
export const TRANSIT_PLATFORM_Y = TRANSIT_RAIL_Y - 0.44;
/** Ground level at the city end of Central's pier and on frontier ground (both 0.56). */
const GROUND_Y = 0.56;

/**
 * Where a rider joins and leaves the rail: `base` is on the ground (the city end of Central's pier, or a station
 * tower's foot) and `climb` the points from there up to their spot on the platform deck. Central's riders walk
 * along the pier into the hall and wait beside the tracks; a station's ride its tower lift. Undefined for a stop
 * the laid-out circuit does not have.
 */
export function circuitPlatform(layout: CircuitLayout | undefined, stop: number | null): { base: Foot; climb: Foot[] } | undefined {
  if (stop === null) {
    // Along the pier, inside the hall's front (before its glazing), up to the deck, and between its two tracks.
    const [x, z] = MERIDIAN_CENTRAL, hall = MERIDIAN_CENTRAL_RECT[2] + 1;
    return { base: [x, GROUND_Y, MERIDIAN_CENTRAL_PIER[2] + 0.2], climb: [[x, GROUND_Y, hall], [x, TRANSIT_PLATFORM_Y, hall], [x - 4, TRANSIT_PLATFORM_Y, z - 1]] };
  }
  const distance = layout?.stations[stop];
  if (layout === undefined || distance === undefined) return undefined;
  const p = circuitPointAt(layout, distance);
  return { base: [p.x, GROUND_Y, p.z], climb: [[p.x, TRANSIT_PLATFORM_Y, p.z]] };
}

/** Harbour pavilions and their jetties (city-architecture.tsx): no pylon stands on them. */
const PAVILIONS: readonly Point[] = [[-17, 50.3], [17, 50.3]];
const insideRect = (rect: readonly [number, number, number, number], x: number, z: number, margin = 0) =>
  x >= rect[0] - margin && x <= rect[1] + margin && z >= rect[2] - margin && z <= rect[3] + margin;

/**
 * Pylons carrying the rail: about every 6.5 units, never on a parcel's building site, a harbour pavilion or its
 * jetty, the quay paving or inside Central (which carries its own platforms). `water` marks a pylon standing in
 * the channel.
 */
export function circuitPylons(layout: CircuitLayout, route: NonNullable<TransitCircuitVisual["route"]>): { x: number; z: number; heading: number; water: boolean }[] {
  const sites = route.path.map((c) => frontierParcelPosition(c.ring, c.slot));
  const pylons: { x: number; z: number; heading: number; water: boolean }[] = [];
  for (let s = 3.25; s < layout.total; s += 6.5) {
    const p = circuitPointAt(layout, s);
    const r = Math.hypot(p.x, p.z);
    if (r < 42.5 || insideRect(MERIDIAN_CENTRAL_RECT, p.x, p.z, 0.5)) continue;
    if (sites.some(([x, z]) => Math.hypot(p.x - x, p.z - z) < 4)) continue;
    if (PAVILIONS.some(([x, z]) => Math.hypot(p.x - x, p.z - z) < 4.2 || (Math.abs(p.x - x) < 2 && p.z > 38 && p.z < z))) continue;
    pylons.push({ ...p, water: r < FRONTIER_INNER_EDGE });
  }
  return pylons;
}
