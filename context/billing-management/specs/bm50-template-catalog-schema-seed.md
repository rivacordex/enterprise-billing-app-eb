# bm50 — Invoice template catalog schema, seed rows, permission row and grants

**Unit:** bm50 (Invoice Template update, Part 4). **Boundary:** schema + grants + seed rows only (workflow rules §4.1 — schema lands alone, before any consumer):

- one hand-written migration `db/migrations/0046_invoice_template_catalog.sql` (+ `meta/_journal.json`)
- Drizzle schema `db/schema/billing/{bill-format,bill-template-version,bill-asset}.ts` + the two new columns in `db/schema/billing/customer-bill.ts`
- grants: `db/bootstrap/bootstrap-db-roles.sql` (`app_runtime`) and `db/bootstrap/billrun-db-roles.sql` (the `billrun_runtime` **revoke**)
- the permission set (minus the nav entry — D7): `auth/permission-constants.ts`, `types/rbac.ts`, `types/permissions.ts`, `db/seeds/billing.ts` (role grants)
- read repositories `db/repositories/billing/{bill-template-version,bill-asset}.ts`
- unions + ID schemas in `types/billing.ts` and `validation/billing/template-version-id.schema.ts`
- the seeded CSV v1 column map (repo file, D5)

**No consumer**: nothing renders from these rows until bm53; no page until bm55.

**Specs from:** Inv #41, #42, #44, #23; code-standards Part 2 data rules 1–3, 5, 6, 10, 11, TS rules 1, 6, file-org rule 4, permission map §8 delta, guardrails 45 (DB half) and 56 (grants half); workflow rules §7.7; platform Inv #6.

**Depends on:** bm49 (layout v1 is final and frozen; its checksums are seeded here).

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G3 / X3 / C3 | **Decided 2026-10-07** | Partial unique index `(ref_bill_format_id, kind) WHERE status = 'ACTIVE' AND NOT is_default`; resolution pinned → non-default ACTIVE → default |
| G7 | **Decided 2026-10-07** | Notes & footer wording are fixed layout text — seeded immutably here; no profile fields |
| G6 / O2 / C4 checksum | **OPEN** (interim) | SHA-256 (hex) for template/asset blobs, with the algorithm recorded per row (`checksum_algorithm`); invoice PDFs keep md5 |
| G10 / O10 retention | **OPEN** (interim) | Nothing deletes a version; the trigger refuses every `DELETE` |
| G11 role grants | **OPEN** (interim) | ADMIN : EDIT, MANAGER : EDIT, USER : READ |
| G12 CSV version column | **OPEN** (interim) | `customer_bill.ref_csv_template_version_id` (code-standards data rule 4) |

> **Build may not start until G6, G10, G11, G12 are recorded as decided.** A migration is permanent; each interim above becomes DDL here.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).**
>
> - Migrations are hand-written (`db/migrations/README.md`: no `drizzle-kit generate`; snapshots stop at `0026`); statements separated by `--> statement-breakpoint`; each needs a `_journal.json` entry whose `when` exceeds the last applied one. Latest is `0044`; `0042` is unused. **bm48 takes `0045`, so this unit is `0046`.**
> - `0043_ratecard_permission.sql` is the permission-row precedent (`INSERT INTO "core"."permissions" … ON CONFLICT ("permission_name") DO NOTHING`). Its header says "role grants are applied by the seed" — **but no seed grants `ratecard`**. The working template for role grants is `db/seeds/billing.ts` (`REVENUE_OPS_ROLES`, `ADMIN_GRANTS` `:28-35`, `resolvePermissionIds` `:37`, `grant()` upsert `:65-97`).
> - `app_runtime`'s billing grants are per-table in **`db/bootstrap/bootstrap-db-roles.sql`** (`:148-198`); there is no `app-db-roles` file. `billrun_runtime`'s Step 5 (`billrun-db-roles.sql:122-134`) grants column `INSERT`/`UPDATE` on `ref_bill_format_id`, `ref_bill_template_version_id`. **No flow, Python or app code writes either column today** (repo-wide grep: only the bootstrap file, `0029`, the schema and `tests/db/customer-bill-schema.test.ts`), so the revoke breaks no writer.
> - ID convention: `billing.sequence(…)` + `DEFAULT 'PFX' || lpad(nextval(…)::text, 8, '0')` (`customer-bill-line.ts:29-38`, `0039:8-11`); a Zod regex per ID (`validation/product/ratecard.schema.ts:28`).
> - `PERMISSIONS` (`auth/permission-constants.ts:6-22`), `PERMISSION_NAMES` (`types/rbac.ts:1-17`), `OptionalPermissionName` (`types/permissions.ts:10-19`) — **all three** need the new name.
> - `core.system_config` already has `config_version`, `status IN ('DRAFT','ACTIVE','RETIRED')`, UNIQUE `(config_group, config_version, config_key)`. The `invoice.profile` group needs no DDL.

## Goal

Create the four `billing` catalog tables with the database-enforced version rules, the two new `customer_bill` stamp columns, the seed rows for `INVOICE`, layout `INVTPL-STD-A4` v1, the default generated v1 and CSV v1 (each with the SHA-256 of its repo files), the `invoice_settings` permission set and the grants — so that on a fresh database `bill_format` has exactly one row, the default layout and generated versions are ACTIVE with `is_default = true`, the trigger refuses to retire or delete them, and `information_schema` shows the exact grant set.

## Design

### D1 — Tables (all `billing`, none partitioned)

```sql
CREATE TABLE "billing"."bill_format" (
  "bill_format_id" text PRIMARY KEY CHECK ("bill_format_id" IN ('INVOICE')),
  "name" text NOT NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE "billing"."bill_template_version_seq" START 1;
CREATE TABLE "billing"."bill_template_version" (
  "bill_template_version_id" text PRIMARY KEY DEFAULT 'BTV' || lpad(nextval('billing.bill_template_version_seq')::text, 8, '0'),
  "ref_bill_format_id"   text NOT NULL REFERENCES "billing"."bill_format"("bill_format_id"),
  "kind"                 text NOT NULL CHECK ("kind" IN ('layout','generated','csv')),
  "version_no"           integer NOT NULL CHECK ("version_no" >= 1),
  "status"               text NOT NULL CHECK ("status" IN ('DRAFT','ACTIVE','RETIRED')),
  "is_default"           boolean NOT NULL DEFAULT false,
  "layout_code"          text,                       -- kind = 'layout'
  "ref_layout_version_id" text REFERENCES "billing"."bill_template_version"("bill_template_version_id"), -- kind = 'generated'
  "structure"            jsonb,                      -- kind = 'generated'
  "page_setup"           jsonb,                      -- kind = 'layout'
  "blob_ref"             text,                       -- directory prefix, e.g. invoice-templates/layouts/INVTPL-STD-A4/v1/
  "checksum"             text,                       -- hex digest of the version's checksums.json (D3)
  "checksum_algorithm"   text CHECK ("checksum_algorithm" IN ('sha256')), -- G6 interim
  "change_note"          text,
  "created_by"           text REFERENCES "core"."appuser"("id") ON DELETE SET NULL,
  "created_datetime"     timestamptz NOT NULL DEFAULT now(),
  "activated_by"         text REFERENCES "core"."appuser"("id") ON DELETE SET NULL,
  "activated_datetime"   timestamptz,
  "retired_datetime"     timestamptz,
  "last_modified_datetime" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "btv_version_uq" UNIQUE ("ref_bill_format_id", "kind", "version_no"),
  CONSTRAINT "btv_files_when_not_draft" CHECK ("status" = 'DRAFT' OR ("blob_ref" IS NOT NULL AND "checksum" IS NOT NULL AND "checksum_algorithm" IS NOT NULL AND "activated_datetime" IS NOT NULL)),
  CONSTRAINT "btv_draft_has_no_files" CHECK ("status" <> 'DRAFT' OR ("blob_ref" IS NULL AND "checksum" IS NULL)),
  CONSTRAINT "btv_change_note" CHECK ("status" = 'DRAFT' OR length(btrim(coalesce("change_note", ''))) > 0),
  CONSTRAINT "btv_generated_has_layout" CHECK ("kind" <> 'generated' OR ("ref_layout_version_id" IS NOT NULL AND "structure" IS NOT NULL)),
  CONSTRAINT "btv_layout_has_code" CHECK ("kind" <> 'layout' OR ("layout_code" IS NOT NULL AND "page_setup" IS NOT NULL)),
  CONSTRAINT "btv_draft_only_generated" CHECK ("status" <> 'DRAFT' OR "kind" = 'generated'),
  CONSTRAINT "btv_default_not_draft" CHECK (NOT "is_default" OR "status" = 'ACTIVE')
);
CREATE UNIQUE INDEX "btv_one_active_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "status" = 'ACTIVE' AND NOT "is_default";                       -- G3 / C3
CREATE UNIQUE INDEX "btv_one_default_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "is_default";
CREATE UNIQUE INDEX "btv_one_draft_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
  WHERE "status" = 'DRAFT';                                             -- one working draft per kind (bm57/bm58)
CREATE INDEX "btv_layout_ref_idx" ON "billing"."bill_template_version" ("ref_layout_version_id");

CREATE SEQUENCE "billing"."bill_asset_seq" START 1;
CREATE TABLE "billing"."bill_asset" (
  "bill_asset_id" text PRIMARY KEY DEFAULT 'INVAST' || lpad(nextval('billing.bill_asset_seq')::text, 8, '0'),
  "kind" text NOT NULL CHECK ("kind" IN ('logo')),
  "name" text NOT NULL,
  "created_by" text REFERENCES "core"."appuser"("id") ON DELETE SET NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE "billing"."bill_asset_version_seq" START 1;
CREATE TABLE "billing"."bill_asset_version" (
  "bill_asset_version_id" text PRIMARY KEY DEFAULT 'INVASV' || lpad(nextval('billing.bill_asset_version_seq')::text, 8, '0'),
  "ref_bill_asset_id" text NOT NULL REFERENCES "billing"."bill_asset"("bill_asset_id"),
  "version_no" integer NOT NULL CHECK ("version_no" >= 1),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','RETIRED')),
  "mime" text NOT NULL CHECK ("mime" IN ('image/png','image/jpeg','image/svg+xml')),
  "width" integer NOT NULL CHECK ("width" > 0), "height" integer NOT NULL CHECK ("height" > 0),
  "byte_size" integer NOT NULL CHECK ("byte_size" BETWEEN 1 AND 512000),
  "blob_ref" text NOT NULL, "checksum" text NOT NULL,
  "checksum_algorithm" text NOT NULL CHECK ("checksum_algorithm" IN ('sha256')),
  "created_by" text REFERENCES "core"."appuser"("id") ON DELETE SET NULL,
  "created_datetime" timestamptz NOT NULL DEFAULT now(),
  "retired_datetime" timestamptz,
  CONSTRAINT "basv_version_uq" UNIQUE ("ref_bill_asset_id", "version_no")
);
```

Notes:

- `bill_format_id` is its own code (no sequence) because `customer_bill.ref_bill_format_id` is stamped with the literal `'INVOICE'` (code-standards TS rule 6). The CHECK pins it to one value (D1 of the plan); a credit-note format would be a new migration.
- **Only `generated` may be DRAFT** (`btv_draft_only_generated`): layouts are developer-seeded, CSV maps are system-seeded.
- `byte_size ≤ 512000` mirrors the 500 KB logo cap (Inv #48) in the DB as a backstop.
- Asset versions have no DRAFT: an uploaded logo is a finished artifact; what is "draft" is the profile that points at it (bm60).
- `customer_bill` stamps carry **no FK** to these tables (partitioned table + the established plain-key rule for stamps; `0029` precedent). Integrity comes from being written only by `stampPosted` from resolved rows (bm54).

### D2 — The version-rules trigger (`DEFAULT_VERSION_IMMUTABLE`)

`billing.bill_template_version_guard()` — `BEFORE UPDATE OR DELETE … FOR EACH ROW`:

- `DELETE` → `RAISE EXCEPTION 'VERSION_DELETE_FORBIDDEN' USING ERRCODE = '23001'` (G10 interim: nothing deletes a version).
- `UPDATE` where `OLD.is_default` → `RAISE … 'DEFAULT_VERSION_IMMUTABLE'` for **any** change (status, files, structure).
- Allowed transitions only:
  1. `DRAFT → DRAFT`: only `structure`, `change_note` and `last_modified_datetime` may change.
  2. `DRAFT → ACTIVE`: sets `blob_ref`, `checksum`, `checksum_algorithm`, `activated_by`, `activated_datetime`, `change_note`; `kind`, `version_no`, `ref_*`, `structure` unchanged. This is the path bm58 uses: activation promotes the single working DRAFT (`btv_one_draft_uq`) in place, so it keeps its `version_no`.
  3. `ACTIVE → RETIRED`: only `status`, `retired_datetime`, `last_modified_datetime` change.
- Everything else (`RETIRED → *`, `ACTIVE → DRAFT`, any change to `kind`/`version_no`/`blob_ref`/`checksum` of a non-DRAFT row) → `RAISE … 'VERSION_IMMUTABLE'`.

`billing.bill_asset_version_guard()`: refuses `DELETE` and any `UPDATE` other than `ACTIVE → RETIRED` (+ `retired_datetime`). `bill_asset` and `bill_format`: refuse `DELETE`; `bill_format` refuses `UPDATE` too.

Messages begin with the binding code so the app maps the SQLSTATE + message prefix to the typed `AppError` (`DEFAULT_VERSION_IMMUTABLE` is binding, code-standards TS rule 7; `VERSION_IMMUTABLE` and `VERSION_DELETE_FORBIDDEN` are new — **add them to code-standards first**, workflow rules §7.8).

### D3 — Multi-file versions: one checksum over a checksum index

A layout version is ~15 files; a generated version is 3; CSV is 1. The row holds one `blob_ref` (the directory prefix) and one `checksum`. Each version directory carries a **`checksums.json`** index:

```json
{ "algorithm": "sha256", "files": { "manifest.json": "<hex>", "shell.hbs": "<hex>", "footer.hbs": "<hex>", "partials/header.hbs": "<hex>", … } }
```

with keys sorted, two-space indentation, LF, trailing newline (canonical bytes). The row's `checksum` = SHA-256 of those exact bytes. `load()` (bm53) verifies `checksums.json` against the row, then every file it reads against the index — so a one-byte change to any file, or to the index, fails the load (Inv #45, guardrail 47). `checksums.json` is generated by a repo script, never hand-edited:

`scripts/invoice-templates/write-checksums.ts <dir>` → writes `<dir>/checksums.json` and prints the index digest.

### D4 — Seed rows (in the migration)

```sql
INSERT INTO billing.bill_format (bill_format_id, name) VALUES ('INVOICE', 'Tax invoice');

-- layout v1 (developer-owned; default; ACTIVE; immutable)
INSERT INTO billing.bill_template_version (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
  layout_code, page_setup, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
VALUES ('BTV00000001', 'INVOICE', 'layout', 1, 'ACTIVE', true, 'INVTPL-STD-A4', '<manifest pageSetup json>',
  'invoice-templates/layouts/INVTPL-STD-A4/v1/', '<sha256 of layouts/…/v1/checksums.json>', 'sha256',
  'Seeded default layout INVTPL-STD-A4 v1 (bm50).', now());

-- default generated v1 (all optional sections and columns on; default; ACTIVE; immutable)
… ('BTV00000002', 'INVOICE', 'generated', 1, 'ACTIVE', true, NULL, 'BTV00000001', '<structure.json>', …
  'invoice-templates/generated/INVOICE/v1/', '<sha256 of generated/INVOICE/v1/checksums.json>', 'sha256', 'Seeded default generated template v1 (bm50).', now());

-- CSV v1 (system column map; default; ACTIVE; immutable)
… ('BTV00000003', 'INVOICE', 'csv', 1, 'ACTIVE', true, …, 'invoice-templates/system/csv/v1/', '<sha256 of system/csv/v1/checksums.json>', 'sha256', 'Seeded CSV column map v1 (bm50).', now());

SELECT setval('billing.bill_template_version_seq', 3);
```

- Explicit IDs keep the seed deterministic across environments; `setval` moves the sequence past them.
- `created_by`/`activated_by` are `NULL` (system seed); the CHECKs do not require them.
- The digests are **literal hex strings** pasted from `write-checksums.ts` output into the migration. A unit test (D8) recomputes them from the repo files and fails if they differ — the migration and the files can't drift.
- The `structure` literal for generated v1 is `{"sections": {all nine InvoiceSectionKey: true}, "columns": {all four: true}}` — validated by the bm55 Zod schema later; a bm50 test asserts it parses under a local copy of the union.

### D5 — CSV v1 column map (repo file, seeded here, immutable)

`db/seeds/invoice-templates/system/csv/v1/invoice.csv.columns.json` — **replaces** the planning sample, which carries per-line tax columns (R6 forbids) and `po_reference` (G9 interim: no source):

```json
{
  "templateId": "INVTPL-CSV-LINES", "version": 1,
  "rowSource": "lines", "encoding": "utf-8-bom", "lineEnding": "CRLF",
  "columns": [
    { "header": "invoice_number",       "path": "invoice.number" },
    { "header": "invoice_date",         "path": "invoice.date" },
    { "header": "billing_period_start", "path": "invoice.periodStart" },
    { "header": "billing_period_end",   "path": "invoice.periodEnd" },
    { "header": "payment_due_date",     "path": "invoice.dueDate" },
    { "header": "currency",             "path": "invoice.currency" },
    { "header": "supplier_name",        "path": "company.name" },
    { "header": "supplier_tin",         "path": "company.tin" },
    { "header": "supplier_sst_no",      "path": "company.sstRegNo" },
    { "header": "billing_account_id",   "path": "customer.billingAccountId" },
    { "header": "customer_name",        "path": "customer.name" },
    { "header": "customer_tin",         "path": "customer.tin" },
    { "header": "line_no",              "path": "line.lineNo" },
    { "header": "charge_type",          "path": "line.source" },
    { "header": "product_offering_id",  "path": "line.productOfferingId" },
    { "header": "description",          "path": "line.description" },
    { "header": "udr_type",             "path": "line.udrType" },
    { "header": "udr_count",            "path": "line.udrCount" },
    { "header": "service_period_start", "path": "line.periodStart" },
    { "header": "service_period_end",   "path": "line.periodEnd" },
    { "header": "quantity",             "path": "line.quantity" },
    { "header": "unit",                 "path": "line.unit" },
    { "header": "unit_price",           "path": "line.unitPrice" },
    { "header": "gross_amount",         "path": "line.grossAmount" },
    { "header": "discount_amount",      "path": "line.discountAmount" },
    { "header": "net_amount",           "path": "line.netAmount" }
  ]
}
```

`path` is a dotted lookup into `{ ...InvoiceRenderInput, line }` — **not** a Handlebars expression (no template evaluation in CSV; bm62 resolves paths with a 10-line pure function). `null` → empty cell. Per-line tax columns are absent (Inv #50).

### D6 — `customer_bill` stamp columns (G12 interim)

```sql
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_invoice_profile_version" integer;
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_csv_template_version_id" text;
```

On the partitioned parent (propagates). Nullable, no FK (D1 note). **Not** granted to `billrun_runtime` in any form. `app_runtime` already updates `customer_bill` through `stampPosted` — verify its grant covers the new columns (if `app_runtime` has column-scoped `UPDATE` on `customer_bill`, extend the list with `ref_bill_format_id`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id`; if table-level, nothing to add — record which in the PR).

### D7 — The permission set (moves as one, minus nav)

| Item | Change |
| --- | --- |
| Migration row | `INSERT INTO "core"."permissions" ("permission_name","permission_info") VALUES ('invoice_settings', 'Controls access to Administration › Invoice Settings: view and edit the company profile and invoice template, upload the invoice logo, and activate versions (read and edit only — no delete).') ON CONFLICT ("permission_name") DO NOTHING;` |
| `auth/permission-constants.ts` | `INVOICE_SETTINGS: "invoice_settings"` |
| `types/rbac.ts` | `"invoice_settings"` in `PERMISSION_NAMES` |
| `types/permissions.ts` | `"invoice_settings"` in `OptionalPermissionName` |
| Role grants (G11 interim) | `db/seeds/billing.ts`: grant `invoice_settings` ADMIN `EDIT`, MANAGER `EDIT`, USER `READ` through the existing `grant()` upsert (idempotent; `db:seed-billing` already runs in `db:setup`). Not in the migration (the `0043` precedent), but **actually implemented** — unlike `ratecard`, whose grants no seed applies (raise a separate known-issue for that gap; do not fix it here). |
| Map rows | Architecture §4 permission table + code-standards §8 — add the `invoice_settings` row (READ / EDIT, no DELETE). |
| **Deferred:** `NAV_REGISTRY` + `NAV_ICONS` | **bm55.** `nav-registry-guard.test.ts` requires every registry entry to point at a real page, and there is no page until bm55. This is the one sanctioned split of "the permission map moves as one" (workflow rules §7.7) — recorded here and in the bm55 spec. |

### D8 — Grants

`db/bootstrap/bootstrap-db-roles.sql` (`app_runtime`, billing section `:148-198`, per table — Inv #23):

```sql
GRANT SELECT ON TABLE "billing"."bill_format" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE "billing"."bill_template_version", "billing"."bill_asset", "billing"."bill_asset_version" TO app_runtime;
GRANT USAGE ON SEQUENCE "billing"."bill_template_version_seq", "billing"."bill_asset_seq", "billing"."bill_asset_version_seq" TO app_runtime;
-- no DELETE on any of the four (Inv #44)
```

`db/bootstrap/billrun-db-roles.sql` Step 5 (Inv #41):

- Remove `"ref_bill_format_id","ref_bill_template_version_id"` from the column lists of the `GRANT INSERT (…)` and `GRANT UPDATE (…)` statements.
- Add, for already-bootstrapped databases (idempotent):
  ```sql
  REVOKE INSERT ("ref_bill_format_id","ref_bill_template_version_id"), UPDATE ("ref_bill_format_id","ref_bill_template_version_id")
    ON TABLE "billing"."customer_bill" FROM billrun_runtime;
  ```
- Add an explicit `REVOKE ALL ON TABLE "billing"."bill_format", "billing"."bill_template_version", "billing"."bill_asset", "billing"."bill_asset_version" FROM billrun_runtime;` (belt-and-braces; it never had any).

Both bootstrap files are **protected** (workflow rules §6.1): this spec is the explicit instruction; the PR must name both edits. Update `infra/docs/db-role-verification.md` with the re-run order (`db:bootstrap-roles` → `db:bootstrap-billrun-roles` after `db:migrate`) for the cutover.

### D9 — Repositories (read-only in this unit)

- `billTemplateVersionRepository`: `findById(db, id)`, `findActive(db, { kind })` (the non-default ACTIVE row or `null`), `findDefault(db, { kind })`, `listForKind(db, { kind })` (history, newest first, with `used_by_count` = `count(*)` of `customer_bill` rows stamped with the id — via a `LEFT JOIN LATERAL` on `ref_bill_template_version_id` / `ref_csv_template_version_id`), `nextVersionNo(tx, { kind })`: `max(version_no) + 1` after `SELECT pg_advisory_xact_lock(hashtext('billing.bill_template_version:INVOICE:' || kind))`. It uses an advisory lock, not `FOR UPDATE` on `bill_format`, because `app_runtime` has only `SELECT` there and `FOR UPDATE` needs `UPDATE` privilege. `btv_version_uq` is the backstop.
- `billAssetRepository`: `findVersionById(db, id)`, `listVersions(db, assetId)`.

Writes arrive with their units (bm57, bm58, bm60). Rows map to types via Drizzle; jsonb columns typed `.$type<…>()` (`structure` → the bm55 Zod type is not yet available: type as `InvoiceTemplateStructure` declared in `types/billing.ts` now, schema in bm55).

### D10 — Unions and ID schemas

`types/billing.ts`: `BILL_FORMAT_CODES = ['INVOICE']`, `TEMPLATE_KINDS = ['layout','generated','csv']` (**no `xml`**), `TemplateVersionStatus` (reuse `types/system-config.ts`'s `DRAFT|ACTIVE|RETIRED` union if exported; otherwise declare once here and re-export from there), `BILL_ASSET_KINDS = ['logo']`, `InvoiceSectionKey`, `InvoiceOptionalSectionKey`, `InvoiceColumnKey` (bm47 already added the section/column unions for guardrail 49 — reuse). `validation/billing/template-version-id.schema.ts`: `^BTV\d{8}$`, `^INVAST\d{8}$`, `^INVASV\d{8}$`.

## Implementation

1. Run `scripts/invoice-templates/write-checksums.ts` on `db/seeds/invoice-templates/INVTPL-STD-A4/v1/`, `…/generated/INVOICE/v1/`, `…/system/csv/v1/`; commit the three `checksums.json`.
2. Write `0046_invoice_template_catalog.sql` (D1, D2, D4, D6, D7 row) with the three digests; add the journal entry.
3. Drizzle: `bill-format.ts`, `bill-template-version.ts`, `bill-asset.ts` (both asset tables), the two `customer-bill.ts` columns; export from `db/schema/billing/index.ts`.
4. Grants (D8) + `db-role-verification.md`.
5. Permission set (D7) + the `db/seeds/billing.ts` grants.
6. Repositories (D9), unions + ID schemas (D10).
7. Tests (below).

### Tests

| Test | Covers |
| --- | --- |
| `tests/db/invoice-template-catalog.integration.test.ts` (new) | fresh DB: `bill_format` = exactly `[INVOICE]`; BTV00000001 layout / 00000002 generated / 00000003 csv all `ACTIVE`, `is_default`; one non-default ACTIVE per kind allowed alongside the default, a second refused (`btv_one_active_uq`); a second DRAFT per kind refused (`btv_one_draft_uq`); a second default refused; CHECKs: DRAFT with files refused, ACTIVE without note refused, generated without layout refused, layout DRAFT refused |
| same file — **guardrail 45 (DB half)** | `UPDATE … SET status='RETIRED'` on either default → `DEFAULT_VERSION_IMMUTABLE`; `DELETE` → `VERSION_DELETE_FORBIDDEN`; `RETIRED → ACTIVE` refused; DRAFT `structure` edit allowed; ACTIVE `structure` edit refused |
| `tests/db/invoice-template-seed-checksums.test.ts` (new) | recompute each repo `checksums.json` from the files and its SHA-256; equal to the migration's literal digests |
| `tests/guardrails/invoice-settings-grants.test.ts` (new — **guardrail 56, grants half**) | over `information_schema.role_table_grants` / `column_privileges`: `app_runtime` has SELECT on `bill_format`, SELECT/INSERT/UPDATE on the other three, **no DELETE** on any; `billrun_runtime` has nothing on the four tables and no INSERT/UPDATE on `ref_bill_format_id`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id` |
| `tests/db/customer-bill-schema.test.ts` (update) | the two new nullable columns; the reserved-column comments updated ("stamped at posting by the app, bm54") |
| `tests/auth/permission-registry.test.ts` (extend existing or new) | `PERMISSIONS.INVOICE_SETTINGS`, `PermissionName`, `OptionalPermissionName` all include it; the migration row exists after `db:migrate`; after `db:seed-billing` ADMIN/MANAGER have EDIT, USER READ |
| `tests/guardrails/invoice-manifest-parity.test.ts` (extend) | seeded `structure` of BTV00000002 has exactly the union keys, all `true` |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm49 (layout v1 frozen). bm48 owns `0045`.
- **Downstream:** bm53 (uploads the files and resolves these rows), bm54 (stamps), bm55+ (pages, permission use).

## Verification checklist

- [ ] `0046` applies on a fresh DB after `0045`; `_journal.json` entry present; `db:migrate` idempotent on re-run.
- [ ] `bill_format` has exactly one row; the three seeded versions are ACTIVE + `is_default` with SHA-256 digests matching the repo files.
- [ ] The trigger refuses retiring/deleting a default (`DEFAULT_VERSION_IMMUTABLE`) and any other illegal transition.
- [ ] Grant assertions over `information_schema` pass (guardrail 56 grants half); `billrun_runtime` lost both reserved-column grants; a processing run on the `ci` seed still completes (it never wrote them).
- [ ] `invoice_settings` exists in the DB, in `PERMISSIONS`, `PermissionName`, `OptionalPermissionName`; seeded role grants applied by `db:seed-billing`; **no** nav entry yet (`nav-registry-guard` green).
- [ ] No consumer reads the new tables (grep: only the repositories and tests).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` (incl. integration) green.
- [ ] Docs, same change set: X3 closed (architecture conflict table, overview open items, code-standards C3 → "decided"); the G6/G10/G11/G12 resolutions recorded in all three places once decided; architecture §3 storage table + §4 permission table; code-standards §8 row + TS rule 7 additions (`VERSION_IMMUTABLE`, `VERSION_DELETE_FORBIDDEN`) + data rule 2 (`checksum_algorithm`, `checksums.json` index); `billmgmt-known-issues.md` gains "ratecard role grants are not seeded" (observed, not fixed); progress tracker.
