import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { isUniqueViolation } from "@/lib/db-errors";
import { conflict, notFound } from "@/lib/errors";
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

  if (
    stage === TERMINAL_STAGE &&
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

    // The Validation stage's outcome is computed by the app (§31); every
    // other stage records exactly what the caller signalled (record-and-
    // advance pass-through, real effects land in bm05-07).
    const effective =
      input.stage === "validation"
        ? await validateAccount(tx, input.banId)
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
        startedAt: new Date(),
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

    const newAccountStatus = advanceAccountStatus(
      currentAccount.status,
      input.stage,
      effective,
    );
    await billRunAccountRepository.updateStatus(tx, input.runId, input.banId, {
      status: newAccountStatus,
      errorCode: effective.errorCode,
      errorDetail: effective.errorDetail,
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
