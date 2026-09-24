# Product Management — Update Overview (Rate Card Lookup)

**Module:** Product Management — the `RATECARD_RAN_USAGE_LKP` reference table, surfaced as **Products → Rate Card**. Stands up a RevOps-managed lookup table with an upload/diff/activate/rollback/carry-forward lifecycle and its UI; the rating engine's consumption of the table is a following-sprint deliverable, not part of this update.
**Users:** Revenue Operations — upload, review, activate and roll back rate card versions.
**Status:** Design (v2). The RC-series (as revised), invariants **RV1–RV4 / RV9**, and open items **OR3 / OR4 / OR7′ / OR-RET** are locked in `_updatemodule-ratecard-lookup-plan-v2.md`. **No blocking open items remain.**
**Supersedes:** the previous Pricing Components update overview. That update's authoritative text remains `_updatemodule-product-pricing-components-plan.md` plus specs `pm46`–`pm56`; its prior overview is recoverable at commit `7ebcc67`.
**Companion docs:** `_updatemodule-ratecard-lookup-plan-v2.md` (authoritative), `_updatemodule-product-pricing-components-plan.md` (PC10), `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`.

---

## Overview

This update stands up a RevOps-managed lookup table that records, for any unit of RAN usage, **which subscriber reference it belongs to and which service it is**. Revenue Operations uploads a CSV keyed on `(MNO public key, commercial unit public key, polygon ID)` — the same three columns that already form the UDR's `udr_key` — effective-dated by polygon start date; each upload becomes a version that is validated and previewable as `DRAFT` and takes effect only when explicitly activated. One lookup row carries an `lkp_subscriber_ref_id` and a `service_code`, both plain stored columns. The scope of this update is the table plus its full version lifecycle — upload, diff, activate, carry-forward and rollback — and the `/products/rate-card` UI, **and it stops there**. Nothing consumes the table: the rating engine's resolution of a UDR against the lookup is a following-sprint deliverable and no part of it is built here.

---

## Goals

1. Store an effective-dated lookup from `(mno_public_key, commercial_unit_public_key, polygon_id)` to `lkp_subscriber_ref_id` and `service_code`, versioned per upload, in `product.ratecard_version` + `product.RATECARD_RAN_USAGE_LKP`.
2. Give RevOps a self-service upload at **Products → Rate Card** that validates a ~5,000–5,500 row CSV synchronously and reports row-level errors without writing anything on failure.
3. Make activation a deliberate, separate act: an upload lands as `DRAFT`, is diffable against the current `ACTIVE`, and only becomes live when a user activates it.
4. Guarantee exactly one `ACTIVE` version per card name via a partial unique index, so "which card is live" always has one answer.
5. Keep the `ACTIVE` version **self-sufficient** — carry rows retired upstream forward at activation with a `retired_at` date, so the lookup for a period before a polygon was decommissioned is still present.
6. Stand up the table and its lifecycle only. This update builds no consumer: no rating resolution, no price-row selection, and no change to `product_offering_price` — those belong to a following sprint.

---

## Core User Flow

1. A Revenue Operations user opens **Products → Rate Card**. The version list shows every version for the card with its status (`DRAFT` / `ACTIVE` / `SUPERSEDED` / `REJECTED`), snapshot date, row count, and who uploaded and activated it.
2. They click **Upload new version** and pick a CSV — roughly 5,000–5,500 rows, about 0.5 MB.
3. The server action parses and validates the whole file in one request: header matches the expected columns; the `Date` column is constant across every row; no duplicate `(mno, cu, polygon, polygon_start_date)` key; every distinct `lkp_subscriber_ref_id` resolves in `inventory.product_inventory` with a usable status and a date window covering the row's `polygon_start_date`.
4. **On failure**, a row-level error table appears — row number, column, value, reason — and **no version is created**. The user fixes the file and uploads again.
5. **On success**, the version is created as `DRAFT` — validated, previewable, and never the `ACTIVE` version any future reader would resolve against. The file's `Date` is hoisted to the version header as `snapshot_date`; it is not stored per row.
6. The user reviews the rows and the **diff against the current `ACTIVE`**: subscription reassignments and service-code changes are listed first, then additions, then keys absent from the upload — labelled **Retiring**, with what will happen to them.
7. They click **Activate**. A confirmation names the version being superseded, the change counts, how many polygons will be carried forward as retired, and states that re-rating an earlier period will use this version.
8. In one transaction the service promotes the `DRAFT` to `ACTIVE`, demotes the prior `ACTIVE` to `SUPERSEDED`, and copies every key present in the outgoing version but absent from the upload into the new version with `retired_at = <new version's snapshot_date>`, preserving any `retired_at` already set. `carried_row_count` is written to the version header. An audit event is recorded in the same transaction.
9. If the activation was a mistake, the user re-activates any `SUPERSEDED` version from the version list; versions are immutable, so rollback is a status change, not an edit.

---

## Features

### Lookup table and versioning

- `product.ratecard_version` — one row per upload: `ratecard_version_id` (`RCV` + 8 digits), `card_name`, `version_num`, `status`, `snapshot_date`, `source_file`, `file_checksum`, `row_count`, `carried_row_count`, uploader/activator and timestamps, `superseded_by_version_id`, `reject_summary`.
- `product.RATECARD_RAN_USAGE_LKP` — one row per mapping: `mno_public_key`, `commercial_unit_public_key`, `polygon_id`, `polygon_start_date`, `lkp_subscriber_ref_id`, `service_code`, `rate_per_unit` (a plain nullable column), `retired_at`.
- Partial unique index on `card_name WHERE status = 'ACTIVE'` — at most one live version per card, enforced by the database rather than by application code.
- Versions are immutable once activated; a correction is a new upload, and any superseded version can be re-activated.

### Effective dating

- Row grain is `(mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date)`; `polygon_start_date` is the as-of key.
- The window is `[polygon_start_date, next polygon_start_date for the same key)`, closed on the right also by `retired_at`; `polygon_start_date` is the as-of key a future consumer would read against.
- The file's `Date` column is the snapshot/extract date, constant across the file, hoisted to the version header, and never used for matching.

### Retirement carry-forward

- Uploads are current-state: retired polygons never appear, because the polygon list is filtered during CUPS file filtering at the mediation layer, upstream of the card.
- At activation, keys present in the outgoing `ACTIVE` version but absent from the upload are copied forward with `retired_at = COALESCE(source.retired_at, new snapshot_date)`.
- `retired_at` comes from `snapshot_date`, not the wall clock, so a version activated late records the same `retired_at` as one activated on time.
- A polygon that reappears under the same keys is simply uploaded again with `retired_at = NULL`; un-retirement needs no special handling.

### Upload and ingest

- Synchronous server action — no Kestra, no `landing/`, no staging table, no streaming. At ~0.5 MB the file is parsed and inserted in one request.
- `serverActions.bodySizeLimit` raised to `4mb` in `next.config.ts` (the Next default is 1 MB).
- Rows insert in 1,000-row batches inside a single transaction; Postgres caps a statement at 65,535 bind parameters and 5,500 × 8 columns = 44,000 is uncomfortably close.

### Validation

- Row and file schemas as Zod `strictObject`s in `validation/product/ratecard.schema.ts`, matching pm47's house style — an unknown key is rejected, never stripped.
- Subscriber-reference checks split by severity: an `lkp_subscriber_ref_id` that is unknown, or resolves to a status `TERMINATED` / `CANCELLED` / `ABORTED`, or has a `polygon_start_date` outside the subscription's `[start_date, end_date]` window → **error**, upload refused. Status `SUSPENDED` or `PENDING_*` → **warning**, shown on the draft review, does not block.
- Carried-forward rows are never re-validated; their subscriptions may legitimately be terminated.

### UI — `/products/rate-card`

- A fifth item in the Products section of `lib/nav-registry.ts` with an icon in `components/nav-icons.ts`.
- Version list, upload dialog, row preview, diff against `ACTIVE`, activate confirmation, rollback, and a row-level error table on rejection.

---

## In Scope

- `product.ratecard_version` and `product.RATECARD_RAN_USAGE_LKP` in a new forward-only migration `0041_ratecard_ran_usage_lkp.sql`, with the hand-written Drizzle mirror. `0006_product.sql` is **not** reopened.
- `validation/product/ratecard.schema.ts` — row schema, file schema, and the referential/status/window checks.
- `services/product/ratecard/{upload-version,activate-version,rollback-version,diff-versions}.ts` and `db/repositories/product/ratecard.repository.ts`.
- The `/products/rate-card` page, nav entry, icon, and RBAC wiring.
- `next.config.ts` `bodySizeLimit` raise.
- A demo seed card version aligned with the four-component demo offering pm48 seeds.
- One audit event per upload, activate and rollback, in the same transaction as the write.

---

## Out of Scope

- **Any consumer of the table.** No rating resolution, no as-of lookup, no per-UDR match, no reject events, no `udr_rated` stamping. The table is stood up and left; consumption is a following-sprint deliverable.
- **Any change to `product_offering_price`.** No `service_code` column, no uniqueness-constraint rekey, no `lead()` partition amendment, no `AMBIGUOUS_RATE_CARD`. Price-row selection is not part of this update.
- **Capacity.** No `capacity_mbps` column, not in the table and not in the upload contract. Capacity semantics stay post-aggregation in `capacity_commitment` / `capacity_motivation`.
- **The negotiated override, entirely.** `ordering.order_item_price_override` is not read, modified, reshaped or reasoned about.
- **Row-level authoring.** Upload is the only write path; there is no in-UI editing of individual card rows.
- **The bill-run capacity resolver**, the `customer_bill_line` mapping, proration, rounding and the BAN aggregation grain.
- **Any TMF620 API or adapter.**
- **Editing `0006_product.sql`** — pm00's G-C authorization was scoped to `pm46` and does not extend here.
- **Async ingest** — Kestra, `landing/`, staging tables and streaming are all set aside at this volume; the schema is identical if a future feed forces the change.

---

## Success Criteria

- `npm run db:migrate` on an empty database produces both tables and the partial unique index on `card_name WHERE status = 'ACTIVE'`. `0006_product.sql` and `product_offering_price` are untouched.
- Uploading a valid ~5,400-row CSV creates exactly one `DRAFT` version, inserts its rows in 1,000-row batches inside one transaction, and leaves the current `ACTIVE` version untouched and still active.
- Each of these is refused and **creates no version**: a duplicate `(mno, cu, polygon, polygon_start_date)`; a `Date` column that varies across rows; a missing expected column; an unknown `lkp_subscriber_ref_id`; a subscription whose status is `TERMINATED`, `CANCELLED` or `ABORTED`; a `polygon_start_date` outside the subscription's date window.
- A subscription with status `SUSPENDED` or `PENDING_ACTIVE` produces a warning on the draft review and does **not** block activation.
- Activating a version promotes it to `ACTIVE`, demotes the prior version to `SUPERSEDED`, and inserts one carried-forward row for every key present in the outgoing version and absent from the upload, each with `retired_at` equal to the new version's `snapshot_date` — asserted including the case where the source row already had a `retired_at`, which must be preserved rather than re-dated.
- Attempting to activate a second version while one is `ACTIVE` is refused by the partial unique index, not merely by application code.
- Re-activating a `SUPERSEDED` version restores it to `ACTIVE` and demotes the current one; no row of either version is edited.
- One audit event per upload, activate and rollback, written in the same transaction as the write.
- A user holding only READ on the rate-card permission can view versions and rows but cannot upload, activate or roll back.
- `npm run typecheck`, `lint` and the full test suite pass; the schema-diff guardrail is green against both new tables.
