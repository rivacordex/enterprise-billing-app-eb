import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
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

// Accounts whose failure is RESOLVED — deliberately taken out of the run's
// billed outcome: `EXCLUDED` at scoping (Inv #26), or a `PROCESSING_FAILED`/
// `EXCLUDED` account re-badged `SKIPPED` at approval. Their historical FAILED
// stage cells stay on the per-account grid (that is the account's truth), but
// must NOT read as a live failure on the run-level flow bar — a COMPLETED run
// whose only failure was skipped at approval is not a failed run.
// `PROCESSING_FAILED` is deliberately ABSENT: that failure is still live
// (pre-approval) and must surface on the bar until approval skips it.
const RESOLVED_OUT: ReadonlySet<AccountStatus> = new Set([
  "EXCLUDED",
  "SKIPPED",
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
  const [accounts, stageRows, renderedAccountIds, distributionAbandoned] =
    await Promise.all([
      billRunAccountRepository.listStatusesForRun(db, billRunId),
      billRunAccountStageRepository.listLatestForRun(db, billRunId),
      billRunInvoicesRepository.listBillingAccountIdsForRun(db, billRunId),
      // Only a COMPLETED run can have reached distribution via T11's
      // force-complete/abandon path — that is the one run status where the flow
      // bar's Distribution step would otherwise read a falsely-clean `done`.
      runStatus === "COMPLETED"
        ? billRunDistributionRepository.hasAbandonedArtifactsForRun(
            db,
            billRunId,
          )
        : Promise.resolve(false),
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
  const flow = deriveFlowProgress(
    rows,
    runStatus ?? null,
    distributionAbandoned,
  );

  return { rows, summary, flow };
}

// The three app-side stages. Returns `null` (neutral PENDING) for a signalled
// stage or a state we cannot honestly call yet.
function deriveAppSideStage(
  stage: TimelineStage,
  account: {
    billingAccountId: string;
    status: AccountStatus;
    errorCode: string | null;
  },
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
      // Parked by a posting failure: the account stays `PROCESSED` and records
      // the reason ONLY in `error_code` — `handle-stage-signal` clears it on a
      // clean terminal signal, so a successfully-`PROCESSED` account never
      // carries one. ANY code here (POSTING_FAILED, PERIOD_CLOSED, a GL/period
      // reject, …) therefore means parked, so mirror `get-posting-progress.ts`'s
      // failed/PERIOD_CLOSED derivation rather than matching a single literal —
      // else a genuinely-stuck account (e.g. PERIOD_CLOSED) reads as a
      // misleading PENDING, the exact defect these derived stages exist to fix.
      if (account.status === "PROCESSED" && account.errorCode !== null) {
        return "FAILED";
      }
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
  runStatus: RunStatus | null,
  distributionAbandoned: boolean,
): RunFlowProgress {
  // Only accounts still in play have to clear a step; an EXCLUDED/SKIPPED or
  // already-failed account must never hold the whole run at `current`. This is
  // filtered off each ROW by its own account status, because a settled-out
  // account can carry cells that never became DONE/SKIPPED — e.g. a
  // partial-period `EXCLUDED` row is scoped but bypassed, so its stage cells stay
  // `null`. Counting it against `rows.length` would strand a stage at `current`
  // even after every in-play account cleared it.
  const inPlayRows = rows.filter((r) => !SETTLED_OUT.has(r.accountStatus));

  const states = new Map<Stage, FlowStepState>();

  for (const stage of TIMELINE_STAGES) {
    // `anyFailed` and `started` still look across ALL rows — a failure or a
    // signal on any account is real whether or not it settled out.
    const cells = rows.map((r) => r.cells.find((c) => c.stage === stage));
    // A stage reads `failed` on the bar only for a LIVE failure — one on an
    // account still owned by the run. A failure on a RESOLVED_OUT account
    // (EXCLUDED, or re-badged SKIPPED at approval) is history the grid still
    // shows but must not paint a COMPLETED run's bar red (the floor below never
    // downgrades a `failed`, so this is the only place to draw the line).
    const anyFailed = rows.some(
      (r) =>
        !RESOLVED_OUT.has(r.accountStatus) &&
        r.cells.find((c) => c.stage === stage)?.status === "FAILED",
    );
    const cleared = inPlayRows.filter((r) => {
      const status = r.cells.find((c) => c.stage === stage)?.status;
      return status === "DONE" || status === "SKIPPED";
    }).length;
    const started = cells.some((c) => c?.status != null);

    if (anyFailed) states.set(stage, "failed");
    else if (inPlayRows.length > 0 && cleared >= inPlayRows.length)
      states.set(stage, "done");
    else if (inPlayRows.length === 0 && rows.length > 0)
      states.set(stage, "skipped");
    else states.set(stage, started ? "current" : "pending");
  }

  states.set(
    "distribution",
    deriveDistributionState(runStatus, distributionAbandoned),
  );

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

function deriveDistributionState(
  runStatus: RunStatus | null,
  distributionAbandoned: boolean,
): FlowStepState {
  switch (runStatus) {
    case "COMPLETED":
      // A COMPLETED run is normally fully delivered, but T11's force-complete
      // path leaves FAILED artifacts abandoned. Reflect that as `failed` so the
      // bar never shows a clean `done` over an undelivered artifact — matching
      // the Distribution tab's own abandoned-artifact detection. (The floor
      // below never downgrades a `failed`, so this survives.)
      return distributionAbandoned ? "failed" : "done";
    case "DISTRIBUTING":
      return "current";
    case "DISTRIBUTION_FAILED":
      return "failed";
    default:
      return "pending";
  }
}
