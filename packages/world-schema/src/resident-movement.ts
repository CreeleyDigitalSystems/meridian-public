import {z} from "zod";
const id=z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const minute=z.number().int().nonnegative();
export const FrontierWorksiteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quay"), sector: z.number().int().min(0).max(7) }).strict(),
  z.object({ kind: z.literal("ground"), parcelId: id }).strict(),
]);
export type FrontierWorksite = z.infer<typeof FrontierWorksiteSchema>;
export const FrontierTripSchema = z.object({
  policy: z.literal(1), site: FrontierWorksiteSchema, fromPlaceId: id,
  phase: z.enum(["travelling", "working"]), arrivesMinute: minute,
}).strict();
export type FrontierTrip = z.infer<typeof FrontierTripSchema>;
export const ResidentWalkSchema = z.object({ policy: z.literal(1), fromPlaceId: id, arrivesMinute: minute }).strict();
export type ResidentWalk = z.infer<typeof ResidentWalkSchema>;
/** Physical return after settled work. It keeps the actual worksite until the destination is reached. */
export const FrontierReturnSchema=z.object({
 policy:z.literal(1),site:FrontierWorksiteSchema,fromPlaceId:id,arrivesMinute:minute,
 targetParcelId:id,sourceStartedMinute:minute,
}).strict();
export type FrontierReturn=z.infer<typeof FrontierReturnSchema>;
