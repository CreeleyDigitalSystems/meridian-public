import { CITY_GROUND_Y } from "./city-walkability.js";
import { FRONTIER_INNER_EDGE, FRONTIER_RING_STEP, frontierParcelPosition, type FrontierParcelVisual } from "./frontier-visuals.js";
import { nearestConnectedPosition, pedestrianPath, type PedestrianMap } from "./pedestrian-path.js";
import { QUAY_STATION_RADIUS, RIDE_Y, TRAM_BEARINGS } from "./sky-tram-sites.js";

/**
 * SUPERSEDED by the Transport Ruling (22 Oct 2026): nothing in the scene draws or routes by this any more (see
 * sky-tram.tsx); kept, unused, only so its existing tests stand.
 *
 * The sky tram's network and its riders' routes (14 Oct 2026). Lines leave quay stations at the compass bearings
 * and run out over charted land, a station on ring 1, every second ring and the line's end, stopping at the first
 * fog — so the network grows as residents chart. Every ring's slot boundaries fall on the compass bearings, so the
 * lines run along parcel edges, never over a building site. Visual only: no timetable or travel exists in the world.
 */

type Foot = [number, number, number];
export interface TramStation { x: number; z: number; radius: number; ring: number; base: number }
export interface TramLine { bearing: number; stations: TramStation[] }
const GROUND_TOP = 0.56;

export function skyTramNetwork(parcels: readonly FrontierParcelVisual[]): TramLine[] {
  const open = new Set(parcels.filter((p) => p.state !== "fog").map((p) => `${p.ring}:${p.slot}`));
  const at = (bearing: number, radius: number, ring: number, base: number): TramStation =>
    ({ x: Math.sin(bearing) * radius, z: -Math.cos(bearing) * radius, radius, ring, base });
  const lines: TramLine[] = [];
  for (const bearing of TRAM_BEARINGS) {
    const stations: TramStation[] = [];
    for (let ring = 1; ; ring += 1) {
      // The bearing is a slot boundary on every ring: the parcels either side of it.
      const slots = 8 * ring, boundary = Math.round(bearing / (Math.PI * 2) * slots) % slots;
      if (!open.has(`${ring}:${boundary}`) && !open.has(`${ring}:${(boundary + slots - 1) % slots}`)) break;
      stations.push(at(bearing, FRONTIER_INNER_EDGE + (ring - .5) * FRONTIER_RING_STEP, ring, GROUND_TOP));
    }
    // A station on ring 1, every second ring after it, and always at the line's end; pylons carry the rail between.
    const kept = stations.filter((s, i) => s.ring % 2 === 1 || i === stations.length - 1);
    if (kept.length) lines.push({ bearing, stations: [at(bearing, QUAY_STATION_RADIUS, 0, CITY_GROUND_Y), ...kept] });
  }
  return lines;
}

/** Seconds a scheduled car waits at each station, and its speed along the rail (scene units per second). */
const DWELL = 2.5, SPEED = 3.2;
/** Where a scheduled car is along its line at time t: out from the quay, stopping at each station, then back. */
export function tramPosition(stations: readonly TramStation[], t: number): number {
  const radii = stations.map((s) => s.radius);
  const stops = [...radii, ...radii.slice(0, -1).reverse()];
  const legs = stops.slice(0, -1).map((from, i) => ({ from, to: stops[i + 1]!, travel: Math.abs(stops[i + 1]! - from) / SPEED }));
  const cycle = legs.reduce((sum, leg) => sum + DWELL + leg.travel, 0);
  if (!(cycle > 0)) return radii[0] ?? QUAY_STATION_RADIUS;
  let clock = ((t % cycle) + cycle) % cycle;
  for (const leg of legs) {
    if (clock < DWELL) return leg.from;
    clock -= DWELL;
    if (clock < leg.travel) {
      const k = clock / leg.travel, eased = k * k * (3 - 2 * k);
      return leg.from + (leg.to - leg.from) * eased;
    }
    clock -= leg.travel;
  }
  return radii[0]!;
}

/** Beyond the quay's water: a spot on the frontier. */
export const isAcrossWater = (p: readonly number[]) => Math.hypot(p[0]!, p[2]!) > 50;
const bearingOf = (x: number, z: number) => (Math.atan2(x, -z) + Math.PI * 2) % (Math.PI * 2);
const angleGap = (a: number, b: number) => { const d = Math.abs(a - b) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };

/** The line serving a frontier spot: the nearest bearing among lines that reach its ring (any line if none do). */
export function lineFor(lines: readonly TramLine[], spot: readonly number[]): TramLine | undefined {
  const r = Math.hypot(spot[0]!, spot[2]!), b = bearingOf(spot[0]!, spot[2]!);
  const reaching = lines.filter((l) => l.stations.at(-1)!.radius >= r - FRONTIER_RING_STEP);
  const pool = reaching.length ? reaching : lines;
  return pool.reduce<TramLine | undefined>((best, l) => !best || angleGap(l.bearing, b) < angleGap(best.bearing, b) ? l : best, undefined);
}
const stationFor = (line: TramLine, spot: readonly number[]) => {
  const r = Math.hypot(spot[0]!, spot[2]!);
  return line.stations.slice(1).reduce((best, s) => Math.abs(s.radius - r) < Math.abs(best.radius - r) ? s : best, line.stations[1]!);
};

/** On frontier ground the walk from a station keeps off the founded place's building (radius ≤ 3.4) by passing beside it. */
function frontierWaypoints(from: Foot, to: Foot): Foot[] {
  const r = Math.hypot(to[0], to[2]);
  const ring = Math.max(1, Math.floor((r - FRONTIER_INNER_EDGE) / FRONTIER_RING_STEP) + 1);
  const slots = 8 * ring, slot = Math.floor(bearingOf(to[0], to[2]) / (Math.PI * 2 / slots)) % slots;
  const [cx, cz] = frontierParcelPosition(ring, slot);
  const dx = to[0] - from[0], dz = to[2] - from[2], length2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((cx - from[0]) * dx + (cz - from[2]) * dz) / length2));
  if (Math.hypot(from[0] + dx * t - cx, from[2] + dz * t - cz) >= 3.6) return [];
  const mx = (from[0] + to[0]) / 2 - cx, mz = (from[2] + to[2]) / 2 - cz, m = Math.hypot(mx, mz) || 1;
  return [[cx + mx / m * 4.6, to[1], cz + mz / m * 4.6]];
}

/** Where a rider waits on the quay: on the paving, on the city side of the station's tower. */
export function boardingPoint(nav: PedestrianMap, line: TramLine): Foot {
  return nearestConnectedPosition(nav, [Math.sin(line.bearing) * (QUAY_STATION_RADIUS - 1.6), CITY_GROUND_Y, -Math.cos(line.bearing) * (QUAY_STATION_RADIUS - 1.6)]);
}

/** City paving → frontier spot: walk to the quay station, rise inside its tower, ride, descend, walk to the spot. */
function outbound(nav: PedestrianMap, line: TramLine, from: Foot, to: Foot): Foot[] {
  const walk = pedestrianPath(nav, from, boardingPoint(nav, line));
  if (!walk.length) return [];
  const quay = line.stations[0]!, stop = stationFor(line, to);
  const landing: Foot = [stop.x, stop.base, stop.z];
  return [...walk, [quay.x, quay.base, quay.z], [quay.x, RIDE_Y, quay.z], [stop.x, RIDE_Y, stop.z], landing, ...frontierWaypoints(landing, to), [...to]];
}

/**
 * A render-only route for a resident whose saved place moved across the water, through the sky tram. Empty when no
 * line runs yet or the city end is not on the paths (the caller then moves them directly, as before the tram).
 */
export function skyTramRoute(nav: PedestrianMap, lines: readonly TramLine[], from: Foot, to: Foot): Foot[] {
  const away = isAcrossWater(from), there = isAcrossWater(to);
  if (!lines.length || (!away && !there)) return [];
  if (!away) { const line = lineFor(lines, to); return line ? outbound(nav, line, from, to) : []; }
  if (!there) { const line = lineFor(lines, from); return line ? outbound(nav, line, to, from).reverse() : []; }
  // Frontier to frontier: one line rides between its own stations; otherwise in on one line and out on the other.
  const a = lineFor(lines, from), b = lineFor(lines, to);
  if (!a || !b) return [];
  if (a === b) {
    const start = stationFor(a, from), stop = stationFor(a, to);
    if (start === stop) return [[...from], ...frontierWaypoints(from, to), [...to]];
    const up: Foot = [start.x, start.base, start.z], down: Foot = [stop.x, stop.base, stop.z];
    return [[...from], ...frontierWaypoints(up, from).reverse(), up, [start.x, RIDE_Y, start.z], [stop.x, RIDE_Y, stop.z], down, ...frontierWaypoints(down, to), [...to]];
  }
  const transfer = boardingPoint(nav, b);
  const inbound = outbound(nav, a, transfer, from).reverse();
  const onward = outbound(nav, b, transfer, to);
  return inbound.length && onward.length ? [...inbound, ...onward.slice(1)] : [];
}
