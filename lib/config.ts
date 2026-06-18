import { z } from "zod";

import { AppError } from "@/lib/errors";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Production sourcing moves to Azure Key Vault via Managed Identity (um25);
  // here it is read directly from the env (um02).
  DATABASE_URL: z.string().refine((v) => v.startsWith("postgresql://"), {
    message: "DATABASE_URL must be a postgresql:// connection string.",
  }),
  // Production sourcing moves to Azure Key Vault via Managed Identity (um25);
  // here BETTER_AUTH_SECRET is read directly from the env (um03).
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    APP_URL: process.env.APP_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DATABASE_URL: process.env.DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  });

  if (!parsed.success) {
    throw new AppError("INTERNAL", "Invalid environment configuration.", {
      cause: parsed.error,
    });
  }

  return Object.freeze(parsed.data);
}

export const config: Config = loadConfig();
