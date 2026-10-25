import { z } from "zod";

const identifier = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const BodyFrameSchema = z.enum(["compact", "balanced", "broad"]);
export type BodyFrameId = z.infer<typeof BodyFrameSchema>;

export const FaceShapeSchema = z.enum(["oval", "round", "square", "heart"]);
export type FaceShapeId = z.infer<typeof FaceShapeSchema>;

export const ComplexionSchema = z.enum(["warm-umber", "deep-brown", "golden", "olive", "fair-rose"]);
export type ComplexionId = z.infer<typeof ComplexionSchema>;

export const EyeStyleSchema = z.enum(["almond", "round", "hooded"]);
export type EyeStyleId = z.infer<typeof EyeStyleSchema>;

export const HairStyleSchema = z.enum(["cropped", "full", "tied"]);
export type HairStyleId = z.infer<typeof HairStyleSchema>;

export const GarmentSchema = z.enum(["indigo-workwear", "moss-workwear", "ochre-workwear"]);
export type GarmentId = z.infer<typeof GarmentSchema>;

export const TrouserSchema = z.enum(["charcoal-trousers", "moss-trousers", "umber-trousers"]);
export type TrouserId = z.infer<typeof TrouserSchema>;

export const FootwearSchema = z.enum(["leather-boots", "canvas-shoes", "work-boots"]);
export type FootwearId = z.infer<typeof FootwearSchema>;

export const AccessorySchema = z.enum(["none", "satchel", "scarf", "glasses"]);
export type AccessoryId = z.infer<typeof AccessorySchema>;

export const MarkSchema = z.enum(["none", "freckles", "scar", "mole"]);
export type MarkId = z.infer<typeof MarkSchema>;

/**
 * The owned wardrobe's adult looks (catalogue version 1): one entry per packaged
 * Rocketbox adult avatar (`apps/web/public/models/meridian-adult-<look>.glb`).
 * Styled looks come first. A look is a resident's own presentation choice; it
 * never changes the saved fixed traits, and no child may wear one.
 */
export const WARDROBE_LOOKS = [
  "business-female-01", "business-male-05", "sports-female-02", "female-party-02",
  "female-adult-01", "female-adult-02", "female-adult-03", "female-adult-04", "female-adult-05", "female-adult-07",
  "female-adult-08", "female-adult-09", "female-adult-12", "female-adult-13", "female-adult-14", "female-adult-15", "female-adult-17",
  "male-adult-01", "male-adult-02", "male-adult-03", "male-adult-04", "male-adult-05", "male-adult-06", "male-adult-07",
  "male-adult-08", "male-adult-10", "male-adult-12", "male-adult-13", "male-adult-14", "male-adult-17", "male-adult-18",
] as const;
export const WardrobeLookSchema = z.enum(WARDROBE_LOOKS);
export type WardrobeLookId = z.infer<typeof WardrobeLookSchema>;

/** Pure version1 presentation catalogue. Order and tone participate in existing fixed-trait selection. */
const adultPresentation = (avatar: string, tone: number) => ({ avatar, tone, figure: avatar.includes("Female") ? "female" as const : "male" as const, look: avatar.toLowerCase().replaceAll("_", "-") as WardrobeLookId });
export const ADULT_PRESENTATION_CATALOGUE = [
  adultPresentation("Female_Adult_01", 1), adultPresentation("Female_Adult_02", 0), adultPresentation("Female_Adult_03", 2), adultPresentation("Female_Adult_04", 0),
  adultPresentation("Female_Adult_05", 1), adultPresentation("Female_Adult_07", 0), adultPresentation("Female_Adult_08", 0), adultPresentation("Female_Adult_09", 1),
  adultPresentation("Female_Adult_12", 1), adultPresentation("Female_Adult_13", 2), adultPresentation("Female_Adult_14", 1), adultPresentation("Female_Adult_15", 1),
  adultPresentation("Female_Adult_17", 0), adultPresentation("Female_Party_02", 2), adultPresentation("Business_Female_01", 3), adultPresentation("Sports_Female_02", 1),
  adultPresentation("Male_Adult_01", 1), adultPresentation("Male_Adult_02", 0), adultPresentation("Male_Adult_03", 2), adultPresentation("Male_Adult_04", 4),
  adultPresentation("Male_Adult_05", 1), adultPresentation("Male_Adult_06", 1), adultPresentation("Male_Adult_07", 2), adultPresentation("Male_Adult_08", 1),
  adultPresentation("Male_Adult_10", 2), adultPresentation("Male_Adult_12", 4), adultPresentation("Male_Adult_13", 2), adultPresentation("Male_Adult_14", 1),
  adultPresentation("Male_Adult_17", 4), adultPresentation("Male_Adult_18", 4), adultPresentation("Business_Male_05", 3),
] as const;
export const COMPLEXION_TONE: Readonly<Record<ComplexionId, number>> = { "fair-rose": 0, olive: 1, golden: 2, "warm-umber": 3, "deep-brown": 4 };
function presentationHash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16_777_619) >>> 0;
  result = Math.imul(result ^ (result >>> 16), 0x85eb_ca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2_ae35);
  return (result ^ (result >>> 16)) >>> 0;
}
/** Exact original selection, including custom catalogue order, nearest-tone fallback and object identity. */
export function selectAdultPresentation<T extends { tone: number }>(profile: ResidentAppearanceProfile, catalogue: readonly T[]): T {
  const { bodyFrame, height, faceShape, complexion, eyeStyle, identifyingMark } = profile.fixed;
  const key = `${profile.catalogueVersion}|${bodyFrame}|${height.toFixed(2)}|${faceShape}|${complexion}|${eyeStyle}|${identifyingMark}`;
  const target = COMPLEXION_TONE[complexion];
  const nearest = Math.min(...catalogue.map(entry => Math.abs(entry.tone - target)));
  const candidates = catalogue.filter(entry => Math.abs(entry.tone - target) <= Math.max(1, nearest));
  return candidates[presentationHash(`skin:${key}`) % candidates.length]!;
}
export const defaultAdultLook = (profile: ResidentAppearanceProfile): WardrobeLookId => selectAdultPresentation(profile, ADULT_PRESENTATION_CATALOGUE).look;

/** An opening records the original visible capability once. No names, URLs or private IDs are values. */
export const OriginalPresentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalogue"), look: WardrobeLookSchema }).strict(),
  z.object({ kind: z.literal("authored-elf") }).strict(),
  z.object({ kind: z.literal("procedural") }).strict(),
]);
export type OriginalPresentation = z.infer<typeof OriginalPresentationSchema>;
export const OriginalPresentationsSchema = z.record(z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), OriginalPresentationSchema);
export type OriginalPresentations = z.infer<typeof OriginalPresentationsSchema>;
export function assertOriginalPresentations(residents: Readonly<Record<string, { lifeStage?: string | undefined }>>, input: OriginalPresentations, complete = true): void {
  const originals = OriginalPresentationsSchema.parse(input);
  for (const [id, original] of Object.entries(originals)) {
    if (!Object.hasOwn(residents, id)) throw new Error("original presentation names an unknown resident");
    if (residents[id]!.lifeStage === "child" && original.kind !== "procedural") throw new Error("child original presentation must be procedural");
  }
  if (complete && Object.keys(residents).some(id => !Object.hasOwn(originals, id))) throw new Error("original presentations must bind every resident at opening");
}
export function resolveResidentPresentation(appearance: ResidentAppearanceProfile | undefined, original: OriginalPresentation | undefined): OriginalPresentation | undefined {
  return appearance?.presentation.look ? { kind: "catalogue", look: appearance.presentation.look } : original;
}
export function sameResidentPresentation(a: OriginalPresentation, b: OriginalPresentation): boolean {
  return a.kind === b.kind && (a.kind !== "catalogue" || b.kind === "catalogue" && a.look === b.look);
}

/** Present only once a world's wardrobe has been explicitly opened (a zero-minute event). */
export const WardrobeStateSchema = z.object({ catalogueVersion: z.literal(1), originals: OriginalPresentationsSchema.optional() }).strict();
export type WardrobeState = z.infer<typeof WardrobeStateSchema>;

export const ResidentAppearanceProfileSchema = z.object({
  catalogueVersion: z.literal(1),
  fixed: z.object({
    bodyFrame: BodyFrameSchema,
    height: z.number().min(0.94).max(1.06),
    faceShape: FaceShapeSchema,
    complexion: ComplexionSchema,
    eyeStyle: EyeStyleSchema,
    identifyingMark: MarkSchema,
  }).strict(),
  presentation: z.object({
    hairStyle: HairStyleSchema,
    garment: GarmentSchema,
    trousers: TrouserSchema,
    footwear: FootwearSchema,
    accessory: AccessorySchema,
    /** The resident's own chosen look. Absent means their original look. */
    look: WardrobeLookSchema.optional(),
  }).strict(),
  latestChange: z.object({
    minute: z.number().int().nonnegative(),
    decisionId: identifier,
    source: z.literal("resident"),
  }).strict().optional(),
}).strict();

export interface ResidentAppearanceProfile {
  catalogueVersion: 1;
  fixed: {
    bodyFrame: BodyFrameId;
    height: number;
    faceShape: FaceShapeId;
    complexion: ComplexionId;
    eyeStyle: EyeStyleId;
    identifyingMark: MarkId;
  };
  presentation: {
    hairStyle: HairStyleId;
    garment: GarmentId;
    trousers: TrouserId;
    footwear: FootwearId;
    accessory: AccessoryId;
    look?: WardrobeLookId | undefined;
  };
  latestChange?: { minute: number; decisionId: string; source: "resident" } | undefined;
}
