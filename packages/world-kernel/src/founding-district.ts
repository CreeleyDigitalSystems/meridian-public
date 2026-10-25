import {
  WorldStateSchema,
  type PlaceState,
  type ResidentState,
  type ScheduleEntry,
  type WorldState,
} from "@meridian/world-schema";

const RESIDENT_COUNT = 12;

function residentNumber(index: number): string {
  return String(index).padStart(2, "0");
}

function dailySchedule(homePlaceId: string, workPlaceId: string): ScheduleEntry[] {
  return [
    { startMinute: 0, activity: "home", placeId: homePlaceId },
    { startMinute: 540, activity: "work", placeId: workPlaceId },
    { startMinute: 1_020, activity: "leisure", placeId: "founders-square" },
    { startMinute: 1_260, activity: "home", placeId: homePlaceId },
  ];
}

function foundingPlaces(): Record<string, PlaceState> {
  const places: Record<string, PlaceState> = {
    "founders-square": {
      id: "founders-square",
      name: "Founders Square",
      kind: "civic",
    },
    "founding-district-site": {
      id: "founding-district-site",
      name: "Founding District Site",
      kind: "construction",
    },
  };

  for (let index = 1; index <= RESIDENT_COUNT; index += 1) {
    const number = residentNumber(index);
    const homePlaceId = `home-${number}`;
    const workPlaceId = `work-${number}`;

    places[homePlaceId] = {
      id: homePlaceId,
      name: `Residence ${number}`,
      kind: "residence",
    };
    places[workPlaceId] = {
      id: workPlaceId,
      name: `Workplace ${number}`,
      kind: "workplace",
    };
  }

  return places;
}

function foundingResidents(): Record<string, ResidentState> {
  const residents: Record<string, ResidentState> = {};

  for (let index = 1; index <= RESIDENT_COUNT; index += 1) {
    const number = residentNumber(index);
    const id = `resident-${number}`;
    const homePlaceId = `home-${number}`;
    const workPlaceId = `work-${number}`;

    residents[id] = {
      id,
      name: `Resident ${number}`,
      homePlaceId,
      workPlaceId,
      placeId: homePlaceId,
      activity: "home",
      schedule: dailySchedule(homePlaceId, workPlaceId),
    };
  }

  return residents;
}

export function createFoundingState(seed: string): WorldState {
  return WorldStateSchema.parse({
    schemaVersion: 1,
    engineVersion: "founding-1",
    seed,
    canonicalMinute: 0,
    places: foundingPlaces(),
    residents: foundingResidents(),
    construction: {
      id: "founding-district",
      placeId: "founding-district-site",
      stage: "foundation",
      stageSchedule: [
        { stage: "foundation", startMinute: 0 },
        { stage: "frame", startMinute: 1_440 },
        { stage: "enclosure", startMinute: 2_880 },
        { stage: "fitout", startMinute: 4_320 },
        { stage: "complete", startMinute: 5_760 },
      ],
    },
  });
}
