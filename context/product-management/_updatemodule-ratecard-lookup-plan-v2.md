# Rate Card Lookup — `RATECARD_RAN_USAGE_LKP` (Products → Rate Card)

**Type:** Update module (Product Management, `pm`-series). Adds two **new** tables and a page. It **touches no delivered table** — in particular it makes **no change to `product_offering_price`** — so it is **independent of the Part 4 (pm46–pm54) atomic window**.
**Module:** Rate Card Lookup — a Revenue-Ops-managed reference table, uploaded and versioned, stood up so that a future consumer (rating) can read it. This delivery builds the table and its management surface; it does **not** build the consumer.
**Users:** Revenue Operations — upload, review, activate, roll back.
**Status:** Design.
**Companion docs:** `context/product-management/specs/pm00-build-plan.md`, `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`. No rating work is in scope; the rating consumer is a separate, following-sprint deliverable.

---

## 0. Objective

**Stand up a custom rate-card lookup table — `RATECARD_RAN_USAGE_LKP` — that Revenue Operations can manage (upload, review, activate, roll back), and that a rating consumer can later read.** The table must exist, be populated, and be governed by the version lifecycle **by the end of this delivery**. Nothing in this delivery *uses* the data.

Explicitly **not** an objective: defining how rating, bill run, or product pricing consume the table, or attaching any pricing/rating significance to any column.

```
   THIS DELIVERY                                   OUT OF SCOPE (future)
   ─────────────                                   ─────────────────────
   RATECARD_RAN_USAGE_LKP stood up                 how rating reads it
   + version/config tracking                       any bill-run impact
   + RevOps upload / diff / activate / rollback    product pricing / service_code semantics
   + CSV parser, UI                                creating additional lookup tables
                                                   carry-forward / retired-row history
   + seeded with 1 customer dataset (Phase 1)
```

---

## 1. Design decisions

The load-bearing choices for the table and its lifecycle.

- **D-A1 — `lkp_subscriber_ref_id` is `NOT NULL` and carries a `product_inventory.product_inventory_id` value** (format `PRDINV` + 8 digits, `inventory.ts:40-44`). **No FK** — matching `rating.udr_rated`'s no-FK convention (Inv #17), where the eventual downstream sink `udr_subscriber_ref_id` is likewise plain `text`. Validated **structurally only** (present, non-empty, required per the contract); there is **no** referential check against `inventory.product_inventory` — that coupling is a consumer concern, out of scope.
- **D-A2 — `rate_per_unit` is a plain nullable numeric column.** No CHECK, no reserved rule. It is stored as uploaded when present and NULL when the cell is empty. The empty-cell-≠-zero parser discipline (§6) is ordinary data hygiene, not a reserved-column guard.
- **D-A3 — `ratecard_version` is the config/version tracker.** It registers the tracked card and its versions; in Phase 1 it holds exactly one `card_name`.
- **D-A4 — Storage stays in the `product` schema, spec series `pm`.** The app writes it, and it is managed from the Products surface.
- **D-A5 — One card, seeded, fixed.** Phase 1 seeds a single `card_name` and its initial dataset. There is **no UI to create a second card or a second lookup table** (out of scope). The upload surface uploads **new versions of the one seeded card** only.
- **D-A7 — No carry-forward; a version is exactly its uploaded file.** Mediation filters retired polygons out of the CUPS file upstream, so the upload is the authoritative current state and a polygon absent from it is decommissioned. Nothing is copied into a new version at activation, and there is no `retired_at`. History is not lost: superseded versions are retained immutably (RC11), so a key removed in v(n+1) is still present in v(n). How a future consumer resolves a past period is that consumer's design.
- **D-A8 — `snapshot_date` is the upload date; the file has no snapshot-date column.** `snapshot_date` is set by the upload service to the **calendar date of the upload in the app timezone** — the IANA zone configured in `APP_TIMEZONE` (default `UTC`; `lib/config.ts`) — not read from the file. A file uploaded late records a later `snapshot_date`. This is accepted, because nothing in this delivery reads `snapshot_date` for matching.
- **D-A9 — The row identity within a version is `(mno_public_key, commercial_unit_public_key, polygon_id)`.** `polygon_start_date` is **not** part of the row key: a given polygon appears **at most once per version**. `polygon_start_date` and `polygon_end_date` are descriptive validity-window dates — `polygon_start_date` required, `polygon_end_date` nullable (`NULL` = open-ended / still active) — read by no key and no index in this delivery.
- **D-A10 — `state` and `district` are descriptive labels.** Plain nullable `text` columns, uploaded and stored, read by nothing. They are **candidate** key components for a future consumer, but carry **no** key, uniqueness or partition meaning here — for all present purposes they are plain descriptive data, like `service_code` (§4).
- **D-A11 — an open `DRAFT` is replaced by re-upload, not blocked.** The one-`DRAFT`-per-card partial unique index means a card holds at most one open draft. If RevOps uploads the wrong file, a second upload for the same card **replaces** the open draft: inside the upload transaction the existing draft is discarded whole (a `DRAFT`-guarded version delete; its rows go by `ON DELETE CASCADE`) and the new draft is inserted. This is the recovery path — without it a single fat-fingered upload would block every future upload for the card until it was activated. It stays inside the scope rules: **no `ratecard : DELETE`, no standalone "discard" control, no fourth audit type** (the replace emits the same one upload event) and **no fourth action file** (the discard is a repository write). Lookup rows are still only inserted or cascade-removed, never edited (Inv. #46). This **reopens and resolves C2**: a discard exists, but only implicitly via re-upload.

---

## 2. Scope

### In
- The two tables: `product.ratecard_version` (config/version tracker) and `product.RATECARD_RAN_USAGE_LKP` (rows), in one forward-only migration (RC12).
- **Ability for Revenue Ops to upload files** (CSV), synchronously, as a new `DRAFT` version.
- **Upload contract validation** — structural (header/columns, duplicate row keys, cell types). No cross-module referential validation (D-A1).
- **CSV parser** — the one pinned dependency; coercion off; empty cell preserved.
- **Diff** against the current `ACTIVE` version.
- **Activate / rollback** — status flips only; no row writes (D-A7).
- **The `/products/rate-card` UI** — version list, row preview, diff, upload/activate/rollback controls.
- **Phase 1 seed** — one customer dataset, activated through the real path, and the config row that tracks this one table.
- RBAC (a `ratecard` permission, OR3), audit events, nav entry.

### Out
- **How the lookup data is used** — any resolution, as-of matching, or consumer logic. The table is stood up; nothing reads it.
- **Any bill-run impact** — no aggregation, no charge computation, no `customer_bill_line`, no flow YAML.
- **Any rating-engine change** — no `rp.py`, no card join, no lookup-miss, no `udr_rated` stamps.
- **Any `product_offering_price` change** — no `service_code` column, no re-key, no partition amend, no authoring form.
- **Creating / configuring / setting up new lookup tables** — Phase 1 tracks exactly one, seeded. No table-creation surface.
- Rate-card **row authoring** (row-by-row editing) — upload is the only write path.
- Capacity of any kind (no capacity column); currency (no currency column).
- **Carry-forward / retired-row history** — no `retired_at`, no re-insertion of polygons absent from an upload (D-A7). Mediation filters retired polygons upstream; superseded versions hold the history.

---

## 3. The tables

### `product.ratecard_version` — the config / version tracker

One row per upload of the tracked card. In Phase 1 there is exactly one `card_name`.

| Column | Type | Notes |
|---|---|---|
| `ratecard_version_id` | `text` PK | `RCV` + 8-digit sequence |
| `card_name` | `text NOT NULL` | the tracked lookup's identifier; **one seeded value in Phase 1** (D-A5) |
| `version_num` | `integer NOT NULL` | max+1 within `card_name` |
| `status` | `text NOT NULL` | `DRAFT` / `ACTIVE` / `SUPERSEDED` / `REJECTED` |
| `snapshot_date` | `date NOT NULL` | calendar date of the upload in the app timezone, set by the service; not in the file (D-A8) |
| `source_file` | `text NOT NULL` | original filename, forensics only |
| `file_checksum` | `text` | duplicate-upload detection (warning only) |
| `row_count` | `integer NOT NULL` | rows in the uploaded file |
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
| `polygon_start_date` | `date NOT NULL` | validity-window start — **descriptive, not a key component** (D-A9) |
| `polygon_end_date` | `date` | validity-window end; `NULL` = open-ended / still active — **descriptive** (D-A9) |
| `state` | `text` | **plain descriptive label** — candidate future key component, no meaning here (D-A10) |
| `district` | `text` | **plain descriptive label** — candidate future key component, no meaning here (D-A10) |
| `lkp_subscriber_ref_id` | `text NOT NULL` | the subscription — a `product_inventory.product_inventory_id` value (`PRDINV`+8 digits). **No FK** (matches `udr_rated` Inv #17); required; stored as uploaded, no referential check (D-A1) |
| `service_code` | `text` | **plain attribute — a value in a column, no further meaning** (see §4) |
| `rate_per_unit` | `numeric(18,6) NULL` | **plain nullable attribute** — no reserved ritual (D-A2) |

Constraints: `UNIQUE (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)` — the natural row key, needed for diff (D-A9). This version-scoped uniqueness index is the only lookup index required; **there is no separate as-of index** (with `polygon_start_date` out of the key, nothing reads rows by date). **No capacity column** (RC4), **no currency column**.

> **Note on the row key.** The uniqueness key above is the identity of a row *within a version*. `service_code`, `state`, `district`, `polygon_start_date` and `polygon_end_date` are **not** part of any key or index — they are plain columns (§4).

Both tables land in one forward-only migration; `0006_product.sql` is **not** reopened (RC12).

---

## 4. `service_code`, and the other plain columns

`service_code` is a `text` column on `RATECARD_RAN_USAGE_LKP` carrying whatever value the upload provides. It is **data**. Specifically it:

- is **not** part of any uniqueness key or index partition;
- does **not** appear on `product_offering_price` (that column is not added);
- does **not** select a price row, derive a rate, or influence any pricing or rating logic;
- has **no** cross-row invariant;
- is validated **structurally only** — present/typed per the upload contract — like any other column.

`state` and `district` (D-A10), and the `polygon_start_date` / `polygon_end_date` validity dates (D-A9), are the same: uploaded, stored, structurally validated, and read by nothing in this delivery. If a future consumer needs to interpret any of them, that is that consumer's design, out of scope here.

---

## 5. Lifecycle

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
- **DRAFT** — parsed, validated, previewable, diffable, invisible to any consumer. At most one open draft per card; a new upload for the card **replaces** the open draft (D-A11).
- **Diff** — added / changed / removed rows against the current `ACTIVE` (D-A6).
- **Activate** (RC7) — `DRAFT` → `ACTIVE`; prior `ACTIVE` → `SUPERSEDED`. Two status flips, **no row writes** (D-A7). One transaction, one lock, status read on `tx`. At most one `ACTIVE` per card, enforced by the partial unique index.
- **Rollback** (RC11) — re-activate a `SUPERSEDED` version; two status flips, no row edits (versions are immutable). Activate and rollback have the same shape.

> **D-A6 — Diff buckets.** With `subscription_id`, `service_code`, `state` and `district` all plain attributes, the diff keeps **added / changed / removed**: *changed* is a key whose non-key columns differ; *removed* is a key in the current `ACTIVE` that is absent from the upload. With no carry-forward (D-A7), *removed* means exactly that — the row is not in the new version and stays readable in the superseded one.

### No carry-forward (D-A7)

Uploads are complete current-state snapshots, and mediation has already filtered retired polygons out of them. A version's row set is **exactly its uploaded file**: nothing is copied in at activation, and there is no `retired_at`. A polygon dropped between v(n) and v(n+1) appears in the diff as *removed* and stays readable in v(n), which is retained immutably for audit and rollback.

---

## 6. Validation & CSV parser

**Structural validation** (`validation/product/ratecard.schema.ts`) — `strictObject`, pm47 house style:
- Header match against the expected column set; unknown column rejected, missing column = file rejected (contract changed).
- **The column set.** The header text is exact, case-sensitive and in any order:

  | File header | Table column | Required |
  |---|---|---|
  | `MNO Name` | `mno_public_key` | yes |
  | `Commercial Unit ID` | `commercial_unit_public_key` | yes |
  | `Polygon ID` | `polygon_id` | yes |
  | `Polygon Start Date` | `polygon_start_date` (`YYYY-MM-DD`) | yes |
  | `Polygon End Date` | `polygon_end_date` (`YYYY-MM-DD`) | no |
  | `State` | `state` | no |
  | `District` | `district` | no |
  | `Subscriber Reference ID` | `lkp_subscriber_ref_id` | yes |
  | `Service Code` | `service_code` | no |
  | `Rate per Unit` | `rate_per_unit` | no |

  There is no snapshot-date column (D-A8). pm58 D0 holds the full cell rules.
- No duplicate row key `(mno, commercial_unit, polygon)`; report both line numbers (D-A9).
- Per-cell typing per the contract. `rate_per_unit`, if present, is an optional decimal string. `polygon_end_date`, if present, is a strict `YYYY-MM-DD` date; `state` and `district`, if present, are plain text.
- **No cross-module referential validation** (D-A1). No capacity field, no currency field.

**CSV parser** (`services/product/ratecard/parse-csv.ts`) — the one file importing the pinned parser (exact version, coercion **off**). Every cell a string; an empty cell stays `""` (never `0`); leading-zero keys survive; dates stay `YYYY-MM-DD` strings. Buffered/synchronous at this volume; the file itself is never stored (filename + checksum only). Line numbering: header is line 1, first data row is line 2, honoured end to end.

---

## 7. Services, actions, UI, seed, permission

- **Services/actions:** `upload-version`, `activate-version`, `rollback-version`, `diff-versions`; repository `db/repositories/ratecard.ts` (flat path); one audit event per upload/activate/rollback in the same transaction. No row-level update/delete is exported — **upload is the only write path.**
- **UI `/products/rate-card`:** version list (status badge, snapshot date, row count), paged/filterable row preview, diff view, upload/activate/rollback dialogs (first `<input type=file>` in the app; uncontrolled, `FormData`, never in form state). Uncached (`force-dynamic`). Read UI ships before write UI. No status banner — the table is stood up on the assumption it will be consumed (rating, a following sprint).
- **Phase 1 seed** (`db/seeds/demo/…` and the tracked-card config): seed **one** `card_name` and its initial `RATECARD_RAN_USAGE_LKP` dataset, created **through the real upload + activate path** (so the guards are exercised and the audit trail is real). Small, human-readable — not 5,400 rows. This is the "1 customer lookup table" of Phase 1; the config tracks **only** it. **DELIVERED pm67** — `db/seeds/demo/product-demo.ts` seeds `RAN_USAGE` as one `ACTIVE` + one `SUPERSEDED` version (one key removed between them) via pm61/pm63's services on `db:seed-demo`; the actor stamping `uploaded_by`/`activated_by` is a get-or-created `Demo — Rate Card Operator` (the plan v2:269 open item, resolved).
- **Permission (OR3):** a new `ratecard` permission (READ/EDIT), recommended over reusing `products`. READ reaches the read surface; EDIT reaches upload/activate/rollback. No DELETE level.

---

## 8. Invariants

- **RV1** — At most one `ACTIVE` version per `card_name` (partial unique index).
- **RV2** — Within a version, `(mno_public_key, commercial_unit_public_key, polygon_id)` is unique (D-A9).
- **RV3** — A version's rows are immutable once `ACTIVE`, and are exactly the rows of its uploaded file (rows stored = `row_count`).

---

## 9. Delivery units

Delivery is broken into units **pm57** (schema) and **pm58–pm68** (upload contract, parser, repository, upload service, diff, activate, rollback, page + read UI, write UI, Phase 1 seed, ship gate). Per-unit detail lives in `context/product-management/specs/pmXX-*.md` and in `pm00-build-plan.md`.

---

## 10. Open items

**None blocking the table stand-up.**

- **OR3 — Permission.** New `ratecard` permission vs reuse `products`. *Recommendation: new `ratecard`.*
- **OR4 — File format / parser (resolved 2026-09-27; G-RC4 closed).** CSV; pinned `csv-parse` at exact **7.0.3** (the `csv-parse/sync` API), coercion **off** (`cast: false`, set explicitly). Imported in exactly one file — `services/product/ratecard/parse-csv.ts` (pm59).
- **OR7′ — Column set (confirmed).** Ten columns (§6). `Polygon ID` maps to `polygon_id`; `SITE` is not a column; there is no snapshot-date column (D-A8). Dates (`Polygon Start Date`, `Polygon End Date`) are strict `YYYY-MM-DD`.
- **OR-RET — Retention / purge policy (deferred to a later plan).** Over the long run `RATECARD_RAN_USAGE_LKP` accumulates one ~5,500-row slice per version. This is **not** a stand-up blocker: the hot path stays version-scoped by the leading `ratecard_version_id` index, so per-lookup cost does not grow with total rows. A retention/purge policy for superseded versions — and, only if it is ever needed, a partition-by-month trigger for cheap `DROP PARTITION` retention — is **to be captured and delivered in a later plan**, not here.

---

## 11. Sequencing

Single phase. No cross-module dependency, no Part 4 window.

```
  0041 migration (2 tables)
        │
        ├─ CSV parser ── validation ── repository
        │        │            │            │
        │        └────────────┴────────────┘
        │                     │
        │              upload · diff · activate · rollback
        │                     │
        │              read UI ── write UI (+ bodySizeLimit)
        │                     │
        └───────────► Phase 1 seed (one card, one dataset, via the real path)
                              │
                        ship gate
```

**Definition of done:** `RATECARD_RAN_USAGE_LKP` and its version/config tracker exist from an empty database; Revenue Operations can upload, review, activate and roll back versions of the one seeded card through the UI; each version holds exactly its uploaded rows — and no code in this delivery reads, resolves, prices, or bills from the table; the rating consumer is a following-sprint deliverable.

---

## GSTACK REVIEW REPORT

**/plan-eng-review** — 2026-09-27. Scope: this plan (v2) + all `context/product-management` docs + the Part 5 specs (pm57, pm57a, pm58–pm68). Verified against the live codebase on `dev1` (`cb32aa6`). Outside voice: Claude subagent (codex CLI unavailable in this environment).

| Review | Runs | Status | Findings |
|--------|------|--------|----------|
| Eng Review (PLAN) | 1 | ISSUES RESOLVED | 8 decided + 4 folded corrections; 0 critical gaps remaining (2 closed) |

**Architecture:** sound and unusually well-reasoned (DB-enforced partial unique indexes, TOCTOU lock-read-on-`tx` with 4× concurrency loops, validate-before-transaction, 1,000-row batching for the bind-param cap, honest D9 grant hand-off). The risks are deployment-mechanism and doc-drift, not design. **Performance:** no issues — query budgeting is a model; no-cache is the correct call. **Tests:** near-complete on planned paths.

Decisions taken (all approved via AskUserQuestion):
- **1A** — the pm57a in-place `0041` rewrite becomes a **verified gate (G-RC6)**: confirm no persistent/shared DB applied the original `0041` before rewriting, recorded like G-C. (Original `0041` is committed at the v1 shape.)
- **2A** — keep the as-of-index **drop**; record in the Part 5 hand-off that the consumer inherits an index-on-populated-table migration.
- **3A** — annotate pm60/pm65/pm57a/pm68 so **C1/C5/C6/C9 read as verify-only** (context docs are already at target state).
- **4B** — add a **redirect banner** to `prodmgmt-progress-tracker.md`'s pm57 section (still describes the reversed v1 unit); note the pm57 integration suite is superseded by pm57a's re-baseline.
- **5B** — rely on pm61's sequential second-upload test for the concurrent-upload race. Caveat: confirm the upload service actually catches `23505` on the DRAFT index and maps it to `{ok:false}`.
- **6A** — add a **minimal DRAFT recovery path** (a new upload replaces the open draft: delete-then-insert rows in one tx, reuse `RATECARD_VERSION_UPLOADED`, no new audit type, no DELETE permission). Reopens/​supersedes C2 — record in pm00.
- **7A** — **keep full Phase-1 scope** (lifecycle is the product for RevOps; per-version immutability makes a future key change a new-version migration, not a live-row rewrite). Record D-A9/D-A10 as planner calls with a reopening trigger.
- **8A** — correct pm57a's rewrite mechanism: **regenerate `0041`'s `_journal.json` hash + snapshot** to match the rewritten SQL (not "unchanged"); add a hash-matches-SQL verification step to the 1A gate.

Folded corrections (clear, no decision needed):
- pm57a D5 / pm00 gate table: **G-RC3 blocks pm61, not pm65** — the write actions call `requirePermission('ratecard','EDIT')` and won't compile without the `rbac.ts` member.
- pm61: state `version_num = max+1` is read on `tx` inside the transaction.
- pm67: name which `core.appuser` stamps `uploaded_by`/`activated_by` in the seed.
- Note the `REJECTED`-as-reserved tradeoff (kept; documented as dead-until-async-ingest).

**VERDICT:** ENG CLEARED (plan-stage) — architecture and tests pass. The 8 decisions and 4 corrections above were **applied to the specs/context docs on 2026-09-27** (T1–T10): the new-migration-safety gate is recorded as **G-RC6** (G-RC5 was already taken by the withdrawn `rp.py` gate), and D-A11 (replace-open-DRAFT) is threaded through the plan, pm57a, pm60, pm61, pm66, pm68 and pm00. No CEO or design review required (backend + one internal RevOps surface; docs already carry the UI spec).

NO UNRESOLVED DECISIONS
