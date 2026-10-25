import {
  TRANSIT_CENTRAL_WALK_MINUTES, TRANSIT_GROUND_STEP_MINUTES, planTransitRide, transitRideHolds, transitServiceAt,
  type FrontierParcel, type TransitJourney, type WorldState,
} from "@meridian/world-schema";
import { transitGroundJoins, transitStationFor } from "./transit.js";

/**
 * Journeys policy 1 (Transport Ruling; coordination-3 gap c): in a world with commissioned transit, a resident
 * who goes across the water does it as a saved journey on the Meridian Central circuit — walk to the platform,
 * ride the vehicle the saved transit actually runs, walk on — instead of being relocated in one minute.
 *
 * The two sides are the city (every place that is not founded on the frontier) and the founded frontier places.
 * The city side boards at Central; a frontier place boards at the station whose walk over charted ground reaches
 * it (`transitStationFor`, on the circuit in service that minute). Between two frontier places joined by charted
 * ground there is no crossing: the resident-travel layer plans a timed walk over that ground. Two frontier places on separate stretches have no lawful way between
 * them at all: fog and water lie between, and the one circuit serves one stretch. Between two city places nothing
 * changes.
 *
 * Like the spatial lane's frontier trips, the traveller keeps their canonical place (the "door" they set out
 * from) until `arrivesMinute`, and the journey is checked every minute: a journey whose ride the saved vehicle no
 * longer runs ends without arriving. Pure and deterministic; nothing here reads renderer geometry.
 */

const FRONTIER_PLACE = /^(?:frontier|landing)-(\d+)-(\d+)$/;
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

/** The charted parcel a founded frontier place stands on; undefined for a city place. */
export function transitPlaceParcel(state: WorldState, placeId: string): FrontierParcel | undefined {
  const match = FRONTIER_PLACE.exec(placeId);
  const frontier = state.life?.frontier;
  if (!match || !frontier) return undefined;
  const parcel = own(frontier, `parcel:${Number(match[1])}:${Number(match[2])}`);
  return parcel?.state === "charted" && (parcel.placeId === placeId || placeId === `landing-${parcel.ring}-${parcel.slot}` && Object.hasOwn(state.places, placeId)) ? parcel : undefined;
}

/**
 * The journey a resident needs to reach `toPlaceId` from where they stand, setting out at `minute`:
 * - null when no water lies between: transit is not commissioned, they are already there, both places are in the
 *   city, or both are frontier places joined by charted ground (so every world without transit keeps its exact
 *   behaviour);
 * - a journey on the circuit when the far side can be reached lawfully;
 * - undefined when it cannot: no circuit runs yet, the frontier place lies where no station's walk reaches, or the
 *   two frontier places lie on separate stretches of charted ground.
 */
export function planTransitJourney(state: WorldState, residentId: string, toPlaceId: string, minute: number): TransitJourney | null | undefined {
  const transit = state.life?.transit;
  const resident = own(state.residents, residentId);
  if (!transit || !resident || resident.placeId === toPlaceId || !Object.hasOwn(state.places, toPlaceId)) return null;
  const from = transitPlaceParcel(state, resident.placeId), to = transitPlaceParcel(state, toPlaceId);
  if (from === undefined && to === undefined) return null;
  if (from !== undefined && to !== undefined) return transitGroundJoins(state.life!.frontier, from.id, to.id) ? null : undefined;
  // The station is chosen on the circuit the ride is planned from: the one in service this minute, including a
  // newer circuit the vehicle adopts at Central this very minute.
  const reach = transitStationFor(state.life!.frontier, transitServiceAt(transit, minute).route, (from ?? to)!.id);
  if (!reach) return undefined;
  // The walk lists the station's parcel through the place's own: one step per parcel, the first down from the platform.
  const groundMinutes = reach.walk.length * TRANSIT_GROUND_STEP_MINUTES;
  const ride = from === undefined
    ? planTransitRide(transit, null, reach.station, minute + TRANSIT_CENTRAL_WALK_MINUTES, minute)
    : planTransitRide(transit, reach.station, null, minute + groundMinutes, minute);
  if (!ride) return undefined;
  return { policy: 1, fromPlaceId: resident.placeId, ride, arrivesMinute: ride.arriveMinute + (from === undefined ? groundMinutes : TRANSIT_CENTRAL_WALK_MINUTES) };
}

/**
 * One committed minute of a task's journey. Until arrival the traveller must still be where they set out and,
 * through the ride's minutes, the saved vehicle must be running that ride; from `arrivesMinute` they take up the
 * task's place (late, if a frozen minute kept them from it). Returns false when the journey cannot go on as
 * saved: the caller then ends the task with no arrival, so nobody crosses the water any other way.
 */
export function keepTransitJourney(state: WorldState, residentId: string, minute: number): boolean {
  const task = state.life?.residents[residentId]?.task;
  const journey = task?.journey;
  const resident = own(state.residents, residentId);
  const transit = state.life?.transit;
  if (!task || !journey || !resident) return false;
  if (resident.placeId === task.placeId) return true;
  if (resident.placeId !== journey.fromPlaceId || !transit) return false;
  if (!transitJourneyRideRuns(state, residentId, minute)) return false;
  if (minute >= journey.arrivesMinute) state.residents[residentId] = { ...resident, placeId: task.placeId };
  return true;
}

/**
 * The vehicle keeps its own timetable whatever its rider proposed: through a saved ride's minutes, false when the
 * saved vehicle is not running that ride now. Outside those minutes (or with no journey) there is nothing to
 * check. Moves nobody; the caller uses it to check a ride even in a minute its traveller is frozen, so a ride the
 * vehicle never ran cannot be skipped over into a late arrival.
 */
export function transitJourneyRideRuns(state: WorldState, residentId: string, minute: number): boolean {
  const journey = state.life?.residents[residentId]?.task?.journey;
  if (!journey || minute < journey.ride.boardMinute || minute > journey.ride.arriveMinute) return true;
  const transit = state.life?.transit;
  return transit !== undefined && transitRideHolds(transit, journey.ride, minute);
}
