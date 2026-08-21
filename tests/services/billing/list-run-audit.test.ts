import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Design/§Implementation §2. The run Audit read delegates to the
// platform audit-log repository, filtered to `target_id = runId`.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/audit-log.repository", () => ({
  auditLogRepository: { findByTargetId: vi.fn() },
}));

import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { listRunAudit } from "@/services/billing/read/list-run-audit";
import type { AuditLogRow } from "@/types/audit-log";

const mockFindByTargetId = vi.mocked(auditLogRepository.findByTargetId);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listRunAudit (bm07-spec §2)", () => {
  it("reads the run's events by target_id and returns them unchanged", async () => {
    const events: AuditLogRow[] = [
      {
        auditId: "01AUDIT",
        eventType: "BILL_RUN_TRIGGERED",
        category: "Change",
        actorUserId: "user-1",
        actorUserName: "Ops User",
        actorDeleted: false,
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        beforeData: null,
        afterData: null,
        createdDatetime: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    mockFindByTargetId.mockResolvedValue(events);

    const rows = await listRunAudit("BRN00000001");

    expect(mockFindByTargetId).toHaveBeenCalledWith(
      expect.anything(),
      "BRN00000001",
    );
    expect(rows).toBe(events);
  });
});
