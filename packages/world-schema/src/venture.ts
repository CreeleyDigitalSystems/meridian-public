import { z } from "zod";

/**
 * Canonical ventures for `city-life-2` worlds: resident-proposed, consented,
 * resourced projects run by the pure lifecycle kernel. Shapes mirror
 * `@meridian/world-kernel` `project-lifecycle.ts` exactly so committed state
 * and the kernel ledger are the same value. `city-life-1` saves never carry
 * this field; older readers fail closed on the new engine version.
 */
const id = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const minute = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const label = z.string().min(1).max(160);

export const VentureStatusSchema = z.enum(["proposed", "planning", "resourcing", "active", "completed", "failed", "abandoned"]);
export const VentureConsentSchema = z.enum(["invited", "accepted", "declined", "expired"]);
export const VentureOutcomeReasonSchema = z.enum(["all-steps-complete", "consent-declined", "consent-timeout", "resources-unavailable", "unknown-resource", "deadline-passed", "participant-withdrew", "abandoned-by-proposer"]);
export const VentureRequirementSchema = z.object({ resourceId: id, quantity: positive }).strict();
export const VentureStepSchema = z.object({
  id, label, durationMinutes: positive, requires: z.array(VentureRequirementSchema).max(4),
  status: z.enum(["pending", "running", "done", "aborted"]), startedMinute: minute.nullable(), completedMinute: minute.nullable(), consumed: z.array(VentureRequirementSchema).max(4),
}).strict();
export const VentureParticipantSchema = z.object({ residentId: id, consent: VentureConsentSchema, invitedMinute: minute, respondedMinute: minute.nullable() }).strict();
export const VentureRecordSchema = z.object({
  id, label, placeId: id, proposerId: id, status: VentureStatusSchema, sequence: positive,
  proposedMinute: minute, consentDeadlineMinute: minute, deadlineMinute: minute,
  steps: z.array(VentureStepSchema).min(1).max(8), participants: z.array(VentureParticipantSchema).max(8),
  outcome: z.object({ minute, result: z.enum(["completed", "failed", "abandoned"]), reason: VentureOutcomeReasonSchema }).strict().nullable(),
  history: z.array(z.object({ minute, status: VentureStatusSchema }).strict()).max(12),
}).strict();
export type VentureRecord = z.infer<typeof VentureRecordSchema>;

export const VentureReservationRecordSchema = z.object({
  requestId: id, planId: id, resourceId: id, residentId: id, quantity: positive, grantedMinute: minute, expiryMinute: minute, sequence: positive,
  status: z.enum(["active", "consumed", "released", "expired"]), terminalMinute: minute.nullable(), terminalSequence: positive.nullable(),
}).strict();
export const VentureResourceLedgerSchema = z.object({
  version: z.literal(1), resourceId: id, stock: count, committedMinute: minute, lastRequestSequence: count, eventSequence: count,
  active: z.array(VentureReservationRecordSchema).max(128), terminal: z.array(VentureReservationRecordSchema).max(128),
}).strict();
export type VentureResourceLedger = z.infer<typeof VentureResourceLedgerSchema>;

export const VentureLedgerSchema = z.object({
  formatVersion: z.literal(1), nextSequence: positive, nextRequestSequence: positive,
  resources: z.record(id, VentureResourceLedgerSchema), projects: z.record(id, VentureRecordSchema), retired: z.array(VentureRecordSchema).max(32),
}).strict().superRefine((ledger, context) => {
  for (const [key, record] of Object.entries(ledger.projects)) {
    if (record.id !== key) context.addIssue({ code: "custom", message: "venture key must match its id", path: ["projects", key] });
    if (["completed", "failed", "abandoned"].includes(record.status)) context.addIssue({ code: "custom", message: "open ventures cannot be terminal", path: ["projects", key] });
  }
  for (const [key, ledgerEntry] of Object.entries(ledger.resources)) if (ledgerEntry.resourceId !== key) context.addIssue({ code: "custom", message: "resource key must match its id", path: ["resources", key] });
  for (const [index, record] of ledger.retired.entries()) if (!["completed", "failed", "abandoned"].includes(record.status)) context.addIssue({ code: "custom", message: "retired ventures must be terminal", path: ["retired", index] });
  if (Object.keys(ledger.projects).length > 16) context.addIssue({ code: "custom", message: "at most 16 open ventures", path: ["projects"] });
});
export type VentureLedger = z.infer<typeof VentureLedgerSchema>;

export const VentureCountersSchema = z.object({ nextSequence: positive, nextRequestSequence: positive }).strict();
export const VentureChangedEventSchema = z.object({ type: z.literal("venture-changed"), minute, ventureId: id, before: VentureRecordSchema.nullable(), after: VentureRecordSchema.nullable(), evicted: VentureRecordSchema.optional() }).strict()
  .refine((event) => event.before !== null || event.after !== null, { message: "venture change needs a before or an after" })
  .refine(event=>event.evicted===undefined||event.after!==null&&["completed","failed","abandoned"].includes(event.after.status)&&event.evicted.id!==event.after.id&&["completed","failed","abandoned"].includes(event.evicted.status),{message:"eviction requires a distinct terminal before-image"});
export const VentureResourceChangedEventSchema = z.object({ type: z.literal("venture-resource-changed"), minute, resourceId: id, before: VentureResourceLedgerSchema.nullable(), after: VentureResourceLedgerSchema }).strict();
export const VentureCountersChangedEventSchema = z.object({ type: z.literal("venture-counters-changed"), minute, before: VentureCountersSchema, after: VentureCountersSchema }).strict();
