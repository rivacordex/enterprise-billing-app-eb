import { partyRoleRepository } from "@/db/repositories/party-role";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { BACKDATING_TOLERANCE_DAYS } from "@/validation/backdating-tolerance";
import type { Database } from "@/db/client";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const ORDER_PRECONDITION_ERROR_CODES = [
  "CUSTOMER_NOT_ACTIVE",
  "BILLING_ACCOUNT_CLOSED",
  "BILLING_ACCOUNT_MISMATCH",
  "OFFERING_NOT_ORDERABLE",
  "NO_PRICE_ROWS",
  "OVERRIDE_PRICE_TYPE_INVALID",
  "OVERRIDE_CURRENCY_MISMATCH",
  "BACKDATED_START_TOO_FAR",
] as const;
export type OrderPreconditionErrorCode =
  (typeof ORDER_PRECONDITION_ERROR_CODES)[number];

export type CheckOrderPreconditionsResult =
  | { ok: true }
  | { ok: false; code: OrderPreconditionErrorCode };

// pm28-spec §1 — the update's single source of the submission validation set,
// reused verbatim by pm30's approval (never duplicated elsewhere, grep-able).
// `tx` must be the caller's open transaction: every read here is locked
// (`FOR UPDATE` where the target row supports it) and re-checked immediately
// before the caller's own writes, closing the TOCTOU window between a form
// read and submission (architecture Inv. #19).
export async function checkOrderPreconditions(
  tx: Database,
  input: CreateOrderInput,
  now: Date,
): Promise<CheckOrderPreconditionsResult> {
  // Party — ACTIVE only (Q14); VALIDATED, SUSPENDED, CLOSED, and an unknown
  // id are all rejected the same way.
  const party = await partyRoleRepository.findStatusByIdForUpdate(
    tx,
    input.customerPartyRoleId,
  );
  if (!party || party.status !== "ACTIVE") {
    return { ok: false, code: "CUSTOMER_NOT_ACTIVE" };
  }

  // BAN — non-closed (Q15) and owned by the ordering party. `billing_account`
  // carries its own `ref_party_role_id` (set equal to the financial account's
  // at onboarding time), so this is the same check as "belongs to the
  // party's FA" without an extra join.
  const ban = await billingAccountRepository.findStateByIdForUpdate(
    tx,
    input.billingAccountId,
  );
  if (!ban || ban.state === "closed") {
    return { ok: false, code: "BILLING_ACCOUNT_CLOSED" };
  }
  if (ban.refPartyRoleId !== input.customerPartyRoleId) {
    return { ok: false, code: "BILLING_ACCOUNT_MISMATCH" };
  }

  // Offering — ACTIVE, billing-only, sellable (Q16).
  const offering = await productOfferingRepository.findDetailByIdForUpdate(
    tx,
    input.productOfferingId,
  );
  if (
    !offering ||
    offering.lifecycleStatus !== "ACTIVE" ||
    !offering.billingOnly ||
    !offering.isSellable
  ) {
    return { ok: false, code: "OFFERING_NOT_ORDERABLE" };
  }

  // Prices — at least one row on the pinned version. Insert-only (Inv. #1),
  // so no lock is needed for this existence check to stay valid through the
  // write below (pm16 NO_PRICE_ROWS precedent).
  const prices =
    await productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
      tx,
      input.productOfferingId,
    );
  if (prices.length === 0) {
    return { ok: false, code: "NO_PRICE_ROWS" };
  }

  // Overrides — each targeted price type must exist on the version as a flat
  // price, and its currency must match the BAN's.
  for (const override of input.overrides ?? []) {
    const targetExists = prices.some(
      (price) =>
        price.priceType === override.priceType && price.pricingModel === "flat",
    );
    if (!targetExists) {
      return { ok: false, code: "OVERRIDE_PRICE_TYPE_INVALID" };
    }
    if (override.currency !== ban.currency) {
      return { ok: false, code: "OVERRIDE_CURRENCY_MISMATCH" };
    }
  }

  // Start date — no more than 3 days in the past, checked against this
  // transaction's authoritative `now`, distinct from the schema's parse-time
  // fast-fail (mirrors insert-price's two-copy pattern, pm15).
  const [year, month, day] = input.startDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const startUtcMidnight = Date.UTC(year, month - 1, day);
  const nowUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const daysInPast = Math.round(
    (nowUtcMidnight - startUtcMidnight) / MS_PER_DAY,
  );
  if (daysInPast > BACKDATING_TOLERANCE_DAYS) {
    return { ok: false, code: "BACKDATED_START_TOO_FAR" };
  }

  return { ok: true };
}
