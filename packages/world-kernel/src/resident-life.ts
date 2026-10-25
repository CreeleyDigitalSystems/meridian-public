import { planResidentTravel, taskPresenceHolds, advanceResidentTravel } from "./resident-travel.js";
import { expireMethodGrants } from './invention-learning.js';
import { continueResidentAgenda, expireInventionConsultations, pauseResidentAgenda, settleResidentAgendas } from './invention-cognition.js';
import { applyInventionCommand, gateInventionWork, inventionAssociated, inventionDeltas, inventionTemplateUsed, settleInventionWork } from "./invention.js";
import { InventionCommandSchema, type InventionCommand } from "@meridian/world-schema";
import type {
  LifeCommitment, ResidentState, ResidentActionOption, ResidentActionProposal, ResidentActionResolvedEvent,
  ResidentLifeProfile, ResidentMemory, ResidentNextAction, ResidentTask, VentureLedger, WorldEvent, WorldState,
} from "@meridian/world-schema";
import { advanceProjects, abandonProject, proposeProject, respondToInvitation, type ProjectEffect, type ProjectLedger } from "./project-lifecycle.js";
import { applyUpkeep } from "./upkeep.js";
import { chooseSocialVenue } from "./social-venues.js";
import { SURVEY_MINUTES, describeChart, isCartographer, observePlace, surveyTargets } from "./cartography.js";
import { storesCanSupply, supplyFromWork } from "./growth.js";
import { homesToMoveInto, moveHome } from "./frontier.js";
import { FRONTIER_BUILDS, FRONTIER_HELP_EFFORT, FRONTIER_LEAD_EFFORT, FRONTIER_TASK_MINUTES, FRONTIER_WORK_PLACE_ID, applyBuildWork, applyFrontierWork, frontierBuildLabel, frontierDirection, frontierParcelName, startFrontierBuild } from "./frontier.js";
import { frontierMenu, frontierShiftTask, keepFrontierShift, frontierReturnTask, keepFrontierReturn } from "./frontier-access.js";
import type { FrontierBuildKind, TransitJourney } from "@meridian/world-schema";
import { keepTransitJourney, planTransitJourney, transitJourneyRideRuns } from "./transit-journey.js";

type JourneyPlanner = (residentId: string, placeId: string) => TransitJourney | null | undefined;
/**
 * Journeys policy 1, for a menu: within one unchanging state and minute a crossing depends only on where the
 * traveller stands and where they go, so each pair of places is planned once (many partners stand at one place).
 * Read-only use: journeys a task saves are planned afresh in `start`.
 */
function menuJourneys(state: WorldState, minute: number): JourneyPlanner {
  const planned = new Map<string, TransitJourney | null | undefined>();
  return (residentId, placeId) => {
    const key = JSON.stringify([state.residents[residentId]?.placeId ?? null, placeId]);
    if (!planned.has(key)) planned.set(key, planTransitJourney(state, residentId, placeId, minute));
    return planned.get(key);
  };
}

/**
 * Journeys policy 1 (commissioned transit only): where a pair would meet and each one's crossing there (null:
 * none needed). Undefined when no venue is lawfully reachable by both.
 */
function transitMeeting(state: WorldState, residentId: string, partnerId: string, minute: number, plan: JourneyPlanner = (id, placeId) => planTransitJourney(state, id, placeId, minute)): { venue: string; mine: TransitJourney | null; theirs: TransitJourney | null } | undefined {
  const both = (placeId: string) => plan(residentId, placeId) !== undefined && plan(partnerId, placeId) !== undefined;
  const venue = chooseSocialVenue(state, residentId, partnerId, minute, both);
  const mine = plan(residentId, venue), theirs = plan(partnerId, venue);
  return mine === undefined || theirs === undefined ? undefined : { venue, mine, theirs };
}
/** Minutes a saved journey adds before a task's own time begins (none without one). */
const journeyMinutes = (journey: TransitJourney | null, minute: number) => journey ? journey.arrivesMinute - minute : 0;
import { applyWardrobeChoice, legalWardrobeChoice, parseWardrobeOptionId, wardrobeChoiceAllowed, wardrobeMenu, wardrobeOptionId, wardrobeOptionLabel, type WardrobeChoice } from "./wardrobe.js";

/**
 * Venture templates for city-life-2: what a resident may propose. Bounded and
 * deterministic; the consequence is applied through existing committed state
 * (garden progress), which the city already renders.
 */
export const VENTURE_TEMPLATES = [{
  id: "garden-beds", label: "Renew the garden beds", placeId: "city-garden",
  steps: [
    { id: "clear", label: "Clear the old beds", durationMinutes: 6, requires: [{ resourceId: "stone", quantity: 2 }] },
    { id: "plant", label: "Plant the new beds", durationMinutes: 6, requires: [{ resourceId: "timber", quantity: 2 }] },
  ],
  consentMinutes: 24, deadlineMinutes: 120, consequence: { projectId: "public-garden", progress: 20 },
}, {
  // Civic improvements: open to any rested resident, one open venture per template, then a cooldown.
  id: "square-benches", label: "Build a bench in Founders Square", placeId: "founders-square",
  steps: [
    { id: "shape", label: "Shape the bench stone", durationMinutes: 6, requires: [{ resourceId: "stone", quantity: 2 }] },
    { id: "set", label: "Set the bench in the square", durationMinutes: 4, requires: [] },
  ],
  consentMinutes: 24, deadlineMinutes: 120, consequence: { projectId: "square-benches", progress: 25 }, cooldownMinutes: 90,
}, {
  id: "promenade-lanterns", label: "Hang a lantern on the promenade", placeId: "city-promenade",
  steps: [
    { id: "post", label: "Raise a timber lantern post", durationMinutes: 6, requires: [{ resourceId: "timber", quantity: 1 }] },
    { id: "light", label: "Hang and light the lantern", durationMinutes: 4, requires: [] },
  ],
  consentMinutes: 24, deadlineMinutes: 120, consequence: { projectId: "promenade-lanterns", progress: 20 }, cooldownMinutes: 90,
}, {
  id: "market-planters", label: "Plant a planter at the Terrace Market", placeId: "city-market",
  steps: [
    { id: "box", label: "Lay a stone planter box", durationMinutes: 5, requires: [{ resourceId: "stone", quantity: 1 }] },
    { id: "plant", label: "Fill and plant the planter", durationMinutes: 5, requires: [] },
  ],
  consentMinutes: 24, deadlineMinutes: 120, consequence: { projectId: "market-planters", progress: 20 }, cooldownMinutes: 90,
}, {
  id: "public-map-boards", label: "Put up a public map board", placeId: "founders-square",
  steps: [
    { id: "frame", label: "Build the map board frame", durationMinutes: 6, requires: [{ resourceId: "timber", quantity: 2 }] },
    { id: "draw", label: "Draw the city map on the board", durationMinutes: 8, requires: [] },
  ],
  consentMinutes: 24, deadlineMinutes: 120, consequence: { projectId: "public-map-boards", progress: 50 }, cooldownMinutes: 90,
}] as const;
const MAX_OPEN_VENTURES_FOR_PROPOSALS = 2;
const templateOf = (ventureId: string) => VENTURE_TEMPLATES.find((t) => ventureId.endsWith(`:${t.id}`));
/** An open venture of this template, or one that ended within the cooldown, holds the template back. */
function templateRecentlyUsed(ventures: VentureLedger, templateId: string, minute: number, cooldownMinutes: number): boolean {
  const suffix = `:${templateId}`;
  if (Object.keys(ventures.projects).some((id) => id.endsWith(suffix))) return true;
  return ventures.retired.some((venture) => venture.id.endsWith(suffix) && venture.outcome !== null && minute - venture.outcome.minute < cooldownMinutes);
}

/** Children live at home with their family: no work, ventures, projects or charts. */
export const CHILD_TASK_LABELS: readonly string[] = Object.freeze(["Playing with blocks", "Story time", "Nap", "Drawing", "Dinner with family"]);
const CHILD_TASK_BLOCK_MINUTES = 12;
export const isChild = (resident: ResidentState): boolean => resident.lifeStage === "child";
const childTaskLabel = (minute: number): string => CHILD_TASK_LABELS[Math.floor(minute / CHILD_TASK_BLOCK_MINUTES) % CHILD_TASK_LABELS.length]!;
const CHILD_HOME_GAIN = 2;
const CHILD_PARENT_GAIN = 4;
/** Per-minute social/purpose gain for a child at home; larger when an adult of the same home is in the same place. */
const childHomeGain = (state: WorldState, id: string): number => {
  const child = state.residents[id]!;
  const parentHome = Object.keys(state.residents).some((otherId) => {
    const other = state.residents[otherId]!;
    return otherId !== id && !isChild(other) && other.homePlaceId === child.homePlaceId && other.placeId === child.placeId;
  });
  return parentHome ? CHILD_PARENT_GAIN : CHILD_HOME_GAIN;
};
/** Is this resident a child in the current state? Unknown ids are not children. */
const childIn = (state: WorldState, id: string): boolean => Object.hasOwn(state.residents, id) && isChild(state.residents[id]!);

const activeStatuses = new Set(["pending", "meeting", "loaned", "returning"]);
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const sorted = <T>(record: Record<string, T>) => Object.keys(record).sort().map((id) => record[id]!);
const own = <T>(record: Record<string, T>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined;
const wardrobeOption = (choice: WardrobeChoice): ResidentActionOption => ({ id: wardrobeOptionId(choice), kind: "choose-appearance", label: wardrobeOptionLabel(choice) });
/**
 * The resident's own legal wardrobe choice by id, whether or not the menu's rail shows it now, so a choice
 * planned while busy survives the rail turning. Never while a task is under way, like every other choice.
 */
function wardrobeOptionById(state: WorldState, residentId: string, optionId: string): ResidentActionOption | undefined {
  const profile = state.life ? own(state.life.residents, residentId) : undefined;
  if (!profile || profile.task) return undefined;
  const choice = legalWardrobeChoice(state, residentId, optionId);
  return choice ? wardrobeOption(choice) : undefined;
}

/** A fresh, canonical menu. No free-form mutations or invented history are accepted. */
export function getResidentActionOptions(state: WorldState, residentId: string): ResidentActionOption[] {
  const life = state.life;
  const profile = life ? own(life.residents, residentId) : undefined;
  if (!life || !profile || !Object.hasOwn(state.residents, residentId) || profile.task) return [];
  // The resident's own wardrobe (only once opened): a bounded rotating rail, always after every ordinary
  // choice, so a truncated menu drops wardrobe choices first and worlds without a wardrobe keep their exact menus.
  const wardrobe: ResidentActionOption[] = wardrobeMenu(state, residentId).map(wardrobeOption);
  // A child's only legal task is a home task; the label comes from the fixed child set at start.
  // Their wardrobe holds only age-appropriate clothing.
  if (isChild(state.residents[residentId]!)) return [{ id: "rest", kind: "rest", label: "Rest and recover energy" }, ...wardrobe];
  const options: ResidentActionOption[] = [{ id: "rest", kind: "rest", label: "Rest and recover energy" }, { id: "think", kind: "rest", label: "Think and reflect without moving" }];
  // Journeys policy 1: a place across the water is offered only when a lawful crossing there exists (always true without transit).
  const plan = menuJourneys(state, state.canonicalMinute + 1);
  const reachable = (placeId: string) => plan(residentId, placeId) !== undefined;
  if (profile.needs.energy >= 20 && profile.skills.work > 0 && reachable(state.residents[residentId]!.workPlaceId)) options.push({ id: "work", kind: "work", label: `Do ${profile.skills.occupation.toLowerCase()} work` });
  for (const commitment of sorted(life.commitments)) {
    if (commitment.lenderId === residentId && commitment.status === "pending" && commitment.expiresMinute > state.canonicalMinute + 1) {
      const fields = { partnerId: commitment.requesterId, resourceId: commitment.resourceId, projectId: commitment.projectId, commitmentId: commitment.id };
      options.push({ id: `decline:${commitment.id}`, kind: "decline-request", label: "Decline the tool request", ...fields });
      if (profile.needs.energy >= 15 && life.residents[commitment.requesterId]?.task?.commitmentId === commitment.id && life.resources[commitment.resourceId]?.ownerId === residentId) options.push({ id: `accept:${commitment.id}`, kind: "accept-request", label: "Meet to lend the garden tools", ...fields });
    }
    if (commitment.requesterId === residentId && commitment.status === "loaned" && life.resources[commitment.resourceId]?.ownerId === residentId && !life.residents[commitment.lenderId]?.task && profile.needs.energy >= 10 && life.residents[commitment.lenderId]!.needs.energy >= 10) {
      options.push({ id: `return:${commitment.id}`, kind: "return-tool", label: "Meet to return the borrowed tools", partnerId: commitment.lenderId, resourceId: commitment.resourceId, projectId: commitment.projectId, commitmentId: commitment.id });
    }
  }
  if (profile.needs.energy >= 20 && profile.skills.gardening >= 40) {
    // Garden tools tend gardens only; civic improvements advance through their own ventures.
    for (const project of sorted(life.projects).filter((p) => p.kind === "garden" && p.progress < 100)) {
      for (const resource of sorted(life.resources)) {
        if (resource.ownerId === residentId) options.push({ id: `use:${resource.id}:${project.id}`, kind: "use-tool", label: "Tend the public garden with tools", resourceId: resource.id, projectId: project.id });
        else if (!sorted(life.commitments).some((c) => c.resourceId === resource.id && activeStatuses.has(c.status))) options.push({ id: `request:${resource.id}:${project.id}`, kind: "request-tool", label: "Ask to borrow garden tools", partnerId: resource.ownerId, resourceId: resource.id, projectId: project.id });
      }
    }
  }
  // Frontier access policy 1 narrows these to worksites this resident can actually reach; without it, the legacy menu.
  const frontier = frontierMenu(state, residentId);
  if (profile.needs.energy >= 20 && isCartographer(profile)) {
    for (const placeId of surveyTargets(state, residentId)) {
      options.push({ id: `survey:${placeId}`, kind: "survey", label: `Survey ${state.places[placeId]!.name}`.slice(0, 160), placeId });
    }
    // Beyond the city (D-8): push the fog back at the edge.
    if (Object.hasOwn(state.places, FRONTIER_WORK_PLACE_ID)) {
      for (const parcel of frontier.chartTargets()) options.push({ id: `chart-frontier:${parcel.id}`, kind: "chart-frontier", label: `Chart ${frontierParcelName(parcel)}`, parcelId: parcel.id });
    }
  }
  // Anyone may choose to help a cartographer who is out at the edge right now (R-3: by their own choice).
  if (profile.needs.energy >= 30 && Object.hasOwn(state.places, FRONTIER_WORK_PLACE_ID)) {
    const parcel = frontier.helpTargets().find((p) => !(isCartographer(profile) && frontier.chartTargets().some((t) => t.id === p.id)));
    if (parcel) options.push({ id: `help-chart:${parcel.id}`, kind: "help-chart", label: `Help chart ${frontierParcelName(parcel)}`, parcelId: parcel.id });
    // Building on charted ground (D-8): found something from the catalogue, or take a shift on a build.
    for (const { parcel: ground, spec } of frontier.foundingOptions()) {
      options.push({ id: `found:${spec.kind}:${ground.id}`, kind: "found-place", label: `Found a ${spec.label} on the charted ground to the ${frontierDirection(ground)} (ring ${ground.ring})`, parcelId: ground.id });
    }
    for (const home of homesToMoveInto(state, residentId)) {
      if (!reachable(home.placeId)) continue;
      options.push({ id: `move-home:${home.placeId}`, kind: "move-home", label: `Move into the new home to the ${frontierDirection(home.parcel)} (ring ${home.parcel.ring}, plot ${home.parcel.slot + 1})`, placeId: home.placeId, parcelId: home.parcel.id });
      if (options.filter((o) => o.kind === "move-home").length >= 2) break;
    }
    const site = frontier.buildSite();
    if (site) options.push({ id: `build:${site.id}`, kind: "build", label: `Build the ${frontierBuildLabel(site.build!.kind)} to the ${frontierDirection(site)} (ring ${site.ring})`, parcelId: site.id });
  }
  if (profile.needs.energy >= 10) {
    const partner = sorted(life.residents).find((other) => other.residentId !== residentId && !childIn(state, other.residentId) && !other.task && other.needs.energy >= 10
      && (!life.transit || transitMeeting(state, residentId, other.residentId, state.canonicalMinute + 1, plan) !== undefined));
    if (partner) options.push({ id: `socialise:${partner.residentId}`, kind: "socialise", label: "Spend time together", partnerId: partner.residentId });
  }
  if (life.ventures) {
    const open = sorted(life.ventures.projects);
    for (const venture of open) {
      const me = venture.participants.find((p) => p.residentId === residentId);
      if (me?.consent !== "invited" || state.canonicalMinute + 1 >= venture.consentDeadlineMinute) continue;
      options.push({ id: `venture-join:${venture.id}`, kind: "join-venture", label: `Join: ${venture.label}`, partnerId: venture.proposerId, ventureId: venture.id });
      options.push({ id: `venture-decline:${venture.id}`, kind: "decline-venture", label: `Decline: ${venture.label}`, partnerId: venture.proposerId, ventureId: venture.id });
    }
    const proposing = open.some((v) => v.proposerId === residentId);
    if (!proposing && open.length < MAX_OPEN_VENTURES_FOR_PROPOSALS && profile.needs.energy >= 30) {
      for (const template of VENTURE_TEMPLATES) {
        const project = own(life.projects, template.consequence.projectId);
        if (!Object.hasOwn(state.places, template.placeId) || !project || project.progress >= 100) continue;
        // Nobody starts building without the materials to finish: that launched ~250 doomed ventures a day.
        if (!storesCanSupply(life, template.steps)) continue;
        // The original garden venture keeps its purpose gate; civic improvements use a per-template cooldown instead.
        if (!("cooldownMinutes" in template)) { if (profile.needs.purpose >= 70 || inventionTemplateUsed(state, template.id, state.canonicalMinute, 0)) continue; }
        else if (templateRecentlyUsed(life.ventures, template.id, state.canonicalMinute, template.cooldownMinutes) || inventionTemplateUsed(state, template.id, state.canonicalMinute, template.cooldownMinutes)) continue;
        options.push({ id: `venture-propose:${template.id}`, kind: "propose-venture", label: `Propose: ${template.label}` });
      }
    }
  }
  return [...options.filter(option => {
    if (!life.transit) return true;
    const destination = option.placeId ?? (option.kind === "use-tool" ? life.projects[option.projectId!]?.placeId : option.kind === "request-tool" ? "founders-square" : option.kind === "accept-request" || option.kind === "return-tool" ? life.commitments[option.commitmentId!]?.placeId : option.kind === "join-venture" ? life.ventures?.projects[option.ventureId!]?.placeId : option.kind === "propose-venture" ? VENTURE_TEMPLATES.find(t => option.id === `venture-propose:${t.id}`)?.placeId : undefined);
    if(destination && planResidentTravel(state,residentId,destination,state.canonicalMinute+1)===undefined) return false;
    if((option.kind==="accept-request" || option.kind==="return-tool") && option.partnerId && destination && planResidentTravel(state,option.partnerId,destination,state.canonicalMinute+1)===undefined)return false;
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id)), ...wardrobe];
}

function remember(profile: ResidentLifeProfile, memory: ResidentMemory): void {
  profile.memories = [...profile.memories, memory].slice(-12);
}
function trust(profile: ResidentLifeProfile, partnerId: string, delta: number): void {
  profile.trust[partnerId] = Math.max(-100, Math.min(100, (own(profile.trust, partnerId) ?? 0) + delta));
}

/** Engine choice among proposals: the least-progressed consequence first, then option id. Deterministic. */
function leastProgressedProposal(state: WorldState, options: ResidentActionOption[]): ResidentActionOption | undefined {
  const progressOf = (option: ResidentActionOption) => {
    const template = VENTURE_TEMPLATES.find((t) => option.id === `venture-propose:${t.id}`);
    return template ? own(state.life!.projects, template.consequence.projectId)?.progress ?? 100 : 100;
  };
  return options.filter((option) => option.kind === "propose-venture").sort((a, b) => progressOf(a) - progressOf(b) || a.id.localeCompare(b.id))[0];
}

function utility(state: WorldState, residentId: string, options: ResidentActionOption[]): ResidentActionOption | undefined {
  const profile = state.life!.residents[residentId]!;
  const byKind = (kind: ResidentActionOption["kind"]) => options.find((o) => o.kind === kind);
  if (profile.needs.energy < 30) return byKind("decline-request") ?? byKind("rest");
  const accept = byKind("accept-request");
  if (accept) return (own(profile.trust, accept.partnerId!) ?? 0) < -10 ? byKind("decline-request") : accept;
  const last = profile.memories.at(-1);
  if (byKind("return-tool") && (last?.outcome === "garden-tended" || state.life!.projects["public-garden"]!.progress >= 100)) return byKind("return-tool");
  if (byKind("use-tool")) return byKind("use-tool");
  if (byKind("request-tool") && !(last && ["request-declined", "request-expired", "interrupted"].includes(last.outcome) && state.canonicalMinute - last.minute < 30)) return byKind("request-tool");
  const join = byKind("join-venture");
  if (join) return (own(profile.trust, join.partnerId!) ?? 0) < -10 ? byKind("decline-venture") : join;
  // A builder with time on their hands founds what the frontier has least of; others may take shifts.
  if (profile.needs.purpose < 60 && byKind("found-place")) {
    const standing = Object.values(state.life!.frontier ?? {}).map((p) => p.build?.kind ?? p.builtKind);
    const count = (kind: string) => standing.filter((k) => k === kind).length;
    const founding = options.filter((o) => o.kind === "found-place").sort((a, b) => count(a.id.split(":")[1]!) - count(b.id.split(":")[1]!) || a.id.localeCompare(b.id));
    return founding[0];
  }
  if (profile.needs.purpose < 55 && profile.needs.social >= 45 && byKind("build")) return byKind("build");
  // An engine-driven resident moves only into a home they helped build.
  const ownHome = options.find((o) => o.kind === "move-home" && state.life!.frontier?.[o.parcelId!]?.builtBy?.includes(residentId));
  if (ownHome) return ownHome;
  // Helping at the edge is a choice for the restless, not a pull that empties the city.
  if (profile.needs.purpose < 40 && profile.needs.social >= 45 && byKind("help-chart")) return byKind("help-chart");
  if (profile.needs.purpose < 50 && byKind("propose-venture") && !(last && last.outcome === "venture-failed" && state.canonicalMinute - last.minute < 60)) return leastProgressedProposal(state, options);
  if (profile.needs.social < 45 && byKind("socialise")) return byKind("socialise");
  // Cartographers alternate between the frontier and the city chart, so neither is abandoned.
  const atEdgeLast = last !== undefined && (last.outcome === "frontier-surveyed" || last.outcome === "frontier-charted");
  const mapping = atEdgeLast ? byKind("survey") ?? byKind("chart-frontier") : byKind("chart-frontier") ?? byKind("survey");
  return profile.needs.purpose < 80 ? mapping ?? byKind("work") ?? byKind("rest") : byKind("rest");
}

/** Life owns resident activity/location; the historical scheduler still owns construction. */
export function applyResidentLifeMinute(input: WorldState, minute: number, proposals: ResidentActionProposal[] = [], nextActions: readonly ResidentNextAction[] = [], inventionCommands: readonly InventionCommand[] = [], generation?: string): { state: WorldState; events: WorldEvent[] } {
  if (!input.life) return { state: input, events: [] };
  const state: WorldState = { ...input, residents: { ...input.residents }, life: structuredClone(input.life) };
  const life = state.life!;
  // Finished work wears first, so the whole minute — including the options residents choose from —
  // sees the worn city. The project diff at the end of the minute reports it.
  applyUpkeep(life, minute);
  const events: WorldEvent[] = [];
  const handled = new Set<string>();
  const frozen = new Set<string>();
  const commands = [...proposals, ...inventionCommands];
  const reserved = new Set(commands.map((proposal) => proposal.residentId));
  const duplicate = new Set(commands.filter((p, i) => commands.findIndex((other) => other.residentId === p.residentId) !== i).map((p) => p.residentId));
  for (const proposal of proposals) {
    // The same legality as the proposal check below: a legal wardrobe choice off the current rail is legal here too.
    if (duplicate.has(proposal.residentId) || proposal.observedMinute !== input.canonicalMinute || !(getResidentActionOptions(input, proposal.residentId).some((o) => o.id === proposal.optionId) || wardrobeOptionById(input, proposal.residentId, proposal.optionId))) frozen.add(proposal.residentId);
  }
  const resolution = (proposal: ResidentActionProposal, reason: ResidentActionResolvedEvent["reason"]) => {
    events.push({ type: "resident-action-resolved", minute, residentId: proposal.residentId, optionId: proposal.optionId, source: proposal.source, outcome: reason === "legal-option" ? "accepted" : "rejected", reason });
  };
  const locate = (residentId: string, placeId: string, activity: "work" | "home" | "leisure") => {
    state.residents[residentId] = { ...state.residents[residentId]!, placeId, activity };
  };
  const task = (residentId: string, kind: ResidentTask["kind"], label: string, duration: number, placeId: string, decisionSource: ResidentActionProposal["source"], fields: Partial<ResidentTask> = {}) => {
    const travel = !fields.journey && !fields.walk && life.transit ? planResidentTravel(state,residentId,placeId,minute) : {minutes:0};
    if (!travel) return false;
    const {minutes, ...legs} = travel;
    life.residents[residentId]!.task = { kind, label, startedMinute: minute, endsMinute: minute + duration + minutes, placeId, ...legs, ...fields, decisionSource };
    // A journey across the water sets out from where the resident stands; they take up the place on arrival.
    locate(residentId, fields.journey?.fromPlaceId ?? fields.walk?.fromPlaceId ?? travel.journey?.fromPlaceId ?? travel.walk?.fromPlaceId ?? placeId, kind === "rest" ? "home" : ["work", "use-tool", "survey", "chart-frontier", "help-chart", "build"].includes(kind) ? "work" : "leisure");
    handled.add(residentId);
    return true;
  };
  const mutual = (a: string, b: string, outcome: ResidentMemory["outcome"], fact: string, delta: number, resourceId?: string) => {
    for (const [id, partnerId] of [[a, b], [b, a]] as const) {
      remember(life.residents[id]!, { minute, outcome, fact, partnerId, ...(resourceId ? { resourceId } : {}) });
      trust(life.residents[id]!, partnerId, delta);
      handled.add(id);
    }
  };
  const failCommitment = (commitment: LifeCommitment, status: "declined" | "expired" | "interrupted") => {
    // Interruption of a return never cancels the existing loan or strands its ownership.
    commitment.status = status === "interrupted" && commitment.status === "returning" ? "loaned" : status;
    for (const id of [commitment.requesterId, commitment.lenderId]) {
      if (life.residents[id]!.task?.commitmentId === commitment.id) life.residents[id]!.task = null;
    }
    mutual(commitment.requesterId, commitment.lenderId, status === "declined" ? "request-declined" : status === "expired" ? "request-expired" : "interrupted", status === "declined" ? "The lender declined the garden-tool request." : status === "expired" ? "The garden-tool request expired without a handover." : "The tool meeting was interrupted before transfer.", status === "declined" ? -1 : -2, commitment.resourceId);
  };
  /**
   * A frontier shift: under frontier access policy 1, the planned walk to its worksite (undefined if unreachable),
   * assigned with `shift`; before the policy, the accepted promenade shift.
   */
  const planShift = (residentId: string, kind: "chart-frontier" | "help-chart" | "build", label: string, parcelId: string, source: ResidentActionProposal["source"]): ResidentTask | null | undefined =>
    life.frontierAccess ? frontierShiftTask(state, residentId, kind, label, parcelId, minute, source) : null;
  const shift = (residentId: string, planned: ResidentTask | null, kind: "chart-frontier" | "help-chart" | "build", label: string, parcelId: string, source: ResidentActionProposal["source"]) => {
    if (!planned) { task(residentId, kind, label, FRONTIER_TASK_MINUTES, FRONTIER_WORK_PLACE_ID, source, { parcelId }); return; }
    // The resident sets out from where they are: their place changes only when they arrive.
    life.residents[residentId]!.task = planned;
    state.residents[residentId] = { ...state.residents[residentId]!, activity: "work" };
    handled.add(residentId);
  };
  const start = (residentId: string, option: ResidentActionOption, source: ResidentActionProposal["source"] = "engine"): boolean => {
    if (!Object.hasOwn(life.residents, residentId) || !Object.hasOwn(state.residents, residentId)) return false;
    if ((option.partnerId && !Object.hasOwn(life.residents, option.partnerId)) || (option.resourceId && !Object.hasOwn(life.resources, option.resourceId)) || (option.projectId && !Object.hasOwn(life.projects, option.projectId)) || (option.commitmentId && !Object.hasOwn(life.commitments, option.commitmentId))) return false;
    if (option.partnerId && frozen.has(option.partnerId)) return false;
    if (option.partnerId && ["socialise", "accept-request", "decline-request", "return-tool"].includes(option.kind) && reserved.has(option.partnerId)) return false;
    const resident = state.residents[residentId]!;
    const profile = life.residents[residentId]!;
    switch (option.kind) {
      case "rest":
        if (isChild(resident)) task(residentId, "rest", childTaskLabel(minute), CHILD_TASK_BLOCK_MINUTES, resident.homePlaceId, source);
        else if (option.id === "think") task(residentId, "rest", "Think and reflect", 1, resident.placeId, source);
        else {
          // Journeys policy 1: home across the water is reached on the circuit; with no lawful crossing, rest here.
          const journey = planTransitJourney(state, residentId, resident.homePlaceId, minute);
          if (journey === undefined) task(residentId, "rest", "Recover energy away from home", 8, resident.placeId, source);
          else task(residentId, "rest", "Recover energy at home", 8 + journeyMinutes(journey, minute), resident.homePlaceId, source, journey ? { journey } : {});
        }
        break;
      case "work": {
        const journey = planTransitJourney(state, residentId, resident.workPlaceId, minute);
        if (journey === undefined) return false;
        task(residentId, "work", option.label, 10 + journeyMinutes(journey, minute), resident.workPlaceId, source, journey ? { journey } : {}); break;
      }
      case "survey": if (!task(residentId, "survey", option.label, SURVEY_MINUTES, option.placeId!, source)) return false; break;
      case "chart-frontier":
      case "help-chart": {
        if (life.frontier?.[option.parcelId!]?.state !== "fog") return false;
        const planned = planShift(residentId, option.kind, option.label, option.parcelId!, source);
        if (planned === undefined) return false;
        shift(residentId, planned, option.kind, option.label, option.parcelId!, source); break;
      }
      case "found-place": {
        const kind = option.id.split(":")[1] as FrontierBuildKind;
        // Plan the walk before paying: nothing is bought for a site the founder cannot reach.
        const planned = planShift(residentId, "build", option.label, option.parcelId!, source);
        if (planned === undefined || !startFrontierBuild(life, option.parcelId!, kind, residentId, minute)) return false;
        remember(profile, { minute, outcome: "build-started", fact: `Founded a ${frontierBuildLabel(kind)} on charted ground beyond the city and paid its materials from the stores.`, parcelId: option.parcelId! });
        shift(residentId, planned, "build", option.label, option.parcelId!, source); break;
      }
      case "move-home": {
        // Journeys policy 1: the new home beyond the water is reached on the circuit, never by relocation.
        const journey = planTransitJourney(state, residentId, option.placeId!, minute);
        if (journey === undefined || !moveHome(state, residentId, option.placeId!)) return false;
        remember(profile, { minute, outcome: "moved-home", fact: `Moved into a new home on the frontier, beyond the city's water.`, placeId: option.placeId!, parcelId: option.parcelId! });
        task(residentId, "rest", "Settle into the new home", 8 + journeyMinutes(journey, minute), option.placeId!, source, journey ? { journey } : {}); break;
      }
      case "build": {
        if (!life.frontier?.[option.parcelId!]?.build) return false;
        const planned = planShift(residentId, "build", option.label, option.parcelId!, source);
        if (planned === undefined) return false;
        shift(residentId, planned, "build", option.label, option.parcelId!, source); break;
      }
      case "socialise": {
        const partnerId = option.partnerId!;
        if (life.residents[partnerId]!.task) return false;
        // Leave travel time and a readable encounter in the accelerated rehearsal.
        // The venue is chosen here, not in the menu, so the option id stays stable for proposals.
        // Journeys policy 1: a venue across the water is reached on the circuit, and the pair's meeting begins once
        // both are there, so their tasks still end together. Without transit this is exactly the venue and 16 minutes.
        const meeting = life.transit ? transitMeeting(state, residentId, partnerId, minute) : { venue: chooseSocialVenue(state, residentId, partnerId, minute), mine: null, theirs: null };
        if (!meeting) return false;
        const mine=planResidentTravel(state,residentId,meeting.venue,minute), theirs=planResidentTravel(state,partnerId,meeting.venue,minute);
        if(!mine || !theirs)return false;
        const together=16+Math.max(mine.minutes,theirs.minutes);
        const {minutes:_,...mineLegs}=mine,{minutes:__,...theirLegs}=theirs;
        task(residentId,"socialise",option.label,together-mine.minutes,meeting.venue,source,{partnerId,...mineLegs});
        task(partnerId,"socialise",option.label,together-theirs.minutes,meeting.venue,source,{partnerId:residentId,...theirLegs});
        // Explicit legs have already been included in the common end; zero-distance partners remain at the venue.
        life.residents[residentId]!.task!.endsMinute=minute+together;
        life.residents[partnerId]!.task!.endsMinute=minute+together;
        break;
      }
      case "request-tool": {
        const id = `request:${minute}:${residentId}:${option.resourceId}`;
        const commitment: LifeCommitment = { id, requesterId: residentId, lenderId: option.partnerId!, resourceId: option.resourceId!, projectId: option.projectId!, placeId: "founders-square", status: "pending", createdMinute: minute, expiresMinute: minute + 24 };
        life.commitments[id] = commitment;
        task(residentId, "wait-tool", "Wait for a reply to the tool request", 24, "founders-square", source, { partnerId: commitment.lenderId, resourceId: commitment.resourceId, projectId: commitment.projectId, commitmentId: id, blocker: "Waiting for the lender to accept or decline" }); break;
      }
      case "decline-request": failCommitment(life.commitments[option.commitmentId!]!, "declined"); break;
      case "accept-request":
      case "return-tool": {
        const commitment = life.commitments[option.commitmentId!]!;
        const returning = option.kind === "return-tool";
        const pair=[commitment.requesterId,commitment.lenderId] as const;
        const routes=pair.map(id=>planResidentTravel(state,id,commitment.placeId,minute));
        if(routes.some(r=>!r))return false;
        const end=minute+16+Math.max(...routes.map(r=>r!.minutes));
        commitment.status = returning ? "returning" : "meeting";
        for(const [index,id] of pair.entries()) {
          const {minutes:_,...legs}=routes[index]!;
          task(id,returning?"return-tool":"handover",returning?"Meet to return the garden tools":"Meet to hand over the garden tools",end-minute,commitment.placeId,source,{partnerId:pair[1-index],resourceId:commitment.resourceId,commitmentId:commitment.id,...legs});
          life.residents[id]!.task!.endsMinute=end;
        }
        break;
      }
      case "use-tool": task(residentId, "use-tool", option.label, 6, life.projects[option.projectId!]!.placeId, source, { resourceId: option.resourceId!, projectId: option.projectId!, progress: 0 }); break;
      case "propose-venture": {
        const template = VENTURE_TEMPLATES.find((t) => option.id === `venture-propose:${t.id}`);
        if (!template || !life.ventures) return false;
        const invitee = sorted(life.residents).find((other) => other.residentId !== residentId && !childIn(state, other.residentId) && !other.task && other.needs.energy >= 20 && !frozen.has(other.residentId))?.residentId;
        const ventureId = `venture:${minute}:${residentId}:${template.id}`;
        const proposed = proposeProject(life.ventures as ProjectLedger, {
          id: ventureId, label: template.label, placeId: template.placeId, proposerId: residentId, invitees: invitee ? [invitee] : [],
          steps: template.steps.map((st) => ({ id: st.id, label: st.label, durationMinutes: st.durationMinutes, requires: st.requires.map((r) => ({ ...r })) })),
          consentDeadlineMinute: minute + template.consentMinutes, deadlineMinute: minute + template.deadlineMinutes,
        }, minute);
        if (!proposed.ok) return false;
        life.ventures = proposed.value as VentureLedger;
        task(residentId, "venture-work", `Plan: ${template.label}`, 4, template.placeId, source, { ventureId });
        remember(profile, { minute, outcome: "venture-proposed", fact: invitee ? `Proposed to ${template.label.toLowerCase()} and invited a neighbour.` : `Proposed to ${template.label.toLowerCase()}.`, ventureId, ...(invitee ? { partnerId: invitee } : {}) });
        break;
      }
      case "join-venture":
      case "decline-venture": {
        if (!life.ventures || !option.ventureId) return false;
        const venture = own(life.ventures.projects, option.ventureId);
        if (!venture) return false;
        const answered = respondToInvitation(life.ventures as ProjectLedger, option.ventureId, residentId, option.kind === "join-venture" ? "accepted" : "declined", minute);
        if (!answered.ok) return false;
        life.ventures = answered.value.ledger as VentureLedger;
        if (option.kind === "join-venture") {
          remember(profile, { minute, outcome: "venture-joined", fact: `Agreed to help ${venture.label.toLowerCase()}.`, partnerId: venture.proposerId, ventureId: venture.id });
          trust(profile, venture.proposerId, 2);
          task(residentId, "venture-work", `Agreed to help: ${venture.label}`, 2, venture.placeId, source, { ventureId: venture.id, partnerId: venture.proposerId });
        } else {
          remember(profile, { minute, outcome: "venture-declined", fact: `Declined to join ${venture.label.toLowerCase()}.`, partnerId: venture.proposerId, ventureId: venture.id });
          handled.add(residentId);
        }
        applyVentureEffects(answered.value.effects);
        break;
      }
      case "choose-appearance": {
        // Consent over one's own body: only the resident's own model decision, only their own profile.
        const choice = parseWardrobeOptionId(option.id);
        if (source !== "local-model" || !choice || !profile.appearance || !wardrobeChoiceAllowed(choice, isChild(resident))) return false;
        profile.appearance = applyWardrobeChoice(profile.appearance, choice, minute);
        break;
      }
    }
    handled.add(profile.residentId);
    return true;
  };

  /** Venture ledger effects → tasks, memories, trust and the visible consequence. Deterministic; no narrative. */
  const applyVentureEffects = (effects: readonly ProjectEffect[]) => {
    const ventures = life.ventures!;
    const recordOf = (id: string) => own(ventures.projects, id) ?? ventures.retired.find((v) => v.id === id);
    const crew = (ventureId: string) => { const v = recordOf(ventureId); return v ? [v.proposerId, ...v.participants.filter((p) => p.consent === "accepted").map((p) => p.residentId)].filter((id) => Object.hasOwn(life.residents, id)) : []; };
    const assignWork = (ventureId: string) => {
      const venture = recordOf(ventureId);
      const step = venture?.steps.find((st) => st.status === "running");
      if (!venture || !step || step.startedMinute === null) return;
      for (const id of crew(ventureId)) {
        const member = life.residents[id]!;
        if (member.task) continue;
        task(id, "venture-work", step.label, Math.max(1, step.startedMinute + step.durationMinutes - minute), venture.placeId, "engine", { ventureId });
      }
    };
    const clearWork = (ventureId: string) => { for (const id of crew(ventureId)) if (life.residents[id]!.task?.ventureId === ventureId) life.residents[id]!.task = null; };
    for (const effect of effects) {
      if (inventionAssociated(state, effect.projectId)) continue;
      if (effect.type === "status" && effect.to === "active") assignWork(effect.projectId);
      else if (effect.type === "step" && effect.status === "running") assignWork(effect.projectId);
      else if (effect.type === "status" && effect.to === "completed") {
        const venture = recordOf(effect.projectId)!;
        const template = templateOf(venture.id);
        const project = template ? own(life.projects, template.consequence.projectId) : undefined;
        if (template && project) project.progress = clamp(project.progress + template.consequence.progress);
        const members = crew(effect.projectId);
        clearWork(effect.projectId);
        for (const id of members) {
          remember(life.residents[id]!, { minute, outcome: "venture-completed", fact: `Completed the venture to ${venture.label.toLowerCase()}.`, ventureId: venture.id, ...(template ? { projectId: template.consequence.projectId } : {}) });
          life.residents[id]!.needs.purpose = clamp(life.residents[id]!.needs.purpose + 25);
          for (const other of members) if (other !== id) trust(life.residents[id]!, other, 3);
          handled.add(id);
        }
      } else if (effect.type === "status" && (effect.to === "failed" || effect.to === "abandoned")) {
        const venture = recordOf(effect.projectId)!;
        const members = crew(effect.projectId);
        clearWork(effect.projectId);
        for (const id of members) {
          remember(life.residents[id]!, { minute, outcome: "venture-failed", fact: `The venture to ${venture.label.toLowerCase()} ended: ${effect.reason ?? effect.to}.`, ventureId: venture.id });
          handled.add(id);
        }
      }
    }
  };

  expireInventionConsultations(state, minute);
  expireMethodGrants(state,minute);
  // A fresh refusal takes effect before another actor can occupy both parties this minute.
  const orderedInventionCommands=[...inventionCommands].sort((a,b)=>Number(!(a.action==='grant-choice'&&['revoke','decline'].includes(a.choice)))-Number(!(b.action==='grant-choice'&&['revoke','decline'].includes(b.choice))));
  for (const command of orderedInventionCommands) {
    handled.add(command.residentId);
    const reason = duplicate.has(command.residentId) ? "conflicting-duplicate" : applyInventionCommand(state, command, minute, generation);
    if (reason !== "legal-command" && command.action !== "author-method" && command.action !== "adopt-version" && command.action!=="offer-method" && command.action!=="grant-choice") frozen.add(command.residentId);
    events.push({type:"invention-command-resolved",minute,residentId:command.residentId,requestId:command.requestId,...(InventionCommandSchema.safeParse(command).success ? {command:structuredClone(command)}:{}),...(generation === undefined ? {}:{executionGeneration:generation}),outcome:reason === "legal-command" ? "accepted" : "rejected",reason});
  }
  gateInventionWork(state, minute, frozen, handled);
  // Explicit proposals are considered once, in supplied order, against the state at application.
  for (const proposal of proposals) {
    handled.add(proposal.residentId);
    let reason: ResidentActionResolvedEvent["reason"] = "legal-option";
    if (!Object.hasOwn(life.residents, proposal.residentId) || !Object.hasOwn(state.residents, proposal.residentId)) reason = "unknown-resident";
    else if (duplicate.has(proposal.residentId)) reason = "contradictory-proposals";
    else if (proposal.observedMinute !== input.canonicalMinute) reason = "stale-observation";
    else {
      const option = getResidentActionOptions(state, proposal.residentId).find((o) => o.id === proposal.optionId) ?? wardrobeOptionById(state, proposal.residentId, proposal.optionId);
      // Nobody, the engine included, chooses a resident's appearance for them.
      if (!option || (option.kind === "choose-appearance" && proposal.source !== "local-model")) reason = "invalid-option";
      else if (!start(proposal.residentId, option, proposal.source)) reason = "partner-unavailable";
    }
    if (reason !== "legal-option") frozen.add(proposal.residentId);
    if (reason === "legal-option") pauseResidentAgenda(state, proposal.residentId);
    resolution(proposal, reason);
  }

  for (const commitment of sorted(life.commitments)) {
    // An invalid proposal cannot postpone an existing commitment's deadline.
    if (commitment.status === "pending" && minute >= commitment.expiresMinute) {
      failCommitment(commitment, "expired");
      // Keep the scheduled expiry and subsequent need updates identical with or without
      // an invalid decision. Both participants are already handled by this outcome.
      frozen.delete(commitment.requesterId);
      frozen.delete(commitment.lenderId);
    }
  }
  // Presence is a physical invariant, including failed-decision/frozen minutes. Legacy in-flight tasks retain
  // their accepted semantics; every task begun after commissioning must stay at its door or worksite.
  for (const profile of sorted(life.residents)) {
    const current=profile.task;
    if(!current || !life.transit || current.startedMinute<=life.transit.commissionedMinute)continue;
    const travel=current.walk??current.journey;
    const expected=travel && minute>=travel.arrivesMinute && state.residents[profile.residentId]!.placeId===current.placeId;
    if(expected || taskPresenceHolds(state,profile.residentId,current,minute))continue;
    if(current.commitmentId) failCommitment(life.commitments[current.commitmentId]!,"interrupted");
    else {profile.task=null;remember(profile,{minute,outcome:"interrupted",fact:"Work stopped because the resident was no longer at the recorded place or lawful journey."});handled.add(profile.residentId);}
  }
  // Journeys policy 1: the vehicle keeps its timetable whatever a rider proposed, so through a saved ride's minutes
  // the ride is checked even when its traveller (or their partner) is frozen and skipped below; a ride the saved
  // vehicle is not running ends the journey here, as it would unfrozen, never later as a late arrival.
  for (const profile of sorted(life.residents)) {
    const current = profile.task;
    if (!current?.journey || !(frozen.has(profile.residentId) || (current.partnerId && frozen.has(current.partnerId)))) continue;
    if (transitJourneyRideRuns(state, profile.residentId, minute)) continue;
    profile.task = null;
    remember(profile, { minute, outcome: "interrupted", fact: "The journey on the Meridian Central circuit could not go on as planned." });
    handled.add(profile.residentId);
  }
  // Finish existing tasks before making any automatic new choices. Finished actors skip utility this tick.
  for (const profile of sorted(life.residents)) {
    const id = profile.residentId;
    // Returning is physical committed time: an invalid proposal cannot pause it into a teleport or new work.
    if(profile.task?.kind==="frontier-return") {
      const held=profile.task;
      if(!keepFrontierReturn(state,id,minute)){profile.task=null;remember(profile,{minute,outcome:"interrupted",fact:"The physical return was interrupted; previously earned work is retained.",parcelId:held.returnTrip!.targetParcelId});}
      profile.needs.energy=clamp(profile.needs.energy-1);profile.needs.social=clamp(profile.needs.social-1);profile.needs.purpose=clamp(profile.needs.purpose-1);handled.add(id);continue;
    }
    if (frozen.has(id)) continue;
    if (profile.task && ["invention-build","assembly-trial","invention-teach"].includes(profile.task.kind)) { if(profile.task.kind!=='invention-teach'||profile.task.startedMinute<minute)profile.needs.energy = clamp(profile.needs.energy - 1); handled.add(id); continue; }
    const current = profile.task;
    if (current?.partnerId && frozen.has(current.partnerId)) continue;
    // A child's home task also restores social and purpose: more when a parent is home with them.
    const childGain = childIn(state, id) && current?.kind === "rest" ? childHomeGain(state, id) : 0;
    profile.needs.social = clamp(profile.needs.social - 1 + childGain);
    profile.needs.purpose = clamp(profile.needs.purpose - 1 + childGain);
    profile.needs.energy = clamp(profile.needs.energy + (current?.kind === "rest" ? 8 : current?.kind === "work" || current?.kind === "use-tool" ? -2 : -1));
    if (!current || current.startedMinute === minute) continue;
    if (!current.trip && (current.walk || current.journey) && !advanceResidentTravel(state,id,current,minute)) {
      profile.task=null; remember(profile,{minute,outcome:"interrupted",fact:"The recorded journey did not complete at the worksite."}); handled.add(id); continue;
    }
    if (profile.needs.energy === 0 && current.kind !== "rest") {
      if (current.commitmentId) failCommitment(life.commitments[current.commitmentId]!, "interrupted");
      else if (current.kind === "socialise" && current.partnerId) {
        life.residents[current.partnerId]!.task = null; profile.task = null;
        mutual(id, current.partnerId, "interrupted", "The meeting ended early because a participant was exhausted.", -1);
      } else { profile.task = null; remember(profile, { minute, outcome: "interrupted", fact: "The task stopped because energy was exhausted." }); }
      handled.add(id); continue;
    }
    if (current.kind === "use-tool" && state.residents[id]!.placeId === current.placeId) { const start=current.walk?.arrivesMinute??current.journey?.arrivesMinute??current.startedMinute; current.progress = clamp(Math.floor((minute-start)*100/(current.endsMinute-start))); }
    // Frontier access policy 1: walk on, arrive, and stay at the worksite every minute, or the shift earns nothing.
    if (current.trip && !keepFrontierShift(state, id, minute)) {
      profile.task = null;
      remember(profile, { minute, outcome: "interrupted", fact: "Was no longer at the frontier worksite, so the shift there did not count.", parcelId: current.parcelId! });
      handled.add(id); continue;
    }
    if (minute < current.endsMinute || current.kind === "wait-tool") continue;
    handled.add(id);
    if (current.kind === "invention-travel") {
      if (!life.transit) state.residents[id] = { ...state.residents[id]!, placeId: current.placeId };
      profile.task = null;
    } else if (current.kind === "handover" || current.kind === "return-tool") {
      const commitment = life.commitments[current.commitmentId!]!;
      const other = life.residents[current.partnerId!]!;
      const returning = current.kind === "return-tool";
      const expectedOwner = returning ? commitment.requesterId : commitment.lenderId;
      if (other.task?.commitmentId !== commitment.id || other.needs.energy <= 1 || state.residents[id]!.placeId !== commitment.placeId || state.residents[other.residentId]!.placeId !== commitment.placeId || life.resources[commitment.resourceId]!.ownerId !== expectedOwner) {
        failCommitment(commitment, "interrupted"); continue;
      }
      life.resources[commitment.resourceId]!.ownerId = returning ? commitment.lenderId : commitment.requesterId;
      commitment.status = returning ? "returned" : "loaned";
      profile.task = null; other.task = null;
      for (const [actorId, partnerId] of [[commitment.requesterId, commitment.lenderId], [commitment.lenderId, commitment.requesterId]] as const) {
        const outcome = returning ? "tool-returned" : actorId === commitment.requesterId ? "tool-received" : "tool-lent";
        remember(life.residents[actorId]!, { minute, outcome, fact: returning ? "The borrowed garden tools were returned at the public meeting." : "The garden tools changed hands at the public meeting.", partnerId, resourceId: commitment.resourceId });
        trust(life.residents[actorId]!, partnerId, returning ? 5 : 3); handled.add(actorId);
      }
    } else if (current.kind === "socialise") {
      const other = life.residents[current.partnerId!]!;
      if (other.task?.kind !== "socialise" || other.task.partnerId !== id || other.needs.energy <= 1 || state.residents[id]!.placeId !== current.placeId || state.residents[other.residentId]!.placeId !== current.placeId) {
        profile.task = null; other.task = null; mutual(id, other.residentId, "interrupted", "The shared meeting did not complete.", -1);
      } else {
        profile.task = null; other.task = null;
        profile.needs.social = clamp(profile.needs.social + 30); other.needs.social = clamp(other.needs.social + 30);
        mutual(id, other.residentId, "socialised", `Spent time together at ${own(state.places, current.placeId)?.name ?? "a public place"}.`, 2);
      }
    } else if (current.kind === "use-tool") {
      profile.task = null;
      if (state.residents[id]!.placeId !== current.placeId || life.projects[current.projectId!]!.placeId !== current.placeId || life.resources[current.resourceId!]!.ownerId !== id) remember(profile, { minute, outcome: "interrupted", fact: "Garden work stopped because the required tools were unavailable." });
      else {
        const project = life.projects[current.projectId!]!; project.progress = clamp(project.progress + 10);
        profile.needs.purpose = clamp(profile.needs.purpose + 30);
        profile.skills.gardening = clamp(profile.skills.gardening + 1);
        remember(profile, { minute, outcome: "garden-tended", fact: "Used the held tools to improve the public garden.", resourceId: current.resourceId!, projectId: project.id });
      }
    } else if (current.kind === "survey") {
      profile.task = null;
      const entry = observePlace(state, current.placeId, id, minute);
      life.charts = { ...(life.charts ?? {}), [current.placeId]: entry };
      // Surveying is a cartographer's work, and pays like it.
      profile.needs.purpose = clamp(profile.needs.purpose + 25);
      profile.skills.work = clamp(profile.skills.work + 1);
      remember(profile, { minute, outcome: "place-charted", fact: describeChart(state, entry), placeId: current.placeId });
    } else if (current.kind === "chart-frontier" || current.kind === "help-chart") {
      profile.task = null;
      const lead = current.kind === "chart-frontier";
      const parcelId = current.parcelId!;
      const outcome = applyFrontierWork(life, parcelId, id, lead ? FRONTIER_LEAD_EFFORT : FRONTIER_HELP_EFFORT, minute);
      const parcel = life.frontier?.[parcelId];
      const where = parcel ? frontierParcelName(parcel) : "the fog";
      if (outcome === "worked" || outcome === "charted") {
        profile.needs.purpose = clamp(profile.needs.purpose + (lead ? 25 : 15));
        if (lead) profile.skills.work = clamp(profile.skills.work + 1);
      }
      if (outcome === "charted") remember(profile, { minute, outcome: "frontier-charted", fact: `The fog lifted: charted ${where}, and new ground lies beyond it.`.slice(0, 240), parcelId });
      else if (outcome === "worked") remember(profile, { minute, outcome: "frontier-surveyed", fact: `${lead ? "Surveyed" : "Helped survey"} ${where}; the fog is thinning (${parcel!.effort} of 6).`.slice(0, 240), parcelId });
      else remember(profile, { minute, outcome: "frontier-surveyed", fact: `Reached ${where}, but it had already been charted.`.slice(0, 240), parcelId });
    } else if (current.kind === "build") {
      profile.task = null;
      const parcelId = current.parcelId!;
      const result = applyBuildWork(state, parcelId, id, minute);
      if (result.outcome === "founded") {
        profile.needs.purpose = clamp(profile.needs.purpose + 30);
        profile.skills.building = clamp(profile.skills.building + 1);
        remember(profile, { minute, outcome: "place-founded", fact: `Finished building ${result.place!.name}: a new place in Meridian.`.slice(0, 240), parcelId, placeId: result.place!.id });
      } else if (result.outcome === "worked") {
        profile.needs.purpose = clamp(profile.needs.purpose + 20);
        profile.skills.building = clamp(profile.skills.building + 1);
        const build = life.frontier![parcelId]!.build!;
        remember(profile, { minute, outcome: "build-worked", fact: `Worked on the ${frontierBuildLabel(build.kind)} beyond the city (${build.effort} of ${FRONTIER_BUILDS.find((s) => s.kind === build.kind)!.effort}).`, parcelId });
      } else remember(profile, { minute, outcome: "build-worked", fact: "Reached the building site, but the work there was already finished.", parcelId });
    } else if (current.kind === "venture-work") {
      // Venture progress is owned by the venture ledger; finishing a shift only frees the resident.
      const venture=life.ventures?.projects[current.ventureId!];
      if(life.transit && venture?.status==="active") current.endsMinute=Math.max(minute+1,...venture.steps.filter(s=>s.status==="running"&&s.startedMinute!==null).map(s=>s.startedMinute!+s.durationMinutes));
      else {profile.task=null; profile.needs.purpose=clamp(profile.needs.purpose+10);}
    } else {
      profile.task = null;
      if (current.kind === "work") { profile.needs.purpose = clamp(profile.needs.purpose + 25); profile.skills.work = clamp(profile.skills.work + 1); }
      // Builders and gardeners fill the city stores; every other trade's work is unchanged.
      const supplied = current.kind === "work" ? supplyFromWork(life, profile) : undefined;
      remember(profile, { minute, outcome: current.kind === "rest" ? "rested" : "work-completed", fact: current.kind === "rest" ? (childIn(state, id) ? `Finished ${current.label.charAt(0).toLowerCase()}${current.label.slice(1)} at home.` : current.label === "Recover energy away from home" ? "Finished resting away from home; there was no lawful way across the water." : "Finished resting at home.") : supplied?.fact ?? `Completed ${profile.skills.occupation.toLowerCase()} work.` });
    }
    if(current.trip && !profile.task) {
      const returning=frontierReturnTask(state,id,current,minute);
      if(returning){profile.task=returning;state.residents[id]={...state.residents[id]!,activity:"leisure"};}
    }
  }
  // Ventures advance once per committed minute after task completions, before automatic choices,
  // so freed crew can be assigned the next step in the same minute.
  // Only while ventures are open: concluded ventures hold no reservations, so an idle world emits no venture events.
  gateInventionWork(state, minute, frozen, handled);
  if (life.ventures && Object.keys(life.ventures.projects).length > 0) {
    // Ordinary projects use the same physical requirement as invention jobs. Waiting for real arrivals
    // cannot start a paid step; leaving/frozen work aborts without consuming remaining reservations.
    const present=(ventureId:string) => {
      const v=life.ventures!.projects[ventureId];
      return !!v && [v.proposerId,...v.participants.filter(p=>p.consent==="accepted").map(p=>p.residentId)].every(id=>{
        const p=life.residents[id], r=state.residents[id];
        return !!p&&!!r&&r.placeId===v.placeId&&p.needs.energy>0&&!frozen.has(id)&&p.task?.ventureId===v.id&&minute>=(p.task.walk?.arrivesMinute??p.task.journey?.arrivesMinute??0);
      });
    };
    if(life.transit)for(const v of Object.values(life.ventures.projects)) {
      if(inventionAssociated(state,v.id)||v.proposedMinute<=life.transit.commissionedMinute||v.status!=="active"||present(v.id))continue;
      const stopped=abandonProject(life.ventures as ProjectLedger,v.id,minute);
      if(!stopped.ok)throw new Error(stopped.reason);
      life.ventures=stopped.value.ledger as VentureLedger;applyVentureEffects(stopped.value.effects);
    }
    const advanced = advanceProjects(life.ventures as ProjectLedger, minute, id=>!life.transit || inventionAssociated(state,id) || life.ventures!.projects[id]!.proposedMinute<=life.transit.commissionedMinute || present(id));
    if (advanced.ok) { life.ventures = advanced.value.ledger as VentureLedger; applyVentureEffects(advanced.value.effects); }
  }
  settleInventionWork(state, minute, handled);
  settleResidentAgendas(state);
  for (const profile of sorted(life.residents)) {
    if (handled.has(profile.residentId) || frozen.has(profile.residentId) || profile.task) continue;
    // A completed actor's decision slot must survive this commit on both sides
    // of an automatic social choice. Explicit proposals and tool commitments
    // retain their existing legality and consent rules.
    const options = getResidentActionOptions(state, profile.residentId).filter((o) => !o.partnerId || (!frozen.has(o.partnerId) && (o.kind !== "socialise" || !handled.has(o.partnerId))));
    // A model resident's choice made while busy is used now, if it is still legal; otherwise the engine chooses.
    const nextAction = nextActions.find((n) => n.residentId === profile.residentId);
    const planned = nextAction ? options.find((o) => o.id === nextAction.optionId) ?? wardrobeOptionById(state, profile.residentId, nextAction.optionId) : undefined;
    if (planned && start(profile.residentId, planned, "local-model")) { pauseResidentAgenda(state,profile.residentId); resolution({ residentId: profile.residentId, observedMinute: input.canonicalMinute, optionId: planned.id, source: "local-model" }, "legal-option"); continue; }
    if (continueResidentAgenda(state, profile.residentId, minute)) continue;
    const option = utility(state, profile.residentId, options);
    if (option && start(profile.residentId, option)) resolution({ residentId: profile.residentId, observedMinute: input.canonicalMinute, optionId: option.id, source: "engine" }, "legal-option");
  }

  // New places come first, so replay creates a place before any resident moves into it.
  for (const placeId of Object.keys(state.places).filter((pid) => !Object.hasOwn(input.places, pid)).sort()) {
    const parcel = Object.values(life.frontier ?? {}).find((p) => p.placeId === placeId);
    const place = state.places[placeId]!;
    if (!parcel || (place.kind !== "civic" && place.kind !== "residence")) throw new Error(`unexpected new place ${placeId}`);
    events.push({ type: "place-founded", minute, placeId, parcelId: parcel.id, place: { id: place.id, name: place.name, kind: place.kind } });
  }
  // Entity deltas record the whole minute's before/after values, never a per-resident world copy.
  for (const id of Object.keys(life.residents).sort()) {
    const before = input.life.residents[id]!; const after = life.residents[id]!;
    if (JSON.stringify(before) !== JSON.stringify(after)) events.push({ type: "resident-life-changed", minute, residentId: id, before, after: structuredClone(after) });
    const original = input.residents[id]!; const next = state.residents[id]!;
    if (original.activity !== next.activity) events.push({ type: "resident-activity-changed", minute, residentId: id, fromActivity: original.activity, toActivity: next.activity });
    // A move comes before the walk there, so replay knows the new home before the resident arrives in it.
    if (original.homePlaceId !== next.homePlaceId) events.push({ type: "resident-moved-home", minute, residentId: id, before: { homePlaceId: original.homePlaceId, schedule: structuredClone(original.schedule) }, after: { homePlaceId: next.homePlaceId, schedule: structuredClone(next.schedule) } });
    if (original.placeId !== next.placeId) events.push({ type: "resident-location-changed", minute, residentId: id, fromPlaceId: original.placeId, toPlaceId: next.placeId });
  }
  for (const id of Object.keys(life.resources).sort()) if (JSON.stringify(input.life.resources[id]) !== JSON.stringify(life.resources[id])) events.push({ type: "life-resource-changed", minute, resourceId: id, before: input.life.resources[id]!, after: structuredClone(life.resources[id]!) });
  for (const id of Object.keys(life.projects).sort()) if (JSON.stringify(input.life.projects[id]) !== JSON.stringify(life.projects[id])) events.push({ type: "life-project-changed", minute, projectId: id, before: input.life.projects[id]!, after: structuredClone(life.projects[id]!) });
  for (const id of Object.keys(life.charts ?? {}).sort()) {
    const before = input.life.charts && Object.hasOwn(input.life.charts, id) ? input.life.charts[id]! : null;
    const after = life.charts![id]!;
    if (JSON.stringify(before) !== JSON.stringify(after)) events.push({ type: "life-chart-changed", minute, placeId: id, before, after: structuredClone(after) });
  }
  for (const id of Object.keys(life.frontier ?? {}).sort()) {
    const before = input.life.frontier && Object.hasOwn(input.life.frontier, id) ? input.life.frontier[id]! : null;
    const after = life.frontier![id]!;
    if (JSON.stringify(before) !== JSON.stringify(after)) events.push({ type: "life-frontier-changed", minute, parcelId: id, before, after: structuredClone(after) });
  }
  for (const id of Object.keys(life.commitments).sort()) if (JSON.stringify(input.life.commitments[id]) !== JSON.stringify(life.commitments[id])) events.push({ type: "life-commitment-changed", minute, commitmentId: id, before: input.life.commitments[id] ?? null, after: structuredClone(life.commitments[id]!) });
  const beforeVentures = input.life.ventures, afterVentures = life.ventures;
  if (beforeVentures && afterVentures) {
    const newlyRetired = afterVentures.retired.filter((v) => !beforeVentures.retired.some((b) => b.id === v.id));
    // Replay appends a retiring venture to `retired` in event order, so retirements must be emitted in
    // the order the kernel retired them, not id order ("resident-102:" sorts before "resident-10:").
    const retiredIds = newlyRetired.map((v) => v.id);
    const ids = [...[...new Set([...Object.keys(beforeVentures.projects), ...Object.keys(afterVentures.projects)])].filter((id) => !retiredIds.includes(id)).sort(), ...retiredIds];
    const replayRetired = [...beforeVentures.retired];
    for (const id of ids) {
      const before = own(beforeVentures.projects, id) ?? null;
      const after = own(afterVentures.projects, id) ?? newlyRetired.find((v) => v.id === id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const terminal=after&&["completed","failed","abandoned"].includes(after.status);
        const evicted=terminal&&replayRetired.length===32?replayRetired.shift():undefined;
        if(terminal)replayRetired.push(after);
        events.push({ type: "venture-changed", minute, ventureId: id, before, after: structuredClone(after), ...(evicted?{evicted:structuredClone(evicted)}:{}) });
      }
    }
    for (const rid of Object.keys(afterVentures.resources).sort()) {
      if (JSON.stringify(beforeVentures.resources[rid]) !== JSON.stringify(afterVentures.resources[rid])) events.push({ type: "venture-resource-changed", minute, resourceId: rid, before: beforeVentures.resources[rid] ?? null, after: structuredClone(afterVentures.resources[rid]!) });
    }
    if (beforeVentures.nextSequence !== afterVentures.nextSequence || beforeVentures.nextRequestSequence !== afterVentures.nextRequestSequence) {
      events.push({ type: "venture-counters-changed", minute, before: { nextSequence: beforeVentures.nextSequence, nextRequestSequence: beforeVentures.nextRequestSequence }, after: { nextSequence: afterVentures.nextSequence, nextRequestSequence: afterVentures.nextRequestSequence } });
    }
  }
  events.push(...inventionDeltas(input.life.invention, life.invention, minute));
  return { state, events };
}
