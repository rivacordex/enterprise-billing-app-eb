import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import {
  insertTemplateType,
  retireTemplateType,
} from "@/tests/helpers/bindable-template-type";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";

// cm21-spec §3.9 / cm23-spec §3.12 (CM guardrail 12) — the type bind on a real
// transaction. Fixtures create, through raw SQL, a usable type (family + ACTIVE
// settings row), a retired one and a not-yet-usable one (layout only). Binding
// NULL → usable → NULL is one update, one audit row with type names and a
// bumped last_modified each time, with party_role untouched (Inv. #17);
// Standard's id, an unknown id, the retired and the not-yet-usable type are
// TEMPLATE_NOT_BINDABLE and write nothing; a stale replay is a CONFLICT; a
// closed BAN is refused. Same fresh-migrate setup as cm18.
const databaseUrl = process.env.DATABASE_URL;

const STANDARD = "BTF00000001";
const WHOLESALE = "BTF00000101";
const RETIRED = "BTF00000102";
const NOT_YET_USABLE = "BTF00000103";

describe.skipIf(!databaseUrl)(
  "cm23 billing account template type bind (requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;
    let actorId: string;

    // Onboards a customer (its BAN starts NULL) and backdates the BAN's lock.
    async function onboardedBan(orgName: string) {
      const pr = await seedInitializedCustomer(db, orgName);
      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: db.cycleId,
          currency: "MYR",
          templateTypeId: null,
          statusReason: "cm23 template bind test",
          lastModifiedDatetime: pr.ts,
        },
        db.appuserId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      const banId = onboarded.value.billingAccountId;

      const [ban] = await db.sql<{ lastModified: Date }[]>`
        UPDATE billing.billing_account
        SET last_modified = now() - interval '1 minute'
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

    async function banRow(banId: string) {
      const [row] = await db.sql<
        { ref: string | null; editedBy: string; lastModified: Date }[]
      >`
        SELECT ref_bill_template_family_id AS ref,
               last_edited_by AS "editedBy",
               last_modified AS "lastModified"
        FROM billing.billing_account WHERE billing_account_id = ${banId}
      `;
      if (!row) throw new Error(`billing_account ${banId} not found`);
      return row;
    }

    async function auditRows(banId: string) {
      return db.sql<
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
          AND target_id = ${banId}
        ORDER BY created_datetime, audit_id
      `;
    }

    async function partyRoleTs(partyRoleId: string): Promise<number> {
      const [party] = await db.sql<{ ts: Date }[]>`
        SELECT last_modified_datetime AS ts
        FROM customer.party_role WHERE party_role_id = ${partyRoleId}
      `;
      return party!.ts.getTime();
    }

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "cm23");
      const [actor] = await db.sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-cm23-bind', 'cm23 Bind User', 'cm23-bind@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      actorId = actor!.id;

      await insertTemplateType(db.sql, {
        typeId: WHOLESALE,
        code: "WHOLESALE",
        name: "Wholesale",
        versionSeed: 101,
        withActiveSettings: true,
      });
      await insertTemplateType(db.sql, {
        typeId: RETIRED,
        code: "RETIREDTYPE",
        name: "Retired Type",
        versionSeed: 102,
        withActiveSettings: true,
      });
      await retireTemplateType(db.sql, RETIRED);
      await insertTemplateType(db.sql, {
        typeId: NOT_YET_USABLE,
        code: "PENDING",
        name: "Pending Type",
        versionSeed: 103,
        withActiveSettings: false,
      });
    }, 60_000);

    afterAll(async () => {
      if (db) await tearDownOnboardingDatabase(db.sql);
    }, 60_000);

    it("binds NULL → Wholesale → NULL: one update, one audit row with type names and a bumped lock each; a stale replay conflicts; party_role untouched", async () => {
      const fx = await onboardedBan("cm23 Org A");

      // NULL → NULL is unchanged: no write, no audit.
      const noop = await setBillingAccountTemplate(
        {
          partyRoleId: fx.partyRoleId,
          billingAccountId: fx.banId,
          typeId: null,
          lastModified: fx.lastModified,
        },
        actorId,
      );
      expect(noop).toMatchObject({ ok: true, value: { changed: false } });
      expect(await auditRows(fx.banId)).toHaveLength(0);
      expect((await banRow(fx.banId)).lastModified.getTime()).toBe(
        fx.lastModified.getTime(),
      );

      // NULL → Wholesale.
      const toWholesale = {
        partyRoleId: fx.partyRoleId,
        billingAccountId: fx.banId,
        typeId: WHOLESALE,
        lastModified: fx.lastModified,
      };
      const bound = await setBillingAccountTemplate(toWholesale, actorId);
      expect(bound).toMatchObject({
        ok: true,
        value: { billingAccountId: fx.banId, changed: true },
      });
      const afterBind = await banRow(fx.banId);
      expect(afterBind.ref).toBe(WHOLESALE);
      expect(afterBind.editedBy).toBe(actorId);
      expect(afterBind.lastModified.getTime()).toBeGreaterThan(
        fx.lastModified.getTime(),
      );
      if (bound.ok) {
        expect(bound.value.lastModified.getTime()).toBe(
          afterBind.lastModified.getTime(),
        );
      }
      expect(await auditRows(fx.banId)).toEqual([
        {
          actor: actorId,
          before: {
            refBillTemplateFamilyId: null,
            typeName: "Standard (default)",
          },
          after: { refBillTemplateFamilyId: WHOLESALE, typeName: "Wholesale" },
        },
      ]);

      // A replay with the stale token is a CONFLICT and writes nothing.
      const replay = await setBillingAccountTemplate(toWholesale, actorId);
      expect(replay).toEqual({ ok: false, code: "CONFLICT" });
      expect(await auditRows(fx.banId)).toHaveLength(1);

      // Wholesale → NULL (Standard).
      const back = await setBillingAccountTemplate(
        {
          partyRoleId: fx.partyRoleId,
          billingAccountId: fx.banId,
          typeId: null,
          lastModified: afterBind.lastModified,
        },
        actorId,
      );
      expect(back).toMatchObject({ ok: true, value: { changed: true } });
      const afterBack = await banRow(fx.banId);
      expect(afterBack.ref).toBeNull();
      expect(afterBack.lastModified.getTime()).toBeGreaterThan(
        afterBind.lastModified.getTime(),
      );
      const audits = await auditRows(fx.banId);
      expect(audits).toHaveLength(2);
      expect(audits[1]).toEqual({
        actor: actorId,
        before: { refBillTemplateFamilyId: WHOLESALE, typeName: "Wholesale" },
        after: {
          refBillTemplateFamilyId: null,
          typeName: "Standard (default)",
        },
      });

      expect(await partyRoleTs(fx.partyRoleId)).toBe(fx.partyRoleTs.getTime());
    });

    it.each([
      { label: "Standard's explicit id", typeId: STANDARD },
      { label: "an unknown id", typeId: "BTF99999999" },
      { label: "a retired type", typeId: RETIRED },
      { label: "a not-yet-usable type", typeId: NOT_YET_USABLE },
    ])(
      "$label → TEMPLATE_NOT_BINDABLE, no write, no audit",
      async ({ typeId }) => {
        const fx = await onboardedBan(`cm23 Org ${typeId}`);
        const result = await setBillingAccountTemplate(
          {
            partyRoleId: fx.partyRoleId,
            billingAccountId: fx.banId,
            typeId,
            lastModified: fx.lastModified,
          },
          actorId,
        );
        expect(result).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });

        const ban = await banRow(fx.banId);
        expect(ban.ref).toBeNull();
        expect(ban.lastModified.getTime()).toBe(fx.lastModified.getTime());
        expect(await auditRows(fx.banId)).toHaveLength(0);
        expect(await partyRoleTs(fx.partyRoleId)).toBe(
          fx.partyRoleTs.getTime(),
        );
      },
    );

    it("a closed BAN → BAN_CLOSED and nothing written", async () => {
      const fx = await onboardedBan("cm23 Org Closed");
      const [closed] = await db.sql<{ lastModified: Date }[]>`
        UPDATE billing.billing_account SET state = 'closed'
        WHERE billing_account_id = ${fx.banId}
        RETURNING last_modified AS "lastModified"
      `;

      const result = await setBillingAccountTemplate(
        {
          partyRoleId: fx.partyRoleId,
          billingAccountId: fx.banId,
          typeId: WHOLESALE,
          lastModified: closed!.lastModified,
        },
        actorId,
      );
      expect(result).toEqual({ ok: false, code: "BAN_CLOSED" });
      expect((await banRow(fx.banId)).ref).toBeNull();
      expect(await auditRows(fx.banId)).toHaveLength(0);
    });
  },
);
