# Product Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — the technology stack, folder ownership, multi-module database design, the auth/authorization platform, storage principles and the platform invariants — and records **only what the Product Management module adds or changes**. Anything not stated here is inherited unchanged. This revision is scoped to the **Rate Card Lookup update** (`RATECARD_RAN_USAGE_LKP`, Products → Rate Card); the Pricing Components model is now the **baseline** it builds on, restated only where the rate card depends on it or changes it.

**Status:** DESIGN. Decisions **RC3/RC4/RC7/RC8/RC11/RC12/RC15/RC17** (the ones that survive v2), invariants **RV1–RV4/RV9** and the v2 revision decisions **D-A1–D-A6** are locked in `_updatemodule-ratecard-lookup-plan-v2.md` — the authoritative design. **No blocking open items remain.** Nothing in §3 is built yet. Changes to _Module Invariants_ require a documented design review; the amendments in §6 are **proposed, not yet approved**.

**Baseline (delivered or in flight, carried forward unchanged):** four pages — View Product (`/products/product-offering`), Manage Products (`/products/manage-products`), Orders (`/products/orders`), Subscriptions (`/products/subscriptions`); the five-value lifecycle `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`; the expression unique indexes for one-open and one-active per family; the DRAFT-guard trigger on both child tables; the retirement gate; three `product` tables; and the **pricing-component envelope** — `product_offering_price` already reshaped to `component_type` + `price_component jsonb` (pm46), the Zod discriminated union (pm47), seeds emitting envelopes (pm48) and the component write path (pm49). Module invariants **1–44** stand except where §6 amends them.

**Scope of this update.** Two new `product` tables (a config/version tracker and the lookup itself), the first **file-upload path in the application**, a version lifecycle with an explicit activation gate, and the `/products/rate-card` surface. This delivery stands up the table and its management surface; **it touches no delivered table** — in particular it makes **no change to `product_offering_price`** — and defines **no consumer** of the data. The rating consumer that reads the lookup is a following-sprint deliverable, out of scope here.

**Companion docs:** `_updatemodule-ratecard-lookup-plan-v2.md` (authoritative), `prodmgmt-update-overview.md` and `_updatemodule-product-pricing-components-plan.md` (PC10 — the `rateCardLookUp` field this module tracks a table for, still a validated name only), `prodmgmt-code-standards.md`, `prodmgmt-project-overview.md`, `specs/pm00-build-plan.md`.

---

## 1. Technology Stack — Deltas Only

The stack is inherited from `architecture.md` §1. This update is the **first in the module to add a runtime dependency and to touch root config** — both consequences of the same fact: the application has never accepted a file before.

| Layer | Technology (inherited unless marked new) | Role in this update |
| --- | --- | --- |
| Frontend | Next.js ≥ 15 App Router + RSC, TypeScript `strict` | A fifth Products page, `/products/rate-card`: version list, upload, draft review with a row preview and a diff against the current `ACTIVE`, and activate and rollback confirmations. The file picker is the **first `<input type="file">` in the tree** — every existing form is react-hook-form + a typed Server Action, and the only `FormData` uses today are HTTP clients. |
| File ingest | **New — a pinned, non-streaming CSV parser** (`papaparse` or `csv-parse/sync`; OR4) | The one new dependency. CSV over XLSX (OR4): XLSX needs a heavier parser and brings type-coercion ambiguity — dates, and leading zeros on the key columns — that explicit CSV parsing avoids. Whatever is pinned **must preserve an empty cell as `""` and never coerce it to `0`** — ordinary data hygiene (D-A2). |
| APIs & Backend | Server Actions over framework-agnostic `services/` | Upload, activate, rollback and diff are ordinary Server Actions (`requirePermission` → `safeParse` → service → `revalidatePath`). **No `app/api/product*` route is added — and none ever exists.** Ingest is **synchronous** (RC15): parse, validate and insert in one request, one transaction, result shown immediately. |
| Root config | **New surface — `next.config.ts`** | `serverActions.bodySizeLimit` raised to `4mb` (RC15). The Next default is 1 MB and a ~0.5 MB card fits, but the failure mode when it ever does not is a generic body-size error rather than a validation message — it reads as a bug, not a bad file. This is a **platform-level file edited by a module**; it is not owned by §2's table and the change must be called out in review. |
| Database | Azure PostgreSQL 17 via Drizzle ORM | Two new `product` tables (`ratecard_version`, `RATECARD_RAN_USAGE_LKP`), in **`0041_ratecard_ran_usage_lkp.sql` — a new, forward-only migration file** (RC12). `0006_product.sql` is **not** reopened. **No `ALTER` touches `product_offering_price`** — this update adds no column and rekeys no index on a delivered table. |
| Validation | Zod in `validation/` | New `validation/product/ratecard.schema.ts` — a **row schema** and a **file schema**, both `strictObject` in the pm47 house style (unknown key rejected, never stripped). Adds the module's first **file-level** validation (header match, `Date` constant across all rows, no duplicate row keys). Validation is **structural only** — there is no cross-module referential check (D-A1). |
| Auth & Permissions | Better-Auth + core RBAC | **The module's first new permission since `products` / `product_inventory`** — OR3 recommends a dedicated `ratecard` name rather than reusing `products : EDIT` (§4). `PERMISSION_NAMES` is a closed `as const` union of 14; this makes it 15. |
| Workflow engine | Kestra OSS + the custom Python worker | **Deliberately not used for ingest** (RC15). The card does not arrive via `landing/` (Azure Files SMB) the way UDR files do; it arrives through the app. The engine plays no part in this delivery — nothing reads the new tables here. |
| Caching / CDN | None | Unchanged. The read surface is uncached (`force-dynamic`); no card version, row or resolution result is cached anywhere. |
| Background jobs / AI | None | Unchanged — see §5. No job, no queue, no staging table, no async flow; at 5,000–5,500 rows (~0.5 MB) all three are unjustified complexity (RC15). |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, RLS unused, no rate limiting, no email. |

**Revisit condition, recorded now.** RC15's synchronous ingest holds while volume stays in this order of magnitude. Past roughly **50k rows** per upload, the schema does not change — only the loader does (streaming parse, staging table, or a Kestra flow). Anyone changing that should read RC15 first rather than re-deriving it.

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged: UI → actions → services → repositories → DB; inner layers never import outward. `components/`, `validation/`, `types/` remain shared leaves. `workflow-management/**` remains outside the chain, bounded by grants, never imported (platform §2, Inv. #9).

| Path | Owns | This update |
| --- | --- | --- |
| `db/migrations/0041_ratecard_ran_usage_lkp.sql` | **New.** All DDL for this update. | Both new tables. Forward-only (RC12). `0006_product.sql` is untouched, and **no `ALTER` touches any delivered table** — the fresh-install / in-place-edit convention used by pm46 **does not apply to this module**. |
| `db/schema/product.ts` | Drizzle mirror of hand-written SQL. | Two new table definitions; kept in sync by hand, no `drizzle-kit generate`. |
| `db/repositories/ratecard.ts` | **New.** The only SQL for the two card tables. | Version CRUD, chunked row insert, the row read, and the set-based carry-forward `INSERT … SELECT`. Flat path, matching every existing product repository (`db/repositories/product-offering-price.ts`). |
| `validation/product/ratecard.schema.ts` | **New.** Row schema, file schema, and the upload contract's column set. | `rate_per_unit`, if present, is an optional decimal string — a **plain nullable attribute**, no reserved rule (D-A2). `service_code` is a plain `text` attribute, validated structurally only. No capacity field (RC4). |
| `services/product/ratecard/upload-version.ts` | Parse → validate → insert a `DRAFT` version and its rows, in one transaction. | Returns a row-level error report on failure and **inserts nothing**. Rows go in **1,000-row batches** inside that one transaction, well under Postgres's 65,535 bind-parameter cap. |
| `services/product/ratecard/activate-version.ts` | `DRAFT → ACTIVE`, prior `ACTIVE → SUPERSEDED`, **and carry-forward** (RC17). | One transaction under a row lock. Deliberately at **activation**, not upload: the outgoing `ACTIVE` can change in between (a rollback), and carrying against a stale baseline silently drops rows. Also writes `carried_row_count`. |
| `services/product/ratecard/rollback-version.ts` | Re-activate a `SUPERSEDED` version (RC11). | Same lock, same confirmation shape. |
| `services/product/ratecard/diff-versions.ts` | Added / retiring / changed rows vs the current `ACTIVE`. | **In-memory** (RC15) — 5.5k vs 5.5k rows keyed on the four row-key columns is a map comparison, not a set-based SQL diff and not a temp table. Generic add/remove/change buckets (D-A6). This is the control that makes RC7's gate worth anything; without a diff, "review before activating" is a button, not a review. |
| `actions/product/**` | One Server Action per mutation. | **New action files** for upload, activate and rollback. `EXPECTED_PRODUCT_ACTION_FILES` changes — it was explicitly unchanged by the pricing update, so this is the first movement in that list since the rebuild. |
| `app/(app)/products/rate-card/page.tsx` | The new page. | Thin orchestrator; declares its permission + level like every other page. |
| `components/products/rate-card/**` | **New.** Write-capable UI. | Upload form, error table, paginated row preview, diff view, activate/rollback confirmations. Import direction unchanged. |
| `lib/nav-registry.ts`, `components/nav-icons.ts` | Routing policy + nav glyphs. | A fifth entry in the Products section (`nav-registry.ts:102-129`) and its icon (`nav-icons.ts:47-50`). |
| `types/rbac.ts` | The closed `PERMISSION_NAMES` union. | One more name if OR3 lands as recommended (§4). |
| `next.config.ts` | Root Next config. | `serverActions.bodySizeLimit: '4mb'` (RC15). Outside every module folder — see §1. |
| `db/seeds/demo/**` | Demo data. | The Phase 1 seed: one `card_name` and its initial dataset, created **through the real upload + activate path** so the guards are exercised and the audit trail is real (D-A5). Small and human-readable, not 5,400 rows. Held to the same CHECKs and the same Zod validation as user input. |
| `tests/**` | Units, integration, authz matrix, guardrails. | Upload/validation suites, a carry-forward suite, the version-self-sufficiency guardrail, the upload-only-write-path guardrail, a re-baselined schema diff (two new tables, no price-table change), and the authz matrix row for the new route (§6). |

**What Product Management does _not_ own, and must not acquire.**

| Concern | Owner | Why it is not here |
| --- | --- | --- |
| Any consumer of the lookup data — resolution, as-of matching, or reading a row at all | A future rating consumer, a following sprint | This delivery **stands up the table**; nothing in it reads, resolves or prices from the lookup. A separate runtime with its own DB role will eventually read it; the app never imports it. |
| `service_code` semantics — what a value means, which row it selects | The future consumer, out of scope | Here `service_code` is a **plain `text` attribute** (D-A6): a value in a column, no pricing or rating derivation, no cross-row rule. |
| Any `product_offering_price` change — a `service_code` column, a rekey, a `lead()` partition amend, an authoring form | Nobody — **explicitly not done** (D-A1/D-A2) | v2 makes **no change to any delivered table**. The whole price-table ripple of v1 is removed. |
| The bill-run capacity resolver | Bill Run (`services/billing/**` + the engine) | Unchanged from the pricing update. Capacity is post-aggregation and **has no representation in the card at all** (RC4). |
| `ordering.order_item_price_override` | Ordering | **Not read, not modified, not reshaped, not reasoned about.** Overrides keep working exactly as today. |
| Any TMF620 adapter or external API | Nobody, by decision | Unchanged. `app/api/product*` never exists. |

---

## 3. Storage Model

### 3.1 What lives where

| Kind of state | Where | Rule under this update |
| --- | --- | --- |
| Card versions and their rows | **Postgres**, `product.ratecard_version` + `product.RATECARD_RAN_USAGE_LKP` | Schema is `product.*` because **the write direction decides ownership** — the app writes it, and it is managed from the Products surface. It is the inverse of `rating.udr_rated`, and it is why the spec series is `pm` and not `rm` (RC8 / D-A4). |
| The uploaded CSV itself | **Nowhere — parsed and discarded** | Only `source_file` (the original filename, forensics only) and `file_checksum` (duplicate detection) survive. **This is the module's most consequential storage decision and it contradicts the obvious reading of platform §3**, which anticipates uploads as *"binary → Azure Blob, DB stores a reference."* No blob, no Azurite dependency, no `landing/` drop. A version's rows **are** the record of the upload. |
| The retired-polygon history | **Postgres, inside each version** (RC17) | Uploads are current-state — retired polygons are filtered out upstream during CUPS file filtering at the mediation layer. The upstream therefore *cannot* supply history, so **the app keeps it** by carrying rows forward at activation. |
| Service code on a card row | **Postgres column** `RATECARD_RAN_USAGE_LKP.service_code` | A **plain `text` attribute** carrying whatever the upload provides (D-A6). It is not added to `product_offering_price`, is not part of any key, and selects nothing. Any meaning is a future consumer's design. |
| Money on a card row | **A plain nullable column** | `rate_per_unit` is an ordinary `numeric(18,6) NULL` attribute (D-A2) — no reserved rule, no `CHECK`, no activation ritual. There is deliberately **no currency column**. The table stands up keys and attributes; it defines no pricing significance. |
| Capacity | **Nowhere** (RC4) | Not a column, not in the upload contract. It is not "stored but unused" — there is no column. If a polygon's coverage capacity is ever needed, its home is the product catalog's offering characteristics, not this lookup table. |
| File storage / blob | **Still none** | Platform §3's "user-uploaded files: none in v1" stays true *of stored files*. The statement that needs a one-line follow-up in `context/architecture.md` §3 is the **ingest** half: an upload path now exists, and its answer is parse-and-discard, not Blob. |
| Cache | **None** | Unchanged, and load-bearing here — see §1 and Inv. #59. |

### 3.2 `product.ratecard_version` — one row per upload

| Column | Type | Notes |
| --- | --- | --- |
| `ratecard_version_id` | `text` PK | `RCV` + 8-digit sequence — the platform's prefix + padded-sequence convention, one sequence per table |
| `card_name` | `text NOT NULL` | The tracked lookup's identifier; **one seeded value in Phase 1** (D-A5). Shares the string namespace of `usage_rate.params.rateCardLookUp`, which stays a validated name only — no cross-reference is validated here. |
| `version_num` | `integer NOT NULL` | max+1 within `card_name` |
| `status` | `text NOT NULL` | `DRAFT` / `ACTIVE` / `SUPERSEDED` / `REJECTED` |
| `snapshot_date` | `date NOT NULL` | The file's `Date` column, **hoisted to the header** (RC3). It is the snapshot/extract date, constant across the file, never stored per row. It is also the source of `retired_at` (RC17). |
| `source_file` | `text NOT NULL` | Original filename, forensics only |
| `file_checksum` | `text` | Duplicate-upload detection |
| `row_count` | `integer NOT NULL` | Rows in the uploaded file |
| `carried_row_count` | `integer NOT NULL DEFAULT 0` | Rows carried forward as retired at activation (RC17); `0` until activated |
| `uploaded_by` / `uploaded_at` | `text` / `timestamptz(3)` | `uploaded_by` → `core.APPUSER`, the cross-schema provenance pattern used across `product` |
| `activated_by` / `activated_at` | `text` / `timestamptz(3)` | NULL until activated |
| `superseded_by_version_id` | `text` | Version lineage |
| `reject_summary` | `jsonb` | Row-level validation failures. **Report data, not domain state** — a bounded, write-once shape, still Zod-validated on write per platform §3's JSONB rule. |

**Constraints.** `UNIQUE (card_name, version_num)`; a **partial unique index on `card_name WHERE status = 'ACTIVE'`** — at most one ACTIVE version per card, the direct analogue of `product_offering`'s one-ACTIVE-per-family partial index. **A second partial index `WHERE status = 'DRAFT'` — decided (pm57, 2026-09-24, C8 option A), not merely recommended** — mirrors the one-open-version pattern exactly (§6.7). This document previously hedged ("recommended") while code-standards §6.27/§6.30 already stated it affirmatively; pm57 is the unit that writes the DDL, so it resolved the disagreement in code-standards' favor rather than leaving two doc voices. The accepted cost: with no discard and no `ratecard : DELETE` in Phase A, **an abandoned DRAFT blocks the next upload until it is activated** — recorded in the hand-off register, not hidden. In both cases the rule is enforced by the index, **not by application code** (RV1).

### 3.3 `product.RATECARD_RAN_USAGE_LKP` — the rows of one version

| Column | Type | Notes |
| --- | --- | --- |
| `ratecard_ran_usage_lkp_id` | `uuid` PK | `core.generate_ulid()` — a high-volume child table, matching the module's ULID convention rather than a padded sequence |
| `ratecard_version_id` | `text NOT NULL` FK → `ratecard_version` `ON DELETE CASCADE` | The only FK on the table |
| `mno_public_key` | `text NOT NULL` | key component ← UDR `PUBLIC_KEY` |
| `commercial_unit_public_key` | `text NOT NULL` | key component ← UDR `COMMERCIAL_UNIT` |
| `polygon_id` | `text NOT NULL` | key component ← UDR `SITE` (**assumption — OR7′**; lower stakes than v1 — no referential use — but the seed must load) |
| `polygon_start_date` | `date NOT NULL` | part of the row key (RC3′) |
| `lkp_subscriber_ref_id` | `text NOT NULL` | The subscription — a `product_inventory.product_inventory_id` value, format `PRDINV` + 8 digits (D-A1). **No FK**, matching `udr_rated`'s no-FK convention (Inv. #17); required; stored as uploaded, validated **structurally only**, no referential check. |
| `service_code` | `text` | A **plain attribute** — a value in a column, no further meaning (D-A6). Not part of any key; selects nothing; no cross-row rule. |
| `rate_per_unit` | `numeric(18,6) NULL` | A **plain nullable attribute** (D-A2) — no reserved rule, no `CHECK`, no activation ritual. If present, an optional decimal string through Zod. |
| `retired_at` | `date NULL` | NULL for an uploaded row. Set on a row **carried forward** at activation to the new version's `snapshot_date` (RC17). |

**Constraints.** `UNIQUE (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date)` (RV2) — the natural row key, needed for diff and carry-forward. Index on the same key columns for version-scoped lookup. **No capacity column, no currency column** (RC4).

> **Note on the row key vs "partitioning."** The uniqueness key above is the identity of a row *within a version*. It is not related to, and must not be confused with, v1's `service_code` partitioning of the price table — which is **removed**. `service_code` is **not** part of any key here.

**Empty-cell discipline.** The parser must distinguish an **empty cell** (→ NULL) from `"0"` or whitespace, and a **missing column** rejects the file (the contract changed). A parser that coerces an empty cell to `0` corrupts the data silently — ordinary data hygiene (D-A2), no test catches it unless written for exactly this. This is parser discipline, not a reserved-column guard.

### 3.4 `product_offering_price` — unchanged

`product_offering_price` is **not touched** by this update. v1 added a `service_code` column, a new per-`component_type` CHECK and a second uniqueness rekey here; **v2 removes all of that** (D-A1). `service_code` lives only on `RATECARD_RAN_USAGE_LKP` as a plain attribute (§3.3); it is neither on the price row nor in the `price_component` envelope. The pm46 uniqueness key `(offering, component_type, unit_of_measure, start_date_time)` stands exactly as delivered.

### 3.5 No partition-key ripple

v1 required a `service_code` `lead()` partition key to be kept identical across the price repository, `rp.py` and the bill-run template. With no `service_code` on the price table and no consumer defined here, **that ripple does not exist** — nothing in this delivery partitions, resolves or rates against the lookup.

### 3.6 Version lifecycle, and why the gate exists

```
upload ──► DRAFT ──(review + diff)──► ACTIVE ──(next activation)──► SUPERSEDED
             │                          ▲                              │
             └──► REJECTED              └───────── rollback ───────────┘
```

- **Upload lands as `DRAFT`; activation is a separate, explicit act** (RC7). A `DRAFT` version is parsed, validated, previewable, diffable, and **invisible to every run**. One permission covers both acts, so a single RevOps user is never blocked mid-task.
- **Versions are immutable once activated** (RC11). Rows are never edited in place; a correction is a new upload. **Upload is the only write path** — there is no row-level editing UI, by design.
- **A version's row set is the uploaded file plus the rows carried forward at activation** (RC17). This is the one place a version is not a byte-for-byte image of its file, and it is worth knowing before reading `row_count` beside `carried_row_count`.
- **Carry-forward, precisely.** On activation of v(n+1), every row in the outgoing `ACTIVE` whose key is **absent** from the new upload is copied into v(n+1) with `retired_at = COALESCE(src.retired_at, :new_snapshot_date)`. Three details each cause a silent wrong answer if missed: `retired_at` comes from **`snapshot_date`, not the wall clock** (or a version activated late carries different dates from one activated on time); the `COALESCE` stops an already-retired row being re-dated (or dead polygons quietly come back to life); and carried rows are **never re-validated** on subsequent activations. None of these fails loudly.
- **Un-retirement is free.** If a polygon reappears under the same keys, those keys are present, nothing is carried, and the uploaded rows arrive with `retired_at = NULL`.
- **Why the gate is not optional.** The diff plus the DRAFT gate is what turns activation into a review rather than a button. Without it, one mis-keyed CSV silently becomes the live version. The gate is the control the whole lifecycle is built around.

### 3.7 Re-rate drift — out of scope

v1 documented an accepted rating-drift exception (re-rates resolving against the current `ACTIVE` version rather than a first-rate snapshot). **v2 defines no consumer**, so there is no re-rate behaviour to reason about here at all. Whether and how a future consumer snapshots the `ACTIVE` version is that consumer's design; it is not owned or decided by this delivery.

### 3.8 Cross-runtime consequences — none in this delivery

Nothing reads the two new tables in this delivery. Storing them in `product.*` aligns ownership with the write direction (the app writes, the engine reads) but does **not** by itself grant read access. `app_runtime`'s `product.*` access is schema-wide and transparent — `bootstrap-db-roles.sql` grants it `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `ALL TABLES IN SCHEMA "product"` plus `ALTER DEFAULT PRIVILEGES` for future ones — so it reaches both new tables automatically. `rating_runtime` and `billrun_runtime` are different: `rating-db-roles.sql` (rm03) and `billrun-db-roles.sql` (bm14) each grant them `SELECT` on an **enumerated** per-table list (`product.product_offering`, `product.product_offering_price`), never `ALL TABLES`, and neither file sets default privileges for the `product` schema. Neither engine role can read `ratecard_version` or `RATECARD_RAN_USAGE_LKP` as created — a future consumer will need its own explicit per-table grant added to the relevant bootstrap file, which is out of scope here along with the consumer itself. `product_offering_price` is read by two non-application runtimes and by Ordering as before, and is **unchanged** (§3.4), so those readers are untouched.

**`rating.*` stays engine-owned and the app writes nothing into it.** The inverse — `product.*` written by the app, later read by a consumer — is exactly what RC8 / D-A4 rely on, and it is the reason this module is `pm` and not `rm`.

### 3.9 Unchanged storage

The three catalog tables, the pricing-component envelope and its per-`component_type` CHECKs, the `PRDOFR`/`PRDSMD`/`PRDOFP` sequences, the cascade FKs, the DRAFT-guard trigger, the expression unique indexes, the retirement gate, `product_offering_price` in full, `ordering` and `inventory` in full, and the audit log's role are all untouched. Historical billing basis is still reconstructed from price rows; the audit log remains forensics, never a rating or pricing source.

---

## 4. Authentication & Access Model

Auth mechanics are inherited unchanged from platform §5 — Better-Auth DB-backed sessions, status and effective permissions loaded per request, never cached, never in the session. Enforcement stays three-deep: page guard → action guard → repository.

**This update adds one route and, on the OR3 recommendation, one permission.**

| Action | Permission : level | Note |
| --- | --- | --- |
| View the version list, a draft's rows, and the diff | `ratecard : READ` | The page's declared guard. |
| Upload a new version (creates a `DRAFT`) | `ratecard : EDIT` | Same level as activation, so a single RevOps user is not blocked mid-task (RC7). |
| Activate a `DRAFT`; roll back to a `SUPERSEDED` version | `ratecard : EDIT` | The consequential act. It is gated by the **diff review**, not by a higher level. |

**OR3 — why a new permission rather than `products : EDIT`.** Reusing `products` means anyone who can edit a product description can replace the live rate-card lookup version, which sits badly beside the care taken in RC7. Cost of the new name: an RBAC seed row via a committed migration, the role-editor UI, the authz-matrix test, one more entry in a closed `as const` union, and the `NAV_REGISTRY` entry. *Owner: user.* If OR3 instead lands as "reuse `products`", the table above collapses to `products : READ` / `products : EDIT` and **this paragraph must be rewritten, not silently deleted** — the reasoning is the record of a decision, not commentary.

**The route × level matrix gains exactly one row** (`/products/rate-card`), and the authz sweep gains one route. Nav visibility filters through the same `NAV_REGISTRY` entry — a denied page is hidden, never shown locked — and the page guard remains the enforcement boundary.

**No machine-to-machine surface is added.** No bearer-token endpoint, no `app/api/product*`. A future consumer would read the card by **Postgres grant**, not over HTTP — which is why this module adds no M2M credential and no new credential direction (platform §5).

**No ownership model change.** Card versions are reference data owned by the version row, not by a user; `uploaded_by` / `activated_by` are provenance columns, not an ownership model. Customers (MNOs) remain domain data, not tenants — RLS stays unused.

---

## 5. Background Tasks & AI

**None, in this phase or any prior one. No AI/ML components anywhere in this module.**

- **Ingest is synchronous and in-process** (RC15). No Kestra flow, no staging table, no streaming, no queue, no scheduled job. At 5,000–5,500 rows (~0.5 MB) each of those is complexity without a payer. The engine exists and was **considered and set aside**, which is a different thing from being overlooked.
- **No sweeper retires rows.** Retirement happens synchronously inside the activation transaction (RC17), derived from `snapshot_date`. There is deliberately no clock-driven job anywhere near this data — see §3.6.
- **Retirement is stored at query-derivation time** from `polygon_start_date` / `retired_at`, mirroring how prices are effective-dated from `start_date_time`. No consumer resolves it here.
- **No later-phase compute is owned here.** Any future consumer of the lookup would run in a non-application runtime that never executes in-process (platform §6); it is out of scope.

**Audit.** **Three new event types**, one per mutation, written in the same transaction as the data change: `RATECARD_VERSION_UPLOADED`, `RATECARD_VERSION_ACTIVATED`, `RATECARD_VERSION_ROLLED_BACK`. The activation event's payload carries the superseded version id and the change counts (added / retiring / changed), the durable record of what a given activation altered. Page reads are never audited.

---

## 6. Module Invariants

Platform invariants (`architecture.md` §7) all apply — including Inv. #18, whose "a correction inserts a successor" rule the version model follows exactly: a card correction is a new version, never an edit. Module invariants **1–44** continue to apply, with the amendments below. Each rule here is testable and CI-enforceable.

### Amended by this update

| # | Rule | Change |
| --- | --- | --- |
| 2 | No overlapping effectivity | **Not amended by this update.** v2 makes no `product_offering_price` change (D-A1); the pm46 uniqueness key `(offering, component_type, unit_of_measure, start_date_time)` stands. The v1 rekey that added `service_code` here is withdrawn. |
| 28 | A price is complete for its type, or it does not exist | **Not amended by this update.** Completeness stays keyed to `component_type` as pm46 left it; `service_code` is not a price-row column, so the v1 "completeness includes `service_code`" amendment is withdrawn. |
| 34 | Exactly one `usage_rate` effective per `(offering, unit_of_measure)` | **Not amended by this update.** The key is unchanged; the v1 "gains `service_code`" amendment is withdrawn. |
| 42 | `rateCardLookUp` is a name, not a reference | **Not amended by this update.** `rateCardLookUp` stays a **validated name only, with no referent** — an unresolved string, no FK, no table wired behind it, exactly as pm47 left it. This delivery stands up a lookup table but defines **no consumer** that resolves the name, so nothing here makes the name a reference. The v1 "now has a referent" amendment is withdrawn. |
| 16 / 39 | Every price a customer pays is an immutable catalog row or an insert-only, approved override | **Reaffirmed, explicitly.** The lookup table is not a price source: it is stood up with no consumer. `ordering.order_item_price_override` is not read, modified, reshaped or reasoned about, and `rm08` D2's `COALESCE(override.amount, price.amount)` is untouched. |
| 43 | Product defines and stores components; it never prices them | **Reaffirmed.** Product stores a reference lookup table; it performs no lookup, no selection and no calculation, and no consumer of the table is defined here. It never prices anything. |

### New — introduced by the Rate Card Lookup update

45. **At most one `ACTIVE` version per `card_name`, enforced by a partial unique index** — not by application code (RV1). Within a version, `(mno, commercial_unit, polygon_id, polygon_start_date)` is unique (RV2).
46. **A version's rows are immutable once the version is `ACTIVE`.** Corrections are new uploads (RC11 / RV3). **Upload is the only write path** — no row-level editing exists, in the UI or in a service.
47. **`snapshot_date` is constant across every row of an upload** (RV4). A file that violates this is rejected whole — it is a real signal the file is not what we think it is, not a tolerable blemish.
48. **The `ACTIVE` version is self-sufficient** (RV9 / RC17). Every key present in the outgoing `ACTIVE` is present in the incoming one after activation, as an uploaded or a carried-forward row. **No lookup ever consults a superseded version**, which is what lets a future consumer read one version by a single flat scan. Asserted by an activation-time count check (`incoming keys ⊇ outgoing keys`) and by a guardrail test.
49. **`retired_at` is data, not clock.** It is always the new version's `snapshot_date`, never wall-clock activation time, and it is always `COALESCE`d against the source row's existing value. A version activated late must carry identical dates to one activated on time, and an already-retired row must never be re-dated.
50. **Withdrawn (v2).** *Was: a card miss rejects and never falls back (`RATECARD_LOOKUP_MISS`).* This is a consumer concern — no consumer of the lookup is defined in this delivery.
51. **An empty cell is not a zero.** Empty cell → NULL. Missing column → reject the file (the contract changed). `"0"` or whitespace is a distinct value and must not be conflated with an empty cell. This is the parser discipline (D-A2); coercing an empty cell to `0` corrupts the data silently, and these cases must never share a code path.
52. **Withdrawn (v2).** *Was: `rate_per_unit` is reserved and always NULL, guarded by a `CHECK`.* v2 makes `rate_per_unit` a plain nullable attribute (D-A2) — no reserved rule, no `CHECK`, no activation ritual.
53. **The lookup carries no currency.** No currency column exists on either table. A card that carries a priced currency is a different design and needs its own review.
54. **Withdrawn (v2).** *Was: `rateCardLookUp` and `service_code` mutually implied on `product_offering_price`.* `service_code` is not a price-row column in v2 (D-A1); it is a plain attribute on the lookup only.
55. **Withdrawn (v2).** *Was: every `usage_rate` row on one offering carries the same `rateCardLookUp` (`AMBIGUOUS_RATE_CARD`).* A consumer-side cross-row rule; no consumer is defined here.
56. **Withdrawn (v2).** *Was: the `lead()` partition key is identical in three places.* No `service_code` on the price table and no consumer means there is no partition-key ripple to keep in parity.
57. **`lkp_subscriber_ref_id` is a value reference, never an FK** (D-A1). It carries a `product_inventory.product_inventory_id` value, is `NOT NULL`, and is validated **structurally only** — present and non-empty per the upload contract. The v1 referential check against subscription status and window is **not** reinstated; that coupling is a consumer concern. Same no-FK stance as `udr_rated` (Inv. #17).
58. **The uploaded file is never stored.** Filename and checksum only; the rows are the record. No blob, no `landing/` drop, no retained original.
59. **The `ACTIVE` card version is never cached** — not in the app, not anywhere. The read surface is `force-dynamic`; a future consumer that reads it must do so live. A cache would silently diverge from the live version.
60. **Withdrawn (v2).** *Was: SVLCODE narrows within the pinned offering, preserving grandfathering.* A consumer concern — this delivery defines no consumer that selects an offering or a row.

### Guardrail re-scoping

| Guardrail | Change |
| --- | --- |
| 2 — price immutability | Unchanged in substance. Extended in spirit to card versions: an `ACTIVE` version's rows refuse UPDATE and DELETE. |
| 13 — schema-diff | **Re-baselined**: two new tables. **No change to `product_offering_price`** — the v1 `service_code` column, extended CHECK and re-rekeyed uniqueness index are all withdrawn. |
| **new** — version self-sufficiency | Asserts `incoming keys ⊇ outgoing keys` after every activation, and that no query path reads a `SUPERSEDED` version (Inv. #48). |
| **new** — upload is the only write path | Asserts the card repository exposes no row-level update or delete (Inv. #46). |

---

## 7. Known gaps this update does **not** close

Recorded so a future reader does not re-derive them. Each maps to an open item in `_updatemodule-ratecard-lookup-plan-v2.md`.

- **Nothing consumes the lookup.** This delivery stands up the table; the rating consumer that reads it is a following-sprint deliverable, out of scope here. An activated version is stored and auditable but **read by nothing** in this delivery. A deliberate state, not a defect.
- **Column mapping of the seeded file is assumed, not confirmed** (OR7′). `SITE ≡ polygon_id` is the least certain mapping. Lower stakes than v1 — there is no referential use — but the seed must load.
- **File format and parser are unpinned** (OR4). CSV is recommended; the library is not chosen (exact version, coercion off). Whatever is pinned must satisfy the empty-cell discipline (Inv. #51).
- **The permission is undecided** (OR3). §4 is written on the recommendation, not on a decision.
- **The v2 revision decisions await confirmation** (D-A1, D-A2, D-A3, D-A6): `lkp_subscriber_ref_id` structural-only, `rate_per_unit` as a plain column, `ratecard_version` not renamed, and the generic diff buckets.
- **Retention / purge policy is deferred** (OR-RET). Over time the lookup accumulates one ~5,500-row slice per version. Not a stand-up blocker — the hot path stays version-scoped by the leading `ratecard_version_id` index — but a retention/purge policy for superseded versions is a later plan, not this one.
- **Capacity has no home** (RC4). It is not in the card. If a polygon's coverage capacity is ever needed as a service attribute, the catalog owns it — and that is a catalog design task nobody has started.
- **Unit of measure still has no shared vocabulary**, unchanged from the pricing update — three independent columns across `product`, `rating` and `billing`. The card does not touch units, so it neither worsens nor helps this.
