import { afterEach, describe, expect, it, vi } from "vitest";

const VALID_EMAIL = "admin@example.com";
const VALID_PASSWORD = "a".repeat(16);

describe("loadBootstrapAdminConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a valid env", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", VALID_EMAIL);
    vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", VALID_PASSWORD);

    const { loadBootstrapAdminConfig } =
      await import("@/db/seeds/seed-admin.config");

    expect(loadBootstrapAdminConfig()).toEqual({
      BOOTSTRAP_ADMIN_EMAIL: VALID_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: VALID_PASSWORD,
    });
  });

  it("fails loud when BOOTSTRAP_ADMIN_EMAIL is not a valid email", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "not-an-email");
    vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", VALID_PASSWORD);

    const { loadBootstrapAdminConfig } =
      await import("@/db/seeds/seed-admin.config");

    expect(() => loadBootstrapAdminConfig()).toThrow();
  });

  it("fails loud when BOOTSTRAP_ADMIN_PASSWORD is too short", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", VALID_EMAIL);
    vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", "short");

    const { loadBootstrapAdminConfig } =
      await import("@/db/seeds/seed-admin.config");

    expect(() => loadBootstrapAdminConfig()).toThrow();
  });

  it("fails loud when both are missing", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
    vi.stubEnv("BOOTSTRAP_ADMIN_PASSWORD", "");
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;

    const { loadBootstrapAdminConfig } =
      await import("@/db/seeds/seed-admin.config");

    expect(() => loadBootstrapAdminConfig()).toThrow();
  });
});
