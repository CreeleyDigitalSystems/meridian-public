import { frontierGroundDistance, RESIDENT_CITY_WALK_MINUTES, RESIDENT_FRONTIER_STEP_MINUTES, type ResidentTask, type ResidentWalk, type TransitJourney, type WorldState } from "@meridian/world-schema";
import { planTransitJourney, transitJourneyRideRuns, transitPlaceParcel } from "./transit-journey.js";
export interface ResidentTravel { minutes: number; walk?: ResidentWalk; journey?: TransitJourney }
/** Timed ground or saved rail access; undefined is an inaccessible destination, never a teleport fallback. */
export function planResidentTravel(state: WorldState, residentId: string, destination: string, minute: number): ResidentTravel | undefined {
 const resident=state.residents[residentId];
 if(!resident || !Object.hasOwn(state.places,destination)) return undefined;
 if(!state.life?.transit || resident.placeId===destination) return {minutes:0};
 const journey=planTransitJourney(state,residentId,destination,minute);
 if(journey===undefined)return undefined;
 if(journey)return {minutes:journey.arrivesMinute-minute,journey};
 const from=transitPlaceParcel(state,resident.placeId),to=transitPlaceParcel(state,destination);
 const hops=from&&to?frontierGroundDistance(state.life.frontier??{},from.id,to.id):undefined;
 if((from||to)&&hops===undefined)return undefined;
 const minutes=from&&to?Math.max(1,hops!)*RESIDENT_FRONTIER_STEP_MINUTES:RESIDENT_CITY_WALK_MINUTES;
 return {minutes,walk:{policy:1,fromPlaceId:resident.placeId,arrivesMinute:minute+minutes}};
}
/** The expected physical place this minute. Frozen decisions never excuse a wrong place or a missing ride. */
export function taskPresenceHolds(state: WorldState,id:string,task:ResidentTask,minute:number):boolean {
 const resident=state.residents[id];if(!resident)return false;
 if(task.returnTrip)return resident.placeId===task.returnTrip.fromPlaceId;
 if(task.trip) return resident.placeId===(task.trip.phase==='travelling'?task.trip.fromPlaceId:task.placeId)&&transitJourneyRideRuns(state,id,minute);
 const travel=task.walk??task.journey;
 if(travel) return transitJourneyRideRuns(state,id,minute)&&resident.placeId===(minute<=travel.arrivesMinute?travel.fromPlaceId:task.placeId);
 return resident.placeId===task.placeId;
}
/** Arrival changes location only after the complete admitted journey; after arrival the origin is no bypass. */
export function advanceResidentTravel(state:WorldState,id:string,task:ResidentTask,minute:number):boolean {
 const travel=task.walk??task.journey;if(!travel)return state.residents[id]?.placeId===task.placeId;
 const resident=state.residents[id];if(!resident||!transitJourneyRideRuns(state,id,minute))return false;
 if(minute<travel.arrivesMinute)return resident.placeId===travel.fromPlaceId;
 if(resident.placeId===task.placeId)return true;
 if(minute!==travel.arrivesMinute||resident.placeId!==travel.fromPlaceId)return false;
 state.residents[id]={...resident,placeId:task.placeId};return true;
}
