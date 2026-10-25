import {
  WorldStateSchema,
  type PlaceState,
  type ResidentState,
  type ScheduleEntry,
  type WorldState,
} from "@meridian/world-schema";

import { createFoundingState } from "./founding-district.js";

const MINUTES_PER_DAY = 1_440;
const TASK_INTERVALS = [20, 30, 40, 60] as const;

// New fictional rehearsal residents, not a recovered historical cast.
const GIVEN_NAMES = ["Ari", "Bea", "Cai", "Dara", "Emi", "Finn", "Gia", "Hale", "Ira", "Juno", "Kit", "Lux", "Mira", "Nico", "Ori", "Pia"] as const;
const FAMILY_NAMES = ["Vale", "Rowan", "Mercer", "Venn", "Solis", "Alder", "North", "Quinn", "Moss", "Reed", "Lane", "Arden", "Stone", "Wren", "Linden", "Ash", "Rivers", "Harlow", "Finch", "Lark", "Dove", "Marsh", "Sage", "Perry", "Hollis", "Wilder", "Aster", "Brook", "Ember", "Hart", "Lowen", "Marlow"] as const;

const OCCUPATIONS = [
  { name: "Gardener", tasks: ["Water the courtyard seedlings", "Prune the terrace fruit trees", "Prepare soil for the next planting", "Collect seeds for the city nursery"] },
  { name: "Baker", tasks: ["Mix dough for the morning loaves", "Shape bread for the market stalls", "Bake the next batch of flatbread", "Prepare tomorrow's starter culture"] },
  { name: "Builder", tasks: ["Check the new district foundations", "Assemble a courtyard archway", "Inspect the workshop masonry", "Prepare materials for the next wall"] },
  { name: "Archivist", tasks: ["Catalogue the district's new records", "Restore a weathered city map", "Index the public reading collection", "Prepare an exhibition of city history"] },
  { name: "Ceramicist", tasks: ["Shape clay vessels at the wheel", "Glaze bowls for the community kitchen", "Check the temperature of the kiln", "Finish tiles for the garden pavilion"] },
  { name: "Transit steward", tasks: ["Inspect the promenade transit stop", "Check the next service timetable", "Prepare the station for arrivals", "Review accessibility along the route"] },
  { name: "Water keeper", tasks: ["Inspect the courtyard water channels", "Check the garden irrigation flow", "Clean the public fountain filters", "Record reservoir supply readings"] },
  { name: "Weaver", tasks: ["Weave cloth for the market awnings", "Repair a community pavilion canopy", "Prepare fibres for the next loom", "Finish banners for Founders Square"] },
  { name: "Cook", tasks: ["Prepare vegetables for the midday meal", "Simmer broth for the community table", "Bake a tray for the evening service", "Plan tomorrow's seasonal menu"] },
  { name: "Instrument maker", tasks: ["Tune a new stringed instrument", "Shape timber for an instrument body", "Repair a musician's worn bridge", "Fit strings for the evening recital"] },
  { name: "Cartographer", tasks: ["Survey paths around the new district", "Update the public promenade map", "Check distances between civic places", "Mark accessible routes through the gardens"] },
  { name: "Market keeper", tasks: ["Arrange seasonal produce at the stall", "Check stock for the afternoon market", "Prepare baskets for the community kitchen", "Record the day's market deliveries"] },
] as const;

function seedNumber(seed: string): number {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return value;
}

function citySchedule(index: number, homePlaceId: string, workPlaceId: string, occupation: typeof OCCUPATIONS[number]): ScheduleEntry[] {
  const interval = TASK_INTERVALS[index % TASK_INTERVALS.length]!;
  const shift = ((index + Math.floor(index / OCCUPATIONS.length)) % 3) * 480;
  const schedule: ScheduleEntry[] = [];
  for (let startMinute = 0; startMinute < MINUTES_PER_DAY; startMinute += interval) {
    const routineMinute = (startMinute + shift) % MINUTES_PER_DAY;
    let activity: ScheduleEntry["activity"] = "home";
    let placeId = homePlaceId;
    let task = "Rest before the next city shift";

    if (routineMinute >= 360 && routineMinute < 420) {
      task = "Prepare breakfast and organise the day";
    } else if (routineMinute >= 420 && routineMinute < 480) {
      activity = "leisure"; placeId = "city-market"; task = "Choose fresh food at the morning market";
    } else if ((routineMinute >= 480 && routineMinute < 720) || (routineMinute >= 780 && routineMinute < 960)) {
      activity = "work"; placeId = workPlaceId;
      task = occupation.tasks[Math.floor(routineMinute / interval) % occupation.tasks.length]!;
    } else if (routineMinute >= 720 && routineMinute < 780) {
      activity = "leisure"; placeId = "city-market"; task = "Take a meal break beside the market";
    } else if (routineMinute >= 960 && routineMinute < 1_080) {
      activity = "leisure"; placeId = "city-garden"; task = "Walk through the public garden terraces";
    } else if (routineMinute >= 1_080 && routineMinute < 1_140) {
      activity = "leisure"; placeId = "city-promenade"; task = "Watch the water from the promenade";
    } else if (routineMinute >= 1_140 && routineMinute < 1_260) {
      activity = "leisure"; placeId = "founders-square"; task = "Listen to the evening music in the square";
    } else if (routineMinute >= 1_260) {
      task = "Read and wind down at home";
    }
    schedule.push({ startMinute, activity, placeId, task });
  }
  return schedule;
}

/** A deterministic local rehearsal fixture; creating it does not start a canonical Genesis run. */
export function createCityState(seed: string, population = 120): WorldState {
  if (!Number.isInteger(population) || population < 1 || population > 512) {
    throw new RangeError("city population must be an integer between 1 and 512");
  }
  const founding = createFoundingState(seed);
  const places: Record<string, PlaceState> = {
    "founders-square": founding.places["founders-square"]!,
    "founding-district-site": founding.places["founding-district-site"]!,
    "city-market": { id: "city-market", name: "Terrace Market", kind: "civic" },
    "city-garden": { id: "city-garden", name: "Public Garden Terraces", kind: "civic" },
    "city-promenade": { id: "city-promenade", name: "Waterside Promenade", kind: "civic" },
  };
  const residents: Record<string, ResidentState> = {};
  const seedOffset = seedNumber(seed);
  for (let index = 0; index < population; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const id = `resident-${suffix}`;
    const homePlaceId = `home-${suffix}`;
    const workPlaceId = `work-${suffix}`;
    const nameIndex = (index + seedOffset) % (GIVEN_NAMES.length * FAMILY_NAMES.length);
    const name = `${GIVEN_NAMES[nameIndex % GIVEN_NAMES.length]} ${FAMILY_NAMES[Math.floor(nameIndex / GIVEN_NAMES.length)]}`;
    const occupation = OCCUPATIONS[(index + seedOffset) % OCCUPATIONS.length]!;
    const schedule = citySchedule(index, homePlaceId, workPlaceId, occupation);
    const initial = schedule[0]!;
    places[homePlaceId] = { id: homePlaceId, name: `${name}'s home`, kind: "residence" };
    places[workPlaceId] = { id: workPlaceId, name: `${occupation.name} workspace ${suffix}`, kind: "workplace" };
    residents[id] = {
      id, name, occupation: occupation.name, homePlaceId, workPlaceId,
      placeId: initial.placeId, activity: initial.activity, schedule,
    };
  }
  return WorldStateSchema.parse({ ...founding, engineVersion: "city-1", places, residents });
}
