import type { Database } from "@/db/client";
import type { LedgerBinding } from "@/db/schema/billing/ledger-binding";

// Skeleton (ac02-spec §2.6/§3.5). Binding-completeness seam (Module Inv. #9)
// — filled by ac05 (onboarding transaction creates the bindings).
export const ledgerBindingRepository = {
  async findByOwner(
    _db: Database,
    _ownerType: "financial_account" | "billing_account",
    _ownerId: string,
  ): Promise<LedgerBinding[]> {
    throw new Error("not implemented (ac05)");
  },
};
