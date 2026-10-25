import { useEffect, useLayoutEffect, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { InstancedMesh, Object3D } from "three";

import type { CameraIntent } from "@meridian/mobile-controls";

import { CelestialClock } from "./celestial-clock.js";
import { InstancedBuildings } from "./instanced-buildings.js";
import { InstancedResidents } from "./instanced-residents.js";
import type { QualityPolicy } from "./quality-policy.js";
import type { ConstructionStage, ResidentVisualState } from "./projection-visuals.js";
import type { VentureSiteVisual } from "./venture-sites.js";
import type { CityView, CityLight } from "./city-layout.js";
export { CityScene as FoundingScene } from "./city-scene.js";

export interface FoundingSceneProps {
  inspectedHomeId?: string | null;
  ventureSites?: readonly VentureSiteVisual[] | undefined;
  cityView?: CityView;
  light?: CityLight;
  autoOrbit?: boolean;
  cameraReset?: number;
  world: GeneratedWorldView;
  residents: readonly ResidentVisualState[];
  constructionStage: ConstructionStage;
  canonicalMinute: number;
  gardenProgress?: number | undefined;
  /** Parcels beyond the city (D-8): fog, charted ground, builds and founded places. */
  frontier?: readonly import("./frontier-visuals.js").FrontierParcelVisual[] | undefined;
  /** Meridian Central's circuit from the public `transit.state` fact; absent until it is commissioned. */
  transit?: import("./transit-circuit.js").TransitCircuitVisual | undefined;
  /** Committed civic project progress by project id (0..100). */
  civicProgress?: Readonly<Record<string, number>> | undefined;
  cameraIntent: CameraIntent;
  quality: QualityPolicy;
  reducedMotion?: boolean;
  selectedResidentId?: string | null;
  onSelectResident?: ((residentId: string) => void) | undefined;
  /** The audience's own walk: present while walking, holding the page's keys and buttons. Viewer-local only. */
  observerWalk?: import("./observer-travel.js").WalkInput | null | undefined;
  /** What happened to that walk (where it started, a jump instead of a walk, arrival), for the page to say plainly. */
  onObserverNote?: ((note: import("./observer-travel.js").ObserverNote) => void) | undefined;
}

/** The rendering subset consumed structurally from procedural-world's GeneratedWorld. */
export interface GeneratedWorldView {
  width: number;
  height: number;
  heightCells: readonly { height: number }[];
  water: { cells: readonly unknown[] };
  roads: { cells: readonly { x: number; y: number }[] };
  lots: readonly { x: number; y: number }[];
  buildings: readonly { id: string; x: number; y: number; width: number; height: number }[];
}

function CameraIntentRig({ intent, world }: { intent: CameraIntent; world: GeneratedWorldView }) {
  const { camera } = useThree();

  useEffect(() => {
    if (intent.type === "pan") {
      camera.position.x -= intent.delta.x * 0.018;
      camera.position.z -= intent.delta.y * 0.018;
    } else if (intent.type === "pinch") {
      const distance = camera.position.length();
      const nextDistance = Math.min(44, Math.max(12, distance / Math.max(0.5, intent.scale)));
      camera.position.setLength(nextDistance);
    } else if (intent.type === "inspect") {
      const x = ((intent.point.x % Math.max(1, world.width)) - world.width / 2) * 0.08;
      camera.position.x += x;
    }
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, intent, world]);

  return null;
}

function InstancedRoads({ world }: { world: GeneratedWorldView }) {
  const mesh = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const target = mesh.current;
    if (target === null) return;
    const transform = new Object3D();
    for (const [index, road] of world.roads.cells.entries()) {
      transform.position.set(road.x - world.width / 2 + 0.5, 0.08, road.y - world.height / 2 + 0.5);
      transform.updateMatrix();
      target.setMatrixAt(index, transform.matrix);
    }
    target.instanceMatrix.needsUpdate = true;
  }, [world]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, world.roads.cells.length]} receiveShadow>
      <boxGeometry args={[0.82, 0.08, 0.82]} />
      <meshStandardMaterial color="#e9e2d1" roughness={0.7} />
    </instancedMesh>
  );
}

export function BlockoutScene({
  world,
  residents,
  constructionStage,
  canonicalMinute,
  cameraIntent,
  quality,
  reducedMotion = false,
  selectedResidentId = null,
  onSelectResident,
}: FoundingSceneProps) {
  const waterDepth = Math.max(1, world.water.cells.length / world.width);

  return (
    <>
      <color attach="background" args={["#071a36"]} />
      <fog attach="fog" args={["#173f59", 20, 58]} />
      <ambientLight intensity={0.8} color="#bce8ef" />
      <directionalLight
        castShadow={quality.shadows}
        color="#fff1c2"
        intensity={2.1}
        position={[10, 18, 8]}
        shadow-mapSize={[512, 512]}
      />
      <CameraIntentRig intent={cameraIntent} world={world} />
      <OrbitControls
        makeDefault
        enableDamping={!reducedMotion}
        enablePan={false}
        minDistance={12}
        maxDistance={44}
        maxPolarAngle={Math.PI / 2.15}
        target={[0, 1.1, 0]}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[world.width + 5, world.height + 5]} />
        <meshStandardMaterial color="#d9ddd2" roughness={0.92} />
      </mesh>
      <mesh
        position={[0, 0.13, -world.height / 2 + waterDepth / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[world.width + 2, waterDepth]} />
        <meshStandardMaterial color="#0fc7c0" emissive="#087d86" emissiveIntensity={0.55} metalness={0.18} roughness={0.22} />
      </mesh>
      <InstancedRoads world={world} />
      <InstancedBuildings world={world} constructionStage={constructionStage} />
      <InstancedResidents
        world={world}
        residents={residents}
        selectedResidentId={selectedResidentId}
        onSelectResident={onSelectResident}
      />
      <CelestialClock canonicalMinute={canonicalMinute} reducedMotion={reducedMotion} />
    </>
  );
}
