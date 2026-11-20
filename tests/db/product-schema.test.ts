import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import * as productSchema from "@/db/schema/product";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
  priceComponentType,
  priceComponentPriceType,
  popUsageRate,
  popFlatFee,
  popCapacityCommitment,
  popMotivationStep,
  productSpecCharacteristic,
} from "@/db/schema/product";

// Guardrail 13 (unit half), re-baselined by pm70 (0056): the exact snake_case
// column sets of the nine catalog tables the Normalize update leaves — the
// header WITH price_type and WITHOUT price_component, specifications WITHOUT
// product_spec_characteristics, and the six new tables. The rate-card tables
// are unchanged and asserted by their own suites.

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
        "family_offering_id",
      ].sort(),
    );
  });
});

describe("product.product_specifications", () => {
  it("exposes the exact snake_case column set — no product_spec_characteristics (pm70)", () => {
    expect(columnNames(productSpecifications).sort()).toEqual(
      [
        "product_spec_id",
        "ref_product_offering_id",
        "name",
        "is_mandatory",
        "is_default",
        "default_value",
      ].sort(),
    );
  });
});

describe("product.product_offering_price", () => {
  it("exposes the exact snake_case column set — price_type in, price_component out (pm70)", () => {
    expect(columnNames(productOfferingPrice).sort()).toEqual(
      [
        "product_offering_price_id",
        "product_offering_id",
        "name",
        "component_type",
        "price_type",
        "recurring_charge_period_length",
        "recurring_charge_period_type",
        "unit_of_measure",
        "currency",
        "gl_code",
        "policy",
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

describe("the six Normalize tables (pm70, code-standards §6.35)", () => {
  const cases: [string, Parameters<typeof getTableColumns>[0], string[]][] = [
    [
      "price_component_type",
      priceComponentType,
      ["component_type", "applies_at", "basis", "pla_spec_id", "apply_order"],
    ],
    [
      "price_component_price_type",
      priceComponentPriceType,
      ["component_type", "price_type"],
    ],
    [
      "pop_usage_rate",
      popUsageRate,
      [
        "product_offering_price_id",
        "component_type",
        "rate_per_unit",
        "rate_card_lookup",
      ],
    ],
    [
      "pop_flat_fee",
      popFlatFee,
      ["product_offering_price_id", "component_type", "amount"],
    ],
    [
      "pop_capacity_commitment",
      popCapacityCommitment,
      ["product_offering_price_id", "component_type", "committed_quantity"],
    ],
    [
      "pop_motivation_step",
      popMotivationStep,
      [
        "product_offering_price_id",
        "component_type",
        "above_quantity",
        "rate_per_unit",
      ],
    ],
    [
      "product_spec_characteristic",
      productSpecCharacteristic,
      ["product_spec_id", "char_name", "char_value", "display_order"],
    ],
  ];

  for (const [name, table, expected] of cases) {
    it(`product.${name} exposes the exact snake_case column set`, () => {
      expect(columnNames(table).sort()).toEqual([...expected].sort());
    });
  }

  it("no subtype table carries a header column, a step_no, a sequence or a stored pla_spec_id (§6.36, §6.44)", () => {
    for (const table of [
      popUsageRate,
      popFlatFee,
      popCapacityCommitment,
      popMotivationStep,
    ]) {
      const columns = columnNames(table);
      for (const forbidden of [
        "currency",
        "unit_of_measure",
        "start_date_time",
        "step_no",
        "sequence",
        "pla_spec_id",
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    }
  });

  it("the view product.offering_price_v is not declared in Drizzle (§1.62)", () => {
    expect(Object.keys(productSchema)).not.toContain("offeringPriceV");
    expect(Object.keys(productSchema).filter((k) => /view/i.test(k))).toEqual(
      [],
    );
  });
});
