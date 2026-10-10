import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BlobServiceClient } from "@azure/storage-blob";
import {
  afterAll,
  afterEach,
  beforeAll,
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

// bm58-spec §Tests (+ guardrail 53): activate the working draft on a real
// database and a real Azurite. Success writes a content-addressed, checksum-
// indexed directory that `loadGeneratedFiles` verifies; the second activation
// retires the first and never touches the default; a DB failure after the blob
// write leaves the previous version ACTIVE, the draft a DRAFT, orphan blobs in
// place and no audit row, and an identical retry succeeds; and a stale token,
// an empty note, a tampered layout, a layout that fails its test render and a
// different blob at the target path are each refused with nothing activated.
// The service uses the `@/db/client` singleton, so that singleton is replaced
// with one built on a real client (the ratecard-activate precedent).
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import {
  clearLoadedTemplateMemo,
  loadGeneratedFiles,
} from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import type { Database } from "@/db/client";

const ACTOR = "bm58-actor";
const NOTE = "Hide notes for the pilot MNOs";
const SEED_LAYOUT_DIR = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/INVTPL-STD-A4/v1",
);

function structure(overrides: { notes?: boolean; payment?: boolean } = {}) {
  return {
    sections: {
      ...Object.fromEntries(INVOICE_SECTION_KEYS.map((k) => [k, true])),
      ...overrides,
    },
    columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
  } as Parameters<typeof saveTemplateDraft>[0]["structure"];
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm58 activate template (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const templates = () => service!.getContainerClient("invoice-templates");

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

    // Save (or update) the single working draft and return its id and token.
    async function ensureDraft(
      s = structure(),
    ): Promise<{ id: string; token: string; versionNo: number }> {
      const existing = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
      });
      const saved = await saveTemplateDraft(
        { structure: s, expectedDraftToken: existing?.token ?? null },
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      return {
        id: saved.versionId,
        token: saved.draftToken,
        versionNo: saved.versionNo,
      };
    }

    async function activatedAudit() {
      return sql<
        { target_id: string; before_data: unknown; after_data: unknown }[]
      >`
        SELECT target_id, before_data, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_ACTIVATED' ORDER BY created_datetime`;
    }

    async function nonDefaultActive() {
      return sql<{ bill_template_version_id: string; version_no: number }[]>`
        SELECT bill_template_version_id, version_no FROM billing.bill_template_version
        WHERE kind = 'generated' AND status = 'ACTIVE' AND NOT is_default`;
    }

    async function blobNames(prefix: string): Promise<string[]> {
      const names: string[] = [];
      for await (const b of templates().listBlobsFlat({ prefix })) {
        names.push(b.name);
      }
      return names;
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
        VALUES (${ACTOR}, 'Template Admin', 'template-admin@example.com', 'LOCAL', 'ACTIVE')`;
      // Layout v1 and the default generated v1 must exist in blob storage.
      await seedInvoiceTemplates(db);
      clearLoadedTemplateMemo();
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (service) {
        for await (const b of templates().listBlobsFlat({
          prefix: "generated/INVOICE/v",
        })) {
          // Keep the seeded default (`v1/`); remove what these tests wrote.
          if (!b.name.startsWith("generated/INVOICE/v1/")) {
            await templates()
              .deleteBlob(b.name)
              .catch(() => undefined);
          }
        }
        for await (const b of templates().listBlobsFlat({
          prefix: "layouts/INVTPL-STD-A4/v2-",
        })) {
          await templates()
            .deleteBlob(b.name)
            .catch(() => undefined);
        }
      }
      clearLoadedTemplateMemo();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("activates the draft: ACTIVE with a content-addressed blob_ref, verified files, one audit row, resolved for the next draft", async () => {
      const draft = await ensureDraft(structure({ notes: false }));
      const result = await activateTemplate(
        {
          draftId: draft.id,
          expectedDraftToken: draft.token,
          changeNote: NOTE,
        },
        ACTOR,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.versionNo).toBe(2);
      expect(result.retiredVersionId).toBeNull();

      const [row] = await sql`
        SELECT * FROM billing.bill_template_version
        WHERE bill_template_version_id = ${result.versionId}`;
      expect(row).toMatchObject({
        status: "ACTIVE",
        is_default: false,
        change_note: NOTE,
        activated_by: ACTOR,
        checksum_algorithm: "sha256",
      });
      expect(row?.blob_ref).toMatch(
        /^invoice-templates\/generated\/INVOICE\/v2-[0-9a-f]{12}\/$/,
      );
      expect(row?.activated_datetime).not.toBeNull();

      // The stored directory verifies end to end against the row's checksum,
      // and the generated files carry no directive and no hidden-section markup.
      const stored = await loadGeneratedFiles(
        (await billTemplateVersionRepository.findById(db, result.versionId))!,
      );
      const invoice = stored["invoice.hbs"].toString("utf-8");
      expect(invoice).not.toContain("[[");
      expect(invoice).not.toContain("sec--notes");
      expect(JSON.parse(stored["structure.json"].toString("utf-8"))).toEqual(
        JSON.parse(JSON.stringify(structure({ notes: false }))),
      );
      expect(stored["footer.hbs"].toString("utf-8")).toContain("totalPages");

      // Exactly one audit row naming the version, the default it superseded
      // and the note.
      const audit = await activatedAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.target_id).toBe(result.versionId);
      expect(audit[0]?.before_data).toEqual({
        activeVersionId: "BTV00000002",
        activeVersionNo: 1,
      });
      expect(audit[0]?.after_data).toMatchObject({
        activatedVersionId: result.versionId,
        versionNo: 2,
        retiredVersionId: null,
        changeNote: NOTE,
        blobRef: row?.blob_ref,
        checksum: row?.checksum,
      });

      // The default is untouched and the next draft preview uses the new one.
      const [def] = await sql`
        SELECT status, is_default FROM billing.bill_template_version
        WHERE bill_template_version_id = 'BTV00000002'`;
      expect(def).toMatchObject({ status: "ACTIVE", is_default: true });
      clearLoadedTemplateMemo();
      const resolved = await resolveTemplate(db, { kind: "draft" });
      expect(resolved.generated.billTemplateVersionId).toBe(result.versionId);
    }, 120_000);

    it("a second activation retires the previous version, leaves the default alone and audits both ids", async () => {
      const previous = (await nonDefaultActive())[0]!;
      const draft = await ensureDraft(structure({ payment: false }));
      expect(draft.versionNo).toBe(3);
      const result = await activateTemplate(
        {
          draftId: draft.id,
          expectedDraftToken: draft.token,
          changeNote: "v3",
        },
        ACTOR,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.retiredVersionId).toBe(previous.bill_template_version_id);

      const rows = await sql<
        {
          version_no: number;
          status: string;
          is_default: boolean;
          retired_datetime: Date | null;
        }[]
      >`
        SELECT version_no, status, is_default, retired_datetime
        FROM billing.bill_template_version WHERE kind = 'generated' ORDER BY version_no`;
      expect(rows.map((r) => [r.version_no, r.status, r.is_default])).toEqual([
        [1, "ACTIVE", true],
        [2, "RETIRED", false],
        [3, "ACTIVE", false],
      ]);
      expect(rows[1]?.retired_datetime).not.toBeNull();

      const audit = await activatedAudit();
      expect(audit).toHaveLength(2);
      expect(audit[1]?.before_data).toEqual({
        activeVersionId: previous.bill_template_version_id,
        activeVersionNo: 2,
      });
      expect(audit[1]?.after_data).toMatchObject({
        retiredVersionId: previous.bill_template_version_id,
      });
    }, 120_000);

    it("[guardrail 53] a DB failure after the blob write leaves the previous version ACTIVE, the draft a DRAFT, the blobs as orphans and no audit row; a retry then succeeds", async () => {
      const activeBefore = (await nonDefaultActive())[0]!;
      const auditBefore = (await activatedAudit()).length;
      const draft = await ensureDraft(
        structure({ notes: false, payment: true }),
      );

      vi.spyOn(
        billTemplateVersionRepository,
        "promoteDraft",
      ).mockRejectedValueOnce(new Error("injected: promoteDraft failed"));
      await expect(
        activateTemplate(
          {
            draftId: draft.id,
            expectedDraftToken: draft.token,
            changeNote: "boom",
          },
          ACTOR,
        ),
      ).rejects.toThrow("injected");

      // The retire ran inside the rolled-back transaction, so v3 is still ACTIVE.
      expect(await nonDefaultActive()).toEqual([activeBefore]);
      const [stillDraft] = await sql`
        SELECT status FROM billing.bill_template_version
        WHERE bill_template_version_id = ${draft.id}`;
      expect(stillDraft?.status).toBe("DRAFT");
      expect(await activatedAudit()).toHaveLength(auditBefore);
      // The four files from step 7 remain as orphans.
      const orphans = await blobNames(`generated/INVOICE/v${draft.versionNo}-`);
      expect(orphans.map((n) => n.split("/").pop()).sort()).toEqual([
        "checksums.json",
        "footer.hbs",
        "invoice.hbs",
        "structure.json",
      ]);

      // A retry with the same draft and token finds identical blobs and works.
      const retry = await activateTemplate(
        {
          draftId: draft.id,
          expectedDraftToken: draft.token,
          changeNote: "retry",
        },
        ACTOR,
      );
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.retiredVersionId).toBe(
        activeBefore.bill_template_version_id,
      );
      expect(
        await blobNames(`generated/INVOICE/v${draft.versionNo}-`),
      ).toHaveLength(4);
      expect(await activatedAudit()).toHaveLength(auditBefore + 1);
    }, 180_000);

    it("a stale token is DRAFT_CONFLICT and writes nothing", async () => {
      const draft = await ensureDraft(structure({ notes: true }));
      const auditBefore = (await activatedAudit()).length;
      const activeBefore = await nonDefaultActive();
      // Someone else edits the draft, moving its token on.
      await ensureDraft(structure({ notes: false }));

      const result = await activateTemplate(
        {
          draftId: draft.id,
          expectedDraftToken: draft.token,
          changeNote: "stale",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await nonDefaultActive()).toEqual(activeBefore);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(
        await blobNames(`generated/INVOICE/v${draft.versionNo}-`),
      ).toHaveLength(0);
    }, 120_000);

    it.each(["", "   \n\t"])(
      "an empty change note (%j) is CHANGE_NOTE_REQUIRED and writes nothing",
      async (note) => {
        const draft = await ensureDraft();
        const auditBefore = (await activatedAudit()).length;
        const result = await activateTemplate(
          {
            draftId: draft.id,
            expectedDraftToken: draft.token,
            changeNote: note,
          },
          ACTOR,
        );
        expect(result).toEqual({ ok: false, code: "CHANGE_NOTE_REQUIRED" });
        expect(await activatedAudit()).toHaveLength(auditBefore);
        expect(
          await blobNames(`generated/INVOICE/v${draft.versionNo}-`),
        ).toHaveLength(0);
      },
    );

    it("an id that is not the working draft is DRAFT_CONFLICT", async () => {
      const draft = await ensureDraft();
      const result = await activateTemplate(
        {
          draftId: "BTV00000002",
          expectedDraftToken: draft.token,
          changeNote: "x",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    });

    it("a tampered layout blob is TEMPLATE_CHECKSUM_MISMATCH and writes nothing", async () => {
      const draft = await ensureDraft();
      const auditBefore = (await activatedAudit()).length;
      const target = "layouts/INVTPL-STD-A4/v1/partials/notes.hbs";
      const original = readFileSync(
        path.join(SEED_LAYOUT_DIR, "partials/notes.hbs"),
      );
      const blob = templates().getBlockBlobClient(target);
      await blob.uploadData(
        Buffer.concat([original, Buffer.from("<!-- x -->")]),
      );
      try {
        const result = await activateTemplate(
          {
            draftId: draft.id,
            expectedDraftToken: draft.token,
            changeNote: "t",
          },
          ACTOR,
        );
        expect(result).toEqual({
          ok: false,
          code: "TEMPLATE_CHECKSUM_MISMATCH",
        });
      } finally {
        await blob.uploadData(original);
      }
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(
        await blobNames(`generated/INVOICE/v${draft.versionNo}-`),
      ).toHaveLength(0);
    }, 120_000);

    it("a layout whose output fails the test render is TEMPLATE_COMPILE_FAILED and writes nothing", async () => {
      // A second layout version whose shell calls a helper that is not
      // registered: a real, checksum-indexed layout in blob storage.
      const dir = "layouts/INVTPL-STD-A4/v2-badhelper/";
      const files = new Map<string, Buffer>();
      for (const rel of walk(SEED_LAYOUT_DIR)) {
        if (rel === "checksums.json") continue;
        let bytes = readFileSync(path.join(SEED_LAYOUT_DIR, rel));
        if (rel === "shell.hbs") {
          bytes = Buffer.from(
            bytes
              .toString("utf-8")
              .replace("<body", "{{bogusHelper invoice.number}}<body"),
          );
        }
        files.set(rel, bytes);
      }
      const index = {
        algorithm: "sha256",
        files: Object.fromEntries(
          [...files.keys()].sort().map((k) => [k, sha256(files.get(k)!)]),
        ),
      };
      const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
      files.set("checksums.json", indexBytes);
      for (const [name, bytes] of files) {
        await templates().getBlockBlobClient(`${dir}${name}`).uploadData(bytes);
      }
      const [v1] = await sql`
        SELECT page_setup FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000001'`;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, layout_code,
           page_setup, blob_ref, checksum, checksum_algorithm, activated_datetime, change_note)
        VALUES ('BTV00000090', 'INVOICE', 'layout', 2, 'ACTIVE', 'INVTPL-STD-A4',
                ${JSON.stringify(v1!.page_setup)}::jsonb, ${`invoice-templates/${dir}`}, ${sha256(indexBytes)}, 'sha256', now(), 'bad helper fixture')`;
      // A DRAFT pointing at it (the trigger forbids changing this later, so it
      // is inserted that way). Free the single draft slot first.
      await sql`ALTER TABLE billing.bill_template_version DISABLE TRIGGER USER`;
      await sql`DELETE FROM billing.bill_template_version WHERE status = 'DRAFT'`;
      await sql`ALTER TABLE billing.bill_template_version ENABLE TRIGGER USER`;
      const nextNo = await billTemplateVersionRepository.nextVersionNo(db, {
        kind: "generated",
      });
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, ref_layout_version_id, structure, created_by)
        VALUES ('BTV00000091', 'INVOICE', 'generated', ${nextNo}, 'DRAFT', 'BTV00000090',
                ${JSON.stringify(structure())}::jsonb, ${ACTOR})`;
      const draft = (await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
      }))!;
      const auditBefore = (await activatedAudit()).length;

      const result = await activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: "bad",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "TEMPLATE_COMPILE_FAILED" });
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(await blobNames(`generated/INVOICE/v${nextNo}-`)).toHaveLength(0);

      // Remove the fixture draft so later tests start clean.
      await sql`ALTER TABLE billing.bill_template_version DISABLE TRIGGER USER`;
      await sql`DELETE FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000091'`;
      await sql`ALTER TABLE billing.bill_template_version ENABLE TRIGGER USER`;
    }, 180_000);

    it("a different blob already at the target path is ACTIVATION_BLOB_CONFLICT and activates nothing", async () => {
      const activeBefore = await nonDefaultActive();
      const draft = await ensureDraft(
        structure({ notes: false, payment: false }),
      );
      // Create the orphans with a failed activation, then corrupt one of them.
      vi.spyOn(
        billTemplateVersionRepository,
        "promoteDraft",
      ).mockRejectedValueOnce(new Error("injected"));
      await expect(
        activateTemplate(
          {
            draftId: draft.id,
            expectedDraftToken: draft.token,
            changeNote: "first",
          },
          ACTOR,
        ),
      ).rejects.toThrow("injected");
      const orphan = (
        await blobNames(`generated/INVOICE/v${draft.versionNo}-`)
      ).find((n) => n.endsWith("/invoice.hbs"))!;
      await templates()
        .getBlockBlobClient(orphan)
        .uploadData(Buffer.from("different"));

      const result = await activateTemplate(
        {
          draftId: draft.id,
          expectedDraftToken: draft.token,
          changeNote: "retry",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "ACTIVATION_BLOB_CONFLICT" });
      expect(await nonDefaultActive()).toEqual(activeBefore);
      const [row] = await sql`
        SELECT status FROM billing.bill_template_version
        WHERE bill_template_version_id = ${draft.id}`;
      expect(row?.status).toBe("DRAFT");
    }, 180_000);

    it("two concurrent activations of the same draft: one wins, the other is DRAFT_CONFLICT", async () => {
      // Edit the draft so its content (and so its directory) is fresh.
      const draft = await ensureDraft(
        structure({ notes: true, payment: false }),
      );
      const run = (note: string) =>
        activateTemplate(
          {
            draftId: draft.id,
            expectedDraftToken: draft.token,
            changeNote: note,
          },
          ACTOR,
        );
      const results = await Promise.all([run("a"), run("b")]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => !r.ok && r.code === "DRAFT_CONFLICT"),
      ).toHaveLength(1);
      expect(await nonDefaultActive()).toHaveLength(1);
    }, 180_000);
  },
);
