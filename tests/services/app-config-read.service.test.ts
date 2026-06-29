import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock `@/db/client` so importing the service never triggers `lib/config`'s
// eager env validation (mirrors system-config-read.service.test.ts).
vi.mock("@/db/client", () => ({ db: {} }));

// um29: `getAppTimezone` reads `config.APP_TIMEZONE` directly, so the service
// now imports `@/lib/config`. Mock it (the `@/db/client` mock no longer covers
// the chain) — both to avoid eager env validation and to fix the zone.
vi.mock("@/lib/config", () => ({
  config: { APP_TIMEZONE: "Asia/Kuala_Lumpur" },
}));

vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findActiveValue: vi.fn() },
}));

import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import {
  getAppCurrency,
  getAppLocale,
  getAppTimezone,
  getBrandingLogo,
} from "@/services/system-config/app-config-read.service";

const mockFindActiveValue = vi.mocked(systemConfigRepository.findActiveValue);

// `React.cache` memoizes per-render; in a plain test there is no React render
// scope, so each call runs the underlying function fresh — fine here.
beforeEach(() => {
  mockFindActiveValue.mockReset();
});

// Helper: route findActiveValue(group, key) to a fixture map.
function stub(values: Record<string, string | null>): void {
  mockFindActiveValue.mockImplementation(
    async (_db, group: string, key: string) =>
      values[`${group}/${key}`] ?? null,
  );
}

describe("getBrandingLogo", () => {
  it("returns null (⇒ wordmark) when app_logo_path is blank", async () => {
    stub({ "app/app_logo_path": "", "app/app_name": "Acme" });
    expect(await getBrandingLogo()).toBeNull();
  });

  it("returns null when app_logo_path is unset", async () => {
    stub({});
    expect(await getBrandingLogo()).toBeNull();
  });

  it("returns the logo with app_name as alt for a valid /brand/ path", async () => {
    stub({
      "app/app_logo_path": "/brand/logo.svg",
      "app/app_name": "Acme Telco",
    });
    expect(await getBrandingLogo()).toEqual({
      src: "/brand/logo.svg",
      alt: "Acme Telco",
    });
  });

  it("includes markSrc only when a valid mark path is set", async () => {
    stub({
      "app/app_logo_path": "/brand/logo.svg",
      "app/app_logo_mark_path": "/brand/mark.svg",
      "app/app_name": "Acme",
    });
    expect(await getBrandingLogo()).toEqual({
      src: "/brand/logo.svg",
      markSrc: "/brand/mark.svg",
      alt: "Acme",
    });
  });

  it("falls back to a default alt when app_name is blank", async () => {
    stub({ "app/app_logo_path": "/brand/logo.svg", "app/app_name": "" });
    const logo = await getBrandingLogo();
    expect(logo?.alt).toBe("Enterprise Billing");
  });

  // The path renders into an <img src> on the unauthenticated login page, so
  // an external / data: / protocol-relative / traversal value must be treated
  // as unset (⇒ wordmark), never rendered.
  it.each([
    ["https://evil.example/logo.svg"],
    ["//evil.example/logo.svg"],
    ["data:image/svg+xml,<svg/>"],
    ["javascript:alert(1)"],
    ["/brand/../../etc/passwd"],
    ["/public/logo.svg"],
  ])("rejects an unsafe logo path (%s) ⇒ null", async (path) => {
    stub({ "app/app_logo_path": path, "app/app_name": "Acme" });
    expect(await getBrandingLogo()).toBeNull();
  });
});

describe("getAppLocale", () => {
  it("returns an allow-listed locale unchanged", async () => {
    stub({ "app/locale": "en-MY" });
    expect(await getAppLocale()).toBe("en-MY");
  });

  it("falls back to DEFAULT_LOCALE for an unknown value", async () => {
    stub({ "app/locale": "ja-JP" });
    expect(await getAppLocale()).toBe("en-GB");
  });

  it("falls back to DEFAULT_LOCALE when unset", async () => {
    stub({});
    expect(await getAppLocale()).toBe("en-GB");
  });
});

describe("getAppCurrency", () => {
  it("returns an allow-listed currency unchanged", async () => {
    stub({ "app/default_currency": "SGD" });
    expect(await getAppCurrency()).toBe("SGD");
  });

  it("falls back to DEFAULT_CURRENCY for an unknown value", async () => {
    stub({ "app/default_currency": "XXX" });
    expect(await getAppCurrency()).toBe("MYR");
  });
});

describe("getAppTimezone (um29)", () => {
  // A plain synchronous accessor over `config.APP_TIMEZONE` (no DB read, no
  // `React.cache`); the mocked config above fixes the zone.
  it("returns the configured APP_TIMEZONE", () => {
    expect(getAppTimezone()).toBe("Asia/Kuala_Lumpur");
  });
});
