import { z } from "zod";

const orderIdSchema = z
  .string()
  .trim()
  .regex(/^PRDORD\d{8}$/, "Invalid product order id");

const reasonSchema = z
  .string()
  .trim()
  .max(1000, "Reason must be 1000 characters or fewer");

// Two derived schemas off one order-id base (spec §4). Approve: reason
// optional. Reject: reason required, min 1. Reviewer ≠ submitter is enforced
// in the service and backstopped by the DB CHECK (architecture Inv. #22), not
// here — it needs the order's submitter identity.
export const approveOrderSchema = z.object({
  orderId: orderIdSchema,
  reason: reasonSchema.optional(),
});

export const rejectOrderSchema = z.object({
  orderId: orderIdSchema,
  reason: reasonSchema.min(1, "A rejection reason is required"),
});

export type ApproveOrderInput = z.infer<typeof approveOrderSchema>;
export type RejectOrderInput = z.infer<typeof rejectOrderSchema>;
