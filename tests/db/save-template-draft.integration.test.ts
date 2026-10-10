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
import { INVOICE_COLUMN_KEYS, INVOICE_SECTION_KEYS } from "@/types/billing";

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

import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import {
  resolveTemplate,
  resolveVersionsForPosting,
} from "@/services/billing/invoice-template/resolve-template";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { Database } from "@/db/client";

const ACTOR = "bm57-actor";

function structure(overrides: { payment?: boolean; notes?: boolean } = {}) {
  return {
    sections: {
      ...Object.fromEntries(INVOICE_SECTION_KEYS.map((k) => [k, true])),
      ...overrides,
    },
    columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
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
        { structure: structure({ notes: false }), expectedDraftToken: null },
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
        blob_ref: null,
        checksum: null,
        created_by: ACTOR,
      });
      expect(row?.structure.sections.notes).toBe(false);
    });

    it("writes exactly one audit row per success, with null before on the insert", async () => {
      const result = await saveTemplateDraft(
        { structure: structure(), expectedDraftToken: null },
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
        { structure: structure({ payment: true }), expectedDraftToken: null },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");

      const second = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
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
        { structure: structure(), expectedDraftToken: null },
        ACTOR,
      );
      if (!first.ok) throw new Error("expected ok");
      // Someone else saves, moving the token on.
      const other = await saveTemplateDraft(
        {
          structure: structure({ notes: false }),
          expectedDraftToken: first.draftToken,
        },
        ACTOR,
      );
      if (!other.ok) throw new Error("expected ok");

      const stale = await saveTemplateDraft(
        {
          structure: structure({ payment: false }),
          expectedDraftToken: first.draftToken,
        },
        ACTOR,
      );
      expect(stale).toEqual({ ok: false, code: "DRAFT_CONFLICT" });

      const [row] = await sql`
        SELECT structure FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      expect(row?.structure.sections.payment).toBe(true);
      expect(row?.structure.sections.notes).toBe(false);
      expect(await auditRows()).toHaveLength(2);
    });

    it("believing no draft exists while one does is DRAFT_CONFLICT", async () => {
      await saveTemplateDraft(
        { structure: structure(), expectedDraftToken: null },
        ACTOR,
      );
      expect(
        await saveTemplateDraft(
          { structure: structure(), expectedDraftToken: null },
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
            },
            ACTOR,
          ),
          saveTemplateDraft(
            {
              structure: structure({ payment: false }),
              expectedDraftToken: null,
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

    it("refuses a hidden mandatory section even when called directly, writing nothing", async () => {
      const crafted = structure();
      crafted.sections.billTo = false;
      expect(
        await saveTemplateDraft(
          { structure: crafted, expectedDraftToken: null },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "MANDATORY_SECTION_HIDDEN" });
      const drafts = await sql`
        SELECT 1 FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      expect(drafts).toHaveLength(0);
      expect(await auditRows()).toHaveLength(0);
    });

    it("the DRAFT is never resolved: draft and posting still use the ACTIVE/default version", async () => {
      await saveTemplateDraft(
        { structure: structure({ payment: false }), expectedDraftToken: null },
        ACTOR,
      );
      const draft = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
      });
      expect(draft?.status).toBe("DRAFT");

      const resolved = await resolveTemplate(db, { kind: "draft" });
      const posting = await db.transaction((tx) =>
        resolveVersionsForPosting(tx),
      );
      expect(posting.refBillTemplateVersionId).toBe("BTV00000002");
      expect(resolved.generated.billTemplateVersionId).toBe("BTV00000002");
      expect(resolved.generated.status).toBe("ACTIVE");
      expect(
        await billTemplateVersionRepository.findActive(db, {
          kind: "generated",
        }),
      ).toBeNull();
    });

    it("a saved DRAFT shows in the version history and the default is untouched", async () => {
      await saveTemplateDraft(
        { structure: structure(), expectedDraftToken: null },
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
  },
);
