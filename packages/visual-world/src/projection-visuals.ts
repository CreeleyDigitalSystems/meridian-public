import type { OriginalPresentation, ResidentAppearanceProfile } from "../../world-schema/src/resident-appearance.js";

export type ConstructionStage = "unavailable" | "foundation" | "frame" | "enclosure" | "fitout" | "complete";

/**
 * A frontier shift's worksite, as the public projection names it (frontier access policy 1): the outer quay facing a
 * ring-1 sector, or charted ground (facing the fog being charted; absent when building on the parcel itself).
 */
export type FrontierWorksiteVisual =
  | { phase: "travelling" | "working" | "returning"; kind: "quay"; sector: number }
  | { phase: "travelling" | "working" | "returning"; kind: "ground"; ring: number; slot: number; facing?: { ring: number; slot: number } | undefined };

export interface ResidentVisualState {
  id: string;
  publicPresentation?: boolean;
  persona?: "luna" | "sol" | undefined;
  placeId: string;
  /** Saved home; selects the furnished interior for the AI resident. */
  homePlaceId?: string | undefined;
  /** Undefined only at the legacy projection boundary; never reconstructed from ID. */
  appearance?: ResidentAppearanceProfile | undefined;
  /** Closed immutable original capability admitted at the wardrobe's opening, never a canonical-ID map. */
  originalPresentation?: OriginalPresentation | undefined;
  /** Presentation only: a child never receives an adult skin. Absent means adult. */
  lifeStage?: "child" | undefined;
  walking?: boolean;
  taskKind?: string | undefined;
  partnerId?: string | undefined;
  /**
   * On the way to, or working at, a frontier worksite. Drawn at the worksite only while "working"; while
   * "travelling" the resident is drawn at their current place (where they set out from), never there early.
   */
  frontierSite?: FrontierWorksiteVisual | undefined;
  /** A saved crossing on the Meridian Central circuit, from the public journey fact; absent otherwise. */
  journey?: ResidentJourneyVisual | undefined;
}

/**
 * Where a resident is in their saved journey at the public minute: on foot to the platform they board at,
 * aboard the vehicle, or on foot from the platform they stepped off at to `toPlaceId` (the task's place).
 * `platform` is the stop index on the published circuit; null is Meridian Central.
 */
export interface ResidentJourneyVisual {
  phase: "to-platform" | "aboard" | "onward";
  platform: number | null;
  toPlaceId: string;
}

export interface ResidentPlacement extends ResidentVisualState {
  x: number;
  z: number;
}

interface ProjectionWorld {
  width: number;
  height: number;
  lots: readonly { x: number; y: number }[];
  buildings: readonly { x: number; y: number }[];
  roads: { cells: readonly { x: number; y: number }[] };
}

const stageProfiles = {
  unavailable: {heightScale:0,appearance:"unavailable",color:"#879398"},
  foundation: { heightScale: 0.25, appearance: "works", color: "#d8a84e" },
  frame: { heightScale: 0.5, appearance: "frame", color: "#e2bd69" },
  enclosure: { heightScale: 0.72, appearance: "enclosed", color: "#c8ece7" },
  fitout: { heightScale: 0.9, appearance: "fitout", color: "#e8f3e9" },
  complete: { heightScale: 1, appearance: "complete", color: "#fff8df" },
} as const;

export function constructionStageProfile(stage: ConstructionStage) {
  return stageProfiles[stage];
}

function numberedIndex(placeId: string): number {
  const match = /-(\d+)$/.exec(placeId);
  return Math.max(0, Number(match?.[1] ?? 1) - 1);
}

function stableIndex(value: string, length: number): number {
  if (length <= 1) return 0;
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % length;
}

function placeCoordinate(world: ProjectionWorld, placeId: string): { x: number; y: number } {
  if (placeId.startsWith("home-")) {
    return world.lots[numberedIndex(placeId) % Math.max(1, world.lots.length)] ?? { x: world.width / 2, y: world.height / 2 };
  }
  if (placeId.startsWith("work-")) {
    return world.buildings[numberedIndex(placeId) % Math.max(1, world.buildings.length)] ?? { x: world.width / 2, y: world.height / 2 };
  }
  if (placeId === "founders-square") {
    return world.roads.cells[Math.floor(world.roads.cells.length / 2)] ?? { x: world.width / 2, y: world.height / 2 };
  }
  if (placeId === "founding-district-site") {
    return world.buildings.at(-1) ?? { x: world.width / 2, y: world.height / 2 };
  }
  const candidates = world.roads.cells.length > 0 ? world.roads.cells : world.lots;
  return candidates[stableIndex(placeId, candidates.length)] ?? { x: world.width / 2, y: world.height / 2 };
}

export function projectResidentPlacements(
  world: ProjectionWorld,
  residents: readonly ResidentVisualState[],
): ResidentPlacement[] {
  return residents.map((resident) => {
    const coordinate = placeCoordinate(world, resident.placeId);
    return {
      ...resident,
      x: coordinate.x - world.width / 2 + 0.5,
      z: coordinate.y - world.height / 2 + 0.5,
    };
  });
}
