import { z } from "zod";

export const BILL_CYCLE_FREQUENCIES = [
  "monthly",
  "quarterly",
  "annually",
] as const;

export const upsertBillCycleSchema = z.object({
  // Absent on new cycles; present when editing (identifies the row to update).
  billCycleId: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  frequency: z.enum(BILL_CYCLE_FREQUENCIES),
  cycleDay: z.number().int().min(1).max(28),
  paymentDueDays: z.number().int().min(0),
  // ISO string — present when editing (CAS lock); absent for new cycles.
  lastModified: z.iso.datetime().optional(),
});

export type UpsertBillCycleInput = z.infer<typeof upsertBillCycleSchema>;

export const retireBillCycleSchema = z.object({
  billCycleId: z.string().min(1),
  lastModified: z.iso.datetime(),
});

export type RetireBillCycleInput = z.infer<typeof retireBillCycleSchema>;
