import { z } from 'zod';
import { AssemblyEnvelopeSchema, AssemblyMaterialsSchema, AssemblyPartSchema, AssemblyClaimSchema, InventionIdSchema, WorkbenchContextSchema } from './invention.js';
const score=z.number().int().min(0).max(100), minute=z.number().int().nonnegative(), hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ContextSchema=WorkbenchContextSchema;
export type WorkbenchContext=z.infer<typeof ContextSchema>;
export const OutputSchema=z.object({parts:z.array(AssemblyPartSchema).min(2).max(6),claim:AssemblyClaimSchema}).strict();
export type ModuleOutput=z.infer<typeof OutputSchema>;
export const SubmitSchema=z.object({source:z.string().min(1).refine(s=>s.isWellFormed(), 'source must be well-formed Unicode').refine(s=>Buffer.byteLength(s,'utf8')<=8192),revision:z.number().int().min(1).max(8),parent:hash.nullable()}).strict();
export const TestSchema=z.object({artifact:hash,fixtureSet:InventionIdSchema}).strict();
export const ProposeSchema=z.object({artifact:hash,receipt:hash}).strict();
export const FixtureSchema=z.object({id:InventionIdSchema,cases:z.array(z.object({envelope:AssemblyEnvelopeSchema,skill:score,condition:score}).strict()).min(1).max(8)}).strict();
export type FixtureSet=z.infer<typeof FixtureSchema>;

export const TerminationSchema = z.enum(['completed','proposed','malformed','invalid-usage','multiple-calls','unknown-tool','incomplete','refusal','output-budget','input-budget','response-budget','unavailable','duplicate-call-id','invalid-tool-arguments','terminated','session-deadline','request-budget','request-deadline','aborted','stale-writer','stale-observation','cleanup-failed','spend-budget','unverified-model-or-tier','executor-unavailable','observation-unavailable']);
/** Host faults, never resident results: no receipt, no paid continuation, operator recovery before any further execution. */
export const HostInterventionSchema=TerminationSchema.extract(['cleanup-failed','executor-unavailable','observation-unavailable']);
export const isHostIntervention=(termination:unknown)=>HostInterventionSchema.safeParse(termination).success;
export const ArtifactSchema = SubmitSchema.extend({hash,sourceHash:hash,actor:InventionIdSchema,session:InventionIdSchema,contextHash:hash}).strict();
const caseCode=z.enum(['measured','execution-failed','invalid-output','invalid-graph','nondeterministic']);
export const CaseResultSchema = z.object({inputHash:hash,passed:z.boolean(),code:caseCode,quality:score.nullable(),duration:z.number().int().min(2).max(16).nullable(),design:OutputSchema.nullable()}).strict().refine(r=>r.code==='measured'?(r.quality!==null&&r.duration!==null&&r.design!==null):(!r.passed&&r.quality===null&&r.duration===null&&r.design===null));
export const ReceiptSchema=z.object({hash,actor:InventionIdSchema,session:InventionIdSchema,contextHash:hash,artifact:hash,fixtureSet:InventionIdSchema,fixtureHash:hash,passed:z.boolean(),results:z.array(CaseResultSchema).min(1).max(8)}).strict();
export const ObservationSchema=z.object({actor:InventionIdSchema,generation:InventionIdSchema,minute,need:InventionIdSchema,site:InventionIdSchema,siteRevision:minute,contextHash:hash}).strict();
export const BridgeProposalSchema=z.object({kind:z.literal('workbench-method'),artifact:hash,receipt:hash,sourceHash:hash,observation:ObservationSchema,design:OutputSchema,hash}).strict();
/** Private diagnostics only: never retain a schema message, raw path, argument value or exception. */
export const ToolArgumentFailureSchema=z.object({
 tool:z.enum(['submit_module','test_module','propose_method']),
 field:z.enum(['arguments','source','revision','parent','artifact','fixtureSet','receipt']),
 issue:z.enum(['invalid-json','type','missing','extra','range','reference','source','schema']),
}).strict().refine(f=>f.field==='arguments'||(f.tool==='submit_module'?['source','revision','parent']:f.tool==='test_module'?['artifact','fixtureSet']:['artifact','receipt']).includes(f.field));
export type ToolArgumentFailure=z.infer<typeof ToolArgumentFailureSchema>;
export const MetricSchema=z.object({request:z.number().int().min(1).max(12),inputTokens:minute.nullable(),outputTokens:minute.nullable(),totalTokens:minute.nullable(),latencyMs:minute,termination:TerminationSchema,toolFailure:ToolArgumentFailureSchema.optional()}).strict().refine(m=>m.inputTokens===null?m.outputTokens===null&&m.totalTokens===null:m.outputTokens!==null&&m.totalTokens===m.inputTokens+m.outputTokens).refine(m=>!m.toolFailure||m.termination==='invalid-tool-arguments');
export const JournalSchema=z.object({version:z.literal(1),context:ContextSchema,createdAt:minute,artifacts:z.array(ArtifactSchema).max(8),receipts:z.array(ReceiptSchema).max(64),proposals:z.array(BridgeProposalSchema).max(1),requests:z.number().int().min(0).max(12),metrics:z.array(MetricSchema).max(12),termination:TerminationSchema.nullable()}).strict();
/** The only shape the workbench request composer accepts: public numbers, owned lineage and closed measured feedback. */
const reference=z.number().int().min(1).max(8), parent=hash.nullable();
/** Exactly the numeric input the module received for a tested case: public envelope/skill/condition and the actor's already-scoped materials. */
export const WorkbenchCaseInputSchema=z.object({envelope:AssemblyEnvelopeSchema,skill:score,condition:score,materials:AssemblyMaterialsSchema}).strict();
/** Host-derived facets of a measured result explain a failure: required quality, the module's own claim, available materials. */
const facet=z.boolean().nullable();
export const WorkbenchFeedbackSchema=z.object({inputHash:hash,current:z.boolean(),case:WorkbenchCaseInputSchema,passed:z.boolean(),code:caseCode,quality:score.nullable(),duration:z.number().int().min(2).max(16).nullable(),qualityMet:facet,claimMet:facet,materialsMet:facet}).strict().refine(r=>r.code==='measured'
 ?(r.quality!==null&&r.duration!==null&&r.qualityMet!==null&&r.claimMet!==null&&r.materialsMet!==null&&r.passed===(r.qualityMet&&r.claimMet&&r.materialsMet))
 :(!r.passed&&r.quality===null&&r.duration===null&&r.qualityMet===null&&r.claimMet===null&&r.materialsMet===null));
export const SafeWorkbenchInputSchema=z.object({
 context:z.object({envelope:AssemblyEnvelopeSchema,skill:score,condition:score,materials:AssemblyMaterialsSchema,evidence:z.array(z.object({reference,quality:score,duration:z.number().int().min(2).max(16)}).strict()).max(8)}).strict(),
 fixtureSets:z.array(InventionIdSchema).max(8),
 saved:z.object({
  latest:z.object({hash,source:SubmitSchema.shape.source,sourceHash:hash,revision:reference,parent}).strict().nullable(),
  versions:z.array(z.object({hash,revision:reference,parent}).strict()).max(8),
  tests:z.array(z.object({hash,artifact:hash,passed:z.boolean(),results:z.array(WorkbenchFeedbackSchema).max(8)}).strict()).max(8),
 }).strict(),
}).strict();
export type SafeWorkbenchInput=z.infer<typeof SafeWorkbenchInputSchema>;
