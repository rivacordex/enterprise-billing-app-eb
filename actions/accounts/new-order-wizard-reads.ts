"use server";

// pm29-spec Design §1: the New Order wizard's three steps read across the
// customer, accounts, and catalog modules via their own services
// (architecture §1's "Step reads use other modules' services"), never
// repositories. Because the wizard is a client-held, interactive Dialog
// (step state via useState — the app's first multi-step wizard), those
// reads need a Server Action entry point the client can call directly, the
// same way `OnboardAccountsWizard` calls `getWizardOptionsAction`
// (components/customers/onboard-accounts-wizard.tsx /
// actions/accounts/get-wizard-options.ts — the direct precedent for this
// file's placement and shape).
//
// Disclosed placement call: `components/**` may not depend on `services/**`
// or `auth/**` (ESLint `boundaries/dependencies`, general architecture),
// only on `actions/**` — so these read-only wrappers can't live beside the
// wizard components that are their only caller. They also don't belong in
// `actions/ordering/`, whose contents are pinned to exactly
// `create-order.action.ts` by this same unit's own
// `EXPECTED_ORDERING_ACTION_FILES` guardrail (pm29-spec Verification
// checklist), nor in `actions/customer/` or `actions/product/`, whose
// action-file sets are each pinned by an existing ship-gated allow-list
// (`product-module-boundaries.test.ts`'s `PRODUCT_ACTION_FILES`,
// `customer-module-boundaries.test.ts`'s `EXPECTED_FILES`) this unit has no
// mandate to reopen. `actions/accounts/` carries no such allow-list and
// already hosts `get-wizard-options.ts`'s own "wizard-support read living
// outside actions/ordering" precedent, so that's this file's home.
//
// Every entry point re-checks `product_orders:EDIT` independently (the same
// permission `createOrderAction` itself requires) rather than each read's
// "native" permission — a caller who can search for customers/accounts/
// offerings through this wizard is, by construction, a caller who is about
// to submit an order.

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { searchCustomers } from "@/services/customer/search-customers";
import { searchAccounts } from "@/services/accounts/search-accounts";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { resolveTerm } from "@/services/accounts/term-resolution";
import { listOfferings } from "@/services/product/list-offerings";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import type { CustomerSearchResults } from "@/types/customer";
import type { OfferingDetail } from "@/types/product";

async function canActOnOrders(): Promise<boolean> {
  try {
    await requirePermission(PERMISSIONS.PRODUCT_ORDERS, LEVELS.EDIT);
    return true;
  } catch {
    return false;
  }
}

// Step 1 — customer search (`searchCustomers`, customer module). Returns
// `null` when the caller lacks permission, matching `getWizardOptionsAction`'s
// precedent; the wizard treats `null` as "stop, show a permission error."
export async function wizardSearchCustomersAction(
  query: string,
): Promise<CustomerSearchResults | null> {
  if (!(await canActOnOrders())) return null;
  return searchCustomers(query);
}

export type WizardBillingAccountOption = {
  billingAccountId: string;
  name: string;
  state: string;
  currency: string;
  billCycleId: string;
  billCycleName: string;
  paymentTermsDays: number;
};

export type WizardCustomerAccounts = {
  financialAccountId: string;
  financialAccountName: string;
  bans: WizardBillingAccountOption[];
} | null;

// Step 2 — the selected customer's financial account and its non-closed BANs
// (state/currency/cycle/terms), per pm29-spec §Design ("BAN list with
// state/currency/cycle/terms"). `searchAccounts(id, "customer")` does an
// exact `ref_party_role_id` match (accounts module precedent), so the first
// result is the customer's FA — onboarding provisions exactly one per
// customer (ac04). A per-BAN `getBillingAccountDetail` call resolves the
// fields `getFinancialAccountDetail`'s own `bans` projection doesn't carry
// (currency, cycle, resolved terms) — an accepted N+1 cost on a short,
// small list, same disclosed trade pm21 made for `getOfferingDetail`.
export async function wizardGetCustomerAccountsAction(
  customerPartyRoleId: string,
): Promise<WizardCustomerAccounts> {
  if (!(await canActOnOrders())) return null;

  const accountSearch = await searchAccounts(customerPartyRoleId, "customer");
  const fa = accountSearch.results[0];
  if (!fa) return null;

  const faDetail = await getFinancialAccountDetail(fa.financialAccountId);
  if (!faDetail) return null;

  const nonClosedBans = faDetail.bans.filter((ban) => ban.state !== "closed");

  const bans = (
    await Promise.all(
      nonClosedBans.map(async (ban) => {
        const detail = await getBillingAccountDetail(ban.billingAccountId);
        if (!detail) return null;
        const option: WizardBillingAccountOption = {
          billingAccountId: ban.billingAccountId,
          name: ban.name,
          state: ban.state,
          currency: detail.ban.currency,
          billCycleId: detail.billCycle.billCycleId,
          billCycleName: detail.billCycle.name,
          paymentTermsDays: resolveTerm(
            detail.ban.paymentDueDaysOverride,
            detail.billCycle.paymentDueDays,
          ),
        };
        return option;
      }),
    )
  ).filter((option): option is WizardBillingAccountOption => option !== null);

  return {
    financialAccountId: fa.financialAccountId,
    financialAccountName: fa.name,
    bans,
  };
}

export type WizardOfferingOption = {
  productOfferingId: string;
  name: string;
  version: number;
};

// Step 3 — the offer picker. Filtered server-side to `ACTIVE ∧ billing_only ∧
// is_sellable` (pm29-spec Design — `listOfferings` itself carries no such
// filter, so it's applied here, in the one server-side boundary the wizard
// has, never client-side). `billingOnly`/`isSellable` are the "flags" the
// picker filters on (Design §"name + version + flags") — since every
// surfaced row is true on both by construction, there's nothing left to
// render as a chip, so the option carries only what distinguishes rows.
export async function wizardSearchOfferingsAction(
  query: string,
): Promise<WizardOfferingOption[] | null> {
  if (!(await canActOnOrders())) return null;

  const page = await listOfferings({
    q: query,
    status: "ACTIVE",
    sort: "name",
    page: 1,
    offering: null,
  });

  return page.rows
    .filter((row) => row.billingOnly && row.isSellable)
    .map((row) => ({
      productOfferingId: row.productOfferingId,
      name: row.name,
      version: row.version,
    }));
}

// Step 3 — current effective prices + spec-characteristic defaults for the
// selected offer. Reuses `getOfferingDetail` unmodified (catalog effectivity
// computed once, never reimplemented — pm29-spec Design).
export async function wizardGetOfferingDetailAction(
  productOfferingId: string,
): Promise<OfferingDetail | null> {
  if (!(await canActOnOrders())) return null;
  return getOfferingDetail(productOfferingId);
}
