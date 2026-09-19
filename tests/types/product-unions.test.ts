import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_STATUSES,
  RECURRING_PERIOD_LENGTHS,
  RECURRING_PERIOD_TYPES,
  UNITS_OF_MEASURE,
} from "@/types/product";

// pm37-spec I6. Every expected list is duplicated here on purpose — NOT imported
// from a shared constant — so a silent widening of a domain union, or a re-order
// of the lifecycle, fails this test instead of passing vacuously. The values
// must equal pm35's database CHECK vocabularies exactly (case-sensitive), and
// the lifecycle order is load-bearing (SQL enum order === array index, D1).
describe("product domain unions", () => {
  it("LIFECYCLE_STATUSES holds the five members in lifecycle order", () => {
    expect([...LIFECYCLE_STATUSES]).toEqual([
      "DRAFT",
      "TESTING",
      "ACTIVE",
      "OBSOLETE",
      "RETIRED",
    ]);
  });

  it("UNITS_OF_MEASURE matches the usage-unit CHECK, case-sensitive", () => {
    expect([...UNITS_OF_MEASURE]).toEqual(["Mbps", "GB", "MB", "EA"]);
  });

  it("RECURRING_PERIOD_TYPES is months-only (period_value CHECK)", () => {
    expect([...RECURRING_PERIOD_TYPES]).toEqual(["months"]);
  });

  it("RECURRING_PERIOD_LENGTHS is (1, 3, 12) (period_value CHECK)", () => {
    expect([...RECURRING_PERIOD_LENGTHS]).toEqual([1, 3, 12]);
  });
});
