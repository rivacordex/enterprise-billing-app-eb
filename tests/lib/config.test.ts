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
    });
  });

  it("applies defaults when optional keys are missing", async () => {
    const { config } = await loadConfigWithEnv(VALID_REQUIRED_ENV);

    expect(config.APP_URL).toBe("http://localhost:3000");
    expect(config.LOG_LEVEL).toBe("info");
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
