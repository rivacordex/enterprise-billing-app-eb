import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { customerBillTaxItem } from "@/db/schema/billing/customer-bill-tax-item";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

// bm06-spec §1/§Implementation §1. Structural typing-only assertions
// (customer-bill-schema.test.ts precedent) — the physical DDL of record is
// db/migrations/0030_customer_bill_tax_item.sql.
describe("billing.customer_bill_tax_item", () => {
  it("exposes the exact snake_case column set (no JSONB — first-class table)", () => {
    expect(columnNames(customerBillTaxItem).sort()).toEqual(
      [
        "customer_bill_tax_item_id",
        "ref_customer_bill_id",
        "period_partition",
        "tax_category",
        "tax_rate",
        "tax_amount",
      ].sort(),
    );
  });

  it("has a composite primary key (customer_bill_tax_item_id, period_partition) — partition key", () => {
    const { primaryKeys } = getTableConfig(customerBillTaxItem);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "customer_bill_tax_item_id",
      "period_partition",
    ]);
  });

  it("has a composite FK to customer_bill on (ref_customer_bill_id, period_partition)", () => {
    const { foreignKeys } = getTableConfig(customerBillTaxItem);
    const fk = foreignKeys.find((f) =>
      f.reference().foreignColumns.some((c) => c.name === "customer_bill_id"),
    );
    expect(fk).toBeDefined();
    const ref = fk!.reference();
    expect(ref.columns.map((c) => c.name)).toEqual([
      "ref_customer_bill_id",
      "period_partition",
    ]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual([
      "customer_bill_id",
      "period_partition",
    ]);
  });

  it("tax_rate is numeric(5,2) and tax_amount numeric(18,2), both required", () => {
    const columns = getTableColumns(customerBillTaxItem);
    expect(columns.taxRate.columnType).toBe("PgNumeric");
    expect(columns.taxRate.notNull).toBe(true);
    expect(columns.taxAmount.columnType).toBe("PgNumeric");
    expect(columns.taxAmount.notNull).toBe(true);
    expect(columns.taxCategory.notNull).toBe(true);
  });

  it("has no charge-line/amount-array JSONB column (Module Inv. #3 / §6.12)", () => {
    const columns = columnNames(customerBillTaxItem);
    expect(columns).not.toContain("charge_lines");
    expect(columns).not.toContain("line_items");
    expect(columns).not.toContain("breakdown");
  });
});
