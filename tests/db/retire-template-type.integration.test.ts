import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// bm83-spec §8 (Inv #66, #67; guardrails 76 and 77) — retire an invoice
// template type with the bulk switch of its BANs, on a real database and a
// real Azurite (the bm77–bm79 harness). Types are created, uploaded and
// activated through the real services (the Chromium probe is stubbed clean);
// BANs are bound through cm23's `setBillingAccountTemplate`, except the
// 1,201-BAN SQL fixture. Retire is one-way, so each case uses its own types.
// Concurrency runs two `db.transaction` calls on the pooled client: one side
// is held open at an audit insert (a barrier), and the other is released only
// once Postgres reports it waiting on a lock — so every race is deterministic.
// After every case, no BAN references a retired type.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));
// Pass-through spies: the chunk sizes are observed, and a case can hold a
// transaction open (or act inside it) at a given audit insert.
vi.mock("@/db/repositories/audit.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof AuditRepository>();
  return {
    ...actual,
    insertAuditEvent: vi.fn(actual.insertAuditEvent),
    insertAuditEvents: vi.fn(actual.insertAuditEvents),
  };
});

import type { Database } from "@/db/client";
import type * as AuditRepository from "@/db/repositories/audit.repository";
import {
  insertAuditEvent,
  insertAuditEvents,
} from "@/db/repositories/audit.repository";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { billingAccount, financialAccount } from "@/db/schema/billing/accounts";
import { billCycle } from "@/db/schema/billing/catalogs";
import { organization, partyRole } from "@/db/schema/customer";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { discardTemplateDraft } from "@/services/billing/invoice-template/discard-template-draft";
import {
  TemplateTypeRetiredError,
  previewInvoiceTemplate,
} from "@/services/billing/invoice-template/preview";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import {
  deriveTemplateTypeCode,
  retireTemplateType,
} from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { registerTemplateTypeDb } from "@/tests/db/helpers/template-type-db-harness";
import {
  buildLayoutPackage,
  cleanRender,
} from "@/tests/helpers/layout-package";
import type { InvoiceTemplateStructure } from "@/types/billing";

const ACTOR = "bm83-retirer";
const STANDARD = "BTF00000001";
const CURRENCY = "MYR";

// Every type this suite creates; its blobs are removed before and after.
const TYPE_NAMES = [
  "Wholesale",
  "Retail",
  "Pending",
  "Old",
  "Wholesale Two",
  "Bulk",
  "Leaky",
  "Bind First",
  "Retire First",
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Saver",
  "Saver Two",
];
const BLOB_PREFIXES = TYPE_NAMES.flatMap((name) => {
  const code = deriveTemplateTypeCode(name);
  return [`layouts/INVTPL-${code}/`, `generated/INVOICE/${code}/`];
});

const mockAuditEvent = vi.mocked(insertAuditEvent);
const mockAuditEvents = vi.mocked(insertAuditEvents);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm83 retire a template type with a bulk switch (requires DATABASE_URL + Azurite)",
  () => {
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: { id: ACTOR, name: "Type Retirer", email: "retirer@example.com" },
      blobPrefixes: BLOB_PREFIXES,
      holder: hoisted.holder,
    });
    let actual: typeof AuditRepository;
    let cycleId: string;
    let standardName: string;

    beforeAll(async () => {
      actual = await vi.importActual<typeof AuditRepository>(
        "@/db/repositories/audit.repository",
      );
      const [cycle] = await h.db
        .insert(billCycle)
        .values({ name: "BM83 Retire Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
      const [std] = await h.sql<{ name: string }[]>`
        SELECT name FROM billing.bill_template_family WHERE is_default`;
      standardName = std!.name;
    }, 60_000);

    afterEach(async () => {
      mockAuditEvent.mockImplementation(actual.insertAuditEvent);
      mockAuditEvents.mockImplementation(actual.insertAuditEvents);
      // Inv #66 — after every case, no BAN is left on a retired type.
      const [left] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM billing.billing_account ba
        JOIN billing.bill_template_family f
          ON f.bill_template_family_id = ba.ref_bill_template_family_id
        WHERE f.retired_datetime IS NOT NULL`;
      expect(left!.n).toBe(0);
    });

    // ── fixtures ────────────────────────────────────────────────────────

    // A usable type: created, layout v1 uploaded, settings v1 activated.
    async function usableType(name: string): Promise<string> {
      const typeId = await h.createTypeWithLayout(name);
      const draft = await h.settingsDraft(typeId);
      const activated = await activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: `${name} v1`,
          familyId: typeId,
        },
        ACTOR,
        { render: cleanRender() },
      );
      if (!activated.ok) throw new Error(`activate failed: ${activated.code}`);
      return typeId;
    }

    async function newParty(): Promise<{ roleId: string; faId: string }> {
      const [org] = await h.db
        .insert(organization)
        .values({
          name: "BM83VERIFY-Customer",
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
          name: "BM83VERIFY-FA",
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: ACTOR,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      return { roleId: role!.partyRoleId, faId: fa!.financialAccountId };
    }

    // A new BAN on Standard (NULL).
    async function newBan(name = "BM83VERIFY-BAN"): Promise<string> {
      const { roleId, faId } = await newParty();
      const [ban] = await h.db
        .insert(billingAccount)
        .values({
          name,
          state: "active",
          refPartyRoleId: roleId,
          refFinancialAccountId: faId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: ACTOR,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function banRow(banId: string) {
      const [row] = await h.sql<
        {
          ref_party_role_id: string;
          ref_bill_template_family_id: string | null;
          last_modified: Date;
          last_edited_by: string;
          state: string;
        }[]
      >`
        SELECT ref_party_role_id, ref_bill_template_family_id, last_modified,
               last_edited_by, state
        FROM billing.billing_account WHERE billing_account_id = ${banId}`;
      return row!;
    }

    function bind(banId: string, typeId: string | null) {
      return banRow(banId).then((row) =>
        setBillingAccountTemplate(
          {
            partyRoleId: row.ref_party_role_id,
            billingAccountId: banId,
            typeId,
            lastModified: new Date(row.last_modified),
          },
          ACTOR,
        ),
      );
    }

    async function bindOk(banId: string, typeId: string): Promise<void> {
      expect(await bind(banId, typeId)).toMatchObject({
        ok: true,
        value: { changed: true },
      });
    }

    async function typeName(typeId: string): Promise<string> {
      const [row] = await h.sql<{ name: string }[]>`
        SELECT name FROM billing.bill_template_family
        WHERE bill_template_family_id = ${typeId}`;
      return row!.name;
    }

    async function retire(
      typeId: string,
      targetTypeId: string | null,
      confirmName?: string,
    ) {
      return retireTemplateType(
        {
          typeId,
          targetTypeId,
          confirmName: confirmName ?? (await typeName(typeId)),
        },
        ACTOR,
      );
    }

    async function versionRows(typeId: string) {
      return h.sql`
        SELECT * FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${typeId}
        ORDER BY bill_template_version_id`;
    }

    async function familyRows() {
      return h.sql`
        SELECT * FROM billing.bill_template_family
        ORDER BY bill_template_family_id`;
    }

    async function auditCount(): Promise<number> {
      const [row] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.audit_log`;
      return row!.n;
    }

    async function retireAuditFor(typeId: string) {
      return (await h.auditRows("INVOICE_TEMPLATE_TYPE_RETIRED")).filter(
        (r) => r.target_id === typeId,
      );
    }

    async function switchAuditFrom(typeId: string) {
      return (await h.auditRows("BILLING_ACCOUNT_TEMPLATE_CHANGED")).filter(
        (r) =>
          (r.before_data as { refBillTemplateFamilyId: string | null })
            .refBillTemplateFamilyId === typeId &&
          (r.after_data as { reason?: string }).reason ===
            "TEMPLATE_TYPE_RETIRED",
      );
    }

    // Hold the next `insertAuditEvent` of `eventType` open (inside its
    // transaction) until `release()`.
    function holdAuditEvent(eventType: string): {
      reached: Promise<void>;
      release: () => void;
    } {
      const reached = deferred();
      const release = deferred();
      let armed = true;
      mockAuditEvent.mockImplementation(async (db, event) => {
        if (armed && event.eventType === eventType) {
          armed = false;
          reached.resolve();
          await release.promise;
        }
        return actual.insertAuditEvent(db, event);
      });
      return { reached: reached.promise, release: () => release.resolve() };
    }

    // Resolves once some backend of this database waits on a lock.
    async function lockWaiter(): Promise<void> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await h.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row!.n > 0) return;
        if (Date.now() > deadline) throw new Error("no lock waiter appeared");
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    function structureOf(row: {
      structure: unknown;
    }): InvoiceTemplateStructure {
      return row.structure as InvoiceTemplateStructure;
    }

    // ── guardrail 77 + refusals ─────────────────────────────────────────

    let wholesaleId: string;
    let retailId: string;

    it("refusals write nothing: Standard, a wrong name, an unknown type, and a target that is itself, Standard's id, not yet usable or retired", async () => {
      wholesaleId = await usableType("Wholesale");
      retailId = await usableType("Retail");
      const pendingId = await h.createTypeWithLayout("Pending");
      const oldId = await usableType("Old");
      const banA = await newBan();
      await bindOk(banA, wholesaleId);
      // A retired target: Old, retired to Standard (nothing bound).
      expect(await retire(oldId, null)).toEqual({
        ok: true,
        movedBanCount: 0,
      });

      const families = await familyRows();
      const bans = await h.sql`
        SELECT * FROM billing.billing_account ORDER BY billing_account_id`;
      const audits = await auditCount();

      expect(await retire(STANDARD, null, standardName)).toEqual({
        ok: false,
        code: "DEFAULT_TYPE_NOT_RETIRABLE",
      });
      expect(await retire(oldId, null)).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });
      expect(await retire(wholesaleId, null, "wholesale")).toEqual({
        ok: false,
        code: "RETIRE_NAME_MISMATCH",
      });
      expect(await retire("BTF00009999", null, "Ghost")).toEqual({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      for (const target of [wholesaleId, STANDARD, pendingId, oldId]) {
        expect(await retire(wholesaleId, target), target).toEqual({
          ok: false,
          code: "RETIRE_TARGET_NOT_USABLE",
        });
      }

      expect(await familyRows()).toEqual(families);
      expect(
        await h.sql`
          SELECT * FROM billing.billing_account ORDER BY billing_account_id`,
      ).toEqual(bans);
      expect(await auditCount()).toBe(audits);
    }, 120_000);

    it("retires Wholesale to Standard: open and closed BANs → NULL with a bumped last_modified, one audit per BAN with the reason, one type audit, version rows and party_role untouched", async () => {
      // An open DRAFT pair, which the retire must leave as it is (D6).
      await h.upload(
        wholesaleId,
        `INVTPL-${deriveTemplateTypeCode("Wholesale")}`,
        2,
      );
      const banA = (
        await h.sql<{ billing_account_id: string }[]>`
          SELECT billing_account_id FROM billing.billing_account
          WHERE ref_bill_template_family_id = ${wholesaleId}`
      )[0]!.billing_account_id;
      const banC = await newBan("BM83VERIFY-CLOSED");
      await bindOk(banC, wholesaleId);
      await h.sql`
        UPDATE billing.billing_account SET state = 'closed'
        WHERE billing_account_id = ${banC}`;

      const versionsBefore = await versionRows(wholesaleId);
      expect(versionsBefore.some((v) => v.status === "DRAFT")).toBe(true);
      const before = { a: await banRow(banA), c: await banRow(banC) };
      const rolesBefore = await h.sql`
        SELECT party_role_id, last_modified_datetime FROM customer.party_role
        WHERE party_role_id IN (${before.a.ref_party_role_id}, ${before.c.ref_party_role_id})
        ORDER BY party_role_id`;

      expect(await retire(wholesaleId, null)).toEqual({
        ok: true,
        movedBanCount: 2,
      });

      for (const [banId, prior] of [
        [banA, before.a],
        [banC, before.c],
      ] as const) {
        const after = await banRow(banId);
        expect(after.ref_bill_template_family_id).toBeNull();
        expect(new Date(after.last_modified).getTime()).toBeGreaterThan(
          new Date(prior.last_modified).getTime(),
        );
        expect(after.last_edited_by).toBe(ACTOR);
        expect(after.state).toBe(prior.state);
      }

      const moves = await switchAuditFrom(wholesaleId);
      expect(moves.map((m) => m.target_id).sort()).toEqual([banA, banC].sort());
      for (const m of moves) {
        expect(m.before_data).toEqual({
          refBillTemplateFamilyId: wholesaleId,
          typeName: "Wholesale",
        });
        expect(m.after_data).toEqual({
          refBillTemplateFamilyId: null,
          typeName: "Standard (default)",
          reason: "TEMPLATE_TYPE_RETIRED",
        });
      }

      const typeAudit = await retireAuditFor(wholesaleId);
      expect(typeAudit).toHaveLength(1);
      expect(typeAudit[0]!.before_data).toEqual({
        name: "Wholesale",
        code: "WHOLESALE",
        retiredDatetime: null,
      });
      expect(typeAudit[0]!.after_data).toMatchObject({
        targetTypeId: null,
        targetTypeName: "Standard (default)",
        movedBanCount: 2,
      });

      const [family] = await h.sql<{ retired_datetime: Date | null }[]>`
        SELECT retired_datetime FROM billing.bill_template_family
        WHERE bill_template_family_id = ${wholesaleId}`;
      expect(family!.retired_datetime).not.toBeNull();
      // Raw `sql` returns timestamptz as a string; compare instants.
      expect(
        new Date(
          (typeAudit[0]!.after_data as { retiredDatetime: string })
            .retiredDatetime,
        ).getTime(),
      ).toBe(new Date(family!.retired_datetime!).getTime());

      // Inv #67 — row by row, every version row of the type is unchanged.
      expect(await versionRows(wholesaleId)).toEqual(versionsBefore);
      // CM Inv. #17 — party_role is never touched.
      expect(
        await h.sql`
          SELECT party_role_id, last_modified_datetime FROM customer.party_role
          WHERE party_role_id IN (${before.a.ref_party_role_id}, ${before.c.ref_party_role_id})
          ORDER BY party_role_id`,
      ).toEqual(rolesBefore);
    }, 120_000);

    it("after retire, save, upload, preview (draft or not) and activate return TEMPLATE_TYPE_RETIRED; discard does too and the open DRAFT pair stays unchanged", async () => {
      const versions = await versionRows(wholesaleId);
      const settings = await h.settingsDraft(wholesaleId);
      const layoutDraft = (await billTemplateVersionRepository.findDraft(h.db, {
        kind: "layout",
        familyId: wholesaleId,
      }))!;
      expect(layoutDraft).toBeTruthy();

      expect(
        await saveTemplateDraft(
          {
            structure: structureOf(settings),
            expectedDraftToken: settings.token,
            familyId: wholesaleId,
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "TEMPLATE_TYPE_RETIRED" });

      const upload = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: buildLayoutPackage({
            layoutCode: "INVTPL-WHOLESALE",
            layoutVersion: 2,
          }).zip,
          expectedDraft: {
            versionId: layoutDraft.billTemplateVersionId,
            lastModified: layoutDraft.token,
          },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(upload).toMatchObject({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });

      for (const draft of [false, true]) {
        await expect(
          previewInvoiceTemplate({
            structure: structureOf(settings),
            source: "sample",
            familyId: wholesaleId,
            draft,
          }),
        ).rejects.toBeInstanceOf(TemplateTypeRetiredError);
      }

      expect(
        await activateTemplate(
          {
            draftId: settings.billTemplateVersionId,
            expectedDraftToken: settings.token,
            changeNote: "after retire",
            familyId: wholesaleId,
          },
          ACTOR,
          { render: cleanRender() },
        ),
      ).toMatchObject({ ok: false, code: "TEMPLATE_TYPE_RETIRED" });

      expect(
        await discardTemplateDraft(
          {
            familyId: wholesaleId,
            draftId: settings.billTemplateVersionId,
            expectedDraftToken: settings.token,
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "TEMPLATE_TYPE_RETIRED" });

      expect(await versionRows(wholesaleId)).toEqual(versions);
    }, 120_000);

    it("retires to another usable type: the BANs read its id and the audit names it", async () => {
      const w2 = await usableType("Wholesale Two");
      const ban = await newBan();
      await bindOk(ban, w2);
      expect(await retire(w2, retailId)).toEqual({
        ok: true,
        movedBanCount: 1,
      });
      expect((await banRow(ban)).ref_bill_template_family_id).toBe(retailId);
      const [move] = await switchAuditFrom(w2);
      expect(move!.after_data).toEqual({
        refBillTemplateFamilyId: retailId,
        typeName: "Retail",
        reason: "TEMPLATE_TYPE_RETIRED",
      });
      expect((await retireAuditFor(w2))[0]!.after_data).toMatchObject({
        targetTypeId: retailId,
        targetTypeName: "Retail",
        movedBanCount: 1,
      });
    }, 120_000);

    it("audits 1,201 moved BANs in three multi-row inserts (500/500/201)", async () => {
      const bulkId = await usableType("Bulk");
      const { roleId, faId } = await newParty();
      await h.sql`
        INSERT INTO billing.billing_account
          (name, state, ref_party_role_id, ref_financial_account_id, currency,
           ref_bill_cycle_id, last_edited_by, ref_bill_template_family_id)
        SELECT 'BM83-BULK-' || g, 'active', ${roleId}, ${faId}, ${CURRENCY},
               ${cycleId}, ${ACTOR}, ${bulkId}
        FROM generate_series(1, 1201) g`;
      mockAuditEvents.mockClear();

      expect(await retire(bulkId, null)).toEqual({
        ok: true,
        movedBanCount: 1201,
      });
      expect(mockAuditEvents.mock.calls.map((c) => c[1].length)).toEqual([
        500, 500, 201,
      ]);
      const moves = await switchAuditFrom(bulkId);
      expect(moves).toHaveLength(1201);
      expect(new Set(moves.map((m) => m.target_id)).size).toBe(1201);
      const [left] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.billing_account
        WHERE ref_bill_template_family_id = ${bulkId}`;
      expect(left!.n).toBe(0);
    }, 120_000);

    it("a BAN bound between the audit and the re-count rolls the whole retire back: no BAN moves, the type stays live", async () => {
      const leakyId = await usableType("Leaky");
      const ban = await newBan();
      await bindOk(ban, leakyId);
      const { roleId, faId } = await newParty();
      const audits = await auditCount();
      mockAuditEvents.mockImplementationOnce(async (db, events) => {
        await actual.insertAuditEvents(db, events);
        // Inside the retire's transaction, after step 4 and before step 5.
        await (db as Database).insert(billingAccount).values({
          name: "BM83VERIFY-LATE",
          state: "active",
          refPartyRoleId: roleId,
          refFinancialAccountId: faId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: ACTOR,
          refBillTemplateFamilyId: leakyId,
        });
      });

      await expect(retire(leakyId, null)).rejects.toThrow("RETIRE_BANS_REMAIN");

      expect((await banRow(ban)).ref_bill_template_family_id).toBe(leakyId);
      const [family] = await h.sql<{ retired_datetime: Date | null }[]>`
        SELECT retired_datetime FROM billing.bill_template_family
        WHERE bill_template_family_id = ${leakyId}`;
      expect(family!.retired_datetime).toBeNull();
      const late = await h.sql`
        SELECT 1 FROM billing.billing_account WHERE name = 'BM83VERIFY-LATE'`;
      expect(late).toHaveLength(0);
      expect(await auditCount()).toBe(audits);
    }, 120_000);

    // ── guardrail 76: races ─────────────────────────────────────────────

    it("bind first: a bind holding its FOR SHARE makes the retire wait; the retire then moves that BAN too", async () => {
      const typeId = await usableType("Bind First");
      const ban = await newBan();
      const hold = holdAuditEvent("BILLING_ACCOUNT_TEMPLATE_CHANGED");
      const binding = bind(ban, typeId);
      await hold.reached;
      const retiring = retire(typeId, null);
      await lockWaiter();
      hold.release();

      expect(await binding).toMatchObject({
        ok: true,
        value: { changed: true },
      });
      expect(await retiring).toEqual({ ok: true, movedBanCount: 1 });
      expect((await banRow(ban)).ref_bill_template_family_id).toBeNull();
    }, 120_000);

    it("retire first: a bind waiting on the retire's FOR UPDATE re-reads the type and returns TEMPLATE_NOT_BINDABLE", async () => {
      const typeId = await usableType("Retire First");
      const ban = await newBan();
      const hold = holdAuditEvent("INVOICE_TEMPLATE_TYPE_RETIRED");
      const retiring = retire(typeId, null);
      await hold.reached;
      const binding = bind(ban, typeId);
      await lockWaiter();
      hold.release();

      expect(await retiring).toEqual({ ok: true, movedBanCount: 0 });
      expect(await binding).toEqual({
        ok: false,
        code: "TEMPLATE_NOT_BINDABLE",
      });
      expect((await banRow(ban)).ref_bill_template_family_id).toBeNull();
    }, 120_000);

    it("opposite retires A→B and B→A, one held open while the other waits: no deadlock, exactly one succeeds", async () => {
      const alpha = await usableType("Alpha");
      const beta = await usableType("Beta");
      const banA = await newBan();
      const banB = await newBan();
      await bindOk(banA, alpha);
      await bindOk(banB, beta);

      const hold = holdAuditEvent("INVOICE_TEMPLATE_TYPE_RETIRED");
      const first = retire(alpha, beta);
      await hold.reached;
      const second = retire(beta, alpha);
      await lockWaiter();
      hold.release();

      const results = await Promise.all([first, second]);
      expect(results[0]).toEqual({ ok: true, movedBanCount: 1 });
      expect(results[1]).toEqual({
        ok: false,
        code: "RETIRE_TARGET_NOT_USABLE",
      });
      expect((await banRow(banA)).ref_bill_template_family_id).toBe(beta);
      expect((await banRow(banB)).ref_bill_template_family_id).toBe(beta);
    }, 120_000);

    it("opposite retires run freely in parallel: both finish in time, no 40P01, exactly one succeeds", async () => {
      const gamma = await usableType("Gamma");
      const delta = await usableType("Delta");
      const banG = await newBan();
      const banD = await newBan();
      await bindOk(banG, gamma);
      await bindOk(banD, delta);

      const results = await Promise.race([
        Promise.all([retire(gamma, delta), retire(delta, gamma)]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("retires timed out")), 20_000),
        ),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok);
      expect(["RETIRE_TARGET_NOT_USABLE", "TEMPLATE_TYPE_RETIRED"]).toContain(
        loser && !loser.ok ? loser.code : null,
      );
      const survivor = results[0]!.ok ? delta : gamma;
      expect((await banRow(banG)).ref_bill_template_family_id).toBe(survivor);
      expect((await banRow(banD)).ref_bill_template_family_id).toBe(survivor);
    }, 120_000);

    it("save racing retire: a save holding the type row makes the retire wait, then both succeed; the other way the save waits and returns TEMPLATE_TYPE_RETIRED", async () => {
      const saver = await usableType("Saver");
      const current = (await billTemplateVersionRepository.findActive(h.db, {
        kind: "generated",
        familyId: saver,
      }))!;
      const saveHold = holdAuditEvent("INVOICE_TEMPLATE_DRAFT_SAVED");
      const saving = saveTemplateDraft(
        {
          structure: structureOf(current),
          expectedDraftToken: null,
          familyId: saver,
        },
        ACTOR,
      );
      await saveHold.reached;
      const retiring = retire(saver, null);
      await lockWaiter();
      saveHold.release();
      expect(await saving).toMatchObject({ ok: true });
      expect(await retiring).toEqual({ ok: true, movedBanCount: 0 });

      const saverTwo = await usableType("Saver Two");
      const currentTwo = (await billTemplateVersionRepository.findActive(h.db, {
        kind: "generated",
        familyId: saverTwo,
      }))!;
      const retireHold = holdAuditEvent("INVOICE_TEMPLATE_TYPE_RETIRED");
      const retiringTwo = retire(saverTwo, null);
      await retireHold.reached;
      const savingTwo = saveTemplateDraft(
        {
          structure: structureOf(currentTwo),
          expectedDraftToken: null,
          familyId: saverTwo,
        },
        ACTOR,
      );
      await lockWaiter();
      retireHold.release();
      expect(await retiringTwo).toEqual({ ok: true, movedBanCount: 0 });
      expect(await savingTwo).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });
      expect(
        await billTemplateVersionRepository.findDraft(h.db, {
          kind: "generated",
          familyId: saverTwo,
        }),
      ).toBeNull();
    }, 120_000);
  },
);
