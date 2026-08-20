import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { billRunAccount } from "@/db/schema/billing/bill-run-account";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

// bm03-spec §1/§6.2. Structural typing-only assertions (audit_log precedent,
// tests/db/audit-schema.test.ts) — the physical DDL of record is
// db/migrations/0027_bill_run_account.sql.
describe("billing.bill_run_account", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(billRunAccount).sort()).toEqual(
      [
        "bill_run_account_id",
        "ref_bill_run_id",
        "ref_billing_account_id",
        "period_partition",
        "status",
        "attempt_count",
        "error_code",
        "error_detail",
        "last_processed_at",
      ].sort(),
    );
  });

  it("has a composite primary key (bill_run_account_id, period_partition) — partition key", () => {
    const { primaryKeys } = getTableConfig(billRunAccount);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "bill_run_account_id",
      "period_partition",
    ]);
  });

  it("bill_run_account_id is not a standalone primary key (composite PK lives in the table config)", () => {
    expect(getTableColumns(billRunAccount).billRunAccountId.primary).toBe(
      false,
    );
  });

  it("has the (ref_bill_run_id, ref_billing_account_id, period_partition) UNIQUE", () => {
    const { uniqueConstraints } = getTableConfig(billRunAccount);
    const triple = uniqueConstraints.find(
      (u) => u.name === "bill_run_account_run_ban_period_unique",
    );
    expect(triple?.columns.map((c) => c.name).sort()).toEqual(
      ["ref_bill_run_id", "ref_billing_account_id", "period_partition"].sort(),
    );
  });

  it("has the status CHECK constraint", () => {
    expect(checkNames(billRunAccount)).toContain(
      "bill_run_account_status_check",
    );
  });

  it("status defaults to PENDING and attempt_count defaults to 1", () => {
    const columns = getTableColumns(billRunAccount);
    expect(columns.status.hasDefault).toBe(true);
    expect(columns.attemptCount.hasDefault).toBe(true);
  });

  it("error_code/error_detail/last_processed_at are nullable", () => {
    const columns = getTableColumns(billRunAccount);
    expect(columns.errorCode.notNull).toBe(false);
    expect(columns.errorDetail.notNull).toBe(false);
    expect(columns.lastProcessedAt.notNull).toBe(false);
  });

  it("has no stored charge amount column (Module Inv. #1, structural)", () => {
    const columns = columnNames(billRunAccount);
    expect(columns).not.toContain("amount");
    expect(columns).not.toContain("total_amount");
  });
});
