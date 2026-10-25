import type { HomeInteriorLayout } from "./home-interior.js";
import { CITY_GROUND_Y } from "./city-walkability.js";
import { pedestrianPath, type createPedestrianMap } from "./pedestrian-path.js";

type Point = [number, number, number];
type Navigation = ReturnType<typeof createPedestrianMap>;
/** Routes between two exterior points: the street network by default, or a caller's (e.g. tram) router. */
export type StreetRouter = (from: Point, to: Point) => Point[];

/**
 * Whether the admitted public facts put a resident away from their saved place while it is still the home, so an
 * opened home must not hold them in its room: motion `walking` (a trip under way), a frontier shift's public worksite
 * (spatial-frontier's `frontierSite`: travelling to it or working at it), or a saved crossing (transport-circuit's
 * `journey`: on foot to a platform, aboard, or onward). Read structurally, so it holds before and after those
 * fields join ResidentVisualState.
 */
export function awayFromSavedPlace(resident: { readonly walking?: boolean | undefined; readonly frontierSite?: unknown; readonly journey?: unknown }): boolean {
  return resident.walking === true || resident.frontierSite !== undefined || resident.journey !== undefined;
}

function local(home: HomeInteriorLayout, p: readonly number[]): [number, number] {
  const x = p[0]! - home.center[0], z = p[2]! - home.center[2];
  return [Math.cos(home.yaw) * x - Math.sin(home.yaw) * z, Math.sin(home.yaw) * x + Math.cos(home.yaw) * z];
}

/** Inside the room, on the threshold between its doorway and its doorstep, or neither. */
export function homeRegion(home: HomeInteriorLayout, p: Point): "room" | "door" | undefined {
  const [x, z] = local(home, p);
  if (Math.abs(x) < home.width / 2 && Math.abs(z) < home.depth / 2 + .01) return "room";
  const outsideZ = local(home, home.outside)[1];
  return Math.abs(x) < .26 && z >= home.depth / 2 && z < outsideZ - .01 ? "door" : undefined;
}

/** An opened home's walls stand this far outside its room: a planned building's own rect, or a founded frontier home's shell. */
const SHELL_WALL = { planned: .25, frontier: .15 } as const;
/** A way round an opened shell keeps this far off its walls: about a walker's half-width. */
export const SHELL_CLEARANCE = .3;
/** Above a floor (a tram rail, a station's lift) a leg passes over buildings, not through them. */
const ALOFT = CITY_GROUND_Y + .5;

/** Whether the segment a→b (in the home's own frame) passes through the open box |x| < hx, |z| < hz. */
function throughBox(a: readonly [number, number], b: readonly [number, number], hx: number, hz: number): boolean {
  let enter = 0, leave = 1;
  for (const [p, d, h] of [[a[0], b[0] - a[0], hx], [a[1], b[1] - a[1], hz]] as const) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(p) >= h) return false; continue; }
    const t0 = (-h - p) / d, t1 = (h - p) / d;
    enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1));
    if (leave - enter <= 1e-9) return false;
  }
  return true;
}

/**
 * The corners to pass so a ground leg a→b goes round an opened home's shell instead of through it: the shortest way
 * round, SHELL_CLEARANCE off its walls. None when the leg misses the shell, or when either end is already within it
 * (the doorway legs, which this never touches).
 */
function aroundShell(home: HomeInteriorLayout, a: Point, b: Point): Point[] {
  const wall = SHELL_WALL[home.kind], hx = home.width / 2 + wall, hz = home.depth / 2 + wall;
  const from = local(home, a), to = local(home, b);
  const within = (p: readonly [number, number]) => Math.abs(p[0]) < hx && Math.abs(p[1]) < hz;
  if (within(from) || within(to) || !throughBox(from, to, hx, hz)) return [];
  const ex = hx + SHELL_CLEARANCE, ez = hz + SHELL_CLEARANCE;
  const nodes: (readonly [number, number])[] = [from, to, [ex, ez], [-ex, ez], [-ex, -ez], [ex, -ez]];
  // The shortest way round a box: over the six points' clear sightlines.
  const distance = nodes.map((_, i) => i === 0 ? 0 : Infinity), previous = nodes.map(() => -1), done = nodes.map(() => false);
  for (;;) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && distance[i]! < Infinity && (current < 0 || distance[i]! < distance[current]!)) current = i;
    if (current < 0 || current === 1) break;
    done[current] = true;
    for (let next = 0; next < nodes.length; next++) {
      if (done[next] || throughBox(nodes[current]!, nodes[next]!, hx, hz)) continue;
      const via = distance[current]! + Math.hypot(nodes[next]![0] - nodes[current]![0], nodes[next]![1] - nodes[current]![1]);
      if (via < distance[next]!) { distance[next] = via; previous[next] = current; }
    }
  }
  const corners: Point[] = [];
  for (let at = previous[1]!; at > 1; at = previous[at]!) {
    const [x, z] = nodes[at]!;
    corners.unshift([home.center[0] + Math.cos(home.yaw) * x + Math.sin(home.yaw) * z, a[1], home.center[2] - Math.sin(home.yaw) * x + Math.cos(home.yaw) * z]);
  }
  return corners;
}

/**
 * An exterior route with every ground leg kept out of the open homes' shells, whatever router drew it (the city's
 * streets, frontier ground, the way to a transit platform): an open home is an obstacle, entered only by its door.
 */
export function keepOutOfShells(route: Point[], homes: readonly HomeInteriorLayout[]): Point[] {
  if (route.length < 2 || !homes.length) return route;
  const kept: Point[] = [route[0]!];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    if (a[1] < ALOFT && b[1] < ALOFT) {
      let leg: Point[] = [a, b];
      for (const home of homes) leg = leg.flatMap((p, k) => k === 0 ? [p] : [...aroundShell(home, leg[k - 1]!, p), p]);
      kept.push(...leg.slice(1));
    } else kept.push(b);
  }
  return kept;
}

/** This private doorway does not add building footprints to public navigation. */
export function homeResidentPath(nav: Navigation, from: Point, to: Point, home?: HomeInteriorLayout, street: StreetRouter = (a, b) => pedestrianPath(nav, a, b)): Point[] {
  if (!home) return street(from, to);
  // Whatever router carries the exterior legs, the open home stays an obstacle to them.
  const exterior: StreetRouter = (a, b) => keepOutOfShells(street(a, b), [home]);
  const source = homeRegion(home, from);
  const fromRoom = source === "room", fromDoor = source === "door";
  const toRoom = homeRegion(home, to) === "room";
  if (fromRoom && toRoom) return [from, to];
  if (toRoom) {
    if (fromDoor) return [from, home.doorway, to];
    const route = exterior(from, home.outside);
    return route.length ? [...route, home.doorway, to] : [];
  }
  if (fromRoom || fromDoor) {
    const route = exterior(home.outside, to);
    if (!route.length) return [];
    return [from, ...(fromRoom ? [home.doorway] : []), ...route];
  }
  return exterior(from, to);
}

/**
 * The same, when more than one home is open to residents' movement (the inspected home and any default
 * interior): leave one home by its doorway and enter another by its own, without repeating the doorstep.
 * Every open home is an obstacle to every exterior leg, including walks that only pass one by.
 */
export function homesResidentPath(nav: Navigation, from: Point, to: Point, homes: readonly HomeInteriorLayout[], street: StreetRouter = (a, b) => pedestrianPath(nav, a, b)): Point[] {
  const exterior: StreetRouter = homes.length ? (a, b) => keepOutOfShells(street(a, b), homes) : street;
  const source = homes.find((home) => homeRegion(home, from)), target = homes.find((home) => homeRegion(home, to) === "room");
  if (!source || !target || source === target) return homeResidentPath(nav, from, to, target ?? source, exterior);
  const leave = homeResidentPath(nav, from, target.outside, source, exterior);
  const enter = leave.length ? homeResidentPath(nav, target.outside, to, target, exterior) : [];
  if (!leave.length || !enter.length) return [];
  const same = (p: Point, q: Point) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  let skip = 0;
  while (skip < enter.length && same(enter[skip]!, target.outside)) skip++;
  return [...leave, ...enter.slice(skip)];
}
