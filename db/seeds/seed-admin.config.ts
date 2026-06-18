import { z } from "zod";

import { AppError } from "@/lib/errors";

// Kept separate from `lib/config.ts` (the shared runtime config, loaded on
// every process import) since these credentials are only needed by the
// one-shot `db:seed` script, not every app process.
const bootstrapAdminEnvSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(16),
});

export type BootstrapAdminConfig = Readonly<
  z.infer<typeof bootstrapAdminEnvSchema>
>;

export function loadBootstrapAdminConfig(): BootstrapAdminConfig {
  const parsed = bootstrapAdminEnvSchema.safeParse({
    BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });

  if (!parsed.success) {
    throw new AppError(
      "INTERNAL",
      "Invalid bootstrap admin environment configuration.",
      { cause: parsed.error },
    );
  }

  return Object.freeze(parsed.data);
}
