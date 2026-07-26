import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { financialAccount } from "@/db/schema/billing/accounts";
import { partyRole } from "@/db/schema/customer";
import type {
  FinancialAccount,
  FinancialAccountInsert,
} from "@/db/schema/billing/accounts";

export const financialAccountRepository = {
  async findById(
    db: Database,
    financialAccountId: string,
  ): Promise<FinancialAccount | null> {
    const [row] = await db
      .select()
      .from(financialAccount)
      .where(eq(financialAccount.financialAccountId, financialAccountId))
      .limit(1);
    return row ?? null;
  },

  async insert(
    tx: Database,
    data: FinancialAccountInsert,
  ): Promise<FinancialAccount> {
    const [row] = await tx.insert(financialAccount).values(data).returning();
    if (!row) throw new Error("financial_account insert returned no row");
    return row;
  },

  // Returns all FAs whose party role belongs to the given organization.
  // Used by the onboarding wizard to detect returning customers (ac04).
  async findByEngagedParty(
    db: Database,
    engagedParty: string,
  ): Promise<
    Pick<FinancialAccount, "financialAccountId" | "name" | "state">[]
  > {
    return db
      .select({
        financialAccountId: financialAccount.financialAccountId,
        name: financialAccount.name,
        state: financialAccount.state,
      })
      .from(financialAccount)
      .innerJoin(
        partyRole,
        eq(financialAccount.refPartyRoleId, partyRole.partyRoleId),
      )
      .where(eq(partyRole.engagedParty, engagedParty));
  },

  async findByPartyRoleIds(
    db: Database,
    partyRoleIds: string[],
  ): Promise<FinancialAccount[]> {
    if (partyRoleIds.length === 0) return [];
    return db
      .select()
      .from(financialAccount)
      .where(inArray(financialAccount.refPartyRoleId, partyRoleIds));
  },
};
