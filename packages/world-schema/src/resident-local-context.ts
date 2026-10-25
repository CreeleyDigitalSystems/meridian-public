import { z } from "zod";
import type { WorldState } from "./index.js";

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const count = z.number().int().nonnegative();
export const ResidentLocalContextSchema = z.object({
  scope: z.literal("same-place"),
  residentId: identifier,
  observedMinute: count,
  place: z.object({ id: identifier, name: z.string().min(1).max(160) }),
  otherResidentCount: count,
  otherResidents: z.array(z.object({ id: identifier, name: z.string().min(1).max(80), activity: z.enum(["home", "work", "leisure"]) })).max(8),
  projectCount: count,
  projects: z.array(z.object({ id: identifier, label: z.string().min(1).max(160), progress: z.number().int().min(0).max(100) })).max(4),
}).superRefine((context, refinement) => {
  if (context.otherResidentCount < context.otherResidents.length || context.projectCount < context.projects.length) {
    refinement.addIssue({ code: "custom", message: "local-context counts cannot be smaller than the listed facts" });
  }
  if (context.otherResidents.some(resident => resident.id === context.residentId)) {
    refinement.addIssue({ code: "custom", message: "other residents cannot include self" });
  }
});
export type ResidentLocalContext = z.infer<typeof ResidentLocalContextSchema>;

/** Canonical co-location, not line-of-sight or access to another resident's mind. */
export function getResidentLocalContext(state: WorldState, residentId: string): ResidentLocalContext | undefined {
  if (!Object.hasOwn(state.residents, residentId)) return undefined;
  const resident = state.residents[residentId]!;
  if (!Object.hasOwn(state.places, resident.placeId)) return undefined;
  const place = state.places[resident.placeId]!;
  const otherIds = Object.keys(state.residents).sort().filter(id => id !== residentId && state.residents[id]!.placeId === place.id);
  const projects = Object.keys(state.life?.projects ?? {}).sort().map(id => state.life!.projects[id]!).filter(project => project.placeId === place.id);
  return {
    scope: "same-place", residentId, observedMinute: state.canonicalMinute,
    place: { id: place.id, name: place.name.slice(0, 160) },
    otherResidentCount: otherIds.length,
    otherResidents: otherIds.slice(0, 8).map(id => {
      const other = state.residents[id]!;
      return { id, name: other.name.slice(0, 80), activity: other.activity };
    }),
    projectCount: projects.length,
    projects: projects.slice(0, 4).map(({ id, label, progress }) => ({ id, label: label.slice(0, 160), progress })),
  };
}
