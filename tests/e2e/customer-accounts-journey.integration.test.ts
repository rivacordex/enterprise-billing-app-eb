import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type { getCustomerAccountsSummary as GetCustomerAccountsSummary } from "@/services/accounts/get-customer-accounts-summary";
import type { listCustomerBillingAccounts as ListCustomerBillingAccounts } from "@/services/accounts/list-customer-billing-accounts";
import type { onboardCustomerAccounts as OnboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import type { setBillingAccountTemplate as SetBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import {
  type OnboardingDatabase,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";

const databaseUrl = process.env.DATABASE_URL;

// cm22-spec §3.2 — the Invoice Template Binding update end to end, at the
// service level: create → not onboarded → onboard (NULL template) → Accounts
// tab summary and label → Manage Customer panel row → no-op reset → reset of
// a Phase-3-style non-NULL value → non-NULL refused. Calls services, not
// actions: `requirePermission` needs a real session this suite doesn't build,
// and the action guards are covered by the cm18/cm21 action tests (same
// boundary as customer-core-flow.integration.test.ts). Services are imported
// dynamically after migrate, as in that suite. Fresh-migrate setup via the
// shared onboarding fixture (appuser + active monthly bill cycle), plus the
// `customer` config row createCustomer reads.
describe.skipIf(!databaseUrl)(
  "customer accounts journey: onboard → accounts summary → template label → reset (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;
    let createCustomer: typeof CreateCustomer;
    let getCustomerAccountsSummary: typeof GetCustomerAccountsSummary;
    let listCustomerBillingAccounts: typeof ListCustomerBillingAccounts;
    let onboardCustomerAccounts: typeof OnboardCustomerAccounts;
    let setBillingAccountTemplate: typeof SetBillingAccountTemplate;

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "cm22");

      await db.sql`
        INSERT INTO core.system_config (config_group, config_key, config_value, description, is_secret, status)
        VALUES ('customer', 'CUSTOMER_SEARCH_RESULT_LIMIT', '5', 'cm22 journey', false, 'ACTIVE')
      `;

      ({ createCustomer } =
        await import("@/services/customer/create-customer"));
      ({ getCustomerAccountsSummary } =
        await import("@/services/accounts/get-customer-accounts-summary"));
      ({ listCustomerBillingAccounts } =
        await import("@/services/accounts/list-customer-billing-accounts"));
      ({ onboardCustomerAccounts } =
        await import("@/services/accounts/onboard-customer-accounts"));
      ({ setBillingAccountTemplate } =
        await import("@/services/accounts/set-billing-account-template"));
    }, 60_000);

    afterAll(async () => {
      if (db) await tearDownOnboardingDatabase(db.sql);
    }, 60_000);

    async function templateAuditCount(banId: string): Promise<number> {
      const [row] = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM core.audit_log
        WHERE event_type = 'BILLING_ACCOUNT_TEMPLATE_CHANGED'
          AND target_id = ${banId}
      `;
      return Number(row?.count);
    }

    async function banRow(banId: string) {
      const [row] = await db.sql<{ ref: string | null; lastModified: Date }[]>`
        SELECT ref_bill_template_version_id AS ref,
               last_modified AS "lastModified"
        FROM billing.billing_account WHERE billing_account_id = ${banId}
      `;
      if (!row) throw new Error(`billing_account ${banId} not found`);
      return row;
    }

    async function partyRoleRow(partyRoleId: string) {
      const [row] = await db.sql<{ status: string; ts: Date }[]>`
        SELECT status, last_modified_datetime AS ts
        FROM customer.party_role WHERE party_role_id = ${partyRoleId}
      `;
      if (!row) throw new Error(`party_role ${partyRoleId} not found`);
      return row;
    }

    it("chains onboarding, the Accounts tab, the template label and the reset, end to end", async () => {
      // 1. Create → organization REGISTERED, customer INITIALIZED.
      const created = await createCustomer(
        {
          name: `Journey Holdings ${randomUUID()}`,
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-CM22-${randomUUID()}`,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        db.appuserId,
      );
      if (!created.ok)
        throw new Error(`createCustomer failed: ${created.code}`);
      const { partyRoleId, organizationId } = created.value;

      const [org] = await db.sql<{ status: string }[]>`
        SELECT status FROM customer.organization
        WHERE organization_id = ${organizationId}
      `;
      expect(org?.status).toBe("REGISTERED");
      const initialized = await partyRoleRow(partyRoleId);
      expect(initialized.status).toBe("INITIALIZED");

      // 2. Accounts tab before onboarding.
      await expect(getCustomerAccountsSummary(partyRoleId, 1)).resolves.toEqual(
        { kind: "notOnboarded" },
      );

      // 3. Onboard with "Follow active template" (NULL).
      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId,
          billCycleId: db.cycleId,
          currency: "MYR",
          billTemplateVersionId: null,
          statusReason: "cm22 journey onboarding",
          lastModifiedDatetime: initialized.ts,
        },
        db.appuserId,
      );
      if (!onboarded.ok) {
        throw new Error(`onboarding failed: ${onboarded.code}`);
      }
      const { financialAccountId, billingAccountId: banId } = onboarded.value;

      expect((await banRow(banId)).ref).toBeNull();
      const afterOnboarding = await partyRoleRow(partyRoleId);
      expect(afterOnboarding.status).toBe("VALIDATED");
      const [onboardAudit] = await db.sql<
        { afterData: Record<string, unknown> }[]
      >`
        SELECT after_data AS "afterData" FROM core.audit_log
        WHERE event_type = 'ACCOUNTS_ONBOARDED'
          AND target_id = ${financialAccountId}
      `;
      expect(onboardAudit?.afterData).toHaveProperty(
        "refBillTemplateVersionId",
        null,
      );

      // 4. Accounts tab after onboarding: one FA, one BAN, live label, no docs.
      const summary = await getCustomerAccountsSummary(partyRoleId, 1);
      if (summary.kind !== "onboarded") throw new Error("expected onboarded");
      expect(summary.financialAccounts).toHaveLength(1);
      const [fa] = summary.financialAccounts;
      expect(fa?.financialAccountId).toBe(financialAccountId);
      expect(fa?.bans).toHaveLength(1);
      expect(fa?.bans[0]).toMatchObject({
        billingAccountId: banId,
        templateLabel:
          "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
      });
      expect(fa?.documents.total).toBe(0);

      // 5. Manage Customer panel row: NULL reference (reset disabled).
      const panel = await listCustomerBillingAccounts(partyRoleId);
      if (!panel.onboarded) throw new Error("expected onboarded");
      expect(panel.bans).toHaveLength(1);
      const [panelBan] = panel.bans;
      expect(panelBan).toMatchObject({
        billingAccountId: banId,
        refBillTemplateVersionId: null,
      });

      // 6. Resetting an already-NULL reference is a no-op: no write, no audit.
      const noop = await setBillingAccountTemplate(
        {
          partyRoleId,
          billingAccountId: banId,
          billTemplateVersionId: null,
          lastModified: panelBan!.lastModified,
        },
        db.appuserId,
      );
      expect(noop).toMatchObject({ ok: true, value: { changed: false } });
      expect(await templateAuditCount(banId)).toBe(0);

      // 7. A Phase-3-style non-NULL value (raw SQL; v1 can't write one) is
      //    labelled honestly, then reset to NULL with one audit row and
      //    party_role untouched (Inv. #17).
      const [phase3] = await db.sql<{ lastModified: Date }[]>`
        UPDATE billing.billing_account
        SET ref_bill_template_version_id = 'BTV00000002', last_modified = now()
        WHERE billing_account_id = ${banId}
        RETURNING last_modified AS "lastModified"
      `;
      const phase3Summary = await getCustomerAccountsSummary(partyRoleId, 1);
      if (phase3Summary.kind !== "onboarded") {
        throw new Error("expected onboarded");
      }
      expect(phase3Summary.financialAccounts[0]?.bans[0]?.templateLabel).toBe(
        "Template reference not supported yet",
      );

      const reset = await setBillingAccountTemplate(
        {
          partyRoleId,
          billingAccountId: banId,
          billTemplateVersionId: null,
          lastModified: phase3!.lastModified,
        },
        db.appuserId,
      );
      expect(reset).toMatchObject({ ok: true, value: { changed: true } });
      expect(await templateAuditCount(banId)).toBe(1);
      const afterReset = await banRow(banId);
      expect(afterReset.ref).toBeNull();
      expect((await partyRoleRow(partyRoleId)).ts.getTime()).toBe(
        afterOnboarding.ts.getTime(),
      );

      // 8. A non-NULL id is refused (v1 NULL-only, D13) and writes nothing.
      const refused = await setBillingAccountTemplate(
        {
          partyRoleId,
          billingAccountId: banId,
          billTemplateVersionId: "BTV00000002",
          lastModified: afterReset.lastModified,
        },
        db.appuserId,
      );
      expect(refused).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });
      const afterRefusal = await banRow(banId);
      expect(afterRefusal.ref).toBeNull();
      expect(afterRefusal.lastModified.getTime()).toBe(
        afterReset.lastModified.getTime(),
      );
      expect(await templateAuditCount(banId)).toBe(1);
    });
  },
);
