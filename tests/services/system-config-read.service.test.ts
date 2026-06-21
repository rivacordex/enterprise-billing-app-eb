import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/roles-read.service.test.ts: mock `@/db/client` so
// importing the service never triggers `lib/config`'s eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findAllNonSecret: vi.fn() },
}));

import { db } from "@/db/client";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { getSystemConfigParams } from "@/services/system-config/system-config-read.service";
import type { SystemConfigDisplayRow } from "@/types/system-config";

const mockFindAllNonSecret = vi.mocked(systemConfigRepository.findAllNonSecret);

beforeEach(() => {
  mockFindAllNonSecret.mockReset();
});

const ROW: SystemConfigDisplayRow = {
  configId: "id-1",
  configGroup: "app",
  configVersion: 1,
  configKey: "app_name",
  configValue: "Enterprise Billing System",
  isSecret: false,
  status: "ACTIVE",
  modifiedByUserId: null,
  modifiedByName: null,
  lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
};

describe("getSystemConfigParams", () => {
  it("delegates to findAllNonSecret and returns the result unmodified", async () => {
    mockFindAllNonSecret.mockResolvedValue([ROW]);

    const result = await getSystemConfigParams();

    expect(result).toEqual([ROW]);
    expect(mockFindAllNonSecret).toHaveBeenCalledTimes(1);
    expect(mockFindAllNonSecret).toHaveBeenCalledWith(db);
  });

  it("returns [] when the repository returns []", async () => {
    mockFindAllNonSecret.mockResolvedValue([]);

    const result = await getSystemConfigParams();

    expect(result).toEqual([]);
  });
});
