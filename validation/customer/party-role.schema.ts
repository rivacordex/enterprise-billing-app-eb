import { z } from "zod";

export const partyRoleIdSchema = z.string().regex(/^PTRL\d{8}$/);

export const statusReasonSchema = z.string().trim().min(1).max(500);

// Every mutation in a customer's scope extends this — Module Inv. #6.
export const optimisticLockSchema = z.object({
  lastModifiedDatetime: z.coerce.date(),
});

export const statusTransitionInputSchema = z
  .object({
    statusReason: statusReasonSchema,
  })
  .merge(optimisticLockSchema);
