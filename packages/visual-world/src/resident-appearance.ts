import type { ResidentAppearanceProfile } from "../../world-schema/src/resident-appearance.js";

export type ResidentSurface = "terracotta" | "graphite" | "stoneware";
export type ResidentWorkwear = "indigo" | "moss" | "ochre";
export type ResidentHair = "cropped" | "full" | "tied";

export interface ResidentRenderProfile {
  identitySource: "saved" | "unavailable";
  bodyWidth: number;
  faceScale: [number, number, number];
  garmentLayer: [number, number, number];
  eyeScale: number;
  accessory: "none" | "satchel" | "scarf" | "glasses";
  mark: "none" | "freckles" | "scar" | "mole";
  footwearScale: [number, number, number];
  surface: ResidentSurface;
  workwear: ResidentWorkwear;
  hair: ResidentHair;
  /** Hex colours for the shared instanced materials. */
  skin: string;
  garment: string;
  trouser: string;
  hairColor: string;
  boot: string;
  /** Overall height multiplier, 0.94..1.06, so a crowd is not identical silhouettes. */
  build: number;
}

export const RESIDENT_SURFACES: Record<ResidentSurface, string> = {
  terracotta: "#b46d4a",
  graphite: "#565860",
  stoneware: "#c9aa8a",
};

export const RESIDENT_WORKWEAR: Record<ResidentWorkwear, { garment: string; trouser: string }> = {
  indigo: { garment: "#37436e", trouser: "#2b3147" },
  moss: { garment: "#5f6d47", trouser: "#44493a" },
  ochre: { garment: "#a97535", trouser: "#5c4630" },
};

/** Legacy projections have no invented identity. Migration owns profile creation. */
export function resolveResidentAppearance(profile: ResidentAppearanceProfile | undefined): ResidentRenderProfile {
  const complexion = profile?.fixed.complexion;
  const surface: ResidentSurface = complexion === "deep-brown" ? "graphite" : complexion === "warm-umber" || complexion === "golden" ? "terracotta" : "stoneware";
  const workwear: ResidentWorkwear = profile?.presentation.garment === "moss-workwear" ? "moss" : profile?.presentation.garment === "ochre-workwear" ? "ochre" : "indigo";
  const faceScale: Record<string, [number, number, number]> = { oval: [.43,.54,.43], round: [.49,.49,.46], square: [.49,.51,.43], heart: [.46,.53,.42] };
  return {
    identitySource: profile ? "saved" : "unavailable",
    surface, workwear, hair: profile?.presentation.hairStyle ?? "cropped",
    skin: complexion ? {"warm-umber":"#a86b4d", "deep-brown":"#694736", golden:"#be8b56", olive:"#9a8660", "fair-rose":"#d1a38d"}[complexion] : "#a79e91",
    garment: RESIDENT_WORKWEAR[workwear].garment,
    trouser: profile ? {"charcoal-trousers":"#2b3147", "moss-trousers":"#44493a", "umber-trousers":"#5c4630"}[profile.presentation.trousers] : "#41454a",
    hairColor: "#302720",
    boot: profile?.presentation.footwear === "canvas-shoes" ? "#a79b84" : "#342b27",
    build: profile?.fixed.height ?? 1,
    bodyWidth: profile ? {compact:.88, balanced:1, broad:1.16}[profile.fixed.bodyFrame] : 1,
    faceScale: faceScale[profile?.fixed.faceShape ?? "oval"]!,
    garmentLayer: workwear === "indigo" ? [.25,.38,.035] : workwear === "moss" ? [.28,.29,.05] : [.27,.46,.045],
    eyeScale: profile ? {almond:.65, round:1, hooded:.45}[profile.fixed.eyeStyle] : .65,
    accessory: profile?.presentation.accessory ?? "none", mark: profile?.fixed.identifyingMark ?? "none",
    footwearScale: profile?.presentation.footwear === "canvas-shoes" ? [1,.72,.95] : profile?.presentation.footwear === "work-boots" ? [1.1,1.15,1.05] : [1,1,1],
  };
}
