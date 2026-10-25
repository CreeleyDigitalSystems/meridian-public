import { CITY_GROUND_Y, isCityWalkable } from "./city-walkability.js";
import { frontierResidentPosition } from "./frontier-visuals.js";
import { createPedestrianMap, isConnectedPosition, nearestConnectedPosition } from "./pedestrian-path.js";
import { isPlanLayout } from "./city-plan.js";
export { CITY_GROUND_Y, isCityWalkable } from "./city-walkability.js";

export type CityView = "arrival" | "gardens" | "canal" | "observatory";
export type CityLight = "day" | "blue-hour";
/**
 * Camera presets. View ids are stable interface contracts; their framing now
 * reads the two district languages: "arrival" shows the low working
 * neighbourhood in front of the Upper Meridian skyline, "canal" looks along the
 * riverside workshops, "observatory" rises to the white-and-gold civic terraces.
 */
export const CITY_VIEWS: Record<CityView, { position: [number, number, number]; target: [number, number, number] }> = {
  arrival: { position: [50, 27, 66], target: [0, 8, -3] },
  gardens: { position: [-8, 7.5, 24], target: [-6, 3, 5] },
  canal: { position: [14, 6.5, 30], target: [0, 2, 20] },
  observatory: { position: [25, 22, 21], target: [0, 18, -14] },
};

/** Measured visual limits, in scene units; these do not alter simulation scale. */
export const SCALE_LIMITS = {
  residentHeight: 1.1, streetClearance: 2.6,
  neighbourhoodCore: { min: 2.8, variation: 1.5, max: 4.5 },
  neighbourhoodOuter: { min: 3.2, variation: 2.6, max: 6 },
  upperInner: { min: 7, variation: 5, max: 12 },
  upperOuter: { min: 11, variation: 12, max: 23 },
} as const;

/** Perspective height at the preset target distance, or an explicit measured distance. */
export function residentScreenHeight(view: CityView, viewportHeightPx: number, distance?: number): number {
  const preset = CITY_VIEWS[view];
  const d = distance ?? Math.hypot(...preset.position.map((v, i) => v - preset.target[i]!));
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) throw new RangeError("positive finite distance and viewport required");
  return viewportHeightPx * SCALE_LIMITS.residentHeight / (2 * d * Math.tan(Math.PI / 8));
}

/** Shared visual centres; canonical place ids and positions are unchanged. */
export const PUBLIC_PLACES: Readonly<Record<string, readonly [number, number]>> = {
  "founders-square": [0, 17], "city-garden": [-10, 7],
  "city-market": [0, 23], "city-promenade": [0, 38],
  "founding-district-site": [14, -10],
};

/** Segment/cylinder visibility to resident head height; ignores low paving and geometry beyond the target. */
export function publicPlaceSightline(view: typeof CITY_VIEWS[CityView], placeId: string, buildings: readonly CityBuilding[]): boolean {
  const place = PUBLIC_PLACES[placeId];
  if (!place) return false;
  const [cx, cy, cz] = view.position;
  const dx = place[0] - cx, dz = place[1] - cz;
  const length2 = dx * dx + dz * dz;
  return buildings.every(b => {
    if (b.height <= SCALE_LIMITS.residentHeight) return true;
    const ox = cx - b.x, oz = cz - b.z, radius = b.radius * 1.2;
    const c = ox * ox + oz * oz - radius * radius;
    if (length2 === 0) return c > 0 || Math.min(cy, CITY_GROUND_Y + SCALE_LIMITS.residentHeight) > CITY_GROUND_Y + b.height;
    const dot = ox * dx + oz * dz;
    const discriminant = dot * dot - length2 * c;
    if (discriminant < 0) return true;
    const enter = Math.max(0, (-dot - Math.sqrt(discriminant)) / length2);
    const leave = Math.min(1, (-dot + Math.sqrt(discriminant)) / length2);
    if (enter > leave) return true;
    const y = (t: number) => cy + (CITY_GROUND_Y + SCALE_LIMITS.residentHeight - cy) * t;
    return Math.min(y(enter), y(leave)) > CITY_GROUND_Y + b.height;
  });
}

/** Visual district of a building: a projection for art direction, never engine state or class membership. */
export type CityDistrict = "upper" | "neighbourhood";
export interface CityBuilding {
  x: number; z: number; radius: number; height: number; tiers: number; variant: number; district: CityDistrict; canonicalIndex?: number;
  /** Planned city (city-plan.ts): footprint [x0, x1, z0, z1], the place it houses, its door on the street and its facing. */
  rect?: readonly [number, number, number, number]; placeId?: string; frontage?: readonly [number, number]; yaw?: number;
}

/**
 * Deterministic classification: the rear skyline (beyond the central ring and
 * behind the spire) is Upper Meridian; the central and foreground rings are
 * the working neighbourhoods. Depends only on position, never on residents.
 */
export function districtAt(ring: number, z: number): CityDistrict {
  return ring > 0 && z < -6 ? "upper" : "neighbourhood";
}

/** Visual-only architecture. Never changes the canonical procedural grid or world state. */
export function createCityLayout(seed: string): CityBuilding[] {
  let hash = 2166136261;
  for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const random = () => { hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0; return hash / 4294967296; };
  const buildings: CityBuilding[] = [];
  for (const [ring, count] of [12, 18, 24].entries()) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + ring * 0.19;
      const distance = 14 + ring * 11;
      const z = Math.cos(angle) * distance;
      // Keep the arrival avenue and central landmark sightline open.
      if (ring > 0 && z > 12 && Math.abs(Math.sin(angle)) < 0.42) continue;
      const variation = random();
      const district = districtAt(ring, z);
      buildings.push({
        x: Math.sin(angle) * distance, z,
        radius: 1.4 + random() * 0.75 + ring * 0.18,
        // Public life occupies the low working neighbourhood (terracotta roofs,
        // one to three storeys). Upper Meridian's towers form the rear skyline;
        // they do not surround or conceal the observation space.
        height: district === "neighbourhood"
          ? (ring === 0 ? SCALE_LIMITS.neighbourhoodCore.min + variation * SCALE_LIMITS.neighbourhoodCore.variation : SCALE_LIMITS.neighbourhoodOuter.min + variation * SCALE_LIMITS.neighbourhoodOuter.variation)
          : (ring === 1 ? SCALE_LIMITS.upperInner.min + variation * SCALE_LIMITS.upperInner.variation : SCALE_LIMITS.upperOuter.min + variation * SCALE_LIMITS.upperOuter.variation),
        tiers: 2 + (i % 3), variant: i % 4, district,
        ...(ring === 0 ? { canonicalIndex: i } : {}),
      });
    }
  }
  return buildings;
}

const publicSlots = new WeakMap<readonly CityBuilding[], Map<string, [number, number, number][]>>();
const frontageSlots = new WeakMap<readonly CityBuilding[], Map<number, [number, number, number][]>>();
const doorSlots = new WeakMap<readonly CityBuilding[], Map<string, [number, number, number][]>>();

/** Square locators stay on its forecourt, before the market stalls at z=20. */
export function isWithinPlaceFrontage(placeId: string, point: readonly number[]): boolean {
  return placeId !== "founders-square" || (Math.abs(point[0]!) <= 14 && point[2]! >= 12 && point[2]! < 20);
}

export function residentCityPosition(placeId: string, id: string, buildings: readonly CityBuilding[]): [number, number, number] {
  // A place residents founded beyond the water (D-8): they stand on its parcel, never routed through the city.
  const onFrontier = frontierResidentPosition(placeId, id);
  if (onFrontier) return onFrontier;
  const navigation = createPedestrianMap(buildings);
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  // The planned city: every home and workplace has its own building, so stand on the street outside its door.
  const planned = isPlanLayout(buildings) ? buildings.find((b) => b.placeId === placeId) : undefined;
  if (planned?.frontage) {
    let cache = doorSlots.get(buildings);
    if (!cache) { cache = new Map(); doorSlots.set(buildings, cache); }
    let slots = cache.get(placeId);
    if (!slots) {
      const [fx, fz] = planned.frontage;
      slots = [];
      for (let dx = -3; dx <= 3; dx += .3) for (let dz = -3; dz <= 3; dz += .3) {
        const point: [number, number, number] = [fx + dx, CITY_GROUND_Y, fz + dz];
        if (isConnectedPosition(navigation, point)) slots.push(point);
      }
      slots.sort((p, q) => Math.hypot(p[0] - fx, p[2] - fz) - Math.hypot(q[0] - fx, q[2] - fz));
      // Housemates and colleagues stand apart, nearest the door first.
      slots = slots.reduce<[number, number, number][]>((kept, p) => kept.every((k) => Math.hypot(k[0] - p[0], k[2] - p[2]) > .9) ? [...kept, p] : kept, []);
      cache.set(placeId, slots);
    }
    const ordinal = Math.max(0, Number(/(\d+)$/.exec(id)?.[1] ?? hash) - 1);
    if (slots.length) return [...slots[ordinal % slots.length]!];
  }
  // Distinct saved home/work identities must not collapse to the same numbered
  // building. Homes keep their established ordering; work uses another frontage.
  let placeHash = 0;
  for (const c of placeId) placeHash = (placeHash * 31 + c.charCodeAt(0)) >>> 0;
  const numbered = /^(home|work)-(\d+)$/.exec(placeId);
  const ordinalPlace = numbered ? Math.max(0, Number(numbered[2]) - 1) : placeHash;
  const work = numbered?.[1] === "work";
  const index = ordinalPlace + (work ? Math.floor(buildings.length / 2) : 0);
  const b = buildings[index % Math.max(1, buildings.length)];
  const a = hash * 2.399963;
  const publicPlaces = PUBLIC_PLACES;
  let [x, z] = publicPlaces[placeId] ?? [b?.x ?? 0, b?.z ?? 17];
  if (publicPlaces[placeId]) {
    let cache = publicSlots.get(buildings);
    if (!cache) { cache = new Map(); publicSlots.set(buildings, cache); }
    let slots = cache.get(placeId);
    if (!slots) {
      let surface = cache.get("walkable-surface");
      if (!surface) {
        surface = [];
        for (let gx = -40; gx <= 40; gx += 1.15) for (let gz = -40; gz <= 40; gz += 1.15) {
          const candidate: [number, number, number] = [gx, CITY_GROUND_Y, gz];
          if (isConnectedPosition(navigation, candidate)) surface.push(candidate);
        }
        cache.set("walkable-surface", surface);
      }
      slots = placeId === "founders-square" ? [] : surface.slice();
      if (placeId === "founders-square") {
        for (let sx = -14; sx <= 14; sx += .95) for (let sz = 12; sz < 20; sz += .95) {
          const point: [number,number,number] = [sx,CITY_GROUND_Y,sz];
          if (isConnectedPosition(navigation,point)) slots.push(point);
        }
      }
      slots.sort((p, q) => Math.hypot(p[0] - x, p[2] - z) - Math.hypot(q[0] - x, q[2] - z));
      cache.set(placeId, slots);
    }
    const ordinal = Math.max(0, Number(/(\d+)$/.exec(id)?.[1] ?? hash) - 1);
    if (slots.length) return [...slots[ordinal % slots.length]!];
  } else if (b) {
    let cache = frontageSlots.get(buildings);
    if (!cache) { cache = new Map(); frontageSlots.set(buildings,cache); }
    const buildingIndex = index % buildings.length;
    let slots = cache.get(buildingIndex);
    if (!slots) {
      slots = [];
      const inward = Math.atan2(-b.x,-b.z);
      for (let row=0;row<10;row++) for (let direction=0;direction<21;direction++) {
        const angle = inward + (direction % 2 ? 1 : -1) * Math.ceil(direction/2) * .15;
        const distance = b.radius * (b.variant === 3 ? 2 : 1.3) + .85 + row * .95;
        const point: [number,number,number] = [b.x+Math.sin(angle)*distance,CITY_GROUND_Y,b.z+Math.cos(angle)*distance];
        if (isConnectedPosition(navigation,point) && slots.every(p=>Math.hypot(p[0]-point[0],p[2]-point[2])>.9)) slots.push(point);
      }
      cache.set(buildingIndex,slots);
    }
    const frontage = Math.floor(ordinalPlace / buildings.length) * 2 + (work ? 1 : 0);
    if (slots.length) return [...slots[frontage % slots.length]!];
  }
  if (isCityWalkable(x, z, buildings)) return nearestConnectedPosition(navigation, [x, CITY_GROUND_Y, z]);
  // Find the nearest safe public-space location, not a point underneath scenery.
  for (let step = 1; step <= 70; step++) {
    for (let direction = 0; direction < 24; direction++) {
      const angle = a + direction * Math.PI / 12;
      const px = x + Math.sin(angle) * step * .35;
      const pz = z + Math.cos(angle) * step * .35;
      if (isConnectedPosition(navigation, [px, CITY_GROUND_Y, pz])) return [px, CITY_GROUND_Y, pz];
    }
  }
  return nearestConnectedPosition(navigation, [0, CITY_GROUND_Y, 30]);
}

/** Observe from the public-space side of the resident, away from their building. */
export function residentObservationCamera(position: readonly [number, number, number], buildings?: readonly CityBuilding[]) {
  const [x, y, z] = position;
  const radius = Math.max(1, Math.hypot(x, z));
  if (buildings) {
    const inward = Math.atan2(-x, -z);
    for (const distance of [4.7, 3.8, 3]) for (let i = 0; i < 24; i++) {
      const a = inward + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 12;
      const cx = x + Math.sin(a) * distance, cz = z + Math.cos(a) * distance;
      let clear = true;
      for (let t = 0; t <= 1; t += .05) if (!isCityWalkable(x + (cx - x) * t, z + (cz - z) * t, buildings)) { clear = false; break; }
      if (clear) return { position: [cx, y + 2.8, cz] as [number, number, number], target: [x, y + .65, z] as [number, number, number] };
    }
    return { position: [x, y + 5, z] as [number, number, number], target: [x, y + .65, z] as [number, number, number] };
  }
  return {
    position: [x - x / radius * 4.5 + z / radius * 1.3, y + 2.1, z - z / radius * 4.5 - x / radius * 1.3] as [number, number, number],
    target: [x, y + 0.7, z] as [number, number, number],
  };
}
