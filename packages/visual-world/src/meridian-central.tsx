import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, CylinderGeometry, InstancedMesh, MeshStandardMaterial, Object3D, SphereGeometry } from "three";
import { WHITE_GOLD_FINISHES } from "./city-theme.js";
import type { CityLight } from "./city-layout.js";
import { CITY_GROUND_Y } from "./city-walkability.js";
import { MERIDIAN_CENTRAL, MERIDIAN_CENTRAL_PIER, MERIDIAN_CENTRAL_RECT, TRANSIT_RAIL_Y, circuitLayout, circuitPointAt, circuitPylons, vehicleDistance, type TransitCircuitVisual } from "./transit-circuit.js";

/**
 * Meridian Central and its circuit (Transport Ruling, 22 Oct 2026): the grand station on the water off the
 * promenade, the rail out over the water once, round the developed districts and back once, a station at each
 * stop, and the one vehicle where the canonical timetable puts it. Drawn only from the public transit fact; with
 * no commissioned transit nothing is drawn, so no transit is claimed that the world does not run.
 */

const WATER_Y = -0.4, GROUND_TOP = 0.56;
const CAR_LENGTH = 4.2, CAR_GAP = 0.4, CARS = 3;
const dummy = new Object3D();
const material = (finish: keyof typeof WHITE_GOLD_FINISHES, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}) => {
  const f = WHITE_GOLD_FINISHES[finish];
  return new MeshStandardMaterial({ color: f.color, metalness: f.metalness, roughness: f.roughness, ...extra });
};

interface Placement { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; rz?: number }
function useInstances(ref: React.RefObject<InstancedMesh | null>, placements: readonly Placement[]) {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    placements.forEach((p, i) => { dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, p.ry, p.rz ?? 0); dummy.scale.set(p.sx, p.sy, p.sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    mesh.count = placements.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, placements]);
}

/** The grand station: a plinth and pier, a glazed concourse, the platform deck, a gold-ribbed vault and two towers. */
function centralParts() {
  const [x0, x1, z0, z1] = MERIDIAN_CENTRAL_RECT, [px0, px1, pz0, pz1] = MERIDIAN_CENTRAL_PIER;
  const [cx, cz] = MERIDIAN_CENTRAL;
  const width = x1 - x0, depth = z1 - z0;
  const white: Placement[] = [
    { x: cx, y: (WATER_Y + GROUND_TOP) / 2, z: (z0 + z1) / 2, sx: width, sy: GROUND_TOP - WATER_Y, sz: depth, ry: 0 }, // plinth
    { x: (px0 + px1) / 2, y: CITY_GROUND_Y - 0.12, z: (pz0 + pz1) / 2, sx: px1 - px0, sy: 0.24, sz: pz1 - pz0, ry: 0 }, // pier
    { x: cx, y: TRANSIT_RAIL_Y - 0.62, z: cz, sx: width - 1, sy: 0.36, sz: depth - 3, ry: 0 }, // platform deck
  ];
  // Colonnades along both long sides, from the plinth to where the vault springs, clear of the tracks between.
  const spring = TRANSIT_RAIL_Y + 2, half = depth / 2 - 0.6;
  for (let i = 0; i <= 6; i += 1) for (const z of [cz - half, cz + half]) white.push({ x: x0 + 1 + (width - 2) * i / 6, y: (GROUND_TOP + spring) / 2, z, sx: 0.5, sy: spring - GROUND_TOP, sz: 0.5, ry: 0 });
  // Two towers flanking the entrance from the promenade.
  const towers: Placement[] = [-1, 1].map((side) => ({ x: cx + side * (width / 2 - 1.4), y: GROUND_TOP + 8, z: z0 + 1.4, sx: 1.2, sy: 16, sz: 1.2, ry: 0 }));
  const glass: Placement[] = [{ x: cx, y: GROUND_TOP + 3.2, z: z0 + 1.6, sx: width - 3, sy: 5.6, sz: 0.12, ry: 0 }];
  // The vault: a half-cylinder of glass along the tracks (east-west), ribbed in gold.
  const vault: Placement[] = [{ x: cx, y: spring, z: cz, sx: half, sy: width, sz: half, ry: 0, rz: Math.PI / 2 }];
  const ribs: Placement[] = [];
  for (let i = 0; i <= 8; i += 1) ribs.push({ x: x0 + 0.5 + (width - 1) * i / 8, y: spring, z: cz, sx: half + 0.15, sy: 0.18, sz: half + 0.15, ry: 0, rz: Math.PI / 2 });
  const lamps: Placement[] = [...[-1, 1].map((side) => ({ x: cx + side * (width / 2 - 1.4), y: GROUND_TOP + 16.5, z: z0 + 1.4, sx: 0.5, sy: 0.5, sz: 0.5, ry: 0 })),
    { x: cx, y: spring + half + 0.2, z: cz, sx: 0.6, sy: 0.6, sz: 0.6, ry: 0 }];
  return { white, towers, glass, vault, ribs, lamps };
}

/** Where the lead car is drawn this frame, so riders saved aboard are carried inside it. */
export interface TransitVehicleFrame { x: number; z: number; heading: number }

export function MeridianCentral({ circuit, light, reducedMotion, vehicleRef }: { circuit: TransitCircuitVisual; light: CityLight; reducedMotion: boolean; vehicleRef?: React.RefObject<TransitVehicleFrame | null> | undefined }) {
  const geometry = useMemo(() => ({
    box: new BoxGeometry(1, 1, 1), pylon: new CylinderGeometry(.12, .2, 1, 8).translate(0, .5, 0),
    tower: new CylinderGeometry(.55, .8, 1, 16).translate(0, .5, 0), deck: new CylinderGeometry(1.6, 1.6, 1, 24),
    canopy: new SphereGeometry(1.75, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2.6),
    // Half-cylinders (θ 0..π, the half that ends up above the axis once turned to run east-west).
    vault: new CylinderGeometry(1, 1, 1, 32, 1, true, 0, Math.PI), spire: new CylinderGeometry(.35, .6, 1, 12),
    ring: new CylinderGeometry(1, 1, 1, 32, 1, true, 0, Math.PI),
  }), []);
  const materials = useMemo(() => ({ white: material("ivory"), gold: material("gold"), glass: material("glass", { transparent: true, opacity: 0.55 }), lamp: material("light", { emissive: WHITE_GOLD_FINISHES.light.emissive ?? "#ffd38a" }) }), []);
  useLayoutEffect(() => () => { for (const g of Object.values(geometry)) g.dispose(); for (const m of Object.values(materials)) m.dispose(); }, [geometry, materials]);
  const night = light === "blue-hour";
  useLayoutEffect(() => { materials.lamp.emissiveIntensity = night ? 1.4 : .25; materials.glass.emissive.set(night ? "#ffd9a0" : "#000000"); materials.glass.emissiveIntensity = night ? .5 : 0; }, [night, materials]);

  const layout = useMemo(() => circuit.route ? circuitLayout(circuit.route) : undefined, [circuit.route]);
  const central = useMemo(centralParts, []);
  const parts = useMemo(() => {
    const rails: Placement[] = [], soffits: Placement[] = [], pylons: Placement[] = [], yokes: Placement[] = [];
    const towers: Placement[] = [], decks: Placement[] = [], canopies: Placement[] = [], lamps: Placement[] = [];
    if (!layout || !circuit.route) return { rails, soffits, pylons, yokes, towers, decks, canopies, lamps };
    for (let i = 1; i < layout.points.length; i += 1) {
      const a = layout.points[i - 1]!, b = layout.points[i]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-6) continue;
      const ry = Math.atan2(b[0] - a[0], b[1] - a[1]), x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2;
      rails.push({ x, y: TRANSIT_RAIL_Y - .12, z, sx: .42, sy: .22, sz: length + .05, ry });
      soffits.push({ x, y: TRANSIT_RAIL_Y - .3, z, sx: .3, sy: .14, sz: length + .05, ry });
    }
    for (const p of circuitPylons(layout, circuit.route)) {
      const base = p.water ? WATER_Y : GROUND_TOP;
      pylons.push({ x: p.x, y: base, z: p.z, sx: 1, sy: TRANSIT_RAIL_Y - .4 - base, sz: 1, ry: 0 });
      yokes.push({ x: p.x, y: TRANSIT_RAIL_Y - .42, z: p.z, sx: .3, sy: .14, sz: 1.1, ry: p.heading + Math.PI / 2 });
    }
    for (const s of layout.stations) {
      const p = circuitPointAt(layout, s);
      towers.push({ x: p.x, y: GROUND_TOP, z: p.z, sx: 1, sy: TRANSIT_RAIL_Y - .45 - GROUND_TOP, sz: 1, ry: 0 });
      decks.push({ x: p.x, y: TRANSIT_RAIL_Y - .55, z: p.z, sx: 1, sy: .22, sz: 1, ry: 0 });
      canopies.push({ x: p.x, y: TRANSIT_RAIL_Y + 2.2, z: p.z, sx: 1, sy: .55, sz: 1, ry: 0 });
      lamps.push({ x: p.x, y: TRANSIT_RAIL_Y + 1.85, z: p.z, sx: .22, sy: .22, sz: .22, ry: 0 });
    }
    return { rails, soffits, pylons, yokes, towers, decks, canopies, lamps };
  }, [layout, circuit.route]);

  const refs = {
    rails: useRef<InstancedMesh>(null), soffits: useRef<InstancedMesh>(null), pylons: useRef<InstancedMesh>(null), yokes: useRef<InstancedMesh>(null),
    towers: useRef<InstancedMesh>(null), decks: useRef<InstancedMesh>(null), canopies: useRef<InstancedMesh>(null), lamps: useRef<InstancedMesh>(null),
    centralWhite: useRef<InstancedMesh>(null), centralTowers: useRef<InstancedMesh>(null), centralGlass: useRef<InstancedMesh>(null),
    vault: useRef<InstancedMesh>(null), ribs: useRef<InstancedMesh>(null), centralLamps: useRef<InstancedMesh>(null),
  };
  useInstances(refs.rails, parts.rails); useInstances(refs.soffits, parts.soffits); useInstances(refs.pylons, parts.pylons); useInstances(refs.yokes, parts.yokes);
  useInstances(refs.towers, parts.towers); useInstances(refs.decks, parts.decks); useInstances(refs.canopies, parts.canopies); useInstances(refs.lamps, parts.lamps);
  useInstances(refs.centralWhite, central.white); useInstances(refs.centralTowers, central.towers); useInstances(refs.centralGlass, central.glass);
  useInstances(refs.vault, central.vault); useInstances(refs.ribs, central.ribs); useInstances(refs.centralLamps, central.lamps);

  // The vehicle: three white cars on a gold belt, glazed, at the canonical position along the rail. It glides to
  // each minute's position (or jumps there with reduced motion); a new circuit starts it at Central.
  const body = useRef<InstancedMesh>(null), belt = useRef<InstancedMesh>(null), glazing = useRef<InstancedMesh>(null);
  const shown = useRef<{ revision: number; distance: number } | null>(null);
  useFrame((_, dt) => {
    const target = layout ? vehicleDistance(layout, circuit.vehicle) : 0;
    const total = layout?.total ?? 0;
    const previous = shown.current;
    let distance = target;
    if (previous && previous.revision === circuit.revision && total > 0 && !reducedMotion) {
      const ahead = ((target - previous.distance) % total + total) % total;
      distance = ahead > total / 2 ? target : previous.distance + ahead * (1 - Math.exp(-Math.min(dt, .1) * 2));
      if (distance > total) distance -= total;
    }
    shown.current = { revision: circuit.revision, distance };
    for (let car = 0; car < CARS; car += 1) {
      // Cars behind the lead follow it round the loop; with no circuit yet the train stands in Central's hall.
      const along = distance - car * (CAR_LENGTH + CAR_GAP);
      const p = layout ? circuitPointAt(layout, ((along % total) + total) % total) : { x: MERIDIAN_CENTRAL[0] + (car - 1) * (CAR_LENGTH + CAR_GAP), z: MERIDIAN_CENTRAL[1], heading: Math.PI / 2 };
      if (car === 0 && vehicleRef) vehicleRef.current = { x: p.x, z: p.z, heading: p.heading };
      for (const [mesh, y, sx, sy, sz] of [[body, TRANSIT_RAIL_Y + .95, 1.5, 1.5, CAR_LENGTH], [belt, TRANSIT_RAIL_Y + .26, 1.56, .22, CAR_LENGTH + .06], [glazing, TRANSIT_RAIL_Y + 1.25, 1.54, .55, CAR_LENGTH - .6]] as const) {
        if (!mesh.current) continue;
        dummy.position.set(p.x, y, p.z); dummy.rotation.set(0, p.heading, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
        mesh.current.setMatrixAt(car, dummy.matrix);
      }
    }
    for (const mesh of [body, belt, glazing]) if (mesh.current) { mesh.current.count = CARS; mesh.current.instanceMatrix.needsUpdate = true; }
  });

  const capacity = (n: number) => Math.max(1, n);
  return <group name="meridian-central">
    <instancedMesh ref={refs.centralWhite} args={[geometry.box, materials.white, capacity(central.white.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.centralTowers} args={[geometry.spire, materials.white, capacity(central.towers.length)]} castShadow frustumCulled={false} />
    <instancedMesh ref={refs.centralGlass} args={[geometry.box, materials.glass, capacity(central.glass.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.vault} args={[geometry.vault, materials.glass, capacity(central.vault.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.ribs} args={[geometry.ring, materials.gold, capacity(central.ribs.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.centralLamps} args={[geometry.box, materials.lamp, capacity(central.lamps.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.rails} args={[geometry.box, materials.white, capacity(parts.rails.length)]} castShadow frustumCulled={false} />
    <instancedMesh ref={refs.soffits} args={[geometry.box, materials.gold, capacity(parts.soffits.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.pylons} args={[geometry.pylon, materials.white, capacity(parts.pylons.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.yokes} args={[geometry.box, materials.gold, capacity(parts.yokes.length)]} frustumCulled={false} />
    <instancedMesh ref={refs.towers} args={[geometry.tower, materials.white, capacity(parts.towers.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.decks} args={[geometry.deck, materials.white, capacity(parts.decks.length)]} castShadow receiveShadow frustumCulled={false} />
    <instancedMesh ref={refs.canopies} args={[geometry.canopy, materials.gold, capacity(parts.canopies.length)]} castShadow frustumCulled={false} />
    <instancedMesh ref={refs.lamps} args={[geometry.box, materials.lamp, capacity(parts.lamps.length)]} frustumCulled={false} />
    <instancedMesh ref={body} args={[geometry.box, materials.white, CARS]} castShadow frustumCulled={false} />
    <instancedMesh ref={belt} args={[geometry.box, materials.gold, CARS]} frustumCulled={false} />
    <instancedMesh ref={glazing} args={[geometry.box, materials.glass, CARS]} frustumCulled={false} />
  </group>;
}
