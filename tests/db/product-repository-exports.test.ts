import { describe, expect, it } from "vitest";

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";

const MUTATION_NAME_PATTERN = /^(insert|create|update|delete|remove|set)/;

// Structural no-mutation assert (pm00 / pm03-spec §3.8). v1 repositories
// export finders only (Inv. #11). Phase 2 (pm11, prodmgmt-architecture-phase2
// §2) explicitly relaxes this for the offering repository — it gains write
// methods (`insertOffering`, and later branch/activate/retire) — so the
// offering assertion below now whitelists `insertOffering` by name rather
// than forbidding the whole mutation-name pattern outright. The price
// repository's `update*`/`delete*` prohibition stays PERMANENT (Inv. #1) —
// at CRUD time its pattern relaxes for `insert*` only (a new `insertPrice`),
// never for update/delete on prices.
describe("product repository exports (structural)", () => {
  it("productOfferingRepository exports no update*/delete* mutation function (insertOffering excepted, Phase 2 pm11)", () => {
    const names = Object.keys(productOfferingRepository);
    const forbidden = names.filter(
      (n) => MUTATION_NAME_PATTERN.test(n) && n !== "insertOffering",
    );
    expect(forbidden).toEqual([]);
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
