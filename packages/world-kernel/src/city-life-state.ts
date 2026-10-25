import { WorldStateSchema, type ResidentLifeState, type WorldState } from "@meridian/world-schema";
import { createCityState } from "./city-state.js";
import { deriveResidentAppearance } from "./resident-appearance.js";

/** New fictional rehearsal state; historical city/founding saves are unchanged. */
export function createCityLifeState(seed: string, population = 120): WorldState {
  const city = createCityState(seed, population);
  const life: ResidentLifeState = { residents: {}, resources: {}, projects: {
    "public-garden": { id: "public-garden", kind: "garden", label: "Public garden renewal", placeId: "city-garden", progress: 0 },
  }, commitments: {} };
  for (const resident of Object.values(city.residents).sort((a, b) => a.id.localeCompare(b.id))) {
    const occupation = resident.occupation!;
    life.residents[resident.id] = {
      residentId: resident.id, needs: { energy: 80, social: 65, purpose: occupation === "Gardener" ? 30 : 60 },
      skills: { occupation, work: 60, gardening: occupation === "Gardener" ? 80 : 10, building: occupation === "Builder" ? 80 : 10 },
      goal: occupation === "Gardener" ? "Improve the public garden with borrowed tools" : `Contribute through ${occupation.toLowerCase()} work and keep well`,
      task: null, memories: [], trust: {}, appearance: deriveResidentAppearance(resident.id, 1),
    };
  }
  const builder = Object.values(city.residents).sort((a, b) => a.id.localeCompare(b.id)).find((r) => r.occupation === "Builder");
  if (builder) life.resources["garden-tools"] = { id: "garden-tools", kind: "garden-tools", label: "Shared garden tools", ownerId: builder.id };
  return WorldStateSchema.parse({ ...city, engineVersion: "city-life-1", life });
}
