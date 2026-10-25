import { useEffect, useMemo } from "react";
import { ExtrudeGeometry, Shape as ThreeShape } from "three";
import type { CityLight } from "./city-layout.js";
import type { FrontierWorksiteVisual } from "./projection-visuals.js";

/**
 * The frontier (D-8) in 3D: ground beyond the city's water, under fog until residents chart it.
 * Visual only — positions are a projection of each parcel's ring and slot, never engine state.
 */

/** One parcel as the scene draws it, projected from `life.frontier` by the web app. */
export interface FrontierParcelVisual {
  id: string; ring: number; slot: number;
  state: "fog" | "charted" | "building" | "built";
  /** For a build under way or a founded place: what it is. */
  buildKind?: "gathering-hall" | "garden-terrace" | "lookout" | "market-stalls" | "workshop" | "home" | undefined;
  /** For a build under way: share of the work done, 0..1. */
  progress?: number | undefined;
}

/**
 * Ring 1's land begins past the harbour pavilions (which stand on the water ~53 out), leaving a channel
 * of open water between the city and the frontier (D-5). Each ring is a band FRONTIER_RING_STEP wide.
 */
export const FRONTIER_INNER_EDGE = 58;
export const FRONTIER_RING_STEP = 10;
/** Top of frontier ground: level with the city's building plinths, so its architecture stands on it. */
const GROUND_TOP = 0.56;
const WATER_Y = -0.4;

/** The band of a ring and the angular span of a slot, in scene terms (bearing clockwise from north, -z). */
export function frontierSector(ring: number, slot: number): { inner: number; outer: number; from: number; to: number } {
  const span = (Math.PI * 2) / (8 * ring);
  return { inner: FRONTIER_INNER_EDGE + (ring - 1) * FRONTIER_RING_STEP, outer: FRONTIER_INNER_EDGE + ring * FRONTIER_RING_STEP, from: slot * span, to: (slot + 1) * span };
}

/** Parcel centre: north (slot angle 0) is away from the arrival view, clockwise like the compass labels. */
export function frontierParcelPosition(ring: number, slot: number): [number, number] {
  const { inner, outer, from, to } = frontierSector(ring, slot);
  const angle = (from + to) / 2, radius = (inner + outer) / 2;
  return [Math.sin(angle) * radius, -Math.cos(angle) * radius];
}

/** Where a resident stands at a founded frontier place: spread around its parcel by id, deterministically. */
export function frontierResidentPosition(placeId: string, residentId: string): [number, number, number] | undefined {
  const match = /^(?:frontier|landing)-(\d+)-(\d+)$/.exec(placeId);
  if (!match) return undefined;
  const [x, z] = frontierParcelPosition(Number(match[1]), Number(match[2]));
  let hash = 0;
  for (const c of residentId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const angle = (hash % 360) * (Math.PI / 180);
  // Just outside the largest frontier building's footprint (radius 2.6), never inside it.
  const distance = 3.3 + (hash % 7) * 0.15;
  return [x + Math.sin(angle) * distance, GROUND_TOP, z + Math.cos(angle) * distance];
}

/** Quay worksites stand on the waterside paving: clear of the quay cypresses (radius 39.5) and inside the island's edge (41.5). */
export const QUAY_WORKSITE_RADIUS = 40.9;

/**
 * Where a resident stands for a frontier shift, from its public worksite: on the outer quay facing the sector's fog
 * across the channel, or on charted ground toward the fog it faces (on the parcel itself when building). Spread a
 * little by id so a crew stands apart. Presentation only: the engine alone decides who may be there.
 */
export function frontierWorksitePosition(site: FrontierWorksiteVisual, residentId: string): [number, number, number] {
  let hash = 0;
  for (const c of residentId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  if (site.kind === "quay") {
    // The sector's centre bearing, give or take 6°: between two quay stations (at the compass bearings).
    const bearing = ((site.sector + 0.5) * Math.PI) / 4 + ((hash % 9) - 4) * (Math.PI / 120);
    return [Math.sin(bearing) * QUAY_WORKSITE_RADIUS, GROUND_TOP, -Math.cos(bearing) * QUAY_WORKSITE_RADIUS];
  }
  const [x, z] = frontierParcelPosition(site.ring, site.slot);
  const angle = (hash % 360) * (Math.PI / 180);
  if (!site.facing) {
    const distance = 3.3 + (hash % 7) * 0.15;
    return [x + Math.sin(angle) * distance, GROUND_TOP, z + Math.cos(angle) * distance];
  }
  // A third of the way toward the fog parcel's centre: on this side of the shared edge, never inside the fog.
  const [fx, fz] = frontierParcelPosition(site.facing.ring, site.facing.slot);
  return [x + (fx - x) / 3 + Math.sin(angle) * 0.6, GROUND_TOP, z + (fz - z) / 3 + Math.cos(angle) * 0.6];
}

/**
 * A parcel's band segment as an extruded annular sector, lying flat. Shape space is rotated -90° about
 * X into the scene, so shape (x, y) lands at scene (x, -y): a bearing θ (clockwise from -z) is the shape
 * angle π/2 - θ. Neighbouring segments share edges exactly, so charted ground joins into one coast.
 */
function sectorGeometry(ring: number, slot: number, depth: number): ExtrudeGeometry {
  const { inner, outer, from, to } = frontierSector(ring, slot);
  const shape = new ThreeShape();
  const a0 = Math.PI / 2 - to, a1 = Math.PI / 2 - from;
  shape.absarc(0, 0, outer, a0, a1, false);
  shape.absarc(0, 0, inner, a1, a0, true);
  shape.closePath();
  const segments = Math.max(6, Math.ceil(48 / ring));
  return new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segments });
}

/** Fog: stacked flat veils (no side walls to catch the eye), densest near the water and thinning upward. */
const FOG_LAYERS = [0.25, 0.7, 1.2, 1.8, 2.5, 3.3, 4.2].map((y, i) => ({ y, depth: 0.001, opacity: 0.2 - i * 0.022 }));

function Sector({ parcel, fog, colour }: { parcel: FrontierParcelVisual; fog: boolean; colour: string }) {
  const ground = useMemo(() => fog ? undefined : sectorGeometry(parcel.ring, parcel.slot, GROUND_TOP - WATER_Y), [parcel.ring, parcel.slot, fog]);
  const layers = useMemo(() => fog ? FOG_LAYERS.map((layer) => sectorGeometry(parcel.ring, parcel.slot, layer.depth)) : [], [parcel.ring, parcel.slot, fog]);
  useEffect(() => () => { ground?.dispose(); for (const layer of layers) layer.dispose(); }, [ground, layers]);
  if (ground) return <mesh geometry={ground} rotation={[-Math.PI / 2, 0, 0]} position={[0, WATER_Y, 0]} receiveShadow><meshStandardMaterial color={colour} roughness={0.92} /></mesh>;
  return <group>
    {layers.map((geometry, i) => <mesh key={i} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, FOG_LAYERS[i]!.y, 0]}>
      <meshStandardMaterial color={colour} transparent opacity={FOG_LAYERS[i]!.opacity} roughness={1} depthWrite={false} />
    </mesh>)}
  </group>;
}

/**
 * Ground beyond the water: charted segments are pale stone joined into one growing coast; uncharted
 * segments stand under a soft wall of fog. Buildings, scaffolding and cranes are drawn by the city's
 * own architecture (city-architecture.tsx), so the frontier grows in Meridian's style.
 */
export function CityFrontier({ parcels, light = "day" }: { parcels: readonly FrontierParcelVisual[]; light?: CityLight }) {
  const fogColour = light === "blue-hour" ? "#9fb2c8" : "#f4f2ee";
  return <group name="frontier">
    {parcels.map((parcel) => parcel.state === "fog"
      ? <Sector key={parcel.id} parcel={parcel} fog colour={fogColour} />
      : <Sector key={parcel.id} parcel={parcel} fog={false} colour={(parcel.ring + parcel.slot) % 3 === 0 ? "#ddd6bf" : (parcel.ring + parcel.slot) % 3 === 1 ? "#e4dcc6" : "#d6d3b8"} />)}
  </group>;
}

/** Structural view of `life.frontier` parcels, so the scene does not depend on the engine. */
interface FrontierParcelState {
  id: string; ring: number; slot: number; state: "fog" | "charted"; placeId?: string | undefined;
  builtKind?: FrontierParcelVisual["buildKind"]; build?: { kind: NonNullable<FrontierParcelVisual["buildKind"]>; effort: number } | undefined;
}
/**
 * How each catalogue place is drawn in the city's own architecture (city-architecture.tsx): size, storeys and
 * district language. Shared here so home views and camera volumes read the same footprint the scene draws.
 */
export const FRONTIER_ARCHITECTURE: Readonly<Record<NonNullable<FrontierParcelVisual["buildKind"]>, { radius: number; height: number; variant: number; district: "upper" | "neighbourhood" }>> = {
  "gathering-hall": { radius: 2.6, height: 2.9, variant: 2, district: "neighbourhood" },
  "market-stalls": { radius: 1.9, height: 1.45, variant: 1, district: "neighbourhood" },
  "garden-terrace": { radius: 2.6, height: 0.4, variant: 0, district: "neighbourhood" },
  lookout: { radius: 1.1, height: 8, variant: 2, district: "upper" },
  workshop: { radius: 2, height: 1.45, variant: 3, district: "neighbourhood" },
  home: { radius: 1.6, height: 2.9, variant: 0, district: "neighbourhood" },
};

/** Catalogue effort per kind, mirroring FRONTIER_BUILDS in packages/world-kernel/src/frontier.ts (a test keeps them equal). */
export const FRONTIER_BUILD_EFFORT: Readonly<Record<NonNullable<FrontierParcelVisual["buildKind"]>, number>> = {
  "gathering-hall": 12, "garden-terrace": 8, lookout: 10, "market-stalls": 8, workshop: 10, home: 8,
};

/** Projects saved frontier parcels into what the scene draws, in a stable order. */
export function projectFrontier(frontier: Readonly<Record<string, FrontierParcelState>> | undefined): FrontierParcelVisual[] {
  if (!frontier) return [];
  return Object.values(frontier).sort((a, b) => a.ring - b.ring || a.slot - b.slot).map((p) => {
    const base = { id: p.id, ring: p.ring, slot: p.slot };
    if (p.state === "fog") return { ...base, state: "fog" as const };
    if (p.placeId && p.builtKind) return { ...base, state: "built" as const, buildKind: p.builtKind };
    if (p.build) return { ...base, state: "building" as const, buildKind: p.build.kind, progress: Math.min(1, p.build.effort / FRONTIER_BUILD_EFFORT[p.build.kind]) };
    return { ...base, state: "charted" as const };
  });
}
