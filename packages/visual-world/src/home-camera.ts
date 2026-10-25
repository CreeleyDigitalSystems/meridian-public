import { Vector3 } from "three";
import { cameraSegmentClear, cameraVolumes, frontierCameraVolumes, type CameraVolume } from "./camera-collision.js";
import type { CityBuilding } from "./city-layout.js";
import type { FrontierParcelVisual } from "./frontier-visuals.js";
import { homeInteriorParts, type HomeInteriorLayout } from "./home-interior.js";

type Point = [number, number, number];
type Vec = Readonly<{ x: number; y: number; z: number }> | readonly [number, number, number];

/** The scene camera's vertical field of view (WorldCanvas), used to frame the room on any aspect ratio. */
const FOV = 45 * Math.PI / 180;
/**
 * Orbit limits while a home is open. The polar limits match the city's OrbitControls; distance limits keep the
 * room reachable; `reach` bounds how far the orbit target may be panned from the room.
 */
export const HOME_ORBIT = Object.freeze({ minDistance: 1.2, maxDistance: 24, minPolar: .12, maxPolar: Math.PI * .485, reach: 1.5 });

export interface HomeCameraPose {
  position: Point; target: Point;
  /** exterior: the lens stands outside the opened shell; cutaway: it looks down into the room from above it. */
  mode: "exterior" | "cutaway";
  /** full: the room centre and its four quarters are in sight; centre: only the centre; obstructed: nothing clear was found. */
  view: "full" | "centre" | "obstructed";
}

/** Every solid volume around an opened home: the city's buildings and frontier builds, less the opened shell itself. */
export function homeNeighbourVolumes(buildings: readonly CityBuilding[], home: HomeInteriorLayout, frontier: readonly FrontierParcelVisual[] = []): CameraVolume[] {
  const city = cameraVolumes(buildings).filter((_, index) => !(home.kind === "planned" && index === home.buildingIndex));
  return [...city, ...frontierCameraVolumes(frontier, home.kind === "frontier" ? home.parcelId : undefined)];
}

const occluderCache = new WeakMap<HomeInteriorLayout, CameraVolume[]>();
/** The room's own cut-away walls, as boxes in the room's local frame (x across, z toward the doorway). */
function homeOccluders(home: HomeInteriorLayout): CameraVolume[] {
  let occluders = occluderCache.get(home);
  if (occluders) return occluders;
  occluders = homeInteriorParts(home).filter((part) => part.role === "wall").map((part) => {
    const [x, z] = toLocal(home, part.position);
    return { x, z, radius: 0, bottom: part.position[1] - part.scale[1] / 2, top: part.position[1] + part.scale[1] / 2,
      box: [x - part.scale[0] / 2, x + part.scale[0] / 2, z - part.scale[2] / 2, z + part.scale[2] / 2] as const };
  });
  occluderCache.set(home, occluders);
  return occluders;
}

const at = (p: Vec): Point => "x" in p ? [p.x, p.y, p.z] : [p[0], p[1], p[2]];
function toLocal(home: HomeInteriorLayout, p: readonly number[]): [number, number] {
  const dx = p[0]! - home.center[0], dz = p[2]! - home.center[2];
  return [Math.cos(home.yaw) * dx - Math.sin(home.yaw) * dz, Math.sin(home.yaw) * dx + Math.cos(home.yaw) * dz];
}
const scratch = { a: new Vector3(), b: new Vector3() };
function segmentClear(from: readonly number[], to: readonly number[], volumes: readonly CameraVolume[]): boolean {
  return cameraSegmentClear(scratch.a.set(from[0]!, from[1]!, from[2]!), scratch.b.set(to[0]!, to[1]!, to[2]!), volumes);
}

/** Lens-to-point visibility past the neighbours and the room's own cut-away walls. */
export function homeSightClear(home: HomeInteriorLayout, neighbours: readonly CameraVolume[], from: Vec, to: Vec): boolean {
  const a = at(from), b = at(to);
  if (!segmentClear(a, b, neighbours)) return false;
  const [ax, az] = toLocal(home, a), [bx, bz] = toLocal(home, b);
  return segmentClear([ax, a[1], az], [bx, b[1], bz], homeOccluders(home));
}

/** Lens distance at which the whole room (and its walls) fits the view on this aspect ratio. */
export function homeFramingDistance(home: HomeInteriorLayout, aspect: number): number {
  const radius = Math.hypot(home.width, home.depth) / 2 + .35;
  const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * Math.max(.2, aspect)));
  return Math.min(18, Math.max(3, radius / Math.sin(half)));
}

/** Within the opened shell's footprint (the room plus its wall), where only the cut-away shell stood. */
function overShell(home: HomeInteriorLayout, p: readonly number[]): boolean {
  const [x, z] = toLocal(home, p);
  return Math.abs(x) <= home.width / 2 + .25 && Math.abs(z) <= home.depth / 2 + .25;
}

/**
 * A bounded set of room-centred poses, tried in order: around the authored front-right view first, then the
 * rest of the circle and steeper angles, then a cutaway looking down into the room from above its own (hidden)
 * shell. A pose is accepted only when its lens stands outside every neighbour and the room centre is in sight.
 */
export function homeCameraPose(home: HomeInteriorLayout, neighbours: readonly CameraVolume[], aspect = 16 / 9): HomeCameraPose {
  const target: Point = [home.center[0], home.center[1] + .5, home.center[2]];
  const quarters: Point[] = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
    const x = sx! * home.width / 4, z = sz! * home.depth / 4;
    return [home.center[0] + Math.cos(home.yaw) * x + Math.sin(home.yaw) * z, home.center[1] + .6, home.center[2] - Math.sin(home.yaw) * x + Math.cos(home.yaw) * z];
  });
  const fit = homeFramingDistance(home, aspect);
  const clampDistance = (d: number) => Math.min(HOME_ORBIT.maxDistance - .5, Math.max(HOME_ORBIT.minDistance + .3, d));
  const lens = (bearing: number, polar: number, distance: number): Point => {
    const lx = Math.sin(bearing) * Math.sin(polar) * distance, lz = Math.cos(bearing) * Math.sin(polar) * distance;
    return [target[0] + Math.cos(home.yaw) * lx + Math.sin(home.yaw) * lz, target[1] + Math.cos(polar) * distance, target[2] - Math.sin(home.yaw) * lx + Math.cos(home.yaw) * lz];
  };
  const rate = (position: Point): HomeCameraPose | undefined => {
    if (!segmentClear(position, position, neighbours) || !homeSightClear(home, neighbours, position, target)) return undefined;
    return { position, target, mode: overShell(home, position) ? "cutaway" : "exterior", view: quarters.every((q) => homeSightClear(home, neighbours, position, q)) ? "full" : "centre" };
  };
  // Bearing of the authored preset (width × .9 across, depth × 2.4 out of the doorway).
  const preferred = Math.atan2(home.width * .9, home.depth * 2.4);
  const offsets = [0, .35, -.35, .7, -.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75, 2.1, -2.1, 2.45, -2.45, 2.8, -2.8, Math.PI];
  const framed = [fit, fit * 1.25].map(clampDistance), closer = [fit * .8, fit * .6].map(clampDistance);
  // Whole-room framing near the authored bearing first; closer lenses next; then the rest of the circle.
  const tiers = [
    { offsets: offsets.slice(0, 7), polars: [1, .8, .6], distances: framed },
    { offsets: offsets.slice(0, 7), polars: [1, .8, .6], distances: closer },
    { offsets, polars: [1, .8, .6, .42], distances: [...framed, ...closer] },
  ];
  const seen = new Set<string>();
  let fallback: HomeCameraPose | undefined;
  const better = (pose: HomeCameraPose) => !fallback || (pose.view === "full" && fallback.view !== "full") || (pose.view === fallback.view && pose.mode === "exterior" && fallback.mode === "cutaway");
  for (const tier of tiers) for (const polar of tier.polars) for (const offset of tier.offsets) for (const distance of tier.distances) {
    const key = `${polar}:${offset}:${distance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pose = rate(lens(preferred + offset, polar, distance));
    if (pose?.mode === "exterior" && pose.view === "full") return pose;
    if (pose && better(pose)) fallback = pose;
  }
  // Cutaway: look down into the room from just above its own shell, leaning toward the doorway, the lens kept
  // over the footprint so no neighbouring facade can stand between it and the room.
  const inset = Math.min(home.width, home.depth) / 2 * .6;
  for (const polar of [HOME_ORBIT.minPolar + .01, .2, .3]) for (const bearing of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const pose = rate(lens(bearing, polar, clampDistance(Math.min(fit, inset / Math.sin(polar)))));
    if (pose && better(pose)) fallback = pose;
    if (fallback?.view === "full") return fallback;
  }
  return fallback ?? { position: lens(0, HOME_ORBIT.minPolar + .01, clampDistance(inset / Math.sin(HOME_ORBIT.minPolar + .01))), target, mode: "cutaway", view: "obstructed" };
}

/**
 * The lens path for a camera transition: straight when that segment is clear; otherwise up, across above every
 * volume under the straight path, and down. Each leg is checked; a lens starting inside a volume cuts instead.
 */
export function cameraTransitionPath(from: Point, to: Point, volumes: readonly CameraVolume[]): { waypoints: Point[]; cut: boolean } {
  if (segmentClear(from, to, volumes)) return { waypoints: [to], cut: false };
  let ceiling = Math.max(from[1], to[1]);
  for (const volume of volumes) {
    // Does this footprint meet the ground track of the straight path?
    if (!cameraSegmentClear(scratch.a.set(from[0], 0, from[2]), scratch.b.set(to[0], 0, to[2]), [{ ...volume, bottom: -1, top: 1 }])) ceiling = Math.max(ceiling, volume.top);
  }
  const height = ceiling + 1.5;
  const waypoints: Point[] = [[from[0], height, from[2]], [to[0], height, to[2]], to];
  let previous = from;
  for (const point of waypoints) {
    if (!segmentClear(previous, point, volumes)) return { waypoints: [to], cut: true };
    previous = point;
  }
  return { waypoints, cut: false };
}

/**
 * The orbit's polar limits for this frame. They bound the viewer's own orbit (HOME_ORBIT); a scripted fly-in to a
 * home view follows its checked path instead, because the controls clamp the lens on every update and would hold
 * it short of a waypoint straight above the room. The limits return once the lens arrives, at a pose inside them.
 */
export function applyOrbitPolarLimits(controls: { minPolarAngle: number; maxPolarAngle: number }, flyingIntoHome: boolean): void {
  controls.minPolarAngle = flyingIntoHome ? 0 : HOME_ORBIT.minPolar;
  controls.maxPolarAngle = flyingIntoHome ? Math.PI : HOME_ORBIT.maxPolar;
}

/** A lens transition in progress: the checked waypoints still ahead, and how long the lens has not gained on its goal. */
export interface LensTransition {
  waypoints: Point[];
  /** Cut to the destination when the lens stops gaining on a fixed goal (a home view), rather than hang short of it. */
  cutWhenStalled: boolean;
  closest: number;
  idle: number;
}
export function lensTransition(waypoints: Point[] = [], cutWhenStalled = false): LensTransition {
  return { waypoints, cutWhenStalled, closest: Infinity, idle: 0 };
}
/** Seconds without headway before a stalled transition into a home view cuts to its destination. */
export const TRANSITION_STALL_SECONDS = 1;
/**
 * How near the lens passes a waypoint before heading for the next: loosely on the way, but it settles over the
 * room at the last one, so the descent into the home view follows its checked leg rather than cutting the corner.
 */
export const WAYPOINT_PASS = Object.freeze({ through: .6, last: .05 });
const goalScratch = new Vector3();

/**
 * One frame of a camera transition, after the orbit controls' own update: the lens eases through each checked
 * waypoint (WAYPOINT_PASS) and then to its destination (arrived within .04), the target easing to the aim;
 * `update` lets the controls apply their limits. A home view's transition that gains nothing on its goal for
 * TRANSITION_STALL_SECONDS cuts to its checked destination instead of parking short of it.
 */
export function stepLensTransition(transition: LensTransition, lens: Vector3, target: Vector3, destination: Vector3, aim: Vector3, dt: number, update: () => void): "moving" | "arrived" | "cut" {
  const step = Math.min(dt, .05);
  const alpha = 1 - Math.exp(-step * 3);
  const next = transition.waypoints[0];
  const goal = next ? goalScratch.set(...next) : destination;
  lens.lerp(goal, next ? Math.min(1, alpha * 1.6) : alpha); target.lerp(aim, alpha); update();
  const gap = lens.distanceTo(goal);
  if (next && gap < (transition.waypoints.length > 1 ? WAYPOINT_PASS.through : WAYPOINT_PASS.last)) { transition.waypoints.shift(); transition.closest = Infinity; transition.idle = 0; return "moving"; }
  if (!next && gap < .04) return "arrived";
  if (!transition.cutWhenStalled) return "moving";
  if (gap < transition.closest - 1e-3) { transition.closest = gap; transition.idle = 0; return "moving"; }
  transition.idle += step;
  if (transition.idle < TRANSITION_STALL_SECONDS) return "moving";
  transition.waypoints = [];
  lens.copy(destination); target.copy(aim); update();
  return "cut";
}

/**
 * While a home is open, an orbit pose is kept only when its lens stands outside every neighbour and no neighbour
 * stands between it and the orbit target (the room). The opened shell itself is not a neighbour.
 */
export function homeLensSafe(neighbours: readonly CameraVolume[], lens: Vec, target: Vec): boolean {
  const a = at(lens), b = at(target);
  return segmentClear(a, a, neighbours) && segmentClear(a, b, neighbours);
}

/** Keeps a panned orbit target within reach of the opened room; the lens moves with it. True when it moved. */
export function clampHomeTarget(home: HomeInteriorLayout, target: Vector3, lens: Vector3): boolean {
  const limit = Math.max(home.width, home.depth) / 2 + HOME_ORBIT.reach;
  const dx = target.x - home.center[0], dz = target.z - home.center[2], distance = Math.hypot(dx, dz);
  const low = home.center[1], high = home.center[1] + 3;
  let mx = 0, my = 0, mz = 0;
  if (distance > limit) { mx = dx / distance * limit - dx; mz = dz / distance * limit - dz; }
  if (target.y < low) my = low - target.y; else if (target.y > high) my = high - target.y;
  if (!mx && !my && !mz) return false;
  target.x += mx; target.y += my; target.z += mz;
  lens.x += mx; lens.y += my; lens.z += mz;
  return true;
}
