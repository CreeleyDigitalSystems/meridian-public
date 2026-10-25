import type { CityBuilding } from "./city-layout.js";
import { isPlanLayout, isPlanPaving, PLAN_QUAY_PLANTERS } from "./city-plan.js";
import { QUAY_STATION_CLEARANCE, QUAY_STATIONS } from "./sky-tram-sites.js";

export const CITY_GROUND_Y = .56;
const gardenTrees = Array.from({length: 8}, (_, i) => [Math.sin(i * Math.PI / 4) * 8.6, 5 + Math.cos(i * Math.PI / 4) * 8.6]);
const quayTrees = Array.from({length: 48}, (_, i) => [Math.sin(i * Math.PI / 24) * 39.5, Math.cos(i * Math.PI / 24) * 39.5]);

/** Conservative pedestrian clearance: water, civic podiums and building plinths are not paths. */
export function isCityWalkable(x: number, z: number, buildings: readonly CityBuilding[]): boolean {
  // The planned city: its paving is the path network; the garden, spire podium and market stalls still stand on it.
  if (isPlanLayout(buildings)) return Math.hypot(x, z) < 41.5
    && isPlanPaving(x, z)
    && Math.hypot(x, z - 5) > 7
    && Math.hypot(x, z + 9) > 6.5
    && gardenTrees.every(([tx, tz]) => Math.hypot(x - tx!, z - tz!) > 1.1)
    && PLAN_QUAY_PLANTERS.every(([tx, tz]) => Math.hypot(x - tx, z - tz) > .9)
    && QUAY_STATIONS.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > QUAY_STATION_CLEARANCE)
    && [-6, 6].every((mx) => Math.abs(x - mx) > 2.4 || Math.abs(z - 20) > 1.8);
  return Math.hypot(x, z) < 41.5
    && Math.hypot(x, z - 5) > 7
    && Math.hypot(x, z + 9) > 6.5
    && gardenTrees.every(([tx, tz]) => Math.hypot(x - tx!, z - tz!) > 1.1)
    && quayTrees.every(([tx, tz]) => Math.hypot(x - tx!, z - tz!) > 1.15)
    && buildings.every((b) => Math.hypot(x - b.x, z - b.z) > b.radius * (b.variant === 3 ? 2 : 1.3) + .45)
    && [-6, 6].every((mx) => Math.abs(x - mx) > 2.4 || Math.abs(z - 20) > 1.8);
}
