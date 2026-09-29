import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/ratecard/activate-version", () => ({
  activateRatecardVersion: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { activateRatecardVersionAction } from "@/actions/product/activate-ratecard-version.action";
import * as activateVersionService from "@/services/product/ratecard/activate-version";

const mockRequirePermission = vi.mocked(requirePermission);
const mockActivateRatecardVersion = vi.mocked(
  activateVersionService.activateRatecardVersion,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockActivateRatecardVersion.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "revops@example.com",
    permissionMap: { ratecard: "EDIT" } as never,
  });
});

describe("activateRatecardVersionAction", () => {
  it("requires ratecard:EDIT before anything else", async () => {
    mockActivateRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000002",
      supersededVersionId: "RCV00000001",
      diff: { added: 1, changed: 0, removed: 0 },
    });

    await activateRatecardVersionAction("RCV00000002");

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.RATECARD,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN and takes no further action when the guard redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await activateRatecardVersionAction("RCV00000002");

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockActivateRatecardVersion).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the guard throws something other than a redirect", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    const result = await activateRatecardVersionAction("RCV00000002");

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockActivateRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a malformed version id, before calling the service", async () => {
    const result = await activateRatecardVersionAction("not-an-rcv-id");

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockActivateRatecardVersion).not.toHaveBeenCalled();
  });

  it("calls the service with the parsed version id and the actor, then revalidates and returns ok:true", async () => {
    mockActivateRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000002",
      supersededVersionId: "RCV00000001",
      diff: { added: 3, changed: 1, removed: 2 },
    });

    const result = await activateRatecardVersionAction("RCV00000002");

    expect(mockActivateRatecardVersion).toHaveBeenCalledWith(
      "RCV00000002",
      "user-1",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/rate-card");
    expect(result).toEqual({
      ok: true,
      versionId: "RCV00000002",
      supersededVersionId: "RCV00000001",
      diff: { added: 3, changed: 1, removed: 2 },
    });
  });

  it("returns the service's typed refusal unchanged and never revalidates", async () => {
    mockActivateRatecardVersion.mockResolvedValue({
      ok: false,
      code: "NOT_DRAFT",
      status: "ACTIVE",
    });

    const result = await activateRatecardVersionAction("RCV00000002");

    expect(result).toEqual({
      ok: false,
      code: "NOT_DRAFT",
      status: "ACTIVE",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service call throws", async () => {
    mockActivateRatecardVersion.mockRejectedValue(new Error("connection reset"));

    const result = await activateRatecardVersionAction("RCV00000002");

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
