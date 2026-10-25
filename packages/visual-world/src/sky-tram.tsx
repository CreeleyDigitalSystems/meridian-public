import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, CylinderGeometry, InstancedMesh, MeshStandardMaterial, Object3D, SphereGeometry } from "three";
import { FRONTIER_INNER_EDGE } from "./frontier-visuals.js";
import { tramPosition, type TramLine } from "./sky-tram-network.js";
import { TRAM_Y } from "./sky-tram-sites.js";
import { WHITE_GOLD_FINISHES } from "./city-theme.js";
import type { CityLight } from "./city-layout.js";

/**
 * SUPERSEDED by the Transport Ruling (22 Oct 2026): the scene no longer draws this eight-line radial draft and no
 * resident is routed by it; Meridian Central's canonical circuit (meridian-central.tsx) replaces it. Kept, unused,
 * only so its existing tests stand until the parent decides to delete it.
 *
 * The sky tram (14 Oct 2026): how residents cross the water to the frontier. Network and routes live in
 * sky-tram-network.ts; this draws the stations, pylons and rail, the scheduled cars, and a car around anyone aboard.
 * Visual only: no engine state, no timetable in the world.
 */

const PYLON_SPACING = 6.5;
const WATER_Y = -0.4, GROUND_TOP = 0.56;
/** A rider is aboard once their feet rise past the station deck; their car is drawn around them until they step off. */
const ABOARD_Y = TRAM_Y - .6;
type Foot = [number, number, number];
const dummy = new Object3D();
const material = (finish: keyof typeof WHITE_GOLD_FINISHES, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}) => {
  const f = WHITE_GOLD_FINISHES[finish];
  return new MeshStandardMaterial({ color: f.color, metalness: f.metalness, roughness: f.roughness, ...extra });
};

interface Placement { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }
function useInstances(ref: React.RefObject<InstancedMesh | null>, placements: readonly Placement[]) {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    placements.forEach((p, i) => { dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, p.ry, 0); dummy.scale.set(p.sx, p.sy, p.sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    mesh.count = placements.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, placements]);
}

export function SkyTram({ lines, light, reducedMotion, positionsRef }: { lines: readonly TramLine[]; light: CityLight; reducedMotion: boolean; positionsRef?: React.RefObject<Map<string, Foot>> }) {
  const geometry = useMemo(() => ({
    pylon: new CylinderGeometry(.12, .2, 1, 8).translate(0, .5, 0), box: new BoxGeometry(1, 1, 1),
    tower: new CylinderGeometry(.55, .8, 1, 16).translate(0, .5, 0), deck: new CylinderGeometry(1.6, 1.6, 1, 24),
    canopy: new SphereGeometry(1.75, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2.6),
  }), []);
  const materials = useMemo(() => ({ white: material("ivory"), gold: material("gold"), glass: material("glass"), lamp: material("light", { emissive: WHITE_GOLD_FINISHES.light.emissive ?? "#ffd38a" }) }), []);
  useLayoutEffect(() => () => { for (const g of Object.values(geometry)) g.dispose(); for (const m of Object.values(materials)) m.dispose(); }, [geometry, materials]);
  const night = light === "blue-hour";
  useLayoutEffect(() => { materials.lamp.emissiveIntensity = night ? 1.4 : .25; materials.glass.emissive.set(night ? "#ffd9a0" : "#000000"); materials.glass.emissiveIntensity = night ? .6 : 0; }, [night, materials]);

  const parts = useMemo(() => {
    const pylons: Placement[] = [], yokes: Placement[] = [], rails: Placement[] = [], towers: Placement[] = [], decks: Placement[] = [], canopies: Placement[] = [], lamps: Placement[] = [];
    for (const line of lines) {
      const ry = Math.PI - line.bearing; // local +z along the line, outward
      const first = line.stations[0]!, last = line.stations.at(-1)!;
      const length = last.radius - first.radius;
      const mid = (first.radius + last.radius) / 2;
      const along = (r: number) => [Math.sin(line.bearing) * r, -Math.cos(line.bearing) * r] as const;
      const [mx, mz] = along(mid);
      // The rail: a white beam on a gold soffit, the full length of the line.
      rails.push({ x: mx, y: TRAM_Y - .12, z: mz, sx: .42, sy: .22, sz: length, ry });
      rails.push({ x: mx, y: TRAM_Y - .3, z: mz, sx: .3, sy: .14, sz: length, ry });
      for (const s of line.stations) {
        towers.push({ x: s.x, y: s.base, z: s.z, sx: 1, sy: TRAM_Y - .45 - s.base, sz: 1, ry: 0 });
        decks.push({ x: s.x, y: TRAM_Y - .55, z: s.z, sx: 1, sy: .22, sz: 1, ry: 0 });
        canopies.push({ x: s.x, y: TRAM_Y + 2.2, z: s.z, sx: 1, sy: .55, sz: 1, ry: 0 });
        lamps.push({ x: s.x, y: TRAM_Y + 1.85, z: s.z, sx: .22, sy: .22, sz: .22, ry: 0 });
        for (const side of [-1, 1]) {
          // Two slender gold posts carry the canopy either side of the rail.
          const px = s.x + Math.cos(line.bearing) * side * 1.2, pz = s.z + Math.sin(line.bearing) * side * 1.2;
          yokes.push({ x: px, y: TRAM_Y + 1, z: pz, sx: .08, sy: 3.1, sz: .08, ry: 0 }); // deck to canopy rim
        }
      }
      // Pylons between stations: slender white columns with a gold yoke under the rail.
      for (let i = 1; i < line.stations.length; i++) {
        const a = line.stations[i - 1]!.radius, b = line.stations[i]!.radius;
        const spans = Math.max(1, Math.round((b - a) / PYLON_SPACING));
        for (let k = 1; k < spans; k++) {
          const r = a + (b - a) * k / spans, [x, z] = along(r);
          const base = r < 41.5 ? GROUND_TOP : r < FRONTIER_INNER_EDGE ? WATER_Y : GROUND_TOP;
          pylons.push({ x, y: base, z, sx: 1, sy: TRAM_Y - .4 - base, sz: 1, ry: 0 });
          yokes.push({ x, y: TRAM_Y - .42, z, sx: 1.1, sy: .14, sz: .3, ry });
        }
      }
    }
    return { pylons, yokes, rails, towers, decks, canopies, lamps };
  }, [lines]);

  const refs = { pylons: useRef<InstancedMesh>(null), yokes: useRef<InstancedMesh>(null), rails: useRef<InstancedMesh>(null), towers: useRef<InstancedMesh>(null), decks: useRef<InstancedMesh>(null), canopies: useRef<InstancedMesh>(null), lamps: useRef<InstancedMesh>(null) };
  useInstances(refs.pylons, parts.pylons); useInstances(refs.yokes, parts.yokes); useInstances(refs.rails, parts.rails);
  useInstances(refs.towers, parts.towers); useInstances(refs.decks, parts.decks); useInstances(refs.canopies, parts.canopies); useInstances(refs.lamps, parts.lamps);

  // Cars: a white cabin on a gold belt with a glazed band, tram-sized beside a resident (1.1): about 10 m long.
  // Short lines run one car; lines with four or more stations run two, half a timetable apart.
  const cars = useMemo(() => lines.flatMap((line, i) => [{ line, offset: i * 7.3 }, ...(line.stations.length >= 4 ? [{ line, offset: i * 7.3 + 23 }] : [])]), [lines]);
  const body = useRef<InstancedMesh>(null), belt = useRef<InstancedMesh>(null), glazing = useRef<InstancedMesh>(null);
  const elapsed = useRef(0);
  useFrame((_, dt) => {
    if (!reducedMotion) elapsed.current += Math.min(dt, .1);
    // Residents aboard: one car around each rider (riders within a car's length on one line share it).
    const riders: { bearing: number; radius: number }[] = [];
    for (const foot of positionsRef?.current.values() ?? []) {
      if (foot[1] < ABOARD_Y) continue;
      const bearing = Math.round(Math.atan2(foot[0], -foot[2]) / (Math.PI / 4)) * (Math.PI / 4), radius = Math.hypot(foot[0], foot[2]);
      if (!riders.some((r) => Math.abs(r.bearing - bearing) < 1e-6 && Math.abs(r.radius - radius) < 6.5)) riders.push({ bearing, radius });
    }
    const placed: { bearing: number; radius: number }[] = [...riders];
    // The scheduled service runs on lines with nobody aboard, so a rider's car never meets another on the rail.
    cars.forEach(({ line, offset }, i) => {
      if (riders.some((r) => Math.abs(((r.bearing - line.bearing) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) < 1e-6)) return;
      placed.push({ bearing: line.bearing, radius: reducedMotion ? line.stations[Math.min(i % 2 ? line.stations.length - 1 : 0, line.stations.length - 1)]!.radius : tramPosition(line.stations, elapsed.current + offset) });
    });
    placed.slice(0, 16).forEach(({ bearing, radius }, i) => {
      const x = Math.sin(bearing) * radius, z = -Math.cos(bearing) * radius, ry = Math.PI - bearing;
      for (const [mesh, y, sx, sy, sz] of [[body, TRAM_Y + .95, 1.5, 1.5, 6.2], [belt, TRAM_Y + .26, 1.56, .22, 6.26], [glazing, TRAM_Y + 1.25, 1.54, .55, 5.4]] as const) {
        if (!mesh.current) continue;
        dummy.position.set(x, y, z); dummy.rotation.set(0, ry, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
        mesh.current.setMatrixAt(i, dummy.matrix);
      }
    });
    for (const mesh of [body, belt, glazing]) if (mesh.current) { mesh.current.count = Math.min(16, placed.length); mesh.current.instanceMatrix.needsUpdate = true; }
  });

  if (!lines.length) return null;
  const capacity = (n: number) => Math.max(1, n);
  return <group name="sky-tram">
    <instancedMesh ref={refs.pylons} args={[geometry.pylon, materials.white, capacity(parts.pylons.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.yokes} args={[geometry.box, materials.gold, capacity(parts.yokes.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.rails} args={[geometry.box, materials.white, capacity(parts.rails.length)]} castShadow frustumCulled={false} />
    <instancedMesh ref={refs.towers} args={[geometry.tower, materials.white, capacity(parts.towers.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.decks} args={[geometry.deck, materials.white, capacity(parts.decks.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.canopies} args={[geometry.canopy, materials.gold, capacity(parts.canopies.length)]} castShadow frustumCulled={false} />
    <instancedMesh ref={refs.lamps} args={[geometry.box, materials.lamp, capacity(parts.lamps.length)]} frustumCulled={false} />
    <instancedMesh ref={body} args={[geometry.box, materials.white, 16]} castShadow frustumCulled={false} />
    <instancedMesh ref={belt} args={[geometry.box, materials.gold, 16]} frustumCulled={false} />
    <instancedMesh ref={glazing} args={[geometry.box, materials.glass, 16]} frustumCulled={false} />
  </group>;
}
