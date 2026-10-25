import { DataTexture, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from "three";
import type { ResidentSurface } from "./resident-appearance.js";
import { SURFACE_KINDS, generateSurface, type SurfaceKind, type SurfaceSize } from "./surface-patterns.js";

/**
 * Exactly three shared texture pairs (albedo + roughness), one per crafted
 * material family, never per resident. Textures are reference counted so
 * several meshes (heads and hands of one family, StrictMode remounts) can share
 * them; a pair is disposed only when the last holder releases it.
 */
export interface SurfaceTexturePair { map: DataTexture; roughnessMap: DataTexture }
export type SurfaceTextureSet = Record<SurfaceKind, SurfaceTexturePair>;
/**
 * One lease per acquisition. Leases of the same size share one `textures` set;
 * each lease can be released exactly once, and a stale or repeated release is a
 * no-op that never consumes another holder's lease.
 */
export interface SurfaceTextureHandle { readonly size: SurfaceSize; readonly textures: SurfaceTextureSet }

/** Fixed per-family seeds: deterministic textures across sessions and machines. */
export const SURFACE_SEEDS: Record<SurfaceKind, number> = { clay: 1101, graphite: 2202, stone: 3303 };
/** Approved appearance families map onto the three surface kinds. */
export const SURFACE_FOR_FAMILY: Record<ResidentSurface, SurfaceKind> = { terracotta: "clay", graphite: "graphite", stoneware: "stone" };
export const DEFAULT_SURFACE_SIZE: SurfaceSize = 64;
/** Hard ceiling from the integration brief: three 128×128 RGBA pairs. */
export const SURFACE_TEXTURE_BYTE_LIMIT = 393_216;

/** Bytes of texel data held for all three pairs at a given size. */
export function surfaceTextureBytes(size: SurfaceSize = DEFAULT_SURFACE_SIZE): number {
  return SURFACE_KINDS.length * 2 * size * size * 4;
}

export function makeTexture(data: Uint8Array, size: number, srgb: boolean): DataTexture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.needsUpdate = true;
  return texture;
}

const registry = new Map<SurfaceSize, { textures: SurfaceTextureSet; leases: Set<SurfaceTextureHandle> }>();

/** Acquire a lease on the shared set for a size (generated on first use). Pair with `releaseSurfaceTextures`. */
export function acquireSurfaceTextures(size: SurfaceSize = DEFAULT_SURFACE_SIZE): SurfaceTextureHandle {
  if (surfaceTextureBytes(size) > SURFACE_TEXTURE_BYTE_LIMIT) throw new RangeError("surface textures exceed the byte budget");
  let entry = registry.get(size);
  if (!entry) {
    const textures = {} as SurfaceTextureSet;
    for (const kind of SURFACE_KINDS) {
      const pattern = generateSurface(kind, SURFACE_SEEDS[kind], size);
      textures[kind] = { map: makeTexture(pattern.albedo, size, true), roughnessMap: makeTexture(pattern.roughness, size, false) };
    }
    entry = { textures, leases: new Set() };
    registry.set(size, entry);
  }
  const lease: SurfaceTextureHandle = { size, textures: entry.textures };
  entry.leases.add(lease);
  return lease;
}

/**
 * Release one lease. Disposes the GPU resources only when the last live lease
 * of that set is released. Releasing a lease twice, or a lease from an already
 * disposed set, does nothing.
 */
export function releaseSurfaceTextures(lease: SurfaceTextureHandle): void {
  const entry = registry.get(lease.size);
  if (!entry || entry.textures !== lease.textures || !entry.leases.delete(lease)) return;
  if (entry.leases.size > 0) return;
  for (const kind of SURFACE_KINDS) { entry.textures[kind].map.dispose(); entry.textures[kind].roughnessMap.dispose(); }
  registry.delete(lease.size);
}

/** Diagnostics for tests: live sets and lease counts. */
export function surfaceTextureStatus(): { size: number; holders: number; bytes: number }[] {
  return [...registry.entries()].map(([size, entry]) => ({ size, holders: entry.leases.size, bytes: surfaceTextureBytes(size) }));
}
