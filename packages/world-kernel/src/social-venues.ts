import type { WorldState } from "@meridian/world-schema";

/**
 * Where residents meet. Every social meeting used to be sent to Founders Square, so a city with
 * little else to do converged on one place: 82 of 120 residents stood in the square at once.
 *
 * A pair stays together in public when staying is no more crowded than moving the pair to the
 * quietest venue; otherwise it meets in the least crowded public
 * place, with the hour's natural venue breaking ties. Deterministic: the same world and minute
 * always choose the same venue, and because each placed pair changes the occupancy the next pair
 * sees, meetings spread across the city instead of stacking.
 */

/** Public places a meeting may use, in canonical order. Missing places are simply skipped. */
export const SOCIAL_VENUES = ["city-garden", "city-market", "city-promenade", "founders-square"] as const;

/** The venue that suits the hour, following the residents' own daily schedules. */
export function venueForMinute(minute: number): string {
  const minuteOfDay = ((minute % 1440) + 1440) % 1440;
  if (minuteOfDay >= 360 && minuteOfDay < 720) return "city-market";      // morning: the market
  if (minuteOfDay >= 720 && minuteOfDay < 1020) return "city-garden";     // afternoon: the terraces
  if (minuteOfDay >= 1020 && minuteOfDay < 1260) return "city-promenade"; // evening: the water
  return "founders-square";                                              // night: the square
}

/**
 * `reachable` (journeys policy 1, commissioned transit only) keeps out venues the pair cannot both reach
 * lawfully; it defaults to every venue, so a world without transit chooses exactly as before.
 */
export function chooseSocialVenue(state: WorldState, residentId: string, partnerId: string, minute: number, reachable: (placeId: string) => boolean = () => true): string {
  // Places residents founded beyond the city (D-8) are meeting places too, in canonical order.
  const venues = [...SOCIAL_VENUES.filter((id) => Object.hasOwn(state.places, id)), ...Object.keys(state.places).filter((id) => id.startsWith("frontier-") && state.places[id]!.kind === "civic").sort()].filter(reachable);
  if (!venues.length) return state.residents[residentId]!.placeId;
  const here = state.residents[residentId]!.placeId;

  const occupancy = new Map<string, number>(venues.map((id) => [id, 0]));
  for (const resident of Object.values(state.residents)) {
    const count = occupancy.get(resident.placeId);
    if (count !== undefined) occupancy.set(resident.placeId, count + 1);
  }
  // The pair already counts toward occupancy here. Moving would add two people elsewhere.
  // Preserve a quiet existing encounter, but do not make an existing crowd self-sustaining.
  const leastOccupied = Math.min(...occupancy.values());
  if (here === state.residents[partnerId]!.placeId
    && occupancy.has(here)
    && occupancy.get(here)! <= leastOccupied + 2) return here;
  const preferred = venueForMinute(minute);
  return [...venues].sort((a, b) =>
    occupancy.get(a)! - occupancy.get(b)!
    || (a === preferred ? -1 : b === preferred ? 1 : 0)
    || a.localeCompare(b))[0]!;
}
