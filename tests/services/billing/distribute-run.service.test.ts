import { beforeEach, describe, expect, it, vi } from "vitest";

// bm20-spec §Design/§Implementation §3/§4. `distribute-run.ts` — trigger/
// rerun the distribution flow (engine call inside the txn, bm03/bm08
// pattern), record per-artifact outcomes (idempotent, T1's stale-attempt
// guard), recompute COMPLETED/DISTRIBUTION_FAILED from the recorded set, and
// T11's force-complete/abandon escape hatch.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markDistributing: vi.fn(),
    markRerunDistributing: vi.fn(),
    markDistributionFailed: vi.fn(),
    completeDistribution: vi.fn(),
    bumpHeartbeat: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-invoices.repository", () => ({
  billRunInvoicesRepository: {
    listForRun: vi.fn(),
    countForRun: vi.fn(),
    listBillingAccountIdsForRun: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-distribution.repository", () => ({
  billRunDistributionRepository: {
    insertOutcome: vi.fn(),
    listForRun: vi.fn(),
    listFailedForAttempt: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { listForRun: vi.fn(), listPostedAccountIds: vi.fn() },
}));
vi.mock("@/services/billing/engine-registry", () => ({
  engineRegistry: { trigger: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: { putReport: vi.fn() },
}));
vi.mock("@/lib/config", () => ({ billRunDistributionForceFail: false }));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { engineRegistry } from "@/services/billing/engine-registry";
import { blobStore } from "@/services/billing/blob-store";
import {
  forceCompleteDistribution,
  recomputeDistributionStatus,
  recordDistributionOutcome,
  rerunDistribution,
  triggerDistribution,
} from "@/services/billing/distribute-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkDistributing = vi.mocked(billRunRepository.markDistributing);
const mockMarkRerunDistributing = vi.mocked(
  billRunRepository.markRerunDistributing,
);
const mockMarkDistributionFailed = vi.mocked(
  billRunRepository.markDistributionFailed,
);
const mockCompleteDistribution = vi.mocked(
  billRunRepository.completeDistribution,
);
const mockBumpHeartbeat = vi.mocked(billRunRepository.bumpHeartbeat);
const mockListInvoicesForRun = vi.mocked(billRunInvoicesRepository.listForRun);
const mockCountForRun = vi.mocked(billRunInvoicesRepository.countForRun);
const mockListBillingAccountIdsForRun = vi.mocked(
  billRunInvoicesRepository.listBillingAccountIdsForRun,
);
const mockInsertOutcome = vi.mocked(billRunDistributionRepository.insertOutcome);
const mockListForRunDistribution = vi.mocked(
  billRunDistributionRepository.listForRun,
);
const mockListFailedForAttempt = vi.mocked(
  billRunDistributionRepository.listFailedForAttempt,
);
const mockListBillsForRun = vi.mocked(customerBillRepository.listForRun);
const mockListPostedAccountIds = vi.mocked(
  customerBillRepository.listPostedAccountIds,
);
const mockTrigger = vi.mocked(engineRegistry.trigger);
const mockPutReport = vi.mocked(blobStore.putReport);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    periodStart: "2026-07-01",
    status: "INVOICED",
    distributionExecutionId: null,
    distributionAttempt: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListInvoicesForRun.mockResolvedValue([
    { billRunInvoiceId: "BRI00000001", blobRef: "invoices/2026-07/INV1.pdf" },
  ]);
  mockCountForRun.mockResolvedValue(1);
  // bm21-spec §Implementation §2, T8 — the D10 safety-net check's reads.
  // Deterministic empty defaults so `hasUnrenderedPostedAccounts` (and
  // `rerunDistribution`'s never-attempted-artifact scan) start from a clean
  // slate in every test regardless of execution order; `vi.clearAllMocks()`
  // clears call/result history but NOT a previously-set `mockResolvedValue`
  // implementation, so a mock left unset here would otherwise leak whatever
  // the LAST test to configure it left behind.
  mockListPostedAccountIds.mockResolvedValue([]);
  mockListBillingAccountIdsForRun.mockResolvedValue([]);
  mockListForRunDistribution.mockResolvedValue([]);
  mockListBillsForRun.mockResolvedValue([
    {
      billingAccountId: "BAN00000001",
      accountName: "Acme",
      currency: "MYR",
      subtotal: "100.00",
      taxTotal: "8.00",
      totalAmount: "108.00",
      refInvDocumentId: "INV00000001",
    },
  ] as never);
  mockPutReport.mockResolvedValue({
    blobRef: "invoices/2026-07/BRN00000001-report.csv",
    checksum: "report-checksum",
  });
  mockTrigger.mockResolvedValue({
    executionId: "exec-dist-1",
    definitionId: "billrun.bill_run_distribution",
    definitionRevision: 0,
    engineRef: "billrun@stub/billrun",
  });
});

describe("triggerDistribution", () => {
  it("gathers artifacts, triggers the distribution flow, and moves INVOICED → DISTRIBUTING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());

    const result = await triggerDistribution("BRN00000001", null);

    expect(result).toMatchObject({
      ok: true,
      value: { executionId: "exec-dist-1", artifactCount: 2 },
    });
    expect(mockTrigger).toHaveBeenCalledWith(
      "billrun",
      "bill_run_distribution",
      expect.objectContaining({
        bill_run_id: "BRN00000001",
        attempt: 1,
        artifacts: [
          {
            ref: "BRI00000001",
            type: "invoice_pdf",
            blob_ref: "invoices/2026-07/INV1.pdf",
          },
          {
            ref: "REPORT",
            type: "report_csv",
            blob_ref: "invoices/2026-07/BRN00000001-report.csv",
          },
        ],
        targets: [{ name: "loopback", is_mandatory: true, force_fail: false }],
      }),
    );
    expect(mockMarkDistributing).toHaveBeenCalledWith(txStub, "BRN00000001", {
      distributionExecutionId: "exec-dist-1",
      distributionFlowId: "billrun.bill_run_distribution",
      distributionFlowRevision: 0,
      distributionEngineRef: "billrun@stub/billrun",
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_DISTRIBUTION_STARTED",
        actorUserId: null,
      }),
    );
  });

  it("is idempotent: a run already carrying a distribution execution is ALREADY_STARTED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ distributionExecutionId: "exec-dist-0" }),
    );

    const result = await triggerDistribution("BRN00000001", null);

    expect(result).toEqual({ ok: false, code: "ALREADY_STARTED" });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects a run that is not INVOICED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));

    const result = await triggerDistribution("BRN00000001", null);

    expect(result).toEqual({ ok: false, code: "NOT_INVOICED" });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE and rolls back (no status write) when the engine trigger fails", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockTrigger.mockRejectedValue(new Error("engine down"));

    const result = await triggerDistribution("BRN00000001", null);

    expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
    expect(mockMarkDistributing).not.toHaveBeenCalled();
  });
});

describe("recordDistributionOutcome", () => {
  const input = {
    runId: "BRN00000001",
    target: "loopback",
    artifactRef: "BRI00000001",
    artifactType: "invoice_pdf" as const,
    isMandatory: true,
    outcome: "DELIVERED" as const,
    attempt: 1,
  };

  it("inserts one outcome row for the current round", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTING", distributionAttempt: 1 }),
    );

    const result = await recordDistributionOutcome(input);

    expect(result).toEqual({ replayed: false });
    expect(mockInsertOutcome).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        refBillRunId: "BRN00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        distributionAttempt: 1,
      }),
    );
  });

  it("treats a stale-round signal (attempt mismatch) as a replayed no-op", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTING", distributionAttempt: 2 }),
    );

    const result = await recordDistributionOutcome(input);

    expect(result).toEqual({ replayed: true });
    expect(mockInsertOutcome).not.toHaveBeenCalled();
  });

  it("rejects when the run is not DISTRIBUTING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "INVOICED" }));

    await expect(recordDistributionOutcome(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("treats a stale-round signal as a replayed no-op even once the run has terminated", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "COMPLETED", distributionAttempt: 2 }),
    );

    const result = await recordDistributionOutcome(input);

    expect(result).toEqual({ replayed: true });
    expect(mockInsertOutcome).not.toHaveBeenCalled();
  });

  it("rejects a current-attempt signal once the run has left DISTRIBUTING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "COMPLETED", distributionAttempt: 1 }),
    );

    await expect(recordDistributionOutcome(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mockInsertOutcome).not.toHaveBeenCalled();
  });

  it("replays a duplicate insert (unique-violation) as a no-op", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTING", distributionAttempt: 1 }),
    );
    mockInsertOutcome.mockRejectedValue(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint_name:
          "bill_run_distribution_run_target_artifact_attempt_period_unique",
      }),
    );

    const result = await recordDistributionOutcome(input);

    expect(result).toEqual({ replayed: true });
  });

  it("rejects an outcome for an artifact/target this run never launched", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTING", distributionAttempt: 1 }),
    );
    // `mockListInvoicesForRun` (beforeEach) only ever returns "BRI00000001" —
    // a fabricated ref for this run must be rejected before insertOutcome.
    await expect(
      recordDistributionOutcome({ ...input, artifactRef: "BRI99999999" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockInsertOutcome).not.toHaveBeenCalled();
  });

  it("rejects an outcome for a target this run never configured", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTING", distributionAttempt: 1 }),
    );
    await expect(
      recordDistributionOutcome({ ...input, target: "portal" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockInsertOutcome).not.toHaveBeenCalled();
  });
});

describe("recomputeDistributionStatus", () => {
  it("flips to DISTRIBUTION_FAILED when a mandatory artifact's latest outcome failed", async () => {
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "FAILED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: "DISTRIBUTION_FAILED" });
    expect(mockMarkDistributionFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  it("flips to COMPLETED once every expected mandatory artifact is DELIVERED", async () => {
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
      {
        billRunDistributionId: "BRD00000002",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);
    mockCountForRun.mockResolvedValue(1); // 1 invoice + the report = 2 expected

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: "COMPLETED" });
    expect(mockCompleteDistribution).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  it("leaves the run unresolved (no write) when the recorded set is incomplete", async () => {
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);
    mockCountForRun.mockResolvedValue(1); // expects 2 (invoice + report), only 1 recorded

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: null });
    expect(mockMarkDistributionFailed).not.toHaveBeenCalled();
    expect(mockCompleteDistribution).not.toHaveBeenCalled();
    // Deliberately no heartbeat bump either — a genuine wedge stays flagged
    // for the operator (mirrors reconcile-run.ts's PROCESSING-mismatch rule).
    expect(mockBumpHeartbeat).not.toHaveBeenCalled();
  });

  it("supersedes a round-1 FAILED with a round-2 DELIVERED redelivery of only the failed artifact, reaching COMPLETED", async () => {
    // `rerunDistribution` only re-triggers the PRIOR round's failed
    // artifacts (§3) — round 2's own rows never cover the full mandatory
    // set on their own. The invoice already DELIVERED in round 1 must still
    // count, and round 2's DELIVERED report must supersede round 1's FAILED
    // report, not be counted alongside it.
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date("2026-07-01T00:00:00Z"),
        distributionAttempt: 1,
      },
      {
        billRunDistributionId: "BRD00000002",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "FAILED",
        at: new Date("2026-07-01T00:00:00Z"),
        distributionAttempt: 1,
      },
      {
        billRunDistributionId: "BRD00000003",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date("2026-07-02T00:00:00Z"),
        distributionAttempt: 2,
      },
    ]);
    mockCountForRun.mockResolvedValue(1); // 1 invoice + the report = 2 expected

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: "COMPLETED" });
    expect(mockMarkDistributionFailed).not.toHaveBeenCalled();
    expect(mockCompleteDistribution).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  // bm21-spec §Implementation §2, Phase-2 review fold T8 — "assert the D10
  // safety net end-to-end". Every mandatory artifact the trigger actually
  // launched (the report) is DELIVERED, but a SECOND account is POSTED with
  // no stored `bill_run_invoices` row (render-pending, bm19's D10 gap) — it
  // was never even an artifact this run could have triggered. Must never
  // silently reach COMPLETED around it.
  it("never completes around a posted account with no stored invoice, even when every triggered artifact was delivered", async () => {
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);
    mockCountForRun.mockResolvedValue(0); // no stored invoices at all yet
    mockListPostedAccountIds.mockResolvedValue(["BAN00000001"]);
    mockListBillingAccountIdsForRun.mockResolvedValue([]); // nothing stored

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: "DISTRIBUTION_FAILED" });
    expect(mockMarkDistributionFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
    expect(mockCompleteDistribution).not.toHaveBeenCalled();
  });

  it("completes normally once the posted account's invoice is stored (no more render-pending gap)", async () => {
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
      {
        billRunDistributionId: "BRD00000002",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 2,
      },
    ]);
    mockCountForRun.mockResolvedValue(1);
    mockListPostedAccountIds.mockResolvedValue(["BAN00000001"]);
    mockListBillingAccountIdsForRun.mockResolvedValue(["BAN00000001"]);

    const result = await recomputeDistributionStatus(txStub as never, {
      billRunId: "BRN00000001",
    });

    expect(result).toEqual({ status: "COMPLETED" });
    expect(mockMarkDistributionFailed).not.toHaveBeenCalled();
    expect(mockCompleteDistribution).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });
});

describe("rerunDistribution", () => {
  it("redelivers only the failed artifacts under a bumped attempt", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTION_FAILED", distributionAttempt: 1 }),
    );
    // rerunDistribution derives both "failed" and "never-attempted" from ONE
    // read of the full delivery log (billRunDistributionRepository.listForRun)
    // — no separate listFailedForAttempt call any more (bm21-spec T8).
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "FAILED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);

    const result = await rerunDistribution("BRN00000001", "user-1");

    expect(result).toMatchObject({
      ok: true,
      value: { attempt: 2, artifactCount: 1 },
    });
    expect(mockTrigger).toHaveBeenCalledWith(
      "billrun",
      "bill_run_distribution",
      expect.objectContaining({ attempt: 2 }),
    );
    expect(mockMarkRerunDistributing).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      expect.objectContaining({ distributionAttempt: 2 }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({ eventType: "BILL_RUN_DISTRIBUTION_RERUN" }),
    );
  });

  it("rejects a run that is not DISTRIBUTION_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "DISTRIBUTING" }));

    const result = await rerunDistribution("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_RERUNNABLE" });
  });

  it("returns NO_FAILED_ARTIFACTS when nothing is currently failed and nothing is newly available", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTION_FAILED", distributionAttempt: 1 }),
    );
    // The stored invoice (mockListInvoicesForRun, beforeEach) was already
    // DELIVERED in round 1 — attempted, and not failed, so neither set
    // picks it up.
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);

    const result = await rerunDistribution("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NO_FAILED_ARTIFACTS" });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns NO_FAILED_ARTIFACTS (never triggers the engine) when every failed artifact's blob reference has vanished", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTION_FAILED", distributionAttempt: 1 }),
    );
    // No stored invoices at all in this scenario — the failed artifact
    // referencing BRI99999999 can't be resolved via listForRun (bm19), and
    // there is nothing else stored to pick up as never-attempted either.
    mockListInvoicesForRun.mockResolvedValue([]);
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "BRI99999999",
        artifactType: "invoice_pdf",
        isMandatory: true,
        outcome: "FAILED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);

    const result = await rerunDistribution("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NO_FAILED_ARTIFACTS" });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockMarkRerunDistributing).not.toHaveBeenCalled();
  });

  // bm21-spec §Implementation §2, T8 — "retry-render + rerun-distribution
  // reaches COMPLETED". A stored invoice that was never part of ANY prior
  // round's outcome set (rendered/stored AFTER the top-level trigger ran,
  // e.g. via retryRenderInvoice) is redelivered too, not just genuinely
  // FAILED artifacts — using its own real stored identity.
  it("also redelivers a never-before-attempted stored invoice (a late retry-render), even with zero FAILED artifacts", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTION_FAILED", distributionAttempt: 1 }),
    );
    // The report was already DELIVERED in round 1 — an attempted artifact,
    // never redelivered again.
    mockListForRunDistribution.mockResolvedValue([
      {
        billRunDistributionId: "BRD00000001",
        target: "loopback",
        artifactRef: "REPORT",
        artifactType: "report_csv",
        isMandatory: true,
        outcome: "DELIVERED",
        at: new Date(),
        distributionAttempt: 1,
      },
    ]);
    // `mockListInvoicesForRun` (beforeEach) returns BRI00000001 — never
    // attempted in any round above, so it's picked up as never-attempted.

    const result = await rerunDistribution("BRN00000001", "user-1");

    expect(result).toMatchObject({
      ok: true,
      value: { attempt: 2, artifactCount: 1 },
    });
    expect(mockTrigger).toHaveBeenCalledWith(
      "billrun",
      "bill_run_distribution",
      expect.objectContaining({
        attempt: 2,
        artifacts: [
          {
            ref: "BRI00000001",
            type: "invoice_pdf",
            blob_ref: "invoices/2026-07/INV1.pdf",
          },
        ],
      }),
    );
  });
});

describe("forceCompleteDistribution", () => {
  it("abandons the failed artifacts and flips DISTRIBUTION_FAILED → COMPLETED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "DISTRIBUTION_FAILED", distributionAttempt: 1 }),
    );
    mockListFailedForAttempt.mockResolvedValue([
      {
        target: "loopback",
        artifactRef: "BRI00000001",
        artifactType: "invoice_pdf",
        isMandatory: true,
      },
    ]);
    mockCompleteDistribution.mockResolvedValue(true);

    const result = await forceCompleteDistribution(
      "BRN00000001",
      "approver-1",
      "Loopback permanently unreachable",
    );

    expect(result).toEqual({
      ok: true,
      value: { billRunId: "BRN00000001", abandonedCount: 1 },
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_DISTRIBUTION_ABANDONED",
        actorUserId: "approver-1",
      }),
    );
  });

  it("rejects a run that is not DISTRIBUTION_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "DISTRIBUTING" }));

    const result = await forceCompleteDistribution(
      "BRN00000001",
      "approver-1",
      "reason",
    );

    expect(result).toEqual({ ok: false, code: "NOT_ABANDONABLE" });
  });
});
