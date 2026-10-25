import { WorldStateSchema, type WorldState } from "@meridian/world-schema";
import { createCityLifeState } from "./city-life-state.js";
import { createProjectLedger, declareResource } from "./project-lifecycle.js";

/** Declared material stocks for a new city-life-2 world (committed state, never invented later). */
export const CITY_LIFE_2_STOCKS: readonly { resourceId: string; stock: number }[] = [{ resourceId: "stone", stock: 40 }, { resourceId: "timber", stock: 24 }];

/**
 * A NEW city-life-2 rehearsal world: city-life-1 residents, tools and garden
 * plus a canonical venture ledger with declared stocks. Existing city-life-1
 * saves are never migrated to this version.
 */
export function createCityLife2State(seed: string, population = 120): WorldState {
  const base = createCityLifeState(seed, population);
  let ventures = createProjectLedger();
  for (const { resourceId, stock } of CITY_LIFE_2_STOCKS) {
    const declared = declareResource(ventures, resourceId, stock, 0);
    if (!declared.ok) throw new Error(declared.reason);
    ventures = declared.value;
  }
  return WorldStateSchema.parse({ ...base, engineVersion: "city-life-2", life: { ...base.life!, ventures } });
}
