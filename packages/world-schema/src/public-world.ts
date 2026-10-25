import { z } from 'zod';
import { ResidentAppearanceProfileSchema, OriginalPresentationSchema, AccessorySchema, FootwearSchema, GarmentSchema, HairStyleSchema, TrouserSchema, WARDROBE_LOOKS } from './resident-appearance.js';
import { TRANSIT_MAX_PATH, TRANSIT_MAX_STOPS, transitCourseIssues } from './transit.js';
const FrontierBuildKindSchema = z.enum(['gathering-hall', 'garden-terrace', 'lookout', 'market-stalls', 'workshop', 'home']);
const VentureStatusSchema = z.enum(['proposed', 'planning', 'resourcing', 'active', 'completed', 'failed', 'abandoned']);
const VentureConsentSchema = z.enum(['invited', 'accepted', 'declined', 'expired']);
const VentureOutcomeReasonSchema = z.enum(['all-steps-complete', 'consent-declined', 'consent-timeout', 'resources-unavailable', 'unknown-resource', 'deadline-passed', 'participant-withdrew', 'abandoned-by-proposer']);

/** Public identifiers are presentation ordinals in a private admission registry, never canonical IDs. */
export const PublicKindSchema = z.enum(['resident', 'place', 'object', 'project', 'parcel', 'venture', 'commitment', 'construction', 'workpad', 'agenda', 'consultation', 'design', 'artifact', 'trial', 'assembly-job', 'method', 'grant']);
export type PublicKind = z.infer<typeof PublicKindSchema>;
const integer = z.number().int().safe().nonnegative();
const positive = integer.min(1),
  percent = integer.max(100);
const ref = <K extends PublicKind,>(kind: K) => z.object({
  kind: z.literal(kind),
  id: positive
}).strict();
const resident = ref('resident'),
  place = ref('place'),
  object = ref('object'),
  project = ref('project'),
  parcel = ref('parcel'),
  venture = ref('venture'),
  commitment = ref('commitment'),
  construction = ref('construction'),
  workpad = ref('workpad'),
  agenda = ref('agenda'),
  consultation = ref('consultation'),
  design = ref('design'),
  artifact = ref('artifact'),
  trial = ref('trial'),
  assemblyJob = ref('assembly-job'),
  method = ref('method'),grant=ref('grant');
export const PublicRefSchema = z.object({
  kind: PublicKindSchema,
  id: positive
}).strict();
export type PublicRef = z.infer<typeof PublicRefSchema>;
export const PUBLIC_GIVEN_NAMES = ['Ari', 'Bea', 'Cai', 'Dara', 'Emi', 'Finn', 'Gia', 'Hale', 'Ira', 'Juno', 'Kit', 'Lux', 'Mira', 'Nico', 'Ori', 'Pia'] as const;
export const PUBLIC_FAMILY_NAMES = ['Vale', 'Rowan', 'Mercer', 'Venn', 'Solis', 'Alder', 'North', 'Quinn', 'Moss', 'Reed', 'Lane', 'Arden', 'Stone', 'Wren', 'Linden', 'Ash', 'Rivers', 'Harlow', 'Finch', 'Lark', 'Dove', 'Marsh', 'Sage', 'Perry', 'Hollis', 'Wilder', 'Aster', 'Brook', 'Ember', 'Hart', 'Lowen', 'Marlow'] as const;
const nameKeys = ['alias', 'sol', 'luna', ...PUBLIC_GIVEN_NAMES.flatMap((_, g) => PUBLIC_FAMILY_NAMES.map((_, f) => `catalogue-${g}-${f}`))] as [string, ...string[]];
export const PublicNameKeySchema = z.enum(nameKeys);
export const PublicOccupationSchema = z.enum(['gardener', 'baker', 'builder', 'archivist', 'ceramicist', 'transit-steward', 'water-keeper', 'weaver', 'cook', 'instrument-maker', 'cartographer', 'market-keeper', 'child', 'unavailable']);
export const PublicTaskKindSchema = z.enum(['frontier-return', 'work', 'rest', 'socialise', 'wait-tool', 'handover', 'use-tool', 'return-tool', 'venture-work', 'invention-build', 'assembly-trial', 'invention-teach', 'invention-travel', 'survey', 'chart-frontier', 'help-chart', 'build']);
const origin = z.enum(['engine', 'world-only-model', 'historical-unclassified']);
const labelKey = z.enum(['unavailable', 'public-garden', 'square-benches', 'promenade-lanterns', 'market-planters', 'public-map-boards']);
const material = z.object({
  material: z.enum(['timber', 'stone']),
  quantity: positive.max(1000000)
}).strict();
const appearance = ResidentAppearanceProfileSchema.omit({
  latestChange: true
}).extend({ originalPresentation: OriginalPresentationSchema.optional() });
const taskValues = z.object({
  kind: PublicTaskKindSchema,
  startedMinute: integer,
  endsMinute: integer,
  choiceOrigin: origin,
  place,
  partner: resident.optional(),
  resource: object.optional(),
  project: project.optional(),
  commitment: commitment.optional(),
  venture: venture.optional(),
  parcel: parcel.optional(),
  progress: percent.optional(),
  blockerCode: z.enum(['waiting', 'unavailable']).optional(),
  /**
   * Policy 2, frontier access only: the frontier worksite and whether the resident is still on the way there
   * (from `from`, arriving at `arrivesMinute`) or working at it. A quay faces one ring-1 sector across the
   * channel; ground is the charted parcel stood on. Presentation follows this; it never grants access.
   */
  trip: z.object({
    phase: z.enum(['travelling', 'working']),
    from: place,
    arrivesMinute: integer,
    site: z.discriminatedUnion('kind', [z.object({
      kind: z.literal('quay'),
      sector: integer.max(7)
    }).strict(), z.object({
      kind: z.literal('ground'),
      parcel
    }).strict()])
  }).strict().optional(),
  walk: z.object({from:place,arrivesMinute:integer}).strict().optional(),
  returnTrip:z.object({from:place,arrivesMinute:integer,site:z.discriminatedUnion("kind",[z.object({kind:z.literal("quay"),sector:integer.max(7)}).strict(),z.object({kind:z.literal("ground"),parcel}).strict()])}).strict().optional(),
  /** Saved travel on the single Central circuit. */
  journey: z.object({
    from: place,
    ride: z.object({
      from: parcel.nullable(),
      to: parcel.nullable(),
      boardMinute: integer,
      departMinute: integer,
      arriveMinute: integer
    }).strict(),
    arrivesMinute: integer
  }).strict().optional()
}).strict().superRefine((v, c) => {
  if (v.trip && (!['chart-frontier', 'help-chart', 'build'].includes(v.kind) || !(v.startedMinute < v.trip.arrivesMinute && v.trip.arrivesMinute < v.endsMinute) || v.kind === 'build' && v.trip.site.kind === 'quay')) c.addIssue({
    code: 'custom',
    message: 'invalid frontier trip'
  });
  if((v.kind==="frontier-return")!==(v.returnTrip!==undefined)||v.returnTrip&&(v.walk||v.trip||v.journey||v.endsMinute!==v.returnTrip.arrivesMinute))c.addIssue({code:"custom",message:"invalid frontier return"});
  if(v.walk && (v.trip || v.journey || v.walk.from.id===v.place.id || !(v.startedMinute<v.walk.arrivesMinute && v.walk.arrivesMinute<=v.endsMinute)))c.addIssue({code:"custom",message:"invalid recorded walk"});
  const j = v.journey;
  if (j && (!['rest','work','socialise','survey','wait-tool','handover','return-tool','use-tool','venture-work','invention-travel','chart-frontier','help-chart','build'].includes(v.kind) || j.from.id === v.place.id || (j.ride.from === null) === (j.ride.to === null) || !(v.startedMinute < j.ride.boardMinute && j.ride.boardMinute < j.ride.departMinute && j.ride.departMinute < j.ride.arriveMinute && j.ride.arriveMinute <= j.arrivesMinute && (j.arrivesMinute < v.endsMinute || v.kind === "invention-travel" && j.arrivesMinute === v.endsMinute)))) c.addIssue({
    code: 'custom',
    message: 'invalid transit journey'
  });
  const allowed: Record<string, string[]> = {
    "frontier-return":[],
    work: [],
    rest: [],
    survey: [],
    socialise: ['partner'],
    'wait-tool': ['partner', 'resource', 'project', 'commitment'],
    handover: ['partner', 'resource', 'project', 'commitment'],
    'return-tool': ['partner', 'resource', 'project', 'commitment'],
    'use-tool': ['resource', 'project'],
    'venture-work': ['venture', 'partner'],
    'invention-build': ['venture'],
    'assembly-trial': ['venture'],
    'invention-teach':['venture','partner'],
    'invention-travel': [],
    'chart-frontier': ['parcel'],
    'help-chart': ['parcel'],
    build: ['parcel']
  };
  for (const key of ['partner', 'resource', 'project', 'commitment', 'venture', 'parcel'] as const) if (v[key] !== undefined && !allowed[v.kind]!.includes(key)) c.addIssue({
    code: 'custom',
    message: 'incompatible optional task reference'
  });
  if (v.endsMinute <= v.startedMinute || v.kind === 'socialise' && !v.partner || v.kind === 'use-tool' && (!v.resource || !v.project) || ['wait-tool', 'handover', 'return-tool'].includes(v.kind) && (!v.partner || !v.resource || !v.commitment) || ['venture-work', 'invention-build', 'assembly-trial','invention-teach'].includes(v.kind) && !v.venture || ['chart-frontier', 'help-chart', 'build'].includes(v.kind) !== (v.parcel !== undefined)) c.addIssue({
    code: 'custom',
    message: 'incompatible task references'
  });
});
const uniqueResidents = z.array(resident).refine(v => new Set(v.map(r => r.id)).size === v.length, {
  message: 'duplicate resident reference'
});
const build = z.object({
  kind: FrontierBuildKindSchema,
  proposer: resident,
  startedMinute: integer,
  effort: percent,
  crew: uniqueResidents.max(8)
}).strict();
const parcelValues = z.object({
  ring: positive.max(64),
  slot: integer,
  state: z.enum(['fog', 'charted']),
  effort: integer.max(6),
  contributors: uniqueResidents.max(8),
  chartedMinute: integer.optional(),
  build: build.optional(),
  place: place.optional(),
  builtKind: FrontierBuildKindSchema.optional(),
  builtBy: uniqueResidents.max(9).optional()
}).strict().superRefine((v, c) => {
  if (v.slot >= 8 * v.ring || v.state === 'charted' !== (v.chartedMinute !== undefined) || v.state === 'charted' !== (v.effort === 6) || (!!v.build || !!v.place) && v.state !== 'charted' || !!v.build && !!v.place || v.place === undefined !== (v.builtKind === undefined) || v.builtBy !== undefined && !v.place) c.addIssue({
    code: 'custom',
    message: 'invalid parcel relation'
  });
});
function fact<C extends string, S extends z.ZodType, V extends z.ZodType>(code: C, subjects: S, values: V) {
  return z.object({
    code: z.literal(code),
    subjects,
    minute: integer,
    values
  }).strict();
}
/** Explicit mechanics admission, never an echo of the private option menu. */
export const PublicAffordanceSchema = z.discriminatedUnion('code', [z.object({
  code: z.literal('invention'),
  intent: z.enum(['observe', 'baseline', 'candidate', 'build', 'test', 'pause', 'resume', 'withdraw', 'consult', 'accept', 'decline', 'answer', 'withdraw-consultation', 'author-method', 'adopt-version', 'production', 'offer-method', 'accept-method', 'decline-method', 'revoke-method', 'invite-lesson', 'start-lesson', 'retest-method', 'adopt-reproduction']),
  site: workpad,
  agenda: agenda.optional(),
  design: design.optional(),
  method: method.optional(),
  grant:grant.optional(),attempt:positive.max(8).optional(),
  artifact: artifact.optional(),
  trial: trial.optional(),
  peer: resident.optional(),
  consultation: consultation.optional(),
  operation: z.enum(['garden-plant', 'lantern-post', 'market-box', 'map-frame']).optional(),
  suggest: z.enum(['add-guide', 'add-clamp', 'add-support', 'add-tray', 'remove-part', 'no-evidence']).optional(),
  certainty: z.enum(['tentative', 'observed']).optional(),
  sources: z.array(trial).max(2).optional()
}).strict(), z.object({
  code: z.enum(['rest', 'think', 'work'])
}).strict(), z.object({
  code: z.literal('socialise'),
  resident
}).strict(), z.object({
  code: z.enum(['accept-request', 'decline-request', 'return-tool']),
  commitment
}).strict(), z.object({
  code: z.enum(['use-tool', 'request-tool']),
  object,
  project
}).strict(), z.object({
  code: z.literal('survey'),
  place
}).strict(), z.object({
  code: z.enum(['chart-frontier', 'help-chart', 'build']),
  parcel
}).strict(), z.object({
  code: z.literal('found-place'),
  parcel,
  buildKind: FrontierBuildKindSchema
}).strict(), z.object({
  code: z.literal('move-home'),
  place
}).strict(), z.object({
  code: z.enum(['join-venture', 'decline-venture']),
  venture
}).strict(), z.object({
  code: z.literal('propose-venture'),
  template: z.enum(['garden-beds', 'square-benches', 'promenade-lanterns', 'market-planters', 'public-map-boards'])
}).strict(), z.object({
  // The actor's own appearance only: there is no resident target, so nobody chooses for another.
  code: z.literal('choose-appearance'),
  look: z.enum([...WARDROBE_LOOKS, 'original']).optional(),
  hairStyle: HairStyleSchema.optional(),
  garment: GarmentSchema.optional(),
  trousers: TrouserSchema.optional(),
  footwear: FootwearSchema.optional(),
  accessory: AccessorySchema.optional()
}).strict().refine(v => [v.look, v.hairStyle, v.garment, v.trousers, v.footwear, v.accessory].filter(x => x !== undefined).length === 1, {
  message: 'one appearance change per choice'
})]);
export const PUBLIC_AFFORDANCE_LIMIT = 128;
export type PublicAffordance = z.infer<typeof PublicAffordanceSchema>;
export const PublicFactSchema = z.discriminatedUnion('code', [fact('grant.state',z.tuple([grant,resident,resident,workpad]),z.object({revision:integer,status:z.enum(['offered','accepted','declined','revoked','demonstrated']),expiresMinute:integer,method,artifact,trial,accepted:z.boolean(),lesson:z.enum(['none','working','completed','interrupted']),startedMinute:integer.nullable(),endedMinute:integer.nullable(),executions:integer.max(8),latestPassed:z.boolean().nullable(),latestExecutionAuthority:z.enum(['configured-runtime','configured-double']).nullable(),reproductionArtifact:artifact.nullable(),reproductionTrial:trial.nullable()}).strict()),fact('method.state', z.tuple([method,resident,agenda,workpad]), z.object({
  revision: positive.max(8), state: z.enum(['available','completed-origin-task','invalidated']),
  reason: z.enum(['none','task-completed','task-replaced','agenda-closed','need-resolved','origin-invalid']),
  passed: z.boolean(), authority: z.enum(['configured-provider','configured-double']), admittedMinute: integer
}).strict()), fact('workpad.state', z.tuple([workpad, place]), z.object({
  revision: integer,
  capacity: z.literal(4),
  access: z.literal('public-adults')
}).strict()), fact('agenda.state', z.tuple([agenda, resident, workpad]), z.object({
  revision: integer,
  stage: z.enum(['observe', 'consult', 'compare', 'build', 'test', 'teach', 'reproduce', 'review', 'paused', 'closed']),
  need: trial.nullable(),
  candidates: z.array(design).max(2),
  selected: design.nullable(),
  consultation: consultation.nullable(),
  trials: z.array(trial).max(8),
  blocked: z.enum(['none', 'resources', 'consent', 'busy', 'no-benefit', 'record-cap', 'no-observation']),
  continuation: z.enum(['observe', 'build', 'operate']).nullable(),
  continuationStatus: z.enum(['pending', 'running']).nullable()
}).strict()), fact('consultation.state', z.tuple([consultation, resident, resident, workpad]), z.object({
  revision: integer,
  need: trial,
  status: z.enum(['requested', 'accepted', 'answered', 'declined', 'withdrawn', 'expired']),
  question: z.enum(['reduce-duration', 'meet-quality', 'explain-failure']),
  createdMinute: integer,
  expiresMinute: integer,
  suggest: z.enum(['add-guide', 'add-clamp', 'add-support', 'add-tray', 'remove-part', 'no-evidence']).nullable(),
  certainty: z.enum(['tentative', 'observed']).nullable(),
  sources: z.array(trial).max(2)
}).strict()), fact('design.state', z.tuple([design, resident, workpad]), z.object({
  need: trial,
  parent: design.nullable(),
  parts: z.array(z.object({
    n: integer.max(5),
    k: z.enum(['base', 'support', 'guide', 'clamp', 'tray']),
    x: integer.max(5),
    y: integer.max(5),
    r: z.union([z.literal(0), z.literal(1)]),
    parent: integer.max(5).nullable()
  }).strict()).min(2).max(6),
  claim: z.object({
    metric: z.enum(['duration-minutes', 'quality-points']),
    relation: z.enum(['at-most', 'at-least']),
    value: positive.max(100)
  }).strict(),
  timber: integer.max(6),
  stone: integer.max(6),
  buildMinutes: positive.max(32),
  status: z.enum(['validated', 'building', 'built', 'failed'])
}).strict()), fact('artifact.state', z.tuple([artifact, design, resident, workpad]), z.object({
  revision: integer,
  condition: percent,
  access: z.enum(['owner-only', 'public-consented']),
  slot: integer.max(3),
  completedMinute: integer
}).strict()), fact('trial.state', z.tuple([trial, resident, workpad]), z.object({
  design: design.nullable(),
  artifact: artifact.nullable(),
  mode: z.enum(['baseline', 'assisted']),
  purpose: z.enum(['trial-only', 'production']),
  pieces: positive.max(4),
  load: positive.max(3),
  precision: integer.min(60).max(85),
  axis: integer.max(1),
  nominalMinutes: integer.min(4).max(8),
  buildingSkill: percent,
  startingCondition: percent,
  startedMinute: integer,
  endedMinute: integer,
  outcome: z.enum(['passed', 'quality-rejected', 'interrupted', 'revoked']),
  quality: percent,
  duration: positive.max(32),
  timber: integer.max(6),
  stone: integer.max(6),
  claimVerdict: z.enum(['none', 'supported', 'refuted']),
  comparison: trial.nullable(),
  useful: z.boolean()
}).strict()), fact('assembly-job.state', z.tuple([assemblyJob, resident, workpad]), z.object({
  artifact: artifact.nullable(),
  status: z.enum(['invited', 'working', 'passed', 'quality-rejected', 'interrupted', 'revoked']),
  result: trial.nullable(),
  operation: z.enum(['garden-plant', 'lantern-post', 'market-box', 'map-frame']),
  purpose: z.enum(['trial-only', 'production'])
}).strict()), fact('resident.affordances', z.tuple([resident]), z.object({
  actions: z.array(PublicAffordanceSchema).max(PUBLIC_AFFORDANCE_LIMIT),
  omittedActions: integer
}).strict()), fact('world.render', z.tuple([]), z.object({
  terrainVersion: z.literal(1),
  terrainSeed: integer.max(0xffffffff),
  layoutVersion: z.literal(1),
  mode: z.enum(['founding', 'city', 'life'])
}).strict()), fact('resident.identity', z.tuple([resident]), z.object({
  nameKey: PublicNameKeySchema,
  occupationCode: PublicOccupationSchema,
  lifeStage: z.enum(['adult', 'child']),
  age: integer.max(17).optional()
}).strict().refine(v => v.lifeStage === 'child' ? v.occupationCode === 'child' : v.age === undefined && v.occupationCode !== 'child')), fact('resident.presence', z.tuple([resident, place, place]), z.object({
  activity: z.enum(['home', 'work', 'leisure']),
  motion: z.enum(['stationary', 'walking', 'unavailable']),
  work: place
}).strict()), fact('resident.appearance', z.tuple([resident]), appearance), fact('resident.task', z.tuple([resident]), taskValues), fact('resident.measurements', z.tuple([resident]), z.object({
  readings: z.array(z.object({
    minute: integer,
    project,
    place,
    value: percent,
    evidenceKind: z.enum(['measured', 'witnessed-change'])
  }).strict()).max(16)
}).strict()), fact('resident.vitals', z.tuple([resident]), z.object({
  energy: percent,
  social: percent,
  purpose: percent,
  work: percent,
  gardening: percent,
  building: percent
}).strict()), fact('place.state', z.tuple([place]), z.object({
  kind: z.enum(['residence', 'workplace', 'civic', 'construction']),
  nameKey: z.enum(['alias', 'home', 'work', 'founders-square', 'founding-district-site', 'city-market', 'city-garden', 'city-promenade', 'frontier', 'family-home', 'empty-home', 'landing']),
  layoutKey: z.enum(['home', 'work', 'civic', 'construction', 'frontier', 'unavailable']),
  anchorSlot: positive.max(122).optional(),
  frontierKind: FrontierBuildKindSchema.optional(),
  ring: positive.max(64).optional(),
  slot: integer.max(511).optional()
}).strict().refine(v => v.anchorSlot === undefined || v.layoutKey === 'home' && v.kind === 'residence' && v.anchorSlot <= 122 || v.layoutKey === 'work' && v.kind === 'workplace' && v.anchorSlot <= 120, {
  message: 'invalid presentation anchor'
})), fact('construction.state', z.tuple([construction, place]), z.object({
  stage: z.enum(['foundation', 'frame', 'enclosure', 'fitout', 'complete'])
}).strict()), fact('project.state', z.tuple([project, place]), z.object({
  kind: z.enum(['garden', 'civic']),
  labelKey,
  progress: percent
}).strict()), fact('parcel.state', z.tuple([parcel]), parcelValues), fact('object.ownership', z.tuple([object, resident]), z.object({
  kind: z.literal('garden-tools'),
  labelKey: z.enum(['garden-tools', 'unavailable'])
}).strict()), fact('commitment.state', z.tuple([commitment, resident, resident, object, project, place]), z.object({
  status: z.enum(['pending', 'meeting', 'loaned', 'returning', 'returned', 'declined', 'expired', 'interrupted']),
  createdMinute: integer,
  expiresMinute: integer
}).strict()), fact('venture.state', z.tuple([venture, place, resident]), z.object({
  labelKey: z.enum(['unavailable', 'garden-beds', 'square-benches', 'promenade-lanterns', 'market-planters', 'public-map-boards']),
  status: VentureStatusSchema,
  proposedMinute: integer,
  consentDeadlineMinute: integer,
  deadlineMinute: integer,
  steps: z.array(z.object({
    ordinal: integer.max(7),
    labelKey: z.enum(['unavailable', 'clear', 'plant', 'shape', 'set', 'post', 'light', 'box', 'frame', 'draw']),
    durationMinutes: positive.max(1000000),
    requires: z.array(material).max(4),
    status: z.enum(['pending', 'running', 'done', 'aborted']),
    startedMinute: integer.nullable(),
    completedMinute: integer.nullable(),
    consumed: z.array(material).max(4)
  }).strict()).min(1).max(8),
  participants: z.array(z.object({
    resident,
    consent: VentureConsentSchema,
    invitedMinute: integer,
    respondedMinute: integer.nullable()
  }).strict()).max(8),
  outcome: z.object({
    minute: integer,
    result: z.enum(['completed', 'failed', 'abandoned']),
    reason: VentureOutcomeReasonSchema
  }).strict().nullable()
}).strict().superRefine((v, c) => {
  if (v.consentDeadlineMinute < v.proposedMinute || v.deadlineMinute < v.consentDeadlineMinute || ['completed', 'failed', 'abandoned'].includes(v.status) !== (v.outcome !== null) || v.outcome && v.outcome.result !== v.status || v.steps.some((step, i) => step.ordinal !== i) || new Set(v.participants.map(p => p.resident.id)).size !== v.participants.length) c.addIssue({
    code: 'custom',
    message: 'invalid venture relation'
  });
})), fact('venture.materials', z.tuple([venture]), z.object({
  minute: integer,
  timber: z.object({
    reserved: integer,
    consumed: integer
  }).strict(),
  stone: z.object({
    reserved: integer,
    consumed: integer
  }).strict()
}).strict()), fact('transit.state', z.tuple([]), z.object({
  commissionedMinute: integer,
  revision: integer,
  anchorMinute: integer,
  route: z.object({
    path: z.array(parcel).min(2).max(TRANSIT_MAX_PATH),
    stops: z.array(integer.max(TRANSIT_MAX_PATH - 1)).min(1).max(TRANSIT_MAX_STOPS)
  }).strict().nullable()
}).strict().refine(v => v.anchorMinute >= v.commissionedMinute && v.route === null === (v.revision === 0) && (v.route === null || v.route.stops.every((stop, i) => stop < v.route!.path.length && (i === 0 || stop > v.route!.stops[i - 1]!))), {
  message: 'invalid transit relation'
})), fact('place.survey', z.tuple([place, resident]), z.object({
  surveyedMinute: integer,
  present: integer.max(10000),
  seen: z.array(resident).max(3),
  projects: z.array(z.object({
    project,
    progress: percent
  }).strict()).max(8)
}).strict())]);
export type PublicFact = z.infer<typeof PublicFactSchema>;
export const PublicResidentContextSchema = z.object({
  policyVersion: z.literal(1),
  resident: PublicRefSchema.refine(r => r.kind === 'resident'),
  observedMinute: z.number().int().safe().nonnegative(),
  observations: z.array(PublicFactSchema).max(32),
  choices: z.array(z.object({
    token: z.string().regex(/^choice-[0-9]+$/),
    action: PublicAffordanceSchema
  }).strict()).max(32),
  omissions: z.object({
    observations: z.number().int().nonnegative(),
    choices: z.number().int().nonnegative(),
    scope: z.literal('own-state-and-same-place; availability-is-not-observation')
  }).strict()
}).strict();
export type PublicResidentContext = z.infer<typeof PublicResidentContextSchema>;
export const ApprovedPublicFactsSchema = z.object({
  minute: integer,
  facts: z.array(PublicFactSchema).max(30000)
}).strict();
export const PublicFactKeySchema = z.object({
  code: z.enum(PublicFactSchema.options.map(s => s.shape.code.value) as [PublicFact['code'], ...PublicFact['code'][]]),
  subject: PublicRefSchema.nullable()
}).strict();
export type PublicFactKey = z.infer<typeof PublicFactKeySchema>;
export function publicFactKey(fact: PublicFact): PublicFactKey {
  return {
    code: fact.code,
    subject: fact.subjects[0] ?? null
  };
}
export function publicKeyString(key: PublicFactKey): string {
  return `${key.code}:${key.subject?.kind ?? ''}:${key.subject?.id ?? 0}`;
}
export function publicCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(publicCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${publicCanonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const MAX_PUBLIC_FACTS = 30000,
  MAX_PUBLIC_OPERATIONS = 60000,
  MAX_PUBLIC_BYTES = 16 * 1024 * 1024;
const envelope = {
  schemaVersion: z.literal(1),
  streamId: z.uuid(),
  catalogueVersion: z.literal(1),
  cursor: integer,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  minute: integer
};
const declarations: Partial<Record<PublicFact['code'], PublicKind>> = {
  'method.state': 'method',
  'grant.state':'grant',
  'workpad.state': 'workpad',
  'agenda.state': 'agenda',
  'consultation.state': 'consultation',
  'design.state': 'design',
  'artifact.state': 'artifact',
  'trial.state': 'trial',
  'assembly-job.state': 'assembly-job',
  'resident.identity': 'resident',
  'place.state': 'place',
  'parcel.state': 'parcel',
  'project.state': 'project',
  'object.ownership': 'object',
  'commitment.state': 'commitment',
  'venture.state': 'venture',
  'construction.state': 'construction'
};
function refs(value: unknown): PublicRef[] {
  if (!value || typeof value !== 'object') return [];
  if ('id' in value && 'kind' in value) return [PublicRefSchema.parse(value)];
  return Object.values(value).flatMap(refs);
}
export const PublicSnapshotSchema = z.object({
  ...envelope,
  facts: z.array(PublicFactSchema).max(MAX_PUBLIC_FACTS)
}).strict().superRefine((s, c) => {
  const keys = new Set<string>(),
    inventory = new Set<string>();
  for (const f of s.facts) {
    const key = publicKeyString(publicFactKey(f));
    if (keys.has(key) || f.minute > s.minute) c.addIssue({
      code: 'custom',
      message: 'duplicate fact or future minute'
    });
    keys.add(key);
    if (declarations[f.code]) {
      const r = f.subjects[0]!;
      inventory.add(`${r.kind}:${r.id}`);
    }
  }
  for (const f of s.facts) for (const r of refs(f)) if (!inventory.has(`${r.kind}:${r.id}`)) c.addIssue({
    code: 'custom',
    message: 'unresolved public reference'
  });
  const anchors = new Set<string>();
  for (const f of s.facts) if (f.code === 'place.state' && f.values.anchorSlot !== undefined) {
    const key = `${f.values.layoutKey}:${f.values.anchorSlot}`;
    if (anchors.has(key)) c.addIssue({
      code: 'custom',
      message: 'duplicate presentation anchor'
    });
    anchors.add(key);
  }
  const identities = s.facts.filter(f => f.code === 'resident.identity');
  for (const identity of identities) {
    const presentation = s.facts.find(f => f.code === 'resident.appearance' && f.subjects[0].id === identity.subjects[0].id);
    if (identity.values.lifeStage === 'child' && presentation?.code === 'resident.appearance' && (presentation.values.presentation.look !== undefined || presentation.values.originalPresentation && presentation.values.originalPresentation.kind !== 'procedural')) c.addIssue({ code: 'custom', message: 'child presentation must remain procedural' });
    const presence = s.facts.find(f => f.code === 'resident.presence' && f.subjects[0].id === identity.subjects[0].id);
    if (!presence) c.addIssue({
      code: 'custom',
      message: 'resident without presence'
    });
    if (identity.values.lifeStage === 'child' && presence?.code === 'resident.presence' && (presence.subjects[1].id !== presence.subjects[2].id || presence.values.work.id !== presence.subjects[2].id)) c.addIssue({
      code: 'custom',
      message: 'child presence must remain at home'
    });
  }
  for (const f of s.facts) {
    if (f.code === 'resident.measurements' && f.values.readings.some(r => r.minute > s.minute || !s.facts.some(p => p.code === 'project.state' && p.subjects[0].id === r.project.id && p.subjects[1].id === r.place.id))) c.addIssue({
      code: 'custom',
      message: 'invalid measurement relation'
    });
    if (f.code === 'parcel.state' && f.values.place) {
      const p = s.facts.find(p => p.code === 'place.state' && p.subjects[0].id === f.values.place!.id);
      if (p?.code !== 'place.state' || (f.values.builtKind === 'home' ? 'residence' : 'civic') !== p.values.kind) c.addIssue({
        code: 'custom',
        message: 'invalid founded place relation'
      });
    }
    // The circuit a spectator sees is lawful on the public parcels themselves: charted all the way, connected,
    // two ring-1 landings, and every station a founded place, one per district.
    if (f.code === 'transit.state' && f.values.route) {
      const parcels = new Map(s.facts.flatMap(p => p.code === 'parcel.state' ? [[p.subjects[0].id, p.values] as const] : []));
      const path = f.values.route.path.map(r => parcels.get(r.id));
      if (path.some(p => p?.state !== 'charted') || f.values.route.stops.some(i => !path[i]?.place && !s.facts.some(p => p.code === 'place.state' && p.values.nameKey === 'landing' && p.values.ring === path[i]?.ring && p.values.slot === path[i]?.slot)) || transitCourseIssues(path.map(p => ({
        ring: p?.ring ?? 0,
        slot: p?.slot ?? 0
      })), f.values.route.stops).length > 0) c.addIssue({
        code: 'custom',
        message: 'invalid transit relation'
      });
    }
  }
  if (!s.facts.some(f => f.code === 'world.render')) c.addIssue({
    code: 'custom',
    message: 'missing render configuration'
  });
  if (new TextEncoder().encode(publicCanonicalJson(s)).length > MAX_PUBLIC_BYTES) c.addIssue({
    code: 'custom',
    message: 'public size bound'
  });
});
export type PublicSnapshot = z.infer<typeof PublicSnapshotSchema>;
export const PublicOperationSchema = z.discriminatedUnion('op', [z.object({
  op: z.literal('put'),
  fact: PublicFactSchema
}).strict(), z.object({
  op: z.literal('remove'),
  key: PublicFactKeySchema
}).strict()]);
export type PublicOperation = z.infer<typeof PublicOperationSchema>;
export const PublicEventSchema = z.object({
  schemaVersion: z.literal(1),
  streamId: z.uuid(),
  cursor: positive,
  previousRevision: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  minute: integer,
  operations: z.array(PublicOperationSchema).max(MAX_PUBLIC_OPERATIONS)
}).strict().refine(v => v.previousRevision !== v.revision && new TextEncoder().encode(publicCanonicalJson(v)).length <= MAX_PUBLIC_BYTES);
export type PublicEvent = z.infer<typeof PublicEventSchema>;
export function publicRevisionInput(s: Pick<PublicSnapshot, 'minute' | 'facts'>): string {
  return publicCanonicalJson({
    catalogueVersion: 1,
    minute: s.minute,
    facts: [...s.facts].sort((a, b) => publicKeyString(publicFactKey(a)) < publicKeyString(publicFactKey(b)) ? -1 : publicKeyString(publicFactKey(a)) > publicKeyString(publicFactKey(b)) ? 1 : 0)
  });
}
export async function publicDigest(input: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function revision(s: Pick<PublicSnapshot, 'minute' | 'facts'>): Promise<string> {
  return publicDigest(publicRevisionInput(s));
}
const acceptedEvents = new WeakMap<PublicSnapshot, string>();
export async function validatePublicSnapshot(input: unknown): Promise<PublicSnapshot> {
  const s = PublicSnapshotSchema.parse(input);
  if ((await revision(s)) !== s.revision) throw new Error('public revision mismatch');
  return s;
}
export async function applyPublicEvent(previous: PublicSnapshot, input: unknown): Promise<PublicSnapshot> {
  const s = await validatePublicSnapshot(previous),
    e = PublicEventSchema.parse(input);
  if (e.streamId !== s.streamId) throw new Error('public epoch mismatch');
  if (e.cursor === s.cursor) {
    if (e.revision === s.revision && acceptedEvents.get(previous) === publicCanonicalJson(e)) return previous;
    throw new Error('unverified duplicate public event');
  }
  if (e.cursor !== s.cursor + 1 || e.previousRevision !== s.revision || e.minute < s.minute) throw new Error('public resync required');
  const facts = new Map(s.facts.map(f => [publicKeyString(publicFactKey(f)), f])),
    touched = new Set<string>();
  for (const op of e.operations) {
    const key = publicKeyString(op.op === 'put' ? publicFactKey(op.fact) : op.key);
    if (touched.has(key)) throw new Error('duplicate public operation');
    touched.add(key);
    if (op.op === 'put') facts.set(key, op.fact);else if (!facts.delete(key)) throw new Error('unknown public removal');
  }
  const next = await validatePublicSnapshot({
    schemaVersion: 1,
    streamId: s.streamId,
    catalogueVersion: 1,
    cursor: e.cursor,
    revision: e.revision,
    minute: e.minute,
    facts: [...facts.values()].sort((a, b) => publicKeyString(publicFactKey(a)) < publicKeyString(publicFactKey(b)) ? -1 : publicKeyString(publicFactKey(a)) > publicKeyString(publicFactKey(b)) ? 1 : 0)
  });
  acceptedEvents.set(next, publicCanonicalJson(e));
  return next;
}

// PRIVATE writer metadata; never a public transport schema.
export const AdmissionRegistrySchema = z.object({
  policyVersion: z.literal(1),
  entries: z.array(z.object({
    kind: PublicKindSchema,
    canonicalId: z.string().min(1).max(512),
    publicId: z.number().int().safe().positive(),
    source: z.literal('verified-canonical-structure')
  }).strict()).max(30000)
}).strict().superRefine((r, c) => {
  const canonical = new Set<string>(),
    publicIds = new Set<string>();
  for (const e of r.entries) {
    const a = `${e.kind}:${e.canonicalId}`,
      b = `${e.kind}:${e.publicId}`;
    if (canonical.has(a) || publicIds.has(b)) c.addIssue({
      code: 'custom',
      message: 'duplicate admission'
    });
    canonical.add(a);
    publicIds.add(b);
  }
});
export type AdmissionRegistry = z.infer<typeof AdmissionRegistrySchema>;
export const PublicHistorySchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('public-world-history'),
  streamId: z.uuid(),
  asOfCursor: integer,
  events: z.array(PublicEventSchema).max(100),
  nextCursor: positive.nullable()
}).strict();
export const PublicDiscoverySchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('public-world-observations'),
  streamId: z.uuid(),
  asOfCursor: integer,
  resident,
  facts: z.array(PublicFactSchema).max(1),
  noteCode: z.literal('since-public-baseline')
}).strict().refine(v => v.facts.every(f => f.code === 'resident.measurements' && f.subjects[0].id === v.resident.id));
