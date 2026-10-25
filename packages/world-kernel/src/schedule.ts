import type {
  ConstructionState,
  ResidentState,
  WorldEvent,
  WorldState,
} from "@meridian/world-schema";

const MINUTES_PER_DAY = 1_440;

export interface ScheduledMinuteResult {
  state: WorldState;
  events: WorldEvent[];
}

export function applyScheduledMinute(state: WorldState, minute: number): ScheduledMinuteResult {
  const minuteOfDay = minute % MINUTES_PER_DAY;
  const residents = { ...state.residents };
  const activityEvents: WorldEvent[] = [];
  const locationEvents: WorldEvent[] = [];

  for (const residentId of Object.keys(state.residents).sort()) {
    if (state.engineVersion === "city-life-1" || state.engineVersion === "city-life-2") break;
    const resident = state.residents[residentId];
    if (resident === undefined) continue;

    const scheduleEntry = resident.schedule.find((entry) => entry.startMinute === minuteOfDay);
    if (scheduleEntry === undefined) continue;

    let nextResident: ResidentState = resident;

    if (resident.activity !== scheduleEntry.activity) {
      activityEvents.push({
        type: "resident-activity-changed",
        minute,
        residentId,
        fromActivity: resident.activity,
        toActivity: scheduleEntry.activity,
      });
      nextResident = { ...nextResident, activity: scheduleEntry.activity };
    }

    if (resident.placeId !== scheduleEntry.placeId) {
      locationEvents.push({
        type: "resident-location-changed",
        minute,
        residentId,
        fromPlaceId: resident.placeId,
        toPlaceId: scheduleEntry.placeId,
      });
      nextResident = { ...nextResident, placeId: scheduleEntry.placeId };
    }

    residents[residentId] = nextResident;
  }

  let construction: ConstructionState = state.construction;
  const constructionEvents: WorldEvent[] = [];
  const stageEntry = state.construction.stageSchedule.find((entry) => entry.startMinute === minute);

  if (stageEntry !== undefined && stageEntry.stage !== state.construction.stage) {
    constructionEvents.push({
      type: "construction-stage-progressed",
      minute,
      constructionId: state.construction.id,
      fromStage: state.construction.stage,
      toStage: stageEntry.stage,
    });
    construction = { ...state.construction, stage: stageEntry.stage };
  }

  const clockEvent: WorldEvent = {
    type: "clock-advanced",
    minute,
    fromMinute: minute - 1,
    toMinute: minute,
  };

  return {
    state: {
      ...state,
      canonicalMinute: minute,
      residents,
      construction,
    },
    events: [...activityEvents, ...locationEvents, ...constructionEvents, clockEvent],
  };
}
