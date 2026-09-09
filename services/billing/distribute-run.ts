import type { Database } from "@/db/client";
import { db } from "@/db/client";
import { logger } from "@/lib/logger";
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
import type {
  DistributionArtifactType,
  DistributionOutcome,
} from "@/types/billing";

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

// bm20 recompute + bm21-spec §Implementation §2 (T8, the D10 safety net) — ONE
// read of the run's POSTED accounts vs its STORED final invoices, shared by
// `recomputeDistributionStatus` (BOTH the never-silently-complete-around-an-
// unrendered-posted-account check AND the expected mandatory-artifact count)
// and `forceCompleteDistribution` (so an abandoned run's audit records the
// posted-but-unrendered accounts it gave up on, not just the FAILED rows).
//
// `unrenderedAccountIds` — POSTED accounts with no stored `bill_run_invoices`
// row yet (bm19's tolerated render-pending gap, D10): a mandatory artifact
// this run could never have triggered (`triggerDistribution` only ever hands
// the engine what is actually STORED), so "every expected mandatory artifact
// delivered" must never be satisfied vacuously around one. A run can reach
// DISTRIBUTION_FAILED on this signal ALONE, with zero FAILED outcome rows.
//
// `storedInvoiceCount` — the stored-invoice half of the expected mandatory
// count; the one always-triggered `report_csv` adds the `+ 1`. Derived from
// the SAME read as the gap-check (one row per (run, ban),
// `bill_run_invoices_run_ban_period_unique`), so the count and the gap-check
// can never disagree — and never a third `countForRun` scan of the same
// partition (mirrors `computeRunStatus`'s "derived, not guessed" discipline,
// architecture Inv. #12).
async function postedVsStoredInvoices(
  tx: Database,
  billRunId: string,
): Promise<{ unrenderedAccountIds: string[]; storedInvoiceCount: number }> {
  const [postedIds, storedIds] = await Promise.all([
    customerBillRepository.listPostedAccountIds(tx, billRunId),
    billRunInvoicesRepository.listBillingAccountIdsForRun(tx, billRunId),
  ]);
  const stored = new Set(storedIds);
  return {
    unrenderedAccountIds: postedIds.filter((id) => !stored.has(id)),
    storedInvoiceCount: storedIds.length,
  };
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

      // bm21-spec §Implementation §2, Phase-2 review fold T8 — a mandatory
      // invoice rendered/stored AFTER this run's distribution was first
      // triggered (a late `retryRenderInvoice`) was never even attempted —
      // no outcome row exists for it in any round. Both this and the prior
      // round's genuine failures are derived from ONE read of the full
      // delivery log (never `listFailedForAttempt` separately) so the two
      // sets can never drift apart from each other (they are filters over
      // the SAME rows, not two independent queries of the same table).
      const [everAttempted, allInvoices] = await Promise.all([
        billRunDistributionRepository.listForRun(tx, billRunId),
        billRunInvoicesRepository.listForRun(tx, billRunId),
      ]);
      const failed = everAttempted.filter(
        (r) => r.distributionAttempt === priorAttempt && r.outcome === "FAILED",
      );
      const attemptedRefs = new Set(
        everAttempted.map((r) => `${r.target}::${r.artifactRef}`),
      );
      const neverAttemptedInvoices = allInvoices.filter(
        (inv) =>
          !attemptedRefs.has(`${LOOPBACK_TARGET}::${inv.billRunInvoiceId}`),
      );
      // The report_csv is mandatory and part of EVERY round's payload
      // (`triggerDistribution`), yet it is neither a `bill_run_invoices` row
      // (so `neverAttemptedInvoices` can't cover it) nor — if its round-1
      // outcome was lost entirely — a `FAILED` row (so `failed` can't either).
      // Left out, a run whose report outcome never landed can never re-attempt
      // it, so `recomputeDistributionStatus` (expected = invoices + 1) can
      // never reach COMPLETED and the run wedges. Re-attempt it whenever NO
      // outcome for it was ever recorded (a genuine FAILED report is already in
      // `failed`; a DELIVERED one has a row and is correctly left alone).
      const reportNeverAttempted = !attemptedRefs.has(
        `${LOOPBACK_TARGET}::${REPORT_ARTIFACT_REF}`,
      );

      if (
        failed.length === 0 &&
        neverAttemptedInvoices.length === 0 &&
        !reportNeverAttempted
      ) {
        return { ok: false, code: "NO_FAILED_ARTIFACTS" } as const;
      }
      const newAttempt = priorAttempt + 1;

      const toRedeliver = [
        ...failed,
        ...neverAttemptedInvoices.map((inv) => ({
          target: LOOPBACK_TARGET,
          artifactRef: inv.billRunInvoiceId,
          artifactType: "invoice_pdf" as const,
          isMandatory: true,
        })),
        ...(reportNeverAttempted
          ? [
              {
                target: LOOPBACK_TARGET,
                artifactRef: REPORT_ARTIFACT_REF,
                artifactType: "report_csv" as const,
                isMandatory: true,
              },
            ]
          : []),
      ];

      // Resolve blob refs: an invoice PDF is looked up from the immutable
      // `bill_run_invoices` store (bm19); the transient report CSV (D21) is
      // regenerated fresh rather than re-read (there is no stored row for it).
      const needsInvoices = toRedeliver.some(
        (f) => f.artifactType === "invoice_pdf",
      );
      const needsReport = toRedeliver.some(
        (f) => f.artifactType === "report_csv",
      );
      const invoices = needsInvoices ? allInvoices : [];
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
      for (const f of toRedeliver) {
        const blobRef =
          f.artifactType === "report_csv"
            ? reportBlobRef
            : (invoiceBlobByRef.get(f.artifactRef) ?? null);
        // Defensive only — an invoice/report that vanished between the failed
        // read above and here should not happen (both are immutable/
        // regenerated), but never hand the engine a null blob_ref.
        if (!blobRef) {
          logger.error(
            "rerunDistribution: failed artifact has no resolvable blob reference, skipping",
            {
              billRunId,
              target: f.target,
              artifactRef: f.artifactRef,
              artifactType: f.artifactType,
            },
          );
          continue;
        }
        artifacts.push({
          ref: f.artifactRef,
          type: f.artifactType,
          blob_ref: blobRef,
        });
      }

      if (artifacts.length === 0) {
        // Every previously-failed artifact lost its blob reference — nothing
        // resolvable to redeliver. Bail out before triggering the engine or
        // advancing the run to DISTRIBUTING with an empty payload.
        return { ok: false, code: "NO_FAILED_ARTIFACTS" } as const;
      }

      const targetIsMandatory = new Map(
        toRedeliver.map((f) => [f.target, f.isMandatory]),
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
        beforeData: {
          // bm21 T8 — `toRedeliver` (and thus the engine payload) is the union
          // of the prior round's genuine failures AND the never-attempted
          // mandatory invoices; the audit must record BOTH so it reflects
          // every artifact actually sent for redelivery, not just the failed
          // subset.
          failedArtifacts: [
            ...failed.map((f) => f.artifactRef),
            ...neverAttemptedInvoices.map((inv) => inv.billRunInvoiceId),
          ],
        },
        afterData: {
          attempt: newAttempt,
          executionId: executionRef.executionId,
        },
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

// The identity check backing `recordDistributionOutcome`: v1 ships exactly
// one target (`LOOPBACK_TARGET`, always mandatory, D20), so a pushed outcome
// can only ever legitimately describe that target plus one of the artifacts
// this run actually has — the stored final invoices (bm19) or the one fixed
// report ref. Rejecting anything else stops a malformed or malicious M2M
// push from fabricating an artifact/target `recomputeDistributionStatus`
// would otherwise count toward "all mandatory delivered", or from smuggling
// `is_mandatory: false` past the FAILED-blocks-completion check for a target
// this run never actually configured as advisory.
async function isLaunchedDistributionIdentity(
  tx: Database,
  input: Pick<
    RecordDistributionOutcomeInput,
    "runId" | "target" | "artifactRef" | "artifactType" | "isMandatory"
  >,
): Promise<boolean> {
  if (input.target !== LOOPBACK_TARGET || !input.isMandatory) return false;
  if (input.artifactType === "report_csv") {
    return input.artifactRef === REPORT_ARTIFACT_REF;
  }
  const invoices = await billRunInvoicesRepository.listForRun(tx, input.runId);
  return invoices.some((inv) => inv.billRunInvoiceId === input.artifactRef);
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

    if (
      run.distributionAttempt !== null &&
      run.distributionAttempt !== input.attempt
    ) {
      // A straggler signal from a superseded round (T1's stale-attempt guard,
      // the same shape `handle-stage-signal.ts` applies to
      // `bill_run_account.attempt_count`) — accepted as a no-op replay rather
      // than rejected, so a slow/duplicate signal from the prior attempt can
      // never land on the current round's outcome set. Evaluated BEFORE the
      // status check so this holds even once the run has left DISTRIBUTING
      // entirely (a later round already completed/failed while this
      // straggler was in flight) — a stale attempt is never a 409. A run that
      // never entered distribution (`distributionAttempt` still null) has no
      // round to be stale relative to, so it falls through to the status
      // check below instead of being swallowed as a replay.
      return { replayed: true };
    }

    // Only the CURRENT attempt's push needs the run to still be DISTRIBUTING.
    if (run.status !== "DISTRIBUTING") {
      throw conflict("Bill run is not DISTRIBUTING.");
    }

    if (!(await isLaunchedDistributionIdentity(tx, input))) {
      throw conflict(
        "Distribution outcome does not match a launched artifact/target for this run.",
      );
    }

    // stall.ts's invariant — a DISTRIBUTING run's heartbeat is "bumped by every
    // stage/outcome signal" — plus bm20-spec §Implementation §4. A valid
    // per-artifact outcome for the CURRENT round is live progress, so bump
    // `last_progress_at` exactly as the PROCESSING path does on every stage
    // signal (`recomputeStatus`). Placed AFTER the stale-attempt guard (a
    // straggler from a superseded round returned early above), so a long,
    // actively-delivering distribution is never falsely flagged STALLED
    // mid-delivery, and a stale signal never resets the stall clock.
    await billRunRepository.bumpHeartbeat(tx, input.runId);

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
// either way, so the two paths can never disagree. `rerunDistribution` only
// re-triggers the PRIOR round's FAILED artifacts (never the ones already
// DELIVERED), so a round's own rows are never the full mandatory set on
// their own — reads across EVERY round instead and keeps, per
// `(target, artifact_ref)`, only the outcome from its highest recorded
// `distribution_attempt` (a `FAILED` from round 1 that round 2 redelivers as
// `DELIVERED` must supersede it, never be double-counted):
//   - Any mandatory artifact's latest outcome is FAILED → DISTRIBUTION_FAILED.
//   - Every expected mandatory artifact (bm19 stored invoices + the report,
//     computeExpectedMandatoryArtifactCount) DELIVERED (at its latest attempt)
//     → COMPLETED.
//   - Otherwise → no change (heartbeat bumped only) — the recorded set is
//     still incomplete; never force a status the outcome set doesn't support
//     (architecture Inv. #12's "derived, never forced" discipline).
export async function recomputeDistributionStatus(
  tx: Database,
  run: Pick<BillRun, "billRunId">,
): Promise<RecomputeDistributionStatusResult> {
  const rows = await billRunDistributionRepository.listForRun(
    tx,
    run.billRunId,
  );
  const latestByArtifact = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.target}::${row.artifactRef}`;
    const current = latestByArtifact.get(key);
    if (!current || row.distributionAttempt > current.distributionAttempt) {
      latestByArtifact.set(key, row);
    }
  }
  const mandatoryRows = [...latestByArtifact.values()].filter(
    (r) => r.isMandatory,
  );

  if (mandatoryRows.some((r) => r.outcome === "FAILED")) {
    await billRunRepository.markDistributionFailed(tx, run.billRunId);
    return { status: "DISTRIBUTION_FAILED" };
  }

  // T8's D10 safety net + the expected count in ONE read (see
  // `postedVsStoredInvoices`) — never silently COMPLETED around a posted
  // account with nothing stored to deliver.
  const { unrenderedAccountIds, storedInvoiceCount } =
    await postedVsStoredInvoices(tx, run.billRunId);
  if (unrenderedAccountIds.length > 0) {
    await billRunRepository.markDistributionFailed(tx, run.billRunId);
    return { status: "DISTRIBUTION_FAILED" };
  }

  // Every stored final invoice + the one always-triggered report_csv.
  const expected = storedInvoiceCount + 1;
  const delivered = mandatoryRows.filter(
    (r) => r.outcome === "DELIVERED",
  ).length;
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
    // A run reaches DISTRIBUTION_FAILED two ways: a FAILED artifact outcome,
    // OR (T8/D10) a POSTED account never rendered/stored, which has NO outcome
    // row at all. Force-completing abandons BOTH, so the audit must record both
    // — otherwise a run failed purely on the unrendered-posted path completes
    // with an empty abandoned list and `abandonedCount` 0, hiding that a posted
    // invoice was given up on un-rendered/undelivered.
    const [abandoned, { unrenderedAccountIds }] = await Promise.all([
      billRunDistributionRepository.listFailedForAttempt(
        tx,
        billRunId,
        attempt,
      ),
      postedVsStoredInvoices(tx, billRunId),
    ]);

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
        // Posted accounts with no stored invoice to deliver (render-pending,
        // D10) — abandoned un-rendered by this force-complete. Recorded so the
        // audit never understates what was given up on.
        abandonedUnrenderedAccounts: unrenderedAccountIds,
      },
      afterData: { status: "COMPLETED", reason },
    });

    return {
      ok: true,
      value: {
        billRunId,
        abandonedCount: abandoned.length + unrenderedAccountIds.length,
      },
    } as const;
  });
}
