import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/system-config-read.service.test.ts: mock
// `@/db/client` so importing the service never triggers `lib/config`'s
// eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/audit-log.repository", () => ({
  auditLogRepository: { findFiltered: vi.fn(), findActors: vi.fn() },
}));

// um29: `getAuditLog` resolves the business zone via `getAppTimezone()` and
// converts the picked local day to UTC bounds. Mock the resolver so the test
// can vary the zone (and so importing it never reaches the real `lib/config`).
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn(() => "UTC"),
}));

import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import {
  getAuditLog,
  getAuditLogActors,
} from "@/services/audit-log/audit-log-read.service";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import type { AuditLogRow } from "@/types/audit-log";
import type { AuditLogSearchParams } from "@/validation/audit-log-filters.schema";

const mockFindFiltered = vi.mocked(auditLogRepository.findFiltered);
const mockFindActors = vi.mocked(auditLogRepository.findActors);
const mockGetAppTimezone = vi.mocked(getAppTimezone);

beforeEach(() => {
  mockFindFiltered.mockReset();
  mockFindActors.mockReset();
  mockFindFiltered.mockResolvedValue({ rows: [], total: 0 });
  mockGetAppTimezone.mockReset().mockReturnValue("UTC");
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
  // um29-spec §2.6: with the UTC zone the conversion is the identity, so the
  // existing day-boundary behavior is preserved exactly.
  it("converts a dateFrom string to a start-of-day UTC Date (UTC zone identity)", async () => {
    await getAuditLog(baseParams({ dateFrom: "2026-01-15" }));

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateFrom).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("converts a dateTo string to an end-of-day UTC Date (UTC zone identity)", async () => {
    await getAuditLog(baseParams({ dateTo: "2026-01-20" }));

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateTo).toEqual(new Date("2026-01-20T23:59:59.999Z"));
  });

  // um29-spec §2.6: a +08 zone shifts the local-day boundary back 8 hours.
  it("converts a local day to UTC bounds for Asia/Kuala_Lumpur (UTC+8)", async () => {
    mockGetAppTimezone.mockReturnValue("Asia/Kuala_Lumpur");
    await getAuditLog(
      baseParams({ dateFrom: "2026-06-27", dateTo: "2026-06-27" }),
    );

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateFrom).toEqual(new Date("2026-06-26T16:00:00.000Z"));
    expect(filters.dateTo).toEqual(new Date("2026-06-27T15:59:59.999Z"));
  });

  // um29-spec §2.6: validates the non-integer (half-hour) offset.
  it("handles the half-hour offset for Asia/Kolkata (UTC+5:30)", async () => {
    mockGetAppTimezone.mockReturnValue("Asia/Kolkata");
    await getAuditLog(baseParams({ dateFrom: "2026-06-27" }));

    const [, filters] = mockFindFiltered.mock.calls[0]!;
    expect(filters.dateFrom).toEqual(new Date("2026-06-26T18:30:00.000Z"));
  });

  // um29-spec §2.6: a null filter stays null (unfiltered), preserving um24's
  // "never 500s" lenient-filter contract regardless of zone.
  it("passes dateFrom/dateTo through as null when absent", async () => {
    mockGetAppTimezone.mockReturnValue("Asia/Kuala_Lumpur");
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
