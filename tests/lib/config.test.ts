import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "NODE_ENV",
  "APP_URL",
  "LOG_LEVEL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BOOTSTRAP_ADMIN_EMAIL",
  "BOOTSTRAP_ADMIN_PASSWORD",
] as const;

const VALID_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/db";
const VALID_BETTER_AUTH_SECRET = "a".repeat(32);
const VALID_BETTER_AUTH_URL = "http://localhost:3000";
const VALID_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
const VALID_BOOTSTRAP_ADMIN_PASSWORD = "a".repeat(16);

const VALID_REQUIRED_ENV = {
  DATABASE_URL: VALID_DATABASE_URL,
  BETTER_AUTH_SECRET: VALID_BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: VALID_BETTER_AUTH_URL,
  BOOTSTRAP_ADMIN_EMAIL: VALID_BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD: VALID_BOOTSTRAP_ADMIN_PASSWORD,
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
        BOOTSTRAP_ADMIN_EMAIL: VALID_BOOTSTRAP_ADMIN_EMAIL,
        BOOTSTRAP_ADMIN_PASSWORD: VALID_BOOTSTRAP_ADMIN_PASSWORD,
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

  it("fails loud when BOOTSTRAP_ADMIN_EMAIL is not a valid email", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        BOOTSTRAP_ADMIN_EMAIL: "not-an-email",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("fails loud when BOOTSTRAP_ADMIN_PASSWORD is too short", async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_REQUIRED_ENV,
        BOOTSTRAP_ADMIN_PASSWORD: "short",
      }),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });
});
