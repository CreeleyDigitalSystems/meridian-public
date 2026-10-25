import { InstancedMesh, Object3D } from "three";

export interface MonumentClockTick {
  readonly index: number;
  readonly isMajor: boolean;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export const MONUMENT_CLOCK_TICK_COUNT = 60;
export const MONUMENT_CLOCK_RADIUS = 7.14;

/**
 * Calculates deterministic transform data for each minute/hour tick mark
 * on the MonumentClock face.
 *
 * Major ticks (every 5 minutes / hours) are wider and taller:
 *  - Major: width 0.1, height 0.55, depth 0.06
 *  - Minor: width 0.045, height 0.23, depth 0.06
 *
 * Positioned on a circle of radius 7.14 in the clock plane, oriented
 * tangentially via clockwise rotation -a around the Z axis.
 */
export function monumentClockTick(index: number): MonumentClockTick {
  const a = (index / MONUMENT_CLOCK_TICK_COUNT) * Math.PI * 2;
  const isMajor = index % 5 === 0;
  return {
    index,
    isMajor,
    position: [Math.sin(a) * MONUMENT_CLOCK_RADIUS, Math.cos(a) * MONUMENT_CLOCK_RADIUS, 0],
    rotation: [0, 0, -a],
    scale: [isMajor ? 0.1 : 0.045, isMajor ? 0.55 : 0.23, 0.06],
  };
}

export function monumentClockTicks(): readonly MonumentClockTick[] {
  return Array.from({ length: MONUMENT_CLOCK_TICK_COUNT }, (_, i) => monumentClockTick(i));
}

/**
 * Populates all 60 instance matrices for the MonumentClock ticks in a single batch.
 * Evaluated once during layout rather than every frame.
 */
export function populateMonumentClockTicks(mesh: InstancedMesh): void {
  const transform = new Object3D();
  for (let i = 0; i < MONUMENT_CLOCK_TICK_COUNT; i++) {
    const tick = monumentClockTick(i);
    transform.position.set(tick.position[0], tick.position[1], tick.position[2]);
    transform.rotation.set(tick.rotation[0], tick.rotation[1], tick.rotation[2]);
    transform.scale.set(tick.scale[0], tick.scale[1], tick.scale[2]);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

