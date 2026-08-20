import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { billRunAccountStage } from "@/db/schema/billing/bill-run-account-stage";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

// bm04-spec §1/§Implementation §1-3. Structural typing-only assertions
// (bill-run-account-schema.test.ts precedent) — the physical DDL of record is
// db/migrations/0028_bill_run_account_stage.sql.
describe("billing.bill_run_account_stage", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(billRunAccountStage).sort()).toEqual(
      [
        "bill_run_account_stage_id",
        "ref_bill_run_id",
        "ref_billing_account_id",
        "period_partition",
        "stage",
        "attempt",
        "status",
        "started_at",
        "ended_at",
        "error_class",
        "error_code",
        "error_detail",
      ].sort(),
    );
  });

  it("has a composite primary key (bill_run_account_stage_id, period_partition) — partition key", () => {
    const { primaryKeys } = getTableConfig(billRunAccountStage);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "bill_run_account_stage_id",
      "period_partition",
    ]);
  });

  it("has the idempotency UNIQUE (ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)", () => {
    const { uniqueConstraints } = getTableConfig(billRunAccountStage);
    const latch = uniqueConstraints.find(
      (u) =>
        u.name === "bill_run_account_stage_run_ban_stage_attempt_period_unique",
    );
    expect(latch?.columns.map((c) => c.name)).toEqual([
      "ref_bill_run_id",
      "ref_billing_account_id",
      "stage",
      "attempt",
      "period_partition",
    ]);
  });

  it("has the stage/status/error_class CHECK constraints", () => {
    const names = checkNames(billRunAccountStage);
    expect(names).toContain("bill_run_account_stage_stage_check");
    expect(names).toContain("bill_run_account_stage_status_check");
    expect(names).toContain("bill_run_account_stage_error_class_check");
  });

  it("error_class/error_code/error_detail/started_at/ended_at are nullable", () => {
    const columns = getTableColumns(billRunAccountStage);
    expect(columns.errorClass.notNull).toBe(false);
    expect(columns.errorCode.notNull).toBe(false);
    expect(columns.errorDetail.notNull).toBe(false);
    expect(columns.startedAt.notNull).toBe(false);
    expect(columns.endedAt.notNull).toBe(false);
  });

  it("attempt/stage/status are required (no default, not nullable)", () => {
    const columns = getTableColumns(billRunAccountStage);
    expect(columns.attempt.notNull).toBe(true);
    expect(columns.stage.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
  });

  it("has no stored charge amount column (Module Inv. #1/#3, structural)", () => {
    const columns = columnNames(billRunAccountStage);
    expect(columns).not.toContain("amount");
    expect(columns).not.toContain("total_amount");
  });
});
