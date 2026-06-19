import { z } from "zod";

export const createUserSchema = z.object({
  userName: z.string().min(1, "Name is required").max(255).trim(),
  userEmail: z.string().email("Invalid email").max(255).trim().toLowerCase(),
  userPhonenum: z
    .string()
    .max(50)
    .trim()
    .nullish()
    .transform((v) => v || null),
  authMethod: z.enum(["SSO", "LOCAL"]),
  roleIds: z.array(z.string().uuid()).default([]),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
