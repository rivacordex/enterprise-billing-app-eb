import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { accountView } from "@/db/schema/billing/views";
import type { AccountViewRow } from "@/db/schema/billing/views";
import type {
  AccountState,
  TmfAccountRef,
  TmfRelatedParty,
} from "@/types/accounts";

// The sole producer of the TMF composition types (code-standards §2.6, Q28)
// — no page or other repository assembles this shape ad hoc.
function toTmfAccountRef(row: AccountViewRow): TmfAccountRef {
  return {
    accountId: row.accountId,
    accountType: row.accountType as TmfAccountRef["accountType"],
    name: row.name,
    description: row.description,
    state: row.state as AccountState,
    currency: row.currency,
    relatedParty: row.relatedParty.map(
      (party): TmfRelatedParty => ({
        id: party.id,
        role: "customer",
        name: party.name,
        "@referredType": "Customer",
      }),
    ),
  };
}

// This unit's visible result (ac02-spec §1) — a working reader over
// `billing.account_view` (views.sql), the UNION ALL of financial_account
// and billing_account. No writer here: FA/BAN creation is
// `services/accounts/onboard-customer-accounts.ts` (ac05+).
export const accountViewRepository = {
  async findByAccountId(
    db: Database,
    accountId: string,
  ): Promise<TmfAccountRef | null> {
    const [row] = await db
      .select()
      .from(accountView)
      .where(eq(accountView.accountId, accountId))
      .limit(1);
    return row ? toTmfAccountRef(row) : null;
  },

  // Every account (FA + its BANs) for a given customer party role — the
  // shape the Accounts Overview context strip needs once it exists (ac08+).
  async search(db: Database, refPartyRoleId: string): Promise<TmfAccountRef[]> {
    const rows = await db
      .select()
      .from(accountView)
      .where(eq(accountView.refPartyRoleId, refPartyRoleId));
    return rows.map(toTmfAccountRef);
  },
};
