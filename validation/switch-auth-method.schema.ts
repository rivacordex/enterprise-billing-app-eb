import { z } from "zod";

export const switchAuthMethodSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  newAuthMethod: z.enum(["SSO", "LOCAL"]),
});

export type SwitchAuthMethodInput = z.infer<typeof switchAuthMethodSchema>;
