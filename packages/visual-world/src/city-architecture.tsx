import { homeInteriorLayout, homeInteriorParts, type HomeInteriorLayout } from "./home-interior.js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { VENTURE_SITE_ANCHORS, type VentureSiteVisual } from "./venture-sites.js";
import { civicPieceCount } from "./civic-improvements.js";
import { CITY_GROUND_Y as CIVIC_GROUND_Y } from "./city-walkability.js";
import { monumentClockTicks } from "./monument-clock-ticks.js";
import { useFrame, useThree } from "@react-three/fiber";
import { BoxGeometry, ConeGeometry, CylinderGeometry, InstancedMesh, Object3D, SphereGeometry, TorusGeometry, type BufferGeometry } from "three";
import { acquireSurfaceTextures, releaseSurfaceTextures, type SurfaceTextureSet } from "./surface-textures.js";
import { acquireArchitectureSurfaces, releaseArchitectureSurfaces, type ArchitectureSurfaces } from "./architecture-surfaces.js";
import type { CityBuilding, CityLight } from "./city-layout.js";
import { isPlanLayout } from "./city-plan.js";
import { FINISHES, SHADOW_FINISHES, ACCENT_PART_LIMIT, WHITE_GOLD_FINISHES, WHITE_GOLD_METALS, type Finish } from "./city-theme.js";
import { constructionStageProfile, type ConstructionStage } from "./projection-visuals.js";
import { FRONTIER_ARCHITECTURE, frontierParcelPosition, type FrontierParcelVisual } from "./frontier-visuals.js";

/**
 * Batched city architecture. Every part is an instance of one of a few shared
 * geometries; one instanced mesh per (shape, finish) pair.
 *
 * Two architectural languages share one real 3D city:
 *  - Upper Meridian (rear skyline, building.district === "upper"): white-and-gold
 *    civic towers with teal/lapis glass, stained glass, banners and roof gardens.
 *  - Working neighbourhoods (central and foreground rings): low-rise houses,
 *    workshops and market halls in plaster, ochre, stone and timber under
 *    terracotta roofs, with awnings, open workshop fronts and planted courtyards.
 *
 * Navigation contract: everything that touches the ground stays inside the
 * conservative forbidden footprints already used by city-walkability.ts
 * (building circles, the garden basin, the spire podium, tree clearances, the
 * market stalls and the island edge). Elevated parts keep a clear headroom.
 */
export type Shape = "box" | "drum" | "dome" | "orb" | "ring" | "halftrack" | "arch" | "crystal" | "pyramid" | "gable";
export interface Part { homePlaceId?: string; homeRole?: "floor" | "wall" | "furniture"; ventureId?: string; retainDetail?: boolean; position: [number, number, number]; scale: [number, number, number]; rotation: [number, number, number] }
export interface Batch { shape: Shape; finish: Finish; emissive?: boolean; parts: Part[] }

export function architectureGeometry(shape: Shape, efficient = false): BufferGeometry {
  switch (shape) {
    case "box": return new BoxGeometry(1, 1, 1);
    case "drum": return new CylinderGeometry(1, 1, 1, efficient ? 10 : 14);
    case "dome": return new SphereGeometry(1, efficient ? 12 : 16, efficient ? 5 : 7, 0, Math.PI * 2, 0, Math.PI / 2);
    case "orb": return new SphereGeometry(1, efficient ? 6 : 8, efficient ? 4 : 5);
    case "ring": return new TorusGeometry(1, 0.004, 3, efficient ? 16 : 22);
    case "halftrack": return new TorusGeometry(1, 0.034, 3, efficient ? 32 : 48, Math.PI);
    case "arch": return new TorusGeometry(1, 0.07, 3, efficient ? 8 : 12, Math.PI);
    case "crystal": return new ConeGeometry(1, 1, 5);
    case "pyramid": return new ConeGeometry(1, 1, 4);
    // Triangular prism: with rotation [-π/2, yaw, π/2] (YXZ) its ridge runs along
    // local X, apex up; height = 1.5 × scale.z, base depth = 1.732 × scale.x,
    // ridge length = scale.y (the cylinder's original axis).
    case "gable": return new CylinderGeometry(1, 1, 1, 3);
  }
}

/** Ground level of the public realm; residents' feet stand at this height. */
const GROUND = 0.56;
const STOREY = 1.45;

export function makeArchitecture(buildings: readonly CityBuilding[], stage: ConstructionStage, light: CityLight = "day", ventureSites: readonly VentureSiteVisual[] = [], inspectedHome?: string | HomeInteriorLayout | null, civicProgress: Readonly<Record<string, number>> = {}, frontier: readonly FrontierParcelVisual[] = []): Batch[] {
  const batches = new Map<string, Batch>();
  let landmark = false;
  let retainDetail = false;
  let ventureId: string | undefined;
  let emissiveCount = 0;
  const add = (shape: Shape, finish: Finish, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) => {
    const emissive = light === "blue-hour" && landmark && Boolean(FINISHES[finish].emissive) && emissiveCount < ACCENT_PART_LIMIT;
    if (emissive) emissiveCount++;
    const key = `${shape}-${finish}-${emissive}`;
    if (!batches.has(key)) batches.set(key, { shape, finish, emissive, parts: [] });
    batches.get(key)!.parts.push({ ...(ventureId ? { ventureId } : {}), ...(retainDetail ? { retainDetail: true } : {}), position: [x, y, z], scale: [sx, sy, sz], rotation: [rx, ry, rz] });
  };
  const ring = (finish: Finish, x: number, y: number, z: number, r: number) => add("ring", finish, x, y, z, r, r, r, Math.PI / 2);
  const gable = (finish: Finish, x: number, y: number, z: number, ridge: number, rise: number, depth: number, yaw: number) => {
    add("gable", finish, x, y + rise / 3, z, depth / 1.732, ridge, rise / 1.5, -Math.PI / 2, yaw, Math.PI / 2);
    if (finish === "terracotta") for (const side of [-1, 1])
      add("box", "timber", x + Math.sin(yaw) * side * depth / 2, y - .045, z + Math.cos(yaw) * side * depth / 2, ridge, .12, .1, 0, yaw);
  };
  const terrace = (x: number, y: number, z: number, radius: number, planted = false) => {
    add("drum", "ivory", x, y, z, radius, 0.3, radius);
    ring("gold", x, y + 0.2, z, radius);
    ring("gold", x, y - 0.13, z, radius);
    if (planted) {
      add("drum", "garden", x, y + 0.19, z, radius * 0.78, 0.1, radius * 0.78);
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + radius;
        add("orb", i % 2 ? "blossom" : "leaf", x + Math.sin(a) * radius * 0.5, y + 0.4, z + Math.cos(a) * radius * 0.5, 0.26, 0.2, 0.26);
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      add("box", "gold", x + Math.sin(a) * radius, y + 0.43, z + Math.cos(a) * radius, 0.04, 0.7, 0.04);
    }
    ring("gold", x, y + 0.77, z, radius);
  };
  const tree = (x: number, y: number, z: number, s = 1, flowering = false) => {
    add("drum", "timber", x, y + 0.8 * s, z, 0.075 * s, 1.6 * s, 0.075 * s);
    // One connected shadow crown, three overlapping lobes and a visible fork.
    // Position varies the silhouette deterministically, never from activity.
    const phase = Math.sin(x * .73 + z * .41) * Math.PI;
    add("orb", "garden", x, y + 1.62 * s, z, .5 * s, .5 * s, .5 * s);
    for (const side of [-1, 1])
      add("box", "timber", x + Math.cos(phase) * side * .14 * s, y + 1.35 * s, z - Math.sin(phase) * side * .14 * s, .07 * s, .65 * s, .07 * s, 0, phase, -side * .48);
    for (let j = 0; j < 3; j++) {
      const a = phase + j * 2.4;
      const finish: Finish = flowering && j === 2 ? "blossom" : "leaf";
      add("orb", finish, x + Math.sin(a) * .27 * s, y + (1.7 + j * .12) * s, z + Math.cos(a) * .27 * s, (.48 - j * .05) * s, (.43 - j * .045) * s, .4 * s);
    }
  };
  const bridge = (x: number, z: number, length: number, y: number, angle: number, deck: Finish = "ivory", rail: Finish = "gold") => {
    add("box", deck, x, y, z, length, 0.28, 1.5, 0, angle);
    for (const side of [-1, 1]) {
      const dx = Math.sin(angle) * side * 0.74;
      const dz = Math.cos(angle) * side * 0.74;
      add("box", rail, x + dx, y + 0.72, z + dz, length, 0.045, 0.05, 0, angle);
      add("box", rail, x + dx, y - 0.16, z + dz, length, 0.09, 0.07, 0, angle);
      for (let j = -length / 2; j <= length / 2; j += 0.85) {
        add("box", rail, x + Math.cos(angle) * j + dx, y + 0.37, z - Math.sin(angle) * j + dz, 0.04, 0.72, 0.04);
      }
    }
    add("arch", deck, x, y - length * 0.22, z, length * 0.49, length * 0.23, 1.2, 0, angle);
  };
  /** Alternating slats read as a striped awning without any texture. */
  const awning = (finish: Finish, x: number, y: number, z: number, width: number, depth: number, yaw: number, pitch = 0.42) => {
    const slats = Math.max(3, Math.round(width / 0.36));
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    for (let i = 0; i < slats; i++) {
      const offset = (i - (slats - 1) / 2) * (width / slats);
      add("box", i % 2 ? "awningCream" : finish, x + lx * offset, y, z + lz * offset, width / slats + 0.01, 0.03, depth, pitch, yaw);
    }
  };

  // ---------------------------------------------------------------- island
  // The planned city (city-plan.ts) brings its own paving, kerbs, quay planters and buildings (CityKit);
  // the island keeps its base, rim and balustrade, and the civic landmarks below stand on its paving.
  const planned = isPlanLayout(buildings);
  add("drum", "dark", 0, -1.1, 0, 43, 3, 43);
  add("drum", "paving", 0, 0.22, 0, 42.8, 0.64, 42.8);
  ring("gold", 0, 0.61, 0, 42.75);
  ring("stone", 0, -0.1, 0, 43);
  if (!planned) for (const r of [8.2, 10, 18.8, 20, 29.1, 30.8, 40.5]) ring("stone", 0, 0.56, 0, r);
  for (let i = 0; i < 96; i++) {
    const a = i / 96 * Math.PI * 2;
    add("box", "stone", Math.sin(a) * 42.7, 0.98, Math.cos(a) * 42.7, 0.09, 0.9, 0.09);
    if (i % 2 === 0 && !planned) {
      tree(Math.sin(a) * 39.5, 0.55, Math.cos(a) * 39.5, 0.85, i % 6 === 0);
      add("box", "stone", Math.sin(a) * 32, 0.555, Math.cos(a) * 32, 0.045, 0.012, 18, 0, a);
    }
  }
  ring("timber", 0, 1.43, 0, 42.7);

  // ------------------------------------------- the Prismatic Gardens (0, 5)
  // Planted courtyard garden with a glasshouse; the basin footprint (radius 7)
  // is unchanged and remains non-walkable. Extra planting from GardenRenewal
  // sits on the soil ring at radius 4.7–5.8.
  landmark = true;
  const gz = 5;
  add("drum", "stone", 0, 0.73, gz, 6.9, 0.36, 6.9);
  add("drum", "water", 0, 0.93, gz, 6.7, 0.08, 6.7);
  add("drum", "garden", 0, 1.0, gz, 6.05, 0.4, 6.05);
  for (const a of [0, Math.PI / 2]) add("box", "paving", 0, 1.21, gz, 12, 0.03, 0.9, 0, a);
  add("drum", "ivory", 0, 1.26, gz, 2.3, 0.12, 2.3);
  ring("gold", 0, 1.33, gz, 2.3);
  add("dome", "teal", 0, 1.32, gz, 2.05, 2.9, 2.05);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    add("box", "gold", Math.sin(a) * 2.0, 2.4, gz + Math.cos(a) * 2.0, 0.05, 2.2, 0.05, Math.cos(a) * 0.22, a, -Math.sin(a) * 0.22);
    if (i % 2 === 0) add("box", (["violet", "rose", "cyan"] as const)[(i / 2) % 3]!, Math.sin(a) * 2.12, 1.85, gz + Math.cos(a) * 2.12, 0.55, 0.9, 0.05, 0, a);
  }
  add("drum", "gold", 0, 4.45, gz, 0.05, 0.9, 0.05);
  add("orb", "light", 0, 4.95, gz, 0.14, 0.14, 0.14);
  for (let i = 0; i < 8; i++) {
    const a = (i + .5) * Math.PI / 4, r = 4.35 + (i % 2) * .15;
    const px = Math.sin(a) * r, pz = gz + Math.cos(a) * r;
    add("orb", "garden", px, 1.36, pz, .58, .25, .48);
    add("orb", "leaf", px + Math.cos(a) * .3, 1.43, pz - Math.sin(a) * .3, .38, .27, .38);
    add("orb", i % 2 ? "blossom" : "coral", px - Math.cos(a) * .23, 1.58, pz + Math.sin(a) * .23, .23, .14, .22);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    tree(Math.sin(a) * 8.6, 0.55, gz + Math.cos(a) * 8.6, 0.6, i % 2 === 0);
    // Benches hug each garden tree, inside its clearance circle.
    const bx = Math.sin(a) * 9.25, bz = gz + Math.cos(a) * 9.25;
    add("box", "timber", bx, .98, bz, 1.2, .12, .4, 0, a);
    for (const side of [-1, 1]) add("box", "iron", bx + Math.cos(a) * side * .45, .74, bz - Math.sin(a) * side * .45, .05, .45, .3, 0, a);
  }

  landmark = false;
  // ---------------------------------------------------- market stalls (±6, 20)
  for (const [k, mx] of [-6, 6].entries()) {
    const mz = 20, finish: Finish = k ? "awningTeal" : "awningCoral";
    add("box", "stone", mx, .66, mz, 3.7, .22, 2.4);
    add("box", "timber", mx, 1.05, mz + .2, 3.2, .6, .8);
    for (const dx of [-1.65, 1.65]) for (const dz of [-.95, .95]) add("box", "timber", mx + dx, 1.8, mz + dz, .09, 2.4, .09);
    gable(finish, mx, 2.98, mz, 4.0, .6, 2.6, 0);
    add("box", "timber", mx, 3.62, mz, 4.1, .07, .1);
    for (let j = 0; j < 6; j++) add("orb", (["coral", "ochre", "leaf", "rose", "blossom", "cyan"] as const)[j]!, mx - 1.25 + j * .5, 1.5, mz + .2, .17, .15, .17);
    add("orb", "light", mx - 1.4, 2.7, mz - .8, .1, .12, .1);
    add("orb", "light", mx + 1.4, 2.7, mz - .8, .1, .12, .1);
  }

  // ------------------------------------------------------------- buildings
  const profile = constructionStageProfile(stage);
  // The opened home (one at a time) is drawn as its furnished interior in place of its own shell.
  const home = typeof inspectedHome === "string" || !inspectedHome ? homeInteriorLayout(buildings, inspectedHome, frontier) : inspectedHome;
  const interior = (open: HomeInteriorLayout) => {
    for (const part of homeInteriorParts(open)) {
      const key = `box-${part.finish}-false`;
      if (!batches.has(key)) batches.set(key, { shape: "box", finish: part.finish, emissive: false, parts: [] });
      batches.get(key)!.parts.push({ position: part.position, scale: part.scale, rotation: part.rotation, retainDetail: true, homePlaceId: open.homePlaceId, homeRole: part.role });
    }
  };
  buildings.forEach((b, index) => {
    if (home?.kind === "planned" && home.buildingIndex === index) { interior(home); return; }
    if (planned) return; // drawn by CityKit
    if (b.district === "upper") upperTower(b, index);
    else neighbourhoodBuilding(b, index, b.canonicalIndex === 11 ? profile.heightScale : 1);
  });

  // ------------------------------------------------------- the frontier (D-8)
  // Places residents founded beyond the water use the city's own architecture; a build under way
  // rises with the work actually done, under scaffolding and a white-and-gold crane (D-14).
  frontier.forEach((parcel, i) => {
    // New ground reads as land: a few cypresses and shrubs on charted parcels nobody has built on yet.
    if (parcel.state === "charted") {
      const [cx, cz] = frontierParcelPosition(parcel.ring, parcel.slot);
      // One small grove per parcel: two or three cypress spires and a rounded shrub, close together.
      const a = (parcel.ring * 1.7 + parcel.slot * 2.39) % (Math.PI * 2), d = 1.4 + ((parcel.ring * 7 + parcel.slot * 3) % 5) * 0.4;
      const gx = cx + Math.sin(a) * d, gz = cz + Math.cos(a) * d;
      const spires = 2 + ((parcel.ring + parcel.slot) % 2);
      for (let t = 0; t < spires; t++) {
        const h = 2.2 + ((parcel.slot + t * 3) % 4) * 0.35;
        add("orb", "garden", gx + (t - (spires - 1) / 2) * 0.62, GROUND + h / 2, gz + (t % 2) * 0.4, 0.3, h / 2, 0.3);
      }
      add("orb", "leaf", gx + 0.9, GROUND + 0.4, gz - 0.5, 0.55, 0.42, 0.5);
      return;
    }
    if ((parcel.state !== "built" && parcel.state !== "building") || !parcel.buildKind) return;
    if (home?.kind === "frontier" && home.parcelId === parcel.id) { interior(home); return; }
    const [x, z] = frontierParcelPosition(parcel.ring, parcel.slot);
    const look = FRONTIER_ARCHITECTURE[parcel.buildKind];
    const b: CityBuilding = { x, z, radius: look.radius, height: look.height, tiers: 2, variant: look.variant, district: look.district };
    const done = parcel.state === "built" ? 1 : Math.max(0.12, Math.min(1, parcel.progress ?? 0));
    const index = 1000 + i;
    if (parcel.buildKind === "garden-terrace") {
      add("drum", "garden", x, GROUND + 0.18, z, 2.6 * done, 0.36, 2.6 * done);
      for (let t = 0; t < Math.round(5 * done); t++) add("orb", "leaf", x + Math.sin(t * 1.26) * 1.6, GROUND + 1.1, z + Math.cos(t * 1.26) * 1.6, 0.7, 0.9, 0.7);
    } else if (look.district === "upper" && done >= 1) upperTower(b, index);
    else neighbourhoodBuilding(b, index, done);
    if (parcel.state !== "building") return;
    // Scaffolding: a light ivory frame with gold rails at each level, climbing with the build.
    const top = GROUND + 0.6 + done * look.height;
    const reach = look.radius + 0.35;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]] as const) add("box", "ivory", x + dx * reach, (GROUND + top) / 2, z + dz * reach, 0.07, top - GROUND, 0.07);
    for (let level = GROUND + 0.8; level <= top + 0.01; level += 0.8) {
      for (const [dx, dz, sx, sz] of [[0, -1, 2, 0], [0, 1, 2, 0], [-1, 0, 0, 2], [1, 0, 0, 2]] as const) add("box", "gold", x + dx * reach, level, z + dz * reach, sx * reach + 0.06, 0.05, sz * reach + 0.06);
    }
    // A tower crane beside the site: ivory mast, gold jib reaching over the work, counterweight behind.
    const yaw = Math.atan2(-x, -z);
    const mx = x + Math.cos(yaw) * (look.radius + 1.6), mz = z - Math.sin(yaw) * (look.radius + 1.6);
    const mastHeight = look.height + 4;
    add("box", "ivory", mx, GROUND + mastHeight / 2, mz, 0.28, mastHeight, 0.28);
    add("box", "gold", mx - Math.cos(yaw) * 2.2, GROUND + mastHeight, mz + Math.sin(yaw) * 2.2, 5.6, 0.2, 0.2, 0, yaw);
    add("box", "iron", mx + Math.cos(yaw) * 1.4, GROUND + mastHeight - 0.15, mz - Math.sin(yaw) * 1.4, 0.7, 0.5, 0.5, 0, yaw);
    add("box", "iron", mx - Math.cos(yaw) * 3.6, GROUND + mastHeight - 1.6, mz + Math.sin(yaw) * 3.6, 0.03, 3, 0.03);
  });

  function upperTower(b: CityBuilding, index: number) {
    const { x, z, radius: r } = b;
    const h = Math.max(3, b.height);
    const core: Finish = b.variant === 2 ? "lapis" : b.variant === 3 ? "teal" : "glass";
    add("drum", "ivory", x, 0.95, z, r * 1.28, 0.8, r * 1.28);
    add("drum", core, x, 0.8 + h / 2, z, r * 0.88, h, r * 0.88);
    // Layered civic socle and shallow arcades remain within the existing tower plinth.
    for (const [y, radius] of [[1.31, 1.24], [1.48, 1.16]] as const) {
      add("drum", "ivory", x, y, z, r * radius, .14, r * radius);
      ring("gold", x, y + .08, z, r * radius);
    }
    for (let bay = 0; bay < 6; bay++) {
      const a = bay * Math.PI / 3;
      add("arch", "ivory", x + Math.sin(a) * r * 1.06, 2.55, z + Math.cos(a) * r * 1.06, r * .42, 1.1, .32, 0, a);
      add("arch", "gold", x + Math.sin(a) * r * 1.1, 2.55, z + Math.cos(a) * r * 1.1, r * .4, 1.06, .18, 0, a);
    }
    // Six slender coloured facets sit in a plaza-facing glazed bay, lit by the same daylight.
    const front = Math.atan2(-x, -z);
    for (let pane = 0; pane < 6; pane++) {
      const a = front + ((pane % 3) - 1) * .26;
      add("crystal", (["cyan", "violet", "rose"] as const)[pane % 3]!,
        x + Math.sin(a) * r * 1.075, .8 + h * (pane < 3 ? .46 : .7), z + Math.cos(a) * r * 1.075,
        r * .18, h * .22, .08, 0, a, pane % 2 ? .12 : -.12);
    }
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      add("box", "ivory", x + Math.sin(a) * r * 0.93, 0.8 + h / 2, z + Math.cos(a) * r * 0.93, r * 0.29, h, r * 0.18, 0, a);
      add("box", "gold", x + Math.sin(a) * r * 1.025, 0.8 + h / 2, z + Math.cos(a) * r * 1.025, 0.035, h, 0.035, 0, a);
    }
    for (let floor = 1; floor < h; floor += 1.6) {
      add("drum", "ivory", x, 0.8 + floor, z, r * 1.07, 0.26, r * 1.07);
      ring("gold", x, 0.9 + floor, z, r * 1.025);
      if (index % 3 === 0) ring("light", x, 0.72 + floor, z, r * 0.9);
    }
    terrace(x, h + 0.85, z, r * 1.21, b.variant === 1 || index % 4 === 2);
    if (b.variant !== 1) {
      add("dome", b.variant === 2 ? "teal" : "ivory", x, h + 1, z, r, r * 0.85, r);
      ring("gold", x, h + 1.02, z, r);
      add("drum", "gold", x, h + r + 1.2, z, 0.055, 1.3, 0.055);
      add("orb", "light", x, h + r + 1.85, z, 0.12, 0.12, 0.12);
    } else {
      tree(x, h + 1, z, 0.85, true);
    }
    if (index % 3 === 0) {
      terrace(x, h * 0.48 + 0.8, z, r * 1.5, true);
      tree(x + r * 1.05, h * 0.48 + 1.05, z, 0.6);
      tree(x - r * 1.05, h * 0.48 + 1.05, z, 0.6);
    }
    // Civic banners in restrained colour hang from the upper terrace.
    const facing = Math.atan2(-x, -z);
    for (const side of [-1, 1]) {
      const a = facing + side * 0.5;
      add("box", (["coral", "teal", "lapis", "violet"] as const)[(index + (side > 0 ? 1 : 0)) % 4]!, x + Math.sin(a) * r * 1.12, h - 0.9, z + Math.cos(a) * r * 1.12, 0.32, 2.2, 0.04, 0, a);
    }
    // Stained glass inlays on the plaza-facing façade.
    if (b.variant === 2 || b.variant === 0) {
      add("crystal", b.variant === 2 ? "violet" : "rose", x + Math.sin(facing) * r * 1.04, h * .55, z + Math.cos(facing) * r * 1.04, r * .28, h * .5, .12, 0, facing, .05);
      add("crystal", "cyan", x + Math.sin(facing + .35) * r * 1.03, h * .5, z + Math.cos(facing + .35) * r * 1.03, r * .16, h * .4, .12, 0, facing, -.05);
    }
  }

  function neighbourhoodBuilding(b: CityBuilding, index: number, heightScale: number) {
    const { x, z, radius: r } = b;
    const yaw = Math.atan2(-x, -z);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);   // forward: toward the city centre
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);  // lateral
    const at = (dl: number, df: number): [number, number] => [x + lx * dl + fx * df, z + lz * dl + fz * df];
    const box = (finish: Finish, dl: number, y: number, df: number, sx: number, sy: number, sz: number, rx = 0, rz = 0) => {
      const [px, pz] = at(dl, df);
      add("box", finish, px, y, pz, sx, sy, sz, rx, yaw, rz);
    };
    const floors = Math.max(1, Math.min(3, Math.round(b.height / STOREY)));
    const wallHeight = Math.max(0.5, floors * STOREY * heightScale);
    const complete = heightScale >= 1;
    const roofed = heightScale >= 0.9;
    const walls: Finish = (["plaster", "ochre", "stone", "plaster"] as const)[(index + b.variant) % 4]!;
    // A single civic detail in the foothill band; building and navigation identities stay unchanged.
    if (complete && Math.hypot(x, z) > 20 && Math.hypot(x, z) < 30 && z >= -6 && z < 4)
      box("ivory", 0, GROUND + .36 + wallHeight, 0, r * 1.6, .18, r * 1.25);
    const awningFinish: Finish = index % 2 ? "awningCoral" : "awningTeal";
    const windowRow = (df: number, count: number, width: number, y: number) => {
      for (let w = 0; w < count; w++) {
        const dl = (w - (count - 1) / 2) * (width / (count + 0.4));
        box("dark", dl, y, df, 0.42, 0.62, 0.06);
        if (complete) for (const s of [-1, 1]) box("shutter", dl + s * 0.3, y, df + 0.035, 0.16, 0.66, 0.08);
      }
    };
    const orbAt = (finish: Finish, dl: number, df: number, y: number, sx: number, sy: number, sz: number) => {
      const [px, pz] = at(dl, df);
      add("orb", finish, px, y, pz, sx, sy, sz);
    };
    const plantedCorner = (dl: number, df: number) => {
      box("stone", dl, GROUND + 0.16, df, 0.5, 0.32, 0.5);
      const [px, pz] = at(dl, df);
      add("orb", "leaf", px, GROUND + 0.5, pz, 0.24, 0.22, 0.24);
      add("orb", "blossom", px + 0.1, GROUND + 0.6, pz - 0.05, 0.14, 0.12, 0.14);
    };

    if (b.variant === 3) {
      // Market hall: long low building with a timber arcade and striped awnings (footprint 2r).
      const w = r * 2.6, d = r * 1.3;
      box("stone", 0, GROUND + 0.18, 0, w + 0.3, 0.36, d + 0.3);
      box(walls, 0, GROUND + 0.36 + wallHeight / 2, 0, w, wallHeight, d);
      if (roofed) {
        const [rxp, rzp] = at(0, 0);
        gable("terracotta", rxp, GROUND + 0.36 + wallHeight, rzp, w + 0.4, d * 0.42, d + 0.5, yaw);
        box("timber", 0, GROUND + 0.36 + wallHeight + d * 0.42 + 0.03, 0, w + 0.5, 0.08, 0.1);
      }
      if (complete) {
        windowRow(d / 2 + 0.02, 3, w * 0.8, GROUND + 0.36 + wallHeight - 0.5);
        for (const s of [-1, 1]) box("dark", s * w * 0.3, GROUND + 0.36 + 0.7, d / 2 + 0.02, 0.6, 1.3, 0.08);
        for (let p = -2; p <= 2; p++) box("timber", p * w * 0.24, GROUND + 1.25, d / 2 + r * 0.55, 0.11, 2.5, 0.11);
        const [ax, az] = at(0, d / 2 + r * 0.32);
        awning(awningFinish, ax, GROUND + 2.55, az, w * 1.02, r * 0.75, yaw, 0.35);
        box("timber", 0, GROUND + 0.95, d / 2 + r * 0.5, w * 0.7, 0.08, 0.5);
        for (let g = 0; g < 5; g++) {
          const [px, pz] = at((g - 2) * w * 0.14, d / 2 + r * 0.5);
          add("orb", (["coral", "ochre", "leaf", "cyan", "rose"] as const)[g]!, px, GROUND + 1.1, pz, 0.14, 0.13, 0.14);
        }
        orbAt("light", -w * 0.35, d / 2 + r * 0.55, GROUND + 2.35, 0.09, 0.1, 0.09);
      }
      return;
    }

    const w = r * (b.variant === 0 ? 1.7 : 1.55), d = r * (b.variant === 0 ? 1.35 : 1.25);
    // Stone plinth and walls.
    box("stone", 0, GROUND + 0.16, 0, w + 0.24, 0.32, d + 0.24);
    if (b.variant === 1) {
      // Workshop: open ground-floor front under a timber lintel, workbench visible from the street.
      const upper = Math.max(0, wallHeight - STOREY);
      box(walls, 0, GROUND + 0.32 + STOREY / 2, -d * 0.3, w, Math.min(STOREY, wallHeight), d * 0.4);
      for (const s of [-1, 1]) box(walls, s * (w / 2 - 0.22), GROUND + 0.32 + STOREY / 2, d * 0.2, 0.44, Math.min(STOREY, wallHeight), d * 0.6);
      box("dark", 0, GROUND + 0.32 + STOREY / 2 - 0.05, -d * 0.02, w - 0.9, STOREY - 0.15, d * 0.15);
      box("timber", 0, GROUND + 0.32 + STOREY - 0.08, d / 2 - 0.05, w, 0.16, 0.16);
      box("timber", 0, GROUND + 0.32 + 0.42, d * 0.22, w * 0.5, 0.08, 0.5);
      if (upper > 0) {
        box(walls, 0, GROUND + 0.32 + STOREY + upper / 2, 0, w, upper, d);
        if (complete) windowRow(d / 2 + 0.02, 2, w * 0.8, GROUND + 0.32 + STOREY + upper * 0.55);
      }
      if (complete) {
        // Floor and jambs reveal the existing bay depth without adding activity.
        box("stone", 0, GROUND + .3, d * .12, w - .88, .08, d * .68);
        for (const s of [-1, 1]) box("timber", s * (w / 2 - .44), GROUND + .32 + STOREY / 2, d / 2 - .08, .12, STOREY, .2);
        const [ax, az] = at(0, d / 2 + 0.34);
        awning(awningFinish, ax, GROUND + 0.32 + STOREY + 0.1, az, w * 0.95, 0.85, yaw);
        orbAt("coral", -w * 0.18, d * 0.22, GROUND + 0.32 + 0.56, 0.1, 0.1, 0.1);
        orbAt("cyan", w * 0.12, d * 0.22, GROUND + 0.32 + 0.55, 0.09, 0.09, 0.09);
      }
      if (roofed) {
        // Planted roof terrace with a pergola instead of a pitched roof.
        box("stone", 0, GROUND + 0.32 + wallHeight + 0.08, 0, w + 0.1, 0.16, d + 0.1);
        box("garden", 0, GROUND + 0.32 + wallHeight + 0.2, -d * 0.18, w * 0.8, 0.1, d * 0.5);
        for (let p = 0; p < 4; p++) box("timber", (p % 2 ? 1 : -1) * w * 0.4, GROUND + 0.32 + wallHeight + 0.95, (p < 2 ? 1 : -1) * d * 0.4, 0.08, 1.5, 0.08);
        for (let s = -1; s <= 1; s++) box("timber", s * w * 0.4, GROUND + 0.32 + wallHeight + 1.72, 0, 0.06, 0.06, d * 0.9);
        if (complete) {
          const [tx, tz] = at(w * 0.28, -d * 0.2);
          tree(tx, GROUND + 0.32 + wallHeight + 0.2, tz, 0.5, true);
          for (const s of [-1, 1]) orbAt("leaf", -w * 0.28, d * 0.22 * s, GROUND + 0.32 + wallHeight + 0.42, 0.22, 0.18, 0.22);
        }
      }
      return;
    }

    box(walls, 0, GROUND + 0.32 + wallHeight / 2, 0, w, wallHeight, d);
    // Upper side-wall openings break the blank mass at oblique street views.
    // Their relief stays above pedestrian headroom and uses existing batches.
    if (complete && floors > 1) {
      const y = GROUND + .32 + wallHeight - STOREY * .5;
      for (const s of [-1, 1]) {
        box("dark", s * (w / 2 + .025), y, 0, .06, .72, .6);
        box("stone", s * (w / 2 + .06), y - .4, 0, .2, .1, .78);
        box("timber", s * (w / 2 + .065), y + .4, 0, .16, .12, .78);
        box("timber", s * (w / 2 + .065), y, 0, .1, .72, .05);
      }
    }
    // Timber frame: corner posts and a beam at each floor line.
    if (b.variant === 0 || !complete) {
      for (const s of [-1, 1]) for (const f of [-1, 1]) box("timber", s * (w / 2), GROUND + 0.32 + wallHeight / 2, f * (d / 2), 0.12, wallHeight, 0.12);
      for (let f = 1; f <= floors && f * STOREY * heightScale <= wallHeight + 0.01; f++) box("timber", 0, GROUND + 0.32 + f * STOREY * heightScale, d / 2, w + 0.1, 0.1, 0.1);
    }
    // Door and windows face the street.
    box("timber", -w * 0.22, GROUND + 0.32 + 0.48, d / 2 + 0.02, 0.44, 0.92, 0.07);
    if (complete) {
      const doorX = -w * .22, face = d / 2;
      box("dark", doorX, GROUND + .32 + .5, face + .055, .62, 1.08, .045);
      box("ochre", doorX, GROUND + .32 + .48, face + .085, .42, .94, .04);
      for (const s of [-1, 1]) box("timber", doorX + s * .31, GROUND + .32 + .5, face + .1, .1, 1.12, .18);
      box("timber", doorX, GROUND + .32 + 1.06, face + .1, .72, .1, .18);
      box("stone", doorX, GROUND + .3, face + .06, .72, .08, .24);
    }
    for (let f = 0; f < floors && (f + 1) * STOREY * heightScale <= wallHeight + 0.01; f++) {
      const y = GROUND + 0.32 + f * STOREY + STOREY * 0.62;
      if (f === 0) windowRow(d / 2 + 0.02, 1, w * 0.9, y);
      else windowRow(d / 2 + 0.02, 2, w * 0.8, y);
    }
    // Art pass 2 (12 Oct 2026): a white arcaded loggia across the street front of every finished house of
    // two storeys or more — columns, arches and a balustraded balcony above — bridging the warm working
    // neighbourhood (D-15) and the pearl city of the reference image. All within the building's footprint.
    // Two houses in three carry one, which keeps the full tier inside its triangle budget and varies the street.
    if (complete && floors > 1 && index % 3 !== 2) {
      const front = d / 2 + 0.5, columnTop = GROUND + 0.32 + STOREY * 0.78, bays = 3, bay = (w + 0.1) / bays;
      for (let c = 0; c <= bays; c++) {
        const dl = -(w + 0.1) / 2 + c * bay;
        const [cx, cz] = at(dl, front);
        // Square pillars (boxes, no capitals): keeps the arcade inside the city's triangle budget.
        add("box", "stucco", cx, (GROUND + 0.32 + columnTop) / 2, cz, 0.16, columnTop - GROUND - 0.32, 0.16, 0, yaw);
      }
      for (let c = 0; c < bays; c++) {
        const [ax, az] = at(-(w + 0.1) / 2 + (c + 0.5) * bay, front);
        add("arch", "stucco", ax, columnTop, az, bay / 2, bay * 0.42, 1.4, 0, yaw);
      }
      const deck = columnTop + bay * 0.42 + 0.1;
      box("stucco", 0, deck, front - 0.22, w + 0.3, 0.12, 0.66);
      // A solid white parapet with a capping rail: reads as a balustrade at city distance, at a fraction of the cost.
      box("stucco", 0, deck + 0.24, front + 0.08, w + 0.2, 0.36, 0.05);
      box("stucco", 0, deck + 0.44, front + 0.08, w + 0.26, 0.05, 0.1);
      // Café terrace on every third street front: round tables, chairs and a cream awning.
      if (index % 3 === 0) {
        const [ax, az] = at(0, front + 0.5);
        awning("awningCream", ax, deck - 0.12, az, w + 0.2, 0.9, yaw, 0.3);
        for (const t of [-1, 1]) {
          const [tx, tz] = at(t * w * 0.26, front + 0.62);
          add("box", "timber", tx, GROUND + 0.62, tz, 0.06, 0.6, 0.06, 0, yaw);
          add("box", "stucco", tx, GROUND + 0.93, tz, 0.5, 0.04, 0.5, 0, yaw);
          for (const side of [-1, 1]) {
            const [sx, sz] = at(t * w * 0.26 + side * 0.36, front + 0.62);
            add("box", "timber", sx, GROUND + 0.55, sz, 0.22, 0.42, 0.22, 0, yaw);
          }
        }
      }
    }
    if (roofed) {
      const [rxp, rzp] = at(0, 0);
      if (b.variant === 2) {
        // Hipped stone house: pyramid roof.
        const rise = d * 0.55;
        add("pyramid", "terracotta", rxp, GROUND + 0.32 + wallHeight + rise / 2, rzp, Math.hypot(w, d) / 2 + 0.25, rise, Math.hypot(w, d) / 2 + 0.25, 0, yaw + Math.PI / 4);
        add("box", "timber", rxp, GROUND + 0.32 + wallHeight + 0.05, rzp, w + 0.3, 0.1, d + 0.3, 0, yaw);
      } else {
        const rise = d * 0.5;
        gable("terracotta", rxp, GROUND + 0.32 + wallHeight, rzp, w + 0.35, rise, d + 0.45, yaw);
        box("timber", 0, GROUND + 0.32 + wallHeight + rise + 0.03, 0, w + 0.45, 0.08, 0.1);
        // Chimney.
        box("stone", w * 0.3, GROUND + 0.32 + wallHeight + rise * 0.7, -d * 0.15, 0.22, rise * 0.9, 0.22);
      }
    }
    if (complete) {
      if (b.variant === 0) {
        const [ax, az] = at(w * 0.2, d / 2 + 0.3);
        awning(awningFinish, ax, GROUND + 0.32 + STOREY * 0.98, az, w * 0.5, 0.7, yaw);
        // Flower boxes under the upper windows.
        if (floors > 1) for (const s of [-1, 1]) {
          box("timber", s * w * 0.23, GROUND + 0.32 + STOREY + STOREY * 0.36, d / 2 + 0.08, 0.36, 0.1, 0.14);
          orbAt(s > 0 ? "blossom" : "coral", s * w * 0.23, d / 2 + 0.1, GROUND + 0.32 + STOREY + STOREY * 0.36 + 0.1, 0.16, 0.08, 0.1);
        }
      } else {
        // Planted courtyard corners for the stone house (inside the 1.3r footprint).
        plantedCorner(w * 0.55, d * 0.42);
        plantedCorner(-w * 0.55, d * 0.42);
        box("timber", 0, GROUND + 0.32 + 0.3, d / 2 + 0.36, w * 0.5, 0.06, 0.06);
      }
      orbAt("light", w * 0.36, d / 2 + 0.06, GROUND + 0.32 + STOREY * 0.85, 0.07, 0.09, 0.07);
    } else {
      // Construction: scaffolding poles and a timber crane beside the site.
      for (const s of [-1, 1]) for (const f of [-1, 1]) box("timber", s * (w / 2 + 0.28), GROUND + 1.6, f * (d / 2 + 0.28), 0.07, 3.2, 0.07);
      for (const f of [-1, 1]) box("timber", 0, GROUND + 3.2, f * (d / 2 + 0.28), w + 0.6, 0.06, 0.06);
      box("gold", w * 0.55, GROUND + 3.2, d * 0.5, 0.16, 6.4, 0.16);
      box("gold", w * 0.55 + 1.6, GROUND + 6.3, d * 0.5, 3.4, 0.12, 0.12);
      box("gold", w * 0.55 + 2.8, GROUND + 5.4, d * 0.5, 0.04, 1.8, 0.04);
    }
  }

  // ------------------------------------------- Upper Meridian spire (0, -9)
  landmark = true;
  const hz = -9;
  for (let i = 0; i < 5; i++) {
    add("drum", "ivory", 0, 0.7 + i * 0.23, hz, 5.9 - i * 0.28, 0.24, 5.9 - i * 0.28);
    ring("gold", 0, 0.85 + i * 0.23, hz, 5.9 - i * 0.28);
  }
  add("drum", "teal", 0, 12, hz, 3.25, 21, 3.25);
  add("drum", "ivory", 0, 23.6, hz, 2.35, 4, 2.35);
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    add("drum", "ivory", Math.sin(a) * 3.35, 12, hz + Math.cos(a) * 3.35, 0.24, 21, 0.24);
    add("drum", "gold", Math.sin(a) * 3.61, 12, hz + Math.cos(a) * 3.61, 0.045, 21.4, 0.045);
    add("arch", "gold", Math.sin(a) * 3.32, 5.6, hz + Math.cos(a) * 3.32, 0.52, 1.4, 0.52, 0, a);
    if (i % 4 === 1) add("box", (["coral", "lapis", "teal", "violet"] as const)[(i >> 2) % 4]!, Math.sin(a) * 3.7, 9.5, hz + Math.cos(a) * 3.7, 0.5, 4, 0.05, 0, a);
    if (i % 2 === 0) add("box", (["violet", "cyan", "rose"] as const)[(i >> 1) % 3]!, Math.sin(a) * 3.38, 16.5, hz + Math.cos(a) * 3.38, 0.6, 2.4, 0.06, 0, a);
  }
  for (const [y, r, planted] of [[6, 4.8, true], [13, 4.1, false], [21.5, 4.5, true], [24.4, 3.1, false], [27, 2.4, false]] as const) terrace(0, y, hz, r, planted);
  add("dome", "ivory", 0, 25, hz, 2.6, 3.3, 2.6);
  add("crystal", "cyan", 0, 30, hz, 1.65, 7, 1.65);
  add("drum", "gold", 0, 34, hz, 0.06, 10, 0.06);

  retainDetail = true;
  // Civic dial: the same deterministic minute/hour marks as the existing sky clock.
  // The two moving hands are projected from canonicalMinute in CivicClockHands.
  add("drum", "ivory", 0, 17, -5.28, 2, .16, 2, Math.PI / 2);
  add("drum", "glass", 0, 17, -5.17, 1.77, .05, 1.77, Math.PI / 2);
  for (const rz of [0, Math.PI]) {
    add("arch", "gold", 0, 17, -5.12, 1.96, 1.96, .5, 0, 0, rz);
    add("arch", "ivory", 0, 17, -5.15, 2.12, 2.12, .7, 0, 0, rz);
  }
  for (const tick of monumentClockTicks()) {
    add("box", "gold", tick.position[0] * .22, 17 + tick.position[1] * .22, -5.1,
      tick.isMajor ? .065 : .025, tick.isMajor ? .22 : .1, .045, 0, 0, tick.rotation[2]);
  }

  retainDetail = false;
  // Upper gate on the podium threshold (pylons inside the podium's forbidden circle).
  for (const side of [-1, 1]) {
    add("box", "ivory", side * 3.7, 5, -4.7, .7, 9, .9);
    add("box", "gold", side * 3.7, 5, -4.22, .09, 9, .06);
    add("drum", "ivory", side * 3.7, .95, -4.7, .65, .65, .65);
  }
  add("arch", "ivory", 0, 8.8, -4.7, 3.7, 3.2, 2.4);
  add("arch", "gold", 0, 8.8, -4.5, 3.8, 3.3, .45);
  add("orb", "light", 0, 12.2, -4.6, .16, .16, .16);
  // High bridges from the gate to the ring towers; the planned city has no towers for them to land on.
  if (!planned) bridge(-7.5, -6, 11, 13, -.4);
  if (!planned) bridge(7.5, -6, 11, 13, .4);

  // Skyway: an elevated arc across Upper Meridian, hung from its towers rather
  // than standing on columns in the public realm. The planned city links its civic terraces with the kit's own skyway.
  if (!planned) add("halftrack", "ivory", 0, 6.3, 0, 22, 22, 10, -Math.PI / 2);
  if (!planned) add("halftrack", "cyan", 0, 6.15, 0, 22, 22, 10, -Math.PI / 2);
  for (const b of planned ? [] : buildings.filter((b) => b.district === "upper" && Math.hypot(b.x, b.z) < 30)) {
    const a = Math.atan2(b.x, b.z);
    const inward = b.radius * 1.3 - 0.35;
    const px = b.x - Math.sin(a) * inward, pz = b.z - Math.cos(a) * inward;
    add("drum", "ivory", px, 3.35, pz, 0.17, 5.6, 0.17);
    const reach = Math.hypot(px, pz) - 22;
    add("box", "gold", (px + Math.sin(a) * 22) / 2, 6.3, (pz + Math.cos(a) * 22) / 2, 0.12, 0.12, Math.max(0.4, reach), 0, a);
  }
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    if (Math.cos(a) < -0.3 && i % 2 === 0 && !planned) bridge(Math.sin(a) * 16.5, Math.cos(a) * 16.5, 9.5, 6.3, Math.PI / 2 - a);
  }

  // Harbour jetties: timber and stone footbridges over the water to two pavilions.
  // Decks begin beyond the island edge (radius 41.5) so nothing stands on the quay paving.
  for (const x of [-17, 17]) {
    bridge(x, 44.3, 12, 1.35, Math.PI / 2, "timber", "iron");
    add("drum", "stone", x, 1.1, 50.3, 3.1, 0.5, 3.1);
    add("dome", "teal", x, 2.6, 50.3, 1.8, 2.2, 1.8);
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; add("drum", "timber", x + Math.sin(a) * 1.8, 2, 50.3 + Math.cos(a) * 1.8, 0.06, 1.8, 0.06); }
    add("orb", "light", x, 3.7, 50.3, .12, .12, .12);
  }

  // Small status pads share existing material batches. Stocks represent reservations,
  // not inferred deliveries; finished ventures retain only their recorded-step inlay.
  landmark = false;
  retainDetail = true;
  const shownPlaces = new Set<string>();
  for (const site of ventureSites) {
    const anchor = VENTURE_SITE_ANCHORS[site.placeId];
    if (!anchor || shownPlaces.has(site.placeId)) continue;
    shownPlaces.add(site.placeId);
    ventureId = site.ventureId;
    const [x, y, z] = anchor;
    add("box", "stone", x, y, z, 1.2, .025, .55);
    const steps = Math.min(8, Math.max(0, Math.floor(site.totalSteps)));
    for (let i = 0; i < steps; i++)
      add("box", i < site.doneSteps ? "gold" : "stone", x + (i - (steps - 1) / 2) * .12, y + .025, z + .2, .075, .02, .1);
    if (site.status !== "completed") {
      for (let i = 0; i < Math.min(2, site.timber); i++) add("box", "timber", x - .2, y + .06 + i * .08, z - .06, .48, .075, .14);
      for (let i = 0; i < Math.min(2, site.stone); i++) add("box", "stone", x + .3, y + .08 + i * .14, z - .06, .16, .14, .16);
    }
  }

  // Civic improvements residents finished together: one piece per recorded step of committed progress.
  ventureId = undefined;
  retainDetail = true;
  landmark = false;
  const G = CIVIC_GROUND_Y;
  // Benches on the square's side edges, facing inward and clear of the market stalls at z=20.
  const benchSpots: readonly (readonly [number, number, number])[] = [[-12.6, 14, Math.PI / 2], [12.6, 14, -Math.PI / 2], [-12.6, 17.2, Math.PI / 2], [12.6, 17.2, -Math.PI / 2]];
  for (const [bx, bz, yaw] of benchSpots.slice(0, civicPieceCount("square-benches", civicProgress["square-benches"]))) {
    add("box", "stone", bx, G + .42, bz, 1.6, .1, .5, 0, yaw);
    for (const side of [-.62, .62]) add("box", "stone", bx + Math.cos(yaw) * side, G + .19, bz - Math.sin(yaw) * side, .14, .38, .42, 0, yaw);
    add("box", "timber", bx - Math.sin(yaw) * .22, G + .72, bz - Math.cos(yaw) * .22, 1.5, .3, .06, 0, yaw);
  }
  // Lantern posts along the promenade; the lamp glows at blue hour like other civic light.
  const lanternSpots: readonly (readonly [number, number])[] = [[-12, 39.4], [12, 39.4], [-6, 39.4], [6, 39.4], [0, 36.6]];
  for (const [lx, lz] of lanternSpots.slice(0, civicPieceCount("promenade-lanterns", civicProgress["promenade-lanterns"]))) {
    add("drum", "timber", lx, G + 1.1, lz, .06, 2.2, .06);
    add("box", "gold", lx, G + 2.24, lz, .34, .05, .34);
    landmark = true;
    add("orb", "light", lx, G + 2.02, lz, .15, .19, .15);
    landmark = false;
  }
  // Stone planters at the Terrace Market, between and beyond the two stalls.
  const planterSpots: readonly (readonly [number, number])[] = [[-2.6, 21.4], [2.6, 21.4], [-9.6, 21.4], [9.6, 21.4], [0, 25.8]];
  planterSpots.slice(0, civicPieceCount("market-planters", civicProgress["market-planters"])).forEach(([px, pz], i) => {
    add("box", "stone", px, G + .22, pz, .9, .44, .9);
    add("drum", "garden", px, G + .46, pz, .36, .06, .36);
    add("orb", i % 2 ? "blossom" : "leaf", px, G + .74, pz, .34, .3, .34);
  });
  // Public map boards at the square's front corners: two posts, a pale board, a gold rail and route marks.
  const boardSpots: readonly (readonly [number, number])[] = [[-9, 12.6], [9, 12.6]];
  for (const [mx, mz] of boardSpots.slice(0, civicPieceCount("public-map-boards", civicProgress["public-map-boards"]))) {
    for (const side of [-.55, .55]) add("box", "timber", mx + side, G + .8, mz, .08, 1.6, .08);
    add("box", "ivory", mx, G + 1.35, mz, 1.3, .9, .05);
    add("box", "gold", mx, G + 1.83, mz, 1.36, .05, .07);
    (["cyan", "leaf", "coral"] as const).forEach((finish, j) => add("orb", finish, mx - .35 + j * .35, G + 1.25 + (j % 2) * .18, mz - .04, .06, .06, .02));
  }
  return [...batches.values()];
}

/** Drop only small remote decoration. Mass, roofs, planted silhouettes and landmark light remain. */
export function architectureDetail(batches: readonly Batch[], camera: readonly [number, number, number]): Batch[] {
  return batches.map(batch => ({ ...batch, parts: batch.parts.filter(part => {
    if (part.retainDetail || batch.emissive || ["halftrack", "gable", "dome", "pyramid"].includes(batch.shape)
      || ["leaf", "garden", "blossom"].includes(batch.finish)) return true;
    const distance = Math.hypot(...part.position.map((v, i) => v - camera[i]!)) - Math.max(...part.scale);
    if (distance <= 30 || (batch.finish === "gold" && Math.max(...part.scale) >= 2)) return true;
    if (["gold", "shutter", "awningCoral", "awningTeal", "awningCream", "light"].includes(batch.finish)) return false;
    if (batch.shape === "ring") return distance <= 70;
    return Math.max(...part.scale) >= (distance > 70 ? 2 : .8);
  }) })).filter(batch => batch.parts.length > 0);
}

/** Uses the resident material library's shared maps, without generating or owning textures. */
export function architectureMaterial(batch: Batch, night: boolean, textures?: SurfaceTextureSet, surfaces?: ArchitectureSurfaces) {
  // White & gold: timber reads as satin gold, so only terracotta keeps the weathered clay surface.
  const kind = batch.finish === "terracotta" || (batch.finish === "timber" && !WHITE_GOLD_METALS.includes("timber")) ? "clay"
    : ["plaster", "ochre", "stone", "paving"].includes(batch.finish) ? "stone" : undefined;
  const pair = batch.finish === "paving" || batch.finish === "plaster" || batch.finish === "terracotta" ? surfaces?.[batch.finish] : undefined;
  // White & gold: the landmarks, market and frontier share the planned city's palette.
  return {
    ...WHITE_GOLD_FINISHES[batch.finish],
    map: pair?.map ?? (kind ? textures?.[kind].map : undefined),
    roughnessMap: pair?.roughnessMap ?? (kind ? textures?.[kind].roughnessMap : undefined),
    emissiveIntensity: batch.emissive && night ? 1.2 : 0,
    envMapIntensity: night ? .25 : WHITE_GOLD_METALS.includes(batch.finish) ? .9 : kind ? .12 : batch.finish === "ivory" ? .38 : .3,
  };
}

function ArchitectureBatch({ batch, night, textures, surfaces, efficient }: { efficient: boolean; batch: Batch; night: boolean; textures: SurfaceTextureSet | undefined; surfaces: ArchitectureSurfaces | undefined }) {
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => architectureGeometry(batch.shape, efficient), [batch.shape, efficient]);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const o = new Object3D();
    batch.parts.forEach((p, i) => {
      o.position.set(...p.position); o.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], "YXZ"); o.scale.set(...p.scale); o.updateMatrix(); ref.current!.setMatrixAt(i, o.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [batch]);
  const m = architectureMaterial(batch, night, textures, surfaces);
  return <instancedMesh ref={ref} args={[geo, undefined, batch.parts.length]} castShadow={SHADOW_FINISHES.includes(batch.finish)} receiveShadow>
    <meshStandardMaterial {...m} map={m.map ?? null} roughnessMap={m.roughnessMap ?? null} />
  </instancedMesh>;
}

export function CityArchitecture({ buildings, constructionStage, light, ventureSites, efficient = false, inspectedHome, civicProgress, frontier }: { civicProgress?: Readonly<Record<string, number>> | undefined; inspectedHome?: HomeInteriorLayout | undefined; efficient?: boolean; buildings: readonly CityBuilding[]; constructionStage: ConstructionStage; light: CityLight; ventureSites?: readonly VentureSiteVisual[] | undefined; frontier?: readonly FrontierParcelVisual[] | undefined }) {
  const { camera } = useThree();
  const [detailCamera, setDetailCamera] = useState<[number, number, number]>(() => [camera.position.x, camera.position.y, camera.position.z]);
  const detailTimer = useRef(0);
  useFrame((_, dt) => {
    detailTimer.current += dt;
    if (detailTimer.current < .5) return;
    detailTimer.current = 0;
    if (Math.hypot(camera.position.x - detailCamera[0], camera.position.y - detailCamera[1], camera.position.z - detailCamera[2]) >= 4)
      setDetailCamera([camera.position.x, camera.position.y, camera.position.z]);
  });
  const [textures, setTextures] = useState<SurfaceTextureSet>();
  const [surfaces, setSurfaces] = useState<ArchitectureSurfaces>();
  useLayoutEffect(() => {
    const lease = acquireSurfaceTextures();
    const architectural = acquireArchitectureSurfaces();
    setTextures(lease.textures);
    setSurfaces(architectural.textures);
    return () => { releaseSurfaceTextures(lease); releaseArchitectureSurfaces(architectural); };
  }, []);
  // Progress arrives as a fresh object with each projection; key the geometry on its values, not its identity.
  const civicKey = JSON.stringify(civicProgress ?? {});
  const frontierKey = JSON.stringify(frontier ?? []);
  const batches = useMemo(() => makeArchitecture(buildings, constructionStage, light, ventureSites, inspectedHome ?? null, JSON.parse(civicKey) as Record<string, number>, JSON.parse(frontierKey) as FrontierParcelVisual[]), [buildings, constructionStage, light, ventureSites, inspectedHome, civicKey, frontierKey]);
  const visible = useMemo(() => architectureDetail(batches, detailCamera), [batches, detailCamera]);
  return <group>{visible.map((batch) => <ArchitectureBatch key={`${batch.shape}-${batch.finish}-${batch.emissive}`} batch={batch} night={light === "blue-hour"} textures={textures} surfaces={surfaces} efficient={efficient} />)}</group>;
}
