import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/system-config/system-config-write.service", () => ({
  updateConfigValue: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateConfigAction } from "@/actions/system-config/update-config.action";
import * as systemConfigWriteService from "@/services/system-config/system-config-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateConfigValue = vi.mocked(
  systemConfigWriteService.updateConfigValue,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { configId: randomUUID(), configValue: "new-value" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateConfigValue.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "actor-id",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: "EDIT",
      audit_log: null,
    },
  });
});

describe("updateConfigAction", () => {
  it("returns VALIDATION_ERROR for a malformed configId without calling the service", async () => {
    const result = await updateConfigAction({
      configId: "bad",
      configValue: "x",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.configId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateConfigValue).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (insufficient level) without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await updateConfigAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateConfigValue).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND from the service and does not revalidate", async () => {
    mockUpdateConfigValue.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const result = await updateConfigAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SECRET_ROW from the service and does not revalidate", async () => {
    mockUpdateConfigValue.mockResolvedValue({ ok: false, code: "SECRET_ROW" });

    const result = await updateConfigAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SECRET_ROW" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws and does not revalidate", async () => {
    mockUpdateConfigValue.mockRejectedValue(new Error("db exploded"));

    const result = await updateConfigAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("updates the value and revalidates the system-config path on success", async () => {
    mockUpdateConfigValue.mockResolvedValue({ ok: true });

    const result = await updateConfigAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.SYSTEM_CONFIG,
      LEVELS.EDIT,
    );
    expect(mockUpdateConfigValue).toHaveBeenCalledWith(VALID_INPUT, "actor-id");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/administration/system-config",
    );
  });

  it("passes the actorUserId sourced from requirePermission, not from input", async () => {
    mockUpdateConfigValue.mockResolvedValue({ ok: true });

    await updateConfigAction(VALID_INPUT);

    expect(mockUpdateConfigValue).toHaveBeenCalledWith(
      expect.anything(),
      "actor-id",
    );
  });
});
