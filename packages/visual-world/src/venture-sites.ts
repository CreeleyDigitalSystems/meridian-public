/** Read-only structural subset of the canonical ledger; no simulation or outcome inference. */
interface SiteRecord {
  id: string; placeId: string; status: string; sequence: number;
  outcome: { result: string } | null; steps: readonly { status: string }[];
}
interface SiteReservation {
  planId: string; resourceId: string; quantity: number; status: string;
  grantedMinute: number; expiryMinute: number; terminalMinute: number | null;
}
export interface VentureSiteLedger {
  projects: Readonly<Record<string, SiteRecord>>; retired: readonly SiteRecord[];
  resources: Readonly<Record<string, { active: readonly SiteReservation[] }>>;
}
export interface VentureSiteVisual {
  ventureId: string; placeId: string; status: "active" | "resourcing" | "completed";
  doneSteps: number; totalSteps: number; timber: number; stone: number;
}
/** Existing non-pedestrian display surfaces; never fall back to another place. */
export const VENTURE_SITE_ANCHORS: Readonly<Record<string, readonly [number, number, number]>> = {
  "city-garden": [-4, 1.25, 5],
  "city-market": [-6, 1.37, 20.2],
  "city-promenade": [0, .58, 42],
};
export function projectVentureSites(ledger: VentureSiteLedger | undefined, canonicalMinute: number): VentureSiteVisual[] {
  if (!ledger || !Number.isFinite(canonicalMinute) || canonicalMinute < 0) return [];
  const rank: Record<string, number> = { active: 2, resourcing: 1, completed: 0 };
  const records = [
    ...Object.values(ledger.projects).filter(v => (v.status === "active" || v.status === "resourcing") && v.outcome === null),
    ...ledger.retired.filter(v => v.status === "completed" && v.outcome?.result === "completed" && v.steps.length > 0 && v.steps.every(s => s.status === "done")),
  ].sort((a, b) => rank[b.status]! - rank[a.status]! || b.sequence - a.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: VentureSiteVisual[] = [];
  for (const placeId of Object.keys(VENTURE_SITE_ANCHORS)) {
    const record = records.find(v => v.placeId === placeId);
    if (!record) continue;
    const held = (resourceId: string) => record.status === "completed" ? 0 : (ledger.resources[resourceId]?.active ?? [])
      .filter(r => r.planId === record.id && r.resourceId === resourceId && r.status === "active" && r.terminalMinute === null
        && r.grantedMinute <= canonicalMinute && r.expiryMinute > canonicalMinute && Number.isFinite(r.quantity) && r.quantity > 0)
      .reduce((sum, r) => sum + r.quantity, 0);
    result.push({
      ventureId: record.id, placeId, status: record.status as VentureSiteVisual["status"],
      doneSteps: record.steps.filter(s => s.status === "done").length, totalSteps: record.steps.length,
      timber: held("timber"), stone: held("stone"),
    });
  }
  return result;
}
