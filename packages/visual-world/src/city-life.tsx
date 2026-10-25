import { frontierGroundRoute } from "./frontier-ground-route.js";
import type { FrontierParcelVisual } from "./frontier-visuals.js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, Group, InstancedMesh, type MeshStandardMaterial, Object3D, Sphere, Vector3 } from "three";
import { CITY_GROUND_Y, residentCityPosition, type CityBuilding } from "./city-layout.js";
import { TRANSIT_RAIL_Y, circuitLayout, circuitPlatform, type TransitCircuitVisual } from "./transit-circuit.js";
import type { TransitVehicleFrame } from "./meridian-central.js";

/** A platform lift (Central's hall, a station tower) is gentler than walking. Scene units per second. */
const LIFT_SPEED = 2.4;
/** Beyond the quay's water: a spot on the frontier. Central's pier and hall stand on the city side. */
const beyondWater = (p: readonly number[]) => Math.hypot(p[0]!, p[2]!) > 50;
import type { ResidentVisualState } from "./projection-visuals.js";
import { createPedestrianMap, pedestrianPath, nearestConnectedPosition, residentRig, residentStrollPath, type RigPart } from "./pedestrian-path.js";
import { interactionPositions, gardenGrowthCount, activityPose } from "./city-interactions.js";
import { resolveResidentAppearance } from "./resident-appearance.js";
import { SURFACE_FOR_FAMILY, acquireSurfaceTextures, releaseSurfaceTextures } from "./surface-textures.js";
import type { SurfaceKind } from "./surface-patterns.js";
import { residentDetailBudget } from "./quality-policy.js";
import { createResidentGarmentGeometry, residentFaceAttachment, RESIDENT_HEAD_GEOMETRY, selectResidentDetailSlots, type ResidentDetailSlots } from "./resident-detail.js";
import { MONUMENT_CLOCK_TICK_COUNT, populateMonumentClockTicks } from "./monument-clock-ticks.js";
import { homeInteriorLayout, homeResidentSpot, interiorHomeId, type HomeInteriorLayout } from "./home-interior.js";
import { awayFromSavedPlace, homeRegion, homesResidentPath } from "./home-resident-path.js";
import { ImportedResident, type ImportedResidentMotion } from "./imported-resident.js";
import { residentModelUrl, selectSkinnedResidents } from "./resident-skins.js";

interface ImportedSlot { ready: boolean; motion: { current: ImportedResidentMotion }; onReady: (ready: boolean) => void }
function createImportedSlot(foot: [number, number, number] = [0, 0, 0]): ImportedSlot {
  const slot: ImportedSlot = { ready: false, motion: { current: { foot: [...foot], heading: 0, moving: false } }, onReady: (ready) => { slot.ready = ready; } };
  return slot;
}
/** One stable motion ref and readiness flag per imported model assignment. */
function createImportedSlots(): Map<string, ImportedSlot> {
  return new Map();
}

/**
 * Adult Rocketbox skins, mounted only for the nearest `capacity` residents and
 * re-chosen twice a second, so each GLB downloads on demand (once, then cached)
 * and distant residents keep the light procedural rig. Until a model is ready,
 * or if it fails, the resident's procedural body stays visible.
 */
export function ResidentSkins({ ranking, capacity, urls, heights, slotFor, reducedMotion, onSelect }: {
  ranking: React.RefObject<readonly string[]>; capacity: number; urls: ReadonlyMap<string, string>; heights: ReadonlyMap<string, number>;
  slotFor: (id: string) => ImportedSlot; reducedMotion: boolean; onSelect?: ((id: string) => void) | undefined;
}) {
  const [mounted, setMounted] = useState<readonly string[]>([]);
  const elapsed = useRef(Number.POSITIVE_INFINITY);
  useFrame((_, dt) => {
    elapsed.current += dt;
    if (elapsed.current < 0.5) return;
    elapsed.current = 0;
    setMounted((current) => {
      const next = selectSkinnedResidents(ranking.current, current, capacity);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  });
  return <>{mounted.map((id) => {
    const url = urls.get(id);
    if (!url) return null;
    const slot = slotFor(id);
    return <ImportedResident key={`${id}:${url}`} residentId={id} modelUrl={url} height={heights.get(id)} motion={slot.motion} reducedMotion={reducedMotion} onReady={slot.onReady} onSelect={onSelect} />;
  })}</>;
}

type Foot = [number, number, number];
/** `aboard`: saved aboard the circuit's vehicle, so carried in it rather than walking. */
interface Walker { foot: Foot; destination: Foot; route: Foot[]; heading: number; phase: number; stroll: number; aboard?: boolean }
/** Instances per resident on the global shared meshes (workwear, hair, boots, seam). */
export const RESIDENT_PART_COUNTS = { bodies: 1, hairs: 1, limbs: 4, boots: 2, seams: 1 } as const;
/** Instances per resident on the per-material-family cohort meshes (crafted skin surfaces). */
export const RESIDENT_COHORT_PARTS = { heads: 1, hands: 2 } as const;
export const RESIDENT_SURFACE_COHORTS: readonly SurfaceKind[] = ["clay", "graphite", "stone"];

/** Stable cohort membership: resident index → (surface kind, slot within that kind), in resident order. */
export function residentCohorts(residents: readonly ResidentVisualState[]): { members: Record<SurfaceKind, number[]>; slot: number[]; kind: SurfaceKind[] } {
  const members: Record<SurfaceKind, number[]> = { clay: [], graphite: [], stone: [] };
  const slot: number[] = [];
  const kind: SurfaceKind[] = [];
  residents.forEach((resident, index) => {
    const surface = SURFACE_FOR_FAMILY[resolveResidentAppearance(resident.appearance).surface];
    members[surface].push(index);
    slot.push(members[surface].length - 1);
    kind.push(surface);
  });
  return { members, slot, kind };
}

export function CityResidents({ buildings, residents, selectedResidentId, onSelectResident, reducedMotion = false, positionsRef, efficient = false, transit, vehicleRef, inspectedHome, frontier }: { buildings: readonly CityBuilding[]; residents: readonly ResidentVisualState[]; selectedResidentId?: string | null; onSelectResident?: ((id: string) => void) | undefined; reducedMotion?: boolean; positionsRef: React.RefObject<Map<string, Foot>>; efficient?: boolean; transit?: TransitCircuitVisual | undefined; vehicleRef?: React.RefObject<TransitVehicleFrame | null> | undefined; inspectedHome?: HomeInteriorLayout | undefined; frontier?: readonly FrontierParcelVisual[] | undefined }) {
  // Ref order is part of the test contract (city-life.test.tsx supplies meshes in this order).
  const bodies = useRef<InstancedMesh>(null);
  const hairs = useRef<InstancedMesh>(null);
  const limbs = useRef<InstancedMesh>(null);
  const boots = useRef<InstancedMesh>(null);
  const seams = useRef<InstancedMesh>(null);
  const headClay = useRef<InstancedMesh>(null);
  const headGraphite = useRef<InstancedMesh>(null);
  const headStone = useRef<InstancedMesh>(null);
  const handClay = useRef<InstancedMesh>(null);
  const handGraphite = useRef<InstancedMesh>(null);
  const handStone = useRef<InstancedMesh>(null);
  const marker = useRef<Group>(null);

  const walkers = useRef(new Map<string, Walker>());
  const detailFace = useRef<InstancedMesh>(null);
  const detailEyes = useRef<InstancedMesh>(null);
  const detailMarks = useRef<InstancedMesh>(null);
  const detailHair = useRef<InstancedMesh>(null);
  const detailGarment = useRef<InstancedMesh>(null);
  const detailAccessories = useRef<InstancedMesh>(null);
  const detailSlots = useRef<ResidentDetailSlots>({near:[],mid:[],base:[]});
  const importedSlots = useRef<Map<string, ImportedSlot> | null>(null);
  importedSlots.current ??= createImportedSlots();
  const imported = importedSlots.current;
  const skinRanking = useRef<readonly string[]>([]);
  /** The home view last laid out (a holder object, so the ref order above stays the test contract). */
  const inspection = useRef({ homeId: undefined as string | undefined, layout: undefined as HomeInteriorLayout | undefined });
  const slotFor = (id: string) => {
    let slot = imported.get(id);
    if (!slot) { slot = createImportedSlot(positionsRef.current.get(id)); imported.set(id, slot); }
    return slot;
  };
  const budget = residentDetailBudget(efficient);
  const garmentGeometry = useMemo(createResidentGarmentGeometry, []);
  useLayoutEffect(() => () => garmentGeometry.dispose(), [garmentGeometry]);
  const detailParts = () => [detailFace.current, detailEyes.current, detailMarks.current, detailHair.current, detailGarment.current, detailAccessories.current];
  const heads = { clay: headClay, graphite: headGraphite, stone: headStone } as const;
  const hands = { clay: handClay, graphite: handGraphite, stone: handStone } as const;
  const nav = useMemo(() => createPedestrianMap(buildings), [buildings]);
  // The published circuit, laid out as the drawn rail: platforms for residents on a saved journey.
  const circuit = useMemo(() => transit?.route ? circuitLayout(transit.route) : undefined, [transit?.route]);
  const transform = useMemo(() => new Object3D(), []);
  const instanceSphere = useMemo(() => new Sphere(), []);
  const interiorHome = interiorHomeId(residents);
  const personaHome = useMemo(() => homeInteriorLayout(buildings, interiorHome), [buildings, interiorHome]);
  // Residents at an open home stand inside it: the inspected home (its own layout, never a substitute) and the
  // default family interior, one layout per home.
  const homes = useMemo(() => [inspectedHome, personaHome].filter((home, index, all): home is HomeInteriorLayout =>
    home !== undefined && all.findIndex((other) => other?.homePlaceId === home.homePlaceId) === index), [inspectedHome, personaHome]);
  const positions = useMemo(() => interactionPositions(residents, buildings).map((position, index) => {
    const resident = residents[index]!;
    // Admitted public motion "walking" means the resident's trip has started: they walk out through the doorway
    // to their exterior locator instead of being held in the room until their saved place changes on arrival.
    // A frontier worksite or a saved crossing likewise puts them outside, though their saved place is still the home.
    const home = awayFromSavedPlace(resident) ? undefined : homes.find((open) => open.homePlaceId === resident.placeId);
    return home ? homeResidentSpot(home, resident.id) as Foot : position;
  }), [residents, buildings, homes]);
  const looks = useMemo(() => residents.map((r) => { const look = resolveResidentAppearance(r.appearance); return r.lifeStage === "child" ? { ...look, build: .6, accessory: "none" as const, mark: "none" as const } : look; }), [residents]);
  /** Generated adult skins only; authored models (Luna, the twins) are always mounted below. */
  const skins = useMemo(() => {
    const urls = new Map<string, string>(), heights = new Map<string, number>();
    for (const resident of residents) {
      const url = residentModelUrl(resident);
      if (url) { urls.set(resident.id, url); heights.set(resident.id, resident.appearance?.fixed.height ?? 1); }
    }
    return { urls, heights };
  }, [residents]);
  const cohorts = useMemo(() => residentCohorts(residents), [residents]);
  const globalParts = () => [bodies.current, hairs.current, limbs.current, boots.current, seams.current];
  const cohortParts = () => RESIDENT_SURFACE_COHORTS.flatMap((kind) => [heads[kind].current, hands[kind].current]);
  useLayoutEffect(() => {
    // Retain a conservative initial city bound; each rendered part expands it
    // from its actual transform, including frontier homes and transit positions.
    for (const mesh of [...globalParts(), ...cohortParts(), ...detailParts()]) if (mesh) mesh.boundingSphere = new Sphere(new Vector3(0, 1, 0), 43);
  }, [residents.length, efficient]);
  useLayoutEffect(() => {
    // Three shared texture pairs, one per material family; acquired per mount and
    // released on unmount so StrictMode remounts and sibling meshes never dispose
    // a texture another mesh still uses.
    const handle = acquireSurfaceTextures();
    for (const kind of RESIDENT_SURFACE_COHORTS) {
      for (const mesh of [heads[kind].current, hands[kind].current]) {
        const material = mesh?.material as MeshStandardMaterial | undefined;
        if (!material) continue;
        material.map = handle.textures[kind].map;
        material.roughnessMap = handle.textures[kind].roughnessMap;
        material.needsUpdate = true;
      }
    }
    return () => releaseSurfaceTextures(handle);
  }, []);
  useLayoutEffect(() => {
    // Colours come only from the saved catalogue profile.
    const colour = new Color();
    looks.forEach((look, i) => {
      const kind = cohorts.kind[i]!, slot = cohorts.slot[i]!;
      bodies.current?.setColorAt(i, colour.set(look.garment));
      hairs.current?.setColorAt(i, colour.set(look.hairColor));
      heads[kind].current?.setColorAt(slot, colour.set(look.skin));
      for (let j = 0; j < 2; j++) limbs.current?.setColorAt(i * 4 + j, colour.set(look.garment));
      for (let j = 2; j < 4; j++) limbs.current?.setColorAt(i * 4 + j, colour.set(look.trouser));
      for (let j = 0; j < 2; j++) { boots.current?.setColorAt(i * 2 + j, colour.set(look.boot)); hands[kind].current?.setColorAt(slot * 2 + j, colour.set(look.skin)); }
    });
    for (const kind of RESIDENT_SURFACE_COHORTS) {
      if (heads[kind].current) heads[kind].current!.count = cohorts.members[kind].length;
      if (hands[kind].current) hands[kind].current!.count = cohorts.members[kind].length * 2;
    }
    for (const mesh of [...globalParts(), ...cohortParts()]) if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [looks, cohorts]);
  useLayoutEffect(() => {
    // Opening or closing a home view re-lays that home's occupants. It is a change of presentation, not a walk.
    const opened = inspectedHome?.homePlaceId, previous = inspection.current.homeId;
    const closed = opened === previous ? undefined : inspection.current.layout;
    inspection.current.homeId = opened;
    inspection.current.layout = inspectedHome;
    const relaid = opened === previous ? undefined : new Set([opened, previous].filter((id): id is string => id !== undefined));
    // A walker still inside a home whose view just closed would walk on through its restored shell: like its
    // occupants, they are re-laid at once, onto its doorstep, and go on from there.
    if (closed && !homes.some((home) => home.homePlaceId === closed.homePlaceId)) for (const walker of walkers.current.values()) {
      if (!homeRegion(closed, walker.foot)) continue;
      walker.foot = [...closed.outside];
      walker.route = walker.route.slice(walker.route.findLastIndex((p) => homeRegion(closed, p) !== undefined) + 1);
    }
    /** On foot on one side of the water: the streets in the city, straight over frontier ground; nothing across it. */
    const onFoot = (from: Foot, to: Foot): Foot[] => homesResidentPath(nav, from, to, homes, (a, b) => beyondWater(a) !== beyondWater(b) ? [] : beyondWater(b) ? frontier ? frontierGroundRoute(frontier,a,b) : [a,b] : pedestrianPath(nav, a, b)).slice(1);
    /** The street point nearest a platform's foot (frontier ground has no street map). */
    const street = (point: Foot): Foot => beyondWater(point) ? point : nearestConnectedPosition(nav, point) as Foot;
    positions.forEach((p, i) => {
      const id = residents[i]!.id, journey = residents[i]!.journey;
      // A saved journey on the circuit: on foot to the platform, carried aboard, then on foot to the task's place.
      const platform = journey && journey.phase !== "aboard" ? circuitPlatform(circuit, journey.platform) : undefined;
      const aboard = journey?.phase === "aboard";
      const target: Foot = journey?.phase === "to-platform" && platform ? platform.climb.at(-1)! : journey?.phase === "onward" ? residentCityPosition(journey.toPlaceId, id, buildings) : p;
      const walker = walkers.current.get(id);
      if (!walker) walkers.current.set(id, {foot: [...target], destination: target, route: [], heading: Math.atan2(-target[0], -target[2]), phase: i, stroll: i, aboard});
      else if (walker.destination[0] !== target[0] || walker.destination[1] !== target[1] || walker.destination[2] !== target[2] || walker.aboard !== aboard) {
        walker.destination = target;
        if (relaid?.has(residents[i]!.placeId)) { walker.foot = [...target]; walker.route = []; walker.aboard = aboard; return; }
        walker.aboard = aboard;
        if (aboard) walker.route = [];
        else if (journey?.phase === "to-platform" && platform) walker.route = reducedMotion ? [] : [...onFoot(walker.foot, street(platform.base)), platform.base, ...platform.climb];
        else if (journey?.phase === "onward" && platform) walker.route = reducedMotion ? [] : [...[...platform.climb].reverse(), platform.base, street(platform.base), ...onFoot(street(platform.base), target)];
        else {
          // Someone stepping down from a platform finishes first; the next trip starts where it ends.
          const aloft = walker.foot[1] > CITY_GROUND_Y + .3 && walker.route.length > 0;
          const start = aloft ? walker.route.at(-1)! : walker.foot;
          // On the island, the streets. Nobody is routed over the water: only a saved journey crosses it.
          const trip = reducedMotion ? [] : onFoot(start, p);
          walker.route = aloft ? [...walker.route, ...trip] : trip;
        }
        // No route means an exterior locator update, never walking through a building or over the water.
        if (!walker.route.length && !aboard) walker.foot = [...target];
      }
      if (reducedMotion) { const current = walkers.current.get(id)!; if (!current.aboard) current.foot = [...target]; current.route = []; }
    });
    const ids = new Set(residents.map((r) => r.id));
    for (const id of walkers.current.keys()) if (!ids.has(id)) { walkers.current.delete(id); positionsRef.current.delete(id); }
  }, [positions, residents, nav, reducedMotion, positionsRef, homes, inspectedHome, frontier, circuit, buildings]);
  useFrame(({camera}, dt) => {
    if (typeof document !== "undefined" && document.hidden) return;
    if ([...globalParts(), ...cohortParts()].some((mesh) => !mesh)) return;
    const delta = Math.min(dt, .05);
    const set = (mesh: InstancedMesh, index: number, part: RigPart) => {
      transform.position.set(...part.position); transform.scale.set(...part.scale); transform.rotation.set(part.rotation[0], part.rotation[1], part.rotation[2], "YXZ");
      transform.updateMatrix(); mesh.setMatrixAt(index, transform.matrix);
      // InstancedMesh raycasting uses its own cached sphere even when frustum
      // culling is off. Grow it without rescanning every instance on each frame.
      if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
      instanceSphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(transform.matrix);
      if (mesh.boundingSphere === null) mesh.boundingSphere = instanceSphere.clone();
      else mesh.boundingSphere.radius = Math.max(mesh.boundingSphere.radius,
        mesh.boundingSphere.center.distanceTo(instanceSphere.center) + instanceSphere.radius);
    };
    // All residents retain their base rig. Extra slots are reassigned deterministically.
    const currentPositions = new Map(Array.from(walkers.current, ([id,w]) => [id,w.foot] as const));
    detailSlots.current = selectResidentDetailSlots(residents, currentPositions, camera?.position ?? {x:0,y:0,z:0}, selectedResidentId, budget);
    skinRanking.current = [...detailSlots.current.near, ...detailSlots.current.mid, ...detailSlots.current.base].filter((id) => skins.urls.has(id));
    const detailed = [...detailSlots.current.near, ...detailSlots.current.mid];
    const nearIndex = new Map(detailSlots.current.near.map((id,index) => [id,index]));
    const detailIndex = new Map(detailed.map((id,index) => [id,index]));
    const colour = new Color();
    // Hide every unused slot, including optional marks/accessories, before repopulating.
    const hidden: RigPart = {position:[0,0,0],scale:[0,0,0],rotation:[0,0,0]};
    for (const mesh of detailParts()) if (mesh) for (let i=0;i<mesh.count;i++) set(mesh,i,hidden);
    residents.forEach((r, i) => {
      const walker = walkers.current.get(r.id);
      if (!walker) return;
      const look = looks[i]!, kind = cohorts.kind[i]!, slot = cohorts.slot[i]!;
      // Saved aboard: carried inside the drawn vehicle, wherever the canonical timetable has it.
      const carried = walker.aboard ? vehicleRef?.current : undefined;
      if (carried) { walker.foot = [carried.x, TRANSIT_RAIL_Y + .25, carried.z]; walker.heading = carried.heading; }
      let time = reducedMotion || walker.aboard ? 0 : delta;
      const walkSpeed = r.taskKind ? 2.8 : 1.6;
      let moving = false;
      // Spend this frame's time along every reached path segment. A short
      // waypoint must not consume a whole frame or introduce an artificial stop.
      while (time > 1e-8) {
        if (!walker.route.length && r.walking && !r.journey && r.frontierSite?.phase !== "returning") {
          walker.route = residentStrollPath(nav, walker.destination, walker.foot, walker.stroll++).slice(1);
        }
        const next = walker.route[0];
        if (!next) break;
        const dx = next[0] - walker.foot[0], dy = next[1] - walker.foot[1], dz = next[2] - walker.foot[2], across = Math.hypot(dx, dz);
        // A platform lift is a vertical segment, slower than walking.
        const lift = across < 1e-3 && Math.abs(dy) > .5;
        const distance = lift ? Math.abs(dy) : across;
        if (distance < 1e-8) { walker.foot = [...next]; walker.route.shift(); continue; }
        const speed = lift ? LIFT_SPEED : walkSpeed;
        const step = Math.min(distance, time * speed);
        walker.foot[1] += dy * step / distance;
        walker.foot[0] += dx * step / distance;
        walker.foot[2] += dz * step / distance;
        if (!lift) walker.heading = Math.atan2(dx, dz);
        time -= step / speed;
        moving = true;
        if (step === distance) { walker.foot = [...next]; walker.route.shift(); }
      }
      // A journey leg with no street route ends at its point anyway (a locator update, never a walk through walls).
      if (r.journey && !walker.aboard && !walker.route.length && Math.hypot(walker.destination[0] - walker.foot[0], walker.destination[1] - walker.foot[1], walker.destination[2] - walker.foot[2]) > .05) walker.foot = [...walker.destination];
      if (moving) walker.phase += delta * 9;
      positionsRef.current.set(r.id, walker.foot);
      if (!moving && r.partnerId) {
        const partner = walkers.current.get(r.partnerId);
        if (partner) walker.heading = Math.atan2(partner.foot[0] - walker.foot[0], partner.foot[2] - walker.foot[2]);
      }
      if (!moving && !reducedMotion) walker.phase += delta * 2;
      if (r.id === selectedResidentId) marker.current?.position.set(...walker.foot);
      const importedSlot = imported.get(r.id);
      if (importedSlot) {
        importedSlot.motion.current.foot = walker.foot;
        importedSlot.motion.current.heading = walker.heading;
        importedSlot.motion.current.moving = moving;
        if (importedSlot.ready) {
          set(bodies.current!, i, hidden); set(hairs.current!, i, hidden); set(seams.current!, i, hidden);
          set(heads[kind].current!, slot, hidden);
          for (let j = 0; j < 4; j++) set(limbs.current!, i * 4 + j, hidden);
          for (let j = 0; j < 2; j++) { set(boots.current!, i * 2 + j, hidden); set(hands[kind].current!, slot * 2 + j, hidden); }
          return;
        }
      }
      const pose = moving ? residentRig(walker.foot, walker.heading, Math.sin(walker.phase), [0, 0], look.build, look.hair, look) : activityPose(walker.foot, walker.heading, reducedMotion ? 0 : walker.phase, r.taskKind, look.build, look.hair, look);
      set(bodies.current!, i, pose.body); set(hairs.current!, i, pose.hair); set(seams.current!, i, pose.seam);
      set(heads[kind].current!, slot, pose.head);
      pose.limbs.forEach((part, j) => set(limbs.current!, i * 4 + j, part));
      pose.boots.forEach((part, j) => set(boots.current!, i * 2 + j, part));
      pose.hands.forEach((part, j) => set(hands[kind].current!, slot * 2 + j, part));
      const detail = detailIndex.get(r.id), near = nearIndex.get(r.id);
      const put = (mesh: InstancedMesh | null, slot: number, local: Foot, scale: Foot, color: string, head = false, rotation: Foot = [0,0,0]) => {
        if (!mesh) return;
        const origin = head ? pose.head.position : walker.foot;
        const h=walker.heading, b=look.build;
        const position: Foot = [origin[0]+(Math.cos(h)*local[0]+Math.sin(h)*local[2])*b, origin[1]+local[1]*b, origin[2]+(-Math.sin(h)*local[0]+Math.cos(h)*local[2])*b];
        set(mesh,slot,{position,scale:scale.map(v=>v*b) as Foot,rotation:[rotation[0],h+rotation[1],rotation[2]]});
        mesh.setColorAt(slot,colour.set(color));
      };
      const putFace = (mesh: InstancedMesh | null, slot: number, x: number, y: number, scale: Foot, color: string) => {
        const patch=residentFaceAttachment(look.faceScale,x,y);
        put(mesh,slot,patch.position,scale,color,true,patch.rotation);
      };
      if (near !== undefined) {
        const faceWidth=look.faceScale[0]*.17;
        putFace(detailFace.current,near*6,0,-.008,[.018,.036,.028],look.skin);
        for (const [j,side] of [-1,1].entries()) {
          put(detailFace.current,near*6+1+j,[side*faceWidth,0,0],[.017,.038,.025],look.skin,true);
          putFace(detailFace.current,near*6+3+j,side*faceWidth*.55,-.025,[faceWidth*.6,.026,.018],look.skin);
          putFace(detailEyes.current,near*2+j,side*.029,.013,[.019,.012*look.eyeScale,1],"#29211e");
        }
        putFace(detailFace.current,near*6+5,0,-.04,[.027,.005,.003],"#69493c");
        if (look.mark !== "none") {
          const count=look.mark === "freckles" ? 3 : 1;
          for(let j=0;j<count;j++) putFace(detailMarks.current,near*3+j,.025+j*.009,-.012+(j%2)*.008,look.mark === "scar" ? [.003,.029,1] : [.004,.004,1],"#674739");
        }
      }
      if (detail !== undefined) {
        for(const [j,side] of [-1,1].entries()) {
          put(detailHair.current,detail*2+j,[side*.052,look.hair === "cropped" ? .045 : .017,look.hair === "tied" ? -.077 : -.025],look.hair === "cropped" ? [.032,.033,.06] : look.hair === "tied" ? [.033,.11,.047] : [.05,.075,.09],look.hairColor,true);
          const layer=look.garmentLayer;
          put(detailGarment.current,detail*2+j,[side*.05*look.bodyWidth,.70,.071*look.bodyWidth],[layer[0]*.32*look.bodyWidth,layer[1]*.82,layer[2]],look.garment,false,[0,side*.4,0]);
        }
        if(look.accessory === "satchel") {
          put(detailAccessories.current,detail*4,[.2*look.bodyWidth,.55,.03],[.16,.2,.09],"#775336");
          put(detailAccessories.current,detail*4+1,[.19*look.bodyWidth,.76,.03],[.025,.3,.024],"#775336");
        } else if(look.accessory === "scarf") {
          for(const [j,side] of [-1,1].entries()) {
            put(detailAccessories.current,detail*4+j,[side*.037,.901,.035],[.065,.031,.014],"#be9858",false,[0,side*.65,side*.12]);
            put(detailAccessories.current,detail*4+2+j,[side*.022,j ? .82 : .79,.10],j ? [.032,.11,.01] : [.04,.20,.01],"#be9858",false,[0,side*.12,side*.06]);
          }
        } else if(look.accessory === "glasses") {
          for(const [j,side] of [-1,1].entries()) put(detailAccessories.current,detail*4+j,[side*.029,.022,look.faceScale[2]*.17+.008],[.038,.006,.009],"#3a322b",true);
          put(detailAccessories.current,detail*4+2,[0,.017,look.faceScale[2]*.17+.008],[.023,.006,.009],"#3a322b",true);
        }
      }
    });
    for (const mesh of [...globalParts(), ...cohortParts(), ...detailParts()]) if (mesh) { mesh.instanceMatrix.needsUpdate = true; if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
  });
  const select = (index: number | undefined) => {
    const resident = index === undefined ? undefined : residents[index];
    if (resident) onSelectResident?.(resident.id);
  };
  const pick = (divisor: number) => (e: { stopPropagation: () => void; instanceId?: number | undefined }) => { e.stopPropagation(); select(Math.floor((e.instanceId ?? -1) / divisor)); };
  const pickCohort = (kind: SurfaceKind, divisor: number) => (e: { stopPropagation: () => void; instanceId?: number | undefined }) => {
    e.stopPropagation();
    const member = Math.floor((e.instanceId ?? -1) / divisor);
    select(member < 0 ? undefined : cohorts.members[kind][member]);
  };
  const pickDetail = (tier: "near" | "all", divisor: number) => (e: {stopPropagation:()=>void;instanceId?:number}) => {
    e.stopPropagation();
    const ids=tier === "near" ? detailSlots.current.near : [...detailSlots.current.near,...detailSlots.current.mid];
    const id=ids[Math.floor((e.instanceId ?? -1)/divisor)];
    if(id) onSelectResident?.(id);
  };
  return <group>
    <instancedMesh ref={bodies} args={[undefined, undefined, residents.length]} castShadow frustumCulled={false} onClick={pick(1)}>
      <capsuleGeometry args={[0.16, 0.48, 2, 8]} /><meshStandardMaterial color="#ffffff" roughness={0.78} />
    </instancedMesh>
    <instancedMesh ref={hairs} args={[undefined, undefined, residents.length]} frustumCulled={false} onClick={pick(1)}><sphereGeometry args={[0.17, 8, 5]} /><meshStandardMaterial color="#ffffff" roughness={0.9} /></instancedMesh>
    <instancedMesh ref={limbs} args={[undefined, undefined, residents.length * 4]} castShadow frustumCulled={false} onClick={pick(4)}><capsuleGeometry args={[0.085, 0.45, 1, 6]} /><meshStandardMaterial color="#ffffff" roughness={0.74} /></instancedMesh>
    <instancedMesh ref={boots} args={[undefined, undefined, residents.length * 2]} frustumCulled={false} onClick={pick(2)}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="#ffffff" roughness={0.7} /></instancedMesh>
    <instancedMesh ref={seams} args={[undefined, undefined, residents.length]} frustumCulled={false} onClick={pick(1)}><torusGeometry args={[0.1, 0.008, 3, 10]} /><meshStandardMaterial color="#e0aa4e" emissive="#c98a2e" emissiveIntensity={0.35} metalness={0.5} roughness={0.4} /></instancedMesh>
    {/* Skin surfaces: one head and one hand cohort per material family, each with a shared clay/graphite/stone texture pair.
        Capacity equals the resident count (bounded); `count` is trimmed to the family's actual membership every update. */}
    {RESIDENT_SURFACE_COHORTS.map((kind) => <instancedMesh key={`head-${kind}`} ref={heads[kind]} args={[undefined, undefined, residents.length]} castShadow frustumCulled={false} onClick={pickCohort(kind, 1)}><sphereGeometry args={[...RESIDENT_HEAD_GEOMETRY]} /><meshStandardMaterial color="#ffffff" metalness={0.04} roughness={0.72} /></instancedMesh>)}
    {RESIDENT_SURFACE_COHORTS.map((kind) => <instancedMesh key={`hand-${kind}`} ref={hands[kind]} args={[undefined, undefined, residents.length * 2]} frustumCulled={false} onClick={pickCohort(kind, 2)}><sphereGeometry args={[0.17, 6, 3]} /><meshStandardMaterial color="#ffffff" metalness={0.04} roughness={0.72} /></instancedMesh>)}
    {selectedResidentId && <group ref={marker}>
      <mesh position={[0, .025, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.3, 0.34, 32]} /><meshBasicMaterial color="#e5bd67" /></mesh>
      <mesh position={[0, 1.3, 0]} rotation={[-Math.PI / 2, 0, 0]}><torusGeometry args={[.14, .012, 6, 24]} /><meshStandardMaterial color="#f1cf7b" emissive="#d4a445" emissiveIntensity={.45} metalness={.65} roughness={.2} /></mesh>
    </group>}
    <instancedMesh name="resident-detail-face" ref={detailFace} args={[undefined,undefined,budget.near*6]} frustumCulled={false} onClick={pickDetail("near",6)}><boxGeometry /><meshStandardMaterial color="#ffffff" roughness={.72} /></instancedMesh>
    <instancedMesh name="resident-detail-eyes" ref={detailEyes} args={[undefined,undefined,budget.near*2]} frustumCulled={false} onClick={pickDetail("near",2)}><circleGeometry args={[.5,8]} /><meshStandardMaterial color="#ffffff" roughness={.4} /></instancedMesh>
    <instancedMesh name="resident-detail-marks" ref={detailMarks} args={[undefined,undefined,budget.near*3]} frustumCulled={false} onClick={pickDetail("near",3)}><circleGeometry args={[.5,6]} /><meshStandardMaterial color="#ffffff" roughness={.8} /></instancedMesh>
    <instancedMesh name="resident-detail-hair" ref={detailHair} args={[undefined,undefined,(budget.near+budget.mid)*2]} frustumCulled={false} onClick={pickDetail("all",2)}><sphereGeometry args={[.5,6,3]} /><meshStandardMaterial color="#ffffff" roughness={.9} /></instancedMesh>
    <instancedMesh name="resident-detail-garment" ref={detailGarment} args={[undefined,undefined,(budget.near+budget.mid)*2]} frustumCulled={false} onClick={pickDetail("all",2)}><primitive object={garmentGeometry} attach="geometry" /><meshStandardMaterial color="#ffffff" roughness={.8} /></instancedMesh>
    <instancedMesh name="resident-detail-accessories" ref={detailAccessories} args={[undefined,undefined,(budget.near+budget.mid)*4]} frustumCulled={false} onClick={pickDetail("all",4)}><boxGeometry /><meshStandardMaterial color="#ffffff" roughness={.75} /></instancedMesh>
    <ResidentSkins ranking={skinRanking} capacity={budget.near + budget.mid} urls={skins.urls} heights={skins.heights} slotFor={slotFor} reducedMotion={reducedMotion} onSelect={onSelectResident} />
  </group>;
}

/** Additional planting lives inside the existing non-walkable civic garden podium. */
export function GardenRenewal({ progress }: { progress: number }) {
  const count = gardenGrowthCount(progress);
  const stems = useRef<InstancedMesh>(null);
  const leaves = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!stems.current || !leaves.current) return;
    const transform = new Object3D();
    for (let i = 0; i < count; i++) {
      const angle = i * 2.39996, radius = 4.7 + (i % 4) * .36;
      transform.position.set(Math.sin(angle) * radius, 1.22, 5 + Math.cos(angle) * radius);
      transform.scale.set(1, 1, 1); transform.updateMatrix(); stems.current.setMatrixAt(i, transform.matrix);
      transform.position.y = 1.48; transform.scale.set(.26, .38, .26); transform.updateMatrix(); leaves.current.setMatrixAt(i, transform.matrix);
      leaves.current.setColorAt(i, new Color(i % 3 === 0 ? "#f4d998" : "#aacba2"));
    }
    stems.current.count = count; leaves.current.count = count;
    stems.current.instanceMatrix.needsUpdate = true; leaves.current.instanceMatrix.needsUpdate = true;
    if (leaves.current.instanceColor) leaves.current.instanceColor.needsUpdate = true;
    stems.current.computeBoundingSphere(); leaves.current.computeBoundingSphere();
  }, [count]);
  return <group name="canonical-garden-renewal" userData={{ progress, growthCount: count }}>
    <instancedMesh ref={stems} args={[undefined, undefined, 40]}><cylinderGeometry args={[.025, .045, .4, 5]} /><meshStandardMaterial color="#809a66" /></instancedMesh>
    <instancedMesh ref={leaves} args={[undefined, undefined, 40]}><octahedronGeometry args={[1, 0]} /><meshStandardMaterial color="#ffffff" emissive="#4c693d" emissiveIntensity={.15} roughness={.5} /></instancedMesh>
  </group>;
}

export function MonumentClockTicks() {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    populateMonumentClockTicks(mesh.current);
  }, []);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MONUMENT_CLOCK_TICK_COUNT]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#e9ce8c" metalness={0.7} roughness={0.3} />
    </instancedMesh>
  );
}

export function MonumentClock({ canonicalMinute, reducedMotion }: { canonicalMinute: number; reducedMotion: boolean }) {
  const outer = useRef<Group>(null);
  useFrame((_, dt) => { if (outer.current && !reducedMotion) outer.current.rotation.y += Math.min(dt, 0.05) * 0.035; });
  return <group position={[0, 32, -9]}>
    <group ref={outer} rotation={[0.28, 0, 0.08]}>
      {[8, 7.55, 6.8, 5.8].map((r, i) => <mesh key={r} rotation={[i * 0.19, i * 0.22, 0]}><torusGeometry args={[r, i === 0 ? 0.095 : 0.045, 6, 96]} /><meshStandardMaterial color="#d6b773" metalness={0.85} roughness={0.2} emissive="#9c6c28" emissiveIntensity={0.28} /></mesh>)}
      <MonumentClockTicks />
    </group>
    <group rotation={[0, 0, -(canonicalMinute % 1440) / 1440 * Math.PI * 2]}><mesh position={[0, 2.8, 0]}><boxGeometry args={[0.075, 5.6, 0.075]} /><meshBasicMaterial color="#ffe6a1" /></mesh></group>
    <mesh><sphereGeometry args={[0.42, 20, 12]} /><meshStandardMaterial color="#fff5d5" emissive="#ffd99a" emissiveIntensity={1.5} /></mesh>
    <mesh><torusGeometry args={[1.05, 0.045, 6, 48]} /><meshStandardMaterial color="#dabb7b" metalness={0.8} roughness={0.2} /></mesh>
  </group>;
}

/** A conventional twelve-hour civic dial driven solely by the saved world's minute. */
export function CivicClockHands({ canonicalMinute }: { canonicalMinute: number }) {
  const minuteAngle = -(canonicalMinute % 60) / 60 * Math.PI * 2;
  const hourAngle = -(canonicalMinute % 720) / 720 * Math.PI * 2;
  return <group position={[0, 17, -5]}>
    <group rotation={[0, 0, minuteAngle]}><mesh position={[0, .65, 0]}><boxGeometry args={[.065, 1.3, .06]} /><meshStandardMaterial color="#573f24" metalness={.5} roughness={.4} /></mesh></group>
    <group rotation={[0, 0, hourAngle]}><mesh position={[0, .44, .04]}><boxGeometry args={[.11, .88, .07]} /><meshStandardMaterial color="#cfae62" metalness={.72} roughness={.3} /></mesh></group>
  </group>;
}
