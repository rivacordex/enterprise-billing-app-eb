import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { isUniqueViolation } from "@/lib/db-errors";
import { conflict, notFound } from "@/lib/errors";
import { aggregateBill } from "@/services/billing/aggregate-bill";
import { collectClaim } from "@/services/billing/collect-claim";
import { taxBill } from "@/services/billing/taxation";
import { firstOfMonth } from "@/services/billing/derive-periods";
import { validateAccount } from "@/services/billing/validate-account";
import { computeRunStatus } from "@/services/billing/compute-run-status";
import type {
  AccountStatus,
  ErrorClass,
  RunStatus,
  Stage,
  StageStatus,
} from "@/types/billing";

// bm04-spec §Design/§Implementation §8. The stage-complete ingest
// transaction: insert the stage row FIRST (the idempotency latch,
// architecture Inv. #5) → apply the stage's app-side effect → advance the
// account → recompute the run under the `bill_run` row lock already held by
// `findByIdForUpdate` (Inv. #12) → bump the heartbeat. No `AUDIT_LOG` write —
// the appended stage row is the audit surface (code-standards §1.10).

export interface StageSignalInput {
  runId: string;
  stage: Stage;
  banId: string;
  attempt: number;
  status: StageStatus;
  errorClass?: ErrorClass;
  errorCode?: string;
  errorDetail?: string;
}

export interface StageSignalResult {
  replayed: boolean;
  accountStatus: AccountStatus;
  runStatus: RunStatus;
}

const IDEMPOTENCY_CONSTRAINT =
  "bill_run_account_stage_run_ban_stage_attempt_period_unique";

// The last of the six stages this release implements (Stage union order,
// types/billing.ts) — reaching it DONE/SKIPPED is what flips the ACCOUNT to
// PROCESSED in v1 (posting/rendering/distribution are modelled but never
// reached this release, overview "Features/Stage tracking").
const TERMINAL_STAGE: Stage = "verification";

// Pure — exported for direct unit testing. `current` is the account's status
// BEFORE this signal; `stage`/`effective` describe the signal just recorded.
export function advanceAccountStatus(
  current: AccountStatus,
  stage: Stage,
  effective: { status: StageStatus; errorClass: ErrorClass | null },
): AccountStatus {
  // Already terminal (a HARD failure, or a scoping-time exclusion that is
  // never signalled) — nothing downstream can move it further in v1.
  if (current === "PROCESSING_FAILED" || current === "EXCLUDED") {
    return current;
  }

  if (effective.status === "FAILED" && effective.errorClass === "HARD") {
    return "PROCESSING_FAILED";
  }

  // PENDING → PROCESSING on the first stage signal for this account,
  // regardless of outcome (Design §4). An INFRA failure is retryable — no
  // further terminal change.
  const advanced: AccountStatus =
    current === "PENDING" ? "PROCESSING" : current;
  if (effective.status === "FAILED" && effective.errorClass === "INFRA") {
    return advanced;
  }

  // The terminal stage only COMPLETES an account that was already in progress
  // (a prior stage advanced it out of PENDING). A verification signal for a
  // still-PENDING account — e.g. the engine skips validation/aggregation and
  // signals only the terminal stage — must not mark it PROCESSED (that would
  // report a "done" account that was never validated and has no bill); it just
  // advances to PROCESSING.
  if (
    stage === TERMINAL_STAGE &&
    current !== "PENDING" &&
    (effective.status === "DONE" || effective.status === "SKIPPED")
  ) {
    return "PROCESSED";
  }

  return advanced;
}

export async function handleStageSignal(
  input: StageSignalInput,
): Promise<StageSignalResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, input.runId);
    if (!run) throw notFound("Bill run not found.");
    if (run.status !== "PROCESSING") {
      throw conflict("Bill run is not PROCESSING.");
    }

    const periodPartition = firstOfMonth(run.periodStart);

    // The Validation stage's outcome is computed by the app (§31); the
    // Collection/Claim stage is a v1 no-op that always records DONE (bm05-spec
    // §Design §2 — there is no `rating` table to claim from). Every other
    // stage records exactly what the caller signalled (record-and-advance
    // pass-through; Taxation/Verification's real effects land in bm06-07).
    const effective =
      input.stage === "validation"
        ? await validateAccount(tx, input.banId)
        : input.stage === "collection"
          ? collectClaim()
          : {
              status: input.status,
              errorClass: input.errorClass ?? null,
              errorCode: input.errorCode ?? null,
              errorDetail: input.errorDetail ?? null,
            };

    try {
      await billRunAccountStageRepository.insertStageRow(tx, {
        refBillRunId: input.runId,
        refBillingAccountId: input.banId,
        periodPartition,
        stage: input.stage,
        attempt: input.attempt,
        status: effective.status,
        // A completion signal carries no real start time — record only the
        // end. Fabricating startedAt = now implies a false zero duration.
        startedAt: null,
        endedAt: new Date(),
        errorClass: effective.errorClass,
        errorCode: effective.errorCode,
        errorDetail: effective.errorDetail,
      });
    } catch (err) {
      if (isUniqueViolation(err, IDEMPOTENCY_CONSTRAINT)) {
        const current = await billRunAccountRepository.findStatus(
          tx,
          input.runId,
          input.banId,
        );
        return {
          replayed: true,
          accountStatus: current?.status ?? "PENDING",
          runStatus: run.status as RunStatus,
        };
      }
      throw err;
    }

    const currentAccount = await billRunAccountRepository.findStatus(
      tx,
      input.runId,
      input.banId,
    );
    if (!currentAccount) {
      throw notFound(
        `Billing account ${input.banId} is not scoped into run ${input.runId}.`,
      );
    }

    // bm05-spec §Design/§Implementation §4 — Aggregation's write is a side
    // effect of a successful signal, not an override of the recorded stage
    // outcome (unlike Validation/Collection above): a DONE aggregation signal
    // writes the trial `customer_bill` inside this same transaction. Guarded on
    // the account being in progress (`PROCESSING`) — an `EXCLUDED` (scoped-out),
    // still-`PENDING` (never validated), or already-terminal account never gets
    // a bill, even though the M2M caller controls the stage/status body (the
    // engine's stage ordering is not trusted here). A duplicate signal never
    // reaches here — it is caught as a replay above, before any write.
    if (
      input.stage === "aggregation" &&
      effective.status === "DONE" &&
      currentAccount.status === "PROCESSING"
    ) {
      await aggregateBill(tx, run, input.banId);
    }

    // bm06-spec §Design/§Implementation §3 — Taxation is the same side-effect
    // shape as Aggregation (not an outcome override): a DONE taxation signal
    // taxes the account's trial bill inside this same transaction, guarded on
    // the account being in progress. If the bill has not been aggregated yet
    // (an out-of-order signal), `taxBill` throws a conflict so this whole
    // transaction rolls back — the taxation stage row is never committed, and
    // the engine retries after Aggregation rather than the account being left
    // permanently "taxed" with a zero tax.
    if (
      input.stage === "taxation" &&
      effective.status === "DONE" &&
      currentAccount.status === "PROCESSING"
    ) {
      await taxBill(tx, run, input.banId);
    }

    const newAccountStatus = advanceAccountStatus(
      currentAccount.status,
      input.stage,
      effective,
    );
    // Stamp the account-level diagnostics from this signal UNLESS the account
    // was already terminal before it (`PROCESSING_FAILED`/`EXCLUDED`): a stray
    // later signal must not overwrite or wipe the diagnostics that explain why
    // it failed. A non-terminal account records the signal's error (INFRA/SOFT
    // transients included, so a stuck-in-PROCESSING account is not blank) and
    // clears them to null on a clean advance.
    const wasTerminal =
      currentAccount.status === "PROCESSING_FAILED" ||
      currentAccount.status === "EXCLUDED";
    await billRunAccountRepository.updateStatus(tx, input.runId, input.banId, {
      status: newAccountStatus,
      ...(wasTerminal
        ? {}
        : {
            errorCode: effective.errorCode,
            errorDetail: effective.errorDetail,
          }),
    });

    const statuses = await billRunAccountRepository.listStatusesForRun(
      tx,
      input.runId,
    );
    const accountStatuses = statuses.map((s) => s.status);
    const computed = computeRunStatus(accountStatuses);

    await billRunRepository.recomputeStatus(tx, input.runId, {
      newStatus: computed,
      banCount: accountStatuses.length,
      ratedCount: accountStatuses.filter((s) => s === "PROCESSED").length,
      failedCount: accountStatuses.filter((s) => s === "PROCESSING_FAILED")
        .length,
    });

    return {
      replayed: false,
      accountStatus: newAccountStatus,
      runStatus: computed ?? (run.status as RunStatus),
    };
  });
}
