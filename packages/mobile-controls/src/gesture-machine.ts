export interface Point {
  x: number;
  y: number;
}

export type CameraTransition = "eased" | "immediate";

export type CameraIntent =
  | { type: "none" }
  | { type: "inspect"; point: Point; transition: CameraTransition; allowOrbThrow: boolean }
  | { type: "pan"; delta: Point; transition: CameraTransition; allowOrbThrow: boolean }
  | { type: "pinch"; center: Point; scale: number; transition: CameraTransition; allowOrbThrow: boolean };

export type GestureMode = "idle" | "inspect-candidate" | "pan" | "pinch";

export interface GestureState {
  mode: GestureMode;
  reducedMotion: boolean;
  pointers: Readonly<Record<number, Point>>;
  origin: Point | null;
  lastPoint: Point | null;
  pinchDistance: number | null;
  tapEligible: boolean;
  intent: CameraIntent;
}

export type GestureEvent =
  | { type: "pointer-down"; pointerId: number; point: Point }
  | { type: "pointer-move"; pointerId: number; point: Point }
  | { type: "pointer-up"; pointerId: number }
  | { type: "pointer-cancel"; pointerId: number };

const INSPECT_DRAG_THRESHOLD = 8;

export function idle(options: { reducedMotion?: boolean } = {}): GestureState {
  return {
    mode: "idle",
    reducedMotion: options.reducedMotion ?? false,
    pointers: {},
    origin: null,
    lastPoint: null,
    pinchDistance: null,
    tapEligible: true,
    intent: { type: "none" },
  };
}

export function pointerDown(pointerId: number, x: number, y: number): GestureEvent {
  return { type: "pointer-down", pointerId, point: { x, y } };
}

export function pointerMove(pointerId: number, x: number, y: number): GestureEvent {
  return { type: "pointer-move", pointerId, point: { x, y } };
}

export function pointerUp(pointerId: number): GestureEvent {
  return { type: "pointer-up", pointerId };
}

export function pointerCancel(pointerId: number): GestureEvent {
  return { type: "pointer-cancel", pointerId };
}

function cameraOptions(state: GestureState): Pick<Extract<CameraIntent, { type: "pan" }>, "transition" | "allowOrbThrow"> {
  return state.reducedMotion
    ? { transition: "immediate", allowOrbThrow: false }
    : { transition: "eased", allowOrbThrow: true };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function center(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pointsOf(pointers: Readonly<Record<number, Point>>): Point[] {
  return Object.values(pointers);
}

function withPointers(state: GestureState, pointers: Record<number, Point>): GestureState {
  return { ...state, pointers };
}

function reducePinch(state: GestureState, pointers: Record<number, Point>): GestureState {
  const [first, second] = pointsOf(pointers);
  if (first === undefined || second === undefined) return idle({ reducedMotion: state.reducedMotion });
  const baseDistance = state.pinchDistance ?? distance(first, second);
  const currentDistance = distance(first, second);
  return {
    ...state,
    mode: "pinch",
    pointers,
    origin: null,
    lastPoint: null,
    pinchDistance: baseDistance,
    intent: {
      type: "pinch",
      center: center(first, second),
      scale: baseDistance === 0 ? 1 : currentDistance / baseDistance,
      ...cameraOptions(state),
    },
  };
}

export function reduceGesture(state: GestureState, event: GestureEvent): GestureState {
  if (event.type === "pointer-cancel") return idle({ reducedMotion: state.reducedMotion });

  if (event.type === "pointer-down") {
    const pointers = { ...state.pointers, [event.pointerId]: event.point };
    if (Object.keys(pointers).length === 1) {
      return {
        ...state,
        mode: "inspect-candidate",
        pointers,
        origin: event.point,
        lastPoint: event.point,
        pinchDistance: null,
        tapEligible: true,
        intent: { type: "none" },
      };
    }
    const [first, second] = pointsOf(pointers);
    return reducePinch({ ...state, pointers, pinchDistance: first !== undefined && second !== undefined ? distance(first, second) : null, tapEligible: false }, pointers);
  }

  if (event.type === "pointer-up") {
    if (!(event.pointerId in state.pointers)) return state;
    if (state.mode === "inspect-candidate" && state.origin !== null && state.tapEligible) {
      return { ...idle({ reducedMotion: state.reducedMotion }), intent: { type: "inspect", point: state.origin, ...cameraOptions(state) } };
    }
    const pointers = { ...state.pointers };
    delete pointers[event.pointerId];
    const remaining = pointsOf(pointers);
    if (remaining.length === 0) return idle({ reducedMotion: state.reducedMotion });
    if (remaining.length === 1) {
      const point = remaining[0]!;
      return { ...state, mode: "inspect-candidate", pointers, origin: point, lastPoint: point, pinchDistance: null, tapEligible: false, intent: { type: "none" } };
    }
    return reducePinch(state, pointers);
  }

  if (!(event.pointerId in state.pointers)) return state;
  const pointers = { ...state.pointers, [event.pointerId]: event.point };
  if (Object.keys(pointers).length >= 2) return reducePinch(state, pointers);

  const origin = state.origin ?? event.point;
  const previous = state.lastPoint ?? origin;
  if (state.mode === "inspect-candidate" && distance(origin, event.point) < INSPECT_DRAG_THRESHOLD) {
    return { ...withPointers(state, pointers), lastPoint: event.point, intent: { type: "none" } };
  }
  return {
    ...withPointers(state, pointers),
    mode: "pan",
    lastPoint: event.point,
    intent: {
      type: "pan",
      delta: { x: event.point.x - previous.x, y: event.point.y - previous.y },
      ...cameraOptions(state),
    },
  };
}
