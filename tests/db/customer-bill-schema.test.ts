import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { customerBill } from "@/db/schema/billing/customer-bill";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

// bm05-spec §1/§Implementation §1. Structural typing-only assertions
// (bill-run-account-stage-schema.test.ts precedent) — the physical DDL of
// record is db/migrations/0029_customer_bill.sql.
describe("billing.customer_bill", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(customerBill).sort()).toEqual(
      [
        "customer_bill_id",
        "ref_bill_run_id",
        "ref_billing_account_id",
        "period_partition",
        "category",
        "state",
        "billing_period_start",
        "billing_period_end",
        "subtotal",
        "tax_total",
        "total_amount",
        "payment_due_date",
        "ref_bill_format_id",
        "ref_bill_template_version_id",
        // bm50 — the invoice-profile posting stamp (bm88 dropped the CSV stamp),
        // stamped at posting by the app (bm54).
        "ref_invoice_profile_version",
        // bm67 (migration 0052) — the template family posting stamp.
        "ref_bill_template_family_id",
        "ref_inv_document_id",
        "posted_attempt",
        "charge_checksum",
      ].sort(),
    );
  });

  it("has a composite primary key (customer_bill_id, period_partition) — partition key", () => {
    const { primaryKeys } = getTableConfig(customerBill);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "customer_bill_id",
      "period_partition",
    ]);
  });

  it("has the UNIQUE (ref_bill_run_id, ref_billing_account_id, period_partition)", () => {
    const { uniqueConstraints } = getTableConfig(customerBill);
    const latch = uniqueConstraints.find(
      (u) => u.name === "customer_bill_run_ban_period_unique",
    );
    expect(latch?.columns.map((c) => c.name)).toEqual([
      "ref_bill_run_id",
      "ref_billing_account_id",
      "period_partition",
    ]);
  });

  it("has the category/state CHECK constraints", () => {
    const names = checkNames(customerBill);
    expect(names).toContain("customer_bill_category_check");
    expect(names).toContain("customer_bill_state_check");
  });

  it("state defaults to 'new'", () => {
    expect(getTableColumns(customerBill).state.default).toBe("new");
  });

  it("the posting-stamp columns are nullable (stamped at posting by the app, bm54; no FK)", () => {
    const columns = getTableColumns(customerBill);
    expect(columns.refBillFormatId.notNull).toBe(false);
    expect(columns.refBillTemplateVersionId.notNull).toBe(false);
    expect(columns.refInvoiceProfileVersion.notNull).toBe(false);
    expect(columns.refInvDocumentId.notNull).toBe(false);
    expect(columns.postedAttempt.notNull).toBe(false);
    expect(columns.chargeChecksum.notNull).toBe(false);
  });

  it("bm88 (0055) — the CSV stamp column and its index are gone", () => {
    expect(getTableColumns(customerBill)).not.toHaveProperty(
      "refCsvTemplateVersionId",
    );
    expect(
      getTableConfig(customerBill).indexes.map((i) => i.config.name),
    ).not.toContain("customer_bill_ref_csv_template_version_id_idx");
  });

  it("has no FK reference on ref_bill_format_id/ref_bill_template_version_id (reserved, catalog deferred)", () => {
    const { foreignKeys } = getTableConfig(customerBill);
    const fkColumnNames = foreignKeys.flatMap((fk) =>
      fk.reference().columns.map((c) => c.name),
    );
    expect(fkColumnNames).not.toContain("ref_bill_format_id");
    expect(fkColumnNames).not.toContain("ref_bill_template_version_id");
  });

  it("bm67 — ref_bill_template_family_id is a nullable plain key with no FK (the posting-stamp rule)", () => {
    const columns = getTableColumns(customerBill);
    expect(columns.refBillTemplateFamilyId.name).toBe(
      "ref_bill_template_family_id",
    );
    expect(columns.refBillTemplateFamilyId.notNull).toBe(false);
    const fkColumnNames = getTableConfig(customerBill).foreignKeys.flatMap(
      (fk) => fk.reference().columns.map((c) => c.name),
    );
    expect(fkColumnNames).not.toContain("ref_bill_template_family_id");
  });

  it("subtotal/tax_total/total_amount/billing_period_start/billing_period_end/payment_due_date are required", () => {
    const columns = getTableColumns(customerBill);
    expect(columns.subtotal.notNull).toBe(true);
    expect(columns.taxTotal.notNull).toBe(true);
    expect(columns.totalAmount.notNull).toBe(true);
    expect(columns.billingPeriodStart.notNull).toBe(true);
    expect(columns.billingPeriodEnd.notNull).toBe(true);
    expect(columns.paymentDueDate.notNull).toBe(true);
  });

  it("has no charge-line/amount-array column (Module Inv. #3, structural — this is the anchor, not a copy)", () => {
    const columns = columnNames(customerBill);
    expect(columns).not.toContain("charge_lines");
    expect(columns).not.toContain("line_items");
  });
});
