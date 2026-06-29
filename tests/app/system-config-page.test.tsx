import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (matches tests/app/users-page.test.tsx's
// precedent) — asserts `requirePermission` is invoked with the right
// permission/level and that its redirect propagates, not that the page
// renders pixels. The full route×level matrix lives in
// tests/auth/guard.integration.test.ts. um23 adds a `ConfigTable` mock so
// the `canEdit` prop derivation can be asserted without rendering the real
// table.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/config", () => ({
  entraConfig: { tenantId: null, clientId: null, redirectUri: null },
}));
vi.mock("@/services/system-config/system-config-read.service", () => ({
  getSystemConfigParams: vi.fn(),
}));
// um29: the page resolves the business zone server-side (read-only strip +
// ConfigTable prop); mock the synchronous accessor so importing the page never
// reaches the real `lib/config`/`db`.
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));
vi.mock("@/components/system-config/config-table", () => ({
  ConfigTable: vi.fn(() => null),
}));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import SystemConfigPage from "@/app/(admin)/administration/system-config/page";
import { ConfigTable } from "@/components/system-config/config-table";
import { getSystemConfigParams } from "@/services/system-config/system-config-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetSystemConfigParams = vi.mocked(getSystemConfigParams);
const mockConfigTable = vi.mocked(ConfigTable);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetSystemConfigParams.mockReset();
  mockGetSystemConfigParams.mockResolvedValue([]);
  mockConfigTable.mockClear();
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
    expect(mockGetSystemConfigParams).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a no-grants user without fetching config", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(SystemConfigPage()).rejects.toThrow();
    expect(mockGetSystemConfigParams).not.toHaveBeenCalled();
  });

  it("propagates the /login redirect when there is no session", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(SystemConfigPage()).rejects.toThrow();
    expect(mockGetSystemConfigParams).not.toHaveBeenCalled();
  });

  it("passes canEdit={true} to ConfigTable when permissionMap has system_config:EDIT", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: "DELETE",
        roles: "DELETE",
        system_config: "EDIT",
        audit_log: "READ",
      },
    });

    render(await SystemConfigPage());

    expect(mockConfigTable).toHaveBeenCalledWith(
      expect.objectContaining({ canEdit: true }),
      undefined,
    );
  });

  it("passes canEdit={false} to ConfigTable when permissionMap has only system_config:READ", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: "READ",
        audit_log: null,
      },
    });

    render(await SystemConfigPage());

    expect(mockConfigTable).toHaveBeenCalledWith(
      expect.objectContaining({ canEdit: false }),
      undefined,
    );
  });

  it("passes canEdit={true} to ConfigTable when permissionMap has system_config:DELETE (implies EDIT)", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: "DELETE",
        audit_log: null,
      },
    });

    render(await SystemConfigPage());

    expect(mockConfigTable).toHaveBeenCalledWith(
      expect.objectContaining({ canEdit: true }),
      undefined,
    );
  });
});
