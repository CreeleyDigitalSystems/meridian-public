import { LinearFilter } from "three";
import { generateSurface } from "./surface-patterns.js";
import { makeTexture, type SurfaceTexturePair } from "./surface-textures.js";

type Kind = "paving" | "plaster" | "terracotta";
export type ArchitectureSurfaces = Record<Kind, SurfaceTexturePair>;
interface Lease { textures: ArchitectureSurfaces }

/** Neutral finish variation layered over the existing deterministic generator. */
export function architecturalPattern(kind: Kind) {
  const pattern = generateSurface(kind === "terracotta" ? "clay" : "stone", kind === "paving" ? 4404 : kind === "terracotta" ? 6606 : 5505, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const xx = x % 63, yy = y % 63, i = (y * 64 + x) * 4;
    const row = Math.floor(yy / 16);
    const joint = yy % 16 === 0 || (xx + (row % 2) * 8) % 16 === 0;
    const grey = kind === "paving" ? joint ? 206 : Math.min(252, pattern.albedo[i]! + 6)
      : kind === "terracotta" ? yy % 8 === 0 ? 207 : (xx + Math.floor(yy / 8) % 2 * 4) % 8 === 0 ? 221 : Math.min(252, pattern.albedo[i]! + 7)
      : Math.max(208, Math.min(250, 230 + (pattern.albedo[i]! - 237) * 2));
    for (let c = 0; c < 3; c++) pattern.albedo[i + c] = grey;
  }
  // Duplicate periodic boundary texels, including noise and joint row offsets.
  for (const data of [pattern.albedo, pattern.roughness]) {
    for (let y = 0; y < 64; y++) data.set(data.subarray(y * 256, y * 256 + 4), (y * 64 + 63) * 4);
    data.set(data.subarray(0, 256), 63 * 256);
  }
  return pattern;
}

let shared: ArchitectureSurfaces | undefined;
const holders = new Set<Lease>();
export function acquireArchitectureSurfaces(): Lease {
  if (!shared) {
    const pair = (kind: Kind): SurfaceTexturePair => {
      const p = architecturalPattern(kind);
      const map = makeTexture(p.albedo, 64, true), roughnessMap = makeTexture(p.roughness, 64, false);
      for (const texture of [map, roughnessMap]) {
        texture.repeat.set(kind === "paving" ? 8 : 2, kind === "paving" ? 8 : 2);
        texture.magFilter = LinearFilter; texture.minFilter = LinearFilter;
      }
      return { map, roughnessMap };
    };
    shared = { paving: pair("paving"), plaster: pair("plaster"), terracotta: pair("terracotta") };
  }
  const lease = { textures: shared }; holders.add(lease); return lease;
}
export function releaseArchitectureSurfaces(lease: Lease) {
  if (!holders.delete(lease) || holders.size) return;
  for (const pair of Object.values(lease.textures)) { pair.map.dispose(); pair.roughnessMap.dispose(); }
  shared = undefined;
}
