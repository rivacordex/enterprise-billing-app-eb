import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";

// cm21-spec §3.9 — the template reset on a real transaction: a BAN pointed at
// BTV00000002 by raw SQL (v1 can't write a non-NULL value through the app)
// resets to NULL with last_edited_by / last_modified / one audit row; a
// replay with the stale token is a CONFLICT; party_role is never touched
// (Inv. #17); a closed BAN is refused. Same fresh-migrate setup as cm18.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "cm21 billing account template reset (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;
    let resetActorId: string;

    // Onboards a customer, then points its BAN at BTV00000002 by raw SQL.
    async function onboardedBanWithTemplate(orgName: string) {
      const pr = await seedInitializedCustomer(db, orgName);
      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: db.cycleId,
          currency: "MYR",
          billTemplateVersionId: null,
          statusReason: "cm21 template reset test",
          lastModifiedDatetime: pr.ts,
        },
        db.appuserId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      const banId = onboarded.value.billingAccountId;

      const [ban] = await db.sql<{ lastModified: Date }[]>`
        UPDATE billing.billing_account
        SET ref_bill_template_version_id = 'BTV00000002',
            last_modified = now() - interval '1 minute'
        WHERE billing_account_id = ${banId}
        RETURNING last_modified AS "lastModified"
      `;
      if (!ban) throw new Error("BAN fixture update returned no row");

      const [party] = await db.sql<{ ts: Date }[]>`
        SELECT last_modified_datetime AS ts
        FROM customer.party_role WHERE party_role_id = ${pr.id}
      `;
      return {
        partyRoleId: pr.id,
        banId,
        lastModified: ban.lastModified,
        partyRoleTs: party!.ts,
      };
    }

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "cm21");
      const [actor] = await db.sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-cm21-reset', 'cm21 Reset User', 'cm21-reset@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      resetActorId = actor!.id;
    }, 60_000);

    afterAll(async () => {
      if (db) await tearDownOnboardingDatabase(db.sql);
    }, 60_000);

    it("resets a non-NULL reference to NULL with actor, bumped lock and one audit row; a stale replay conflicts; party_role untouched", async () => {
      const fx = await onboardedBanWithTemplate("cm21 Org A");
      const input = {
        partyRoleId: fx.partyRoleId,
        billingAccountId: fx.banId,
        billTemplateVersionId: null,
        lastModified: fx.lastModified,
      };

      const result = await setBillingAccountTemplate(input, resetActorId);
      expect(result).toMatchObject({
        ok: true,
        value: { billingAccountId: fx.banId, changed: true },
      });

      const [ban] = await db.sql<
        { ref: string | null; editedBy: string; lastModified: Date }[]
      >`
        SELECT ref_bill_template_version_id AS ref,
               last_edited_by AS "editedBy",
               last_modified AS "lastModified"
        FROM billing.billing_account WHERE billing_account_id = ${fx.banId}
      `;
      expect(ban?.ref).toBeNull();
      expect(ban?.editedBy).toBe(resetActorId);
      expect(ban!.lastModified.getTime()).toBeGreaterThan(
        fx.lastModified.getTime(),
      );
      if (result.ok) {
        expect(result.value.lastModified.getTime()).toBe(
          ban!.lastModified.getTime(),
        );
      }

      const audits = await db.sql<
        {
          actor: string;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        }[]
      >`
        SELECT actor_user_id AS actor, before_data AS before, after_data AS after
        FROM core.audit_log
        WHERE event_type = 'BILLING_ACCOUNT_TEMPLATE_CHANGED'
          AND target_entity = 'BILLING_ACCOUNT'
          AND target_id = ${fx.banId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toEqual({
        actor: resetActorId,
        before: { refBillTemplateVersionId: "BTV00000002" },
        after: { refBillTemplateVersionId: null },
      });

      const replay = await setBillingAccountTemplate(input, resetActorId);
      expect(replay).toEqual({ ok: false, code: "CONFLICT" });

      const [party] = await db.sql<{ ts: Date }[]>`
        SELECT last_modified_datetime AS ts
        FROM customer.party_role WHERE party_role_id = ${fx.partyRoleId}
      `;
      expect(party!.ts.getTime()).toBe(fx.partyRoleTs.getTime());
    });

    it("a closed BAN → BAN_CLOSED and nothing written", async () => {
      const fx = await onboardedBanWithTemplate("cm21 Org B");
      const [closed] = await db.sql<{ lastModified: Date }[]>`
        UPDATE billing.billing_account SET state = 'closed'
        WHERE billing_account_id = ${fx.banId}
        RETURNING last_modified AS "lastModified"
      `;

      const result = await setBillingAccountTemplate(
        {
          partyRoleId: fx.partyRoleId,
          billingAccountId: fx.banId,
          billTemplateVersionId: null,
          lastModified: closed!.lastModified,
        },
        resetActorId,
      );
      expect(result).toEqual({ ok: false, code: "BAN_CLOSED" });

      const [ban] = await db.sql<{ ref: string | null }[]>`
        SELECT ref_bill_template_version_id AS ref
        FROM billing.billing_account WHERE billing_account_id = ${fx.banId}
      `;
      expect(ban?.ref).toBe("BTV00000002");
    });
  },
);
