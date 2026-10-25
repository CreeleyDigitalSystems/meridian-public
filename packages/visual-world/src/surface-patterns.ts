/** Independently authored flat materials: no provider-generated texture algorithm or binary media. */
export type SurfaceKind = 'clay' | 'graphite' | 'stone';
export type SurfaceSize = 32 | 64 | 128;
export interface SurfacePattern { size: number; albedo: Uint8Array; roughness: Uint8Array }
export const SURFACE_KINDS: readonly SurfaceKind[] = ['clay', 'graphite', 'stone'];
export function generateSurface(kind: SurfaceKind, _seed: number, size: SurfaceSize = 64): SurfacePattern {
  const colour = { clay: [193, 128, 100], graphite: [94, 103, 115], stone: [220, 216, 202] }[kind]!;
  const albedo = new Uint8Array(size * size * 4), roughness = new Uint8Array(size * size * 4);
  for (let i = 0; i < albedo.length; i += 4) { albedo.set([...colour, 255], i); roughness.set([205, 205, 205, 255], i); }
  return { size, albedo, roughness };
}
