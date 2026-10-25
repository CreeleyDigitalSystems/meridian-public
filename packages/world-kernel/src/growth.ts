import type { ResidentLifeProfile, ResidentLifeState } from "@meridian/world-schema";
import { availableStock, type ReservationLedger } from "./discovery-core.js";

/**
 * Growth, part one: a city that makes what it spends.
 *
 * Building materials were a one-time allowance. Nothing ever added stock, so a new world spent its
 * timber by minute 403 and its stone by minute 546, and from then on every venture failed for want
 * of materials — production reached 32 failures in a row. Work produced nothing the city could use.
 *
 * Now two trades produce: builders quarry stone and gardeners fell timber, one unit per completed
 * shift, into stores with a fixed capacity so materials never pile up without limit. And nobody
 * proposes a venture the stores cannot currently supply, so residents stop launching doomed work.
 */

export interface Store { resourceId: string; producer: string; capacity: number; fact: string }

/** Capacity equals the stock a city-life-2 world starts with, so a full store is the founding store. */
export const STORES: readonly Store[] = Object.freeze([
  { resourceId: "stone", producer: "Builder", capacity: 40, fact: "Quarried stone for the city stores." },
  { resourceId: "timber", producer: "Gardener", capacity: 24, fact: "Felled timber for the city stores." },
]);

/**
 * Adds one unit to the store this resident's trade fills, if it has room. Mutates the ledger in place
 * and returns the store that grew, or undefined when the trade produces nothing or the store is full.
 * A rise in stock can never invalidate a reservation: it only adds availability.
 */
export function supplyFromWork(life: ResidentLifeState, profile: ResidentLifeProfile): Store | undefined {
  const store = STORES.find((candidate) => candidate.producer === profile.skills.occupation);
  const resource = store && life.ventures && Object.hasOwn(life.ventures.resources, store.resourceId) ? life.ventures.resources[store.resourceId] : undefined;
  if (!store || !resource || resource.stock >= store.capacity) return undefined;
  resource.stock += 1;
  return store;
}

/** True when the stores can currently cover every material a venture's steps will draw. */
export function storesCanSupply(life: ResidentLifeState, steps: readonly { requires: readonly { resourceId: string; quantity: number }[] }[]): boolean {
  const needed = new Map<string, number>();
  for (const step of steps) for (const requirement of step.requires) needed.set(requirement.resourceId, (needed.get(requirement.resourceId) ?? 0) + requirement.quantity);
  for (const [resourceId, quantity] of needed) {
    const resource = life.ventures && Object.hasOwn(life.ventures.resources, resourceId) ? life.ventures.resources[resourceId] : undefined;
    if (!resource || availableStock(resource as ReservationLedger) < quantity) return false;
  }
  return true;
}
