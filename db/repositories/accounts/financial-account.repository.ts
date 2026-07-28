import { eq, inArray, sql } from "drizzle-orm";

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

  // Used by the Accounts Overview search (ac05-spec §2.3 / §3.4).
  // CUSTOMER mode: exact party_role_id match; NAME mode: ILIKE on org name /
  // trading name. Returns limit+1 rows so the caller can derive `hasMore`.
  async searchForOverview(
    db: Database,
    mode: "customer" | "name",
    value: string,
    limit: number,
  ): Promise<
    Array<{
      financialAccountId: string;
      name: string;
      state: string;
      currency: string;
      refPartyRoleId: string;
      organizationName: string;
    }>
  > {
    if (mode === "customer") {
      return db.execute<{
        financialAccountId: string;
        name: string;
        state: string;
        currency: string;
        refPartyRoleId: string;
        organizationName: string;
      }>(sql`
        SELECT
          fa.financial_account_id  AS "financialAccountId",
          fa.name,
          fa.state,
          fa.currency,
          fa.ref_party_role_id     AS "refPartyRoleId",
          org.name                 AS "organizationName"
        FROM billing.financial_account fa
        JOIN customer.party_role pr  ON pr.party_role_id   = fa.ref_party_role_id
        JOIN customer.organization org ON org.organization_id = pr.engaged_party
        WHERE fa.ref_party_role_id = ${value}
        ORDER BY fa.financial_account_id
        LIMIT ${limit + 1}
      `);
    }

    const pattern = `%${value.replace(/[%_\\]/g, "\\$&")}%`;
    return db.execute<{
      financialAccountId: string;
      name: string;
      state: string;
      currency: string;
      refPartyRoleId: string;
      organizationName: string;
    }>(sql`
      SELECT
        fa.financial_account_id  AS "financialAccountId",
        fa.name,
        fa.state,
        fa.currency,
        fa.ref_party_role_id     AS "refPartyRoleId",
        org.name                 AS "organizationName"
      FROM billing.financial_account fa
      JOIN customer.party_role pr  ON pr.party_role_id   = fa.ref_party_role_id
      JOIN customer.organization org ON org.organization_id = pr.engaged_party
      WHERE org.name ILIKE ${pattern} OR org.trading_name ILIKE ${pattern}
      ORDER BY org.name, fa.financial_account_id
      LIMIT ${limit + 1}
    `);
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
