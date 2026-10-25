import { Component, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas, useFrame } from "@react-three/fiber";

import type { CameraIntent } from "@meridian/mobile-controls";
import type { PublicCityView } from "../world/public-world.js";
import {
  FoundingScene,
  projectVentureSites,
  projectFrontier,
  selectQualityPolicy,
  type ConstructionStage,
  type GeneratedWorldView,
  type ResidentVisualState,
  type CityView,
  type CityLight,
  type ObserverNote,
  type WalkInput,
  applyRealismRenderer,
} from "@meridian/visual-world";

import { WorldFallback } from "./world-fallback.js";

/** Tab-local QA opt-in; never stored, and unavailable outside development loopback. */
export function localEfficientPreview(search: string, hostname: string, development: boolean): boolean {
  return development && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    && new URLSearchParams(search).get("qaQuality") === "efficient";
}

function subscribeVisibility(callback: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getVisibilitySnapshot(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function getServerVisibilitySnapshot(): boolean {
  return false;
}

export function configureRealismRenderer(renderer: Parameters<typeof applyRealismRenderer>[0]) {
  applyRealismRenderer(renderer);
}

export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot, getServerVisibilitySnapshot);
}

function FrameBudget({ onSlow }: { onSlow: () => void }) {
  const count = useRef(0);
  const total = useRef(0);
  useFrame(({ gl }, delta) => {
    if (document.hidden) { count.current = 0; total.current = 0; return; }
    count.current++; total.current += delta;
    if (count.current >= 120) {
      const ms = total.current / count.current * 1000;
      gl.domElement.dataset.frameMs = ms.toFixed(1);
      gl.domElement.dataset.drawCalls = String(gl.info.render.calls);
      gl.domElement.dataset.triangles = String(gl.info.render.triangles);
      if (ms > 34) onSlow();
      count.current = 0; total.current = 0;
    }
  });
  return null;
}

/** R3F forwards scene errors out of Canvas; its fallback DOM is always mounted. */
class CanvasBoundary extends Component<{
  children: React.ReactNode;
  fallback: React.ReactNode;
  onError(): void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface WorldCanvasProps {
  onPresentationModeChange?: ((mode: 'map' | '3d') => void) | undefined;
  inspectedHomeId?: string | null;
  cityView?: CityView;
  light?: CityLight;
  autoOrbit?: boolean;
  cameraReset?: number;
  reducedMotionOverride?: boolean;
  immersive?: boolean;
  world: GeneratedWorldView;
  projection: PublicCityView | null;
  cameraIntent: CameraIntent;
  frameSamples?: readonly number[];
  preferFallback?: boolean;
  selectedResidentId?: string | null;
  onSelectResident?: ((residentId: string) => void) | undefined;
  /** The viewer's own walk through the 3D city (absent in the map view). */
  observerWalk?: WalkInput | null | undefined;
  onObserverNote?: ((note: ObserverNote) => void) | undefined;
}

export function WorldCanvas({
  onPresentationModeChange,
  inspectedHomeId = null,
  cityView = "arrival",
  light = "day",
  autoOrbit = false,
  cameraReset = 0,
  reducedMotionOverride,
  immersive = false,
  world,
  projection,
  cameraIntent,
  frameSamples = [],
  preferFallback = false,
  selectedResidentId = null,
  onSelectResident,
  observerWalk = null,
  onObserverNote,
}: WorldCanvasProps) {
  const [canvasFailed, setCanvasFailed] = useState(false);
  const onCanvasError = useCallback(() => setCanvasFailed(true), []);
  const [slow, setSlow] = useState(() => typeof window !== "undefined"
    && localEfficientPreview(window.location.search, window.location.hostname, import.meta.env.DEV));
  const onSlow = useCallback(() => setSlow(true), []);
  const [webglAvailable] = useState(() => {
    if (typeof document === "undefined") return false;
    if (typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom")) return false;
    try {
      const canvas = document.createElement("canvas");
      return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
    } catch {
      return false;
    }
  });
  const reducedMotion = reducedMotionOverride ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const policy = useMemo(() => selectQualityPolicy(frameSamples, {
    devicePixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
    hardwareConcurrency: typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency,
    webgl: webglAvailable,
    reducedMotion: false,
  }), [frameSamples, reducedMotion, webglAvailable]);
  const quality = { ...policy, shadows: Boolean(policy.shadows && !slow && webglAvailable) };
  const residents = projection?.residents.filter(r=>r.visual.placeId!=="unavailable").map(r=>r.visual) ?? [];
  const constructionStage = projection?.construction?.stage ?? 'unavailable';
  const canonicalMinute = projection?.minute ?? 0;
  const ventureSites = projection?.ventureSites ?? [];
  const frontier = projection?.frontier ?? [];
  const fallback = (
    <WorldFallback
      world={world}
      residentNames={Object.fromEntries((projection?.residents ?? []).map(r=>[r.id,r.name]))}
      residents={residents}
      constructionStage={constructionStage}
      canonicalMinute={canonicalMinute}
      selectedResidentId={selectedResidentId}
      onSelectResident={onSelectResident}
    />
  );

  const isHidden = useDocumentHidden();

  const mapPresentation = canvasFailed || quality.mode === 'fallback' || preferFallback;
  useLayoutEffect(() => {
    onPresentationModeChange?.(mapPresentation ? 'map' : '3d');
  }, [mapPresentation, onPresentationModeChange]);
  if (mapPresentation) return fallback;

  return (
    <div
      aria-label="Interactive Founding District"
      data-quality={slow ? "efficient" : "full"}
      data-frameloop={isHidden ? "never" : "always"}
      style={{
        width: "100%", minHeight: immersive ? "100%" : "34rem", height: immersive ? "100%" : "68dvh",
      }}
    >
      <CanvasBoundary fallback={fallback} onError={onCanvasError}>
      <Canvas
        frameloop={isHidden ? "never" : "always"}
        shadows={quality.shadows ? "percentage" : false}
        dpr={slow ? 1 : Math.min(quality.dpr, 1.5)}
        camera={{ position: [57, 38, 72], fov: 45, near: 0.3, far: 1800 }}
        fallback={fallback}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => configureRealismRenderer(gl)}
      >
        <FrameBudget onSlow={onSlow} />
        <FoundingScene
          inspectedHomeId={inspectedHomeId}
          cityView={cityView}
          light={light}
          autoOrbit={autoOrbit}
          cameraReset={cameraReset}
          world={world}
          residents={residents}
          constructionStage={constructionStage}
          canonicalMinute={canonicalMinute}
          ventureSites={ventureSites}
          frontier={frontier}
          transit={projection?.transit}
          gardenProgress={projection?.projects.find((p) => p.kind === "garden")?.progress}
          civicProgress={Object.fromEntries((projection?.projects ?? []).filter((p) => p.kind === "civic" && p.labelKey!=="unavailable").map((p) => [p.labelKey, p.progress]))}
          cameraIntent={cameraIntent}
          quality={quality}
          reducedMotion={reducedMotion}
          selectedResidentId={selectedResidentId}
          onSelectResident={onSelectResident}
          observerWalk={observerWalk}
          onObserverNote={onObserverNote}
        />
      </Canvas>
      </CanvasBoundary>
    </div>
  );
}
