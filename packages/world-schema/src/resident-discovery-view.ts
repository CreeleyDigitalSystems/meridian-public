import { z } from "zod";

/**
 * Read-only, engine-observed discovery facts for one resident, derived from
 * committed history by the discovery sidecar. Never model text. Hypotheses are
 * always empty until canonical hypothesis events exist.
 */
const id = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const count = z.number().int().nonnegative();
export const RESIDENT_DISCOVERY_VIEW_ROWS = 16;

export const ResidentDiscoveryViewSchema = z.object({
  scope: z.literal("engine-observed"),
  formatVersion: z.literal(1),
  residentId: id,
  asOfSequence: count,
  counts: z.object({ readings: count, interference: count, pinned: count }).strict(),
  /** Newest first, bounded. A reading is the project's committed progress when the resident could observe it. */
  readings: z.array(z.object({ minute: count, projectId: id, placeId: id, value: z.number().int().min(0).max(100) }).strict()).max(RESIDENT_DISCOVERY_VIEW_ROWS),
  /** Newest first, bounded. The resident was present when the project changed (own work or someone else's). */
  interference: z.array(z.object({ minute: count, projectId: id, placeId: id }).strict()).max(RESIDENT_DISCOVERY_VIEW_ROWS),
  hypotheses: z.array(z.unknown()).max(0),
  note: z.string().min(1).max(240),
}).strict().superRefine((view, context) => {
  for (const list of [view.readings, view.interference]) for (let i = 1; i < list.length; i++) if (list[i]!.minute > list[i - 1]!.minute) context.addIssue({ code: "custom", message: "rows must be newest first" });
  if (view.readings.length > view.counts.readings || view.interference.length > view.counts.interference) context.addIssue({ code: "custom", message: "page cannot exceed counts" });
});
export type ResidentDiscoveryView = z.infer<typeof ResidentDiscoveryViewSchema>;
export function parseResidentDiscoveryView(input: unknown): ResidentDiscoveryView { return ResidentDiscoveryViewSchema.parse(input); }
