import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Visual/§Implementation §9 — the Workflow tab's derived read:
// per-account, per-stage cells (null = no signal yet) and the summary,
// always derived, never a stored cache. 2026-09-18 adds the derived app-side
// stages (scoping/posting/rendering), drops `distribution` from the grid, and
// adds the run-level flow progress bar.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listStatusesForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-account-stage.repository", () => ({
  billRunAccountStageRepository: { listLatestForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-invoices.repository", () => ({
  billRunInvoicesRepository: { listBillingAccountIdsForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-distribution.repository", () => ({
  billRunDistributionRepository: { hasAbandonedArtifactsForRun: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { getStageTimeline } from "@/services/billing/read/get-stage-timeline";
import { STAGES, TIMELINE_STAGES } from "@/types/billing";
import type { RunFlowStep, StageTimelineRow } from "@/types/billing";

const mockListStatuses = vi.mocked(billRunAccountRepository.listStatusesForRun);
const mockListLatest = vi.mocked(
  billRunAccountStageRepository.listLatestForRun,
);
const mockListRendered = vi.mocked(
  billRunInvoicesRepository.listBillingAccountIdsForRun,
);
const mockHasAbandoned = vi.mocked(
  billRunDistributionRepository.hasAbandonedArtifactsForRun,
);

function stageRow(overrides: Record<string, unknown>) {
  return {
    billRunAccountStageId: "BRS00000001",
    refBillRunId: "BRN00000001",
    refBillingAccountId: "BAN00000001",
    periodPartition: "2026-07-01",
    stage: "collection",
    attempt: 1,
    status: "DONE",
    startedAt: null,
    endedAt: null,
    errorClass: null,
    errorCode: null,
    errorDetail: null,
    ...overrides,
  } as never;
}

function cell(row: StageTimelineRow | undefined, stage: string) {
  return row?.cells.find((c) => c.stage === stage);
}

function step(steps: RunFlowStep[], stage: string) {
  return steps.find((s) => s.stage === stage);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListRendered.mockResolvedValue([]);
  mockHasAbandoned.mockResolvedValue(false);
});

describe("getStageTimeline", () => {
  it("builds one row per account, one cell per TIMELINE stage, filling signalled stages and leaving unsignalled ones null", async () => {
    mockListStatuses.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        status: "PROCESSING",
        errorCode: null,
      },
      { billingAccountId: "BAN00000002", status: "EXCLUDED", errorCode: null },
    ]);
    mockListLatest.mockResolvedValue([stageRow({})]);

    const { rows, summary } = await getStageTimeline("BRN00000001");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.cells).toHaveLength(TIMELINE_STAGES.length);
    expect(cell(rows[0], "collection")).toEqual({
      stage: "collection",
      status: "DONE",
      errorClass: null,
    });
    expect(cell(rows[0], "validation")).toEqual({
      stage: "validation",
      status: null,
      errorClass: null,
    });

    expect(summary).toEqual({
      total: 2,
      processed: 0,
      processingFailed: 0,
      excluded: 1,
      isMidFlight: true,
    });
  });

  // `distribution` is tracked per (target, artifact) in `bill_run_distribution`,
  // and its REPORT artifact belongs to no account at all, so a per-account cell
  // cannot be derived honestly. It lives on the flow bar instead.
  it("[CRITICAL] does not render a per-account distribution cell", async () => {
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "COMPLETED", errorCode: null },
    ]);
    mockListLatest.mockResolvedValue([]);

    const { rows } = await getStageTimeline("BRN00000001");

    expect(cell(rows[0], "distribution")).toBeUndefined();
    expect(TIMELINE_STAGES).not.toContain("distribution");
    // ...but the DB-aligned enum still carries it (the stage CHECK is unchanged).
    expect(STAGES).toContain("distribution");
  });

  describe("derived app-side stages", () => {
    it("scoping is DONE for a scoped account and SKIPPED for an EXCLUDED one", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "PROCESSED",
          errorCode: null,
        },
        {
          billingAccountId: "BAN00000002",
          status: "EXCLUDED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);

      const { rows } = await getStageTimeline("BRN00000001");

      expect(cell(rows[0], "scoping")?.status).toBe("DONE");
      expect(cell(rows[1], "scoping")?.status).toBe("SKIPPED");
    });

    // `approveRun` re-badges EXCLUDED -> SKIPPED, so after approval the status
    // alone no longer identifies a scoping-time exclusion; `PARTIAL_PERIOD`
    // (Inv #26) survives on `error_code` and is what must be keyed on. Without
    // this, a partial-period account reads "scoping: DONE" on a COMPLETED run.
    it("[CRITICAL] scoping stays SKIPPED for a partial-period account after approval re-badges it", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000005",
          status: "SKIPPED",
          errorCode: "PARTIAL_PERIOD",
        },
      ]);
      mockListLatest.mockResolvedValue([]);

      const { rows } = await getStageTimeline("BRN00000001");

      expect(cell(rows[0], "scoping")?.status).toBe("SKIPPED");
    });

    it("posting is DONE once the account is INVOICED, SKIPPED when skipped, FAILED when parked under ANY error code", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "INVOICED",
          errorCode: null,
        },
        {
          billingAccountId: "BAN00000002",
          status: "SKIPPED",
          errorCode: "ZERO_TOTAL_NOT_INVOICED",
        },
        {
          billingAccountId: "BAN00000003",
          status: "PROCESSED",
          errorCode: "POSTING_FAILED",
        },
        {
          billingAccountId: "BAN00000004",
          status: "PROCESSED",
          errorCode: null,
        },
        {
          // Parked on a first-class posting failure whose code is NOT the
          // literal "POSTING_FAILED" — must still read FAILED, not a
          // misleading PENDING (mirrors get-posting-progress.ts).
          billingAccountId: "BAN00000005",
          status: "PROCESSED",
          errorCode: "PERIOD_CLOSED",
        },
      ]);
      mockListLatest.mockResolvedValue([]);

      const { rows } = await getStageTimeline("BRN00000001");

      expect(cell(rows[0], "posting")?.status).toBe("DONE");
      expect(cell(rows[1], "posting")?.status).toBe("SKIPPED");
      expect(cell(rows[2], "posting")?.status).toBe("FAILED");
      // Approved but not yet posted — genuinely pending, not a failure.
      expect(cell(rows[3], "posting")?.status).toBeNull();
      expect(cell(rows[4], "posting")?.status).toBe("FAILED");
    });

    it("rendering is DONE only for an account with a stored invoice", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "INVOICED",
          errorCode: null,
        },
        {
          billingAccountId: "BAN00000002",
          status: "INVOICED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
      mockListRendered.mockResolvedValue(["BAN00000001"]);

      const { rows } = await getStageTimeline("BRN00000001");

      expect(cell(rows[0], "rendering")?.status).toBe("DONE");
      // Posted but the PDF is not stored yet — render-pending is the truth here.
      expect(cell(rows[1], "rendering")?.status).toBeNull();
    });

    it("[CRITICAL] a real stage row always wins over the derivation", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "EXCLUDED",
          errorCode: null,
        },
      ]);
      // An EXCLUDED account would derive scoping=SKIPPED; a genuine signal says
      // otherwise and must not be overwritten.
      mockListLatest.mockResolvedValue([
        stageRow({ stage: "scoping", status: "DONE" }),
      ]);

      const { rows } = await getStageTimeline("BRN00000001");

      expect(cell(rows[0], "scoping")?.status).toBe("DONE");
    });
  });

  describe("run flow progress", () => {
    it("marks distribution done only when the run is COMPLETED", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "COMPLETED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
      mockListRendered.mockResolvedValue(["BAN00000001"]);

      const { flow } = await getStageTimeline("BRN00000001", "COMPLETED");

      expect(step(flow.steps, "distribution")?.state).toBe("done");
      expect(flow.steps).toHaveLength(STAGES.length);
    });

    it("marks distribution FAILED (not done) for a force-completed run with abandoned artifacts", async () => {
      // A COMPLETED run reached via T11's force-complete path carries abandoned
      // FAILED artifacts; the bar must not show a clean `done` over them.
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "COMPLETED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
      mockListRendered.mockResolvedValue(["BAN00000001"]);
      mockHasAbandoned.mockResolvedValue(true);

      const { flow } = await getStageTimeline("BRN00000001", "COMPLETED");

      expect(mockHasAbandoned).toHaveBeenCalledWith(
        expect.anything(),
        "BRN00000001",
      );
      expect(step(flow.steps, "distribution")?.state).toBe("failed");
    });

    it("anchors on distribution while the run is DISTRIBUTING", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "DISTRIBUTING",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
      mockListRendered.mockResolvedValue(["BAN00000001"]);

      const { flow } = await getStageTimeline("BRN00000001", "DISTRIBUTING");

      expect(step(flow.steps, "distribution")?.state).toBe("current");
      expect(flow.currentStage).toBe("distribution");
    });

    it("reports distribution failed when the run is DISTRIBUTION_FAILED", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "INVOICED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
      mockListRendered.mockResolvedValue(["BAN00000001"]);

      const { flow } = await getStageTimeline(
        "BRN00000001",
        "DISTRIBUTION_FAILED",
      );

      expect(step(flow.steps, "distribution")?.state).toBe("failed");
      expect(flow.currentStage).toBe("distribution");
    });

    it("does NOT paint a COMPLETED run's bar failed for a stage that failed on an account since re-badged SKIPPED at approval", async () => {
      // BAN1 failed validation, was re-badged PROCESSING_FAILED -> SKIPPED at
      // approval; its FAILED validation stage row survives (approval only
      // changes account status). BAN2 completed and posted. The run reached
      // COMPLETED — the bar must read done end-to-end, not carry a red validation
      // step, because BAN1's failure was resolved OUT of the run at approval.
      mockListStatuses.mockResolvedValue([
        { billingAccountId: "BAN00000001", status: "SKIPPED", errorCode: null },
        {
          billingAccountId: "BAN00000002",
          status: "COMPLETED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([
        stageRow({
          refBillingAccountId: "BAN00000001",
          stage: "validation",
          status: "FAILED",
          errorClass: "HARD",
        }),
      ]);
      mockListRendered.mockResolvedValue(["BAN00000002"]);

      const { flow } = await getStageTimeline("BRN00000001", "COMPLETED");

      expect(step(flow.steps, "validation")?.state).toBe("done");
      expect(flow.steps.some((s) => s.state === "failed")).toBe(false);
      expect(flow.currentStage).not.toBe("validation");
    });

    it("surfaces a failed processing stage as the run's anchor", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "PROCESSING_FAILED",
          errorCode: "PROCESSING_STAGE_FAILED",
        },
      ]);
      mockListLatest.mockResolvedValue([
        stageRow({ stage: "validation", status: "FAILED", errorClass: "HARD" }),
      ]);

      const { flow } = await getStageTimeline("BRN00000001", "PROCESSING");

      expect(step(flow.steps, "validation")?.state).toBe("failed");
      expect(flow.currentStage).toBe("validation");
    });

    // Regression: a settled-out account (partial-period EXCLUDED, so scoped but
    // bypassed and carrying no stage signals) must not hold a stage at
    // `current`. Only IN-PLAY rows count toward a stage being `done` — the old
    // `cleared >= rows.length` test stranded validation at `current` here.
    it("marks a stage done once every in-play account cleared it, ignoring an EXCLUDED row with no signals", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "PROCESSING",
          errorCode: null,
        },
        {
          billingAccountId: "BAN00000002",
          status: "EXCLUDED",
          errorCode: "PARTIAL_PERIOD",
        },
      ]);
      mockListLatest.mockResolvedValue([
        stageRow({
          refBillingAccountId: "BAN00000001",
          stage: "validation",
          status: "DONE",
        }),
      ]);

      const { flow } = await getStageTimeline("BRN00000001", "PROCESSING");

      expect(step(flow.steps, "validation")?.state).toBe("done");
    });

    it("exposes at most one current step", async () => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "PROCESSING",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([
        stageRow({ stage: "validation", status: "DONE" }),
      ]);

      const { flow } = await getStageTimeline("BRN00000001", "PROCESSING");

      expect(flow.steps.filter((s) => s.state === "current")).toHaveLength(1);
    });
  });

  // The mid-flight counts describe the PROCESSING phase. Once posting moves
  // accounts off `PROCESSED` they all read zero, so a finished run rendered
  // "0 processed, 0 processing failed of 6" under a fully green flow bar.
  describe("mid-flight summary gate", () => {
    beforeEach(() => {
      mockListStatuses.mockResolvedValue([
        {
          billingAccountId: "BAN00000001",
          status: "INVOICED",
          errorCode: null,
        },
      ]);
      mockListLatest.mockResolvedValue([]);
    });

    it.each([
      "INVOICED",
      "DISTRIBUTING",
      "DISTRIBUTION_FAILED",
      "COMPLETED",
      "CANCELLED",
    ] as const)(
      "suppresses the counts once the run is %s",
      async (runStatus) => {
        const { summary } = await getStageTimeline("BRN00000001", runStatus);
        expect(summary.isMidFlight).toBe(false);
      },
    );

    // Approval only re-badges failed/excluded accounts, so the counts still
    // hold until posting actually runs.
    it.each([
      "PROCESSING",
      "PROCESSED",
      "APPROVED",
      "POSTING",
      "PROCESSING_FAILED",
    ] as const)("keeps the counts while the run is %s", async (runStatus) => {
      const { summary } = await getStageTimeline("BRN00000001", runStatus);
      expect(summary.isMidFlight).toBe(true);
    });

    it("keeps the counts when no run status is supplied", async () => {
      const { summary } = await getStageTimeline("BRN00000001");
      expect(summary.isMidFlight).toBe(true);
    });
  });

  it("returns an empty timeline for a run with no scoped accounts", async () => {
    mockListStatuses.mockResolvedValue([]);
    mockListLatest.mockResolvedValue([]);

    const { rows, summary, flow } = await getStageTimeline("BRN00000001");

    expect(rows).toEqual([]);
    expect(summary).toEqual({
      total: 0,
      processed: 0,
      processingFailed: 0,
      excluded: 0,
      isMidFlight: true,
    });
    expect(flow.steps).toHaveLength(STAGES.length);
  });
});
