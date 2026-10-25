import { CITY_GROUND_Y, PUBLIC_PLACES, type CityBuilding } from "./city-layout.js";
import { isPlanLayout } from "./city-plan.js";
import { homeInteriorLayout, homeInteriorParts, type HomeInteriorLayout } from "./home-interior.js";
import { createPedestrianMap, isConnectedPosition, isOnPedestrianNetwork, nearestConnectedPosition, pedestrianPath, type PedestrianMap } from "./pedestrian-path.js";
import { isAcrossWater } from "./sky-tram-network.js";

/**
 * The audience's own walk through the city: a viewer-local camera position, never a resident, a task or a world
 * event. It changes no location, consent or ledger, and it grants no resident knowledge or object use.
 */
type Point = [number, number, number];

/** The observer's footprint: it stops this far from walls and furnishings. */
export const OBSERVER_RADIUS = .2;
/** Held-key walking, planned travel and turning speeds (scene units or radians per second). */
export const WALK_SPEED = 2.2, TRAVEL_SPEED = 6, TURN_SPEED = 1.9;
/** One discrete step or turn, used under reduced motion and for single key or button presses. */
export const STEP = .5, TURN_STEP = Math.PI / 12;
/** Longest straight move tested at once; a step is swept in pieces this size so it never jumps a wall. */
const SWEEP = .08;
/** A founded frontier home is explored on its own parcel: a bounded patch of this radius around it. */
const FRONTIER_PATCH = 4.5;

export type WalkCommand = "forward" | "back" | "left" | "right";
export interface WalkInput { held: Record<WalkCommand, boolean>; steps: WalkCommand[] }
export function createWalkInput(): WalkInput { return { held: { forward: false, back: false, left: false, right: false }, steps: [] }; }

/** Arrow keys and WASD; nothing else is taken from the page. */
export function walkCommandForKey(key: string): WalkCommand | undefined {
  switch (key) {
    case "ArrowUp": case "w": case "W": return "forward";
    case "ArrowDown": case "s": case "S": return "back";
    case "ArrowLeft": case "a": case "A": return "left";
    case "ArrowRight": case "d": case "D": return "right";
    default: return undefined;
  }
}

/** Where the observer may stand: the connected streets, and the opened home (its room, door and own ground). */
export interface ObserverSurface { map: PedestrianMap; home?: HomeInteriorLayout | undefined }

interface Box { x0: number; x1: number; z0: number; z1: number }
interface HomeFloor { obstacles: Box[]; outsideZ: number; doorHalf: number }
const floors = new WeakMap<HomeInteriorLayout, HomeFloor>();
function local(home: HomeInteriorLayout, x: number, z: number): [number, number] {
  const dx = x - home.center[0], dz = z - home.center[2];
  return [Math.cos(home.yaw) * dx - Math.sin(home.yaw) * dz, Math.sin(home.yaw) * dx + Math.cos(home.yaw) * dz];
}
/** The opened room's walls and visible furnishings as footprints in its own frame (x across, z toward the door). */
function homeFloor(home: HomeInteriorLayout): HomeFloor {
  let floor = floors.get(home);
  if (floor) return floor;
  const parts = homeInteriorParts(home).filter((part) => part.role !== "floor");
  const obstacles = parts.map((part): Box => {
    const [x, z] = local(home, part.position[0], part.position[2]);
    return { x0: x - part.scale[0] / 2, x1: x + part.scale[0] / 2, z0: z - part.scale[2] / 2, z1: z + part.scale[2] / 2 };
  });
  // The door is the gap between the two low front walls.
  const front = obstacles.filter((box, i) => parts[i]!.role === "wall" && box.z0 < home.depth / 2 && box.z1 > home.depth / 2);
  const doorHalf = front.length ? Math.min(...front.map((box) => Math.min(Math.abs(box.x0), Math.abs(box.x1)))) : 0;
  floor = { obstacles, outsideZ: local(home, home.outside[0], home.outside[2])[1], doorHalf };
  floors.set(home, floor);
  return floor;
}
function touches(box: Box, x: number, z: number, radius: number): boolean {
  const dx = Math.max(box.x0 - x, 0, x - box.x1), dz = Math.max(box.z0 - z, 0, z - box.z1);
  return dx * dx + dz * dz < radius * radius;
}
/** Inside the opened home: its floor or the threshold from its door to its doorstep, clear of walls and furniture. */
function homeRegion(home: HomeInteriorLayout, x: number, z: number): "room" | "door" | undefined {
  const floor = homeFloor(home);
  const [lx, lz] = local(home, x, z);
  const room = Math.abs(lx) < home.width / 2 && Math.abs(lz) < home.depth / 2;
  const door = !room && Math.abs(lx) < floor.doorHalf && lz >= home.depth / 2 && lz <= floor.outsideZ;
  if (!room && !door) return undefined;
  return floor.obstacles.some((box) => touches(box, lx, lz, OBSERVER_RADIUS)) ? undefined : room ? "room" : "door";
}
/** A founded frontier home's own parcel ground around it, outside its (cut-away) shell. */
function onParcel(home: HomeInteriorLayout, x: number, z: number): boolean {
  if (Math.hypot(x - home.center[0], z - home.center[2]) > FRONTIER_PATCH) return false;
  const [lx, lz] = local(home, x, z);
  return Math.abs(lx) > home.width / 2 + .15 + OBSERVER_RADIUS || Math.abs(lz) > home.depth / 2 + .15 + OBSERVER_RADIUS;
}

export function observerCanStand(surface: ObserverSurface, x: number, z: number): boolean {
  const home = surface.home;
  if (home && homeRegion(home, x, z)) return true;
  if (home?.kind === "frontier") return onParcel(home, x, z);
  return isOnPedestrianNetwork(surface.map, x, z);
}

/** Ground height under the observer: the room's floor indoors, rising across the threshold, the paving outside. */
function groundAt(surface: ObserverSurface, x: number, z: number): number {
  const home = surface.home;
  const region = home && homeRegion(home, x, z);
  if (!home || !region) return CITY_GROUND_Y;
  if (region === "room") return home.center[1];
  const { outsideZ } = homeFloor(home), lz = local(home, x, z)[1];
  const t = Math.min(1, Math.max(0, (outsideZ - lz) / Math.max(1e-6, outsideZ - home.depth / 2)));
  return home.outside[1] + (home.center[1] - home.outside[1]) * t;
}

/**
 * One swept move on the observer's surface. Blocked pieces slide along the obstacle (x, then z); the move ends
 * where it first cannot continue, so it never passes through a facade, wall or furnishing.
 */
export function stepObserver(surface: ObserverSurface, foot: Point, dx: number, dz: number): Point {
  const pieces = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SWEEP));
  let x = foot[0], z = foot[2];
  for (let i = 1; i <= pieces; i++) {
    const tx = foot[0] + dx * i / pieces, tz = foot[2] + dz * i / pieces;
    if (observerCanStand(surface, tx, tz)) { x = tx; z = tz; continue; }
    const sx = dx / pieces, sz = dz / pieces;
    if (sx && observerCanStand(surface, x + sx, z)) { x += sx; continue; }
    if (sz && observerCanStand(surface, x, z + sz)) { z += sz; continue; }
    break;
  }
  if (x === foot[0] && z === foot[2]) return [...foot];
  return [x, groundAt(surface, x, z), z];
}

function segmentStandable(surface: ObserverSurface, a: readonly number[], b: readonly number[]): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) / .025));
  for (let k = 0; k <= n; k++) if (!observerCanStand(surface, a[0]! + (b[0]! - a[0]!) * k / n, a[2]! + (b[2]! - a[2]!) * k / n)) return false;
  return true;
}
const routeLength = (route: readonly Point[]) => route.reduce((sum, p, i) => i ? sum + Math.hypot(p[0] - route[i - 1]![0], p[2] - route[i - 1]![2]) : 0, 0);

/** Outdoors: the street network's own route, shortened only where a straight line stays on standable ground. */
function exteriorRoute(surface: ObserverSurface, from: Point, to: Point): Point[] {
  if (surface.home?.kind === "frontier" && isAcrossWater(from)) return segmentStandable(surface, from, to) ? [from, to] : [];
  const raw = pedestrianPath(surface.map, from, to);
  if (!raw.length) return [];
  const route: Point[] = [raw[0]!];
  for (let i = 0; i < raw.length - 1;) {
    if (!segmentStandable(surface, raw[i]!, raw[i + 1]!)) return [];
    let j = i + 1;
    while (j + 1 < raw.length && segmentStandable(surface, raw[i]!, raw[j + 1]!)) j++;
    route.push(raw[j]!);
    i = j;
  }
  return route;
}

export type ObserverTravel =
  | { kind: "walk"; route: Point[]; length: number }
  | { kind: "unavailable"; reason: "here" | "across-water" | "off-network" | "no-route" };

/**
 * A walk the observer can actually take: along the streets, and into or out of the opened home only through its
 * doorway. Across the water, onto scenery or into a closed building it says so instead of animating anything.
 */
export function planObserverTravel(surface: ObserverSurface, from: Point, to: Point): ObserverTravel {
  if (Math.hypot(to[0] - from[0], to[2] - from[2]) < 1e-6) return { kind: "unavailable", reason: "here" };
  if (isAcrossWater(to) !== isAcrossWater(from)) return { kind: "unavailable", reason: "across-water" };
  if (!observerCanStand(surface, to[0], to[2]) || !observerCanStand(surface, from[0], from[2])) return { kind: "unavailable", reason: "off-network" };
  const home = surface.home;
  const inside = (p: Point) => home !== undefined && homeRegion(home, p[0], p[2]) !== undefined;
  let route: Point[];
  if (home && inside(from) && inside(to)) {
    // Within the room and its threshold: straight, or by way of the clear aisle at the room's centre.
    route = segmentStandable(surface, from, to) ? [from, to] : [from, [...home.center], to];
  } else if (home && (inside(from) || inside(to))) {
    // Out through the doorway to the doorstep, or from the doorstep in through it; the streets carry the rest.
    const leave: Point[] = inside(from) ? [from, home.doorway, home.outside] : [from];
    const enter: Point[] = inside(to) ? [home.outside, home.doorway, to] : [to];
    const middle = exteriorRoute(surface, leave.at(-1)!, enter[0]!);
    if (!middle.length) return { kind: "unavailable", reason: "no-route" };
    route = [...leave.slice(0, -1), ...middle, ...enter.slice(1)];
  } else route = exteriorRoute(surface, from, to);
  for (let i = 1; i < route.length; i++) if (!segmentStandable(surface, route[i - 1]!, route[i]!)) return { kind: "unavailable", reason: "no-route" };
  if (route.length < 2) return { kind: "unavailable", reason: "no-route" };
  return { kind: "walk", route, length: routeLength(route) };
}

export type ObserverArrival = { status: "street"; point: Point } | { status: "unavailable"; reason: "across-water" | "no-geometry" };
/**
 * Where an observer arrives for an admitted place anchor: a planned home's own doorstep, the street outside a
 * workplace's door, or a public place's own paving. A founded frontier place has no walk from the city.
 */
export function observerArrival(placeId: string, buildings: readonly CityBuilding[]): ObserverArrival {
  if (/^frontier-\d+-\d+$/.test(placeId)) return { status: "unavailable", reason: "across-water" };
  const map = createPedestrianMap(buildings);
  if (/^home-\d+$/.test(placeId)) {
    const home = homeInteriorLayout(buildings, placeId);
    return home ? { status: "street", point: [...home.outside] } : { status: "unavailable", reason: "no-geometry" };
  }
  const planned = /^work-\d+$/.test(placeId) && isPlanLayout(buildings) ? buildings.find((b) => b.placeId === placeId) : undefined;
  const centre = planned?.frontage ?? PUBLIC_PLACES[placeId];
  if (!centre) return { status: "unavailable", reason: "no-geometry" };
  const point = nearestStreetPoint(map, centre[0], centre[1]);
  return point ? { status: "street", point } : { status: "unavailable", reason: "no-geometry" };
}

/** The connected street point nearest (x, z) on the network's own half-unit grid, within a few units. */
function nearestStreetPoint(map: PedestrianMap, x: number, z: number): Point | undefined {
  let best: Point | undefined, distance = Infinity;
  const cx = Math.round(x / .5), cz = Math.round(z / .5);
  for (let i = cx - 16; i <= cx + 16; i++) for (let k = cz - 16; k <= cz + 16; k++) {
    const px = i * .5, pz = k * .5, d = Math.hypot(px - x, pz - z);
    if (d >= distance || !observerCanStand({ map }, px, pz)) continue;
    const point: Point = [px, CITY_GROUND_Y, pz];
    if (isConnectedPosition(map, point)) { best = point; distance = d; }
  }
  return best ?? (() => { const fallback = nearestConnectedPosition(map, [x, CITY_GROUND_Y, z]); return observerCanStand({ map }, fallback[0], fallback[2]) ? fallback : undefined; })();
}

/**
 * Where a walk begins: at the opened home's doorstep, else on the street under the current view, else placed
 * (not walked) on the nearest connected street.
 */
export function observerStart(map: PedestrianMap, home: HomeInteriorLayout | undefined, viewTarget: readonly number[]): { point: Point; from: "door" | "view" | "nearest-street" } {
  if (home) return { point: [...home.outside], from: "door" };
  const ground: Point = [viewTarget[0]!, CITY_GROUND_Y, viewTarget[2]!];
  if (observerCanStand({ map }, ground[0], ground[2])) return { point: ground, from: "view" };
  return { point: nearestConnectedPosition(map, ground), from: "nearest-street" };
}

export interface ObserverState { foot: Point; route: Point[] }
export interface ObserverFrame {
  foot: Point;
  /** Turn to apply to the facing this frame (radians, positive to the left). */
  turn: number;
  /** True when the viewer's own keys or buttons moved or turned it (any planned travel is then dropped). */
  manual: boolean;
  /** Distance covered along planned travel this frame. */
  travelled: number;
  /** Planned travel reached its end this frame. */
  arrived: boolean;
  /** Direction of planned travel this frame, to face along it. */
  heading?: [number, number] | undefined;
}

/** Facing [x, z] turned by `turn` radians to the left (the scene's yaw). */
export function turnFacing(facing: readonly [number, number], turn: number): [number, number] {
  const c = Math.cos(turn), s = Math.sin(turn);
  return [facing[0] * c + facing[1] * s, -facing[0] * s + facing[1] * c];
}

/**
 * One frame of observer movement. Held keys walk and turn continuously; under reduced motion only discrete
 * steps move it, and planned travel jumps to its end instead of animating. Manual input cancels planned travel.
 */
export function advanceObserver(state: ObserverState, surface: ObserverSurface, input: WalkInput, facing: readonly [number, number], dt: number, reducedMotion: boolean): ObserverFrame {
  const held = !reducedMotion && (input.held.forward || input.held.back || input.held.left || input.held.right);
  if (held || input.steps.length) {
    state.route = [];
    let turn = 0, foot = state.foot;
    for (const step of input.steps.splice(0)) {
      if (step === "left" || step === "right") { turn += step === "left" ? TURN_STEP : -TURN_STEP; continue; }
      const [fx, fz] = turnFacing(facing, turn), sign = step === "forward" ? 1 : -1;
      foot = stepObserver(surface, foot, fx * STEP * sign, fz * STEP * sign);
    }
    if (held) {
      turn += ((input.held.left ? 1 : 0) - (input.held.right ? 1 : 0)) * TURN_SPEED * dt;
      const along = ((input.held.forward ? 1 : 0) - (input.held.back ? 1 : 0)) * WALK_SPEED * dt;
      const [fx, fz] = turnFacing(facing, turn);
      if (along) foot = stepObserver(surface, foot, fx * along, fz * along);
    }
    state.foot = foot;
    return { foot, turn, manual: true, travelled: 0, arrived: false };
  }
  if (!state.route.length) return { foot: state.foot, turn: 0, manual: false, travelled: 0, arrived: false };
  if (reducedMotion) {
    const travelled = routeLength([state.foot, ...state.route]);
    state.foot = [...state.route.at(-1)!];
    state.route = [];
    return { foot: state.foot, turn: 0, manual: false, travelled, arrived: true };
  }
  let budget = TRAVEL_SPEED * dt, travelled = 0, heading: [number, number] | undefined;
  let foot = state.foot;
  while (budget > 0 && state.route.length) {
    const next = state.route[0]!, dx = next[0] - foot[0], dz = next[2] - foot[2], distance = Math.hypot(dx, dz);
    if (distance > 1e-9) heading = [dx / distance, dz / distance];
    if (distance <= budget) { foot = [...next]; budget -= distance; travelled += distance; state.route.shift(); continue; }
    const t = budget / distance;
    foot = [foot[0] + dx * t, foot[1] + (next[1] - foot[1]) * t, foot[2] + dz * t];
    travelled += budget; budget = 0;
  }
  state.foot = foot;
  return { foot, turn: 0, manual: false, travelled, arrived: state.route.length === 0, heading };
}

/** Within the opened home's room or on its threshold (its footprint and door strip, furnishings aside). */
export function observerInHome(home: HomeInteriorLayout, x: number, z: number): boolean {
  const floor = homeFloor(home);
  const [lx, lz] = local(home, x, z);
  return Math.abs(lx) < home.width / 2 && Math.abs(lz) < home.depth / 2 || Math.abs(lx) < floor.doorHalf && lz >= home.depth / 2 && lz <= floor.outsideZ;
}

/** What the scene tells the page about the observer's walk, so the page can say it plainly. */
export type ObserverNote =
  | "start-door" | "start-view" | "start-nearest-street"
  | "travel" | "arrived" | "jump-across-water" | "jump-no-route" | "left-home" | "returned-to-city";
