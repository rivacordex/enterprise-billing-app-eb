# bm50 — Invoice template catalog schema, seed rows, permission row and grants

**Unit:** bm50 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-08, commits `ab736a3`, `e41c488` · **Boundary:** schema + grants + seed rows only (workflow rules §4.1 — schema lands alone, before any consumer)
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm50-template-catalog-schema-seed.md` in this repo; the codebase copy keeps the full text._

## Goal

Create the four `billing` catalog tables with DB-enforced version rules, the two new `customer_bill` stamp columns, the seed rows (`INVOICE`, layout `INVTPL-STD-A4` v1, default generated v1, CSV v1, each with the SHA-256 of its repo files), the `invoice_settings` permission set and the grants. No consumer in this unit (bm53 renders from the rows; bm55 adds the first page). Specs from Inv #41, #42, #44, #23; depends on bm49 (layout v1 frozen).

## As built

- **Gates.** G3/X3/C3 and G7 decided 2026-10-07; G6/O2/C4 (SHA-256 + `checksum_algorithm`, invoice PDFs keep md5), G10/O10 (nothing deletes a version), G11 (ADMIN/MANAGER `EDIT`, USER `READ`) and G12 (`customer_bill.ref_csv_template_version_id`) were built to interim and recorded "Decided and delivered" by bm50 (2026-10-08).
- **Migration `0046_invoice_template_catalog.sql`** (hand-written, `--> statement-breakpoint`, `_journal.json` entry; `0045` belongs to bm48, `0042` unused).
- **Tables (all `billing`, none partitioned):**
  - `bill_format` — `bill_format_id` text PK `CHECK (bill_format_id IN ('INVOICE'))` (its own code, no sequence; stamped as the literal `'INVOICE'`), `name`, `created_datetime`.
  - `bill_template_version` — `bill_template_version_id` `'BTV' || lpad(nextval('billing.bill_template_version_seq'),8,'0')`; `ref_bill_format_id`, `kind IN ('layout','generated','csv')`, `version_no >= 1`, `status IN ('DRAFT','ACTIVE','RETIRED')`, `is_default`, `layout_code` (layout), `ref_layout_version_id` (generated, self-FK), `structure` jsonb (generated), `page_setup` jsonb (layout), `blob_ref` (directory prefix), `checksum`, `checksum_algorithm IN ('sha256')`, `change_note`, `created_by`/`activated_by` (FK `core.appuser`, `ON DELETE SET NULL`), `created_datetime`, `activated_datetime`, `retired_datetime`, `last_modified_datetime`.
  - Constraints: `btv_version_uq UNIQUE (ref_bill_format_id, kind, version_no)`; `btv_files_when_not_draft`; `btv_draft_has_no_files`; `btv_change_note` (non-DRAFT needs a non-blank note); `btv_generated_has_layout`; `btv_layout_has_code`; `btv_draft_only_generated`; `btv_default_not_draft` (`NOT is_default OR status = 'ACTIVE'`).
  - Indexes:
    ```sql
    CREATE UNIQUE INDEX "btv_one_active_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind")
      WHERE "status" = 'ACTIVE' AND NOT "is_default";   -- G3 / C3
    CREATE UNIQUE INDEX "btv_one_default_uq" ON "billing"."bill_template_version" ("ref_bill_format_id", "kind") WHERE "is_default";
    CREATE UNIQUE INDEX "btv_one_draft_uq"   ON "billing"."bill_template_version" ("ref_bill_format_id", "kind") WHERE "status" = 'DRAFT';
    CREATE INDEX "btv_layout_ref_idx" ON "billing"."bill_template_version" ("ref_layout_version_id");
    ```
  - `bill_asset` (`INVAST` + 8, `kind IN ('logo')`, `name`) and `bill_asset_version` (`INVASV` + 8, `version_no`, `status` ACTIVE/RETIRED default ACTIVE, `mime IN ('image/png','image/jpeg','image/svg+xml')`, `width`, `height`, `byte_size BETWEEN 1 AND 512000` (Inv #48 backstop), `blob_ref`, `checksum`, `checksum_algorithm`, `basv_version_uq UNIQUE (ref_bill_asset_id, version_no)`). Asset versions have no DRAFT.
- **Guard triggers.** `billing.bill_template_version_guard()` (`BEFORE UPDATE OR DELETE`): `DELETE` → `VERSION_DELETE_FORBIDDEN` (ERRCODE `23001`); any `UPDATE` of an `is_default` row → `DEFAULT_VERSION_IMMUTABLE`; allowed only `DRAFT → DRAFT` (`structure`, `change_note`, `last_modified_datetime`), `DRAFT → ACTIVE` (sets files, activation stamps, note; promotes the single working draft in place, keeping `version_no` — the bm58 path), `ACTIVE → RETIRED` (`status`, `retired_datetime`, `last_modified_datetime`); everything else → `VERSION_IMMUTABLE`. `bill_asset_version_guard()` allows only `ACTIVE → RETIRED`; `bill_asset`/`bill_format` refuse `DELETE`, `bill_format` refuses `UPDATE`. Messages start with the binding code, mapped to typed `AppError`.
- **Checksum model (D3).** One `blob_ref` + one `checksum` per row. Each version directory has a canonical `checksums.json` (`{ "algorithm": "sha256", "files": { … } }`, keys sorted, 2-space, LF, trailing newline); the row's `checksum` is the SHA-256 of that index. `load()` (bm53) verifies the index, then each file. Generated only by `scripts/invoice-templates/write-checksums.ts <dir>`.
- **Seed rows (D4)**, explicit IDs then `setval('billing.bill_template_version_seq', 3)`; `created_by`/`activated_by` NULL:
  - `INVOICE` / "Tax invoice".
  - `BTV00000001` layout `INVTPL-STD-A4` v1, `invoice-templates/layouts/INVTPL-STD-A4/v1/`.
  - `BTV00000002` default generated v1 (`ref_layout_version_id = BTV00000001`, all optional sections and columns `true`), `invoice-templates/generated/INVOICE/v1/`.
  - `BTV00000003` CSV v1, `invoice-templates/system/csv/v1/`.
  - All `ACTIVE`, `is_default = true`; digests are literal hex in the migration, checked by a test against the repo files.
- **CSV v1 column map (D5)** `db/seeds/invoice-templates/system/csv/v1/invoice.csv.columns.json`: `templateId` `INVTPL-CSV-LINES`, `rowSource: "lines"`, `utf-8-bom`, `CRLF`, 26 columns from `invoice_number` … `net_amount` as dotted `path` lookups into `{ ...InvoiceRenderInput, line }` (not Handlebars; `null` → empty). No per-line tax columns (Inv #50/R6) and no `po_reference` (G9).
- **`customer_bill` (D6):** `ref_invoice_profile_version integer`, `ref_csv_template_version_id text` on the partitioned parent; nullable, **no FK** (plain-key stamp rule, `0029` precedent); never granted to `billrun_runtime`.
- **Permission set (D7):** `core.permissions` row `invoice_settings` (`ON CONFLICT DO NOTHING`, `0043` precedent); `PERMISSIONS.INVOICE_SETTINGS`, `PERMISSION_NAMES`, `OptionalPermissionName`; role grants in `db/seeds/billing.ts` via `grant()` (ADMIN/MANAGER `EDIT`, USER `READ`). `NAV_REGISTRY`/`NAV_ICONS` deferred to bm55 (the one sanctioned split of workflow rules §7.7).
- **Grants (D8, Inv #23, #41):** `app_runtime` — `SELECT` on `bill_format`; `SELECT, INSERT, UPDATE` on `bill_template_version`, `bill_asset`, `bill_asset_version`; `USAGE` on the three sequences; no `DELETE`. `billrun_runtime` — `ref_bill_format_id`/`ref_bill_template_version_id` removed from Step 5 column grants, plus an idempotent `REVOKE INSERT (…), UPDATE (…) ON billing.customer_bill` and `REVOKE ALL` on the four tables. No writer of those columns existed, so the revoke broke nothing.
- **Repositories (D9, read-only):** `billTemplateVersionRepository.findById`, `findActive` (non-default ACTIVE or `null`), `findDefault`, `listForKind` (with `used_by_count` via `LEFT JOIN LATERAL` on `customer_bill` stamps), `nextVersionNo` — serialized by `lockKind()` (`pg_advisory_xact_lock(hashtext('billing.bill_template_version:INVOICE:' || kind))`, not `FOR UPDATE`, because `app_runtime` has only `SELECT` on `bill_format`); `btv_version_uq` is the backstop. `billAssetRepository.findVersionById`, `listVersions`.
- **Unions + IDs (D10):** `BILL_FORMAT_CODES = ['INVOICE']`, `TEMPLATE_KINDS = ['layout','generated','csv']` (no `xml`), `TemplateVersionStatus`, `BILL_ASSET_KINDS = ['logo']`; reuses bm47's section/column unions. `validation/billing/template-version-id.schema.ts`: `^BTV\d{8}$`, `^INVAST\d{8}$`, `^INVASV\d{8}$`.

## Files

- Migration: `db/migrations/0046_invoice_template_catalog.sql`, `db/migrations/meta/_journal.json`.
- Schema: `db/schema/billing/{bill-format,bill-template-version,bill-asset}.ts`, `db/schema/billing/customer-bill.ts`, `db/schema/billing/index.ts`.
- Grants: `db/bootstrap/bootstrap-db-roles.sql`, `db/bootstrap/billrun-db-roles.sql`, `infra/docs/db-role-verification.md` (re-run order `db:bootstrap-roles` → `db:bootstrap-billrun-roles` after `db:migrate`).
- Permission: `auth/permission-constants.ts`, `types/rbac.ts`, `types/permissions.ts`, `db/seeds/billing.ts`.
- Repositories: `db/repositories/billing/{bill-template-version,bill-asset}.ts`.
- Types/validation: `types/billing.ts`, `validation/billing/template-version-id.schema.ts`.
- Seeds/scripts: `scripts/invoice-templates/write-checksums.ts`; `checksums.json` in `db/seeds/invoice-templates/INVTPL-STD-A4/v1/`, `…/generated/INVOICE/v1/`, `…/system/csv/v1/`; `…/system/csv/v1/invoice.csv.columns.json`.

## Tests and evidence

- `tests/db/invoice-template-catalog.integration.test.ts` — one `INVOICE` row; three seeded defaults ACTIVE; one non-default ACTIVE allowed beside the default, a second refused; second DRAFT / second default refused; all CHECKs; **guardrail 45 (DB half)**: retiring/deleting a default refused (`DEFAULT_VERSION_IMMUTABLE`, `VERSION_DELETE_FORBIDDEN`), `RETIRED → ACTIVE` refused, DRAFT `structure` edit allowed, ACTIVE edit refused. Also covers guardrail 49's structure-key parity (~l.123).
- `tests/db/invoice-template-seed-checksums.test.ts` — repo `checksums.json` digests equal the migration literals.
- `tests/guardrails/invoice-settings-grants.integration.test.ts` — **guardrail 56 (grants half)** over `information_schema`.
- `tests/db/customer-bill-schema.test.ts` (updated), permission-registry assertions.
- Runs: green at the bm63 run (unit 4378/0, integration 1219/0, `tsc` clean). Docs: X3/C3 closed, G6/G10/G11/G12 recorded, architecture §3/§4, code-standards §8 + TS rule 7 (`VERSION_IMMUTABLE`, `VERSION_DELETE_FORBIDDEN`) + data rule 2.

## Later changes and residuals

- **2026-10-12 as built — layout v1 edited in place after seeding:** `f733095` and `614743a` (bm62–bm63 review fixes, incl. the accessibility fix, known-issues §23k) changed v1 files and re-pinned the `0046` digests in the migration; environments that already ran `0046` must be reset (known-issues §23l).
- "No consumer reads the new tables" held at bm50 only; bm53 onward reads them (2026-10-12).
- `billmgmt-known-issues.md` records "ratecard role grants are not seeded" (observed at bm50, not fixed here).
- **Invoice Template Phase 3 (planned):** `0046` is edited in place on the fresh-DB round to add `bill_template_family`, `ref_bill_template_family_id` (CHECK for `generated`, guard-trigger identity column) and family-scoped `btv_one_active_uq`/`btv_one_draft_uq` (D26, Inv #44 amended); the v1 seeds are rewritten once then pinned (D41, Inv #57).
