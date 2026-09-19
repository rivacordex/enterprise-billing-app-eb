import { describe, expect, it } from "vitest";

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";

const MUTATION_NAME_PATTERN =
  /^(insert|create|update|delete|remove|set|branch)/;

// Structural no-mutation assert (pm00 / pm03-spec §3.8). v1 repositories
// export finders only (Inv. #11). Phase 2 (pm11, prodmgmt-architecture-phase2
// §2) explicitly relaxes this for the offering repository — it gains write
// methods (`insertOffering`, and later branch/activate/retire) — so the
// offering assertion below now whitelists those names rather than
// forbidding the whole mutation-name pattern outright. The price
// repository's `update*`/`delete*` prohibition stays PERMANENT (Inv. #1) —
// at CRUD time its pattern relaxes for `insert*` only (a new `insertPrice`),
// never for update/delete on prices.
const ALLOWED_OFFERING_MUTATIONS = new Set([
  "insertOffering",
  "updateOfferingDraftInPlace",
  "branchOfferingAsDraft",
]);

// pm14: the specification repository gains its own write methods
// (insertSpecification/updateSpecification/deleteSpecification) — same
// relaxation shape as ALLOWED_OFFERING_MUTATIONS above.
const ALLOWED_SPECIFICATION_MUTATIONS = new Set([
  "insertSpecification",
  "updateSpecification",
  "deleteSpecification",
]);

// pm38 (Inv. #1 amended): the price repository gains `updatePrice`/`deletePrice`
// alongside `insertPrice` — the three writes it now permanently exports, and no
// fourth. Both mutators refuse a non-DRAFT parent (proven by
// product-price-writes.integration.test.ts and the source-level
// product-module-boundaries guardrail); this file only asserts the export set.
const ALLOWED_PRICE_MUTATIONS = new Set([
  "insertPrice",
  "updatePrice",
  "deletePrice",
]);

describe("product repository exports (structural)", () => {
  it("productOfferingRepository exports no update*/delete* mutation function (insertOffering, updateOfferingDraftInPlace, branchOfferingAsDraft excepted, Phase 2 pm11/pm12/pm13)", () => {
    const names = Object.keys(productOfferingRepository);
    const forbidden = names.filter(
      (n) =>
        MUTATION_NAME_PATTERN.test(n) && !ALLOWED_OFFERING_MUTATIONS.has(n),
    );
    expect(forbidden).toEqual([]);
  });

  it("productSpecificationRepository exports no mutation function (insertSpecification/updateSpecification/deleteSpecification excepted, Phase 2 pm14)", () => {
    const names = Object.keys(productSpecificationRepository);
    const forbidden = names.filter(
      (n) =>
        MUTATION_NAME_PATTERN.test(n) &&
        !ALLOWED_SPECIFICATION_MUTATIONS.has(n),
    );
    expect(forbidden).toEqual([]);
  });

  it("productOfferingPriceRepository exports only insertPrice/updatePrice/deletePrice mutations (pm38 Inv. #1 amended)", () => {
    const names = Object.keys(productOfferingPriceRepository);
    const forbidden = names.filter(
      (n) => MUTATION_NAME_PATTERN.test(n) && !ALLOWED_PRICE_MUTATIONS.has(n),
    );
    expect(forbidden).toEqual([]);
  });
});
