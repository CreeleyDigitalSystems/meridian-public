import type { Vector3 } from "three";
import type { CityBuilding } from "./city-layout.js";
import { FRONTIER_ARCHITECTURE, frontierParcelPosition, type FrontierParcelVisual } from "./frontier-visuals.js";

/** A cylinder (x, z, radius), or for a planned building its footprint box [x0, x1, z0, z1]. */
export interface CameraVolume { x: number; z: number; radius: number; bottom: number; top: number; box?: readonly [number, number, number, number] }
/** Conservative building envelopes; decorative bridges are not collision geometry. */
export function cameraVolumes(buildings: readonly CityBuilding[]): CameraVolume[] {
  return [...buildings.map((b): CameraVolume => b.rect
    // Planned footprints are exact: a small skin keeps the lens off the wall without closing the street.
    ? { x: b.x, z: b.z, radius: 0, bottom: -.2, top: b.height + 1.2, box: [b.rect[0] - .25, b.rect[1] + .25, b.rect[2] - .25, b.rect[3] + .25] }
    : { x: b.x, z: b.z, radius: b.radius * 1.4 + .3, bottom: -.2, top: b.height + 4 }),
    { x: 0, z: -9, radius: 4.5, bottom: -.2, top: 38 },
    { x: 0, z: 5, radius: 2.5, bottom: -.2, top: 4.5 }];
}

/**
 * Conservative envelopes for buildings on frontier parcels (drawn by city-architecture.tsx): a build under way
 * also carries scaffolding and a tower crane beside it. Charted and fogged parcels hold nothing solid.
 */
export function frontierCameraVolumes(frontier: readonly FrontierParcelVisual[], exceptParcelId?: string): CameraVolume[] {
  return frontier.filter((p) => (p.state === "built" || p.state === "building") && p.buildKind && p.id !== exceptParcelId).map((p): CameraVolume => {
    const [x, z] = frontierParcelPosition(p.ring, p.slot);
    const look = FRONTIER_ARCHITECTURE[p.buildKind!];
    const building = p.state === "building";
    return { x, z, radius: look.radius * 1.4 + .3 + (building ? 2.4 : 0), bottom: -.2, top: look.height * 1.25 + (building ? 5.5 : 3) };
  });
}

/** Analytic swept-point/cylinder (or box) intersection; no per-frame arrays or vectors. */
export function cameraSegmentClear(from: Vector3, to: Vector3, volumes: readonly CameraVolume[]): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  for (const v of volumes) {
    let lo = 0, hi = 1;
    if (Math.abs(dy) < 1e-9) { if (from.y < v.bottom || from.y > v.top) continue; }
    else { const a = (v.bottom - from.y) / dy, b = (v.top - from.y) / dy; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
    if (lo > hi) continue;
    if (v.box) {
      // Slab test on x then z, inside the height interval already clipped above.
      if (Math.abs(dx) < 1e-9) { if (from.x < v.box[0] || from.x > v.box[1]) continue; }
      else { const a = (v.box[0] - from.x) / dx, b = (v.box[1] - from.x) / dx; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
      if (Math.abs(dz) < 1e-9) { if (from.z < v.box[2] || from.z > v.box[3]) continue; }
      else { const a = (v.box[2] - from.z) / dz, b = (v.box[3] - from.z) / dz; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
      if (lo <= hi) return false;
      continue;
    }
    const x = from.x - v.x, z = from.z - v.z;
    const a = dx * dx + dz * dz, b = 2 * (x * dx + z * dz), c = x * x + z * z - v.radius * v.radius;
    if (a < 1e-9) { if (c <= 0) return false; continue; }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;
    const root = Math.sqrt(discriminant);
    if (Math.max(lo, (-b - root) / (2 * a)) <= Math.min(hi, (-b + root) / (2 * a))) return false;
  }
  return true;
}
