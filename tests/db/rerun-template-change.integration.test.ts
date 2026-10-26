import { beforeAll, describe, expect, it, vi } from "vitest";

// bm84-spec §6 (Inv #52, #66) — the rerun's template-type warning on a real
// database and a real Azurite (the bm77–bm79 harness). Wholesale is created,
// uploaded and activated through the real services; BAN A is bound to it
// through cm23's `setBillingAccountTemplate`, BAN B stays NULL (Standard). A
// run is triggered (A stamped Wholesale, B Standard), then Wholesale is
// retired to Standard through bm83: the warning lists exactly BAN A; a rerun
// of A re-stamps it to Standard and its draft renders on Standard; the warning
// is then empty.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount, financialAccount } from "@/db/schema/billing/accounts";
import { billCycle } from "@/db/schema/billing/catalogs";
import { organization, partyRole } from "@/db/schema/customer";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { retireTemplateType } from "@/services/billing/invoice-template/template-types";
import { listRerunTemplateChanges } from "@/services/billing/read/list-rerun-template-changes";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { rerunRun } from "@/services/billing/rerun-run";
import { triggerRun } from "@/services/billing/trigger-run";
import { registerTemplateTypeDb } from "@/tests/db/helpers/template-type-db-harness";
import { cleanRender } from "@/tests/helpers/layout-package";

const ACTOR = "bm84-actor";
const STANDARD = "BTF00000001";
const CURRENCY = "MYR";
const BLOB_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "generated/INVOICE/WHOLESALE/",
];

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm84 rerun template-type warning (requires DATABASE_URL + Azurite)",
  () => {
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: { id: ACTOR, name: "Rerun Manager", email: "rerun@example.com" },
      blobPrefixes: BLOB_PREFIXES,
      holder: hoisted.holder,
    });

    let wholesaleId: string;
    let standardName: string;
    let standardCurrent: string;
    let banA: string;
    let banB: string;
    let runId: string;

    async function newBan(cycleId: string): Promise<string> {
      const [org] = await h.db
        .insert(organization)
        .values({
          name: "BM84VERIFY-Customer",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await h.db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await h.db
        .insert(financialAccount)
        .values({
          name: "BM84VERIFY-FA",
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: ACTOR,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await h.db
        .insert(billingAccount)
        .values({
          name: "BM84VERIFY-BAN",
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: ACTOR,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function stamp(banId: string) {
      const [row] = await h.sql<
        {
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
        }[]
      >`
        SELECT ref_bill_template_family_id, ref_bill_template_version_id
        FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
      return row!;
    }

    // The processor would have produced a trial bill; insert one so the draft
    // can render (the run-template-capture fixture shape).
    async function trialBill(banId: string): Promise<void> {
      await h.sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        const [cb] = await tx<{ customer_bill_id: string }[]>`
          INSERT INTO billing.customer_bill
            (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
             billing_period_start, billing_period_end, subtotal, tax_total, total_amount,
             payment_due_date)
          VALUES (${runId}, ${banId}, '2026-06-01', 'trial', 'new',
                  '2026-06-01', '2026-06-30', '150.00', '0.00', '150.00', '2026-07-15')
          RETURNING customer_bill_id`;
        await tx`
          INSERT INTO billing.customer_bill_line
            (ref_customer_bill_id, period_partition, line_no, source, ref_product_offering_id,
             gross_amount, discount_amount, net_amount, grouping_key, currency, description,
             quantity, unit)
          VALUES (${cb!.customer_bill_id}, '2026-06-01', 1, 'RECURRING', 'POF-BM84',
                  '150.00', '0.00', '150.00', 'POF-BM84', 'MYR', 'BM84 Fibre',
                  '1.000000', 'EA')`;
      });
    }

    beforeAll(async () => {
      // Wholesale: created, layout v1 uploaded, settings v1 activated.
      wholesaleId = await h.createTypeWithLayout("Wholesale");
      const draft = await h.settingsDraft(wholesaleId);
      const activated = await activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: "Wholesale v1",
          familyId: wholesaleId,
        },
        ACTOR,
        { render: cleanRender() },
      );
      if (!activated.ok) throw new Error(`activate failed: ${activated.code}`);

      const [std] = await h.sql<
        { name: string; bill_template_version_id: string }[]
      >`
        SELECT f.name, v.bill_template_version_id
        FROM billing.bill_template_family f
        JOIN billing.bill_template_version v
          ON v.ref_bill_template_family_id = f.bill_template_family_id
        WHERE f.is_default AND v.kind = 'generated' AND v.status = 'ACTIVE'
        ORDER BY v.is_default LIMIT 1`;
      standardName = std!.name;
      standardCurrent = std!.bill_template_version_id;

      const [cycle] = await h.db
        .insert(billCycle)
        .values({ name: "BM84VERIFY Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      banA = await newBan(cycle!.billCycleId);
      banB = await newBan(cycle!.billCycleId);
      const [row] = await h.sql<
        { ref_party_role_id: string; last_modified: string }[]
      >`
        SELECT ref_party_role_id, last_modified FROM billing.billing_account
        WHERE billing_account_id = ${banA}`;
      const bound = await setBillingAccountTemplate(
        {
          partyRoleId: row!.ref_party_role_id,
          billingAccountId: banA,
          typeId: wholesaleId,
          lastModified: new Date(row!.last_modified),
        },
        ACTOR,
      );
      expect(bound).toMatchObject({ ok: true, value: { changed: true } });

      const [run] = await h.db
        .insert(billRun)
        .values({
          refBillCycleId: cycle!.billCycleId,
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          scheduledRunDate: "2026-07-01",
          status: "SCHEDULED",
          runType: "onCycle",
        })
        .returning({ billRunId: billRun.billRunId });
      runId = run!.billRunId;
    }, 180_000);

    it("1. the run stamps A with Wholesale and B with Standard", async () => {
      expect((await triggerRun(runId, ACTOR, "2026-07-01")).ok).toBe(true);
      expect((await stamp(banA)).ref_bill_template_family_id).toBe(wholesaleId);
      expect((await stamp(banB)).ref_bill_template_family_id).toBe(STANDARD);
    }, 60_000);

    it("2–3. after Wholesale is retired to Standard, the warning lists exactly BAN A: Wholesale → Standard", async () => {
      expect(
        await retireTemplateType(
          { typeId: wholesaleId, targetTypeId: null, confirmName: "Wholesale" },
          ACTOR,
        ),
      ).toEqual({ ok: true, movedBanCount: 1 });

      expect(await listRerunTemplateChanges(runId, [])).toEqual([
        {
          billingAccountId: banA,
          fromTypeName: "Wholesale",
          toTypeName: standardName,
        },
      ]);
      // Outside the selection, BAN A is not listed.
      expect(await listRerunTemplateChanges(runId, [banB])).toEqual([]);
    }, 60_000);

    it("4–5. a rerun of BAN A re-stamps it to Standard, its draft renders on Standard, and the warning is then empty", async () => {
      // Pre-approval: the processor would have driven the run to PROCESSED.
      await h.sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${runId}`;
      await h.sql`UPDATE billing.bill_run_account SET status = 'PROCESSED' WHERE ref_bill_run_id = ${runId}`;

      const rerun = await rerunRun(
        {
          billRunId: runId,
          accountIds: [banA],
          fromStage: "validation",
          reason: "bm84 type changed",
        },
        ACTOR,
      );
      expect(rerun).toMatchObject({ ok: true, value: { accountCount: 1 } });
      expect(await stamp(banA)).toEqual({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id: standardCurrent,
      });

      await trialBill(banA);
      const draft = await buildInvoiceHtml({
        runId,
        banId: banA,
        mode: "draft",
      });
      expect(draft.resolved.generated.billTemplateVersionId).toBe(
        standardCurrent,
      );
      expect(draft.resolved.layout.layoutCode).toBe("INVTPL-STD-A4");

      expect(await listRerunTemplateChanges(runId, [])).toEqual([]);
    }, 120_000);
  },
);
