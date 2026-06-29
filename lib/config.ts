import { z } from "zod";

import { AppError } from "@/lib/errors";
import { DEFAULT_TIMEZONE, SUPPORTED_TIMEZONES } from "@/lib/locale";
import type { PasswordPolicy } from "@/types/password";

// um25-spec §"Policy source". Default allowed special-character set —
// shared between the env-var default and the doc comment in `.env.example`.
const DEFAULT_PASSWORD_SPECIAL_CHARS = `!@#$%^&*()_+-=[]{}|;':\\",./<>?`;

// Coerces the env var strings "true"/"false" to a boolean, defaulting when
// absent. Anything else (e.g. "yes") fails loud via the enum check, matching
// the "throw at startup on malformed input" rule for every PASSWORD_* var.
function booleanEnvSchema(defaultValue: "true" | "false") {
  return z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // In production this value is a Container Apps Key Vault secret reference
  // (um30) — `lib/config.ts` itself always reads it from the env either way
  // (um02); the platform resolves the reference before the process starts.
  DATABASE_URL: z.string().refine((v) => v.startsWith("postgresql://"), {
    message: "DATABASE_URL must be a postgresql:// connection string.",
  }),
  // Production sourcing is a Key Vault secret reference (um30); here
  // BETTER_AUTH_SECRET is read directly from the env (um03).
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  // Entra SSO (um10). All three optional — absence disables the Microsoft
  // provider entirely (`isSsoConfigured` below) rather than failing loud,
  // since SSO is opt-in and most local/test environments never configure it.
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  // LOCAL password policy (um25-spec §"Policy source"). All optional with
  // enforced defaults; not stored in `system_config` — this is an
  // operational parameter that requires a redeploy to change, consistent
  // with how the Entra secrets above are handled.
  PASSWORD_MIN_LENGTH: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? 15 : Number(value)))
    .pipe(z.number().int().min(1, "PASSWORD_MIN_LENGTH must be at least 1.")),
  PASSWORD_REQUIRE_UPPERCASE: booleanEnvSchema("true"),
  PASSWORD_REQUIRE_LOWERCASE: booleanEnvSchema("true"),
  PASSWORD_REQUIRE_NUMBER: booleanEnvSchema("true"),
  PASSWORD_REQUIRE_SPECIAL: booleanEnvSchema("true"),
  PASSWORD_SPECIAL_CHARS: z
    .string()
    .min(1, "PASSWORD_SPECIAL_CHARS must not be empty.")
    .default(DEFAULT_PASSWORD_SPECIAL_CHARS),
  // Business timezone (um29-spec §2.1). Optional IANA name validated against
  // the curated `SUPPORTED_TIMEZONES`; defaults to `UTC` when unset, so date
  // output is byte-identical to today until set. An unsupported/misspelled
  // zone throws at startup with a descriptive message — identical fail-fast
  // posture to `PASSWORD_MIN_LENGTH=abc`. Read once at boot, never at runtime
  // (Inv. #17 — the zone defines billing-period boundaries).
  APP_TIMEZONE: z.enum(SUPPORTED_TIMEZONES).default(DEFAULT_TIMEZONE),
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
    PASSWORD_MIN_LENGTH: process.env.PASSWORD_MIN_LENGTH,
    PASSWORD_REQUIRE_UPPERCASE: process.env.PASSWORD_REQUIRE_UPPERCASE,
    PASSWORD_REQUIRE_LOWERCASE: process.env.PASSWORD_REQUIRE_LOWERCASE,
    PASSWORD_REQUIRE_NUMBER: process.env.PASSWORD_REQUIRE_NUMBER,
    PASSWORD_REQUIRE_SPECIAL: process.env.PASSWORD_REQUIRE_SPECIAL,
    PASSWORD_SPECIAL_CHARS: process.env.PASSWORD_SPECIAL_CHARS,
    APP_TIMEZONE: process.env.APP_TIMEZONE,
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

// um25-spec §"Policy source". The single LOCAL password policy object —
// `validation/password.ts` and `services/password.ts` take this as an
// explicit parameter rather than reading `process.env` themselves.
export const passwordPolicy: PasswordPolicy = Object.freeze({
  minLength: config.PASSWORD_MIN_LENGTH,
  requireUppercase: config.PASSWORD_REQUIRE_UPPERCASE,
  requireLowercase: config.PASSWORD_REQUIRE_LOWERCASE,
  requireNumber: config.PASSWORD_REQUIRE_NUMBER,
  requireSpecial: config.PASSWORD_REQUIRE_SPECIAL,
  specialChars: config.PASSWORD_SPECIAL_CHARS,
});
