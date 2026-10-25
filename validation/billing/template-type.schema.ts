import { z } from "zod";

// bm77 — the type name as entered (normalized by the service before this runs).
export const templateTypeNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9 &()-]{3,60}$/,
    "Use 3–60 letters, digits, spaces, & ( ) or -.",
  );

// The raw input is capped at 200 characters before normalization.
export const createTemplateTypeInputSchema = z
  .object({ name: z.string().max(200) })
  .strict();

export type CreateTemplateTypeInput = z.infer<
  typeof createTemplateTypeInputSchema
>;
