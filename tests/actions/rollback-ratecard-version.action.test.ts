import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/ratecard/rollback-version", () => ({
  rollbackRatecardVersion: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { rollbackRatecardVersionAction } from "@/actions/product/rollback-ratecard-version.action";
import * as rollbackVersionService from "@/services/product/ratecard/rollback-version";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRollbackRatecardVersion = vi.mocked(
  rollbackVersionService.rollbackRatecardVersion,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockRollbackRatecardVersion.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "revops@example.com",
    permissionMap: { ratecard: "EDIT" } as never,
  });
});

describe("rollbackRatecardVersionAction", () => {
  it("requires ratecard:EDIT before anything else", async () => {
    mockRollbackRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000001",
      supersededVersionId: "RCV00000002",
      diff: { added: 0, changed: 0, removed: 1 },
    });

    await rollbackRatecardVersionAction("RCV00000001");

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.RATECARD,
      LEVELS.EDIT,
    );
  });

  // pm64-spec I4.11 — a ratecard:READ principal is refused at the action guard
  // (the guard redirects) with NO partial effect: the service is never called
  // and nothing is revalidated.
  it("returns FORBIDDEN and takes no further action when the guard redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await rollbackRatecardVersionAction("RCV00000001");

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRollbackRatecardVersion).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the guard throws something other than a redirect", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    const result = await rollbackRatecardVersionAction("RCV00000001");

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRollbackRatecardVersion).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a malformed version id, before calling the service", async () => {
    const result = await rollbackRatecardVersionAction("not-an-rcv-id");

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRollbackRatecardVersion).not.toHaveBeenCalled();
  });

  it("calls the service with the parsed version id and the actor, then revalidates and returns ok:true", async () => {
    mockRollbackRatecardVersion.mockResolvedValue({
      ok: true,
      versionId: "RCV00000001",
      supersededVersionId: "RCV00000003",
      diff: { added: 2, changed: 1, removed: 3 },
    });

    const result = await rollbackRatecardVersionAction("RCV00000001");

    expect(mockRollbackRatecardVersion).toHaveBeenCalledWith(
      "RCV00000001",
      "user-1",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/rate-card");
    expect(result).toEqual({
      ok: true,
      versionId: "RCV00000001",
      supersededVersionId: "RCV00000003",
      diff: { added: 2, changed: 1, removed: 3 },
    });
  });

  it("returns the service's typed refusal unchanged and never revalidates", async () => {
    mockRollbackRatecardVersion.mockResolvedValue({
      ok: false,
      code: "NOT_SUPERSEDED",
      status: "DRAFT",
    });

    const result = await rollbackRatecardVersionAction("RCV00000001");

    expect(result).toEqual({
      ok: false,
      code: "NOT_SUPERSEDED",
      status: "DRAFT",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service call throws", async () => {
    mockRollbackRatecardVersion.mockRejectedValue(
      new Error("connection reset"),
    );

    const result = await rollbackRatecardVersionAction("RCV00000001");

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
