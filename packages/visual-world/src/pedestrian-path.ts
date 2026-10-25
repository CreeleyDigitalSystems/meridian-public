import type { ResidentRenderProfile } from "./resident-appearance.js";
import { CITY_GROUND_Y, isCityWalkable } from "./city-walkability.js";
import type { CityBuilding } from "./city-layout.js";

type Point = [number, number, number];
const STEP = .5;
const SIZE = 167;
const HALF = 83;
export interface PedestrianMap { open: Uint8Array; adjacency: Uint8Array; buildings: readonly CityBuilding[] }
const mapCache = new WeakMap<readonly CityBuilding[], PedestrianMap>();
const OFFSETS = [-SIZE, SIZE, -1, 1] as const;
const pointAt = (index: number): Point => [(index % SIZE - HALF) * STEP, CITY_GROUND_Y, (Math.floor(index / SIZE) - HALF) * STEP];

export function createPedestrianMap(buildings: readonly CityBuilding[]): PedestrianMap {
  const cached = mapCache.get(buildings);
  if (cached) return cached;
  const map: PedestrianMap = { buildings, adjacency: new Uint8Array(SIZE * SIZE), open: Uint8Array.from({length: SIZE * SIZE}, (_, i) => {
    const [x, , z] = pointAt(i);
    return isCityWalkable(x, z, buildings) ? 1 : 0;
  }) };
  // Geometry is tested once per undirected edge, never during a route search.
  for (let current = 0; current < map.open.length; current++) {
    if (!map.open[current]) continue;
    for (const direction of [1, 3]) {
      const next = current + OFFSETS[direction]!;
      if (next >= map.open.length || !map.open[next] || Math.abs(next % SIZE - current % SIZE) > 1) continue;
      if (!clearSegment(map, pointAt(current), pointAt(next))) continue;
      map.adjacency[current]! |= 1 << direction;
      map.adjacency[next]! |= 1 << (direction ^ 1);
    }
  }
  const visited = new Uint8Array(map.open.length);
  const queue = new Int32Array(map.open.length);
  let largest = new Int32Array(0);
  for (let start = 0; start < map.open.length; start++) {
    if (!map.open[start] || visited[start]) continue;
    let head = 0, tail = 1;
    queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const current = queue[head++]!;
      for (let direction = 0; direction < OFFSETS.length; direction++) {
        if (!(map.adjacency[current]! & (1 << direction))) continue;
        const next = current + OFFSETS[direction]!;
        if (visited[next]) continue;
        visited[next] = 1; queue[tail++] = next;
      }
    }
    if (tail > largest.length) largest = queue.slice(0, tail);
  }
  map.open.fill(0);
  for (const index of largest) map.open[index] = 1;
  for (let index = 0; index < map.open.length; index++) if (!map.open[index]) map.adjacency[index] = 0;
  mapCache.set(buildings, map);
  return map;
}

function clearSegment(map: PedestrianMap, a: Point, b: Point): boolean {
  const steps = Math.ceil(Math.hypot(a[0] - b[0], a[2] - b[2]) * 40);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    if (!isCityWalkable(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, map.buildings)) return false;
  }
  return true;
}

function nearestNode(map: PedestrianMap, point: Point): number {
  if (!isCityWalkable(point[0], point[2], map.buildings)) return -1;
  let best = -1, distance = Infinity;
  const cx = Math.round(point[0] / STEP) + HALF, cz = Math.round(point[2] / STEP) + HALF;
  for (let x = Math.max(0, cx - 2); x <= Math.min(SIZE - 1, cx + 2); x++) for (let z = Math.max(0, cz - 2); z <= Math.min(SIZE - 1, cz + 2); z++) {
    const i = z * SIZE + x;
    if (!map.open[i]) continue;
    const p = pointAt(i), d = Math.hypot(p[0] - point[0], p[2] - point[2]);
    if (d < distance && d <= 1 && clearSegment(map, point, p)) { best = i; distance = d; }
  }
  return best;
}

/** True only when a safe connector of at most one unit reaches the main network. */
export function isConnectedPosition(map: PedestrianMap, point: Point): boolean {
  return nearestNode(map, point) >= 0;
}

/**
 * Walkable ground beside the main network: walkable here, with an open network node at a corner of its grid cell.
 * Constant time, for moving an observer a little at a time without leaving the connected streets.
 */
export function isOnPedestrianNetwork(map: PedestrianMap, x: number, z: number): boolean {
  if (!isCityWalkable(x, z, map.buildings)) return false;
  const gx = Math.floor(x / STEP) + HALF, gz = Math.floor(z / STEP) + HALF;
  for (let cx = gx; cx <= gx + 1; cx++) for (let cz = gz; cz <= gz + 1; cz++)
    if (cx >= 0 && cz >= 0 && cx < SIZE && cz < SIZE && map.open[cz * SIZE + cx]) return true;
  return false;
}

/** Correct an exterior locator before animation; this is not a walking transition. */
export function nearestConnectedPosition(map: PedestrianMap, point: Point): Point {
  if (isConnectedPosition(map, point)) return [...point];
  let nearest = -1, distance = Infinity;
  for (let index = 0; index < map.open.length; index++) {
    if (!map.open[index]) continue;
    const candidate = pointAt(index);
    const squared = (candidate[0] - point[0]) ** 2 + (candidate[2] - point[2]) ** 2;
    if (squared < distance) { distance = squared; nearest = index; }
  }
  if (nearest < 0) throw new RangeError("no connected pedestrian positions exist");
  return pointAt(nearest);
}

/** Render-only route between two canonical locations; it never changes world state. */
export function pedestrianPath(map: PedestrianMap, from: Point, to: Point): Point[] {
  const start = nearestNode(map, from), end = nearestNode(map, to);
  if (start < 0 || end < 0) return [];
  if (clearSegment(map, from, to)) return [from, to];
  const parents = new Int32Array(SIZE * SIZE).fill(-1);
  const queue = new Int32Array(SIZE * SIZE);
  parents[start] = start; queue[0] = start;
  let head = 0, tail = 1;
  while (head < tail && parents[end] === -1) {
    const current = queue[head++]!;
    for (let direction = 0; direction < OFFSETS.length; direction++) {
      if (!(map.adjacency[current]! & (1 << direction))) continue;
      const next = current + OFFSETS[direction]!;
      if (parents[next] !== -1) continue;
      parents[next] = current; queue[tail++] = next;
    }
  }
  if (parents[end] === -1) return [];
  const route: Point[] = [to];
  for (let cursor = end; cursor !== start; cursor = parents[cursor]!) route.push(pointAt(cursor));
  route.push(pointAt(start), from);
  return route.reverse();
}

/** Local animation of an explicit walking task, not an AI decision or a world event. */
export function residentStrollPath(map: PedestrianMap, centre: Point, from: Point, phase: number): Point[] {
  for (let i = 0; i < 12; i++) {
    const angle = phase * 2.399963 + i * Math.PI / 6;
    const to: Point = [centre[0] + Math.sin(angle) * 1.2, CITY_GROUND_Y, centre[2] + Math.cos(angle) * 1.2];
    if (Math.hypot(to[0] - from[0], to[2] - from[2]) > .5 && clearSegment(map, from, to)) return [from, to];
  }
  return [];
}

export interface RigPart { position: Point; scale: Point; rotation: Point }
export interface ResidentPose { body: RigPart; head: RigPart; hair: RigPart; limbs: RigPart[]; boots: RigPart[]; hands: RigPart[]; seam: RigPart }

/**
 * Shared unit geometry the rig scales (see CityResidents):
 *  body  capsule r .16 h .48  (total height .80)   head/hair/hands sphere r .17
 *  limbs capsule r .085 h .45 (total height .62)   boots box 1×1×1   seam torus r .1
 * Rotations are Euler "YXZ": heading about Y, then pitch about the rig's own lateral axis.
 */
export const RIG = Object.freeze({
  legLength: .5, legScale: .72, armLength: .384, armScale: .6, shoulderY: .86, shoulderX: .115,
  bodyY: .70, headY: .99, headRadius: .078, hipX: .06, bootSize: [.12, .09, .2] as const,
});

/**
 * Ordinary adult proportions at ~1.1 world units (≈6.5 heads tall), below the
 * 1.45-unit storey. Explicit foot origin: legs pivot at the hip so the feet
 * stay on the ground; hands and boots are placed from the limb angles so
 * gestures never detach them. `build` scales the whole figure (0.94..1.06).
 */
export function residentRig(foot: Point, heading: number, stride = 0, armPitch: readonly [number, number] = [0, 0], build = 1, hair: "cropped" | "full" | "tied" = "full", look?: ResidentRenderProfile): ResidentPose {
  const sinH = Math.sin(heading), cosH = Math.cos(heading);
  const width = look?.bodyWidth ?? 1;
  const lateral = (side: number): [number, number] => [cosH * side * build * width, -sinH * side * build * width];
  const at = (side: number, y: number, forward = 0): Point => {
    const [lx, lz] = lateral(side);
    return [foot[0] + lx + sinH * forward * build, foot[1] + y * build, foot[2] + lz + cosH * forward * build];
  };
  /** Unit vector along a limb capsule's +Y axis after YXZ rotation (pitch about the lateral axis). */
  const axis = (pitch: number): Point => [sinH * Math.sin(pitch), Math.cos(pitch), cosH * Math.sin(pitch)];
  const part = (position: Point, scale: Point, pitch = 0): RigPart => ({ position, scale: [scale[0] * build, scale[1] * build, scale[2] * build], rotation: [pitch, heading, 0] });

  const limbs: RigPart[] = [];
  const hands: RigPart[] = [];
  const boots: RigPart[] = [];
  for (const [i, side] of [-1, 1].entries()) {
    const pitch = stride * side * .35 + armPitch[i]!;
    const d = axis(pitch);
    const shoulder = at(side * RIG.shoulderX, RIG.shoulderY);
    const half = RIG.armLength * build / 2;
    limbs.push(part([shoulder[0] - d[0] * half, shoulder[1] - d[1] * half, shoulder[2] - d[2] * half], [RIG.armScale, .62, RIG.armScale], pitch));
    const reach = (RIG.armLength + .03) * build;
    hands.push(part([shoulder[0] - d[0] * reach, shoulder[1] - d[1] * reach, shoulder[2] - d[2] * reach], [.28, .28, .28]));
  }
  for (const side of [-1, 1]) {
    const pitch = -stride * side * .35;
    const d = axis(pitch);
    const hip = at(side * RIG.hipX, RIG.legLength);
    const half = RIG.legLength * build / 2;
    limbs.push(part([hip[0] - d[0] * half, hip[1] - d[1] * half, hip[2] - d[2] * half], [RIG.legScale, .8, RIG.legScale], pitch));
    const end = RIG.legLength * build;
    boots.push(part([hip[0] - d[0] * end + sinH * .035, hip[1] - d[1] * end + RIG.bootSize[1] * build / 2, hip[2] - d[2] * end + cosH * .035], [...RIG.bootSize]));
  }
  if (look) for (const boot of boots) {
    const bottom = boot.position[1] - boot.scale[1] / 2;
    boot.scale = boot.scale.map((v,i) => v * look.footwearScale[i]!) as Point;
    boot.position[1] = bottom + boot.scale[1] / 2;
  }
  const hairScale: Point = hair === "cropped" ? [.47, .34, .47] : hair === "tied" ? [.47, .38, .56] : [.52, .43, .52];
  return {
    body: part(at(0, RIG.bodyY), [.9 * width, .6, .6 * width]),
    head: part(at(0, RIG.headY), look?.faceScale ?? [.46, .52, .46]),
    hair: part(at(0, RIG.headY + .045, hair === "tied" ? -.04 : -.02), hairScale), // set back so brows and eyes stay uncovered
    limbs, boots, hands,
    seam: part(at(0, RIG.headY - .088), [.75, .75, .75], Math.PI / 2),
  };
}
