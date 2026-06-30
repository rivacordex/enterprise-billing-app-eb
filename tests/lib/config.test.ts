import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "NODE_ENV",
  "APP_URL",
  "LOG_LEVEL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "ENTRA_TENANT_ID",
  "NEXT_PUBLIC_APP_URL",
  "PASSWORD_MIN_LENGTH",
  "PASSWORD_REQUIRE_UPPERCASE",
  "PASSWORD_REQUIRE_LOWERCASE",
  "PASSWORD_REQUIRE_NUMBER",
  "PASSWORD_REQUIRE_SPECIAL",
  "PASSWORD_SPECIAL_CHARS",
  "APP_TIMEZONE",
] as const;

const VALID_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/db";
const VALID_BETTER_AUTH_SECRET = "a".repeat(32);
const VALID_BETTER_AUTH_URL = "http://localhost:3000";

const VALID_REQUIRED_ENV = {
  DATABASE_URL: VALID_DATABASE_URL,
  BETTER_AUTH_SECRET: VALID_BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: VALID_BETTER_AUTH_URL,
};

async function loadConfigWithEnv(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) {
      vi.stubEnv(key, "");
      delete process.env[key];
    } else {
      vi.stubEnv(key, env[key]);
    }
  }
  return import("@/lib/config");
}

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a valid env", async () => {
    const { config } = await loadConfigWithEnv({
      NODE_ENV: "production",
      APP_URL: "https://billing.example.com",
      LOG_LEVEL: "warn",
      ...VALID_REQUIRED_ENV,
    });

    expect(config).toEqual({
      NODE_ENV: "production",
      APP_URL: "https://billing.example.com",
      LOG_LEVEL: "warn",
      ...VALID_REQUIRED_ENV,
      PASSWORD_MIN_LENGTH: 15,
      PASSWORD_REQUIRE_UPPERCASE: true,
      PASSWORD_REQUIRE_LOWERCASE: true,
      PASSWORD_REQUIRE_NUMBER: true,
      PASSWORD_REQUIRE_SPECIAL: true,
      PASSWORD_SPECIAL_CHARS: `!@#$%^&*()_+-=[]{}|;':\\",./<>?`,
      APP_TIMEZONE: "UTC",
    });
  });

  it("applies defaults when optional keys are missing", async () => {
    const { config } = await loadConfigWithEnv(VALID_REQUIRED_ENV);

    expect(config.APP_URL).toBe("http://localhost:3000");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.PASSWORD_MIN_LENGTH).toBe(15);
    expect(config.PASSWORD_REQUIRE_UPPERCASE).toBe(true);
    expect(config.PASSWORD_REQUIRE_LOWERCASE).toBe(true);
    expect(config.PASSWORD_REQUIRE_NUMBER).toBe(true);
    expect(config.PASSWORD_REQUIRE_SPECIAL).toBe(true);
    expect(config.PASSWORD_SPECIAL_CHARS).toBe(
      `!@#$%^&*()_+-=[]{}|;':\\",./<>?`,
    );
    expect(config.APP_TIMEZONE).toBe("UTC");
  });

  it("fails loud on an invalid env", async () => {
    // `vi.resetModules()` gives `@/lib/config` a fresh `@/lib/errors` module
    // instance, so assert on the thrown error's shape rather than `instanceof`.
    await expect(
      loadConfigWithEnv({
        NODE_ENV: "staging",
        ...VALID_REQUIRED_ENV,
      }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "INTERNAL",
    });
  });

  it("fails loud when DATABASE_URL is missing or malformed", async () => {
    await expect(
      loadConfigWithEnv({
        NODE_ENV: "production",
        APP_URL: "https://billing.example.com",
        LOG_LEVEL: "warn",
        BETTER_AUTH_SECRET: VALID_BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: VALID_BETTER_AUTH_URL,
      }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "INTERNAL",
    });

    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        DATABASE_URL: "not-a-postgres-url",
      }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "INTERNAL",
    });
  });

  it("fails loud when BETTER_AUTH_SECRET is too short", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("fails loud when BETTER_AUTH_URL is not a valid URL", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        BETTER_AUTH_URL: "not-a-url",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });
});

describe("APP_TIMEZONE (um29)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to UTC when unset (behavior-preserving)", async () => {
    const { config } = await loadConfigWithEnv(VALID_REQUIRED_ENV);
    expect(config.APP_TIMEZONE).toBe("UTC");
  });

  it("accepts a supported IANA zone", async () => {
    const { config } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      APP_TIMEZONE: "Asia/Kuala_Lumpur",
    });
    expect(config.APP_TIMEZONE).toBe("Asia/Kuala_Lumpur");
  });

  it("fails loud at boot on an unsupported zone (like PASSWORD_MIN_LENGTH=abc)", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        APP_TIMEZONE: "Mars/Olympus",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("fails loud at boot on a raw offset (IANA names only)", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        APP_TIMEZONE: "+08",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });
});

describe("passwordPolicy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies all defaults when no PASSWORD_* vars are set", async () => {
    const { passwordPolicy } = await loadConfigWithEnv(VALID_REQUIRED_ENV);

    expect(passwordPolicy).toEqual({
      minLength: 15,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSpecial: true,
      specialChars: `!@#$%^&*()_+-=[]{}|;':\\",./<>?`,
    });
  });

  it("overrides PASSWORD_MIN_LENGTH", async () => {
    const { passwordPolicy } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      PASSWORD_MIN_LENGTH: "8",
    });

    expect(passwordPolicy.minLength).toBe(8);
  });

  it("disables a rule when its PASSWORD_REQUIRE_* var is false", async () => {
    const { passwordPolicy } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      PASSWORD_REQUIRE_SPECIAL: "false",
    });

    expect(passwordPolicy.requireSpecial).toBe(false);
  });

  it("throws a descriptive startup error when PASSWORD_MIN_LENGTH is not a number", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        PASSWORD_MIN_LENGTH: "abc",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("throws when PASSWORD_MIN_LENGTH is less than 1", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        PASSWORD_MIN_LENGTH: "0",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("throws when PASSWORD_MIN_LENGTH exceeds the 128 hard cap", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        PASSWORD_MIN_LENGTH: "129",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("throws when a PASSWORD_REQUIRE_* var is neither true nor false", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        PASSWORD_REQUIRE_UPPERCASE: "yes",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("throws when PASSWORD_SPECIAL_CHARS is empty", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        PASSWORD_SPECIAL_CHARS: "",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });
});

describe("entraConfig / isSsoConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is unconfigured when all three Entra vars are absent", async () => {
    const { entraConfig, isSsoConfigured } =
      await loadConfigWithEnv(VALID_REQUIRED_ENV);

    expect(isSsoConfigured).toBe(false);
    expect(entraConfig.tenantId).toBeNull();
    expect(entraConfig.clientId).toBeNull();
    expect(entraConfig.clientSecret).toBeNull();
  });

  it("is unconfigured when only some of the three Entra vars are present", async () => {
    const { isSsoConfigured } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      MICROSOFT_CLIENT_ID: "client-id",
      ENTRA_TENANT_ID: "tenant-id",
    });

    expect(isSsoConfigured).toBe(false);
  });

  it("is configured when all three Entra vars are present", async () => {
    const { entraConfig, isSsoConfigured } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      ENTRA_TENANT_ID: "tenant-id",
    });

    expect(isSsoConfigured).toBe(true);
    expect(entraConfig.tenantId).toBe("tenant-id");
    expect(entraConfig.clientId).toBe("client-id");
    expect(entraConfig.clientSecret).toBe("client-secret");
  });

  it("computes the redirect URI from NEXT_PUBLIC_APP_URL", async () => {
    const { entraConfig } = await loadConfigWithEnv({
      ...VALID_REQUIRED_ENV,
      NEXT_PUBLIC_APP_URL: "https://billing.example.com",
    });

    expect(entraConfig.redirectUri).toBe(
      "https://billing.example.com/api/auth/callback/microsoft",
    );
  });

  it("leaves the redirect URI null when NEXT_PUBLIC_APP_URL is absent", async () => {
    const { entraConfig } = await loadConfigWithEnv(VALID_REQUIRED_ENV);

    expect(entraConfig.redirectUri).toBeNull();
  });
});
