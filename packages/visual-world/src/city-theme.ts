import { ACESFilmicToneMapping, SRGBColorSpace, type WebGLRenderer } from "three";

/**
 * Art-direction palette for the approved 6 September 2026 visual direction.
 *
 * Upper Meridian keeps white and gold as its identity, with restrained teal,
 * lapis, coral, flowering green and stained glass. The working neighbourhoods
 * are warm and lived-in: terracotta, plaster, ochre, stone and timber with
 * colourful awnings. Values are design choices for this pass, not approved
 * production hex values; nothing here is engine state.
 */
export type Finish =
  // Upper Meridian
  | "ivory" | "gold" | "glass" | "lapis" | "teal" | "light" | "violet" | "cyan" | "rose" | "coral"
  // shared landscape and ground
  | "dark" | "garden" | "leaf" | "blossom" | "paving" | "stone" | "water"
  // working neighbourhood
  | "plaster" | "ochre" | "terracotta" | "timber" | "shutter" | "awningCoral" | "awningTeal" | "awningCream" | "iron"
  // matte white limewash for neighbourhood arcades: whiter than plaster, never the glossy civic ivory
  | "stucco";

export interface FinishMaterial { color: string; metalness: number; roughness: number; emissive?: string }

/** Directional modelling with a readable shade floor; no extra light/shadow pass. */
export const DAYLIGHT = { ambient: .14, hemisphere: .42, fill: .5, key: 2.35, environment: .62 } as const;

/** Shared photographic response. Kept explicit so the WebGL host and scene agree. */
export const REALISM_RENDERER = { toneMappingExposure: 1.02 } as const;

export function applyRealismRenderer(renderer: Pick<WebGLRenderer, "toneMapping" | "toneMappingExposure" | "outputColorSpace">) {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = REALISM_RENDERER.toneMappingExposure;
  renderer.outputColorSpace = SRGBColorSpace;
}

/** Bounded atmosphere values; decorative only and never part of world state. */
export const ATMOSPHERE = {
  // Pearl-and-gold daylight (12 Oct 2026 art pass): the city sits in warm air that dissolves distance to pale gold.
  day: { zenith: "#cfc2aa", horizon: "#efe5d2", haze: "#e4d8c0", hazeNear: 62, hazeFar: 250, cloudOpacity: 0.14 },
  night: { zenith: "#101e40", horizon: "#957e96", haze: "#52677e", hazeNear: 105, hazeFar: 270, cloudOpacity: 0.1 },
} as const;

export const FINISHES: Record<Finish, FinishMaterial> = {
  ivory: { color: "#f5f0e5", metalness: 0.12, roughness: 0.38 },
  gold: { color: "#cfae62", metalness: 0.72, roughness: 0.3 },
  glass: { color: "#b6cbc6", metalness: 0.28, roughness: 0.26 },
  lapis: { color: "#8196b6", metalness: 0.35, roughness: 0.22 },
  teal: { color: "#8eb2a7", metalness: 0.3, roughness: 0.24 },
  light: { color: "#fff0c8", metalness: 0.1, roughness: 0.3, emissive: "#ffd38a" },
  violet: { color: "#b39ae0", metalness: 0.4, roughness: 0.14, emissive: "#7d59d3" },
  cyan: { color: "#8fdcd8", metalness: 0.45, roughness: 0.16, emissive: "#3fb9b6" },
  rose: { color: "#eeb6b0", metalness: 0.38, roughness: 0.18, emissive: "#cf7f8f" },
  coral: { color: "#d9775b", metalness: 0.08, roughness: 0.62 },
  dark: { color: "#3b4443", metalness: 0.3, roughness: 0.66 },
  garden: { color: "#5b7a4c", metalness: 0, roughness: 0.92 },
  leaf: { color: "#89a86c", metalness: 0, roughness: 0.82 },
  blossom: { color: "#e39a86", metalness: 0, roughness: 0.8 },
  paving: { color: "#d8ccb6", metalness: 0.02, roughness: 0.86 },
  stone: { color: "#a89c88", metalness: 0.04, roughness: 0.84 },
  water: { color: "#8fb3a8", metalness: 0.35, roughness: 0.18 },
  plaster: { color: "#efe2c9", metalness: 0.02, roughness: 0.88 },
  ochre: { color: "#d8b382", metalness: 0.02, roughness: 0.86 },
  terracotta: { color: "#b8705a", metalness: 0.04, roughness: 0.82 },
  timber: { color: "#6e4a2f", metalness: 0.05, roughness: 0.78 },
  shutter: { color: "#3f7d7a", metalness: 0.06, roughness: 0.7 },
  awningCoral: { color: "#d76b52", metalness: 0.02, roughness: 0.75 },
  awningTeal: { color: "#3f8b8f", metalness: 0.02, roughness: 0.75 },
  awningCream: { color: "#f1e5cd", metalness: 0.02, roughness: 0.75 },
  iron: { color: "#4a4a4e", metalness: 0.55, roughness: 0.45 },
  stucco: { color: "#f2ece0", metalness: 0.01, roughness: 0.74 },
};

/**
  * Flat palette for fictional procedural buildings.
 * every coloured finish is pushed to warm white or gold, and shutters, timber, iron, teal and lapis become satin gold.
 * Greenery, water, glass, lamplight and the glasshouse's coloured panes keep their colour as the accents.
 */
const WHITE_GOLD_COLOURS: Partial<Record<Finish, string>> = {
  terracotta: "#efe6d6", teal: "#d9ae4a", awningCoral: "#f4ebdd", awningTeal: "#d9ae4a", ochre: "#e9d3a0", plaster: "#f4efe6",
  shutter: "#d9ae4a", lapis: "#d9ae4a", timber: "#c9a24e", iron: "#b8913f", awningCream: "#f8f1e4", dark: "#cfc6b6",
  blossom: "#f6eee4", glass: "#bfd3da", ivory: "#f6eeda", coral: "#f1e4d2",
};
/** Finishes that read as gold metal in white & gold. Satin, not mirror: the scene's soft environment turns full metal to bronze. */
export const WHITE_GOLD_METALS: readonly Finish[] = ["gold", "iron", "teal", "awningTeal", "shutter", "lapis", "timber"];
export const WHITE_GOLD_FINISHES: Record<Finish, FinishMaterial> = Object.fromEntries(Object.entries(FINISHES).map(([key, f]) => {
  const finish = key as Finish, metal = WHITE_GOLD_METALS.includes(finish);
  return [finish, { ...f, color: WHITE_GOLD_COLOURS[finish] ?? f.color,
    metalness: metal ? .32 : Math.min(f.metalness, .12), roughness: metal ? .42 : f.roughness }];
})) as Record<Finish, FinishMaterial>;

/** Finishes that cast shadows; small decorative parts do not, keeping the shadow pass bounded. */
export const SHADOW_FINISHES: readonly Finish[] = ["ivory", "stucco", "plaster", "ochre", "stone", "terracotta", "garden", "timber", "lapis", "teal", "glass"];

/** Human-readable district names for the observer interface; descriptive, never a rank. */
export const DISTRICT_NAMES = { upper: "Upper Meridian", neighbourhood: "Working neighbourhoods" } as const;

/** Small night-only landmark budget, never dwelling or workshop emission. */
export const ACCENT_PART_LIMIT = 48;
