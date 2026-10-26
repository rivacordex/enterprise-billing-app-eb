import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// cm18-spec §3.6 / cm23-spec §3.7 (D7) — onboarding writes
// ref_bill_template_family_id = NULL (Standard) on the new BAN and records it
// in ACCOUNTS_ONBOARDED.afterData, whether `templateTypeId` is sent as null or
// omitted. A type id never reaches the service: the schema admits only null
// (tests/validation/onboard-customer-accounts.schema.test.ts). Same
// fresh-migrate setup as v07-onboarding-atomicity.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "cm18/cm23 onboarding invoice template type (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;

    async function onboard(orgName: string, sendNull: boolean) {
      const pr = await seedInitializedCustomer(db, orgName);
      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: db.cycleId,
          currency: "MYR",
          ...(sendNull ? { templateTypeId: null } : {}),
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

    it.each([
      { sendNull: true, org: "cm23 Org A" },
      { sendNull: false, org: "cm23 Org B" },
    ])(
      "onboarding (templateTypeId sent as null: $sendNull) leaves the BAN with ref_bill_template_family_id IS NULL and records it in the audit",
      async ({ sendNull, org }) => {
        const { result } = await onboard(org, sendNull);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const [ban] = await db.sql<{ ref: string | null }[]>`
          SELECT ref_bill_template_family_id AS ref
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
          "refBillTemplateFamilyId",
          null,
        );
        expect(audit?.after_data).not.toHaveProperty(
          "refBillTemplateVersionId",
        );
      },
    );
  },
);
