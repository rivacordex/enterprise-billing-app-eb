import { createHash } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SEEDED_FOOTNOTE } from "@/tests/helpers/seeded-invoice-template";

// bm78-spec §13 (Inv #59, #60, #62, guardrail 69) — upload a layout package on
// a real database and a real Azurite (the activate-template harness). The
// Chromium probe render is injected clean through `deps.render` (the e2e suite
// proves the real one). Cases: the happy path for a new "Wholesale" type; a
// second upload while its draft is open; every rejected fixture writes
// nothing; an open settings DRAFT is re-pointed (token bumped); a retired
// type; and a failure after the blob writes leaves orphan blobs only, which a
// retry reuses. The services use the `@/db/client` singleton, so it is
// replaced with one built on the test client.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { registerTemplateTypeDb } from "@/tests/db/helpers/template-type-db-harness";
import { insertTemplateTypeFixture } from "@/tests/db/helpers/template-type-fixtures";
import {
  buildLayoutPackage,
  cleanRender,
  replaceInFile,
  type LayoutPackageOptions,
} from "@/tests/helpers/layout-package";

const ACTOR = "bm78-actor";
const LAYOUT_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "layouts/INVTPL-BM78_REPOINT/",
  "layouts/INVTPL-RETRY/",
  "layouts/INVTPL-OLD_TYPE/",
];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm78 upload layout package (requires DATABASE_URL + Azurite)",
  () => {
    let wholesaleId: string;
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: {
        id: ACTOR,
        name: "Layout Uploader",
        email: "layout-uploader@example.com",
      },
      blobPrefixes: LAYOUT_PREFIXES,
      holder: hoisted.holder,
    });

    async function blobs(prefix: string): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for await (const b of h.templates().listBlobsFlat({ prefix })) {
        out.set(b.name, b.properties.etag ?? "");
      }
      return out;
    }

    async function counts(familyId: string, prefix: string) {
      const [versions] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version`;
      const [familyVersions] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${familyId}`;
      const [audit] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.audit_log`;
      return {
        versions: versions!.n,
        familyVersions: familyVersions!.n,
        audit: audit!.n,
        blobs: [...(await blobs(prefix)).keys()].sort(),
      };
    }

    function wholesalePackage(opts: LayoutPackageOptions = {}) {
      return buildLayoutPackage({
        layoutCode: "INVTPL-WHOLESALE",
        layoutVersion: 1,
        ...opts,
      });
    }

    beforeAll(async () => {
      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      expect(created.layoutCode).toBe("INVTPL-WHOLESALE");
      wholesaleId = created.typeId;
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Runs first, while "Wholesale" has no layout draft (an open draft would
    // stop the request before the gate).
    it.each([
      [
        "ZIP_UNEXPECTED_FILE",
        wholesalePackageFixture({
          override: (f) => f.set("settings.json", Buffer.from("{}")),
        }),
        cleanRender(),
      ],
      [
        "CHECKSUM_MISMATCH",
        wholesalePackageFixture({
          override: (f) =>
            replaceInFile(
              f,
              "partials/header.hbs",
              "<h1>Invoice</h1>",
              "<h1>X</h1>",
            ),
        }),
        cleanRender(),
      ],
      [
        "LAYOUT_MISSING_REQUIRED_BLOCKS",
        wholesalePackageFixture({
          edit: (f) =>
            replaceInFile(
              f,
              "partials/header.hbs",
              "<div>TIN {{company.tin}}</div>",
              "",
            ),
        }),
        cleanRender(),
      ],
      [
        "LAYOUT_EXTERNAL_FETCH",
        wholesalePackageFixture(),
        cleanRender(["http://x/a.png"]),
      ],
    ] as const)(
      "a %s package is refused and writes nothing (no row, no audit, no blob)",
      async (code, fixture, render) => {
        const before = await counts(wholesaleId, "layouts/INVTPL-WHOLESALE/");
        const result = await uploadLayoutPackage(
          {
            familyId: wholesaleId,
            zip: fixture().zip,
            expectedDraft: { none: true },
          },
          ACTOR,
          { render },
        );
        expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
        if (result.ok) return;
        expect(result.problems.map((p) => p.code)).toContain(code);
        expect(await counts(wholesaleId, "layouts/INVTPL-WHOLESALE/")).toEqual(
          before,
        );
        expect(before.familyVersions).toBe(0);
      },
    );

    it("happy path: INVTPL-WHOLESALE v1 becomes layout DRAFT v1 with a settings DRAFT v1, stored write-once, audited once", async () => {
      const built = wholesalePackage();
      const digest = sha256(built.indexBytes!);
      const result = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: built.zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(result).toMatchObject({ ok: true, versionNo: 1, replaced: false });
      if (!result.ok) return;

      const [layout] = await h.sql`
        SELECT * FROM billing.bill_template_version
        WHERE bill_template_version_id = ${result.versionId}`;
      expect(layout).toMatchObject({
        kind: "layout",
        status: "DRAFT",
        version_no: 1,
        is_default: false,
        layout_code: "INVTPL-WHOLESALE",
        ref_bill_template_family_id: wholesaleId,
        checksum: digest,
        checksum_algorithm: "sha256",
        created_by: ACTOR,
        last_modified_by: ACTOR,
      });
      expect(layout!.blob_ref).toBe(
        `invoice-templates/layouts/INVTPL-WHOLESALE/v1-${digest.slice(0, 12)}/`,
      );
      expect(layout!.blob_ref).toMatch(
        /^invoice-templates\/layouts\/INVTPL-WHOLESALE\/v1-[0-9a-f]{12}\/$/,
      );
      expect(layout!.page_setup).toMatchObject({ format: "A4" });

      const settings = await h.sql`
        SELECT * FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${wholesaleId} AND kind = 'generated'`;
      expect(settings).toHaveLength(1);
      expect(settings[0]).toMatchObject({
        status: "DRAFT",
        version_no: 1,
        ref_layout_version_id: result.versionId,
        created_by: ACTOR,
        last_modified_by: ACTOR,
      });
      expect(settings[0]!.structure).toEqual({
        sections: { payment: true },
        columns: {},
        footnote: [...SEEDED_FOOTNOTE],
      });

      // Every file of the package, under the content-addressed directory.
      const dir = `layouts/INVTPL-WHOLESALE/v1-${digest.slice(0, 12)}/`;
      const stored = await blobs(dir);
      expect([...stored.keys()].sort()).toEqual(
        [...built.files.keys()].map((n) => `${dir}${n}`).sort(),
      );
      for (const [name, bytes] of built.files) {
        const got = await h
          .templates()
          .getBlobClient(`${dir}${name}`)
          .downloadToBuffer();
        expect(sha256(got)).toBe(sha256(bytes));
      }

      const audit = await h.sql<
        {
          target_id: string;
          actor_user_id: string;
          after_data: Record<string, unknown>;
        }[]
      >`
        SELECT target_id, actor_user_id, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_LAYOUT_UPLOADED'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        target_id: result.versionId,
        actor_user_id: ACTOR,
      });
      expect(audit[0]!.after_data).toMatchObject({
        familyId: wholesaleId,
        versionNo: 1,
        replaced: false,
        checksum: digest,
        fileCount: built.files.size,
        settingsDraftId: settings[0]!.bill_template_version_id,
      });
    });

    it("a second upload while the layout draft is open is DRAFT_CHANGED_SINCE_WARNING and writes nothing", async () => {
      const before = await counts(wholesaleId, "layouts/INVTPL-WHOLESALE/");
      const render = vi.fn(cleanRender());
      const result = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: wholesalePackage({ layoutVersion: 2 }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render },
      );
      expect(result).toEqual({
        ok: false,
        code: "DRAFT_CHANGED_SINCE_WARNING",
        problems: [],
      });
      // Refused before the gate runs.
      expect(render).not.toHaveBeenCalled();
      expect(await counts(wholesaleId, "layouts/INVTPL-WHOLESALE/")).toEqual(
        before,
      );
    });

    it("bm80 — a second upload carrying the open draft's { versionId, lastModified } overwrites it in place", async () => {
      const open = await billTemplateVersionRepository.findDraft(h.db, {
        kind: "layout",
        familyId: wholesaleId,
      });
      if (!open) throw new Error("no layout draft");
      const built = wholesalePackage({
        edit: (f) =>
          replaceInFile(
            f,
            "partials/header.hbs",
            "<h1>Invoice</h1>",
            "<h1>Invoice (rev)</h1>",
          ),
      });
      const result = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: built.zip,
          expectedDraft: {
            versionId: open.billTemplateVersionId,
            lastModified: open.token,
          },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(result).toEqual({
        ok: true,
        versionId: open.billTemplateVersionId,
        versionNo: 1,
        replaced: true,
      });
      const [layout] = await h.sql`
        SELECT checksum, status FROM billing.bill_template_version
        WHERE bill_template_version_id = ${open.billTemplateVersionId}`;
      expect(layout).toMatchObject({
        status: "DRAFT",
        checksum: sha256(built.indexBytes!),
      });
    });

    it("an open settings DRAFT is re-pointed at the new layout DRAFT, bumping its token (Inv #62)", async () => {
      // A type with an ACTIVE layout v1 and a settings DRAFT on it.
      const typeId = "BTF00000078";
      await insertTemplateTypeFixture(h.sql, {
        typeId,
        code: "BM78_REPOINT",
        name: "BM78 Repoint",
        layoutVersionId: "BTV00000078",
      });
      await h.sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, created_by,
           last_modified_by, last_modified_datetime)
        SELECT 'BTV00000079', 'INVOICE', 'generated', 1, 'DRAFT', false,
               'BTV00000078', ${typeId}, structure, ${ACTOR}, ${ACTOR},
               now() - interval '1 hour'
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      const draftBefore = await billTemplateVersionRepository.findDraft(h.db, {
        kind: "generated",
        familyId: typeId,
      });
      expect(draftBefore?.refLayoutVersionId).toBe("BTV00000078");

      const result = await uploadLayoutPackage(
        {
          familyId: typeId,
          zip: buildLayoutPackage({
            layoutCode: "INVTPL-BM78_REPOINT",
            layoutVersion: 2,
          }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(result).toMatchObject({ ok: true, versionNo: 2 });
      if (!result.ok) return;

      const draftAfter = await billTemplateVersionRepository.findDraft(h.db, {
        kind: "generated",
        familyId: typeId,
      });
      expect(draftAfter?.billTemplateVersionId).toBe("BTV00000079");
      expect(draftAfter?.refLayoutVersionId).toBe(result.versionId);
      expect(draftAfter?.lastModifiedBy).toBe(ACTOR);
      expect(draftAfter?.token).not.toBe(draftBefore?.token);
      expect(draftAfter!.lastModifiedDatetime.getTime()).toBeGreaterThan(
        draftBefore!.lastModifiedDatetime.getTime(),
      );
      // Re-pointed, not duplicated: still one settings row for the type.
      const [n] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${typeId} AND kind = 'generated'`;
      expect(n!.n).toBe(1);
      const [audit] = await h.sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_LAYOUT_UPLOADED' AND target_id = ${result.versionId}`;
      expect(audit?.after_data).toMatchObject({
        replaced: false,
        settingsDraftId: "BTV00000079",
      });
    });

    it("an upload to a retired type is TEMPLATE_TYPE_RETIRED", async () => {
      const created = await createTemplateType({ name: "Old Type" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      await h.sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE bill_template_family_id = ${created.typeId}`;
      const before = await counts(
        created.typeId,
        `layouts/${created.layoutCode}/`,
      );

      const result = await uploadLayoutPackage(
        {
          familyId: created.typeId,
          zip: buildLayoutPackage({
            layoutCode: created.layoutCode,
            layoutVersion: 1,
          }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(result).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
        problems: [],
      });
      expect(
        await counts(created.typeId, `layouts/${created.layoutCode}/`),
      ).toEqual(before);
    });

    it("a failure after the blob writes leaves orphan blobs and no rows; the same package's retry succeeds and reuses them", async () => {
      const created = await createTemplateType({ name: "Retry" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      expect(created.layoutCode).toBe("INVTPL-RETRY");
      const built = buildLayoutPackage({
        layoutCode: "INVTPL-RETRY",
        layoutVersion: 1,
      });
      const prefix = "layouts/INVTPL-RETRY/";
      const before = await counts(created.typeId, prefix);
      expect(before.blobs).toEqual([]);

      vi.spyOn(
        billTemplateVersionRepository,
        "insertLayoutDraft",
      ).mockRejectedValueOnce(new Error("bm78 forced failure"));
      await expect(
        uploadLayoutPackage(
          {
            familyId: created.typeId,
            zip: built.zip,
            expectedDraft: { none: true },
          },
          ACTOR,
          { render: cleanRender() },
        ),
      ).rejects.toThrow("bm78 forced failure");

      const orphaned = await counts(created.typeId, prefix);
      expect(orphaned.blobs).toHaveLength(built.files.size);
      expect(orphaned.versions).toBe(before.versions);
      expect(orphaned.familyVersions).toBe(0);
      expect(orphaned.audit).toBe(before.audit);
      const orphanEtags = await blobs(prefix);

      const retry = await uploadLayoutPackage(
        {
          familyId: created.typeId,
          zip: built.zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(retry).toMatchObject({ ok: true, versionNo: 1 });
      // The orphans were reused, not rewritten (write-once, returnExisting).
      expect(await blobs(prefix)).toEqual(orphanEtags);
      const [n] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${created.typeId}`;
      expect(n!.n).toBe(2);
    });

    it("review fix (Data rule 9) — a settings structure that fails the schema is never written: no footnote anywhere is SERVER_ERROR with no rows", async () => {
      const created = await createTemplateType({ name: "No Footnote" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      const prefix = "layouts/INVTPL-NO_FOOTNOTE/";
      // A stale catalog: Standard's settings carry no footnote lines.
      await h.sql`ALTER TABLE billing.bill_template_version DISABLE TRIGGER USER`;
      await h.sql`
        UPDATE billing.bill_template_version
        SET structure = jsonb_set(structure, '{footnote}', '[]'::jsonb)
        WHERE kind = 'generated' AND ref_bill_template_family_id = 'BTF00000001'`;
      await h.sql`ALTER TABLE billing.bill_template_version ENABLE TRIGGER USER`;
      try {
        const before = await counts(created.typeId, prefix);
        const result = await uploadLayoutPackage(
          {
            familyId: created.typeId,
            zip: buildLayoutPackage({
              layoutCode: "INVTPL-NO_FOOTNOTE",
              layoutVersion: 1,
            }).zip,
            expectedDraft: { none: true },
          },
          ACTOR,
          { render: cleanRender() },
        );
        expect(result).toEqual({
          ok: false,
          code: "SERVER_ERROR",
          problems: [],
        });
        const after = await counts(created.typeId, prefix);
        expect(after.familyVersions).toBe(0);
        expect(after.audit).toBe(before.audit);
      } finally {
        await h.sql`ALTER TABLE billing.bill_template_version DISABLE TRIGGER USER`;
        await h.sql`
          UPDATE billing.bill_template_version
          SET structure = jsonb_set(structure, '{footnote}', ${JSON.stringify(SEEDED_FOOTNOTE)}::jsonb)
          WHERE kind = 'generated' AND ref_bill_template_family_id = 'BTF00000001'`;
        await h.sql`ALTER TABLE billing.bill_template_version ENABLE TRIGGER USER`;
        for (const name of (await blobs(prefix)).keys()) {
          await h
            .templates()
            .deleteBlob(name)
            .catch(() => undefined);
        }
      }
    });

    // A lazily-built fixture, so `it.each` rows don't build zips at collection.
    function wholesalePackageFixture(opts: LayoutPackageOptions = {}) {
      return () => wholesalePackage(opts);
    }
  },
);
