import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { isUniqueViolation } from "@/lib/db-errors";
import { conflict, notFound } from "@/lib/errors";
import { firstOfMonth } from "@/services/billing/derive-periods";
import {
  computeRunCounters,
  computeRunStatus,
} from "@/services/billing/compute-run-status";
import type {
  AccountStatus,
  ErrorClass,
  RunStatus,
  Stage,
  StageStatus,
} from "@/types/billing";

// bm04-spec §Design/§Implementation §8, revised bm16-spec §Design "The M2M
// handler becomes record-only (D5)" / §Implementation §4. Phase 2: the bill
// run processor computes every stage's outcome AND writes the bill-data
// itself (as `billrun_runtime`, write-then-signal — D6); this handler
// RECORDS what it reports and computes nothing — Phase 1's Validation
// override (`validate-account.ts`) and the Aggregation/Taxation write side
// effects (`aggregate-bill.ts`/`taxation.ts`) are retired (Fork B). The
// stage-complete ingest transaction: insert the stage row FIRST (the
// idempotency latch, architecture Inv. #5) → advance the account → recompute
// `bill_run.status` under the row lock already held by `findByIdForUpdate`
// (Inv. #12). No `AUDIT_LOG` write — the appended stage row is the audit
// surface (code-standards §1.10).

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

// bm04-spec §Design/§1 resolved ambiguity — unchanged by bm16 (spec
// §Implementation §4: "verification remains the terminal processing stage
// until distribution stages land in bm20"). The last of the six stages this
// release implements — reaching it DONE/SKIPPED is what flips the ACCOUNT to
// PROCESSED.
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
  // still-PENDING account — e.g. the processor skips validation/aggregation
  // and signals only the terminal stage — must not mark it PROCESSED (that
  // would report a "done" account that was never validated and has no bill);
  // it just advances to PROCESSING.
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

    // Read the account's current status AND attempt under the run row lock,
    // BEFORE any stage-row write (T14, bm16-spec review folds — the
    // signal's attempt must equal the account's CURRENT attempt). The
    // `bill_run_account_stage` idempotency latch is keyed by `attempt`, so it
    // only catches a duplicate of the SAME attempt — a signal from a
    // superseded execution (a killed run's late push after a cancel +
    // re-trigger, a pre-rerun attempt, or a Kestra replay that stamps a stale
    // attempt) carries an OLD `attempt` that would otherwise land on a fresh
    // stage row and wrongly re-advance the current attempt's account. A
    // signal whose attempt no longer matches the account is rejected here as
    // an accepted no-op (200) before it can touch anything.
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
    if (currentAccount.attemptCount !== input.attempt) {
      return {
        replayed: true,
        accountStatus: currentAccount.status,
        runStatus: run.status as RunStatus,
      };
    }

    const periodPartition = firstOfMonth(run.periodStart);

    // bm16-spec §Design "record-only (D5)" — every stage is recorded exactly
    // as the processor signalled it. The app neither computes nor overrides
    // an outcome and never triggers a write side effect: the processor
    // already wrote the stage's bill-data itself, as `billrun_runtime`,
    // before signalling (write-then-signal, D6). The signal carries no
    // charge payload (validated by `stageSignalBodySchema`'s `strictObject`,
    // Inv. #16).
    const effective = {
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
        // A duplicate of the current attempt — the account was read above under
        // the same lock; nothing has moved it since, so reuse that snapshot.
        return {
          replayed: true,
          accountStatus: currentAccount.status,
          runStatus: run.status as RunStatus,
        };
      }
      throw err;
    }

    const newAccountStatus = advanceAccountStatus(
      currentAccount.status,
      input.stage,
      effective,
    );
    // Stamp the account-level diagnostics from this signal UNLESS the account
    // was already terminal before it (`PROCESSING_FAILED`/`EXCLUDED`): a stray
    // later signal must not overwrite or wipe the diagnostics that explain why
    // it failed. For a non-terminal account, the account error mirrors a genuine
    // FAILURE outcome only (a HARD terminal or an INFRA transient, so a
    // stuck-in-PROCESSING account is not blank); a DONE/SKIPPED outcome clears
    // the account error — including a `verification` SOFT *finding*, which lives
    // on the stage row (bm07-spec §1), not on the account, so a successfully
    // PROCESSED account never carries a stale, contradictory error code.
    const wasTerminal =
      currentAccount.status === "PROCESSING_FAILED" ||
      currentAccount.status === "EXCLUDED";
    const isFailure = effective.status === "FAILED";
    await billRunAccountRepository.updateStatus(tx, input.runId, input.banId, {
      status: newAccountStatus,
      ...(wasTerminal
        ? {}
        : {
            errorCode: isFailure ? effective.errorCode : null,
            errorDetail: isFailure ? effective.errorDetail : null,
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
      ...computeRunCounters(accountStatuses),
    });

    return {
      replayed: false,
      accountStatus: newAccountStatus,
      runStatus: computed ?? (run.status as RunStatus),
    };
  });
}
