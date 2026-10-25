import type { ResidentActivity, ResidentState } from "@meridian/world-schema";

const MINUTES_PER_DAY = 1_440;

export function activityAt(resident: ResidentState, minute: number): ResidentActivity {
  if (!Number.isFinite(minute) || !Number.isInteger(minute) || minute < 0) {
    throw new RangeError("minute must be a non-negative integer");
  }

  const minuteOfDay = minute % MINUTES_PER_DAY;

  for (let index = resident.schedule.length - 1; index >= 0; index -= 1) {
    const entry = resident.schedule[index];
    if (entry !== undefined && entry.startMinute <= minuteOfDay) return entry.activity;
  }

  throw new RangeError("resident schedule has no applicable activity");
}
