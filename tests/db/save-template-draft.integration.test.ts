import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { SEEDED_FOOTNOTE } from "@/tests/helpers/seeded-invoice-template";
import { insertTemplateTypeFixture } from "@/tests/db/helpers/template-type-fixtures";

// bm57-spec §Tests: save-draft on a real database. The first save inserts the
// working DRAFT as v2 (the next after the default v1) with a structure and no
// files; a second save updates the same row; a stale token is DRAFT_CONFLICT;
// two concurrent first saves leave one winner and one DRAFT_CONFLICT; every
// success writes exactly one INVOICE_TEMPLATE_DRAFT_SAVED row with before and
// after; and the DRAFT is never what `resolveTemplate` returns. The service
// opens its own transaction on the `@/db/client` singleton, so that singleton
// is replaced with one built on a real client (the ratecard-activate precedent).
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import {
  isDraftRaceViolation,
  saveTemplateDraft,
} from "@/services/billing/invoice-template/save-template-draft";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { Database } from "@/db/client";
import type { LayoutPageSetup } from "@/types/billing";

const ACTOR = "bm57-actor";

// bm72 — the editable structure: the Payment toggle and the footnote lines
// (the seeded v1 footnote unless a case edits it).
const EDITED_FOOTNOTE = ["Calculations are done in Mbps", "Edited line 2"];
function structure(overrides: { payment?: boolean; footnote?: string[] } = {}) {
  return {
    sections: { payment: overrides.payment ?? true },
    columns: {},
    footnote: overrides.footnote ?? [...SEEDED_FOOTNOTE],
  } as Parameters<typeof saveTemplateDraft>[0]["structure"];
}

describe.skipIf(!databaseUrl)(
  "bm57 save template draft (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    // The guard trigger refuses every DELETE (Inv #44), so a test reset has to
    // switch the user triggers off for the cleanup, as the superuser it runs as.
    async function resetDrafts(): Promise<void> {
      await sql`ALTER TABLE billing.bill_template_version DISABLE TRIGGER USER`;
      try {
        await sql`DELETE FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      } finally {
        await sql`ALTER TABLE billing.bill_template_version ENABLE TRIGGER USER`;
      }
      await sql`DELETE FROM core.audit_log WHERE event_type = 'INVOICE_TEMPLATE_DRAFT_SAVED'`;
    }

    async function auditRows(): Promise<
      {
        target_id: string;
        actor_user_id: string;
        before_data: unknown;
        after_data: unknown;
      }[]
    > {
      return sql`
        SELECT target_id, actor_user_id, before_data, after_data
        FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_DRAFT_SAVED'
        ORDER BY created_datetime`;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 8, onnotice: () => {} });
      await dropAll();
      const drizzleDb = drizzle(sql, { schema });
      await migrate(drizzleDb, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Draft Saver', 'draft-saver@example.com', 'LOCAL', 'ACTIVE')`;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    });

    beforeEach(async () => {
      await resetDrafts();
    });

    it("the first save inserts the DRAFT as the next version, with a structure and no files", async () => {
      const result = await saveTemplateDraft(
        {
          structure: structure({ footnote: EDITED_FOOTNOTE }),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.versionNo).toBe(2);

      const [row] = await sql`
        SELECT * FROM billing.bill_template_version
        WHERE bill_template_version_id = ${result.versionId}`;
      expect(row).toMatchObject({
        kind: "generated",
        status: "DRAFT",
        is_default: false,
        version_no: 2,
        ref_layout_version_id: "BTV00000001",
        // bm64 — the draft takes the family of the version it is built from
        // (the seeded default BTV00000002, in Standard).
        ref_bill_template_family_id: "BTF00000001",
        blob_ref: null,
        checksum: null,
        created_by: ACTOR,
      });
      expect(row?.structure.footnote).toEqual(EDITED_FOOTNOTE);
    });

    it("writes exactly one audit row per success, with null before on the insert", async () => {
      const result = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!result.ok) throw new Error("expected ok");
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        target_id: result.versionId,
        actor_user_id: ACTOR,
        before_data: null,
      });
      expect(rows[0]?.after_data).toMatchObject({
        versionNo: 2,
        refLayoutVersionId: "BTV00000001",
      });
    });

    it("a second save updates the same row with the returned token and audits before/after", async () => {
      const first = await saveTemplateDraft(
        {
          structure: structure({ payment: true }),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");

      const second = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.versionId).toBe(first.versionId);
      expect(second.versionNo).toBe(first.versionNo);
      expect(second.draftToken).not.toBe(first.draftToken);

      const drafts = await sql`
        SELECT structure FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.structure.sections.payment).toBe(false);

      const rows = await auditRows();
      expect(rows).toHaveLength(2);
      expect(
        (rows[1]?.before_data as { structure: typeof schema }).structure,
      ).toMatchObject({ sections: { payment: true } });
      expect(rows[1]?.after_data).toMatchObject({
        structure: { sections: { payment: false } },
      });
    });

    it("a stale token is DRAFT_CONFLICT, changes nothing and writes no audit row", async () => {
      const first = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      // Someone else saves, moving the token on.
      const other = await saveTemplateDraft(
        {
          structure: structure({ footnote: EDITED_FOOTNOTE }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!other.ok) throw new Error("expected ok");

      const stale = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(stale).toEqual({ ok: false, code: "DRAFT_CONFLICT" });

      const [row] = await sql`
        SELECT structure FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      expect(row?.structure.sections.payment).toBe(true);
      expect(row?.structure.footnote).toEqual(EDITED_FOOTNOTE);
      expect(await auditRows()).toHaveLength(2);
    });

    it("believing no draft exists while one does is DRAFT_CONFLICT", async () => {
      await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(
        await saveTemplateDraft(
          {
            structure: structure(),
            expectedDraftToken: null,
            familyId: "BTF00000001",
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    });

    it("believing a draft exists when none does is DRAFT_CONFLICT", async () => {
      expect(
        await saveTemplateDraft(
          {
            structure: structure(),
            expectedDraftToken: "2026-10-10T01:02:03.123456Z",
            familyId: "BTF00000001",
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await auditRows()).toHaveLength(0);
    });

    it("two concurrent first saves: one wins, the other is DRAFT_CONFLICT", async () => {
      for (let i = 0; i < 3; i++) {
        await resetDrafts();
        const results = await Promise.all([
          saveTemplateDraft(
            {
              structure: structure({ payment: true }),
              expectedDraftToken: null,
              familyId: "BTF00000001",
            },
            ACTOR,
          ),
          saveTemplateDraft(
            {
              structure: structure({ payment: false }),
              expectedDraftToken: null,
              familyId: "BTF00000001",
            },
            ACTOR,
          ),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(
          results.filter((r) => !r.ok && r.code === "DRAFT_CONFLICT"),
        ).toHaveLength(1);
        const drafts = await sql`
          SELECT 1 FROM billing.bill_template_version WHERE status = 'DRAFT'`;
        expect(drafts).toHaveLength(1);
        expect(await auditRows()).toHaveLength(1);
      }
    });

    it("review fix (Inv #66 lock order) — a first save racing an upload that holds the type row and then wants the kind lock does not deadlock", async () => {
      await resetDrafts();
      // A second connection plays install: the type row FOR UPDATE first,
      // then (while the save is in flight) the generated kind lock. Before the
      // fix the save took the kind lock first and its INSERT's FK check then
      // waited on the type row: Postgres aborted one side (40P01).
      const holder = postgres(databaseUrl as string, {
        max: 1,
        onnotice: () => {},
      });
      let save: ReturnType<typeof saveTemplateDraft> | undefined;
      try {
        await holder.begin(async (t) => {
          await t`
            SELECT 1 FROM billing.bill_template_family
            WHERE bill_template_family_id = 'BTF00000001' FOR UPDATE`;
          save = saveTemplateDraft(
            {
              structure: structure({ payment: false }),
              expectedDraftToken: null,
              familyId: "BTF00000001",
            },
            ACTOR,
          );
          await new Promise((r) => setTimeout(r, 300));
          await t`SELECT pg_advisory_xact_lock(hashtext(${"billing.bill_template_version:INVOICE:generated"}))`;
        });
        expect(await save).toMatchObject({ ok: true });
      } finally {
        await holder.end();
      }
    }, 30_000);

    it("refuses a mandatory section key even when called directly, writing nothing", async () => {
      // bm71 (D56) — mandatory sections are not part of the stored structure,
      // so the strict schema refuses the key outright.
      const crafted = structure();
      (crafted.sections as Record<string, boolean>).billTo = false;
      expect(
        await saveTemplateDraft(
          {
            structure: crafted,
            expectedDraftToken: null,
            familyId: "BTF00000001",
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "VALIDATION_ERROR" });
      const drafts = await sql`
        SELECT 1 FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      expect(drafts).toHaveLength(0);
      expect(await auditRows()).toHaveLength(0);
    });

    // bm67 — posting no longer resolves (it copies the run stamps), so only
    // the live preview resolution is checked here.
    it("the DRAFT is never resolved: the live preview still uses the ACTIVE/default version", async () => {
      await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      const draft = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
      });
      expect(draft?.status).toBe("DRAFT");

      const resolved = await resolveTemplate(db, {
        kind: "preview-family",
        familyId: "BTF00000001",
      });
      expect(resolved.generated.billTemplateVersionId).toBe("BTV00000002");
      expect(resolved.generated.status).toBe("ACTIVE");
      expect(
        await billTemplateVersionRepository.findActive(db, {
          kind: "generated",
        }),
      ).toBeNull();
    });

    it("a real btv_one_draft_uq violation is recognised as a draft race (postgres.js error shape)", async () => {
      await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      const err = await sql`
        INSERT INTO billing.bill_template_version
          (ref_bill_format_id, kind, version_no, status, ref_layout_version_id, ref_bill_template_family_id, structure)
        VALUES ('INVOICE', 'generated', 99, 'DRAFT', 'BTV00000001', 'BTF00000001', ${JSON.stringify(structure())}::jsonb)`.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(isDraftRaceViolation(err)).toBe(true);
    });

    // bm81 review fix (owner, #4) — the "saved by" banner reads the draft's
    // last writer (`last_modified_by`), not the last DRAFT_SAVED audit row.
    it("the draft's last writer is the latest saver; a removed user leaves no name (an unknown user on the page)", async () => {
      const OTHER = "bm57-other";
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${OTHER}, 'Second Saver', 'second-saver@example.com', 'LOCAL', 'ACTIVE')
        ON CONFLICT DO NOTHING`;
      const first = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      const second = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        OTHER,
      );
      if (!second.ok) throw new Error("expected ok");

      const draft = () =>
        billTemplateVersionRepository.findDraftWithModifier(db, {
          kind: "generated",
          familyId: "BTF00000001",
        });
      expect((await draft())?.lastModifiedByName).toBe("Second Saver");

      // `last_modified_by` is ON DELETE SET NULL: no recorded writer.
      await sql`DELETE FROM core.appuser WHERE user_id = ${OTHER}`;
      expect((await draft())?.lastModifiedByName).toBeNull();
    });

    it("a saved DRAFT shows in the version history and the default is untouched", async () => {
      await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      const rows = await billTemplateVersionRepository.listForKind(db, {
        kind: "generated",
      });
      expect(rows.map((r) => [r.versionNo, r.status])).toEqual([
        [2, "DRAFT"],
        [1, "ACTIVE"],
      ]);
    });

    // bm77 — version numbers are per type (bm74 `btv_version_uq`): another
    // type's higher settings numbers do not move Standard's next number.
    it("bm77 — a Standard draft is numbered Standard's max + 1, whatever another type holds", async () => {
      await insertTemplateTypeFixture(sql, {
        typeId: "BTF00000077",
        code: "BM77_OTHER",
        name: "BM77 Other",
        layoutVersionId: "BTV00000770",
      });
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime)
        SELECT 'BTV00000771', 'INVOICE', 'generated', 9, 'ACTIVE', false,
               'BTV00000770', 'BTF00000077', structure, 'invoice-templates/generated/INVOICE/v9/',
               ${"9".repeat(64)}, 'sha256', 'bm77 other-type fixture', now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      const [max] = await sql<{ n: number }[]>`
        SELECT max(version_no)::int AS n FROM billing.bill_template_version
        WHERE kind = 'generated' AND ref_bill_template_family_id = 'BTF00000001'`;

      const result = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(result).toMatchObject({ ok: true, versionNo: max!.n + 1 });
      expect(max!.n + 1).toBeLessThan(10);
    });

    it("bm77 — a familyId that does not exist is DRAFT_CONFLICT and writes nothing", async () => {
      const result = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00009999",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await auditRows()).toHaveLength(0);
    });

    // bm80 — what install writes on an upload: the layout DRAFT and the
    // re-pointed settings DRAFT in ONE transaction, so both carry the same
    // `now()` (equal tokens). DB-only: the files are never read here.
    async function simulateUpload(settingsDraftId: string): Promise<void> {
      const [v1] = await sql<{ page_setup: LayoutPageSetup }[]>`
        SELECT page_setup FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = 'BTF00000001' AND kind = 'layout'
          AND version_no = 1`;
      await db.transaction(async (tx) => {
        const layout = await billTemplateVersionRepository.insertLayoutDraft(
          tx,
          {
            familyId: "BTF00000001",
            layoutCode: "INVTPL-STD-A4",
            versionNo: 2,
            pageSetup: v1!.page_setup,
            blobRef: "invoice-templates/layouts/INVTPL-STD-A4/v2-000000000000/",
            checksum: "0".repeat(64),
            createdBy: ACTOR,
          },
        );
        await billTemplateVersionRepository.repointDraftLayout(tx, {
          id: settingsDraftId,
          layoutVersionId: layout.billTemplateVersionId,
          actorId: ACTOR,
        });
      });
    }

    it("bm80 — a save with the token from before an upload is DRAFT_LAYOUT_REPLACED with the current token; saving with it succeeds", async () => {
      const first = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      await simulateUpload(first.versionId);
      const current = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId: "BTF00000001",
      });
      expect(current!.token).not.toBe(first.draftToken);

      const replaced = await saveTemplateDraft(
        {
          structure: structure({ footnote: EDITED_FOOTNOTE }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(replaced).toEqual({
        ok: false,
        code: "DRAFT_LAYOUT_REPLACED",
        draftToken: current!.token,
      });
      // Nothing written: one audit row (the first save) only.
      expect(await auditRows()).toHaveLength(1);

      const again = await saveTemplateDraft(
        {
          structure: structure({ footnote: EDITED_FOOTNOTE }),
          expectedDraftToken: current!.token,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(again).toMatchObject({ ok: true, versionId: first.versionId });
    });

    it("bm80 — after another manager's save, a stale token stays DRAFT_CONFLICT (the tokens are unequal)", async () => {
      const first = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      await simulateUpload(first.versionId);
      const afterUpload = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId: "BTF00000001",
      });
      // Another manager saves over the upload with the fresh token.
      const other = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: afterUpload!.token,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!other.ok) throw new Error("expected ok");

      const stale = await saveTemplateDraft(
        {
          structure: structure({ footnote: EDITED_FOOTNOTE }),
          expectedDraftToken: afterUpload!.token,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      expect(stale).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    });

    it("bm77 — every DRAFT write records last_modified_by", async () => {
      const first = await saveTemplateDraft(
        {
          structure: structure(),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      const [inserted] = await sql<{ last_modified_by: string | null }[]>`
        SELECT last_modified_by FROM billing.bill_template_version
        WHERE bill_template_version_id = ${first.versionId}`;
      expect(inserted?.last_modified_by).toBe(ACTOR);

      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('bm77-second', 'Second Saver', 'second-saver@example.com', 'LOCAL', 'ACTIVE')
        ON CONFLICT DO NOTHING`;
      const second = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
          familyId: "BTF00000001",
        },
        "bm77-second",
      );
      if (!second.ok) throw new Error("expected ok");
      const [updated] = await sql<{ last_modified_by: string | null }[]>`
        SELECT last_modified_by FROM billing.bill_template_version
        WHERE bill_template_version_id = ${first.versionId}`;
      expect(updated?.last_modified_by).toBe("bm77-second");
    });
  },
);
