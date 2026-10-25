import { applyLearnerMinute, type LearnerIntake } from './invention-learning.js';
import type { WorldCommand, WorldEvent, WorldState } from "@meridian/world-schema";

import { applyMethodMinute, type MethodIntake } from './invention-method.js';
import { applyScheduledMinute } from "./schedule.js";
import { applyResidentLifeMinute } from "./resident-life.js";
import { applyTransitMinute } from "./transit.js";
import { migrateResidentAppearances as migrateResidentAppearanceProfiles } from "./resident-appearance.js";

export interface TransitionResult {
  state: WorldState;
  events: WorldEvent[];
}

export function advanceWorld(state: WorldState, command: WorldCommand, execution?: { generation: string; methods?: readonly MethodIntake[]; learners?: readonly LearnerIntake[] }): TransitionResult {
  if (command.type === "inspect-resident") return { state, events: [] };

  if (command.targetMinute < state.canonicalMinute) {
    throw new RangeError("clock cannot move backwards");
  }

  if (command.targetMinute === state.canonicalMinute) return { state, events: [] };

  let next = structuredClone(state);
  const events: WorldEvent[] = [];

  for (
    let minute = state.canonicalMinute + 1;
    minute <= command.targetMinute;
    minute += 1
  ) {
    if (next.engineVersion === "city-life-1" || next.engineVersion === "city-life-2") {
      // Next actions wait for their resident to be freed, whichever minute of the advance that is.
      const beforeMinute=next;
      const life = applyResidentLifeMinute(next, minute, minute === state.canonicalMinute + 1 ? command.proposals : undefined, command.nextActions, minute === state.canonicalMinute + 1 ? command.inventionCommands : undefined, execution?.generation);
      next = life.state;
      events.push(...life.events);
      events.push(...applyMethodMinute(beforeMinute,next,minute,minute===state.canonicalMinute+1?execution?.methods:undefined));
      events.push(...applyLearnerMinute(beforeMinute,next,minute,minute===state.canonicalMinute+1?execution?.learners:undefined));
      // Commissioned transit only (absent: unchanged history); after the minute's frontier, before its clock.
      const transit = applyTransitMinute(next, minute, life.events);
      next = transit.state;
      events.push(...transit.events);
    }
    const result = applyScheduledMinute(next, minute);
    next = result.state;
    events.push(...result.events);
  }

  return { state: next, events };
}

/** A zero-minute canonical migration committed by the service before scheduling. */
export function migrateResidentAppearances(state: WorldState): { state: WorldState; event?: WorldEvent } {
  return migrateResidentAppearanceProfiles(state);
}
