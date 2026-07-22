import { z } from "zod";

import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";

export const createSpecificationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Specification name is required")
    .max(200, "Specification name must be 200 characters or fewer"),
  isMandatory: z.boolean(),
  isDefault: z.boolean(),
  defaultValue: z
    .string()
    .trim()
    .max(500, "Default value must be 500 characters or fewer")
    .nullable()
    .default(null),
  productSpecCharacteristics: productSpecCharacteristicsSchema,
});

export type CreateSpecificationInput = z.infer<
  typeof createSpecificationSchema
>;
