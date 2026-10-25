/** Optional imported models are intentionally unavailable in this procedural public candidate. */
export interface ImportedResidentMotion { foot: [number, number, number]; heading: number; moving: boolean }
export function ImportedResident(_props: { residentId: string; modelUrl: string; motion: React.RefObject<ImportedResidentMotion>; reducedMotion: boolean; height?: number | undefined; onReady(ready: boolean): void; onSelect?: ((id: string) => void) | undefined }) { return null; }
