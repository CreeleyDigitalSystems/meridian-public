import {
  ResidentAppearanceProfileSchema,
  WorldEventSchema,
  WorldStateSchema,
  type ResidentAppearanceProfile,
  type WorldEvent,
  type WorldState,
} from "@meridian/world-schema";

const BODY_FRAMES = ["compact", "balanced", "broad"] as const;
const FACE_SHAPES = ["oval", "round", "square", "heart"] as const;
const COMPLEXIONS = ["warm-umber", "deep-brown", "golden", "olive", "fair-rose"] as const;
const EYE_STYLES = ["almond", "round", "hooded"] as const;
/** The presentation (outfit) lists, also the owned wardrobe's clothing catalogue. Order is part of derivation. */
export const HAIR_STYLES = ["cropped", "full", "tied"] as const;
export const GARMENTS = ["indigo-workwear", "moss-workwear", "ochre-workwear"] as const;
export const TROUSERS = ["charcoal-trousers", "moss-trousers", "umber-trousers"] as const;
export const FOOTWEAR = ["leather-boots", "canvas-shoes", "work-boots"] as const;
export const ACCESSORIES = ["none", "satchel", "scarf", "glasses"] as const;
const MARKS = ["none", "freckles", "scar", "mole"] as const;

/** Stable FNV-1a style hash used only to choose persistent catalogue identifiers. */
function residentHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619) >>> 0;
  return hash;
}

function select<T>(residentId: string, catalogueVersion: 1, feature: string, values: readonly T[]): T {
  return values[residentHash(`${catalogueVersion}:${feature}:${residentId}`) % values.length]!;
}

/**
 * Establishes a deterministic, saved appearance at resident creation or legacy
 * migration. It returns bounded identifiers only; renderer assets stay outside
 * canonical world state.
 */
export function deriveResidentAppearance(residentId: string, catalogueVersion: 1): ResidentAppearanceProfile {
  return ResidentAppearanceProfileSchema.parse({
    catalogueVersion,
    fixed: {
      bodyFrame: select(residentId, catalogueVersion, "body-frame", BODY_FRAMES),
      height: 0.94 + (residentHash(`${catalogueVersion}:height:${residentId}`) % 13) / 100,
      faceShape: select(residentId, catalogueVersion, "face-shape", FACE_SHAPES),
      complexion: select(residentId, catalogueVersion, "complexion", COMPLEXIONS),
      eyeStyle: select(residentId, catalogueVersion, "eye-style", EYE_STYLES),
      identifyingMark: select(residentId, catalogueVersion, "mark", MARKS),
    },
    presentation: {
      hairStyle: select(residentId, catalogueVersion, "hair", HAIR_STYLES),
      garment: select(residentId, catalogueVersion, "garment", GARMENTS),
      trousers: select(residentId, catalogueVersion, "trousers", TROUSERS),
      footwear: select(residentId, catalogueVersion, "footwear", FOOTWEAR),
      accessory: select(residentId, catalogueVersion, "accessory", ACCESSORIES),
    },
  });
}

/** Adds profiles only where a verified legacy life world has none, once. */
export function migrateResidentAppearances(state: WorldState): { state: WorldState; event?: WorldEvent } {
  const verified = WorldStateSchema.parse(state);
  if (!verified.life) return { state: verified };

  const assignments: Record<string, ResidentAppearanceProfile> = {};
  for (const residentId of Object.keys(verified.life.residents).sort()) {
    if (!verified.life.residents[residentId]!.appearance) assignments[residentId] = deriveResidentAppearance(residentId, 1);
  }
  if (Object.keys(assignments).length === 0) return { state: verified };

  const next = structuredClone(verified);
  for (const [residentId, appearance] of Object.entries(assignments)) next.life!.residents[residentId]!.appearance = appearance;
  const event = WorldEventSchema.parse({ type: "resident-appearances-migrated", minute: next.canonicalMinute, assignments });
  return { state: WorldStateSchema.parse(next), event };
}
