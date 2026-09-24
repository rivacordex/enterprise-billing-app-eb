# Rate Card Lookup — `RATECARD_RAN_USAGE_LKP` (Products → Rate Card) — v2

**Supersedes:** `_updatemodule-ratecard-lookup-plan.md` (v1). This revision **narrows scope**: it stands up a single, end-user-managed lookup table and its upload lifecycle, and it **stops there**. It defines no consumer of the data — not rating, not bill run, not product pricing.

**Type:** Update module (Product Management, `pm`-series). Adds two **new** tables and a page. Unlike v1, it **touches no delivered table** — in particular it makes **no change to `product_offering_price`** — so it is **independent of the Part 4 (pm46–pm54) atomic window**.
**Module:** Rate Card Lookup — a Revenue-Ops-managed reference table, uploaded and versioned, stood up so that a future consumer (rating) can read it. This delivery builds the table and its management surface; it does **not** build the consumer.
**Users:** Revenue Operations — upload, review, activate, roll back.
**Status:** Design (v2). Restated objective; `service_code` downgraded to a plain attribute; lookup table renamed.
**Companion docs:** `context/product-management/specs/pm00-build-plan.md`, `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`. v1's rating companions (`rm08`, `ran-usage-rating.yaml`) are **no longer referenced** — no rating work is in scope.

---

## 0. Objective (restated)

**Stand up a custom rate-card lookup table — `RATECARD_RAN_USAGE_LKP` — that Revenue Operations can manage (upload, review, activate, roll back), and that a rating consumer can later read.** The table must exist, be populated, and be governed by the version lifecycle **by the end of this delivery**. Nothing in this delivery *uses* the data.

Explicitly **not** an objective: defining how rating, bill run, or product pricing consume the table, or attaching any pricing/rating significance to any column.

```
   THIS DELIVERY                                   OUT OF SCOPE (future)
   ─────────────                                   ─────────────────────
   RATECARD_RAN_USAGE_LKP stood up                 how rating reads it
   + version/config tracking                       any bill-run impact
   + RevOps upload / diff / activate / rollback    product pricing / service_code semantics
   + carry-forward, CSV parser, UI                 creating additional lookup tables
   + seeded with 1 customer dataset (Phase 1)
```

---

## 1. What changed from v1 (delta summary)

| Area | v1 | v2 |
|---|---|---|
| **Objective** | key resolver feeding rating (subscription + service code + reserved rate) | **stand up the table**; consumer undefined and out of scope |
| **Phase B (rating)** | in plan, gated on pm51 | **removed entirely** |
| **`service_code`** | selects a `product_offering_price` row; drives a uniqueness re-key and a 3-site `lead()` partition | **plain text column** on the lookup table; **no** partitioning, **no** pricing/rating derivation |
| **`product_offering_price`** | gains `service_code`, re-keyed, 3-site partition amend, authoring UI | **untouched** |
| **`subscription_id`** | referential check against `inventory.product_inventory` (RV8) | **renamed `lkp_subscriber_ref_id`**, `NOT NULL`, carries a `product_inventory_id` value, **no FK**, no referential check (D-A1) |
| **`rate_per_unit`** | reserved, `CHECK (… IS NULL)`, activation ritual, OR12 precedence | **plain nullable column**, ritual removed (see D-A2) |
| **Lookup table name** | `product.ratecard_lookup` | **`RATECARD_RAN_USAGE_LKP`** |
| **Part 4 coupling** | Phase A inside/after the pm46–pm54 window | **decoupled** — touches no delivered table |
| **Table creation** | one card, name free-text (OR5 open) | **one seeded card only**; creating new lookup tables **out of scope** |

---

## 2. Decisions taken in this v2 revision — confirm before build

These are the judgment calls made translating the new scope. Each is a real fork; correct any that are wrong.

- **D-A1 (resolved) — `subscription_id` is renamed `lkp_subscriber_ref_id`, is `NOT NULL`, and carries a `product_inventory.product_inventory_id` value** (format `PRDINV` + 8 digits, `inventory.ts:40-44`). **No FK** — matching `rating.udr_rated`'s no-FK convention (Inv #17), where the eventual downstream sink `udr_subscriber_ref_id` is likewise plain `text`. Validated **structurally only** (present, non-empty, required per the contract); the v1 referential check against `inventory.product_inventory` status/window (RV8) is **not** reinstated — that coupling is a consumer concern, out of scope.
- **D-A2 — `rate_per_unit` is a plain nullable numeric column.** The v1 "reserved / `CHECK (rate_per_unit IS NULL)` / activate-by-dropping-the-CHECK / OR12 precedence" machinery is removed, because it encoded future pricing significance. The empty-cell-≠-zero parser discipline (§7) is retained as ordinary data hygiene, not as a reserved-column guard. *Alternative: drop the column entirely if it carries no data in the seeded file.*
- **D-A3 — `ratecard_version` remains the config/version tracker and is not renamed.** Only the lookup table is renamed. `ratecard_version` registers the tracked card and its versions; in Phase 1 it holds exactly one `card_name`. *Alternative: rename to `ratecard_ran_usage_version` for symmetry.*
- **D-A4 — Storage stays in the `product` schema, spec series `pm`.** The app writes it, and it is managed from the Products surface. Unchanged from v1 RC8. *Alternative: a dedicated `reference` schema — deferred, no functional difference for this delivery.*
- **D-A5 — One card, seeded, fixed.** Phase 1 seeds a single `card_name` and its initial dataset. There is **no UI to create a second card or a second lookup table** (out of scope). The upload surface uploads **new versions of the one seeded card** only.

---

## 3. Scope

### In
- The two tables: `product.ratecard_version` (config/version tracker) and `product.RATECARD_RAN_USAGE_LKP` (rows), in one forward-only migration.
- **Ability for Revenue Ops to upload files** (CSV), synchronously, as a new `DRAFT` version.
- **Upload contract validation** — structural (header/columns, constant snapshot date, duplicate row keys, cell types). No cross-module referential validation (D-A1).
- **CSV parser** — the one pinned dependency; coercion off; empty cell preserved.
- **Diff** against the current `ACTIVE` version.
- **Activate / rollback**, with the **carry-forward** of dropped rows at activation.
- **The `/products/rate-card` UI** — version list, row preview, diff, upload/activate/rollback controls.
- **Phase 1 seed** — one customer dataset, activated through the real path, and the config row that tracks this one table.
- RBAC (a `ratecard` permission, OR3), audit events, nav entry.

### Out
- **How the lookup data is used** — any resolution, as-of matching, or consumer logic. The table is stood up; nothing reads it.
- **Any bill-run impact** — no aggregation, no charge computation, no `customer_bill_line`, no flow YAML.
- **Any rating-engine change** — no `rp.py`, no card join, no lookup-miss, no `udr_rated` stamps. (All of v1 Phase B.)
- **Any `product_offering_price` change** — no `service_code` column, no re-key, no `lead()` partition amend, no authoring form. (All of v1's ripple.)
- **Creating / configuring / setting up new lookup tables** — Phase 1 tracks exactly one, seeded. No table-creation surface.
- Rate-card **row authoring** (row-by-row editing) — upload is the only write path.
- Capacity of any kind (no capacity column); currency (no currency column).

---

## 4. The tables

### `product.ratecard_version` — the config / version tracker

One row per upload of the tracked card. In Phase 1 there is exactly one `card_name`.

| Column | Type | Notes |
|---|---|---|
| `ratecard_version_id` | `text` PK | `RCV` + 8-digit sequence |
| `card_name` | `text NOT NULL` | the tracked lookup's identifier; **one seeded value in Phase 1** (D-A5) |
| `version_num` | `integer NOT NULL` | max+1 within `card_name` |
| `status` | `text NOT NULL` | `DRAFT` / `ACTIVE` / `SUPERSEDED` / `REJECTED` |
| `snapshot_date` | `date NOT NULL` | the file's hoisted `Date` column; constant across the file |
| `source_file` | `text NOT NULL` | original filename, forensics only |
| `file_checksum` | `text` | duplicate-upload detection (warning only) |
| `row_count` | `integer NOT NULL` | rows in the uploaded file |
| `carried_row_count` | `integer NOT NULL DEFAULT 0` | rows carried forward as retired at activation |
| `uploaded_by` / `uploaded_at` | `text` / `timestamptz(3)` | |
| `activated_by` / `activated_at` | `text` / `timestamptz(3)` | NULL until activated |
| `superseded_by_version_id` | `text` | |
| `reject_summary` | `jsonb` | reserved; no writer in this delivery |

Constraints: `UNIQUE (card_name, version_num)`; a **partial unique index** on `card_name WHERE status = 'ACTIVE'` (at most one live version); a partial unique index on `card_name WHERE status = 'DRAFT'` (at most one open draft — the DB analogue of `product_offering`'s one-open-version rule).

### `product.RATECARD_RAN_USAGE_LKP` — the rows of one version

| Column | Type | Notes |
|---|---|---|
| `ratecard_ran_usage_lkp_id` | `uuid` PK | `core.generate_ulid()` |
| `ratecard_version_id` | `text NOT NULL` FK → `ratecard_version` `ON DELETE CASCADE` | |
| `mno_public_key` | `text NOT NULL` | key component |
| `commercial_unit_public_key` | `text NOT NULL` | key component |
| `polygon_id` | `text NOT NULL` | key component |
| `polygon_start_date` | `date NOT NULL` | key component (part of the row key) |
| `lkp_subscriber_ref_id` | `text NOT NULL` | the subscription — a `product_inventory.product_inventory_id` value (`PRDINV`+8 digits). **No FK** (matches `udr_rated` Inv #17); required; stored as uploaded, no referential check (D-A1) |
| `service_code` | `text` | **plain attribute — a value in a column, no further meaning** (see §5) |
| `rate_per_unit` | `numeric(18,6) NULL` | **plain nullable attribute** — no reserved ritual (D-A2) |
| `retired_at` | `date NULL` | NULL for an uploaded row; set on a row carried forward at activation |

Constraints: `UNIQUE (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date)` — the natural row key, needed for diff and carry-forward. Index on the same key columns for lookup. **No capacity column, no currency column.**

> **Note on the row key vs "partitioning."** The uniqueness key above is the identity of a row *within a version*. It is not related to, and must not be confused with, v1's `service_code` partitioning of the product price table — which is **removed** (§5). `service_code` is **not** part of any key here.

---

## 5. `service_code` — a plain column, and nothing more

`service_code` is a `text` column on `RATECARD_RAN_USAGE_LKP` carrying whatever value the upload provides. It is **data**. Specifically, in v2 it:

- is **not** part of any uniqueness key or index partition;
- does **not** appear on `product_offering_price` (that column is not added);
- does **not** select a price row, derive a rate, or influence any pricing or rating logic;
- has **no** cross-row invariant (v1's `AMBIGUOUS_RATE_CARD` / same-card-name rule is removed);
- is validated **structurally only** — present/typed per the upload contract — like any other column.

Every reference to `service_code` "selecting a `usage_rate` row," "narrowing within the pinned offering," or driving effectivity is **removed** from this plan. If a future consumer needs to interpret it, that is that consumer's design, out of scope here.

---

## 6. Lifecycle

```
   UPLOAD              REVIEW              ACTIVATE            LATER
   ──────              ──────              ────────            ─────
   CSV in       →      DRAFT       →       ACTIVE      →      SUPERSEDED
   validated           (parked,            (the one            (kept for
   (structural)        diffable)           live version)        audit + rollback)
        │
        └─ invalid? → row-level error table, NOTHING written
```

- **Upload** (RC7, RC15) — RevOps uploads a CSV (~5,000–5,500 rows, ~0.5 MB). The server parses and validates structurally; a valid file becomes a `DRAFT`; an invalid one returns a row-level error report and **writes nothing**. Synchronous server action; **no** Kestra, staging table, or streaming. Insert in 1,000-row batches inside one transaction. Raise `serverActions.bodySizeLimit` to `4mb`.
- **DRAFT** — parsed, validated, previewable, diffable, invisible to any consumer. At most one open draft per card.
- **Diff** — added / removed / changed rows against the current `ACTIVE`. This is the control that makes activation a review rather than a button. (Buckets are generic add/remove/change; v1's subscription/service-code billing-consequence buckets are no longer meaningful and collapse to a plain changed set — see D-A6 note below.)
- **Activate** (RC7, RC17) — `DRAFT` → `ACTIVE`; prior `ACTIVE` → `SUPERSEDED`; **carry forward** dropped rows as retired. One transaction, one lock, status read on `tx`. At most one `ACTIVE` per card, enforced by the partial unique index.
- **Rollback** (RC11) — re-activate a `SUPERSEDED` version; two status flips, no carry-forward, no row edits (versions are immutable).

> **D-A6 — Diff buckets.** With `subscription_id` and `service_code` now plain attributes, v1's four billing-consequence buckets (reassignment / code-change / added / retiring) lose their special meaning. v2 keeps **added / retiring / changed** (a row whose non-key columns differ), plus the "retiring = carried forward, closed at `<snapshot_date>`" labelling that the carry-forward model still needs. Confirm this is sufficient for RevOps review.

### Carry-forward (retained from v1 RC17)

Uploads are complete current-state snapshots. At activation, any key present in the outgoing `ACTIVE` version but **absent** from the new upload is copied into the new version with `retired_at` set — so the new version stays self-sufficient. One set-based `INSERT … SELECT`, never a loop. Three properties that fail silently if missed remain in force:

1. `retired_at` = the **new version's `snapshot_date`**, never a clock value.
2. `COALESCE(src.retired_at, :new_snapshot_date)` — an already-retired row keeps its original date.
3. Carried rows are **never re-validated** on subsequent activations.

---

## 7. Validation & CSV parser

**Structural validation** (`validation/product/ratecard.schema.ts`) — `strictObject`, pm47 house style:
- Header match against the expected column set; unknown column rejected, missing column = file rejected (contract changed).
- `snapshot_date` (the file's `Date`) constant across all rows; a varying value rejects the file whole.
- No duplicate row key `(mno, commercial_unit, polygon, polygon_start_date)`; report both line numbers.
- Per-cell typing per the contract. `rate_per_unit`, if present, is an optional decimal string (no "reserved/empty" rule — D-A2).
- **No cross-module referential validation** (D-A1). No capacity field, no currency field.

**CSV parser** (`services/product/ratecard/parse-csv.ts`) — the one file importing the pinned parser (exact version, coercion **off**). Every cell a string; an empty cell stays `""` (never `0`); leading-zero keys survive; dates stay `YYYY-MM-DD` strings. Buffered/synchronous at this volume; the file itself is never stored (filename + checksum only). Line numbering: header is line 1, first data row is line 2, honoured end to end.

---

## 8. Services, actions, UI, seed, permission

- **Services/actions:** `upload-version`, `activate-version` (+ carry-forward), `rollback-version`, `diff-versions`; repository `db/repositories/ratecard.ts` (flat path); one audit event per upload/activate/rollback in the same transaction. No row-level update/delete is exported — **upload is the only write path.**
- **UI `/products/rate-card`:** version list (status badge, snapshot date, row/carried counts), paged/filterable row preview, diff view, upload/activate/rollback dialogs (first `<input type=file>` in the app; uncontrolled, `FormData`, never in form state). Uncached (`force-dynamic`). Read UI ships before write UI. No status banner — the table is stood up on the assumption it will be consumed (rating, a following sprint).
- **Phase 1 seed** (`db/seeds/demo/…` and the tracked-card config): seed **one** `card_name` and its initial `RATECARD_RAN_USAGE_LKP` dataset, created **through the real upload + activate path** (so the guards are exercised and the audit trail is real). Small, human-readable — not 5,400 rows. This is the "1 customer lookup table" of Phase 1; the config tracks **only** it.
- **Permission (OR3):** a new `ratecard` permission (READ/EDIT), recommended over reusing `products`. READ reaches the read surface; EDIT reaches upload/activate/rollback. No DELETE level.

---

## 9. Decisions carried from v1 (still in force)

- **RC3′** — Row key is `(mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date)`; `polygon_start_date` is part of the key. The v1 "as-of matching" *semantics* are a consumer concern and are **out of scope**; the columns remain as the row key for uniqueness, diff and carry-forward.
- **RC4** — No capacity column.
- **RC7** — Upload lands `DRAFT`; activation is a separate explicit act; one permission covers both.
- **RC8 / D-A4** — Storage in `product.*`, spec series `pm`, route `/products/rate-card`.
- **RC11** — Versions are immutable once activated; a correction is a new upload; superseded versions are retained for audit and rollback.
- **RC12** — One forward-only migration, `0041_ratecard_ran_usage_lkp.sql`, a new file. `0006_product.sql` is **not** reopened. **No `ALTER` on `product_offering_price`** (v2 removes v1's price-table changes).
- **RC15** — Synchronous ingest; `bodySizeLimit: '4mb'`; 1,000-row batches in one transaction; in-memory diff.
- **RC17** — Carry-forward at activation (§6).

**Removed from v1:** RC1/RC2 (key-resolver-for-rating), RC5 (accepted rating drift), RC6 (lookup-miss reject), RC9 (card-name loop-break), RC13 (reserved rate), RC14 (subscription resolution), RC16 (override interaction). All concern how the data is *used*, which is out of scope.

---

## 10. Invariants

- **RV1** — At most one `ACTIVE` version per `card_name` (partial unique index).
- **RV2** — Within a version, `(mno, commercial_unit, polygon, polygon_start_date)` is unique.
- **RV3** — A version's rows are immutable once `ACTIVE`.
- **RV4** — `snapshot_date` is constant across an upload; a violation rejects the file.
- **RV9** — After activation the `ACTIVE` version is self-sufficient (incoming keys ⊇ outgoing), via carry-forward.

**Removed from v1:** RV5, RV6, RV7 (all `service_code` ↔ `product_offering_price` couplings), RV8 (subscription referential check — D-A1).

---

## 11. Impact on the existing pm57–pm71 specs

The v1 specs (commit a6f8745) were generated from v1. Under v2:

| Spec | Fate under v2 |
|---|---|
| **pm57** schema + price delta | **Revise** — keep the two card tables (renamed); **drop** the `service_code` column on `product_offering_price`, the uniqueness re-key, and the price-table CHECK. Migration renamed. |
| **pm58** price partition amend + `AMBIGUOUS_RATE_CARD` | **Drop** — no price-table change, no cross-row card rule. |
| **pm59** `rp.py` partition amend | **Drop** — no rating change. |
| **pm60** upload contract validation | **Revise** — structural only; drop the reserved-column-empty rule and the subscription severity cases (D-A1/D-A2). |
| **pm61** CSV parser | **Keep** (rename table refs). |
| **pm62** repository | **Keep** — rename to `RATECARD_RAN_USAGE_LKP`. |
| **pm63** upload service + action | **Revise** — drop the RV8 set-based subscription query. |
| **pm64** diff | **Revise** — generic add/remove/change buckets (D-A6). |
| **pm65** activate + carry-forward | **Keep**. |
| **pm66** rollback | **Keep**. |
| **pm67** page + read UI | **Keep** — no banner (rating consumes in a following sprint); read surface only. |
| **pm68** write UI + `bodySizeLimit` | **Keep**. |
| **pm69** `service_code` authoring on the price form | **Drop** — no price-table involvement. |
| **pm70** demo seed | **Elevate** — becomes the Phase 1 seed of the one tracked table. |
| **pm71** ship gate | **Revise** — drop guardrails tied to the price ripple (partition parity, price CHECK, authz overlap with pricing); no dependency on pm52/pm59/Part 4. |

Net effect: **pm58, pm59, pm69 drop; pm57, pm60, pm63, pm64, pm71 shrink; the Part 4 coupling disappears.**

---

## 12. Open items

**None blocking the table stand-up.**

- **OR3 — Permission.** New `ratecard` permission vs reuse `products`. *Recommendation: new `ratecard`.*
- **OR4 — File format / parser.** CSV; pin one library (exact version, coercion off).
- **OR7′ — Column mapping of the seeded file.** Confirm the seed file's column set matches the table (`SITE ≡ polygon_id`, etc.). Lower stakes than v1 (no referential use), but the seed must load.
- **D-A1, D-A2, D-A3, D-A6** — the revision decisions in §2/§6, for confirmation.
- **OR-RET — Retention / purge policy (deferred to a later plan).** Over the long run `RATECARD_RAN_USAGE_LKP` accumulates one ~5,500-row slice per version. This is **not** a stand-up blocker: the hot path stays version-scoped by the leading `ratecard_version_id` index, so per-lookup cost does not grow with total rows. A retention/purge policy for superseded versions — and, only if it is ever needed, a partition-by-month trigger for cheap `DROP PARTITION` retention — is **to be captured and delivered in a later plan**, not here.

**Retired from v1 as no longer relevant:** OR5 (card identity — resolved by D-A5, one seeded card), OR11 (Part 4 merge point — decoupled), OR12 (override precedence — no rate significance), OR1/OR2/OR8 (already closed).

---

## 13. Sequencing

Single phase. No cross-module dependency, no Part 4 window.

```
  0041 migration (2 tables)
        │
        ├─ CSV parser ── validation ── repository
        │        │            │            │
        │        └────────────┴────────────┘
        │                     │
        │              upload · diff · activate(+carry-forward) · rollback
        │                     │
        │              read UI ── write UI (+ bodySizeLimit)
        │                     │
        └───────────► Phase 1 seed (one card, one dataset, via the real path)
                              │
                        ship gate
```

**Definition of done:** `RATECARD_RAN_USAGE_LKP` and its version/config tracker exist from an empty database; Revenue Operations can upload, review, activate and roll back versions of the one seeded card through the UI; carry-forward preserves retired rows — and no code in this delivery reads, resolves, prices, or bills from the table; the rating consumer is a following-sprint deliverable.
