import "server-only";

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
    .pipe(
      z
        .number()
        .int()
        .min(1, "PASSWORD_MIN_LENGTH must be at least 1.")
        // Mirror `buildPasswordSchema`'s `.max(128)` hard cap: a min above it
        // makes every password schema unsatisfiable, so reject at boot
        // (fail-fast) instead of failing every validation at runtime.
        .max(128, "PASSWORD_MIN_LENGTH must be at most 128."),
    ),
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
  // bm02-spec §2 / architecture Inv. #15, renamed bm15-spec §Implementation §4.
  // While set, every bill run is loudly badged (the always-on
  // `PlaceholderBanner`) as running placeholder billing logic over seeded
  // `_SAMPLE_*` data (billmgmt-architecture.md §3). An environment flag,
  // never a per-run column (code-standards §6.11). Defaults to `false` so
  // production behavior is unchanged until a placeholder/UAT deployment
  // opts in.
  BILLRUN_PLACEHOLDER_MODE: booleanEnvSchema("false"),
  // bm03-spec §Design/§4, extended bm16-spec §Implementation §1. The outbound
  // workflow engine — treated as not-yet-deployed. URL/AUTH are both optional;
  // absence selects the stub engine client (`isEngineConfigured`,
  // `services/billing/engine-registry.ts`), so a bill run's trigger stays
  // fully testable with no live Kestra. Production sources BILLRUN_ENGINE_AUTH
  // from Key Vault via Managed Identity, matching every other credential here.
  // NAMESPACE defaults to the logical engine name — the template flow
  // (`flows/billrun/bill_run_processing.template.yml`) is deployed to the
  // `billrun` Kestra namespace.
  BILLRUN_ENGINE_URL: z.url().optional(),
  BILLRUN_ENGINE_AUTH: z.string().optional(),
  BILLRUN_ENGINE_NAMESPACE: z.string().min(1).default("billrun"),
  // bm04-spec §Implementation §4. The inbound bearer service token the
  // workflow engine (or a signed test caller) presents to `app/api/billrun/*`
  // — Key Vault in prod, `.env` locally. Optional so most environments boot
  // without it; absence means `requireServiceToken` rejects every M2M call
  // with 401 (fail-closed), never a bypass.
  BILLRUN_APP_TOKEN: z.string().min(32).optional(),
  // bm06-spec §Design/§Implementation §2. The v1 taxation model is a single
  // CONFIGURED rate — there is NO tax-rate catalog table in billing (deferred
  // with the rating engine); `bill_run.ref_tax_rate_version` is stamped once
  // per run from `BILLRUN_TAX_VERSION` for provenance. The rate parameterises a
  // SQL `numeric` expression (`round(subtotal * rate / 100, 2)`), never JS
  // float arithmetic (code-standards §2.3). All three carry the GST defaults so
  // every environment boots without them.
  // At most two decimal places — the rate is persisted/cast as `numeric(5,2)`
  // (`customer_bill_tax_item.tax_rate`), so a higher-precision value would be
  // silently rounded on store and no longer match what the amount was computed
  // from. Reject at boot instead (fail-fast). An EMPTY value (`BILLRUN_TAX_RATE=`
  // — the var present but blank) is treated as unset so the `8` default applies,
  // NOT coerced to `0`: `z.coerce.number("")` is `0`, which would silently tax
  // every bill at 0% instead of the intended default.
  BILLRUN_TAX_RATE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce
      .number()
      .min(0)
      .max(100)
      .refine(
        (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
        "BILLRUN_TAX_RATE must have at most two decimal places.",
      )
      .default(8),
  ),
  BILLRUN_TAX_VERSION: z.string().default("GST-2026"),
  BILLRUN_TAX_CATEGORY: z.string().default("GST"),
  // bm12-spec §Implementation §1. The stall threshold — a global config value
  // (the plan floats a per-cycle threshold, but there is no cycle column for
  // it, so v1 uses one config value, code-standards/architecture-supplement
  // resolved-decision). A `PROCESSING` run past this many minutes without a
  // heartbeat (`bill_run.last_progress_at`) DISPLAYS as stalled — derived on
  // read (`services/billing/stall.ts`), never persisted.
  BILLRUN_STALL_THRESHOLD_MINUTES: z.coerce.number().int().min(1).default(30),
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
    BILLRUN_PLACEHOLDER_MODE: process.env.BILLRUN_PLACEHOLDER_MODE,
    BILLRUN_ENGINE_URL: process.env.BILLRUN_ENGINE_URL,
    BILLRUN_ENGINE_AUTH: process.env.BILLRUN_ENGINE_AUTH,
    BILLRUN_ENGINE_NAMESPACE: process.env.BILLRUN_ENGINE_NAMESPACE,
    BILLRUN_APP_TOKEN: process.env.BILLRUN_APP_TOKEN,
    BILLRUN_TAX_RATE: process.env.BILLRUN_TAX_RATE,
    BILLRUN_TAX_VERSION: process.env.BILLRUN_TAX_VERSION,
    BILLRUN_TAX_CATEGORY: process.env.BILLRUN_TAX_CATEGORY,
    BILLRUN_STALL_THRESHOLD_MINUTES:
      process.env.BILLRUN_STALL_THRESHOLD_MINUTES,
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

// bm02-spec §2 / architecture Inv. #15, renamed bm15-spec §Implementation §4.
// Frozen boolean accessor for the placeholder-mode flag, threaded
// server-side into the bill-run page as a prop and on to
// `PlaceholderBanner`/`PlaceholderBadge` — never read from a client component.
export const isBillrunPlaceholderMode: boolean =
  config.BILLRUN_PLACEHOLDER_MODE;

// bm03-spec §Design/§4, extended bm16-spec §Implementation §1. Raw connection
// values for the `billrun` logical engine — read ONLY by
// `services/billing/engine-registry.ts`, which resolves them into a
// `ResolvedEngine` (connection + stable identity string) and is itself the
// sole caller of `services/billing/engine-client.ts`. Never read directly by
// `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` (code-standards §7).
export const billRunEngineConfig = {
  url: config.BILLRUN_ENGINE_URL ?? null,
  auth: config.BILLRUN_ENGINE_AUTH ?? null,
  namespace: config.BILLRUN_ENGINE_NAMESPACE,
} as const;

export const isBillRunEngineConfigured: boolean =
  !!billRunEngineConfig.url && !!billRunEngineConfig.auth;

// bm06-spec §Design/§Implementation §2-3. The v1 taxation parameters — a single
// configured GST rate/version/category, no catalog table. `services/billing/
// taxation.ts` reads this frozen accessor (never `process.env`); the rate is
// applied inside a SQL `numeric` expression, so the parsed number only
// parameterises the query.
export const billRunTaxConfig = {
  rate: config.BILLRUN_TAX_RATE,
  version: config.BILLRUN_TAX_VERSION,
  category: config.BILLRUN_TAX_CATEGORY,
} as const;

// bm12-spec §Implementation §1. `services/billing/stall.ts`'s `isStalled`
// takes this as an explicit parameter (frozen accessor, never re-reads
// process.env), so the helper stays pure and testable.
export const billRunStallThresholdMinutes: number =
  config.BILLRUN_STALL_THRESHOLD_MINUTES;

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
