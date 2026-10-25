import { z } from "zod";
import { ResidentTaskSchema } from "./resident-life.js";

/**
 * Read-only history of committed AI decisions: `resident-action-resolved`
 * events with `source: "local-model"` and `outcome: "accepted"`, newest first,
 * bounded to the verified ledger head. Not a canonical event or world state.
 */
const id = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sequence = z.number().int().nonnegative();

export const AI_DECISION_HISTORY_DEFAULT_LIMIT = 25;
export const AI_DECISION_HISTORY_MAX_LIMIT = 100;

export const AiDecisionRowSchema = z.object({
  /** Ledger sequence of the resolved event (stable identity). */
  sequence: z.number().int().positive(),
  minute: sequence,
  residentId: id,
  optionId: id,
  /** Task kind/label from the same minute's committed resident-life change when it carries local-model attribution; otherwise null. */
  kind: ResidentTaskSchema.shape.kind.nullable(),
  label: z.string().min(1).max(160).nullable(),
}).strict();
export type AiDecisionRow = z.infer<typeof AiDecisionRowSchema>;

export const AiDecisionHistorySchema = z.object({
  scope: z.literal("saved-world-history"),
  total: sequence,
  asOfSequence: sequence,
  rows: z.array(AiDecisionRowSchema).max(AI_DECISION_HISTORY_MAX_LIMIT),
  /** Pass as `before` to fetch older rows; null when the page reached the oldest decision. */
  nextCursor: z.number().int().positive().nullable(),
}).strict().superRefine((history, context) => {
  for (let index = 0; index < history.rows.length; index += 1) {
    const row = history.rows[index]!;
    if (row.sequence > history.asOfSequence) context.addIssue({ code: "custom", message: "row beyond the verified head", path: ["rows", index] });
    const previous = history.rows[index - 1];
    if (previous !== undefined && row.sequence >= previous.sequence) context.addIssue({ code: "custom", message: "rows must be strictly newest first", path: ["rows", index] });
  }
  const last = history.rows.at(-1);
  if (history.nextCursor !== null && (last === undefined || history.nextCursor !== last.sequence)) context.addIssue({ code: "custom", message: "nextCursor must be the last row's sequence", path: ["nextCursor"] });
  if (history.rows.length > history.total) context.addIssue({ code: "custom", message: "page cannot exceed total", path: ["rows"] });
});
export type AiDecisionHistory = z.infer<typeof AiDecisionHistorySchema>;

export function parseAiDecisionHistory(input: unknown): AiDecisionHistory {
  return AiDecisionHistorySchema.parse(input);
}
