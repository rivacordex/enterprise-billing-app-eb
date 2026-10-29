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
        "ref_bill_template_family_id",
        "ref_bill_template_version_id",
        "ref_invoice_profile_version",
        "template_captured_at",
      ].sort(),
    );
  });

  // bm65-spec §1 (migration 0051) — the run-start template stamps: nullable
  // plain keys with no FK (the 0029/0046 posting-stamp rule).
  it("bm65 — the four template stamp columns are nullable and carry no FK (bm88 dropped the CSV stamp)", () => {
    const columns = getTableColumns(billRunAccount);
    for (const key of [
      "refBillTemplateFamilyId",
      "refBillTemplateVersionId",
      "refInvoiceProfileVersion",
      "templateCapturedAt",
    ] as const) {
      expect(columns[key].notNull, key).toBe(false);
    }
    const stampColumns = new Set([
      "ref_bill_template_family_id",
      "ref_bill_template_version_id",
      "ref_invoice_profile_version",
      "template_captured_at",
    ]);
    const fkColumns = getTableConfig(billRunAccount).foreignKeys.flatMap((fk) =>
      fk.reference().columns.map((c) => c.name),
    );
    expect(fkColumns.filter((c) => stampColumns.has(c))).toEqual([]);
  });

  it("bm88 (0055) — the CSV stamp column is gone", () => {
    expect(getTableColumns(billRunAccount)).not.toHaveProperty(
      "refCsvTemplateVersionId",
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
