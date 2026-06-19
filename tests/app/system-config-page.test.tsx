import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (matches tests/app/users-page.test.tsx's
// precedent) — asserts `requirePermission` is invoked with the right
// permission/level and that its redirect propagates, not that the page
// renders pixels. The full route×level matrix lives in
// tests/auth/guard.integration.test.ts.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/config", () => ({
  entraConfig: { tenantId: null, clientId: null, redirectUri: null },
}));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import SystemConfigPage from "@/app/(admin)/administration/system-config/page";

const mockRequirePermission = vi.mocked(requirePermission);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
});

describe("SystemConfigPage", () => {
  it("calls requirePermission(PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ)", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: "DELETE",
        roles: "DELETE",
        system_config: "DELETE",
        audit_log: "READ",
      },
    });

    await SystemConfigPage();

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.SYSTEM_CONFIG,
      LEVELS.READ,
    );
  });

  it("propagates the /no-access redirect for a no-grants user", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(SystemConfigPage()).rejects.toThrow();
  });

  it("propagates the /login redirect when there is no session", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(SystemConfigPage()).rejects.toThrow();
  });
});
