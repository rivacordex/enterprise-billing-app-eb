import { db } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { BillCycle } from "@/db/schema/billing/catalogs";
import type { UpsertBillCycleInput } from "@/validation/accounts/bill-cycle.schema";

export type { BillCycle };

export type UpsertBillCycleResult =
  | { ok: true; billCycleId: string }
  | { ok: false; code: "DUPLICATE_NAME" }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ALREADY_RETIRED" }
  | { ok: false; code: "LAST_MODIFIED_REQUIRED" };

export type RetireBillCycleResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ALREADY_RETIRED" }
  | { ok: false; code: "CONFLICT" };

export async function listBillCycles(): Promise<BillCycle[]> {
  return billCycleRepository.findAll(db);
}

export async function upsertBillCycle(
  input: UpsertBillCycleInput,
  actorId: string,
): Promise<UpsertBillCycleResult> {
  if (!input.billCycleId) {
    // New bill cycle — insert + audit are atomic.
    let billCycleId: string;
    try {
      const inserted = await db.transaction(async (tx) => {
        const row = await billCycleRepository.insert(tx, {
          name: input.name,
          description: input.description ?? null,
          frequency: input.frequency,
          cycleDay: input.cycleDay,
          paymentDueDays: input.paymentDueDays,
          lastEditedBy: actorId,
        });
        await insertAuditEvent(tx, {
          eventType: "BILL_CYCLE_CHANGED",
          actorUserId: actorId,
          targetEntity: "bill_cycle",
          targetId: row.billCycleId,
          beforeData: null,
          afterData: {
            name: input.name,
            frequency: input.frequency,
            cycleDay: input.cycleDay,
            paymentDueDays: input.paymentDueDays,
          },
        });
        return row;
      });
      billCycleId = inserted.billCycleId;
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, code: "DUPLICATE_NAME" };
      throw e;
    }
    return { ok: true, billCycleId };
  }

  // Edit existing.
  if (!input.lastModified) {
    return { ok: false, code: "LAST_MODIFIED_REQUIRED" };
  }

  const existing = await billCycleRepository.findById(db, input.billCycleId);
  if (!existing) return { ok: false, code: "NOT_FOUND" };

  let updateOutcome: "updated" | "conflict" | "already_retired" | "not_found";
  try {
    updateOutcome = await db.transaction(async (tx) => {
      const result = await billCycleRepository.update(tx, {
        billCycleId: input.billCycleId!,
        name: input.name,
        description: input.description ?? null,
        frequency: input.frequency,
        cycleDay: input.cycleDay,
        paymentDueDays: input.paymentDueDays,
        lastModified: new Date(input.lastModified!),
        lastEditedBy: actorId,
      });

      if (result !== "updated") return result;

      await insertAuditEvent(tx, {
        eventType: "BILL_CYCLE_CHANGED",
        actorUserId: actorId,
        targetEntity: "bill_cycle",
        targetId: input.billCycleId!,
        beforeData: {
          name: existing.name,
          frequency: existing.frequency,
          cycleDay: existing.cycleDay,
          paymentDueDays: existing.paymentDueDays,
        },
        afterData: {
          name: input.name,
          frequency: input.frequency,
          cycleDay: input.cycleDay,
          paymentDueDays: input.paymentDueDays,
        },
      });

      return "updated" as const;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: "DUPLICATE_NAME" };
    throw e;
  }

  if (updateOutcome !== "updated") {
    return {
      ok: false,
      code: (
        {
          not_found: "NOT_FOUND",
          conflict: "CONFLICT",
          already_retired: "ALREADY_RETIRED",
        } as const
      )[updateOutcome],
    };
  }

  return { ok: true, billCycleId: input.billCycleId };
}

export async function retireBillCycle(
  billCycleId: string,
  lastModified: Date,
  actorId: string,
): Promise<RetireBillCycleResult> {
  const result = await db.transaction(async (tx) => {
    const r = await billCycleRepository.retire(tx, billCycleId, lastModified);
    if (r !== "updated") return r;

    // Read the highest-version ACTIVE default row so the CAS UPDATE can pin
    // to its exact configId — prevents clearing a lower-version ACTIVE row or
    // a DRAFT/RETIRED row with the same value. Zero affected rows from the
    // UPDATE means a concurrent writer already moved the default elsewhere;
    // retirement proceeds (the default no longer points at this cycle).
    const activeDefault = await systemConfigRepository.findActiveRow(
      tx,
      "accounts",
      "ACCOUNTS_DEFAULT_BILL_CYCLE",
    );
    if (activeDefault?.configValue === billCycleId) {
      await systemConfigRepository.clearValueIfEquals(
        tx,
        activeDefault.configId,
        billCycleId,
        actorId,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "BILL_CYCLE_CHANGED",
      actorUserId: actorId,
      targetEntity: "bill_cycle",
      targetId: billCycleId,
      beforeData: { state: "active" },
      afterData: { state: "retired" },
    });

    return "updated" as const;
  });

  if (result === "updated") return { ok: true };

  return {
    ok: false,
    code: (
      {
        not_found: "NOT_FOUND",
        already_retired: "ALREADY_RETIRED",
        conflict: "CONFLICT",
      } as const
    )[result],
  };
}

// Writes ACCOUNTS_DEFAULT_BILL_CYCLE in system_config. Called from
// set-wizard-defaults action; also exposed for the "Set as Default" shortcut
// on the bill-cycle table row.
export async function setDefaultBillCycle(
  billCycleId: string,
  actorId: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      code: "CYCLE_NOT_FOUND" | "CYCLE_RETIRED" | "CONFIG_NOT_FOUND";
    }
> {
  return db.transaction(async (tx) => {
    const cycle = await billCycleRepository.findById(tx, billCycleId);
    if (!cycle) return { ok: false, code: "CYCLE_NOT_FOUND" };
    if (cycle.state !== "active") return { ok: false, code: "CYCLE_RETIRED" };

    const allConfig = await systemConfigRepository.findAllNonSecret(tx);
    const row = allConfig.find(
      (r) =>
        r.configGroup === "accounts" &&
        r.configKey === "ACCOUNTS_DEFAULT_BILL_CYCLE",
    );
    if (!row) return { ok: false, code: "CONFIG_NOT_FOUND" };

    await systemConfigRepository.updateValue(
      tx,
      row.configId,
      billCycleId,
      actorId,
    );
    return { ok: true };
  });
}
