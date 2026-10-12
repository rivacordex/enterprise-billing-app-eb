import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  expectNotOnboarded,
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// cm18-spec §3.6 — onboarding writes ref_bill_template_version_id = NULL on
// the new BAN and records it in ACCOUNTS_ONBOARDED.afterData; a non-NULL id is
// refused before any write (Inv. #18, D13). Same fresh-migrate setup as
// v07-onboarding-atomicity.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "cm18 onboarding invoice template binding (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;

    async function onboard(
      orgName: string,
      billTemplateVersionId: string | null,
    ) {
      const pr = await seedInitializedCustomer(db, orgName);
      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: db.cycleId,
          currency: "MYR",
          billTemplateVersionId,
          statusReason: "cm18 template binding test",
          lastModifiedDatetime: pr.ts,
        },
        db.appuserId,
      );
      return { pr, result };
    }

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "cm18");
    }, 60_000);

    afterAll(async () => {
      await tearDownOnboardingDatabase(db.sql);
    });

    it("onboarding leaves the BAN with ref_bill_template_version_id IS NULL and records it in the audit", async () => {
      const { result } = await onboard("cm18 Org A", null);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [ban] = await db.sql<{ ref: string | null }[]>`
        SELECT ref_bill_template_version_id AS ref
        FROM billing.billing_account
        WHERE billing_account_id = ${result.value.billingAccountId}
      `;
      expect(ban).toBeDefined();
      expect(ban?.ref).toBeNull();

      const [audit] = await db.sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data
        FROM core.audit_log
        WHERE event_type = 'ACCOUNTS_ONBOARDED'
          AND target_id = ${result.value.financialAccountId}
      `;
      expect(audit?.after_data).toHaveProperty(
        "refBillTemplateVersionId",
        null,
      );
    });

    it("a non-NULL id leaves the customer INITIALIZED and creates no FA/BAN", async () => {
      const { pr, result } = await onboard("cm18 Org B", "BTV00000002");
      expect(result).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });

      await expectNotOnboarded(db.sql, pr.id);
    });
  },
);
