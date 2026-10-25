export { consultationWindow } from './invention-cognition.js';
export { advanceWorld, migrateResidentAppearances } from "./advance-world.js";
export type { TransitionResult } from "./advance-world.js";
export { createFoundingState } from "./founding-district.js";
export { createCityState } from "./city-state.js";
export { createCityLifeState } from "./city-life-state.js";
export { deriveResidentAppearance } from "./resident-appearance.js";
export {
  WARDROBE_COOLDOWN_MINUTES, WARDROBE_MENU_LIMIT, WARDROBE_OPTION_PREFIX, WARDROBE_ROTATION_MINUTES, applyWardrobeChoice, legalWardrobeChoice, openWardrobe,
  parseWardrobeOptionId, validateWardrobeMinute, wardrobeChoiceAllowed, wardrobeChoiceOrder, wardrobeChoices, wardrobeMenu, wardrobeOptionId, wardrobeOptionLabel,
} from "./wardrobe.js";
export type { WardrobeChoice } from "./wardrobe.js";
export { CITY_LIFE_2_STOCKS, createCityLife2State } from "./city-life-2-state.js";
export { CHILD_TASK_LABELS, getResidentActionOptions, isChild, VENTURE_TEMPLATES } from "./resident-life.js";
export { CIVIC_PROJECTS, migrateCivicProjects } from "./civic-improvements.js";
export { applyUpkeep, isUpkeepMinute, UPKEEP_FLOOR, UPKEEP_INTERVAL_MINUTES, UPKEEP_WEAR } from "./upkeep.js";
export { chooseSocialVenue, venueForMinute, SOCIAL_VENUES } from "./social-venues.js";
export { homesToMoveInto, moveHome } from "./frontier.js";
export { FRONTIER_BUILDS, applyBuildWork, buildsUnderWay, canBuild, foundingOptions, frontierBuildLabel, frontierPlace, freeFrontierParcel, startFrontierBuild } from "./frontier.js";
export { FRONTIER_HELP_EFFORT, FRONTIER_LEAD_EFFORT, FRONTIER_TASK_MINUTES, FRONTIER_WORK_PLACE_ID, MAX_FRONTIER_OPTIONS, applyFrontierWork, frontierBeingCharted, frontierDirection, frontierParcelId, frontierParcelName, frontierTargets, migrateFrontier, outwardSlots } from "./frontier.js";
export { FRONTIER_ACCESS_POLICY, FRONTIER_GROUND_STEP_MINUTES, FRONTIER_QUAY_WALK_MINUTES, enableFrontierAccess, frontierAccessEnabled, frontierGroundOf, frontierMenu, frontierNeighbourIds, frontierReach } from "./frontier-access.js";
export type { FrontierMenu, FrontierReach, FrontierRoute } from "./frontier-access.js";
export { CARTOGRAPHER_OCCUPATION, CHART_STALE_MINUTES, MAX_SURVEY_OPTIONS, SURVEY_MINUTES, describeChart, isCartographer, isChartable, observePlace, surveyTargets } from "./cartography.js";
export { STORES, storesCanSupply, supplyFromWork, type Store } from "./growth.js";
export { activityAt } from "./resident-activity.js";
export { applyScheduledMinute } from "./schedule.js";
export type { ScheduledMinuteResult } from "./schedule.js";
export { planWorldTime } from "./world-time.js";
export type { WorldTimeInput, WorldTimePlan } from "./world-time.js";
// Grounded discovery (pure core + isolated adapter). Not yet part of WorldState, events or the store.
export * as discoveryCore from "./discovery-core.js";
export {
  DISCOVERY_FORMAT_VERSION, DISCOVERY_LIMITS, createDiscoveryLedger, evaluateHypotheses, observeCommittedMinute,
  openDiscoveryLedger, proposeHypothesis, residentDiscoverySummary,
} from "./discovery-adapter.js";
export type { DiscoveryHypothesis, DiscoveryLedger, DiscoveryOutcome, HypothesisProposal, ResidentDiscovery } from "./discovery-adapter.js";
// Project/invention lifecycle (Slice 2): pure kernel over the reservation reducer. Not part of WorldState or the store.
export {
  PROJECT_LEDGER_FORMAT_VERSION, PROJECT_LIMITS, TERMINAL_STATUSES, abandonProject, advanceProjects, createProjectLedger, declareResource,
  listProjects, openProjectLedger, proposeProject, respondToInvitation, withdrawParticipant,
} from "./project-lifecycle.js";
export type { ConsentState, OutcomeReason, Participant, ProjectAdvance, ProjectEffect, ProjectLedger, ProjectProposal, ProjectRecord, ProjectRequirement, ProjectStatus, ProjectStep, ProjectStepPlan, StepStatus } from "./project-lifecycle.js";

export * from "./invention.js";
export * from "./invention-evaluator.js";

export { methodTask, methodApplicability, validateMethodGrades, methodInput, methodSelection, methodRevisionBasis } from './invention-method.js';
export type { MethodIntake } from './invention-method.js';

export * from './invention-learning.js';
// Meridian Central circuit: optional versioned transit derived from the charted frontier (Transport Ruling).
export { applyTransitMinute, commissionTransit, deriveTransitRoute, stepTransit, transitLandings, transitStationFor, transitUnservedPlaces, validateTransitCommissioning, validateTransitMinute } from "./transit.js";
export { keepTransitJourney, planTransitJourney, transitPlaceParcel } from "./transit-journey.js";

export { planResidentTravel } from "./resident-travel.js";
