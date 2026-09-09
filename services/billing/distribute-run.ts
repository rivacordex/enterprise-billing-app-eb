import type { Database } from "@/db/client";
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { BillRun } from "@/db/schema/billing/bill-run";
import { buildCsv } from "@/lib/csv";
import { isUniqueViolation } from "@/lib/db-errors";
import { conflict, notFound } from "@/lib/errors";
import { billRunDistributionForceFail } from "@/lib/config";
import {
  DISTRIBUTION_FLOW_ID,
  type DistributionArtifactInput,
  type DistributionTargetInput,
} from "@/services/billing/engine-client";
import { engineRegistry } from "@/services/billing/engine-registry";
import { firstOfMonth } from "@/services/billing/derive-periods";
import { blobStore } from "@/services/billing/blob-store";
import type { DistributionArtifactType, DistributionOutcome } from "@/types/billing";

// bm20-spec §Design/§Implementation §3/§4. The bill-run distributor's app
// side — transport-only (D-push): this file hands the flow references to
// already-stored artifacts (bm19) and records the outcomes it signals back;
// it never renders or computes a charge. Mirrors `trigger-run.ts`/
// `rerun-run.ts`'s "engine call inside the transaction, throw on failure to
// roll the whole thing back" shape (bm03/bm08 precedent).

const LOOPBACK_TARGET = "loopback";
// The one transient report_csv artifact's ref — a fixed constant, not a
// stored id (D21: the report gets no `bill_run_output` row), so its
// idempotency key stays stable across a rerun's fresh blob write.
export const REPORT_ARTIFACT_REF = "REPORT";

const IDEMPOTENCY_CONSTRAINT =
  "bill_run_distribution_run_target_artifact_attempt_period_unique";

// Internal-only signal — thrown inside `db.transaction` so an engine failure
// rolls the whole trigger/rerun back (bm03/bm08 pattern), while the outer
// call still returns a typed result instead of rejecting.
class EngineUnreachableSignal extends Error {}

function buildInvoiceRegisterCsv(
  billRunId: string,
  bills: {
    billingAccountId: string;
    accountName: string;
    currency: string;
    subtotal: string;
    taxTotal: string;
    totalAmount: string;
    refInvDocumentId: string | null;
  }[],
): Buffer {
  const header = [
    "bill_run_id",
    "billing_account_id",
    "account_name",
    "invoice_number",
    "currency",
    "subtotal",
    "tax_total",
    "total_amount",
  ];
  const rows = bills.map((b) => [
    billRunId,
    b.billingAccountId,
    b.accountName,
    b.refInvDocumentId ?? "",
    b.currency,
    b.subtotal,
    b.taxTotal,
    b.totalAmount,
  ]);
  return Buffer.from(buildCsv(header, rows), "utf-8");
}

// The expected mandatory-artifact count for the CURRENT run: every stored
// final invoice (bill_run_invoices) plus the one always-triggered report_csv
// artifact. Re-derived from what was actually triggered, never assumed —
// `recomputeDistributionStatus` compares the recorded DELIVERED count against
// this so "all mandatory delivered" can never be satisfied vacuously by a
// partial or empty outcome set (mirrors `computeRunStatus`'s "derived, not
// guessed" discipline, architecture Inv. #12).
async function computeExpectedMandatoryArtifactCount(
  tx: Database,
  billRunId: string,
): Promise<number> {
  const invoiceCount = await billRunInvoicesRepository.countForRun(tx, billRunId);
  return invoiceCount + 1;
}

export type TriggerDistributionResult =
  | {
      ok: true;
      value: { billRunId: string; executionId: string; artifactCount: number };
    }
  | { ok: false; code: "NOT_INVOICED" }
  | { ok: false; code: "ALREADY_STARTED" }
  | { ok: false; code: "ENGINE_UNREACHABLE" };

// bm20-spec §Design D8/D9, §Implementation §3. Called automatically once,
// right after `postRun` reaches `INVOICED` (`services/billing/post-run.ts`)
// — `actorUserId: null` there (a system write, mirrors bm02 materialization).
// bm20-spec §Phase-2 review fold T2's "Start distribution" operator action
// reuses this SAME function (idempotent re-derivation), passing the real
// actor id, to recover a run whose automatic trigger was lost or failed.
export async function triggerDistribution(
  billRunId: string,
  actorUserId: string | null = null,
): Promise<TriggerDistributionResult> {
  try {
    return await db.transaction(async (tx) => {
      const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
      if (!run || run.status !== "INVOICED") {
        return { ok: false, code: "NOT_INVOICED" } as const;
      }
      if (run.distributionExecutionId) {
        return { ok: false, code: "ALREADY_STARTED" } as const;
      }

      const period = firstOfMonth(run.periodStart);
      const [invoices, bills] = await Promise.all([
        billRunInvoicesRepository.listForRun(tx, billRunId),
        customerBillRepository.listForRun(tx, billRunId),
      ]);
      const csv = buildInvoiceRegisterCsv(billRunId, bills);
      const { blobRef: reportBlobRef } = await blobStore.putReport(
        period,
        billRunId,
        csv,
      );

      const artifacts: DistributionArtifactInput[] = [
        ...invoices.map((inv) => ({
          ref: inv.billRunInvoiceId,
          type: "invoice_pdf" as const,
          blob_ref: inv.blobRef,
        })),
        {
          ref: REPORT_ARTIFACT_REF,
          type: "report_csv" as const,
          blob_ref: reportBlobRef,
        },
      ];
      const targets: DistributionTargetInput[] = [
        {
          name: LOOPBACK_TARGET,
          is_mandatory: true,
          force_fail: billRunDistributionForceFail,
        },
      ];

      let executionRef;
      try {
        executionRef = await engineRegistry.trigger(
          "billrun",
          DISTRIBUTION_FLOW_ID,
          { bill_run_id: billRunId, artifacts, targets, attempt: 1 },
        );
      } catch (err) {
        throw new EngineUnreachableSignal(
          err instanceof Error ? err.message : "Engine unreachable",
        );
      }

      await billRunRepository.markDistributing(tx, billRunId, {
        distributionExecutionId: executionRef.executionId,
        distributionFlowId: executionRef.definitionId,
        distributionFlowRevision: executionRef.definitionRevision,
        distributionEngineRef: executionRef.engineRef,
      });

      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_DISTRIBUTION_STARTED",
        actorUserId,
        targetEntity: "BILL_RUN",
        targetId: billRunId,
        beforeData: null,
        afterData: {
          artifactCount: artifacts.length,
          executionId: executionRef.executionId,
        },
      });

      return {
        ok: true,
        value: {
          billRunId,
          executionId: executionRef.executionId,
          artifactCount: artifacts.length,
        },
      } as const;
    });
  } catch (err) {
    if (err instanceof EngineUnreachableSignal) {
      return { ok: false, code: "ENGINE_UNREACHABLE" };
    }
    throw err;
  }
}

export type RerunDistributionResult =
  | {
      ok: true;
      value: {
        billRunId: string;
        attempt: number;
        artifactCount: number;
        executionId: string;
      };
    }
  | { ok: false; code: "NOT_RERUNNABLE" }
  | { ok: false; code: "NO_FAILED_ARTIFACTS" }
  | { ok: false; code: "ENGINE_UNREACHABLE" };

// bm20-spec §Implementation §3 "Rerun distribution" — re-triggers the
// distribution flow scoped to ONLY the failed artifacts of the current
// round, under a NEW `distribution_attempt` (T1) so the redelivery's outcome
// is a fresh row, never a dropped replay of the prior FAILED one.
export async function rerunDistribution(
  billRunId: string,
  actorId: string,
): Promise<RerunDistributionResult> {
  try {
    return await db.transaction(async (tx) => {
      const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
      if (!run || run.status !== "DISTRIBUTION_FAILED") {
        return { ok: false, code: "NOT_RERUNNABLE" } as const;
      }
      const priorAttempt = run.distributionAttempt ?? 1;
      const failed = await billRunDistributionRepository.listFailedForAttempt(
        tx,
        billRunId,
        priorAttempt,
      );
      if (failed.length === 0) {
        return { ok: false, code: "NO_FAILED_ARTIFACTS" } as const;
      }
      const newAttempt = priorAttempt + 1;

      // Resolve blob refs: an invoice PDF is looked up from the immutable
      // `bill_run_invoices` store (bm19); the transient report CSV (D21) is
      // regenerated fresh rather than re-read (there is no stored row for it).
      const needsInvoices = failed.some((f) => f.artifactType === "invoice_pdf");
      const needsReport = failed.some((f) => f.artifactType === "report_csv");
      const invoices = needsInvoices
        ? await billRunInvoicesRepository.listForRun(tx, billRunId)
        : [];
      const invoiceBlobByRef = new Map(
        invoices.map((i) => [i.billRunInvoiceId, i.blobRef]),
      );

      let reportBlobRef: string | null = null;
      if (needsReport) {
        const period = firstOfMonth(run.periodStart);
        const bills = await customerBillRepository.listForRun(tx, billRunId);
        const csv = buildInvoiceRegisterCsv(billRunId, bills);
        reportBlobRef = (await blobStore.putReport(period, billRunId, csv))
          .blobRef;
      }

      const artifacts: DistributionArtifactInput[] = [];
      for (const f of failed) {
        const blobRef =
          f.artifactType === "report_csv"
            ? reportBlobRef
            : (invoiceBlobByRef.get(f.artifactRef) ?? null);
        // Defensive only — an invoice/report that vanished between the failed
        // read above and here should not happen (both are immutable/
        // regenerated), but never hand the engine a null blob_ref.
        if (!blobRef) continue;
        artifacts.push({ ref: f.artifactRef, type: f.artifactType, blob_ref: blobRef });
      }

      const targetIsMandatory = new Map(
        failed.map((f) => [f.target, f.isMandatory]),
      );
      const targets: DistributionTargetInput[] = [...targetIsMandatory].map(
        ([name, isMandatory]) => ({
          name,
          is_mandatory: isMandatory,
          force_fail: billRunDistributionForceFail,
        }),
      );

      let executionRef;
      try {
        executionRef = await engineRegistry.trigger(
          "billrun",
          DISTRIBUTION_FLOW_ID,
          { bill_run_id: billRunId, artifacts, targets, attempt: newAttempt },
        );
      } catch (err) {
        throw new EngineUnreachableSignal(
          err instanceof Error ? err.message : "Engine unreachable",
        );
      }

      await billRunRepository.markRerunDistributing(tx, billRunId, {
        distributionAttempt: newAttempt,
        distributionExecutionId: executionRef.executionId,
        distributionFlowId: executionRef.definitionId,
        distributionFlowRevision: executionRef.definitionRevision,
        distributionEngineRef: executionRef.engineRef,
      });

      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_DISTRIBUTION_RERUN",
        actorUserId: actorId,
        targetEntity: "BILL_RUN",
        targetId: billRunId,
        beforeData: { failedArtifacts: failed.map((f) => f.artifactRef) },
        afterData: { attempt: newAttempt, executionId: executionRef.executionId },
      });

      return {
        ok: true,
        value: {
          billRunId,
          attempt: newAttempt,
          artifactCount: artifacts.length,
          executionId: executionRef.executionId,
        },
      } as const;
    });
  } catch (err) {
    if (err instanceof EngineUnreachableSignal) {
      return { ok: false, code: "ENGINE_UNREACHABLE" };
    }
    throw err;
  }
}

export interface RecordDistributionOutcomeInput {
  runId: string;
  target: string;
  artifactRef: string;
  artifactType: DistributionArtifactType;
  isMandatory: boolean;
  outcome: DistributionOutcome;
  attempt: number;
}

export interface RecordDistributionOutcomeResult {
  replayed: boolean;
}

// bm20-spec §Implementation §4. The third M2M handler's service: insert one
// outcome row, idempotent on `(run, target, artifact_ref, distribution_attempt,
// period_partition)` — a duplicate of the SAME round is a 200 no-op replay
// (Inv. #5's shape). No run-status recompute here (that happens only on the
// distribution execution's terminal `.../status` push, §Design) and no
// `AUDIT_LOG` write — the appended row IS the audit surface, the same
// "insert-first, no per-signal audit" shape as `bill_run_account_stage`
// (code-standards §1.10).
export async function recordDistributionOutcome(
  input: RecordDistributionOutcomeInput,
): Promise<RecordDistributionOutcomeResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, input.runId);
    if (!run) throw notFound("Bill run not found.");
    if (run.status !== "DISTRIBUTING") {
      throw conflict("Bill run is not DISTRIBUTING.");
    }
    if (run.distributionAttempt !== input.attempt) {
      // A straggler signal from a superseded round (T1's stale-attempt guard,
      // the same shape `handle-stage-signal.ts` applies to
      // `bill_run_account.attempt_count`) — accepted as a no-op replay rather
      // than rejected, so a slow/duplicate signal from the prior attempt can
      // never land on the current round's outcome set.
      return { replayed: true };
    }

    try {
      await billRunDistributionRepository.insertOutcome(tx, {
        refBillRunId: input.runId,
        target: input.target,
        artifactRef: input.artifactRef,
        artifactType: input.artifactType,
        isMandatory: input.isMandatory,
        outcome: input.outcome,
        distributionAttempt: input.attempt,
        periodPartition: firstOfMonth(run.periodStart),
      });
      return { replayed: false };
    } catch (err) {
      if (isUniqueViolation(err, IDEMPOTENCY_CONSTRAINT)) {
        return { replayed: true };
      }
      throw err;
    }
  });
}

export interface RecomputeDistributionStatusResult {
  status: "COMPLETED" | "DISTRIBUTION_FAILED" | null;
}

// bm20-spec §Design "recomputes the run to COMPLETED/DISTRIBUTION_FAILED".
// Called by `handle-status-push.ts` on the distribution flow's generic
// `DISTRIBUTION_FINISHED` terminal push, and reused by `reconcile-run.ts`'s
// "Check status" SUCCESS branch for a DISTRIBUTING run — the SAME derivation
// either way, so the two paths can never disagree. Reads only the CURRENT
// round's outcomes (the UNIQUE key already scopes one row per
// (target, artifact_ref) within an attempt, so no DISTINCT ON is needed):
//   - Any mandatory artifact FAILED at this round → DISTRIBUTION_FAILED.
//   - Every expected mandatory artifact (bm19 stored invoices + the report,
//     computeExpectedMandatoryArtifactCount) DELIVERED → COMPLETED.
//   - Otherwise → no change (heartbeat bumped only) — the recorded set is
//     still incomplete; never force a status the outcome set doesn't support
//     (architecture Inv. #12's "derived, never forced" discipline).
export async function recomputeDistributionStatus(
  tx: Database,
  run: Pick<BillRun, "billRunId" | "distributionAttempt">,
): Promise<RecomputeDistributionStatusResult> {
  const attempt = run.distributionAttempt ?? 1;
  const rows = await billRunDistributionRepository.listForAttempt(
    tx,
    run.billRunId,
    attempt,
  );
  const mandatoryRows = rows.filter((r) => r.isMandatory);

  if (mandatoryRows.some((r) => r.outcome === "FAILED")) {
    await billRunRepository.markDistributionFailed(tx, run.billRunId);
    return { status: "DISTRIBUTION_FAILED" };
  }

  const expected = await computeExpectedMandatoryArtifactCount(
    tx,
    run.billRunId,
  );
  const delivered = mandatoryRows.filter((r) => r.outcome === "DELIVERED").length;
  if (expected > 0 && delivered >= expected) {
    await billRunRepository.completeDistribution(tx, run.billRunId);
    return { status: "COMPLETED" };
  }

  // The flow reported terminal (or the engine reports SUCCESS) yet the
  // recorded outcome set doesn't cover every expected mandatory artifact and
  // none has FAILED — a genuine, unresolved wedge. Do NOT bump the heartbeat
  // here (mirrors `reconcile-run.ts`'s PROCESSING-mismatch precedent exactly):
  // there is no live signal to justify resetting the stall clock, and bumping
  // it would hide the run from `StallBanner`/`isStalled` for another full
  // threshold window while it is genuinely stuck.
  return { status: null };
}

export type ForceCompleteDistributionResult =
  | { ok: true; value: { billRunId: string; abandonedCount: number } }
  | { ok: false; code: "NOT_ABANDONABLE" };

// bm20-spec §Phase-2 review fold T11. `DISTRIBUTION_FAILED` → `COMPLETED`:
// abandons every currently-FAILED artifact of the run's last round so a
// permanently-failing mandatory target can no longer hold the GL period open
// forever (Inv #13). Posted INVs are never touched — this only ever moves
// `bill_run.status`; the abandoned artifacts stay recorded as FAILED rows
// (no new status column — the audit event's `abandonedArtifacts` list is the
// record of what was given up on).
export async function forceCompleteDistribution(
  billRunId: string,
  actorId: string,
  reason: string,
): Promise<ForceCompleteDistributionResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!run || run.status !== "DISTRIBUTION_FAILED") {
      return { ok: false, code: "NOT_ABANDONABLE" } as const;
    }
    const attempt = run.distributionAttempt ?? 1;
    const abandoned = await billRunDistributionRepository.listFailedForAttempt(
      tx,
      billRunId,
      attempt,
    );

    const flipped = await billRunRepository.completeDistribution(tx, billRunId);
    if (!flipped) {
      return { ok: false, code: "NOT_ABANDONABLE" } as const;
    }

    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_DISTRIBUTION_ABANDONED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: billRunId,
      beforeData: {
        status: run.status,
        abandonedArtifacts: abandoned.map((a) => a.artifactRef),
      },
      afterData: { status: "COMPLETED", reason },
    });

    return {
      ok: true,
      value: { billRunId, abandonedCount: abandoned.length },
    } as const;
  });
}
