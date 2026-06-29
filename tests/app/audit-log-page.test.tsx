import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (matches tests/app/system-config-page.test.tsx's
// precedent) — asserts `requirePermission` is invoked with the right
// permission/level and that its redirect propagates, not that the page
// renders pixels. The full route×level matrix lives in
// tests/auth/guard.integration.test.ts.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/audit-log/audit-log-read.service", () => ({
  getAuditLog: vi.fn(),
  getAuditLogActors: vi.fn(),
}));
// um29: the page resolves the business zone server-side; mock the synchronous
// accessor so importing the page never reaches the real `lib/config`/`db`.
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));
vi.mock("@/components/audit-log/audit-log-filters", () => ({
  AuditLogFilters: vi.fn(() => null),
}));
vi.mock("@/components/audit-log/audit-log-table", () => ({
  AuditLogTable: vi.fn(() => null),
}));
vi.mock("@/components/audit-log/audit-log-pagination", () => ({
  AuditLogPagination: vi.fn(() => null),
}));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import AuditLogPage from "@/app/(admin)/administration/audit-log/page";
import {
  getAuditLog,
  getAuditLogActors,
} from "@/services/audit-log/audit-log-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetAuditLog = vi.mocked(getAuditLog);
const mockGetAuditLogActors = vi.mocked(getAuditLogActors);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetAuditLog.mockReset();
  mockGetAuditLogActors.mockReset();
  mockGetAuditLog.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  mockGetAuditLogActors.mockResolvedValue([]);
});

describe("AuditLogPage", () => {
  it("calls requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.READ)", async () => {
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

    await AuditLogPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.AUDIT_LOG,
      LEVELS.READ,
    );
    expect(mockGetAuditLog).toHaveBeenCalled();
    expect(mockGetAuditLogActors).toHaveBeenCalled();
  });

  it("propagates the /login redirect when there is no session", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(
      AuditLogPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockGetAuditLog).not.toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a user without audit_log:READ", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      AuditLogPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockGetAuditLog).not.toHaveBeenCalled();
  });

  it("passes through page='2' from searchParams to getAuditLog", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: "READ",
      },
    });

    await AuditLogPage({ searchParams: Promise.resolve({ page: "2" }) });

    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
    );
  });

  it("coerces an invalid eventType from searchParams to null before calling getAuditLog", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: "READ",
      },
    });

    await AuditLogPage({
      searchParams: Promise.resolve({ eventType: "FAKE_EVENT" }),
    });

    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: null }),
    );
  });
});
