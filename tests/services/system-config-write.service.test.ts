import { beforeEach, describe, expect, it, vi } from "vitest";

// `system-config-write.service.ts` imports the runtime `db` instance to open
// its own transaction — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation, mirroring
// tests/services/roles-write.service.test.ts. `db.transaction` runs the
// callback against the same mocked `tx` handle the repository mock observes.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));

vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: {
    findById: vi.fn(),
    updateValue: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { updateConfigValue } from "@/services/system-config/system-config-write.service";
import type { SystemConfigDisplayRow } from "@/types/system-config";
import type { UpdateConfigInput } from "@/validation/update-config.schema";

const mockFindById = vi.mocked(systemConfigRepository.findById);
const mockUpdateValue = vi.mocked(systemConfigRepository.updateValue);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const ACTOR_ID = "actor-1";
const CONFIG_ID = "11111111-1111-1111-1111-111111111111";

function row(
  overrides: Partial<SystemConfigDisplayRow> = {},
): SystemConfigDisplayRow {
  return {
    configId: CONFIG_ID,
    configGroup: "app",
    configVersion: 1,
    configKey: "app_name",
    configValue: "old",
    description: null,
    isSecret: false,
    status: "ACTIVE",
    modifiedByUserId: "prev-actor-id",
    modifiedByName: "Prev Admin",
    lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mockFindById.mockReset();
  mockUpdateValue.mockReset();
  mockInsertAuditEvent.mockReset();
});

describe("updateConfigValue", () => {
  it("returns NOT_FOUND when the row does not exist", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await updateConfigValue(
      { configId: CONFIG_ID, configValue: "new" },
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(mockUpdateValue).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns SECRET_ROW when the row is marked secret", async () => {
    mockFindById.mockResolvedValue(row({ isSecret: true }));

    const result = await updateConfigValue(
      { configId: CONFIG_ID, configValue: "new" },
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: false, code: "SECRET_ROW" });
    expect(mockUpdateValue).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("updates the value and writes a SYSTEM_CONFIG_CHANGED audit event on the happy path", async () => {
    mockFindById.mockResolvedValue(row());

    const input: UpdateConfigInput = {
      configId: CONFIG_ID,
      configValue: "new",
    };
    const result = await updateConfigValue(input, ACTOR_ID);

    expect(result).toEqual({ ok: true });
    expect(mockUpdateValue).toHaveBeenCalledWith(
      txStub,
      CONFIG_ID,
      "new",
      ACTOR_ID,
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(txStub, {
      eventType: "SYSTEM_CONFIG_CHANGED",
      actorUserId: ACTOR_ID,
      targetEntity: "SYSTEM_CONFIG",
      targetId: CONFIG_ID,
      beforeData: {
        configGroup: "app",
        configKey: "app_name",
        configValue: "old",
        status: "ACTIVE",
        modifiedBy: "prev-actor-id",
      },
      afterData: {
        configGroup: "app",
        configKey: "app_name",
        configValue: "new",
        status: "ACTIVE",
        modifiedBy: ACTOR_ID,
      },
    });
  });

  it("updates the value to null", async () => {
    mockFindById.mockResolvedValue(row());

    const result = await updateConfigValue(
      { configId: CONFIG_ID, configValue: null },
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpdateValue).toHaveBeenCalledWith(
      txStub,
      CONFIG_ID,
      null,
      ACTOR_ID,
    );
  });

  it("captures the original modifiedBy as null in before_data when the row had no prior modifier", async () => {
    mockFindById.mockResolvedValue(row({ modifiedByUserId: null }));

    await updateConfigValue(
      { configId: CONFIG_ID, configValue: "new" },
      ACTOR_ID,
    );

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        beforeData: expect.objectContaining({ modifiedBy: null }),
      }),
    );
  });

  it("runs findById, updateValue, and insertAuditEvent against the same transaction handle", async () => {
    mockFindById.mockResolvedValue(row());

    await updateConfigValue(
      { configId: CONFIG_ID, configValue: "new" },
      ACTOR_ID,
    );

    expect(mockUpdateValue).toHaveBeenCalledWith(
      txStub,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.anything(),
    );
  });

  it("propagates a thrown error from the repository", async () => {
    mockFindById.mockResolvedValue(row());
    mockUpdateValue.mockRejectedValue(new Error("db failure"));

    await expect(
      updateConfigValue({ configId: CONFIG_ID, configValue: "new" }, ACTOR_ID),
    ).rejects.toThrow("db failure");
  });
});
