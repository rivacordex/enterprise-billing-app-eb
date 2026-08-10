import { describe, expect, it } from "vitest";

import { orderItemPriceOverrideRepository } from "@/db/repositories/ordering/order-item-price-override.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import { productOrderItemRepository } from "@/db/repositories/ordering/product-order-item.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";

// Structural no-mutation assert (pm26-spec §4, pm03/product-repository-exports
// precedent). The two permanently insert-only repositories
// (order_item_price_override — Inv. #16; inventory_status_history — Inv. #18)
// must export inserts + finders and never gain an update*/delete*. The
// write-once order-item repository is likewise insert-only (Inv. #15). The
// order and inventory repositories carry a deliberately narrow, named write
// surface (status/characteristics only — never the billing-relevant core).
const MUTATION_NAME_PATTERN =
  /^(insert|create|update|delete|remove|set|branch)/;

const ALLOWED_ORDER_MUTATIONS = new Set(["insertOrder", "updateStatus"]);
const ALLOWED_INVENTORY_MUTATIONS = new Set([
  "insertInventory",
  "updateStatus",
  "updateCharacteristics",
]);

function mutationNames(repo: Record<string, unknown>): string[] {
  return Object.keys(repo).filter((n) => MUTATION_NAME_PATTERN.test(n));
}

describe("ordering + inventory repository exports (structural)", () => {
  it("orderItemPriceOverrideRepository is permanently insert-only (no update*/delete*, Inv. #16)", () => {
    const forbidden = mutationNames(orderItemPriceOverrideRepository).filter(
      (n) => n !== "insertOverride",
    );
    expect(forbidden).toEqual([]);
  });

  it("inventoryStatusHistoryRepository is permanently insert-only (no update*/delete*, Inv. #18)", () => {
    const forbidden = mutationNames(inventoryStatusHistoryRepository).filter(
      (n) => n !== "insertTransition",
    );
    expect(forbidden).toEqual([]);
  });

  it("productOrderItemRepository is write-once (insertItem only, Inv. #15)", () => {
    const forbidden = mutationNames(productOrderItemRepository).filter(
      (n) => n !== "insertItem",
    );
    expect(forbidden).toEqual([]);
  });

  it("productOrderRepository exports no delete* and only the named status write", () => {
    const forbidden = mutationNames(productOrderRepository).filter(
      (n) => !ALLOWED_ORDER_MUTATIONS.has(n),
    );
    expect(forbidden).toEqual([]);
    expect(Object.keys(productOrderRepository)).not.toContainEqual(
      expect.stringMatching(/^delete/),
    );
  });

  it("productInventoryRepository exports no delete* and only the named status/characteristics writes", () => {
    const forbidden = mutationNames(productInventoryRepository).filter(
      (n) => !ALLOWED_INVENTORY_MUTATIONS.has(n),
    );
    expect(forbidden).toEqual([]);
    expect(Object.keys(productInventoryRepository)).not.toContainEqual(
      expect.stringMatching(/^delete/),
    );
  });
});
