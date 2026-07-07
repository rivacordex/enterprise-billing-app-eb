import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
} from "@/db/schema/product";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("product.product_offering", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(productOffering).sort()).toEqual(
      [
        "product_offering_id",
        "name",
        "is_bundle",
        "is_sellable",
        "billing_only",
        "lifecycle_status",
        "version",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });
});

describe("product.product_specifications", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(productSpecifications).sort()).toEqual(
      [
        "product_spec_id",
        "ref_product_offering_id",
        "name",
        "is_mandatory",
        "is_default",
        "default_value",
        "product_spec_characteristics",
      ].sort(),
    );
  });
});

describe("product.product_offering_price", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(productOfferingPrice).sort()).toEqual(
      [
        "product_offering_price_id",
        "product_offering_id",
        "name",
        "price_type",
        "recurring_charge_period_length",
        "recurring_charge_period_type",
        "unit_of_measure",
        "amount",
        "currency",
        "gl_code",
        "pricing_model",
        "policy",
        "pricing_characteristics",
        "start_date_time",
        "created_at",
      ].sort(),
    );
  });

  it("has no end_date_time or last_update column (Inv. #3, structural)", () => {
    const columns = columnNames(productOfferingPrice);
    expect(columns).not.toContain("end_date_time");
    expect(columns).not.toContain("last_update");
  });

  it("has both start_date_time and created_at as distinct columns", () => {
    const columns = columnNames(productOfferingPrice);
    expect(columns).toContain("start_date_time");
    expect(columns).toContain("created_at");
  });
});
