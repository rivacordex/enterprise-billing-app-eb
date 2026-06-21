import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/system-config-read.service.test.ts: mock
// `@/db/client` so importing the service never triggers `lib/config`'s
// eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/audit-log.repository", () => ({
  auditLogRepository: { findFiltered: vi.fn(), findActors: vi.fn() },
}));

import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import {
  getAuditLog,
  getAuditLogActors,
} from "@/services/audit-log/audit-log-read.service";
import type { AuditLogRow } from "@/types/audit-log";
import type { AuditLogSearchParams } from "@/validation/audit-log-filters.schema";

const mockFindFiltered = vi.mocked(auditLogRepository.findFiltered);
const mockFindActors = vi.mocked(auditLogRepository.findActors);

beforeEach(() => {
  mockFindFiltered.mockReset();
  mockFindActors.mockReset();
  mockFindFiltered.mockResolvedValue({ rows: [], total: 0 });
});

function baseParams(
  overrides: Partial<AuditLogSearchParams> = {},
): AuditLogSearchParams {
  return {
    eventType: null,
    actorUserId: null,
    dateFrom: null,
    dateTo: null,
    page: 1,
    ...overrides,
  };
}

describe("getAuditLog", () => {
  it("converts a dateFrom string to a start-of-day UTC Date", async () => {
    await getAuditLog(baseParams({ dateFrom: "2026-01-15" }));

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateFrom).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("converts a dateTo string to an end-of-day UTC Date", async () => {
    await getAuditLog(baseParams({ dateTo: "2026-01-20" }));

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateTo).toEqual(new Date("2026-01-20T23:59:59.999Z"));
  });

  it("passes dateFrom/dateTo through as null when absent", async () => {
    await getAuditLog(baseParams());

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateFrom).toBeNull();
    expect(filters.dateTo).toBeNull();
  });

  it("passes eventType and actorUserId through unchanged", async () => {
    await getAuditLog(
      baseParams({ eventType: "USER_CREATED", actorUserId: "user-1" }),
    );

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.eventType).toBe("USER_CREATED");
    expect(filters.actorUserId).toBe("user-1");
  });

  it("calls findFiltered with the requested page and PAGE_SIZE 50", async () => {
    await getAuditLog(baseParams({ page: 3 }));

    expect(mockFindFiltered).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      3,
      50,
    );
  });

  it("returns an AuditLogPage shape with rows, total, page, pageSize", async () => {
    const row: AuditLogRow = {
      auditId: "audit-1",
      eventType: "USER_CREATED",
      category: "Additive",
      actorUserId: "user-1",
      actorUserName: "Admin",
      actorDeleted: false,
      targetEntity: "APPUSER",
      targetId: "user-2",
      beforeData: null,
      afterData: { userName: "New User" },
      createdDatetime: new Date("2026-01-01T00:00:00Z"),
    };
    mockFindFiltered.mockResolvedValue({ rows: [row], total: 1 });

    const result = await getAuditLog(baseParams({ page: 1 }));

    expect(result).toEqual({ rows: [row], total: 1, page: 1, pageSize: 50 });
  });
});

describe("getAuditLogActors", () => {
  it("delegates to findActors and returns the result unmodified", async () => {
    mockFindActors.mockResolvedValue([
      { userId: "user-1", userName: "Admin", isDeleted: false },
    ]);

    const result = await getAuditLogActors();

    expect(result).toEqual([
      { userId: "user-1", userName: "Admin", isDeleted: false },
    ]);
    expect(mockFindActors).toHaveBeenCalledTimes(1);
  });
});
