export interface WorldTimeInput {
  epochMilliseconds: number;
  nowMilliseconds: number;
  committedMinute: number;
  maxCatchUpMinutes: number;
}

export interface WorldTimePlan {
  elapsedMinute: number;
  targetMinute: number;
  remainingMinutes: number;
  clockBehind: boolean;
}

function requireInteger(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

/** Plans one bounded batch; neither commits history nor establishes an epoch. */
export function planWorldTime(input: WorldTimeInput): WorldTimePlan {
  const { epochMilliseconds, nowMilliseconds, committedMinute, maxCatchUpMinutes } = input;
  requireInteger(epochMilliseconds, 0, "epochMilliseconds");
  requireInteger(nowMilliseconds, 0, "nowMilliseconds");
  requireInteger(committedMinute, 0, "committedMinute");
  requireInteger(maxCatchUpMinutes, 1, "maxCatchUpMinutes");

  // Adapted from recovered Meridian time.ts; exact source/hash in the provenance manifest.
  const elapsedMinute = Math.max(0, Math.floor((nowMilliseconds - epochMilliseconds) / 60_000));
  const backlog = Math.max(0, elapsedMinute - committedMinute);
  // Clamp the increment before addition so a large batch limit cannot overflow.
  const advanceMinutes = Math.min(backlog, maxCatchUpMinutes);

  return {
    elapsedMinute,
    targetMinute: committedMinute + advanceMinutes,
    remainingMinutes: backlog - advanceMinutes,
    clockBehind: nowMilliseconds < epochMilliseconds || elapsedMinute < committedMinute,
  };
}
