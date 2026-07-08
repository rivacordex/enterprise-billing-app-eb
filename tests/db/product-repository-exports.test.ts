import { describe, expect, it } from "vitest";

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";

const MUTATION_NAME_PATTERN = /^(insert|create|update|delete|remove|set)/;

// Structural no-mutation assert (pm00 / pm03-spec §3.8). v1 repositories
// export finders only (Inv. #11). The price repository's `update*`/
// `delete*` prohibition is PERMANENT (Inv. #1) — at CRUD time the pattern
// relaxes for `insert*` only (a new `insertPrice`), never for update/delete
// on prices.
describe("product repository exports (structural)", () => {
  it("productOfferingRepository exports no mutation function", () => {
    const names = Object.keys(productOfferingRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });

  it("productSpecificationRepository exports no mutation function", () => {
    const names = Object.keys(productSpecificationRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });

  it("productOfferingPriceRepository exports no mutation function (permanent for update/delete)", () => {
    const names = Object.keys(productOfferingPriceRepository);
    expect(names.some((n) => MUTATION_NAME_PATTERN.test(n))).toBe(false);
  });
});
