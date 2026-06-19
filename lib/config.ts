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
  // Entra SSO (um10). All three optional — absence disables the Microsoft
  // provider entirely (`isSsoConfigured` below) rather than failing loud,
  // since SSO is opt-in and most local/test environments never configure it.
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
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
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
  });

  if (!parsed.success) {
    throw new AppError("INTERNAL", "Invalid environment configuration.", {
      cause: parsed.error,
    });
  }

  return Object.freeze(parsed.data);
}

export const config: Config = loadConfig();

// um10-spec §10.1. `NEXT_PUBLIC_APP_URL` is deliberately read directly here
// (not added to `envSchema`/`config`) — it's the one client-safe var
// `auth/client.ts` already reads straight from `process.env`, and adding it
// to the strict server-only schema would force every test/dev environment
// to define it even though only the redirect-URI display needs it.
export const entraConfig = {
  tenantId: config.ENTRA_TENANT_ID ?? null,
  clientId: config.MICROSOFT_CLIENT_ID ?? null,
  clientSecret: config.MICROSOFT_CLIENT_SECRET ?? null,
  // Strips a trailing slash so a `NEXT_PUBLIC_APP_URL` like
  // `http://localhost:3000/` doesn't produce a `//api/auth/...` redirect URI
  // that no longer byte-matches what's registered with the SSO provider.
  redirectUri: process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/auth/callback/microsoft`
    : null,
} as const;

// True when all three Entra env vars are present — controls whether the
// Microsoft provider is registered with Better-Auth (auth/index.ts) and
// whether the "Sign in with Microsoft" button renders (login page).
export const isSsoConfigured: boolean =
  !!entraConfig.tenantId &&
  !!entraConfig.clientId &&
  !!entraConfig.clientSecret;
