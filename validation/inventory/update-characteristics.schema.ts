import { z } from "zod";

import { characteristicsRecordSchema } from "@/validation/characteristics.schema";

const inventoryIdSchema = z
  .string()
  .trim()
  .regex(/^PRDINV\d{8}$/, "Invalid product inventory id");

// `instance_characteristics` is the only editable billing-adjacent field
// (architecture Inv. #15) — audited, never a rating input. A flat string→string
// record, guarded here before any JSONB write (Inv. #4 shape discipline).
export const updateCharacteristicsSchema = z.object({
  inventoryId: inventoryIdSchema,
  characteristics: characteristicsRecordSchema,
});

export type UpdateCharacteristicsInput = z.infer<
  typeof updateCharacteristicsSchema
>;
