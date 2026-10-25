import { WorldEventSchema, WorldStateSchema, type WorldEvent, type WorldState } from "@meridian/world-schema";

type LifeProject = NonNullable<WorldState["life"]>["projects"][string];

/**
 * Civic improvements residents can build together in a city-life-2 world. Each is a committed
 * project whose progress only moves when a resident-proposed venture completes; the renderer draws
 * one finished piece per recorded step of progress. Nothing here is inferred or scheduled.
 */
export const CIVIC_PROJECTS: readonly LifeProject[] = Object.freeze([
  { id: "square-benches", kind: "civic", label: "Benches in Founders Square", placeId: "founders-square", progress: 0 },
  { id: "promenade-lanterns", kind: "civic", label: "Lanterns along the Waterside Promenade", placeId: "city-promenade", progress: 0 },
  { id: "market-planters", kind: "civic", label: "Planters at the Terrace Market", placeId: "city-market", progress: 0 },
  { id: "public-map-boards", kind: "civic", label: "Public map boards", placeId: "founders-square", progress: 0 },
]);

/** Adds the civic projects a verified city-life-2 world lacks, once. Other engines are returned unchanged. */
export function migrateCivicProjects(state: WorldState): { state: WorldState; event?: WorldEvent } {
  const verified = WorldStateSchema.parse(state);
  if (verified.engineVersion !== "city-life-2" || !verified.life) return { state: verified };
  const projects: Record<string, LifeProject> = {};
  for (const project of CIVIC_PROJECTS) {
    if (Object.hasOwn(verified.life.projects, project.id) || !Object.hasOwn(verified.places, project.placeId)) continue;
    projects[project.id] = { ...project };
  }
  if (Object.keys(projects).length === 0) return { state: verified };
  const next = structuredClone(verified);
  for (const [id, project] of Object.entries(projects)) next.life!.projects[id] = { ...project };
  const event = WorldEventSchema.parse({ type: "civic-projects-migrated", minute: next.canonicalMinute, projects });
  return { state: WorldStateSchema.parse(next), event };
}
