import { PublicConstructionIndicator } from "./public-construction.js";
import { resolveHomeView, type HomeInteriorLayout } from "./home-interior.js";
import { useEffect, useMemo, useRef } from "react";
import { Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { FoundingSceneProps } from "./founding-scene.js";
import { isAcrossWater } from "./sky-tram-network.js";
import { CityFrontier, type FrontierParcelVisual } from "./frontier-visuals.js";
import { MeridianCentral, type TransitVehicleFrame } from "./meridian-central.js";
import { CITY_VIEWS, residentCityPosition, residentObservationCamera, type CityView, type CityBuilding } from "./city-layout.js";
import { planLayout } from "./city-plan.js";
import { CityKit } from "./city-kit.js";
import { CityArchitecture } from "./city-architecture.js";
import { CityAtmosphere } from "./city-atmosphere.js";
import { ATMOSPHERE, DAYLIGHT } from "./city-theme.js";
import { cameraSegmentClear, cameraVolumes, type CameraVolume } from "./camera-collision.js";
import { applyOrbitPolarLimits, cameraTransitionPath, clampHomeTarget, HOME_ORBIT, homeCameraPose, homeLensSafe, homeNeighbourVolumes, lensTransition, stepLensTransition } from "./home-camera.js";
import { advanceObserver, observerInHome, observerStart, planObserverTravel, turnFacing, type ObserverNote, type ObserverState, type WalkInput } from "./observer-travel.js";
import { createPedestrianMap, nearestConnectedPosition } from "./pedestrian-path.js";
import { CityResidents, MonumentClock, GardenRenewal, CivicClockHands } from "./city-life.js";
import { interactionPositions } from "./city-interactions.js";
import { createCameraFollowerScratch, stepCameraFollower } from "./city-camera-follower.js";

/** The walking observer's eye above its feet, and how far the lens sits behind them (clear of the near plane). */
const OBSERVER_EYE = .95, OBSERVER_LENS_BACK = .25;
/** The city's own orbit limits (the home view narrows the distance once its camera has arrived). */
const CITY_ORBIT = { minDistance: 2.5, maxDistance: 170 } as const;

interface CityCameraProps {
  home?: HomeInteriorLayout | undefined; neighbours?: readonly CameraVolume[] | undefined;
  view: CityView; reset: number; reducedMotion: boolean; autoOrbit: boolean; focus?: [number, number, number] | undefined; selectedId: string | null;
  positionsRef: React.RefObject<Map<string, [number, number, number]>>; buildings: readonly CityBuilding[];
  walk?: WalkInput | undefined; onObserverNote?: ((note: ObserverNote) => void) | undefined;
}

function CityCamera({ home, neighbours, view, reset, reducedMotion, autoOrbit, focus, selectedId, positionsRef, buildings, walk, onObserverNote }: CityCameraProps) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const { camera, size } = useThree();
  const destination = useRef(new Vector3());
  const aim = useRef(new Vector3());
  /** The lens transition: a home view's checked waypoints (over, not through, its neighbours) and stall guard. */
  const transition = useRef(lensTransition());
  const transitioning = useRef(true);
  const first = useRef(true);
  const following = useRef(true);
  const previousFocus = useRef(new Vector3());
  const scratch = useRef(createCameraFollowerScratch());
  const volumes = useMemo(() => cameraVolumes(buildings), [buildings]);
  const safePosition = useRef(new Vector3());
  const safeTarget = useRef(new Vector3());
  const haveSafePose = useRef(false);
  // The home view's lens: chosen against the actual neighbouring volumes and this viewport's shape.
  const aspect = Math.round(size.width / Math.max(1, size.height) * 20) / 20;
  const homePose = useMemo(() => home && neighbours ? homeCameraPose(home, neighbours, aspect) : undefined, [home, neighbours, aspect]);
  const walking = walk !== undefined;
  const walkingRef = useRef(walking);
  walkingRef.current = walking;
  const note = useRef(onObserverNote);
  note.current = onObserverNote;
  useEffect(() => {
    // While the observer walks it drives the lens; when the walk ends the lens returns to the current view.
    if (walkingRef.current) return;
    const displayedFocus = !home && selectedId ? positionsRef.current.get(selectedId) ?? focus : undefined;
    const preset = homePose ?? (displayedFocus ? residentObservationCamera(displayedFocus, buildings) : CITY_VIEWS[view]);
    destination.current.set(...preset.position); aim.current.set(...preset.target);
    if (!home && !focus && size.width / size.height < 0.8 && view === "arrival") destination.current.sub(aim.current).multiplyScalar(1.32).add(aim.current);
    transitioning.current = true;
    haveSafePose.current = false;
    following.current = true;
    transition.current = lensTransition();
    if (displayedFocus) previousFocus.current.set(...displayedFocus);
    let cut = false;
    if (homePose && neighbours && !first.current && !reducedMotion) {
      // The lens path into the home view is checked as well as its final pose: over its neighbours, or a cut.
      const path = cameraTransitionPath([camera.position.x, camera.position.y, camera.position.z], homePose.position, neighbours);
      cut = path.cut;
      transition.current = lensTransition(path.waypoints.slice(0, -1), true);
    }
    if (first.current || reducedMotion || cut) {
      transition.current = lensTransition();
      camera.position.copy(destination.current); controls.current?.target.copy(aim.current); controls.current?.update();
      first.current = false; transitioning.current = false;
    }
  }, [view, reset, camera, reducedMotion, size.width, size.height, selectedId, home, homePose, neighbours, walking]);

  // The observer: a viewer-local walk on the streets and through the opened home's door. Never a resident or a task.
  const observer = useRef<ObserverState | null>(null);
  const facing = useRef<[number, number]>([0, -1]);
  const walkHome = useRef<HomeInteriorLayout | undefined>(undefined);
  const look = useRef(new Vector3());
  useEffect(() => {
    if (!walk) { observer.current = null; walkHome.current = undefined; return; }
    const map = createPedestrianMap(buildings);
    const faceRoom = (from: readonly number[], room: HomeInteriorLayout) => {
      const dx = room.center[0] - from[0]!, dz = room.center[2] - from[2]!, n = Math.hypot(dx, dz);
      if (n > 1e-6) facing.current = [dx / n, dz / n];
    };
    if (!observer.current) {
      const target = controls.current?.target ?? aim.current;
      const start = observerStart(map, home, [target.x, target.y, target.z]);
      observer.current = { foot: start.point, route: [] };
      const direction = camera.getWorldDirection(look.current), n = Math.hypot(direction.x, direction.z);
      facing.current = n > 1e-6 ? [direction.x / n, direction.z / n] : [0, -1];
      if (home) faceRoom(start.point, home);
      walkHome.current = home;
      note.current?.(start.from === "door" ? "start-door" : start.from === "view" ? "start-view" : "start-nearest-street");
      return;
    }
    if (home === walkHome.current) return;
    const previous = walkHome.current, state = observer.current;
    walkHome.current = home;
    if (previous && (observerInHome(previous, state.foot[0], state.foot[2]) || previous.kind === "frontier" && isAcrossWater(state.foot))) {
      // The home the observer stood in (or on whose parcel) was closed: placed outside it, never walked through walls or water.
      state.route = [];
      if (previous.kind === "frontier") { state.foot = nearestConnectedPosition(map, state.foot); note.current?.("returned-to-city"); }
      else { state.foot = [...previous.outside]; note.current?.("left-home"); }
    }
    if (!home) return;
    const plan = planObserverTravel({ map, home }, state.foot, home.center);
    if (plan.kind === "walk") { state.route = plan.route.slice(1); note.current?.("travel"); return; }
    if (plan.reason === "here") return;
    // No walk from here (across the water, or no route): an explicit jump to the home's own doorstep.
    state.route = [];
    state.foot = [...home.outside];
    faceRoom(home.outside, home);
    note.current?.(plan.reason === "across-water" ? "jump-across-water" : "jump-no-route");
  }, [walk, home, buildings, camera]);

  useFrame((_, dt) => {
    const orbit = controls.current;
    if (!orbit) return;
    if (walk && observer.current) {
      const step = Math.min(dt, .1);
      const frame = advanceObserver(observer.current, { map: createPedestrianMap(buildings), home }, walk, facing.current, step, reducedMotion);
      if (frame.turn) facing.current = turnFacing(facing.current, frame.turn);
      if (frame.heading) {
        const t = reducedMotion ? 1 : 1 - Math.exp(-step * 6);
        const fx = facing.current[0] + (frame.heading[0] - facing.current[0]) * t, fz = facing.current[1] + (frame.heading[1] - facing.current[1]) * t;
        const n = Math.hypot(fx, fz);
        if (n > 1e-6) facing.current = [fx / n, fz / n];
      }
      if (frame.arrived) note.current?.("arrived");
      const [x, y, z] = frame.foot, [fx, fz] = facing.current;
      camera.position.set(x - fx * OBSERVER_LENS_BACK, y + OBSERVER_EYE, z - fz * OBSERVER_LENS_BACK);
      look.current.set(x + fx * 3, y + OBSERVER_EYE - .2, z + fz * 3);
      camera.lookAt(look.current);
      // Orbit resumes from here when the walk ends.
      orbit.target.copy(look.current);
      transitioning.current = false; haveSafePose.current = false; transition.current.waypoints = [];
      applyOrbitPolarLimits(orbit, false);
      return;
    }
    // The home view's tighter distance applies once its lens has arrived; transitions keep the city's limits.
    orbit.minDistance = home ? HOME_ORBIT.minDistance : CITY_ORBIT.minDistance;
    orbit.maxDistance = home && !transitioning.current ? HOME_ORBIT.maxDistance : CITY_ORBIT.maxDistance;
    // The fly-in to a home view follows its checked path; the polar limits bound the viewer's own orbit.
    applyOrbitPolarLimits(orbit, Boolean(home) && transitioning.current);
    if (!transitioning.current && (home || !selectedId)) {
      // City: the lens never enters a building. Home: nor a neighbour, and no neighbour may hide the room.
      const guard = home && neighbours ? neighbours : volumes;
      const safeNow = home && neighbours ? homeLensSafe(neighbours, camera.position, orbit.target) : cameraSegmentClear(camera.position, camera.position, volumes);
      if (haveSafePose.current && (!cameraSegmentClear(safePosition.current, camera.position, guard) || (home && !safeNow))) {
        const damping = orbit.enableDamping;
        const rotating = orbit.autoRotate;
        orbit.enableDamping = false; orbit.autoRotate = false;
        orbit.update(); // consume pending angular/pan deltas
        camera.position.copy(safePosition.current); orbit.target.copy(safeTarget.current);
        orbit.update();
        orbit.enableDamping = damping; orbit.autoRotate = rotating;
      } else if (safeNow) {
        safePosition.current.copy(camera.position); safeTarget.current.copy(orbit.target); haveSafePose.current = true;
      }
      // Panning keeps the opened room within reach.
      if (home && clampHomeTarget(home, orbit.target, camera.position)) orbit.update();
    }
    const liveFocus = !home && selectedId ? positionsRef.current.get(selectedId) : undefined;
    if (liveFocus && following.current) {
      const moved = stepCameraFollower(
        liveFocus,
        {
          destination: destination.current,
          aim: aim.current,
          previousFocus: previousFocus.current,
          cameraPosition: camera.position,
          controlsTarget: orbit.target,
          transitioning: transitioning.current,
        },
        scratch.current,
      );
      if (moved) orbit.update();
    }
    if (!transitioning.current) return;
    transitioning.current = stepLensTransition(transition.current, camera.position, orbit.target, destination.current, aim.current, dt, () => orbit.update()) === "moving";
    if (!transitioning.current) applyOrbitPolarLimits(orbit, false);
  });
  return <OrbitControls ref={controls} makeDefault enabled={!walking} enableDamping={!reducedMotion} dampingFactor={0.075} minDistance={home ? HOME_ORBIT.minDistance : CITY_ORBIT.minDistance} maxDistance={CITY_ORBIT.maxDistance} maxPolarAngle={HOME_ORBIT.maxPolar} minPolarAngle={HOME_ORBIT.minPolar} autoRotate={autoOrbit && !reducedMotion && !focus && !home && !walking} autoRotateSpeed={0.25} enablePan onStart={() => { transitioning.current = false; following.current = false; transition.current.waypoints = []; if (controls.current) applyOrbitPolarLimits(controls.current, false); }} target={[0, 11, 0]} />;
}

export function CityScene({ inspectedHomeId = null, residents, constructionStage, canonicalMinute, gardenProgress, civicProgress, ventureSites, frontier, transit, quality, reducedMotion = false, selectedResidentId = null, onSelectResident, cityView = "arrival", light = "day", autoOrbit = false, cameraReset = 0, observerWalk, onObserverNote }: FoundingSceneProps) {
  // Meridian city v3: the planned city built from the street and civic kits (tools/kit/city), shared with the page.
  const buildings = planLayout();
  // Built and building frontier parcels, keyed on what stands there (not on build progress), for the home view.
  const solidKey = (frontier ?? []).filter((p) => (p.state === "built" || p.state === "building") && p.buildKind).map((p) => `${p.id}:${p.ring}:${p.slot}:${p.state}:${p.buildKind}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const solids = useMemo((): FrontierParcelVisual[] => (frontier ?? []).filter((p) => (p.state === "built" || p.state === "building") && p.buildKind).map(({ id, ring, slot, state, buildKind }) => ({ id, ring, slot, state, buildKind })), [solidKey]);
  // The opened home: the resident's admitted home anchor resolved to its own building or founded parcel, or nothing.
  const home = useMemo(() => { const view = resolveHomeView(buildings, inspectedHomeId, solids); return view.status === "available" ? view.layout : undefined; }, [buildings, inspectedHomeId, solids]);
  const neighbours = useMemo(() => home ? homeNeighbourVolumes(buildings, home, solids) : undefined, [buildings, home, solids]);
  const night = light === "blue-hour";
  const residentPositions = useRef(new Map<string, [number, number, number]>());
  // Written by the drawn vehicle each frame; riders saved aboard are carried inside it.
  const transitVehicle = useRef<TransitVehicleFrame | null>(null);
  const resident = residents.find((r) => r.id === selectedResidentId);
  const positions = useMemo(() => interactionPositions(residents, buildings), [residents, buildings]);
  const focus = resident ? positions[residents.indexOf(resident)] : undefined;
  const shell = home?.kind === "planned" ? buildings[home.buildingIndex] : undefined;
  return <>
    {/* Late-afternoon warmth: a lower, softer key light keeps terracotta and plaster saturated instead of washing white and gold to glare. */}
    <fog attach="fog" args={[night ? ATMOSPHERE.night.haze : ATMOSPHERE.day.haze, night ? ATMOSPHERE.night.hazeNear : ATMOSPHERE.day.hazeNear, night ? ATMOSPHERE.night.hazeFar : ATMOSPHERE.day.hazeFar]} />
    <ambientLight intensity={night ? 0.12 : DAYLIGHT.ambient} color={night ? "#9db3e3" : "#f3e6d2"} />
    <hemisphereLight args={[night ? "#9eafe2" : "#f1e4cc", night ? "#536362" : "#7a6650", night ? 0.25 : DAYLIGHT.hemisphere]} />
    <directionalLight castShadow={quality.shadows} color={night ? "#a9c9f4" : "#ffdfae"} intensity={night ? 0.85 : DAYLIGHT.key} position={night ? [-44, 52, 38] : [-62, 44, -40]} shadow-mapSize={[2048, 2048]} shadow-camera-left={-75} shadow-camera-right={75} shadow-camera-top={75} shadow-camera-bottom={-75} shadow-camera-near={1} shadow-camera-far={160} shadow-bias={-0.00015} shadow-normalBias={0.07} />
    {/* Day: a warm front fill keeps facades readable under the side-back key; blue hour keeps its cool rim. */}
    <directionalLight position={night ? [45, 25, -35] : [40, 30, 60]} intensity={night ? 0.5 : DAYLIGHT.fill} color={night ? "#c0e6e8" : "#f0dcc0"} />
    <Environment resolution={128} frames={1} environmentIntensity={night ? 1 : DAYLIGHT.environment}>
      <Lightformer form="rect" intensity={2.6} position={[-12, 18, 10]} scale={[18, 20, 1]} target={[0, 0, 0]} color={night ? "#9ab6dd" : "#ffe9cc"} />
      <Lightformer form="rect" intensity={1.6} position={[15, 12, -8]} scale={[15, 18, 1]} target={[0, 0, 0]} color="#c4d8de" />
      <Lightformer form="ring" intensity={0.8} position={[0, 25, 0]} rotation={[Math.PI / 2, 0, 0]} scale={20} />
    </Environment>
    <CityCamera home={home} neighbours={neighbours} view={cityView} reset={cameraReset} reducedMotion={reducedMotion} autoOrbit={autoOrbit} focus={focus} selectedId={selectedResidentId} positionsRef={residentPositions} buildings={buildings} walk={observerWalk ?? undefined} onObserverNote={onObserverNote} />
    <CityAtmosphere light={light} reducedMotion={reducedMotion} />
    {/* Only the opened planned home's own shell is cut away; a frontier home's shell is replaced in CityArchitecture. */}
    <CityKit light={light} efficient={!quality.shadows} hiddenPlaceId={shell?.placeId} hiddenRect={shell?.rect} />
    <PublicConstructionIndicator stage={constructionStage} />
    <CityArchitecture inspectedHome={home} buildings={buildings} constructionStage={constructionStage} light={light} ventureSites={ventureSites} civicProgress={civicProgress} frontier={frontier} efficient={!quality.shadows} />
    {gardenProgress !== undefined && <GardenRenewal progress={gardenProgress} />}
    {frontier && frontier.length > 0 && <CityFrontier parcels={frontier} light={light} />}
    {/* Meridian Central and its circuit: only the canonical transit the public fact carries (Transport Ruling). */}
    {transit && <MeridianCentral circuit={transit} light={light} reducedMotion={reducedMotion} vehicleRef={transitVehicle} />}
    <CivicClockHands canonicalMinute={canonicalMinute} />
    <MonumentClock canonicalMinute={canonicalMinute} reducedMotion={reducedMotion} />
    <CityResidents efficient={!quality.shadows} buildings={buildings} residents={residents} selectedResidentId={selectedResidentId} onSelectResident={onSelectResident} reducedMotion={reducedMotion} positionsRef={residentPositions} inspectedHome={home} frontier={frontier} transit={transit} vehicleRef={transitVehicle} />
  </>;
}
