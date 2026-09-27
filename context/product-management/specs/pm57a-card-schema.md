# pm57a — Card schema, current design (overwrites pm57's `0041`)

**Unit:** pm57a (Part 5, schema unit). **Overwrites the original pm57** by rewriting its migration in place. **Boundary:** `db/migrations/0041_ratecard_ran_usage_lkp.sql` (**rewritten in place** — not superseded by a new migration), `db/schema/product.ts` (hand-synced, no `drizzle-kit generate`), `types/product.ts` (`RateCardVersionStatus`), `types/rbac.ts` (one `PERMISSION_NAMES` member — gated on G-RC3), and the guardrail files that prove it. **No repository, service, action, component, validation, parser, seed or page.** This delivery stands up the table at the current design; no consumer is built.
**Assumption (load-bearing, now a verified gate — G-RC6):** **no deployment based on the original `0041` has taken place.** This is **confirmed empirically before the rewrite lands** (D1), not assumed. If confirmed, every environment rebuilds its database from empty, so `0041` is edited in place to the correct shape — the module's fresh-install regime, the same one under which `0006_product.sql` is edited in place; there is **no `0042`**, no drop-and-recreate, and no forward-only reversal. **If G-RC6 fails** (any persistent environment applied the original `0041`), the in-place rewrite is off the table and the correction ships as a forward `0042` instead.
**Specs from:** `prodmgmt-update-overview.md` (goals; In Scope) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC4, RC8, RC12, RV1–RV3, D-A1, D-A7, D-A9, D-A10** · `prodmgmt-architecture.md` §3.2, §3.3, §3.4, §3.8, §4, Inv. **#45–#60** · `prodmgmt-code-standards.md` §2.19, §6.23–§6.32, §7.12, §8, guardrails 13/39, Appendix A rows **A10–A13** · `prodmgmt-ai-workflow-rules.md` §4.1, §6.2–§6.5, §8.
**Depends on:** **G-RC1** (unit numbering — Part 5 re-cut). **G-RC3** for the `PERMISSIONS` row / `types/rbac.ts` member only. **G-RC6** (verified no-deployment) before the in-place rewrite (D1).

---

## Goal

**Overwrite the schema the original pm57 delivered — rewrite `0041_ratecard_ran_usage_lkp.sql` in place to the current design.** The original `0041` created the two card tables at an earlier shape; pm57a rewrites that same file so it creates them at the current design: adding the descriptive `polygon_end_date`, `state` and `district` columns, dropping `polygon_start_date` from the row key, dropping the as-of index, and carrying no carry-forward columns. A database built from empty carries the whole current schema, and the rules that matter are refused by Postgres rather than by application code. No consumer is built.

---

## Design

### D1. `0041` is rewritten in place — gated on G-RC6, with its metadata regenerated

**G-RC6 — verify, do not assume, that no deployment based on the original `0041` has taken place.** Before the rewrite lands, confirm empirically — the same discipline that gated the `0006` in-place edits (G-C) — that no persistent or shared database (CI, staging, any reviewer's long-lived local) has applied the original `0041`: inspect each such environment's applied-migration ledger (`__drizzle_migrations` / the journal) for a `0041` entry. Record the check with its date. **If any environment has applied it, stop: the in-place rewrite is unsafe** — the migrator cannot silently re-apply a changed file — **and the correction ships as a forward `0042` instead** (DROP `carried_row_count` / `retired_at` / the as-of index, ALTER the row-key uniqueness, ADD `polygon_end_date` / `state` / `district`). Only once G-RC6 is confirmed is the file **edited in place** to the correct shape — the fresh-install regime under which `0006_product.sql` was edited in place. After this unit, `db/migrations/0041_ratecard_ran_usage_lkp.sql` contains the current-design `CREATE` statements (D2–D4) and nothing else: **there is no `0042`, no `DROP TABLE`, and no drop-and-recreate.**

**The Drizzle metadata for `0041` is regenerated, not left "unchanged."** `meta/_journal.json` stores a per-entry **hash** of the migration and `meta/000X_snapshot.json` is a machine-generated structural fingerprint. If the SQL changes but the hash does not, the migrator sees a tampered entry and errors or silently skips it — the exact failure G-RC6 guards against. So when `0041` is rewritten, its `_journal.json` hash **and** its snapshot are **regenerated to match the new SQL** (drop `0041`'s journal + snapshot entries and let `drizzle-kit` re-add them for that one file, or regenerate scoped to `0041`). This is the one place §6.25's "no `drizzle-kit generate`" is relaxed for the metadata, because a hand-edited hash cannot be made byte-correct; `db/schema/product.ts` is still hand-synced. **Verify the regenerated `0041` hash matches the rewritten SQL before this unit is done — that verification is part of the G-RC6 record.** Because every database is rebuilt from empty (once G-RC6 holds), the migrator then applies the rewritten `0041` cleanly. `0006_product.sql` is **not** reopened (RC12).

### D2. `product.ratecard_version` — unchanged from the original, minus carry-forward

The version/config tracker keeps the original columns and constraints, **minus `carried_row_count`** (D-A7): `ratecard_version_id` (`RCV`+8-digit sequence PK), `card_name`, `version_num`, `status` (CHECK-constrained to the four values), `snapshot_date` (the upload date, set by the service — D-A8), `source_file`, `file_checksum`, `row_count`, `uploaded_by`/`activated_by` FK → `core.appuser("user_id")` `ON DELETE set null`, `uploaded_at`/`activated_at`, `superseded_by_version_id`, `reject_summary`. `status = 'REJECTED'` and `reject_summary` have **no writer** in this delivery — a failed upload writes nothing. Constraints: `UNIQUE (card_name, version_num)`; the partial unique index on `card_name WHERE status = 'ACTIVE'` (RV1) and the one on `WHERE status = 'DRAFT'` (C8, option A — one open draft per card; a wrong draft is **replaced** by the next upload rather than blocking it — D-A11, pm61 D12).

### D3. `product.RATECARD_RAN_USAGE_LKP` — the current column set

| Column                       | Type                                                        | Notes                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ratecard_ran_usage_lkp_id`  | `uuid` PK                                                   | `core.generate_ulid()` — not a padded sequence                                                                                |
| `ratecard_version_id`        | `text NOT NULL` FK → `ratecard_version` `ON DELETE CASCADE` | the only FK                                                                                                                   |
| `mno_public_key`             | `text NOT NULL`                                             | **key component**                                                                                                             |
| `commercial_unit_public_key` | `text NOT NULL`                                             | **key component**                                                                                                             |
| `polygon_id`                 | `text NOT NULL`                                             | **key component**                                                                                                             |
| `polygon_start_date`         | `date NOT NULL`                                             | validity-window start — **descriptive, not a key component** (D-A9)                                                           |
| `polygon_end_date`           | `date`                                                      | validity-window end; `NULL` = open-ended / still active — **descriptive** (D-A9)                                              |
| `state`                      | `text`                                                      | **plain descriptive label** — candidate future key component, no meaning here (D-A10)                                         |
| `district`                   | `text`                                                      | **plain descriptive label** — candidate future key component, no meaning here (D-A10)                                         |
| `lkp_subscriber_ref_id`      | `text NOT NULL`                                             | a `product_inventory.product_inventory_id` value (`PRDINV`+8 digits); **no FK** (D-A1, Inv. #57), validated structurally only |
| `service_code`               | `text`                                                      | **plain attribute** — no CHECK, no meaning (§5)                                                                               |
| `rate_per_unit`              | `numeric(18,6) NULL`                                        | **plain nullable attribute** — no CHECK, no reserved rule (D-A2)                                                              |

**No `retired_at`, no `carried_row_count`** (D-A7). **No capacity column** (RC4), **no currency column** (Inv. #53). No date-order CHECK on the two polygon dates — they are plain descriptive columns.

### D4. Row key and indexes — `polygon_start_date` out of the key, no as-of index

`UNIQUE (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)` (RV2) — the natural row key within a version; a polygon appears **at most once per version** (D-A9). This version-scoped uniqueness index is the **only** lookup index required. With `polygon_start_date` out of the key, **there is no separate as-of index** — the original `0041`'s `..._as_of_idx` (with `polygon_start_date DESC`) is not written. `polygon_start_date`, `polygon_end_date`, `state`, `district`, `service_code` and `rate_per_unit` are part of no key or index.

### D5. Types, permission, grants

`types/product.ts` gains `RateCardVersionStatus` (`'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED'`, `as const`, lifecycle order) — not `LifecycleStatus`. `REJECTED` is kept in the union and the CHECK **deliberately, as reserved surface** for a future asynchronous ingest; it has **no writer in this delivery** (D2), and it is **not** dropped, so the type and the enum stay stable when that ingest arrives rather than widening later. The `ratecard` `PERMISSIONS` seed row and the `types/rbac.ts` member ship **in the rewritten `0041` once G-RC3 clears** (READ/EDIT only, no DELETE); if G-RC3 is still open, land the two tables alone and hold the permission for a follow-up — but that follow-up must land **before pm61, not pm65**: pm61/pm63/pm64's actions call `requirePermission('ratecard', 'EDIT')`, which does **not compile** until `ratecard` is a `PERMISSION_NAMES` member (`types/rbac.ts`). The read page (pm65) is the latest the nav entry could appear; the **write chain (pm61) is the real deadline**. `app_runtime` reaches both tables via the schema-wide grant; `rating_runtime`/`billrun_runtime` do not (enumerated per-table grants) — a finding for whichever future unit first needs an engine role to read the card, **not** a bootstrap edit here.

**C5 (already resolved — verify-only).** Architecture §1's permission count already reads **14 → 15** in the tree (found correct 2026-09-24); this unit only **confirms** it and does not re-edit it. If a stale "16" resurfaces, correct it — otherwise there is nothing to change.

---

## The migration — `0041_ratecard_ran_usage_lkp.sql` rewritten (ready to apply)

**Replace the entire contents** of `db/migrations/0041_ratecard_ran_usage_lkp.sql` with the following. It is plain `CREATE` at the current design — because no deployment has occurred, the file is authored as if this were always its shape (no `DROP`, no `0042`).

```sql
-- pm57a — Card schema, current design. This migration (0041) was rewritten in
-- place to the current design; no deployment based on its earlier shape has
-- taken place, so every environment rebuilds from empty — the module's
-- fresh-install regime, the same one under which 0006_product.sql is edited in
-- place. 0006_product.sql is not reopened.
--
-- RATECARD_RAN_USAGE_LKP: the row key is
-- (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)
-- (D-A9 — polygon_start_date is NOT a key component). polygon_start_date,
-- polygon_end_date, state and district are descriptive; service_code and
-- rate_per_unit are plain (no CHECK); there is no as-of index and no
-- carry-forward columns (no retired_at, no carried_row_count — D-A7).
-- lkp_subscriber_ref_id carries a product_inventory_id VALUE with no FK (D-A1).
-- The ratecard PERMISSIONS row and the types/rbac.ts member stay gated on
-- G-RC3 and are not created here (the pm57 I6 split).

CREATE SEQUENCE "product"."ratecard_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "product"."ratecard_version" (
	"ratecard_version_id" text PRIMARY KEY DEFAULT 'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0') NOT NULL,
	"card_name" text NOT NULL,
	"version_num" integer NOT NULL,
	"status" text NOT NULL,
	-- Upload date in the app timezone, set by the upload service (D-A8). Not
	-- read from the file; never used for matching.
	"snapshot_date" date NOT NULL,
	"source_file" text NOT NULL,
	"file_checksum" text,
	"row_count" integer NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"superseded_by_version_id" text,
	-- status = 'REJECTED' and reject_summary have NO writer in this delivery; a
	-- failed upload writes nothing. Reserved for a future asynchronous ingest.
	"reject_summary" jsonb,
	CONSTRAINT "ratecard_version_card_name_version_num_unique" UNIQUE("card_name","version_num"),
	CONSTRAINT "ratecard_version_status_check" CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED')),
	CONSTRAINT "ratecard_version_uploaded_by_appuser_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "ratecard_version_activated_by_appuser_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
-- At most one live version per card (RV1) — enforced by the index, not app code.
CREATE UNIQUE INDEX "ratecard_version_one_active_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'ACTIVE';
--> statement-breakpoint
-- At most one open DRAFT per card (C8, option A). A wrong draft is replaced by
-- the next upload (D-A11, pm61 D12) — it does not block the card.
CREATE UNIQUE INDEX "ratecard_version_one_draft_per_card"
  ON "product"."ratecard_version" ("card_name")
  WHERE status = 'DRAFT';
--> statement-breakpoint
CREATE TABLE "product"."ratecard_ran_usage_lkp" (
	-- ULID default, not a padded sequence — a high-volume child table whose id
	-- is never displayed (matches rating.udr_rated).
	"ratecard_ran_usage_lkp_id" uuid DEFAULT core.generate_ulid() PRIMARY KEY NOT NULL,
	"ratecard_version_id" text NOT NULL,
	-- key components
	"mno_public_key" text NOT NULL,
	"commercial_unit_public_key" text NOT NULL,
	"polygon_id" text NOT NULL,
	-- descriptive validity-window dates (D-A9) — NOT part of the row key.
	-- polygon_end_date NULL = open-ended / still active.
	"polygon_start_date" date NOT NULL,
	"polygon_end_date" date,
	-- descriptive labels (D-A10) — candidate future key components, plain here.
	"state" text,
	"district" text,
	-- a product_inventory.product_inventory_id VALUE, not a reference. No FK
	-- (D-A1, Inv #57) — validated structurally only; a superseded version must
	-- survive a subscription's removal.
	"lkp_subscriber_ref_id" text NOT NULL,
	-- plain columns — no CHECK, no meaning here (§5, D-A2).
	"service_code" text,
	"rate_per_unit" numeric(18, 6),
	-- RV2 (D-A9): row identity within a version is
	-- (mno_public_key, commercial_unit_public_key, polygon_id) — polygon_start_date
	-- is out of the key. This version-scoped uniqueness index is the only lookup
	-- index; there is no separate as-of index.
	CONSTRAINT "ratecard_ran_usage_lkp_row_key_unique" UNIQUE("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id"),
	CONSTRAINT "ratecard_ran_usage_lkp_ratecard_version_id_ratecard_version_ratecard_version_id_fk" FOREIGN KEY ("ratecard_version_id") REFERENCES "product"."ratecard_version"("ratecard_version_id") ON DELETE cascade ON UPDATE no action
);
```

**`db/schema/product.ts` (hand-sync).** Mirror both tables at the shape above: **drop** `carriedRowCount` and `retiredAt`; **add** `polygonEndDate` (`date`, nullable), `state` (`text`, nullable), `district` (`text`, nullable); the lookup's uniqueness/index is the four-column row key (no `polygon_start_date`, no as-of `DESC` index). Remove any doc-comment clauses citing `retired_at` / carry-forward. **`meta/_journal.json` hash and the `0041` snapshot are regenerated** to match the rewritten SQL (D1) — not hand-edited — and the regenerated hash is verified against the file.

---

## Implementation

0. **Confirm G-RC6** — verify no persistent/shared DB applied the original `0041` (check `__drizzle_migrations`/the journal), and record it with its date (D1). If it fails, switch to a forward `0042` and stop following the in-place steps below.
1. **Rewrite `db/migrations/0041_ratecard_ran_usage_lkp.sql`** in place to the SQL above (D1). No `0042`.
2. **`db/schema/product.ts`** — hand-mirror both tables at the current design; drop `carriedRowCount`/`retiredAt`/as-of index remnants. **Regenerate** the `0041` `_journal.json` hash and snapshot to match the rewritten SQL (D1) and verify the hash — do not hand-edit the metadata.
3. **`types/product.ts`** — `RateCardVersionStatus` per D5.
4. **`types/rbac.ts`** — the `ratecard` member, gated on G-RC3 (called out in review).
5. **Guardrails** — 13 re-baselined to both tables, both partial unique indexes, and the RV2 four-column uniqueness (no as-of index); 39 (a direct second `ACTIVE` per `card_name` is refused by the index).
6. **Tests** — against a database built from **empty**: both tables at the current column set; RV1/C8 partial indexes; RV2 uniqueness on `(version, mno, commercial_unit, polygon)`; cascade delete of a version removes its rows; removing a `product_inventory` row leaves card rows intact (no FK); `polygon_start_date`/`polygon_end_date`/`state`/`district` are plain (no key, no index, no CHECK); `0006_product.sql` byte-identical; no backfill script exists; **no `0042` (or any migration after `0041`) exists for the rate card.**

---

## Verification checklist

- [ ] **G-RC6 confirmed and recorded** (no persistent DB applied the original `0041`) before the in-place rewrite; if it failed, a forward `0042` was used instead.
- [ ] `db/migrations/0041_ratecard_ran_usage_lkp.sql` is the **only** rate-card migration (under G-RC6) — there is no `0042`; the file was rewritten in place.
- [ ] The `0041` `_journal.json` hash and snapshot were **regenerated** to match the rewritten SQL and the hash was **verified** — not left unchanged, not hand-edited.
- [ ] `npm run db:migrate` on an **empty** database produces both tables at the current design — with `polygon_end_date`, `state`, `district` present and **no** `retired_at`/`carried_row_count`.
- [ ] Row key is `(ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)` — `polygon_start_date` is **not** in the key, and there is **no** as-of index.
- [ ] A second `ACTIVE` (and a second open `DRAFT`) version for one `card_name` is refused **by the partial index**; a duplicate `(version, mno, commercial_unit, polygon)` is refused (RV2).
- [ ] `RATECARD_RAN_USAGE_LKP` has exactly one FK; `lkp_subscriber_ref_id` has none; removing a `product_inventory` row leaves card rows intact.
- [ ] `service_code`, `rate_per_unit`, `state`, `district`, `polygon_start_date`, `polygon_end_date` are plain — no CHECK, no key, no index.
- [ ] No capacity column, no currency column, no `retired_at`, no `carried_row_count`.
- [ ] `0006_product.sql` byte-identical; **no backfill script exists** (asserted by grep).
- [ ] `db/schema/product.ts` mirrors the rewritten shape (hand-synced); the `0041` journal hash and snapshot are **regenerated** (not hand-synced) and verified.
- [ ] `RateCardVersionStatus` lands, shares no `Record` with `LifecycleStatus`.
- [ ] `types/rbac.ts` goes 14 → 15 (or the split is taken and recorded); `ratecard` carries no DELETE.
- [ ] Guardrails 13 (re-baselined) and 39 pass.

**Definition of done:** a database built from nothing carries both card tables at the current design — the three key columns plus the descriptive `polygon_start_date`/`polygon_end_date`/`state`/`district`, one live version per card enforced by an index, no as-of index and no carry-forward columns — via the **rewritten `0041`** (no `0042`, under a confirmed G-RC6), with `db/schema/product.ts` hand-synced and the `0041` journal hash + snapshot regenerated and verified, no backfill anywhere, `0006_product.sql` untouched, and nothing consuming the table.
