import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<void>) => await fn({}),
    ),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findById: vi.fn(), updateValue: vi.fn() },
}));

import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { APP_NAME_MAX_LENGTH } from "@/lib/config-limits";
import { updateConfigValue } from "@/services/system-config/system-config-write.service";

const mockFindById = vi.mocked(systemConfigRepository.findById);

function rowFor(configGroup: string, configKey: string) {
  return {
    configId: "cfg-1",
    configGroup,
    configKey,
    configValue: "old",
    status: "ACTIVE",
    isSecret: false,
    modifiedByUserId: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateConfigValue — per-key length cap (D12)", () => {
  it("rejects a 41-char app_name with VALUE_TOO_LONG carrying the limit", async () => {
    mockFindById.mockResolvedValue(rowFor("app", "app_name"));
    const result = await updateConfigValue(
      { configId: "cfg-1", configValue: "a".repeat(APP_NAME_MAX_LENGTH + 1) },
      "actor-1",
    );
    expect(result).toEqual({
      ok: false,
      code: "VALUE_TOO_LONG",
      limit: APP_NAME_MAX_LENGTH,
    });
    expect(systemConfigRepository.updateValue).not.toHaveBeenCalled();
  });

  it("accepts a 40-char app_name", async () => {
    mockFindById.mockResolvedValue(rowFor("app", "app_name"));
    const result = await updateConfigValue(
      { configId: "cfg-1", configValue: "a".repeat(APP_NAME_MAX_LENGTH) },
      "actor-1",
    );
    expect(result).toEqual({ ok: true });
    expect(systemConfigRepository.updateValue).toHaveBeenCalled();
  });

  it("does not cap a different row of the same length", async () => {
    mockFindById.mockResolvedValue(rowFor("company", "company_name"));
    const result = await updateConfigValue(
      { configId: "cfg-1", configValue: "a".repeat(APP_NAME_MAX_LENGTH + 1) },
      "actor-1",
    );
    expect(result).toEqual({ ok: true });
  });

  it("counts code points, not UTF-16 units (emoji-safe)", async () => {
    // 40 emoji = 40 code points (80 UTF-16 units). A UTF-16 `.length` check
    // would wrongly reject this; code-point counting accepts it.
    mockFindById.mockResolvedValue(rowFor("app", "app_name"));
    const accepted = await updateConfigValue(
      { configId: "cfg-1", configValue: "🎉".repeat(APP_NAME_MAX_LENGTH) },
      "actor-1",
    );
    expect(accepted).toEqual({ ok: true });

    // 41 emoji = 41 code points → still rejected.
    mockFindById.mockResolvedValue(rowFor("app", "app_name"));
    const rejected = await updateConfigValue(
      { configId: "cfg-1", configValue: "🎉".repeat(APP_NAME_MAX_LENGTH + 1) },
      "actor-1",
    );
    expect(rejected).toEqual({
      ok: false,
      code: "VALUE_TOO_LONG",
      limit: APP_NAME_MAX_LENGTH,
    });
  });
});

describe("0005 seed copy ↔ constant parity (D12)", () => {
  it("the app_name description names the same number as APP_NAME_MAX_LENGTH", () => {
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../db/migrations/0005_admin_chrome_config.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(`Maximum ${APP_NAME_MAX_LENGTH} characters`);
  });
});
