import {FrontierTripSchema,ResidentWalkSchema,FrontierReturnSchema} from "./resident-movement.js";
import {TransitJourneySchema} from "./transit.js";
import { z } from 'zod';
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);
export const InventionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const id = InventionIdSchema,
  minute = int(0),
  revision = int(0),
  score = int(0, 100),
  seq = int(1);
export const AssemblyPartSchema = z.object({
  n: int(0, 5),
  k: z.enum(['base', 'support', 'guide', 'clamp', 'tray']),
  x: int(0, 5),
  y: int(0, 5),
  r: z.union([z.literal(0), z.literal(1)]),
  parent: int(0, 5).nullable()
}).strict();
export const AssemblyClaimSchema = z.object({
  metric: z.enum(['duration-minutes', 'quality-points']),
  relation: z.enum(['at-most', 'at-least']),
  value: int(1, 100)
}).strict();
export const InventionDesignInputSchema = z.object({
  grammar: z.literal(1),
  evaluator: z.literal(1),
  need: id,
  parent: id.nullable(),
  site: id,
  parts: z.array(AssemblyPartSchema).min(2).max(6),
  claim: AssemblyClaimSchema
}).strict();
export const AssemblyEnvelopeSchema = z.object({
  pieces: int(1, 4),
  load: int(1, 3),
  precision: int(60, 85),
  axis: z.union([z.literal(0), z.literal(1)]),
  nominalMinutes: int(4, 8)
}).strict();
export const AssemblyMaterialsSchema = z.object({
  timber: int(0, 6),
  stone: int(0, 6)
}).strict();
/** Private executable evidence. Absent optional fields preserve historical serialized meaning. */
const methodHash = z.string().regex(/^[a-f0-9]{64}$/);
export const WorkbenchContextSchema = z.object({
  actor: id,
  session: id,
  generation: id,
  minute,
  need: id,
  site: id,
  siteRevision: revision,
  envelope: AssemblyEnvelopeSchema,
  skill: score,
  condition: score,
  materials: AssemblyMaterialsSchema,
  evidence: z.array(z.object({
    trial: id,
    quality: score,
    duration: int(2, 16)
  }).strict()).max(8)
}).strict();
export const MethodOutputSchema = z.object({
  parts: z.array(AssemblyPartSchema).min(2).max(6),
  claim: AssemblyClaimSchema
}).strict();
export const MethodCaseInputSchema = z.object({
  envelope: AssemblyEnvelopeSchema,
  skill: score,
  condition: score,
  materials: AssemblyMaterialsSchema
}).strict();
export const MethodFixtureSchema = z.object({
  id,
  cases: z.array(z.object({
    envelope: AssemblyEnvelopeSchema,
    skill: score,
    condition: score
  }).strict()).min(1).max(8)
}).strict();
export const MethodTaskSchema = z.object({
  kind: z.enum(['frontier-return', 'work', 'rest', 'socialise', 'wait-tool', 'handover', 'use-tool', 'return-tool', 'venture-work', 'invention-build', 'assembly-trial', 'invention-teach', 'invention-travel', 'survey', 'chart-frontier', 'help-chart', 'build']),
  startedMinute: minute,
  endsMinute: minute,
  placeId: id,
  partnerId: id.optional(),
  resourceId: id.optional(),
  projectId: id.optional(),
  inventionId: id.optional(),
  commitmentId: id.optional(),
  ventureId: id.optional(),
  parcelId: id.optional(),
  trip:FrontierTripSchema.optional(),journey:TransitJourneySchema.optional(),walk:ResidentWalkSchema.optional(),returnTrip:FrontierReturnSchema.optional()
}).strict().refine(t => t.endsMinute > t.startedMinute);
export const MethodApplicabilitySchema = z.object({
  revision,
  state: z.enum(['available', 'completed-origin-task', 'invalidated']),
  reason: z.enum(['none', 'task-completed', 'task-replaced', 'agenda-closed', 'need-resolved', 'origin-invalid'])
}).strict().refine(a=>a.state==='available'?a.reason==='none':a.state==='completed-origin-task'?a.reason==='task-completed':!['none','task-completed'].includes(a.reason));
export const MethodChoiceSchema = z.object({
  requestId: id, observedMinute: minute, generation: id,
  agendaRevision: revision, siteRevision: revision, task: MethodTaskSchema.nullable()
}).strict();
export const MethodOriginSchema = z.object({
  context: WorkbenchContextSchema,
  contextHash: methodHash,
  sourceSequence: int(0),
  sourceLedgerHash: methodHash,
  agendaId: id,
  agendaRevision: revision,
  task: MethodTaskSchema.nullable(),
  choice: MethodChoiceSchema.optional()
}).strict();
const methodResult = z.object({
  inputHash: methodHash,
  passed: z.boolean(),
  code: z.enum(['measured', 'execution-failed', 'invalid-output', 'invalid-graph', 'nondeterministic']),
  quality: score.nullable(),
  duration: int(2, 16).nullable(),
  design: MethodOutputSchema.nullable()
}).strict();
export const MethodTestSchema = z.object({
  hash: methodHash,
  actor: id,
  session: id,
  contextHash: methodHash,
  artifact: methodHash,
  fixtureSet: id,
  fixtureHash: methodHash,
  passed: z.boolean(),
  results: z.array(methodResult).min(1).max(8),
  fixture: MethodFixtureSchema,
  executions: z.array(z.object({
    input: MethodCaseInputSchema,
    inputHash: methodHash,
    firstStatus: z.enum(['valid-output', 'invalid-output', 'execution-failed', 'not-run']),
    secondStatus: z.enum(['valid-output', 'invalid-output', 'execution-failed', 'not-run']),
    first: MethodOutputSchema.nullable(),
    second: MethodOutputSchema.nullable(),
    firstHash: methodHash.nullable(),
    secondHash: methodHash.nullable()
  }).strict()).min(1).max(8)
}).strict();
export const InventionMethodSchema = z.object({
  id,
  authorId: id,
  source: z.string().min(1).refine(s => s.isWellFormed() && new TextEncoder().encode(s).length <= 8192),
  sourceHash: methodHash,
  artifactHash: methodHash,
  revision: int(1, 8),
  parentVersionId: id.nullable(),
  parentArtifactHash: methodHash.nullable(),
  origin: MethodOriginSchema,
  authority: z.discriminatedUnion('kind', [z.object({
    kind: z.literal('configured-provider'),
    model: z.enum(['gpt-6-luna', 'gpt-5.6-luna']),
    tier: z.literal('default')
  }).strict(), z.object({
    kind: z.literal('configured-double')
  }).strict()]),
  interface: z.literal('design-v1'),
  evaluator: z.literal(1),
  evaluatorHash: methodHash,
  runtime: z.object({
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runnerHash: methodHash
  }).strict(),
  tests: z.array(MethodTestSchema).min(1).max(8),
  selectedReceiptHash: methodHash,
  admissionBasis: z.object({
    minute,
    applicability: MethodApplicabilitySchema
  }).strict(),
  admittedMinute: minute,
  applicability: MethodApplicabilitySchema
}).strict();
export type InventionMethod = z.infer<typeof InventionMethodSchema>;
/** Complete immutable sessions are linear; only their selected leaf represents a successful completion. Failed tested ancestors remain history. */
export function inventionMethodCollectionProblems(methods: Record<string, InventionMethod> | undefined): string[] {
  const errors: string[] = [],
    sessions = new Map<string, InventionMethod[]>();
  for (const method of Object.values(methods ?? {})) {
    const group = sessions.get(method.origin.context.session) ?? [];
    group.push(method);
    sessions.set(method.origin.context.session, group);
  }
  for (const group of sessions.values()) {
    group.sort((a, b) => a.revision - b.revision);
    const first = group[0]!;
    if (group.length > 8 || new Set(group.map(m => m.revision)).size !== group.length || new Set(group.map(m => m.artifactHash)).size !== group.length) errors.push('method session revision identity');
    for (const [index, m] of group.entries()) {
      const parent = group[index - 1];
      if (m.revision !== index + 1 || m.authorId !== first.authorId || JSON.stringify(m.origin) !== JSON.stringify(first.origin) || JSON.stringify(m.authority) !== JSON.stringify(first.authority) || JSON.stringify(m.runtime) !== JSON.stringify(first.runtime) || m.evaluatorHash !== first.evaluatorHash || m.admittedMinute !== first.admittedMinute || JSON.stringify(m.admissionBasis) !== JSON.stringify(first.admissionBasis) || m.parentVersionId !== (parent?.id ?? null) || m.parentArtifactHash !== (parent?.artifactHash ?? null)) errors.push('method session linear ancestry');
    }
    const leaf = group.at(-1)!,
      c = leaf.origin.context,
      selected = leaf.tests.find(t => t.hash === leaf.selectedReceiptHash);
    const current = selected?.results.some((r, index) => {
      const e = selected.executions[index],
        input = e?.input;
      return !!input && r.passed && r.code === 'measured' && r.inputHash === e.inputHash && input.skill === c.skill && input.condition === c.condition && input.materials.stone === c.materials.stone && input.materials.timber === c.materials.timber && JSON.stringify(input.envelope) === JSON.stringify(c.envelope);
    });
    if (!selected?.passed || !current) errors.push('method selected leaf current completion');
  }
  return errors;
}

export type MethodOrigin = z.infer<typeof MethodOriginSchema>;
export type MethodApplicability = z.infer<typeof MethodApplicabilitySchema>;
export type MethodTest = z.infer<typeof MethodTestSchema>;
export type MethodTask = z.infer<typeof MethodTaskSchema>;
export const InventionSiteSchema = z.object({
  id,
  placeId: id,
  revision,
  access: z.literal('public-adults'),
  capacity: z.literal(4)
}).strict();
export const InventionContinuationSchema = z.object({
  kind: z.enum(['observe', 'build', 'operate']),
  designId: id.nullable(),
  artifactId: id.nullable(),
  artifactRevision: revision.nullable(),
  operation: z.enum(['garden-plant', 'lantern-post', 'market-box', 'map-frame']).nullable(),
  purpose: z.enum(['trial-only', 'production']).nullable(),
  comparisonTrialId: id.nullable(),
  status: z.enum(['pending', 'running']),
  sourceId: id.nullable()
}).strict().refine(c => c.status === 'running' === (c.sourceId !== null) && (c.kind === 'build' ? c.designId !== null && c.operation === null && c.purpose === null && c.artifactId === null && c.artifactRevision === null && c.comparisonTrialId === null : c.kind === 'observe' ? c.designId === null && c.operation === null && c.purpose === null && c.artifactId === null && c.artifactRevision === null && c.comparisonTrialId === null : c.designId === null && c.operation !== null && c.purpose !== null && c.artifactId === null === (c.artifactRevision === null)), 'invalid continuation relation');
export const InventionAgendaSchema = z.object({
  id,
  ownerId: id,
  revision,
  siteId: id,
  needTrialId: id.nullable(),
  stage: z.enum(['observe', 'consult', 'compare', 'build', 'test', 'teach', 'reproduce', 'review', 'paused', 'closed']),
  candidateIds: z.array(id).max(2),
  selectedDesignId: id.nullable(),
  consultationId: id.nullable(),
  trialIds: z.array(id).max(8),
  grantId: id.nullable(),
  engaged: z.literal(true).optional(),
  authoring: z.literal('executable-v1').optional(),
  continuation: InventionContinuationSchema.optional(),
  blocked: z.enum(['none', 'resources', 'consent', 'busy', 'no-benefit', 'record-cap', 'no-observation'])
}).strict();
const answer = z.object({
  speakerId: id,
  sourceTrialIds: z.array(id).max(2),
  suggest: z.enum(['add-guide', 'add-clamp', 'add-support', 'add-tray', 'remove-part', 'no-evidence']),
  certainty: z.enum(['tentative', 'observed'])
}).strict();
export const InventionConsultationSchema = z.object({
  id,
  revision,
  requesterId: id,
  peerId: id,
  siteId: id,
  needTrialId: id,
  question: z.enum(['reduce-duration', 'meet-quality', 'explain-failure']),
  status: z.enum(['requested', 'accepted', 'answered', 'declined', 'withdrawn', 'expired']),
  createdMinute: minute,
  expiresMinute: minute,
  answer: answer.nullable()
}).strict();
const methodApplicationFields = {
  methodVersionId: id,
  authority: InventionMethodSchema.shape.authority,
  receiptHash: methodHash, caseIndex: int(0,7), inputHash: methodHash, outputHash: methodHash,
  adoption: MethodChoiceSchema,
  revisionBasisTrialId: id.nullable()
};
export const MethodApplicationSchema = z.union([z.object(methodApplicationFields).strict(), z.object({...methodApplicationFields, kind:z.literal('reproduction'), grantId:id, executionId:id, teacherId:id}).strict()]);
export const InventionDesignSchema = z.object({
  id,
  authorId: id,
  createdMinute: minute,
  input: InventionDesignInputSchema,
  methodApplication: MethodApplicationSchema.optional(),
  bom: AssemblyMaterialsSchema,
  buildMinutes: int(2, 32),
  status: z.enum(['validated', 'building', 'built', 'failed']),
  ventureId: id.nullable()
}).strict();
export const InventionArtifactSchema = z.object({
  id,
  designId: id,
  builderId: id,
  ownerId: id,
  custodianId: id,
  siteId: id,
  slot: int(0, 3),
  revision,
  condition: score,
  completedMinute: minute,
  access: z.enum(['owner-only', 'public-consented'])
}).strict();
export const AssemblyOperationSchema = z.enum(['garden-plant', 'lantern-post', 'market-box', 'map-frame']);
const mode = z.enum(['baseline', 'assisted']),
  purpose = z.enum(['trial-only', 'production']);
export const InventionJobSchema = z.object({
  id,
  ventureId: id,
  actorId: id,
  siteId: id,
  operation: AssemblyOperationSchema,
  mode,
  purpose,
  artifactId: id.nullable(),
  comparisonTrialId: id.nullable(),
  targetProjectId: id.nullable(),
  revision,
  buildingSkill: score,
  startingCondition: score,
  startedMinute: minute.nullable(),
  endedMinute: minute.nullable(),
  status: z.enum(['invited', 'working', 'passed', 'quality-rejected', 'interrupted', 'revoked']),
  resultTrialId: id.nullable(),
  appliedProgress: score,
  grantId:id.optional()
}).strict();
export const InventionTrialSchema = z.object({
  id,
  actorId: id,
  siteId: id,
  designId: id.nullable(),
  artifactId: id.nullable(),
  ventureId: id,
  stepId: id,
  mode,
  purpose,
  evaluator: z.literal(1),
  operation: AssemblyEnvelopeSchema,
  buildingSkill: score,
  startingCondition: score,
  startedMinute: minute,
  endedMinute: minute,
  outcome: z.enum(['passed', 'quality-rejected', 'interrupted', 'revoked']),
  quality: score,
  duration: int(1, 32),
  consumed: AssemblyMaterialsSchema,
  claimVerdict: z.enum(['none', 'supported', 'refuted']),
  comparisonTrialId: id.nullable(),
  useful: z.boolean()
}).strict();
export const TeachingCadenceSchema=z.object({roster:int(2,512),roundMinutes:int(1,100000)}).strict();
export const LearnerExecutionSchema=z.object({
 id, grantId:id, methodVersionId:id, learnerId:id, generation:id,
 agendaId:id, agendaRevision:revision, siteRevision:revision, task:MethodTaskSchema.nullable(),
 context:WorkbenchContextSchema,contextHash:methodHash,choice:MethodChoiceSchema, observedMinute:minute, admittedMinute:minute,
 sourceSequence:int(0), sourceLedgerHash:methodHash, input:MethodCaseInputSchema,
 sourceHash:methodHash, artifactHash:methodHash,
 runtime:InventionMethodSchema.shape.runtime, authority:InventionMethodSchema.shape.authority,executionAuthority:z.enum(['configured-runtime','configured-double']),
 test:MethodTestSchema
}).strict();
export type LearnerExecution=z.infer<typeof LearnerExecutionSchema>;
export const InventionLessonSchema=z.object({
 invitationId:id,ventureId:id,startedMinute:minute.nullable(),endedMinute:minute.nullable(),
 status:z.enum(['working','completed','interrupted']),
 acceptance:MethodChoiceSchema,start:MethodChoiceSchema
}).strict();
export const GrantMethodSchema=z.object({
 methodVersionId:id, sourceHash:methodHash, artifactHash:methodHash,
 authority:InventionMethodSchema.shape.authority,receiptHash:methodHash,
 teacherArtifactId:id,cadence:TeachingCadenceSchema,offer:MethodChoiceSchema,
 invitationId:id,acceptance:MethodChoiceSchema.nullable(),
 lessons:z.array(InventionLessonSchema).max(8), executions:z.array(LearnerExecutionSchema).max(8)
}).strict();
export type GrantMethod=z.infer<typeof GrantMethodSchema>;
export const InventionGrantSchema = z.object({
  id,
  revision,
  teacherId: id,
  learnerId: id,
  designId: id,
  trialId: id,
  status: z.enum(['offered', 'accepted', 'declined', 'revoked', 'demonstrated']),
  expiresMinute: minute,
  reproductionArtifactId: id.nullable(),
  reproductionTrialId: id.nullable(),
  method:GrantMethodSchema.optional()
}).strict();
export type InventionGrant=z.infer<typeof InventionGrantSchema>;
const records = <T extends z.ZodType,>(schema: T, cap: number) => z.record(id, schema).refine(r => Object.keys(r).length <= cap && Object.entries(r).every(([k, v]) => k === (v as {
  id: string;
}).id), 'record cap or key mismatch');
export const InventionStateSchema = z.object({
  version: z.literal(1),
  nextSequence: seq,
  sites: records(InventionSiteSchema, 8),
  agendas: records(InventionAgendaSchema, 128),
  consultations: records(InventionConsultationSchema, 256),
  designs: records(InventionDesignSchema, 512),
  artifacts: records(InventionArtifactSchema, 128),
  trials: records(InventionTrialSchema, 1024),
  jobs: records(InventionJobSchema, 256),
  grants: records(InventionGrantSchema, 256),
  methods: records(InventionMethodSchema,64).optional()
}).strict().superRefine((state, context) => {
  for (const message of inventionMethodCollectionProblems(state.methods)) {
    context.addIssue({ code: 'custom', path: ['methods'], message });
  }
});
const delta = <T extends string, S extends z.ZodType>(type: T, s: S) => z.object({
  type: z.literal(type),
  minute,
  recordId: id,
  before: s.nullable(),
  after: s
}).strict();
export const InventionMethodChangedEventSchema=delta('invention-method-changed',InventionMethodSchema);
export const InventionSiteChangedEventSchema = delta('invention-site-changed', InventionSiteSchema);
export const InventionAgendaChangedEventSchema = delta('invention-agenda-changed', InventionAgendaSchema);
export const InventionConsultationChangedEventSchema = delta('invention-consultation-changed', InventionConsultationSchema);
export const InventionDesignChangedEventSchema = delta('invention-design-changed', InventionDesignSchema);
export const InventionArtifactChangedEventSchema = delta('invention-artifact-changed', InventionArtifactSchema);
export const InventionTrialChangedEventSchema = z.object({
  type: z.literal('invention-trial-changed'),
  minute,
  recordId: id,
  before: z.null(),
  after: InventionTrialSchema
}).strict();
export const InventionGrantChangedEventSchema = delta('invention-grant-changed', InventionGrantSchema);
export const InventionJobChangedEventSchema = delta('invention-job-changed', InventionJobSchema);
export const InventionCountersChangedEventSchema = z.object({
  type: z.literal('invention-counters-changed'),
  minute,
  before: seq,
  after: seq
}).strict();
export const InventionEnabledEventSchema = z.object({
  type: z.literal('invention-enabled'),
  minute,
  before: z.null(),
  after: InventionStateSchema
}).strict();
export const InventionCommandReasonSchema = z.enum(['legal-command', 'stale', 'invalid-payload', 'unknown-reference', 'unavailable', 'consent-required', 'resources-unavailable', 'record-cap', 'conflicting-duplicate']);
const commandBase = {
  residentId: id,
  requestId: id,
  observedMinute: minute,
  generation: id,
  siteId: id,
  siteRevision: revision
};
export const InventionCommandSchema = z.discriminatedUnion('action', [z.object({...commandBase,action:z.literal('offer-method'),methodVersionId:id,artifactId:id,artifactRevision:revision,trialId:id,learnerId:id,cadence:TeachingCadenceSchema,task:MethodTaskSchema.nullable(),peerTask:MethodTaskSchema.nullable()}).strict(),
 z.object({...commandBase,action:z.literal('grant-choice'),grantId:id,grantRevision:revision,choice:z.enum(['accept','decline','revoke','invite-lesson','start-lesson','retest','adopt-reproduction']),agendaId:id.nullable(),agendaRevision:revision.nullable(),task:MethodTaskSchema.nullable(),peerTask:MethodTaskSchema.nullable(),executionId:id.nullable(),sessionId:z.uuid()}).strict(), z.object({
  ...commandBase,
  action: z.literal('author-method'), agendaId: id, agendaRevision: revision,
  sessionId: z.uuid(), task: MethodTaskSchema.nullable(), revisionBasisTrialId: id.nullable()
}).strict(), z.object({
  ...commandBase,
  action: z.literal('adopt-version'), agendaId: id, agendaRevision: revision,
  methodVersionId: id, task: MethodTaskSchema.nullable(), revisionBasisTrialId: id.nullable()
}).strict(), z.object({
  ...commandBase,
  action: z.literal('agenda'),
  agendaId: id.nullable(),
  agendaRevision: revision.nullable(),
  choice: z.enum(['observe', 'operate', 'build', 'pause', 'resume', 'withdraw']),
  designId: id.nullable(),
  operation: AssemblyOperationSchema.nullable(),
  purpose: purpose.nullable(),
  artifactId: id.nullable(),
  artifactRevision: revision.nullable(),
  comparisonTrialId: id.nullable()
}).strict(), z.object({
  ...commandBase,
  action: z.literal('candidate'),
  agendaId: id,
  agendaRevision: revision,
  input: InventionDesignInputSchema
}).strict(), z.object({
  ...commandBase,
  action: z.literal('consult-request'),
  agendaId: id,
  agendaRevision: revision,
  peerId: id,
  question: z.enum(['reduce-duration', 'meet-quality', 'explain-failure']),
  windowMinutes: int(1, 10000000)
}).strict(), z.object({
  ...commandBase,
  action: z.literal('consult-reply'),
  consultationId: id,
  consultationRevision: revision,
  response: z.enum(['accept', 'decline', 'withdraw', 'answer']),
  answer: answer.nullable(),
  windowMinutes: int(1, 10000000)
}).strict(), z.object({
  ...commandBase,
  action: z.literal('operate'),
  operation: AssemblyOperationSchema,
  purpose,
  artifactId: id.nullable(),
  artifactRevision: revision.nullable(),
  comparisonTrialId: id.nullable()
}).strict(), z.object({
  ...commandBase,
  action: z.literal('design'),
  input: InventionDesignInputSchema
}).strict(), z.object({
  ...commandBase,
  action: z.literal('build'),
  designId: id
}).strict(), z.object({
  ...commandBase,
  action: z.literal('share'),
  artifactId: id,
  artifactRevision: revision,
  access: z.enum(['owner-only', 'public-consented'])
}).strict(), z.object({
  ...commandBase,
  action: z.literal('interrupt'),
  ventureId: id
}).strict()]);
export const InventionCommandResolvedEventSchema = z.object({
  type: z.literal('invention-command-resolved'),
  minute,
  residentId: id,
  requestId: id,
  command: InventionCommandSchema.optional(),
  executionGeneration: id.optional(),
  outcome: z.enum(['accepted', 'rejected']),
  reason: InventionCommandReasonSchema
}).strict().refine(e => e.outcome === 'accepted' === (e.reason === 'legal-command')).refine(e => !e.command || e.command.residentId === e.residentId && e.command.requestId === e.requestId && (e.outcome !== 'accepted' || e.command.observedMinute === e.minute - 1 && e.command.generation === e.executionGeneration), 'command source association');
export type InventionAgenda = z.infer<typeof InventionAgendaSchema>;
export type InventionConsultation = z.infer<typeof InventionConsultationSchema>;
export type InventionState = z.infer<typeof InventionStateSchema>;
export type InventionDesignInput = z.infer<typeof InventionDesignInputSchema>;
export type InventionDesign = z.infer<typeof InventionDesignSchema>;
export type InventionArtifact = z.infer<typeof InventionArtifactSchema>;
export type InventionJob = z.infer<typeof InventionJobSchema>;
export type InventionTrial = z.infer<typeof InventionTrialSchema>;
export type InventionCommand = z.infer<typeof InventionCommandSchema>;
export type AssemblyEnvelope = z.infer<typeof AssemblyEnvelopeSchema>;
export type AssemblyOperation = z.infer<typeof AssemblyOperationSchema>;
export type InventionCommandReason = z.infer<typeof InventionCommandReasonSchema>;

/** Cross-record closure. Historical terminals may outlive the bounded venture cache; active work may not. */
export function inventionReferenceProblems(world: import('./index.js').WorldState): string[] {
  const i = world.life?.invention;
  if (!i) return [];
  const errors: string[] = [],
    life = world.life!,
    v = life.ventures;
  const check = (ok: unknown, reason: string) => {
    if (!ok) errors.push(reason);
  };
  const adult = (id: string) => world.residents[id] && world.residents[id]!.lifeStage !== 'child';
  const source = (id: string) => v?.projects[id] ?? v?.retired.find(x => x.id === id);
  check(!!v, 'invention requires venture ledger');
  for (const s of Object.values(i.sites)) check(world.places[s.placeId]?.kind === 'civic', 'site must be civic');
  const open = new Set<string>();
  for (const a of Object.values(i.agendas)) {
    check(adult(a.ownerId) && i.sites[a.siteId], 'agenda references');
    if (a.stage !== 'closed') {
      check(!open.has(a.ownerId), 'multiple open agendas');
      open.add(a.ownerId);
    }
    check(a.needTrialId === null || i.trials[a.needTrialId], 'agenda need');
    check(a.candidateIds.every(id => i.designs[id]?.authorId === a.ownerId && i.designs[id]?.input.site === a.siteId), 'agenda candidates');
    check(new Set(a.candidateIds).size === a.candidateIds.length, 'duplicate candidates');
    if (a.authoring) {
      const candidates = a.candidateIds.map(id => i.designs[id]);
      check(candidates.every(d => d?.methodApplication), 'executable agenda candidate provenance');
      const sessions = candidates.map(d => i.methods?.[d!.methodApplication!.methodVersionId]?.origin.context.session);
      check(new Set(sessions).size === sessions.length, 'executable independent sessions');
      check(new Set(candidates.map(d => JSON.stringify(d?.input.parts))).size === candidates.length, 'executable distinct outputs');
    }
    check(a.selectedDesignId === null || a.candidateIds.includes(a.selectedDesignId), 'agenda selection');
    check(a.trialIds.every(id => i.trials[id]), 'agenda trials');
    check(a.consultationId === null || i.consultations[a.consultationId], 'agenda consultation');
    check(a.grantId === null || i.grants[a.grantId], 'agenda grant');
  }
  for(const m of Object.values(i.methods??{})){
    const c=m.origin.context,a=i.agendas[m.origin.agendaId],parent=m.parentVersionId===null?null:i.methods?.[m.parentVersionId];
    const originalNeed = i.trials[c.need];
    check(adult(m.authorId) && m.authorId === c.actor && a?.ownerId === m.authorId &&
      a.siteId === c.site && a.trialIds.includes(c.need) && a.revision >= m.origin.agendaRevision &&
      originalNeed?.mode === 'baseline' && originalNeed.actorId === m.authorId &&
      originalNeed.siteId === c.site && originalNeed.endedMinute <= c.minute &&
      JSON.stringify(originalNeed.operation) === JSON.stringify(c.envelope), 'method historical origin references');
    check(m.applicability.state === 'invalidated' || a?.needTrialId === c.need, 'method available current need');
    check(m.admittedMinute<=world.canonicalMinute&&c.minute<m.admittedMinute,'method timing');
    if (m.origin.choice) check(m.origin.choice.generation === c.generation && m.origin.choice.observedMinute < c.minute && m.origin.choice.agendaRevision < m.origin.agendaRevision && m.origin.choice.siteRevision === c.siteRevision, 'method originating choice');
    check(m.revision===1?m.parentVersionId===null&&m.parentArtifactHash===null:!!parent&&parent.revision===m.revision-1&&parent.artifactHash===m.parentArtifactHash&&parent.origin.context.session===c.session&&parent.authorId===m.authorId&&JSON.stringify(parent.origin)===JSON.stringify(m.origin)&&JSON.stringify(parent.authority)===JSON.stringify(m.authority)&&JSON.stringify(parent.runtime)===JSON.stringify(m.runtime),'method parent lineage');
    check(Object.values(i.methods??{}).filter(x=>x.artifactHash===m.artifactHash&&x.origin.context.session===c.session).length===1,'method duplicate identity');
  }
  for (const d of Object.values(i.designs)) {
    const t = i.trials[d.input.need];
    check(adult(d.authorId) && i.sites[d.input.site] && t?.mode === 'baseline' && t.actorId === d.authorId && t.siteId === d.input.site, 'design need');
    check(d.createdMinute <= world.canonicalMinute, 'future design');
    check(d.input.parent === null || i.designs[d.input.parent]?.authorId === d.authorId, 'design parent');
    if (d.methodApplication && !('kind'in d.methodApplication)) {
      const app = d.methodApplication,
        m = i.methods?.[app.methodVersionId],
        t = m?.tests.find(t => t.hash === app.receiptHash),
        r = t?.results[app.caseIndex],
        e = t?.executions[app.caseIndex];
      check(m?.authorId === d.authorId && m.origin.context.need === d.input.need && m.origin.context.site === d.input.site && m.admittedMinute <= app.adoption.observedMinute && d.createdMinute === app.adoption.observedMinute + 1, 'method application origin');
      check(!!m && JSON.stringify(m.authority) === JSON.stringify(app.authority) && m.selectedReceiptHash === app.receiptHash && t?.passed && r?.passed && r.code === 'measured' && r.inputHash === app.inputHash && e?.inputHash === app.inputHash && e.firstHash === app.outputHash && JSON.stringify(r.design) === JSON.stringify({
        parts: d.input.parts,
        claim: d.input.claim
      }), 'method application exact evidence');
      check(!Object.values(i.methods ?? {}).some(x => x.origin.context.session === m?.origin.context.session && x.revision > (m?.revision ?? 0)), 'method application selected leaf');
      const basis = app.revisionBasisTrialId === null ? null : i.trials[app.revisionBasisTrialId];
      check(basis === null ? d.input.parent === null : !!basis && basis.actorId === d.authorId && basis.siteId === d.input.site && basis.designId === d.input.parent && basis.endedMinute <= app.adoption.observedMinute && basis.mode === 'assisted' && (basis.outcome === 'quality-rejected' || basis.claimVerdict === 'refuted'), 'method application paid revision basis');
    }
    if(d.methodApplication&&'kind'in d.methodApplication){
      const app=d.methodApplication,g=i.grants[app.grantId],m=i.methods?.[app.methodVersionId],e=g?.method?.executions.find(e=>e.id===app.executionId),r=e?.test.results[0],run=e?.test.executions[0];
      check(g?.learnerId===d.authorId&&g.teacherId===app.teacherId&&m?.authorId===g.teacherId&&g.method?.methodVersionId===m.id&&e?.learnerId===d.authorId&&e.context.need===d.input.need&&e.context.site===d.input.site,'reproduction original source and learner');
      check(e?.test.passed&&r?.passed&&r.code==='measured'&&e.test.hash===app.receiptHash&&run?.inputHash===app.inputHash&&run.firstHash===app.outputHash&&JSON.stringify(r.design)===JSON.stringify({parts:d.input.parts,claim:d.input.claim})&&JSON.stringify(m?.authority)===JSON.stringify(app.authority),'reproduction exact independent execution');
      const basis=app.revisionBasisTrialId===null?null:i.trials[app.revisionBasisTrialId];
      check(app.caseIndex===0&&(basis===null?(d.input.parent===null||i.designs[d.input.parent]?.status==='failed'):!!basis&&basis.actorId===d.authorId&&basis.designId===d.input.parent&&basis.siteId===d.input.site&&basis.mode==='assisted'&&basis.endedMinute<=app.adoption.observedMinute&&(basis.outcome==='quality-rejected'||basis.claimVerdict==='refuted')),'reproduction paid revision basis');
      check(!!e&&e.admittedMinute<=app.adoption.observedMinute&&d.createdMinute===app.adoption.observedMinute+1&&d.createdMinute<g!.expiresMinute,'reproduction adoption timing');
    }
    check(d.status === 'validated' === (d.ventureId === null), 'design venture status');
    if (d.status === 'building') check(source(d.ventureId!) && !source(d.ventureId!)!.outcome, 'active design source');
  }
  const associated = [...Object.values(i.designs).flatMap(d => d.ventureId ? [d.ventureId] : []), ...Object.values(i.jobs).map(j => j.ventureId),...Object.values(i.grants).flatMap(g=>g.method?.lessons.map(l=>l.ventureId)??[])];
  check(new Set(associated).size === associated.length, "venture source association reused");
  const builtDesigns = Object.values(i.artifacts).map(a => a.designId);
  check(new Set(builtDesigns).size === builtDesigns.length, "duplicate artifact for construction");
  for (const site of Object.values(i.sites)) check(Object.values(i.artifacts).filter(a => a.siteId === site.id).length + Object.values(i.designs).filter(d => d.status === "building" && d.input.site === site.id).length <= site.capacity, "equipment footprint exhausted");
  const occupied = new Set<string>();
  for (const a of Object.values(i.artifacts)) {
    check(i.designs[a.designId]?.status === 'built' && i.designs[a.designId]?.input.site === a.siteId && i.designs[a.designId]?.authorId === a.builderId && adult(a.ownerId) && adult(a.custodianId), 'artifact lineage');
    check(a.completedMinute <= world.canonicalMinute, 'future artifact');
    const key = `${a.siteId}:${a.slot}`;
    check(!occupied.has(key), 'artifact slot collision');
    occupied.add(key);
  }
  const locks = new Set<string>();
  for (const j of Object.values(i.jobs)) {
    const terminal = !['invited', 'working'].includes(j.status),
      s = source(j.ventureId);
    check(adult(j.actorId) && i.sites[j.siteId], 'job actor/site');
    if(j.grantId){const g=i.grants[j.grantId],artifact=j.artifactId&&i.artifacts[j.artifactId],app=artifact&&i.designs[artifact.designId]?.methodApplication;check(g?.learnerId===j.actorId&&!!app&&'kind'in app&&app.grantId===g.id,'job grant provenance');}
    check(j.mode === 'baseline' ? j.artifactId === null : j.artifactId !== null && i.artifacts[j.artifactId], 'job artifact');
    check(j.purpose === 'trial-only' ? j.targetProjectId === null : !!life.projects[j.targetProjectId!], 'job target');
    check(j.comparisonTrialId === null || i.trials[j.comparisonTrialId]?.mode === 'baseline', 'job comparison');
    check(terminal ? j.endedMinute !== null && (j.startedMinute === null ? (j.status === 'interrupted'||j.status==='revoked'&&!!j.grantId) && j.resultTrialId === null && j.appliedProgress === 0 : j.resultTrialId !== null && i.trials[j.resultTrialId]?.ventureId === j.ventureId) : j.endedMinute === null && j.resultTrialId === null && s && !s.outcome, 'job terminal/source');
    if (!terminal && j.artifactId) {
      check(!locks.has(j.artifactId), 'artifact exclusive use');
      locks.add(j.artifactId);
    }
    check(j.endedMinute === null || j.endedMinute <= world.canonicalMinute, 'future job');
  }
  for (const t of Object.values(i.trials)) {
    const j = Object.values(i.jobs).find(j => j.resultTrialId === t.id);
    check(j && j.actorId === t.actorId && j.siteId === t.siteId && j.ventureId === t.ventureId && j.mode === t.mode && j.purpose === t.purpose && j.status === t.outcome && j.artifactId === t.artifactId && j.buildingSkill === t.buildingSkill && j.startingCondition === t.startingCondition && j.comparisonTrialId === t.comparisonTrialId, 'trial job source');
    check(t.endedMinute <= world.canonicalMinute && t.startedMinute <= t.endedMinute, 'trial timing');
    check(t.designId === null || i.designs[t.designId], 'trial design');
    check(t.comparisonTrialId === null || i.trials[t.comparisonTrialId]?.mode === 'baseline', 'trial comparison');
  }
  for (const c of Object.values(i.consultations)) check(adult(c.requesterId) && adult(c.peerId) && c.requesterId !== c.peerId && i.sites[c.siteId] && i.trials[c.needTrialId], 'consultation references');
  for (const g of Object.values(i.grants)) {
    check(adult(g.teacherId)&&adult(g.learnerId)&&g.teacherId!==g.learnerId&&i.designs[g.designId]&&i.trials[g.trialId],'grant references');
    if(!g.method)continue;const m=g.method,version=i.methods?.[m.methodVersionId],artifact=i.artifacts[m.teacherArtifactId],teacherTrial=i.trials[g.trialId];
    check(version?.authorId===g.teacherId&&version.sourceHash===m.sourceHash&&version.artifactHash===m.artifactHash&&JSON.stringify(version.authority)===JSON.stringify(m.authority)&&artifact?.builderId===g.teacherId&&artifact.designId===g.designId&&teacherTrial?.actorId===g.teacherId&&teacherTrial.artifactId===artifact?.id&&teacherTrial.useful&&teacherTrial.outcome==='passed','grant historical useful source');
    check(new Set(m.executions.map(e=>e.id)).size===m.executions.length&&new Set(m.executions.map(e=>e.context.session)).size===m.executions.length,'learner evidence uniqueness');
    for(const e of m.executions)check(e.grantId===g.id&&e.methodVersionId===m.methodVersionId&&e.learnerId===g.learnerId&&e.context.actor===g.learnerId&&e.context.need===i.trials[e.context.need]?.id&&i.trials[e.context.need]?.actorId===g.learnerId&&e.context.site===i.designs[g.designId]?.input.site&&e.sourceHash===m.sourceHash&&e.artifactHash===m.artifactHash&&e.admittedMinute<=world.canonicalMinute,'learner independent context');
  }
  for (const a of Object.values(i.agendas)) {
    const c = a.continuation;
    if (!c) continue;
    check(c.designId === null || a.candidateIds.includes(c.designId), 'continuation design');
    check(c.artifactId === null || i.artifacts[c.artifactId]?.siteId === a.siteId, 'continuation artifact');
    check(c.comparisonTrialId === null || i.trials[c.comparisonTrialId]?.actorId === a.ownerId, 'continuation comparison');
    if (c.status === 'running') check(c.kind === 'build' ? i.designs[c.designId!]?.ventureId === c.sourceId : Object.values(i.jobs).some(j => j.ventureId === c.sourceId && j.actorId === a.ownerId && j.siteId === a.siteId && j.artifactId === c.artifactId && j.operation === c.operation && j.purpose === c.purpose && j.comparisonTrialId === c.comparisonTrialId), 'continuation paid source');
  }
  for (const p of Object.values(life.residents)) {
    const task = p.task;
    if (task?.kind === 'invention-travel') check(i.agendas[task.inventionId!]?.ownerId === p.residentId && i.sites[i.agendas[task.inventionId!]!.siteId]?.placeId === task.placeId, 'travel agenda relation');
    if (task && ['invention-build', 'assembly-trial', 'invention-teach'].includes(task.kind)) check(task.kind === 'invention-build' ? i.designs[task.inventionId!]?.ventureId === task.ventureId && i.designs[task.inventionId!]?.authorId === p.residentId : task.kind === 'assembly-trial' ? i.jobs[task.inventionId!]?.ventureId === task.ventureId && i.jobs[task.inventionId!]?.actorId === p.residentId : !!i.grants[task.inventionId!], 'invention task relation');
  }
  return errors;
}
