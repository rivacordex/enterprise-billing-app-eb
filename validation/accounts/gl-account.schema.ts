import { z } from "zod";

export const GL_ACCOUNT_CLASSES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;

export const GL_NORMAL_BALANCES = ["debit", "credit"] as const;

export const createGlCodeSchema = z.object({
  glCode: z.string().min(1).max(20).regex(/^\d+$/, "GL code must be numeric"),
  name: z.string().min(1).max(120),
  accountClass: z.enum(GL_ACCOUNT_CLASSES),
  normalBalance: z.enum(GL_NORMAL_BALANCES),
  parentGlCode: z.string().min(1).max(20).nullable().optional(),
  isPostable: z.boolean(),
});

export type CreateGlCodeInput = z.infer<typeof createGlCodeSchema>;

export const retireGlCodeSchema = z.object({
  glCode: z.string().min(1),
  // ISO string — Date objects don't survive the server-action boundary
  // (ac11 precedent; z.coerce.date() converts back for the service).
  lastModified: z.iso.datetime(),
});

export type RetireGlCodeInput = z.infer<typeof retireGlCodeSchema>;
