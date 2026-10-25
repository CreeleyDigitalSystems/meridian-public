import {FrontierWorksiteSchema,FrontierTripSchema,ResidentWalkSchema,FrontierReturnSchema} from "./resident-movement.js";
export {FrontierWorksiteSchema,FrontierTripSchema,ResidentWalkSchema,FrontierReturnSchema} from "./resident-movement.js";
export type {FrontierWorksite,FrontierTrip,ResidentWalk,FrontierReturn} from "./resident-movement.js";
import { InventionStateSchema } from "./invention.js";
import { z } from "zod";
import { VentureLedgerSchema } from "./venture.js";
import { ResidentAppearanceProfileSchema, WardrobeStateSchema } from "./resident-appearance.js";
import { TransitJourneySchema, TransitStateSchema } from "./transit.js";

const id = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const minute = z.number().int().nonnegative();
const bounded = z.number().int().min(0).max(100);
export const ResidentActionKindSchema = z.enum(["work", "rest", "socialise", "request-tool", "accept-request", "decline-request", "use-tool", "return-tool", "propose-venture", "join-venture", "decline-venture", "survey", "chart-frontier", "help-chart", "found-place", "build", "move-home", "choose-appearance"]);
export type ResidentActionKind = z.infer<typeof ResidentActionKindSchema>;
/**
 * Frontier access, policy 1 (spatial coherence): a frontier shift is worked where the work is, reached by timed
 * travel. Absent until the zero-minute `frontier-access-enabled` cutover, so every earlier shift keeps the
 * promenade semantics it was accepted under.
 */
export const FrontierAccessPolicySchema = z.object({ version: z.literal(1), enabledMinute: minute }).strict();
export type FrontierAccessPolicy = z.infer<typeof FrontierAccessPolicySchema>;
/**
 * Where a frontier shift is worked: on the city's outer quay facing one ring-1 sector across the channel, or
 * standing on charted ground (the fog's charted neighbour, or the build's own parcel). Never inside fog.
 */
/**
 * Two frontier parcels share an edge: ring neighbours (ring r holds 8r slots, wrapping), or a parcel and its one
 * inward parent in the ring before (slot s of ring r has parent floor(s·(r−1)/r)). A ground worksite for charting
 * must share an edge with the fog it faces.
 */
export function frontierParcelsShareEdge(a: { ring: number; slot: number }, b: { ring: number; slot: number }): boolean {
  if (a.ring === b.ring) {
    const span = 8 * a.ring, apart = (((a.slot - b.slot) % span) + span) % span;
    return apart === 1 || apart === span - 1;
  }
  const [inner, outer] = a.ring < b.ring ? [a, b] : [b, a];
  return outer.ring === inner.ring + 1 && Math.floor((outer.slot * inner.ring) / outer.ring) === inner.slot;
}
/** The walk to a worksite and the shift there: travelling until `arrivesMinute`, then working until the task ends. */
/** Task kinds that cross the water as a saved journey on the Meridian Central circuit (journeys policy 1). */
export const TRANSIT_JOURNEY_TASK_KINDS: readonly string[] = ["rest", "work", "socialise", "survey", "wait-tool", "handover", "return-tool", "use-tool", "venture-work", "invention-travel", "chart-frontier", "help-chart", "build"];
/** A timed walk between recorded places, without a water crossing. Only commissioned worlds use it. */
export const RESIDENT_CITY_WALK_MINUTES = 6;
export const RESIDENT_FRONTIER_STEP_MINUTES = 4;
export const FRONTIER_SHIFT_MINUTES = 20;
export const ResidentTaskSchema = z.object({
  kind: z.enum(["frontier-return", "work", "rest", "socialise", "wait-tool", "handover", "use-tool", "return-tool", "venture-work", "invention-build", "assembly-trial", "invention-teach", "invention-travel", "survey", "chart-frontier", "help-chart", "build"]),
  label: z.string().min(1).max(160), startedMinute: minute, endsMinute: minute,
  placeId: id, partnerId: id.optional(), resourceId: id.optional(), projectId: id.optional(),
  inventionId: id.optional(), commitmentId: id.optional(), ventureId: id.optional(), parcelId: id.optional(), blocker: z.string().min(1).max(160).optional(), progress: bounded.optional(),
  decisionSource: z.enum(["engine", "local-model"]).optional(),
  /** Frontier access policy 1 only: absent on every task begun before the cutover. */
  trip: FrontierTripSchema.optional(),
  /** Journeys policy 1 only (commissioned transit): absent on every task that does not cross the water. */
  journey: TransitJourneySchema.optional(),
  walk: ResidentWalkSchema.optional(),
  returnTrip: FrontierReturnSchema.optional(),
}).strict().superRefine((task, context) => {
  const back=task.returnTrip;
  if((task.kind==="frontier-return")!==(back!==undefined) || back && (task.walk || task.trip || task.journey || task.endsMinute!==back.arrivesMinute || back.sourceStartedMinute>=task.startedMinute || task.parcelId || task.partnerId || task.ventureId || task.inventionId || task.resourceId || task.commitmentId || task.projectId))context.addIssue({code:"custom",message:"a frontier return retains its settled source and complete physical route"});
  if (task.walk && (task.trip || task.journey || task.walk.fromPlaceId === task.placeId || !(task.startedMinute < task.walk.arrivesMinute && task.walk.arrivesMinute <= task.endsMinute))) context.addIssue({code:"custom",message:"invalid recorded walk"});
  const journey = task.journey;
  if (journey) {
    if (!TRANSIT_JOURNEY_TASK_KINDS.includes(task.kind)) context.addIssue({ code: "custom", message: "only rest, work and social tasks travel on the circuit" });
    if (journey.fromPlaceId === task.placeId) context.addIssue({ code: "custom", message: "a journey goes somewhere else" });
    if (!(task.startedMinute < journey.ride.boardMinute && (journey.arrivesMinute < task.endsMinute || task.kind === "invention-travel" && journey.arrivesMinute === task.endsMinute))) context.addIssue({ code: "custom", message: "a journey walks to its platform after the task starts and arrives before it ends" });
  }
  if (task.endsMinute <= task.startedMinute) context.addIssue({ code: "custom", message: "task must end after it starts" });
  if (task.kind === "use-tool" && (!task.resourceId || !task.projectId)) context.addIssue({ code: "custom", message: "garden task requires resource and project" });
  if (task.kind === "socialise" && !task.partnerId) context.addIssue({ code: "custom", message: "social task requires partner" });
  if (["wait-tool", "handover", "return-tool"].includes(task.kind) && (!task.partnerId || !task.resourceId || !task.commitmentId)) context.addIssue({ code: "custom", message: "tool commitment task requires partner, resource and commitment" });
  if (["invention-build","assembly-trial","invention-teach"].includes(task.kind) && (!task.inventionId || !task.ventureId)) context.addIssue({code:"custom",message:"invention task requires association"});
  if (task.kind === "invention-travel") {
    const arrival = task.walk?.arrivesMinute ?? task.journey?.arrivesMinute;
    if (!task.inventionId || task.ventureId || (arrival === undefined ? task.endsMinute !== task.startedMinute + 1 : task.endsMinute !== arrival)) context.addIssue({code:"custom",message:"invention travel must finish its recorded journey and retain its agenda association"});
  }
  if (task.kind === "venture-work" && !task.ventureId) context.addIssue({ code: "custom", message: "venture task requires a venture" });
  if ((task.kind === "chart-frontier" || task.kind === "help-chart" || task.kind === "build") !== (task.parcelId !== undefined)) context.addIssue({ code: "custom", message: "frontier tasks, and only they, name a parcel" });
  const trip = task.trip;
  if (trip) {
    if (task.kind !== "chart-frontier" && task.kind !== "help-chart" && task.kind !== "build") context.addIssue({ code: "custom", message: "only frontier shifts travel to a worksite" });
    if (!(task.startedMinute < trip.arrivesMinute && trip.arrivesMinute < task.endsMinute)) context.addIssue({ code: "custom", message: "a frontier trip arrives after it starts and before the shift ends" });
    if (trip.site.kind === "quay" && (task.kind === "build" || task.parcelId !== `parcel:1:${trip.site.sector}`)) context.addIssue({ code: "custom", message: "a quay faces only its own ring-1 fog sector" });
    if (trip.site.kind === "ground" && (task.kind === "build") !== (trip.site.parcelId === task.parcelId)) context.addIssue({ code: "custom", message: "a build is worked on its parcel; fog from charted ground beside it" });
  }
});
export type ResidentTask = z.infer<typeof ResidentTaskSchema>;
export const ResidentMemorySchema = z.object({
  minute, outcome: z.enum(["work-completed", "rested", "socialised", "tool-received", "tool-lent", "tool-returned", "garden-tended", "request-declined", "request-expired", "interrupted", "venture-proposed", "venture-joined", "venture-declined", "venture-completed", "venture-failed", "place-charted", "frontier-surveyed", "frontier-charted", "build-started", "build-worked", "place-founded", "moved-home"]),
  fact: z.string().min(1).max(240), partnerId: id.optional(), resourceId: id.optional(), projectId: id.optional(), ventureId: id.optional(), placeId: id.optional(), parcelId: id.optional(),
}).strict();
export type ResidentMemory = z.infer<typeof ResidentMemorySchema>;
export const ResidentLifeProfileSchema = z.object({
  residentId: id, needs: z.object({ energy: bounded, social: bounded, purpose: bounded }).strict(),
  skills: z.object({ occupation: z.string().min(1).max(80), work: bounded, gardening: bounded, building: bounded }).strict(),
  goal: z.string().min(1).max(160), task: ResidentTaskSchema.nullable(),
  memories: z.array(ResidentMemorySchema).max(12), trust: z.record(id, z.number().int().min(-100).max(100)),
  // Stored worlds before the appearance migration remain valid at this boundary.
  appearance: ResidentAppearanceProfileSchema.optional(),
}).strict();
export type ResidentLifeProfile = z.infer<typeof ResidentLifeProfileSchema>;
export const LifeResourceSchema = z.object({ id, kind: z.literal("garden-tools"), label: z.string().min(1).max(160), ownerId: id }).strict();
export type LifeResource = z.infer<typeof LifeResourceSchema>;
export const LifeProjectSchema = z.object({ id, kind: z.enum(["garden", "civic"]), label: z.string().min(1).max(160), placeId: id, progress: bounded }).strict();
export type LifeProject = z.infer<typeof LifeProjectSchema>;
export const LifeCommitmentSchema = z.object({
  id, requesterId: id, lenderId: id, resourceId: id, projectId: id, placeId: id,
  status: z.enum(["pending", "meeting", "loaned", "returning", "returned", "declined", "expired", "interrupted"]),
  createdMinute: minute, expiresMinute: minute,
}).strict();
export type LifeCommitment = z.infer<typeof LifeCommitmentSchema>;
/**
 * One surveyed place on the city's shared chart: what a cartographer actually found there, read from
 * committed state at the minute the survey finished. Never model text. The latest survey of a place
 * replaces the previous one, so the chart stays bounded by the number of public places.
 */
export const ChartEntrySchema = z.object({
  placeId: id, surveyorId: id, surveyedMinute: minute,
  /** Residents standing at the place when it was surveyed, the surveyor included. */
  present: z.number().int().nonnegative().max(10_000),
  /** Up to three of them by id, in id order: who the cartographer saw there. */
  seen: z.array(id).max(3),
  /** Every project at the place and its committed progress. */
  projects: z.array(z.object({ projectId: id, progress: bounded }).strict()).max(8),
}).strict();
export type ChartEntry = z.infer<typeof ChartEntrySchema>;
/** Effort a parcel needs before its fog lifts: a cartographer's shift adds 2, a helper's 1. */
export const FRONTIER_CHART_EFFORT = 6;
/** The bounded catalogue of things residents may found on charted ground (A-P36): all public places for now. */
export const FrontierBuildKindSchema = z.enum(["gathering-hall", "market-stalls", "garden-terrace", "lookout", "workshop", "home"]);
export type FrontierBuildKind = z.infer<typeof FrontierBuildKindSchema>;
/** A build under way on a charted parcel: who founded it, what it will be, and the work done so far. */
export const FrontierBuildSchema = z.object({
  kind: FrontierBuildKindSchema, proposerId: id, startedMinute: minute,
  effort: z.number().int().min(0).max(100), crew: z.array(id).max(8),
}).strict().refine((build) => build.crew.every((c, i) => i === 0 || build.crew[i - 1]! < c), { message: "crew is unique and in id order" });
export type FrontierBuild = z.infer<typeof FrontierBuildSchema>;
/**
 * One parcel of ground beyond the charted city (D-8). Ring r holds 8r slots; a parcel exists in state
 * only once revealed. Fog lifts only through residents' finished work, never by time.
 */
export const FrontierParcelSchema = z.object({
  id, ring: z.number().int().min(1).max(64), slot: z.number().int().nonnegative(),
  state: z.enum(["fog", "charted"]), effort: z.number().int().min(0).max(FRONTIER_CHART_EFFORT),
  contributors: z.array(id).max(8), chartedMinute: minute.optional(),
  /** A build under way here; charted ground only, and never once a place stands here. */
  build: FrontierBuildSchema.optional(),
  /** The place residents founded here, and what it is. */
  placeId: id.optional(),
  builtKind: FrontierBuildKindSchema.optional(),
  /**
   * Who built it: the founder and every crew member, in id order. Absent on places founded before
   * homes (slice 2, live 12 Oct 2026): the live world saved eleven of them, so it must stay optional.
   */
  builtBy: z.array(id).max(9).optional(),
}).strict().superRefine((parcel, context) => {
  if ((parcel.build || parcel.placeId) && parcel.state !== "charted") context.addIssue({ code: "custom", message: "only charted ground can be built on" });
  if (parcel.build && parcel.placeId) context.addIssue({ code: "custom", message: "a parcel holds a build or a founded place, not both" });
  if ((parcel.placeId === undefined) !== (parcel.builtKind === undefined)) context.addIssue({ code: "custom", message: "a founded place records what was built" });
  if (parcel.builtBy !== undefined && parcel.placeId === undefined) context.addIssue({ code: "custom", message: "only a founded place records who built it" });
  if (parcel.id !== `parcel:${parcel.ring}:${parcel.slot}` || parcel.slot >= 8 * parcel.ring) context.addIssue({ code: "custom", message: "parcel id must name its ring and an existing slot" });
  if ((parcel.state === "charted") !== (parcel.chartedMinute !== undefined) || (parcel.state === "charted") !== (parcel.effort === FRONTIER_CHART_EFFORT)) context.addIssue({ code: "custom", message: "a parcel is charted exactly when its effort is complete and its minute recorded" });
  if (parcel.contributors.some((c, i) => i > 0 && parcel.contributors[i - 1]! >= c)) context.addIssue({ code: "custom", message: "contributors are unique and in id order" });
});
export type FrontierParcel = z.infer<typeof FrontierParcelSchema>;
/** The waterside promenade: the place a quay worksite is worked from (the kernel's FRONTIER_WORK_PLACE_ID). */
export const FRONTIER_QUAY_PLACE_ID = "city-promenade";
/**
 * Whether a walk joins two charted parcels across charted ground alone, each step to a parcel sharing an edge
 * (never across fog). The kernel plans a ground trip over the same ground; charted ground never returns to fog,
 * so a worksite reachable when the trip began stays reachable.
 */
export function frontierGroundDistance(parcels: Readonly<Record<string, FrontierParcel>>, fromId: string, toId: string): number | undefined {
  const charted = (parcelId: string) => Object.hasOwn(parcels, parcelId) && parcels[parcelId]!.state === "charted" ? parcels[parcelId] : undefined;
  const start = charted(fromId);
  if (!start || !charted(toId)) return undefined;
  const seen = new Map([[start.id, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const parcel = queue[index]!;
    if (parcel.id === toId) return seen.get(parcel.id)!;
    const { ring, slot } = parcel, span = 8 * ring, firstChild = Math.floor((slot * (ring + 1)) / ring);
    // Candidates: both ring neighbours, the inward parent, and the (at most three) outward slots; the edge rule decides.
    const candidates: [number, number][] = [[ring, (slot + 1) % span], [ring, (slot + span - 1) % span], [ring - 1, Math.floor((slot * (ring - 1)) / ring)]];
    for (let child = firstChild; child <= firstChild + 2; child += 1) candidates.push([ring + 1, child]);
    for (const [r, s] of candidates) {
      const next = charted(`parcel:${r}:${s}`);
      if (!next || seen.has(next.id) || !frontierParcelsShareEdge(parcel, next)) continue;
      seen.set(next.id, seen.get(parcel.id)! + 1);
      queue.push(next);
    }
  }
  return undefined;
}
export function frontierGroundConnects(parcels: Readonly<Record<string, FrontierParcel>>, fromId: string, toId: string): boolean {
  return frontierGroundDistance(parcels, fromId, toId) !== undefined;
}
export const ResidentLifeStateSchema = z.object({
  residents: z.record(id, ResidentLifeProfileSchema), resources: z.record(id, LifeResourceSchema),
  projects: z.record(id, LifeProjectSchema), commitments: z.record(id, LifeCommitmentSchema),
  /** Present only in city-life-2 worlds. */
  ventures: VentureLedgerSchema.optional(),
  invention: InventionStateSchema.optional(),
  /** Absent until the first survey completes, so worlds saved before cartography stay byte-identical. */
  charts: z.record(id, ChartEntrySchema).refine(
    (charts) => Object.entries(charts).every(([key, entry]) => entry.placeId === key),
    { message: "chart entries must be keyed by their place" },
  ).optional(),
  /** Absent until the frontier opens (D-8), so worlds without it stay byte-identical. */
  frontier: z.record(id, FrontierParcelSchema).refine(
    (parcels) => Object.entries(parcels).every(([key, parcel]) => parcel.id === key),
    { message: "frontier parcels must be keyed by their id" },
  ).optional(),
  /** Absent until the frontier-access cutover, so worlds saved before it stay byte-identical. */
  frontierAccess: FrontierAccessPolicySchema.optional(),
  /** Absent until Meridian Central is commissioned, so worlds without transit stay byte-identical. */
  transit: TransitStateSchema.optional(),
  /** Absent until the owned wardrobe is explicitly opened, so worlds without it stay byte-identical. */
  wardrobe: WardrobeStateSchema.optional(),
}).strict();
export type ResidentLifeState = z.infer<typeof ResidentLifeStateSchema>;
export const ResidentActionOptionSchema = z.object({
  id, kind: ResidentActionKindSchema, label: z.string().min(1).max(160),
  partnerId: id.optional(), resourceId: id.optional(), projectId: id.optional(), commitmentId: id.optional(), ventureId: id.optional(), placeId: id.optional(), parcelId: id.optional(),
}).strict();
export type ResidentActionOption = z.infer<typeof ResidentActionOptionSchema>;
export const ResidentActionProposalSchema = z.object({
  residentId: id, observedMinute: minute, optionId: id, source: z.enum(["local-model", "engine"]),
}).strict();
export type ResidentActionProposal = z.infer<typeof ResidentActionProposalSchema>;
/**
 * A model resident's choice made while they were busy: their next action. Applied the moment the engine
 * frees them, if it is still a legal option then; otherwise the engine chooses as usual (D-1).
 */
export const ResidentNextActionSchema = z.object({ residentId: id, optionId: id, source: z.literal("local-model") }).strict();
export type ResidentNextAction = z.infer<typeof ResidentNextActionSchema>;
export const ResidentLifeChangedEventSchema = z.object({ type: z.literal("resident-life-changed"), minute, residentId: id, before: ResidentLifeProfileSchema, after: ResidentLifeProfileSchema }).strict();
export const LifeResourceChangedEventSchema = z.object({ type: z.literal("life-resource-changed"), minute, resourceId: id, before: LifeResourceSchema, after: LifeResourceSchema }).strict();
export const LifeProjectChangedEventSchema = z.object({ type: z.literal("life-project-changed"), minute, projectId: id, before: LifeProjectSchema, after: LifeProjectSchema }).strict();
/** A place was surveyed. `before` is null the first time the place is charted. */
export const LifeChartChangedEventSchema = z.object({ type: z.literal("life-chart-changed"), minute, placeId: id, before: ChartEntrySchema.nullable(), after: ChartEntrySchema }).strict();
/** A parcel was worked on, charted or revealed. `before` is null when the parcel first appears under fog. */
export const LifeFrontierChangedEventSchema = z.object({ type: z.literal("life-frontier-changed"), minute, parcelId: id, before: FrontierParcelSchema.nullable(), after: FrontierParcelSchema }).strict();
/** One-time zero-minute migration that opens the frontier: the first ring of parcels, all under fog. */
/** Residents finished building on the frontier: a new public place now exists (D-8, F-P4). */
export const PlaceFoundedEventSchema = z.object({
  type: z.literal("place-founded"), minute, placeId: id, parcelId: id,
  place: z.object({ id, name: z.string().min(1).max(120), kind: z.enum(["civic", "residence"]) }).strict(),
}).strict().refine((event) => event.place.id === event.placeId, { message: "founded place must match its id" });
export const FrontierOpenedEventSchema = z.object({
  type: z.literal("frontier-opened"), minute,
  parcels: z.record(id, FrontierParcelSchema).refine(
    (parcels) => Object.keys(parcels).length > 0 && Object.entries(parcels).every(([key, p]) => p.id === key && p.state === "fog" && p.effort === 0 && p.contributors.length === 0),
    { message: "the frontier opens with fresh fog parcels keyed by id" },
  ),
}).strict();
/**
 * One-time zero-minute cutover to frontier access policy 1: from the next minute every new frontier shift
 * travels to a real worksite and earns only while there. Shifts already under way finish as accepted.
 */
export const FrontierAccessEnabledEventSchema = z.object({
  type: z.literal("frontier-access-enabled"), minute, after: FrontierAccessPolicySchema,
}).strict().refine((event) => event.after.enabledMinute === event.minute, { message: "frontier access is enabled at its own minute" });
export const LifeCommitmentChangedEventSchema = z.object({ type: z.literal("life-commitment-changed"), minute, commitmentId: id, before: LifeCommitmentSchema.nullable(), after: LifeCommitmentSchema.nullable() }).strict();
export const ResidentActionResolvedEventSchema = z.object({
  type: z.literal("resident-action-resolved"), minute, residentId: id, optionId: id,
  source: z.enum(["local-model", "engine"]), outcome: z.enum(["accepted", "rejected"]),
  reason: z.enum(["legal-option", "stale-observation", "unknown-resident", "invalid-option", "contradictory-proposals", "partner-unavailable"]),
}).strict().refine((event) => (event.outcome === "accepted") === (event.reason === "legal-option"), { message: "resolution outcome must agree with its reason" });
export type ResidentActionResolvedEvent = z.infer<typeof ResidentActionResolvedEventSchema>;
export const ResidentAppearancesMigratedEventSchema = z.object({
  type: z.literal("resident-appearances-migrated"), minute,
  assignments: z.record(id, ResidentAppearanceProfileSchema).refine((assignments) => Object.keys(assignments).length > 0, { message: "appearance migration requires assignments" }),
}).strict();
/** One-time zero-minute cutover that lets residents choose their own appearance from the wardrobe catalogue. */
export const WardrobeOpenedEventSchema = z.object({ type: z.literal("wardrobe-opened"), minute, wardrobe: WardrobeStateSchema }).strict();
/** One-time zero-minute migration that adds civic improvement projects to an existing city-life-2 world. */
export const CivicProjectsMigratedEventSchema = z.object({
  type: z.literal("civic-projects-migrated"), minute,
  projects: z.record(id, LifeProjectSchema).refine(
    (projects) => Object.keys(projects).length > 0 && Object.entries(projects).every(([key, project]) => project.id === key && project.kind === "civic" && project.progress === 0),
    { message: "civic migration requires new civic projects keyed by id at zero progress" },
  ),
}).strict();
