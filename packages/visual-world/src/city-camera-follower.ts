import { Vector3 } from "three";

export interface CameraFollowerState {
  destination: Vector3;
  aim: Vector3;
  previousFocus: Vector3;
  cameraPosition: Vector3;
  controlsTarget: Vector3;
  transitioning: boolean;
}

export interface CameraFollowerScratch {
  currentPos: Vector3;
  movement: Vector3;
}

export function createCameraFollowerScratch(): CameraFollowerScratch {
  return {
    currentPos: new Vector3(),
    movement: new Vector3(),
  };
}

/**
 * Updates camera and target positions to follow a moving resident.
 * Reuses retained scratch vectors to eliminate per-frame Vector3 and clone allocations.
 *
 * @returns true if the camera and controls were moved directly (when not transitioning).
 */
export function stepCameraFollower(
  liveFocus: readonly [number, number, number],
  state: CameraFollowerState,
  scratch: CameraFollowerScratch,
): boolean {
  scratch.currentPos.set(liveFocus[0], liveFocus[1], liveFocus[2]);
  scratch.movement.subVectors(scratch.currentPos, state.previousFocus);
  state.destination.add(scratch.movement);
  state.aim.add(scratch.movement);
  if (!state.transitioning) {
    state.cameraPosition.add(scratch.movement);
    state.controlsTarget.add(scratch.movement);
  }
  state.previousFocus.copy(scratch.currentPos);
  return !state.transitioning;
}
