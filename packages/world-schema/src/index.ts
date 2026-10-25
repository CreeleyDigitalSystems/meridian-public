import * as invention from "./invention.js";
import { assertOriginalPresentations } from "./resident-appearance.js";
export * from "./invention.js";
import { z } from "zod";
import { ResidentLifeStateSchema, ResidentActionProposalSchema, ResidentNextActionSchema, ResidentLifeProfileSchema, ResidentLifeChangedEventSchema, LifeResourceChangedEventSchema, LifeProjectChangedEventSchema, LifeChartChangedEventSchema, LifeFrontierChangedEventSchema, FrontierOpenedEventSchema, FrontierAccessEnabledEventSchema, PlaceFoundedEventSchema, LifeCommitmentChangedEventSchema, ResidentActionResolvedEventSchema, ResidentAppearancesMigratedEventSchema, CivicProjectsMigratedEventSchema, FRONTIER_QUAY_PLACE_ID, frontierGroundConnects, frontierGroundDistance, RESIDENT_CITY_WALK_MINUTES, RESIDENT_FRONTIER_STEP_MINUTES, FRONTIER_SHIFT_MINUTES, frontierParcelsShareEdge, WardrobeOpenedEventSchema } from "./resident-life.js";
import { VentureChangedEventSchema, VentureCountersChangedEventSchema, VentureResourceChangedEventSchema } from "./venture.js";
import { TransitChangedEventSchema, TransitCommissionedEventSchema } from "./transit.js";
export * from "./public-world.js";
export * from "./resident-life.js";
export * from "./resident-appearance.js";
export * from "./venture.js";
export * from "./transit.js";
export * from "./ai-decision-history.js";
export * from "./resident-discovery-view.js";

const nonnegativeInteger = z.number().int().nonnegative();
const minuteOfDay = z.number().int().min(0).max(1439);

export const IdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid identifier");

export const PlaceKindSchema = z.enum(["residence", "workplace", "civic", "construction"]);

export const PlaceStateSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    kind: PlaceKindSchema,
  })
  .strict();

export type PlaceState = z.infer<typeof PlaceStateSchema>;

export const ResidentActivitySchema = z.enum(["home", "work", "leisure"]);

export type ResidentActivity = z.infer<typeof ResidentActivitySchema>;

export const ScheduleEntrySchema = z
  .object({
    startMinute: minuteOfDay,
    activity: ResidentActivitySchema,
    placeId: IdentifierSchema,
    task: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ResidentStateSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    occupation: z.string().trim().min(1).max(80).optional(),
    /** Absent means adult, so worlds saved before children existed parse unchanged. */
    lifeStage: z.literal("child").optional(),
    age: z.number().int().min(0).max(17).optional(),
    homePlaceId: IdentifierSchema,
    workPlaceId: IdentifierSchema,
    placeId: IdentifierSchema,
    activity: ResidentActivitySchema,
    schedule: z.array(ScheduleEntrySchema).min(1),
  })
  .strict()
  .superRefine((resident, context) => {
    if (resident.age !== undefined && resident.lifeStage === undefined) {
      context.addIssue({ code: "custom", message: "age is only allowed with lifeStage", path: ["age"] });
    }
    if (resident.lifeStage === "child") {
      if (resident.occupation !== undefined) {
        context.addIssue({ code: "custom", message: "a child cannot have an occupation", path: ["occupation"] });
      }
      if (resident.workPlaceId !== resident.homePlaceId) {
        context.addIssue({ code: "custom", message: "a child's workPlaceId must equal homePlaceId", path: ["workPlaceId"] });
      }
    }

    if (resident.schedule[0]?.startMinute !== 0) {
      context.addIssue({
        code: "custom",
        message: "schedule must begin at minute 0",
        path: ["schedule", 0, "startMinute"],
      });
    }

    for (let index = 1; index < resident.schedule.length; index += 1) {
      const previous = resident.schedule[index - 1];
      const current = resident.schedule[index];
      if (previous !== undefined && current !== undefined && current.startMinute <= previous.startMinute) {
        context.addIssue({
          code: "custom",
          message: "schedule entries must have strictly increasing start minutes",
          path: ["schedule", index, "startMinute"],
        });
      }
    }
  });

export type ResidentState = z.infer<typeof ResidentStateSchema>;

export const ConstructionStageSchema = z.enum([
  "foundation",
  "frame",
  "enclosure",
  "fitout",
  "complete",
]);

export type ConstructionStage = z.infer<typeof ConstructionStageSchema>;

export const ConstructionStageEntrySchema = z
  .object({
    stage: ConstructionStageSchema,
    startMinute: nonnegativeInteger,
  })
  .strict();

export type ConstructionStageEntry = z.infer<typeof ConstructionStageEntrySchema>;

const constructionStages: readonly ConstructionStage[] = [
  "foundation",
  "frame",
  "enclosure",
  "fitout",
  "complete",
];

export const ConstructionStateSchema = z
  .object({
    id: IdentifierSchema,
    placeId: IdentifierSchema,
    stage: ConstructionStageSchema,
    stageSchedule: z.array(ConstructionStageEntrySchema).length(constructionStages.length),
  })
  .strict()
  .superRefine((construction, context) => {
    construction.stageSchedule.forEach((entry, index) => {
      if (entry.stage !== constructionStages[index]) {
        context.addIssue({
          code: "custom",
          message: "construction stages must use the founding progression order",
          path: ["stageSchedule", index, "stage"],
        });
      }

      const previous = construction.stageSchedule[index - 1];
      if (previous !== undefined && entry.startMinute <= previous.startMinute) {
        context.addIssue({
          code: "custom",
          message: "construction stages must have strictly increasing start minutes",
          path: ["stageSchedule", index, "startMinute"],
        });
      }
    });
  });

export type ConstructionState = z.infer<typeof ConstructionStateSchema>;

export const WorldStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.enum(["founding-1", "city-1", "city-life-1", "city-life-2"]),
    seed: z.string().min(1),
    canonicalMinute: nonnegativeInteger,
    places: z.record(IdentifierSchema, PlaceStateSchema),
    residents: z.record(IdentifierSchema, ResidentStateSchema),
    construction: ConstructionStateSchema,
    life: ResidentLifeStateSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const lifeEngine = state.engineVersion === "city-life-1" || state.engineVersion === "city-life-2";
    if (lifeEngine !== (state.life !== undefined)) {
      context.addIssue({ code: "custom", path: ["life"], message: "life is required only for city-life engines" });
    }
    if (state.life && (state.engineVersion === "city-life-2") !== (state.life.ventures !== undefined)) {
      context.addIssue({ code: "custom", path: ["life", "ventures"], message: "ventures are required for city-life-2 and forbidden otherwise" });
    }
    if (state.life) {
      const life = state.life;
      for (const message of invention.inventionReferenceProblems(state)) context.addIssue({code:"custom",path:["life","invention"],message});
      const issue = (message: string) => context.addIssue({ code: "custom", path: ["life"], message });
      const residentExists = (id: string) => Object.hasOwn(state.residents, id);
      if (life.wardrobe?.originals) {
        try { assertOriginalPresentations(state.residents, life.wardrobe.originals, false); }
        catch (error) { issue(error instanceof Error ? error.message : "invalid original presentation bindings"); }
      }
      if (Object.keys(life.residents).sort().join("|") !== Object.keys(state.residents).sort().join("|")) issue("life resident ids must exactly match world residents");
      /** The charted parcel a place was founded on beyond the water; undefined for every city place. */
      let founded: Map<string, NonNullable<typeof life.frontier>[string]> | undefined;
      const foundedOn = (placeId: string) => (founded ??= new Map(Object.values(life.frontier ?? {}).filter((p) => p.state === "charted").flatMap((p) => [...(p.placeId ? [[p.placeId, p] as const] : []), ...(Object.hasOwn(state.places, `landing-${p.ring}-${p.slot}`) ? [[`landing-${p.ring}-${p.slot}`, p] as const] : [])]))).get(placeId);
      for (const [id, profile] of Object.entries(life.residents)) {
        if (id !== profile.residentId) issue("life profile key must match resident id");
        if (Object.keys(profile.trust).some((other) => !residentExists(other) || other === id)) issue("invalid trust partner");
        const task = profile.task;
        if (task && task.startedMinute > state.canonicalMinute) issue("current task cannot start in the future");
        if (task && (!Object.hasOwn(state.places, task.placeId) || (task.partnerId && (!residentExists(task.partnerId) || task.partnerId === id)) || (task.resourceId && !Object.hasOwn(life.resources, task.resourceId)) || (task.projectId && !Object.hasOwn(life.projects, task.projectId)) || (task.commitmentId && !Object.hasOwn(life.commitments, task.commitmentId)) || (task.ventureId && !(life.ventures && (Object.hasOwn(life.ventures.projects, task.ventureId) || life.ventures.retired.some((v) => v.id === task.ventureId)))))) issue("invalid task reference");
        // A saved journey crosses the water once on the commissioned circuit: from one side's place to the other's,
        // with its ride leaving from that side, and the traveller stays where they set out until they arrive.
        if (task?.journey) {
          const journey = task.journey;
          const founded = (placeId: string) => foundedOn(placeId) !== undefined;
          if (!life.transit || !Object.hasOwn(state.places, journey.fromPlaceId) || founded(journey.fromPlaceId) === founded(task.placeId)
            || founded(journey.fromPlaceId) !== (journey.ride.to === null)
            || (state.canonicalMinute < journey.arrivesMinute && state.residents[id]?.placeId !== journey.fromPlaceId)) issue("invalid transit journey");
        }
        if(task?.returnTrip) {
          const back=task.returnTrip,target=life.frontier?.[back.targetParcelId];
          const source=profile.memories.some(m=>m.minute===task.startedMinute&&m.parcelId===back.targetParcelId&&["frontier-surveyed","frontier-charted","build-worked","place-founded"].includes(m.outcome));
          if(!life.transit||!life.frontierAccess||!target||!source||!Object.hasOwn(state.places,back.fromPlaceId))issue("a frontier return retains an actual settled worksite source");
          if(back.site.kind==="quay") {
            if(back.fromPlaceId!==FRONTIER_QUAY_PLACE_ID||foundedOn(task.placeId)||target?.ring!==1||target.slot!==back.site.sector||task.endsMinute-task.startedMinute!==RESIDENT_CITY_WALK_MINUTES)issue("a quay return walks back to the city door");
          } else {
            const anchor=foundedOn(task.placeId),ground=life.frontier?.[back.site.parcelId];
            const hops=anchor&&ground?.state==="charted"?frontierGroundDistance(life.frontier??{},back.site.parcelId,anchor.id):undefined;
            if(back.fromPlaceId!==task.placeId||hops===undefined||task.endsMinute-task.startedMinute<(hops+1)*RESIDENT_FRONTIER_STEP_MINUTES)issue("a frontier return follows admitted charted ground for its full saved duration");
          }
        }
        if (task?.walk) {
          const walk=task.walk, from=foundedOn(walk.fromPlaceId), to=foundedOn(task.placeId);
          if(!life.transit || task.startedMinute<=life.transit.commissionedMinute || !Object.hasOwn(state.places,walk.fromPlaceId)) issue("a recorded walk requires existing places and commissioned movement");
          const hops=from&&to?frontierGroundDistance(life.frontier??{},from.id,to.id):undefined;
          if(from||to) {
            if(hops===undefined || walk.arrivesMinute-task.startedMinute<Math.max(1,hops)*RESIDENT_FRONTIER_STEP_MINUTES) issue("a ground walk follows connected charted ground for its full duration");
          } else if(walk.arrivesMinute-task.startedMinute!==RESIDENT_CITY_WALK_MINUTES) issue("a city walk takes its admitted duration");
        }
        // An owned look is chosen only from an opened wardrobe, and only by an adult (no child wears an adult look).
        if (profile.appearance?.presentation.look !== undefined && (!life.wardrobe || state.residents[id]?.lifeStage === "child")) issue("a chosen look requires an opened wardrobe and an adult");
        if (profile.memories.some((m) => m.minute > state.canonicalMinute || (m.partnerId && !residentExists(m.partnerId)) || (m.resourceId && !Object.hasOwn(life.resources, m.resourceId)) || (m.projectId && !Object.hasOwn(life.projects, m.projectId)))) issue("invalid factual memory reference or future minute");
        // Frontier access policy 1: a new shift travels to a real worksite; one accepted before the cutover finishes as it was.
        if (task?.trip) {
          if (!life.frontierAccess || task.startedMinute <= life.frontierAccess.enabledMinute) issue("a frontier trip requires frontier access enabled before it began");
          if (!Object.hasOwn(state.places, task.trip.fromPlaceId)) issue("invalid task reference");
          const site = task.trip.site;
          if (site.kind === "ground" && !(life.frontier && Object.hasOwn(life.frontier, site.parcelId) && life.frontier[site.parcelId]!.state === "charted")) issue("a frontier worksite stands on charted ground");
          // Charting is done from charted ground sharing an edge with the fog it faces, never from anywhere charted.
          const target = life.frontier && task.parcelId && Object.hasOwn(life.frontier, task.parcelId) ? life.frontier[task.parcelId] : undefined;
          const ground = site.kind === "ground" && life.frontier && Object.hasOwn(life.frontier, site.parcelId) ? life.frontier[site.parcelId] : undefined;
          if (!target) issue("invalid task reference");
          else if (task.kind !== "build" && ground && !frontierParcelsShareEdge(ground, target)) issue("a frontier worksite borders the fog it faces");
          // The shift is credited only where it is worked, so its place is bound to the worksite: the waterside for a
          // quay reached on foot from the city, or the founded place beyond the water it set out from, joined to the
          // worksite by charted ground. Neither is a crossing; this policy grants none.
          if (site.kind === "quay") {
            if (task.placeId !== FRONTIER_QUAY_PLACE_ID || foundedOn(task.trip.fromPlaceId)) issue("a quay worksite is reached on foot from the city and worked from the waterside");
          } else {
            const standing = task.placeId === task.trip.fromPlaceId || task.journey ? foundedOn(task.placeId) : undefined;
            if (!standing || !frontierGroundConnects(life.frontier!, standing.id, site.parcelId)) issue("a ground worksite is reached across charted ground from the founded place it set out from");
          }
          if (task.endsMinute-task.trip.arrivesMinute!==FRONTIER_SHIFT_MINUTES) issue("a frontier shift works its full duration after arrival");
          if(site.kind==="quay" && task.trip.arrivesMinute-task.startedMinute!==RESIDENT_CITY_WALK_MINUTES) issue("a quay walk takes its admitted duration");
          if(site.kind==="ground") {
            const origin=task.journey?foundedOn(task.placeId):foundedOn(task.trip.fromPlaceId);
            const distance=origin?frontierGroundDistance(life.frontier??{},origin.id,site.parcelId):undefined;
            const groundStart=task.journey?.ride.arriveMinute??task.startedMinute;
            if(distance===undefined || task.trip.arrivesMinute-groundStart<(distance+1)*RESIDENT_FRONTIER_STEP_MINUTES) issue("a frontier ground trip takes its admitted distance");
            if(task.journey && (task.journey.arrivesMinute!==task.trip.arrivesMinute || task.journey.fromPlaceId!==task.trip.fromPlaceId || task.journey.ride.to!==origin?.id)) issue("a frontier crossing is bound to its landing and worksite");
          }
          if (task.trip.phase === "working" && task.trip.arrivesMinute > state.canonicalMinute) issue("a frontier trip cannot arrive before its arrival minute");
        } else if (task && life.frontierAccess && (task.kind === "chart-frontier" || task.kind === "help-chart" || task.kind === "build") && task.startedMinute > life.frontierAccess.enabledMinute) {
          issue("a frontier shift begun after the access cutover must travel to its worksite");
        }
      }
      if (life.frontierAccess && !life.frontier) issue("frontier access requires an open frontier");
      if (life.frontierAccess && life.frontierAccess.enabledMinute > state.canonicalMinute) issue("frontier access cannot be enabled in the world's future");
      // Children stay home with family: never away from home, never working, never in a venture or commitment.
      const children = new Set(Object.values(state.residents).filter((r) => r.lifeStage === "child").map((r) => r.id));
      if (children.size > 0) {
        for (const id of children) {
          const resident = state.residents[id]!;
          if (resident.placeId !== resident.homePlaceId) issue("a child must be at home");
          if (resident.activity !== "home") issue("a child's activity must be home");
          const task = life.residents[id]?.task;
          if (task && (task.kind !== "rest" || task.placeId !== resident.homePlaceId || task.ventureId || task.projectId || task.commitmentId || task.resourceId || task.partnerId)) issue("a child may only hold a home rest task");
        }
        for (const venture of [...Object.values(life.ventures?.projects ?? {}), ...(life.ventures?.retired ?? [])]) {
          if (children.has(venture.proposerId) || venture.participants.some((p) => children.has(p.residentId))) issue("a child cannot appear in a venture");
        }
        for (const commitment of Object.values(life.commitments)) if (children.has(commitment.requesterId) || children.has(commitment.lenderId)) issue("a child cannot appear in a commitment");
        for (const resource of Object.values(life.resources)) if (children.has(resource.ownerId)) issue("a child cannot own a project resource");
        for (const profile of Object.values(life.residents)) if (!children.has(profile.residentId) && profile.task?.partnerId && children.has(profile.task.partnerId)) issue("a child cannot be a task partner");
        for (const chart of Object.values(life.charts ?? {})) if (children.has(chart.surveyorId)) issue("a child cannot survey");
      }
      for (const [id, resource] of Object.entries(life.resources)) if (id !== resource.id || !residentExists(resource.ownerId)) issue("resource must have one existing owner");
      for (const [id, project] of Object.entries(life.projects)) if (id !== project.id || !Object.hasOwn(state.places, project.placeId)) issue("invalid project reference");
      const occupied = new Set<string>();
      for (const [id, commitment] of Object.entries(life.commitments)) {
        if (id !== commitment.id || commitment.requesterId === commitment.lenderId || !residentExists(commitment.requesterId) || !residentExists(commitment.lenderId) || !Object.hasOwn(life.resources, commitment.resourceId) || !Object.hasOwn(life.projects, commitment.projectId) || state.places[commitment.placeId]?.kind !== "civic") issue("invalid commitment reference");
        if (["pending", "meeting", "loaned", "returning"].includes(commitment.status)) {
          if (occupied.has(commitment.resourceId)) issue("resource has conflicting commitments");
          occupied.add(commitment.resourceId);
          const expectedOwner = ["loaned", "returning"].includes(commitment.status) ? commitment.requesterId : commitment.lenderId;
          if (life.resources[commitment.resourceId]?.ownerId !== expectedOwner) issue("commitment disagrees with resource ownership");
        }
      }
    }
    const residentCount = Object.keys(state.residents).length;
    if (state.engineVersion === "founding-1" ? residentCount !== 12 : residentCount < 1 || residentCount > 512) {
      context.addIssue({
        code: "custom",
        message: state.engineVersion === "founding-1"
          ? "founding state requires 12 residents"
          : "city state requires between 1 and 512 residents",
        path: ["residents"],
      });
    }

    for (const [placeId, place] of Object.entries(state.places)) {
      if (place.id !== placeId) {
        context.addIssue({
          code: "custom",
          message: "place record key must match place id",
          path: ["places", placeId, "id"],
        });
      }
    }

    for (const [residentId, resident] of Object.entries(state.residents)) {
      if (resident.id !== residentId) {
        context.addIssue({
          code: "custom",
          message: "resident record key must match resident id",
          path: ["residents", residentId, "id"],
        });
      }

      const placeReferences: Array<[string, string]> = [
        ["homePlaceId", resident.homePlaceId],
        ["workPlaceId", resident.workPlaceId],
        ["placeId", resident.placeId],
      ];
      resident.schedule.forEach((entry, index) => {
        placeReferences.push([`schedule.${index}.placeId`, entry.placeId]);
      });

      for (const [field, placeId] of placeReferences) {
        if (!Object.hasOwn(state.places, placeId)) {
          context.addIssue({
            code: "custom",
            message: `resident place reference does not exist: ${placeId}`,
            path: ["residents", residentId, ...field.split(".")],
          });
        }
      }
    }

    if (!Object.hasOwn(state.places, state.construction.placeId)) {
      context.addIssue({
        code: "custom",
        message: `construction place reference does not exist: ${state.construction.placeId}`,
        path: ["construction", "placeId"],
      });
    }
  });

export type WorldState = z.infer<typeof WorldStateSchema>;

export const ClockAdvancedEventSchema = z
  .object({
    type: z.literal("clock-advanced"),
    minute: nonnegativeInteger,
    fromMinute: nonnegativeInteger,
    toMinute: nonnegativeInteger,
  })
  .strict();

export const ResidentActivityChangedEventSchema = z
  .object({
    type: z.literal("resident-activity-changed"),
    minute: nonnegativeInteger,
    residentId: IdentifierSchema,
    fromActivity: ResidentActivitySchema,
    toActivity: ResidentActivitySchema,
  })
  .strict();

export const ResidentLocationChangedEventSchema = z
  .object({
    type: z.literal("resident-location-changed"),
    minute: nonnegativeInteger,
    residentId: IdentifierSchema,
    fromPlaceId: IdentifierSchema,
    toPlaceId: IdentifierSchema,
  })
  .strict();

export const ConstructionStageProgressedEventSchema = z
  .object({
    type: z.literal("construction-stage-progressed"),
    minute: nonnegativeInteger,
    constructionId: IdentifierSchema,
    fromStage: ConstructionStageSchema,
    toStage: ConstructionStageSchema,
  })
  .strict();

/** Historical household event: every changed value carries its before and after. */
export const FamilyFormedEventSchema = z
  .object({
    type: z.literal("family-formed"),
    minute: nonnegativeInteger,
    residents: z
      .record(IdentifierSchema, z.object({ before: ResidentStateSchema.nullable(), after: ResidentStateSchema }).strict())
      .refine((residents) => Object.keys(residents).length > 0, { message: "family formation requires residents" }),
    places: z.record(IdentifierSchema, z.object({ before: PlaceStateSchema, after: PlaceStateSchema }).strict()),
    lifeProfiles: z.record(IdentifierSchema, z.object({ before: ResidentLifeProfileSchema.nullable(), after: ResidentLifeProfileSchema }).strict()),
  })
  .strict();

export type FamilyFormedEvent = z.infer<typeof FamilyFormedEventSchema>;

/** A resident moved into a home built on the frontier: their home and the home blocks of their day change together. */
const HomeAndScheduleSchema = z.object({ homePlaceId: IdentifierSchema, schedule: z.array(ScheduleEntrySchema).min(1) }).strict();
export const ResidentMovedHomeEventSchema = z
  .object({ type: z.literal("resident-moved-home"), minute: nonnegativeInteger, residentId: IdentifierSchema, before: HomeAndScheduleSchema, after: HomeAndScheduleSchema })
  .strict();

export const WorldEventSchema = z.discriminatedUnion("type", [
  invention.InventionMethodChangedEventSchema, invention.InventionSiteChangedEventSchema, invention.InventionAgendaChangedEventSchema, invention.InventionConsultationChangedEventSchema, invention.InventionDesignChangedEventSchema, invention.InventionArtifactChangedEventSchema, invention.InventionTrialChangedEventSchema, invention.InventionGrantChangedEventSchema, invention.InventionJobChangedEventSchema, invention.InventionCountersChangedEventSchema, invention.InventionEnabledEventSchema, invention.InventionCommandResolvedEventSchema,
  ClockAdvancedEventSchema,
  ResidentActivityChangedEventSchema,
  ResidentLocationChangedEventSchema,
  ConstructionStageProgressedEventSchema,
  ResidentLifeChangedEventSchema,
  LifeResourceChangedEventSchema,
  LifeProjectChangedEventSchema,
  LifeChartChangedEventSchema,
  LifeFrontierChangedEventSchema,
  FrontierOpenedEventSchema,
  FrontierAccessEnabledEventSchema,
  PlaceFoundedEventSchema,
  ResidentMovedHomeEventSchema,
  LifeCommitmentChangedEventSchema,
  ResidentActionResolvedEventSchema,
  ResidentAppearancesMigratedEventSchema,
  CivicProjectsMigratedEventSchema,
  WardrobeOpenedEventSchema,
  FamilyFormedEventSchema,
  VentureChangedEventSchema,
  VentureResourceChangedEventSchema,
  VentureCountersChangedEventSchema,
  TransitCommissionedEventSchema,
  TransitChangedEventSchema,
]);

export type WorldEvent = z.infer<typeof WorldEventSchema>;

export const WorldCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("advance-clock"),
      targetMinute: nonnegativeInteger,
      proposals: z.array(ResidentActionProposalSchema).max(512).optional(),
      nextActions: z.array(ResidentNextActionSchema).max(64).optional(),
      inventionCommands: z.array(invention.InventionCommandSchema).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("inspect-resident"),
      residentId: IdentifierSchema,
    })
    .strict(),
]);

export type WorldCommand = z.infer<typeof WorldCommandSchema>;

export const WorldSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(1),
    state: WorldStateSchema,
    ledgerBaseSequence: nonnegativeInteger,
    ledgerBaseHash: z.string().regex(/^[0-9a-f]{64}$/, "invalid ledger base hash"),
  })
  .strict();

export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;

export function parseWorldCommand(input: unknown): WorldCommand {
  return WorldCommandSchema.parse(input);
}

export function parseWorldSnapshot(input: unknown): WorldSnapshot {
  return WorldSnapshotSchema.parse(input);
}
