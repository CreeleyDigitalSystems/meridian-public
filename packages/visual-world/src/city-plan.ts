import type { CityBuilding } from './city-layout.js';

/** Independently authored public-demo layout. No imported kit coordinates or model bounds. */
export type PlanRect = readonly [number, number, number, number];
export function createPlanLayout(): CityBuilding[] {
  const xs = [-28, -20, -12, 12, 20, 28];
  const zs = [-25, -18, -11, -4, 3, 10, 17, 24];
  return Array.from({ length: 48 }, (_, i) => {
    const x = xs[i % xs.length]!, z = zs[Math.floor(i / xs.length)]!;
    const kind = i < 24 ? 'home' : 'work', number = String(i % 24 + 1).padStart(2, '0');
    return { x, z, radius: 2, height: kind === 'home' ? 3.8 : 4.6, tiers: 2, variant: i % 4,
      district: 'neighbourhood', placeId: `${kind}-${number}`, rect: [x - 2, x + 2, z - 2, z + 2],
      frontage: [x, z + 3], yaw: 0 };
  });
}
let sharedPlan: readonly CityBuilding[] | undefined;
/** The same owned layout instance is shared by the accepted scene, home and pedestrian caches. */
export function planLayout(): readonly CityBuilding[] {
  return sharedPlan ??= Object.freeze(createPlanLayout());
}
const footprints = planLayout();
export function isPlanLayout(buildings: readonly CityBuilding[]): boolean {
  return buildings.length > 0 && buildings.every(b => b.rect !== undefined);
}
export function insideRect(rect: PlanRect, x: number, z: number, margin = 0): boolean {
  return x >= rect[0] - margin && x <= rect[1] + margin && z >= rect[2] - margin && z <= rect[3] + margin;
}
export function isPlanPaving(x: number, z: number): boolean {
  return Math.hypot(x, z) <= 41.5 && !footprints.some(b => insideRect(b.rect!, x, z, .2));
}
export const QUAY_STATION_REPLACES = 1.2;
export const PLAN_QUAY_PLANTERS: readonly (readonly [number, number])[] = [];
