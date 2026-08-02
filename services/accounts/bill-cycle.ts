import { db } from "@/db/client";
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
    // New bill cycle.
    let inserted: BillCycle;
    try {
      inserted = await billCycleRepository.insert(db, {
        name: input.name,
        description: input.description ?? null,
        frequency: input.frequency,
        cycleDay: input.cycleDay,
        paymentDueDays: input.paymentDueDays,
        lastEditedBy: actorId,
      });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        (e as { code?: string }).code === "23505"
      ) {
        return { ok: false, code: "DUPLICATE_NAME" };
      }
      throw e;
    }
    await insertAuditEvent(db, {
      eventType: "BILL_CYCLE_CHANGED",
      actorUserId: actorId,
      targetEntity: "bill_cycle",
      targetId: inserted.billCycleId,
      beforeData: null,
      afterData: {
        name: input.name,
        frequency: input.frequency,
        cycleDay: input.cycleDay,
        paymentDueDays: input.paymentDueDays,
      },
    });
    return { ok: true, billCycleId: inserted.billCycleId };
  }

  // Edit existing.
  if (!input.lastModified) {
    return { ok: false, code: "LAST_MODIFIED_REQUIRED" };
  }

  const existing = await billCycleRepository.findById(db, input.billCycleId);
  if (!existing) return { ok: false, code: "NOT_FOUND" };

  const result = await billCycleRepository.update(db, {
    billCycleId: input.billCycleId,
    name: input.name,
    description: input.description ?? null,
    frequency: input.frequency,
    cycleDay: input.cycleDay,
    paymentDueDays: input.paymentDueDays,
    lastModified: new Date(input.lastModified),
    lastEditedBy: actorId,
  });

  if (result !== "updated") {
    return {
      ok: false,
      code: ({ not_found: "NOT_FOUND", conflict: "CONFLICT" } as const)[result],
    };
  }

  await insertAuditEvent(db, {
    eventType: "BILL_CYCLE_CHANGED",
    actorUserId: actorId,
    targetEntity: "bill_cycle",
    targetId: input.billCycleId,
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

  return { ok: true, billCycleId: input.billCycleId };
}

export async function retireBillCycle(
  billCycleId: string,
  lastModified: Date,
  actorId: string,
): Promise<RetireBillCycleResult> {
  const result = await billCycleRepository.retire(
    db,
    billCycleId,
    lastModified,
  );

  if (result === "updated") {
    await insertAuditEvent(db, {
      eventType: "BILL_CYCLE_CHANGED",
      actorUserId: actorId,
      targetEntity: "bill_cycle",
      targetId: billCycleId,
      beforeData: { state: "active" },
      afterData: { state: "retired" },
    });
    return { ok: true };
  }

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
  { ok: true } | { ok: false; code: "CYCLE_NOT_FOUND" | "CONFIG_NOT_FOUND" }
> {
  const cycle = await billCycleRepository.findById(db, billCycleId);
  if (!cycle) return { ok: false, code: "CYCLE_NOT_FOUND" };

  const allConfig = await systemConfigRepository.findAllNonSecret(db);
  const row = allConfig.find(
    (r) =>
      r.configGroup === "accounts" &&
      r.configKey === "ACCOUNTS_DEFAULT_BILL_CYCLE",
  );
  if (!row) return { ok: false, code: "CONFIG_NOT_FOUND" };

  await systemConfigRepository.updateValue(
    db,
    row.configId,
    billCycleId,
    actorId,
  );
  return { ok: true };
}
