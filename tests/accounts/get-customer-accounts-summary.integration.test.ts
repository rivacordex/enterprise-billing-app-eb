import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import { db as appDb } from "@/db/client";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { logger } from "@/lib/logger";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getCustomerAccountsSummary } from "@/services/accounts/get-customer-accounts-summary";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// cm20-spec §3.8 — the Accounts tab read service against a real database. One
// onboarded customer (FA + Master BAN via the real onboarding service), plus
// two more BANs on the same FA (one closed), non-zero receivables on two of
// them, three documents and the page-size config key set to 2. Same
// fresh-migrate setup as the cm18 / v07 onboarding tests.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "cm20 customer accounts summary (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;
    let partyRoleId: string;
    let initializedPartyRoleId: string;
    let financialAccountId: string;
    let masterBanId: string;
    let secondBanId: string;
    let closedBanId: string;

    async function addBan(
      name: string,
      state: "active" | "closed",
    ): Promise<{ banId: string; receivablesId: string }> {
      const [ban] = await db.sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, state, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES (${name}, ${state}, ${partyRoleId}, ${financialAccountId}, 'MYR', ${db.cycleId}, ${db.appuserId})
        RETURNING billing_account_id AS id
      `;
      if (!ban) throw new Error("billing_account insert returned no row");
      const [rec] = await db.sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account(${`ban.${ban.id}.receivables`}, 'MYR')
      `;
      if (!rec) throw new Error("pgledger_create_account returned no row");
      await db.sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('billing_account', ${ban.id}, 'receivables', ${rec.id}, ${db.appuserId})
      `;
      return { banId: ban.id, receivablesId: rec.id };
    }

    async function receivablesOf(banId: string): Promise<string> {
      const [row] = await db.sql<{ id: string }[]>`
        SELECT pgledger_account_id AS id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${banId}
          AND ledger_role = 'receivables'
      `;
      if (!row) throw new Error(`no receivables binding for ${banId}`);
      return row.id;
    }

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "cm20");

      const pr = await seedInitializedCustomer(db, "cm20 Onboarded Org");
      partyRoleId = pr.id;
      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: db.cycleId,
          currency: "MYR",
          statusReason: "cm20 accounts summary test",
          lastModifiedDatetime: pr.ts,
        },
        db.appuserId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
      masterBanId = result.value.billingAccountId;

      const second = await addBan("Second Billing Account", "active");
      secondBanId = second.banId;
      closedBanId = (await addBan("Closed Billing Account", "closed")).banId;

      const [revenue] = await db.sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
      `;
      if (!revenue) throw new Error("sys.revenue account not created");
      await db.sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${revenue.id}, ${await receivablesOf(masterBanId)},
          500.00::numeric, NOW(), '{"doc": "cm20-test-1"}'::jsonb)
      `;
      await db.sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${revenue.id}, ${second.receivablesId},
          125.50::numeric, NOW(), '{"doc": "cm20-test-2"}'::jsonb)
      `;

      await db.sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, last_edited_by)
        VALUES ('CM20_TEST', 'DBN', 'revenue', ${db.appuserId})
      `;
      for (let i = 0; i < 3; i++) {
        await db.sql`
          INSERT INTO billing.document
            (document_id, doc_type, ref_financial_account_id, ref_billing_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
          VALUES (
            'DBN' || lpad(nextval('billing.document_dbn_seq')::text, 8, '0'),
            'DBN', ${financialAccountId}, ${masterBanId}, 'CM20_TEST', 'MYR', '10.00', 'ref',
            now() - make_interval(mins => ${i}), ${db.appuserId}, ${db.appuserId})
        `;
      }

      await db.sql`
        INSERT INTO core.system_config (config_group, config_key, config_value, description, is_secret, status)
        VALUES ('customer', 'CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE', '2', 'cm20 test', false, 'ACTIVE')
      `;

      initializedPartyRoleId = (
        await seedInitializedCustomer(db, "cm20 Initialized Org")
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (db) await tearDownOnboardingDatabase(db.sql);
    }, 60_000);

    it("an INITIALIZED customer is not onboarded", async () => {
      await expect(
        getCustomerAccountsSummary(initializedPartyRoleId, 1),
      ).resolves.toEqual({ kind: "notOnboarded" });
    });

    it("FA and per-BAN balances match getFinancialAccountDetail and getBillingAccountDetail", async () => {
      const summary = await getCustomerAccountsSummary(partyRoleId, 1);
      if (summary.kind !== "onboarded") throw new Error("expected onboarded");
      expect(summary.financialAccounts).toHaveLength(1);
      const [fa] = summary.financialAccounts;
      if (!fa) throw new Error("no FA");

      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(fa.financialAccountId).toBe(financialAccountId);
      expect(fa.receivableBalance).toBe(faDetail!.receivableBalance);
      expect(fa.unappliedCashBalance).toBe(faDetail!.unappliedCashBalance);
      expect(fa.depositBalance).toBe(faDetail!.depositBalance);
      expect(fa.receivableBalance).toBe("625.50");

      for (const ban of fa.bans) {
        const banDetail = await getBillingAccountDetail(ban.billingAccountId);
        expect(ban.receivableBalance, ban.billingAccountId).toBe(
          banDetail!.receivableBalance,
        );
      }
    });

    it("lists all N BANs, including the closed one, with cycle, term and template label", async () => {
      const warn = vi.spyOn(logger, "warn");
      let summary: Awaited<ReturnType<typeof getCustomerAccountsSummary>>;
      try {
        summary = await getCustomerAccountsSummary(partyRoleId, 1);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      if (summary.kind !== "onboarded") throw new Error("expected onboarded");
      const bans = summary.financialAccounts[0]!.bans;

      expect(bans.map((b) => b.billingAccountId)).toEqual(
        [masterBanId, secondBanId, closedBanId].sort(),
      );
      expect(bans.find((b) => b.billingAccountId === closedBanId)?.state).toBe(
        "closed",
      );
      for (const ban of bans) {
        expect(ban.billCycleName).toBe("Monthly – Day 1");
        expect(ban.paymentTermDays).toBe(30);
        // cm23 (D4) — every BAN is NULL (Standard) on the seeded catalog.
        expect(ban.templateLabel).toEqual({
          kind: "STANDARD",
          text: "Standard (default) · v1",
          name: "Standard (default)",
          versionNo: 1,
        });
      }
    });

    it("receivablesByFinancialAccount returns one row per bound BAN in one statement", async () => {
      const execute = vi.spyOn(appDb, "execute");
      try {
        const map = await ledgerRepository.receivablesByFinancialAccount(
          appDb,
          financialAccountId,
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(map.size).toBe(3);
        expect(map.get(masterBanId)).toBe("500.00");
        expect(map.get(secondBanId)).toBe("125.50");
        expect(map.get(closedBanId)).toBe("0.00");
      } finally {
        execute.mockRestore();
      }
    });

    it("pagination honours CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE", async () => {
      const first = await getCustomerAccountsSummary(partyRoleId, 1);
      const second = await getCustomerAccountsSummary(partyRoleId, 2);
      if (first.kind !== "onboarded" || second.kind !== "onboarded") {
        throw new Error("expected onboarded");
      }
      const p1 = first.financialAccounts[0]!.documents;
      const p2 = second.financialAccounts[0]!.documents;

      expect(p1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(p1.rows).toHaveLength(2);
      expect(p2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(p2.rows).toHaveLength(1);
      expect(
        new Set([...p1.rows, ...p2.rows].map((r) => r.documentId)).size,
      ).toBe(3);
    });

    it("an out-of-range page is clamped to the last page", async () => {
      const result = await getCustomerAccountsSummary(partyRoleId, 9);
      if (result.kind !== "onboarded") throw new Error("expected onboarded");
      const docs = result.financialAccounts[0]!.documents;

      expect(docs).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(docs.rows).toHaveLength(1);
    });
  },
);
