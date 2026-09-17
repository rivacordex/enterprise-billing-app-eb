import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import {
  STAGES,
  TIMELINE_STAGES,
  type AccountStatus,
  type ErrorClass,
  type FlowStepState,
  type RunFlowProgress,
  type RunStatus,
  type Stage,
  type StageStatus,
  type StageTimelineRow,
  type StageTimelineSummary,
  type TimelineStage,
} from "@/types/billing";

// bm04-spec §Visual/§Implementation §9. The Workflow tab's read: the
// `StageTimeline` grid (one row per scoped account, one cell per
// `TimelineStage`) and the mid-flight summary — both derived from
// `bill_run_account` / `bill_run_account_stage` on every read, never the
// optional run-level cache (architecture Inv. #12). A cell with no signal yet
// renders `status: null` (the neutral PENDING badge), not a synthesized row.
//
// DERIVED APP-SIDE STAGES (2026-09-18). Only five stages are ever SIGNALLED:
// the processor's `validation`…`verification` M2M callbacks write
// `bill_run_account_stage` rows. `scoping`, `posting` and `rendering` are app-
// side steps that write no stage row, so every one of their cells rendered a
// permanent PENDING badge — a COMPLETED run still showed "posting: pending",
// which read as a broken pipeline. They are now DERIVED here from their real
// sources of truth rather than being given fabricated stage rows:
//
//   scoping   — the `bill_run_account` row itself. `scopeAccounts` only ever
//               snapshots ACTIVE accounts for the cycle, so a row existing IS
//               "scoped in and active"; `EXCLUDED` (partial period, Inv #26) is
//               the deliberate bypass and shows SKIPPED.
//   posting   — the account reaching `INVOICED` (its INV is in the ledger).
//               `SKIPPED` shows SKIPPED; a parked posting failure
//               (`PROCESSED` + `POSTING_FAILED`) shows FAILED.
//   rendering — a `bill_run_invoices` row for the account, i.e. the invoice PDF
//               was rendered, checksummed and stored. An `INVOICED` account with
//               no such row is genuinely still render-pending, so PENDING there
//               is true rather than misleading.
//
// A real stage row always WINS over the derivation, so if any of these three is
// ever wired to a genuine signal the grid picks it up with no change here.
// `distribution` is not a grid column at all — see `TIMELINE_STAGES`.

export interface StageTimelineResult {
  rows: StageTimelineRow[];
  summary: StageTimelineSummary;
  flow: RunFlowProgress;
}

// Account statuses that mean "this account is no longer expected to progress" —
// used so a step is not held `current` forever by an account that will never
// reach it.
const SETTLED_OUT: ReadonlySet<AccountStatus> = new Set([
  "EXCLUDED",
  "SKIPPED",
  "PROCESSING_FAILED",
]);

const POSTED_STATUSES: ReadonlySet<AccountStatus> = new Set([
  "INVOICED",
  "DISTRIBUTING",
  "COMPLETED",
]);

// Run statuses past the processing phase, where the mid-flight counts no longer
// mean anything (every account has left `PROCESSED`). Note this is WIDER than
// "terminal": `INVOICED` and `DISTRIBUTING` are live states, but posting has
// already emptied the counts, so the line is just as misleading there.
// `APPROVED`/`POSTING` are deliberately NOT here — approval only re-badges
// failed/excluded accounts, so the counts still hold until posting runs.
const PAST_PROCESSING: ReadonlySet<RunStatus> = new Set([
  "INVOICED",
  "DISTRIBUTING",
  "DISTRIBUTION_FAILED",
  "COMPLETED",
  "CANCELLED",
]);

export async function getStageTimeline(
  billRunId: string,
  runStatus?: RunStatus,
): Promise<StageTimelineResult> {
  const [accounts, stageRows, renderedAccountIds] = await Promise.all([
    billRunAccountRepository.listStatusesForRun(db, billRunId),
    billRunAccountStageRepository.listLatestForRun(db, billRunId),
    billRunInvoicesRepository.listBillingAccountIdsForRun(db, billRunId),
  ]);

  const rendered = new Set(renderedAccountIds);

  const cellsByAccount = new Map<
    string,
    Map<Stage, { status: StageStatus; errorClass: ErrorClass | null }>
  >();
  for (const stageRow of stageRows) {
    let byStage = cellsByAccount.get(stageRow.refBillingAccountId);
    if (!byStage) {
      byStage = new Map();
      cellsByAccount.set(stageRow.refBillingAccountId, byStage);
    }
    byStage.set(stageRow.stage as Stage, {
      status: stageRow.status as StageStatus,
      errorClass: stageRow.errorClass as ErrorClass | null,
    });
  }

  const rows: StageTimelineRow[] = accounts.map((account) => {
    const byStage = cellsByAccount.get(account.billingAccountId);
    return {
      billingAccountId: account.billingAccountId,
      accountStatus: account.status,
      cells: TIMELINE_STAGES.map((stage) => {
        // A genuine signal always wins over the derivation below.
        const cell = byStage?.get(stage);
        if (cell) {
          return {
            stage,
            status: cell.status,
            errorClass: cell.errorClass,
          };
        }
        return {
          stage,
          status: deriveAppSideStage(stage, account, rendered),
          errorClass: null,
        };
      }),
    };
  });

  const summary = deriveSummary(
    accounts.map((a) => a.status),
    runStatus ?? null,
  );
  const flow = deriveFlowProgress(rows, accounts, runStatus ?? null);

  return { rows, summary, flow };
}

// The three app-side stages. Returns `null` (neutral PENDING) for a signalled
// stage or a state we cannot honestly call yet.
function deriveAppSideStage(
  stage: TimelineStage,
  account: { billingAccountId: string; status: AccountStatus; errorCode: string | null },
  rendered: ReadonlySet<string>,
): StageStatus | null {
  switch (stage) {
    case "scoping":
      // The row exists, so the account WAS scoped in off the active set
      // (`scopeAccounts` only ever snapshots ACTIVE accounts for the cycle).
      // An account excluded AT scoping is the one exception — and its status is
      // not a reliable marker, because `approveRun` re-badges `EXCLUDED` to
      // `SKIPPED`. `PARTIAL_PERIOD` (Inv #26) survives that re-badge on
      // `error_code`, so it is what actually identifies a scoping-time
      // exclusion after approval.
      return account.status === "EXCLUDED" ||
        account.errorCode === "PARTIAL_PERIOD"
        ? "SKIPPED"
        : "DONE";
    case "posting":
      if (account.status === "SKIPPED" || account.status === "EXCLUDED") {
        return "SKIPPED";
      }
      if (POSTED_STATUSES.has(account.status)) return "DONE";
      // Parked by a posting failure: the account stays PROCESSED and carries
      // the error code, so the cell must not read as merely "not started".
      if (account.errorCode === "POSTING_FAILED") return "FAILED";
      return null;
    case "rendering":
      if (account.status === "SKIPPED" || account.status === "EXCLUDED") {
        return "SKIPPED";
      }
      return rendered.has(account.billingAccountId) ? "DONE" : null;
    default:
      return null;
  }
}

function deriveSummary(
  statuses: readonly AccountStatus[],
  runStatus: RunStatus | null,
): StageTimelineSummary {
  return {
    total: statuses.length,
    processed: statuses.filter((s) => s === "PROCESSED").length,
    processingFailed: statuses.filter((s) => s === "PROCESSING_FAILED").length,
    excluded: statuses.filter((s) => s === "EXCLUDED").length,
    // Unknown run status (the non-workflow tabs pass none) keeps the old
    // behaviour rather than silently hiding the line.
    isMidFlight: runStatus === null || !PAST_PROCESSING.has(runStatus),
  };
}

// The run-level flow bar. The eight grid stages are rolled up from the cells
// just built — a step is `done` once every account still in play cleared it —
// and `distribution` comes from the RUN status alone, because it is tracked per
// (target, artifact) in `bill_run_distribution`, never per account.
function deriveFlowProgress(
  rows: readonly StageTimelineRow[],
  accounts: readonly { status: AccountStatus }[],
  runStatus: RunStatus | null,
): RunFlowProgress {
  const inPlay = accounts.filter((a) => !SETTLED_OUT.has(a.status)).length;

  const states = new Map<Stage, FlowStepState>();

  for (const stage of TIMELINE_STAGES) {
    const cells = rows.map((r) => r.cells.find((c) => c.stage === stage));
    const anyFailed = cells.some((c) => c?.status === "FAILED");
    // Only accounts still in play have to clear a step; an EXCLUDED/SKIPPED or
    // already-failed account must never hold the whole run at `current`.
    const cleared = rows.filter((r, i) => {
      const status = cells[i]?.status;
      return status === "DONE" || status === "SKIPPED";
    }).length;
    const started = cells.some((c) => c?.status != null);

    if (anyFailed) states.set(stage, "failed");
    else if (rows.length > 0 && cleared >= rows.length) states.set(stage, "done");
    else if (inPlay === 0 && rows.length > 0) states.set(stage, "skipped");
    else states.set(stage, started ? "current" : "pending");
  }

  states.set("distribution", deriveDistributionState(runStatus));

  // The RUN's own status is a FLOOR on the bar. A run that has reached
  // `INVOICED` necessarily cleared every processing stage and posting, whatever
  // the per-account cells happen to show — a rerun can leave an older attempt's
  // rows behind, and the three derived stages cannot see a stage a signal never
  // wrote. Without this floor a COMPLETED run could still render "validation:
  // current", which is exactly the contradiction this bar exists to remove.
  // Never downgrades a `failed`: a real failure is what the operator must see.
  const floor = impliedCompleteThrough(runStatus);
  if (floor !== null) {
    for (const stage of STAGES.slice(0, floor + 1)) {
      if (states.get(stage) !== "failed") states.set(stage, "done");
    }
  }

  // `current` is the first step that is not finished. A failed step is where the
  // run actually stands, so it takes precedence as the anchor.
  const ordered = STAGES.map((stage) => ({
    stage,
    state: states.get(stage) ?? "pending",
  }));
  const failedAt = ordered.find((s) => s.state === "failed");
  const firstUnfinished = ordered.find(
    (s) => s.state === "current" || s.state === "pending",
  );
  const currentStage = failedAt?.stage ?? firstUnfinished?.stage ?? null;

  // Normalize: exactly one step reads as `current` (the anchor), and only when
  // it is not already failed.
  const steps = ordered.map((s) =>
    s.state === "current" && s.stage !== currentStage
      ? { ...s, state: "pending" as FlowStepState }
      : s,
  );
  if (currentStage && !failedAt) {
    const anchor = steps.find((s) => s.stage === currentStage);
    if (anchor && anchor.state === "pending") anchor.state = "current";
  }

  return { steps, currentStage };
}

// The last flow step the run's own status proves is complete, as an index into
// `STAGES`. `null` when the status implies nothing (not yet triggered, still
// processing, or cancelled).
function impliedCompleteThrough(runStatus: RunStatus | null): number | null {
  switch (runStatus) {
    // Processing finished for every account that got that far.
    case "PROCESSED":
    case "APPROVED":
    case "POSTING":
      return STAGES.indexOf("verification");
    // The ledger has the INVs.
    case "INVOICED":
      return STAGES.indexOf("posting");
    // Distribution only starts once every artifact was rendered and stored.
    case "DISTRIBUTING":
    case "DISTRIBUTION_FAILED":
      return STAGES.indexOf("rendering");
    case "COMPLETED":
      return STAGES.indexOf("distribution");
    default:
      return null;
  }
}

function deriveDistributionState(runStatus: RunStatus | null): FlowStepState {
  switch (runStatus) {
    case "COMPLETED":
      return "done";
    case "DISTRIBUTING":
      return "current";
    case "DISTRIBUTION_FAILED":
      return "failed";
    default:
      return "pending";
  }
}
