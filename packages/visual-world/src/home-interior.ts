import { CITY_GROUND_Y, type CityBuilding } from "./city-layout.js";
import { createPedestrianMap, isConnectedPosition } from "./pedestrian-path.js";
import { isPlanLayout, planLayout } from "./city-plan.js";
import { FRONTIER_ARCHITECTURE, frontierParcelPosition, type FrontierParcelVisual } from "./frontier-visuals.js";
import type { Finish } from "./city-theme.js";

type Point = [number, number, number];
export interface HomeInteriorLayout {
  homePlaceId: string;
  /** A home-NN building of the planned city, or a founded home standing on its frontier parcel. */
  kind: "planned" | "frontier";
  /** Index of the planned building in the scene's buildings; -1 for a frontier home, which is drawn per parcel. */
  buildingIndex: number;
  /** The frontier parcel a frontier home stands on. */
  parcelId?: string;
  center: Point; doorway: Point; outside: Point;
  yaw: number; width: number; depth: number;
  camera: { position: Point; target: Point };
}
/** Why a resident's home cannot be opened: said plainly, never by substituting another house. */
export type HomeViewUnavailableReason = "no-anchor" | "not-residential" | "no-geometry" | "no-entrance" | "frontier-not-built";
export type HomeView = { status: "available"; layout: HomeInteriorLayout } | { status: "unavailable"; reason: HomeViewUnavailableReason };

/**
 * The earlier ring layout (createCityLayout) carries no place ids; only its first two buildings were ever
 * furnished homes. Kept for that layout alone; the planned city resolves every home by its own place id.
 */
const LEGACY_INTERIOR_HOMES: Readonly<Record<string, number>> = { "home-01": 0, "home-02": 1 };
/** The AI resident whose saved home is the furnished interior. */
export const INTERIOR_RESIDENT_ID = "resident-02";
/**
 * The interior follows the AI resident's saved home: home-02 before the family
 * forms, home-01 after. Absent, legacy or unsupported homes keep home-02.
 */
export function interiorHomeId(residents: readonly { id: string; homePlaceId?: string | undefined; publicPresentation?:boolean; persona?:string | undefined }[]): string {
  const home=residents.find(r=>r.persona==='luna')?.homePlaceId;
  return home && home in LEGACY_INTERIOR_HOMES ? home : 'unavailable';
}

const FLOOR_Y = CITY_GROUND_Y + .32;
function layoutAt(base: { x: number; z: number }, yaw: number, width: number, depth: number) {
  const at = (x: number, y: number, z: number): Point => [base.x + Math.cos(yaw) * x + Math.sin(yaw) * z, y, base.z - Math.sin(yaw) * x + Math.cos(yaw) * z];
  return {
    at,
    fields: { center: at(0, FLOOR_Y, 0), doorway: at(0, FLOOR_Y, depth / 2), yaw, width, depth,
      camera: { position: at(width * .9, FLOOR_Y + 4, depth * 2.4), target: at(0, FLOOR_Y + .5, 0) } },
  };
}

/** A planned (or legacy) building's interior: it fills its own footprint, less its walls, and opens through its front door. */
function buildingInterior(buildings: readonly CityBuilding[], homePlaceId: string, buildingIndex: number): HomeView {
  const b = buildings[buildingIndex]!;
  const quarter = b.yaw !== undefined && Math.round(b.yaw / (Math.PI / 2)) % 2 !== 0;
  const spanX = b.rect ? b.rect[1] - b.rect[0] : 0, spanZ = b.rect ? b.rect[3] - b.rect[2] : 0;
  const width = b.rect ? (quarter ? spanZ : spanX) - .5 : b.radius * 1.55, depth = b.rect ? (quarter ? spanX : spanZ) - .5 : b.radius * 1.25;
  const nav = createPedestrianMap(buildings);
  // The doorway faces the city centre when that frontage is walkable (home-02);
  // otherwise the first walkable side, so the entrance never opens onto a plaza edge.
  for (const turn of b.yaw !== undefined ? [b.yaw - Math.atan2(-b.x, -b.z)] : [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const yaw = Math.atan2(-b.x, -b.z) + turn;
    const { at, fields } = layoutAt(b, yaw, width, depth);
    for (let distance = depth / 2 + .5; distance <= b.radius * 4 + 4; distance += .25) {
      const outside = at(0, CITY_GROUND_Y, distance);
      if (isConnectedPosition(nav, outside)) return { status: "available", layout: { homePlaceId, kind: "planned", buildingIndex, ...fields, outside } };
    }
  }
  return { status: "unavailable", reason: "no-entrance" };
}

/**
 * A founded frontier home, drawn by the city's own architecture on its parcel (neighbourhoodBuilding, facing the
 * city centre). Its doorstep is the parcel's own ground: the city's street network does not reach across the water.
 */
function frontierInterior(homePlaceId: string, parcel: FrontierParcelVisual): HomeView {
  const [x, z] = frontierParcelPosition(parcel.ring, parcel.slot);
  const { radius } = FRONTIER_ARCHITECTURE.home;
  const shellWidth = radius * 1.7, shellDepth = radius * 1.35;
  const { at, fields } = layoutAt({ x, z }, Math.atan2(-x, -z), shellWidth - .3, shellDepth - .3);
  return { status: "available", layout: { homePlaceId, kind: "frontier", buildingIndex: -1, parcelId: parcel.id, ...fields, outside: at(0, CITY_GROUND_Y, shellDepth / 2 + .7) } };
}

/**
 * Resolves a resident's admitted home presentation anchor to the interior of that same home: a planned home-NN
 * building by its place id, or a founded frontier home on its own parcel. Anything else is unavailable.
 */
export function resolveHomeView(buildings: readonly CityBuilding[], homePlaceId: string | null | undefined, frontier: readonly FrontierParcelVisual[] = []): HomeView {
  if (!homePlaceId || homePlaceId === "unavailable") return { status: "unavailable", reason: "no-anchor" };
  const founded = /^frontier-(\d+)-(\d+)$/.exec(homePlaceId);
  if (founded) {
    const parcel = frontier.find((p) => p.ring === Number(founded[1]) && p.slot === Number(founded[2]));
    if (parcel?.state === "built" && parcel.buildKind === "home") return frontierInterior(homePlaceId, parcel);
    // A finished frontier build that is not a home (a workshop, say) is not residential; anything else is not built.
    return { status: "unavailable", reason: parcel?.state === "built" && parcel.buildKind ? "not-residential" : "frontier-not-built" };
  }
  if (!/^home-\d+$/.test(homePlaceId)) return { status: "unavailable", reason: "not-residential" };
  const buildingIndex = isPlanLayout(buildings)
    ? buildings.findIndex((b) => b.placeId === homePlaceId)
    : buildings.length >= 2 ? LEGACY_INTERIOR_HOMES[homePlaceId] ?? -1 : -1;
  return buildingIndex >= 0 && buildingIndex < buildings.length ? buildingInterior(buildings, homePlaceId, buildingIndex) : { status: "unavailable", reason: "no-geometry" };
}

/** One saved home at a time. Its furnishings are a visual interpretation. */
export function homeInteriorLayout(buildings: readonly CityBuilding[], homePlaceId: string | null | undefined, frontier: readonly FrontierParcelVisual[] = []): HomeInteriorLayout | undefined {
  const view = resolveHomeView(buildings, homePlaceId, frontier);
  return view.status === "available" ? view.layout : undefined;
}

/** The home view the live scene would open for this anchor, against the page's planned city. */
export function cityHomeView(homePlaceId: string | null | undefined, frontier: readonly FrontierParcelVisual[] = []): HomeView {
  return resolveHomeView(planLayout(), homePlaceId, frontier);
}

export interface HomeInteriorPart { role: "floor" | "wall" | "furniture"; finish: Finish; position: Point; scale: Point; rotation: Point }
/** Half-width of the clear aisle from the doorway to the room centre, kept free of furnishings in every home. */
export const HOME_AISLE = .25;
/**
 * Reuses the existing box batches and architectural palette, leaving the centre and doorway clear. Furnishings
 * keep to the room and out of the aisle (in a small room they are trimmed, or left out when nothing would remain).
 */
export function homeInteriorParts(home: HomeInteriorLayout): HomeInteriorPart[] {
  const {center, yaw, width:w, depth:d} = home;
  const parts: HomeInteriorPart[] = [];
  /** Trims [lo, hi] to [min, max] and out of (-gap, gap); undefined when too little is left. */
  const fit = (lo: number, hi: number, min: number, max: number, gap: number): [number, number] | undefined => {
    lo = Math.max(lo, min); hi = Math.min(hi, max);
    if (lo < gap && hi > -gap) { if (lo + hi >= 0) lo = Math.max(lo, gap); else hi = Math.min(hi, -gap); }
    return hi - lo >= .08 ? [lo, hi] : undefined;
  };
  const box = (role: HomeInteriorPart["role"], finish: Finish, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    if (role === "furniture") {
      const fx = fit(x - sx / 2, x + sx / 2, -w / 2, w / 2, HOME_AISLE), fz = fit(z - sz / 2, z + sz / 2, -d / 2, d / 2, 0);
      if (!fx || !fz) return;
      // Untrimmed pieces keep their exact authored numbers.
      if (fx[0] !== x - sx / 2 || fx[1] !== x + sx / 2) [x, sx] = [(fx[0] + fx[1]) / 2, fx[1] - fx[0]];
      if (fz[0] !== z - sz / 2 || fz[1] !== z + sz / 2) [z, sz] = [(fz[0] + fz[1]) / 2, fz[1] - fz[0]];
    }
    parts.push({role,finish,position:[center[0]+Math.cos(yaw)*x+Math.sin(yaw)*z,center[1]+y,center[2]-Math.sin(yaw)*x+Math.cos(yaw)*z],scale:[sx,sy,sz],rotation:[0,yaw,0]});
  };
  box("floor","timber",0,-.08,0,w,.16,d);
  box("wall","plaster",0,.85,-d/2,w,1.7,.12);
  box("wall","ochre",-w/2,.85,0,.12,1.7,d);
  box("wall","plaster",w/2,.16,0,.12,.32,d);
  for(const side of [-1,1]) box("wall","stone",side*(w/4+.25),.12,d/2,w/2-.5,.24,.12);
  // Bed and linen along the right wall; writing desk and stool in the back left.
  box("furniture","timber",w*.31,.18,-d*.16,w*.28,.36,d*.64);
  box("furniture","ivory",w*.31,.4,-d*.16,w*.29,.12,d*.61);
  box("furniture","teal",w*.31,.48,-d*.01,w*.3,.05,d*.30);
  box("furniture","ivory",w*.31,.51,-d*.39,w*.23,.12,d*.12);
  box("furniture","timber",-w*.26,.66,-d*.34,w*.33,.1,d*.22);
  for(const side of [-1,1]) box("furniture","timber",-w*.26+side*w*.13,.32,-d*.34,.07,.64,.09);
  box("furniture","ivory",-w*.26,.72,-d*.34,w*.2,.025,d*.14);
  box("furniture","timber",-w*.26,.25,-d*.08,.32,.5,.3);
  box("furniture","stone",-w*.34,.13,d*.32,.28,.26,.28);
  box("furniture","leaf",-w*.34,.35,d*.32,.22,.25,.22);
  return parts;
}
/** Deterministic 32-bit FNV-1a hash of a resident id. */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const HOME_SPOT_SLOTS = 16;
/**
 * A resident's standing spot inside the interior: one of 16 fixed slots on two rings around the
 * centre, chosen by a hash of the id. Stable across renders, within the clear middle of the floor
 * (clear of the furniture and the doorway), so family members at home do not overlap.
 */
export function homeResidentSpot(home: HomeInteriorLayout, residentId: string): Point {
  const slot = idHash(residentId) % HOME_SPOT_SLOTS;
  const ring = slot % 2 === 0 ? 0.09 : 0.16;
  const angle = (Math.floor(slot / 2) / (HOME_SPOT_SLOTS / 2)) * Math.PI * 2;
  const x = Math.cos(angle) * home.width * ring, z = Math.sin(angle) * home.depth * ring;
  const { center, yaw } = home;
  return [center[0] + Math.cos(yaw) * x + Math.sin(yaw) * z, center[1], center[2] - Math.sin(yaw) * x + Math.cos(yaw) * z];
}
