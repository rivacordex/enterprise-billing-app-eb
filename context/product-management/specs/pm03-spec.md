# PM03 — Repositories + `services/product`

- **Unit:** 3 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm02 (data layer: migration `0006_product`, `validation/product/` schemas, `types/product.ts` unions, `TOREMOVE-Template-*` seeds) verified and merged. pm03 must not start before that (pm02 §3.9).
- **Authorizing sections:** overview *Features — Catalog listing / Offering detail / Prices panel (effectivity display)* and *Success Criteria*; `prodmgmt-architecture.md` §2 (`services/product/**`, `db/**` product scope), §3 (Storage Model — derived `end_date_time`), Module Inv. #1, #3, #6, #7, #11; `prodmgmt-code-standards.md` §1.1–§1.5, §2.5–§2.7, §6.3, §6.9, §7 (file tree), §9.2/§9.4; platform `architecture.md` §2 (boundary rule), §3 (SYSTEM_CONFIG), Inv. #9; general `code-standards.md` §2 (typed service results, explicit return types), §6.13 (pure functions), §7.5–§7.6.
- **Codebase state assumed at start (re-verify before implementing):** pm01 + pm02 merged — `app/(app)/` exists; `db/schema/product.ts` has the 3 tables/sequences/enum; `validation/product/` has the 3 schemas; `types/product.ts` has the domain unions; migrations `0000`–`0006` applied (this unit adds `0008`); seeds provide 2 offerings / 3 specs / 6 prices incl. the **future-dated 2027 recurring successor** (fixed UTC datetimes — the derived-effectivity fixture). Established patterns this unit follows: object-literal repositories whose methods take `db: Database` first (`db/repositories/roles.repository.ts`); services import the `db` singleton and expose named use-case functions with a module-level `PAGE_SIZE`-style constant (`services/audit-log/audit-log-read.service.ts`); `systemConfigRepository.findActiveValue(db, group, key)` for config reads; ilike-escape `name.replace(/[%_\\]/g, "\\$&")` (`rolesRepository.findRoleByName`); integration tests via `describe.skipIf(!databaseUrl)` (`tests/db/*.integration.test.ts`).

---

## 1. Goal

Deliver the module's entire backend read path: three product repositories (the price repository exporting **no** `update*`/`delete*`, Inv. #1) and framework-agnostic `services/product` with `listOfferings` (search / `lifecycle_status` filter / sort / pagination, RETIRED hidden by default, page size runtime-configurable via `core.SYSTEM_CONFIG`) and `getOfferingDetail` (offering + specs + prices, `endDateTime` derived from the successor's `start_date_time`, open-ended → `null`, plus a computed per-price effectivity status). Services return read models — never raw Drizzle rows. Visible result: unit + integration tests pass against seeded data, demonstrating list filtering/pagination and detail assembly with derived effectivity (incl. future-dated), and a structural test proves no mutation exports.

## 2. Design

No UI — boundary is `services/product/**`, `db/repositories/product-*`, read-model additions to `types/product.ts`, one data-only migration, tests. **No `next/*` (or `react`) imports anywhere in this unit** — `services/product` stays fully framework-agnostic (general §3.14); unlike `app-config-read.service.ts` there is no `React.cache` wrapper, because each page render calls each use case exactly once.

**Pre-made decisions (cited):**

1. **Repository shape** follows the established pattern: exported object literal (`productOfferingRepository`, `productSpecificationRepository`, `productOfferingPriceRepository`), every method taking `db: Database` as first argument, file names per the module tree (§7): `db/repositories/product-offering.ts`, `product-specification.ts`, `product-offering-price.ts`.
2. **v1 repositories export finders only** (Inv. #11 — no production write path). Additionally and permanently, the price repository never gains `update*`/`delete*` (Inv. #1); the future `insertPrice` arrives with the CRUD fast-follow. Asserted structurally (§3.8).
3. **Derived end is a window function in the repository query** (code-standards §6.3): `LEAD(start_date_time) OVER (PARTITION BY product_offering_id, price_type ORDER BY start_date_time)` — never stored, never computed in the UI (Inv. #3).
4. **Read models live in `types/product.ts`** (code-standards §2.7), composed shapes the page consumes without re-joining: `OfferingListRow`, `OfferingListPage`, `OfferingDetail` (embeds `specifications` + `prices` and `lastEditedByName`), `SpecificationCard`, `PriceCard` (all price-row fields + computed `endDateTime` + `effectivityStatus`).
5. **RETIRED-hiding is service behavior** (pm02 §3.6): `status: null` ⇒ repository filter `lifecycle_status <> 'RETIRED'`; an explicit `status` (incl. `RETIRED`) filters to exactly that status.
6. **`lastEditedByName` resolves in the repository** via LEFT JOIN to `core.appuser` (`display_name`); `last_edited_by IS NULL` (seeded rows) ⇒ `lastEditedByName: null` — rendering "—" is pm06's concern.
7. **Typed results, no throw for expected control flow** (general §2.9): unknown offering ID ⇒ `getOfferingDetail` returns `null` (pm05's empty-detail state). ID-format validation is the caller's job (`?offering=` parsed against the pm02 schema, code-standards §2.6); the service treats any non-matching string as not-found.

**Decisions resolved 2026-07-04 (user):**

8. **Page size = 5, runtime-configurable** (revised from 10, user decision closing this spec — smaller pages keep integration fixtures minimal). New `core.SYSTEM_CONFIG` row `('products', 1, 'offering_list_page_size', '5')`, seeded by data-only migration `0008_product_config` (INSERT-in-migration precedent: `0004`/`0005`). `listOfferings` reads it per call via `systemConfigRepository.findActiveValue(db, "products", "offering_list_page_size")`; the value must match `/^\d+$/` and fall in **1–100**, else silently fall back to `DEFAULT_OFFERING_LIST_PAGE_SIZE = 5` (exported constant). No caching (config change takes effect next request); no per-request warn logging (log-spam). Admins can later tune it from the System Configuration page with no deploy.
9. **`getOfferingDetail` returns ALL price rows** of the selected offering — superseded, current, and future-dated — each with `startDateTime` + derived `endDateTime`. History stays visible (overview: "cards per `product_offering_price` row"); nothing is re-shaped at CRUD time.
10. **`PriceCard.effectivityStatus: 'current' | 'future' | 'superseded'`**, computed in the service from an **injectable clock**: `getOfferingDetail(offeringId, now: Date = new Date())`. Rules: `startDateTime > now` ⇒ `future`; `endDateTime !== null && endDateTime <= now` ⇒ `superseded`; else `current`. Window boundaries are `[start, successorStart)` — a price is `current` at its exact start instant and `superseded` at its successor's start instant. Union lives in `types/product.ts` (`EFFECTIVITY_STATUSES` as const, code-standards §2.1 pattern).
11. **Deterministic ordering.** List sort maps `OFFERING_SORT_VALUES` (pm02 §3.6, `-` prefix = desc) to columns with tie-breaker `product_offering_id ASC` so pagination is stable. Specs order: `name ASC, product_spec_id ASC`. Prices order: `price_type ASC, start_date_time ASC, product_offering_price_id ASC`.

## 3. Implementation

### 3.1 Read models — `types/product.ts` (extend, pm02 file)

Append (unions + row re-exports from pm02 stay untouched):

```ts
export const EFFECTIVITY_STATUSES = ["current", "future", "superseded"] as const;
export type EffectivityStatus = (typeof EFFECTIVITY_STATUSES)[number];

export type OfferingListRow = {
  productOfferingId: string;
  name: string;
  lifecycleStatus: LifecycleStatus;
  version: number;
  isSellable: boolean;
  lastModified: Date;
};

export type OfferingListPage = {
  rows: OfferingListRow[];
  total: number;      // matching rows across all pages (for "Page X of Y")
  page: number;
  pageSize: number;   // the resolved (configurable) size
};

export type SpecificationCard = {
  productSpecId: string;
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: ProductSpecCharacteristics; // flat string record (pm02 §3.6)
};

export type PriceCard = {
  productOfferingPriceId: string;
  name: string;
  priceType: PriceType;
  pricingModel: PricingModel;
  amount: string | null;                        // numeric → string (general §2.15)
  currency: string;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  glCode: string | null;
  policy: string | null;                        // carried, semantics deferred (workflow §5.1)
  pricingCharacteristics: TieredPricingCharacteristics | null;
  startDateTime: Date;
  createdAt: Date;
  endDateTime: Date | null;                     // derived; null = open-ended (Inv. #3)
  effectivityStatus: EffectivityStatus;         // Design #10
};

export type OfferingDetail = {
  productOfferingId: string;
  name: string;
  isBundle: boolean;
  isSellable: boolean;
  billingOnly: boolean;
  lifecycleStatus: LifecycleStatus;
  version: number;
  lastModified: Date;
  lastEditedByName: string | null;              // resolved from core.APPUSER (Design #6)
  specifications: SpecificationCard[];
  prices: PriceCard[];
};
```

### 3.2 Repository — `db/repositories/product-offering.ts` (new)

`productOfferingRepository` exporting exactly two finders (explicit return types, general §2.4):

- **`findList(db, filters): Promise<{ rows: OfferingListRow[]; total: number }>`** with `filters: { q: string; status: LifecycleStatus | null; sort: OfferingSort; page: number; pageSize: number }` (`OfferingSort` = pm02's `OFFERING_SORT_VALUES` union, imported from `validation/product/offering-list.schema`).
  - WHERE: `q` non-empty ⇒ `ilike(name, '%' + escaped + '%')` with `[%_\\]` escaping (pattern: `findRoleByName`); `status === null` ⇒ `ne(lifecycleStatus, 'RETIRED')` (Design #5) else `eq(lifecycleStatus, status)`.
  - ORDER BY: lookup table `sort key → column`, `-` prefix ⇒ `desc()`; always append `asc(productOfferingId)` tie-breaker (Design #11).
  - Pagination: `limit(pageSize).offset((page - 1) * pageSize)`. A page past the end returns `rows: []` with the true `total` — no clamping (audit-log precedent).
  - `total`: second query, same WHERE, Drizzle `count()`.
  - Projection: exactly the `OfferingListRow` fields — never `select()` whole rows.
- **`findDetailById(db, productOfferingId): Promise<(offering fields + lastEditedByName) | null>`** — one row, LEFT JOIN `core.appuser` on `last_edited_by` projecting `appuser.display_name` as `lastEditedByName` (verify the actual display-name column in `db/schema/identity.ts` at implementation time and use it verbatim). Returns `null` when no row matches.

No insert/update/delete exports (Design #2).

### 3.3 Repository — `db/repositories/product-specification.ts` (new)

`productSpecificationRepository` with one finder:

- **`findByOfferingId(db, productOfferingId): Promise<SpecificationCard[]>`** — WHERE `ref_product_offering_id = $1` (uses pm02's `product_specifications_offering_idx`), ORDER BY `name ASC, product_spec_id ASC`, projected straight to `SpecificationCard` (`product_spec_characteristics` is already `.$type<ProductSpecCharacteristics>()` from pm02 — no cast, no re-parse on read).

### 3.4 Repository — `db/repositories/product-offering-price.ts` (new)

`productOfferingPriceRepository` with one finder:

- **`findByOfferingIdWithDerivedEnd(db, productOfferingId): Promise<Array<PriceCard minus effectivityStatus>>`** — all price columns plus the derived end (Design #3):

  ```ts
  endDateTime: sql<Date | null>`lead(${p.startDateTime}) over (
    partition by ${p.productOfferingId}, ${p.priceType}
    order by ${p.startDateTime}
  )`.as("end_date_time"),
  ```

  (Confirm at implementation time that the driver maps the window-function column to `Date`; if it round-trips as `string`, normalize with `new Date(...)` in the repository so the read model's `Date | null` holds — the type must not leak a string.)
  WHERE `product_offering_id = $1` (uses `product_offering_price_offering_idx`), ORDER BY `price_type ASC, start_date_time ASC, product_offering_price_id ASC` (Design #11). `pricing_characteristics` comes typed from pm02's `.$type<>()`.
- **Exports no `update*`, `delete*`, or (in v1) `insert*` function** — Inv. #1 / Inv. #11, structurally asserted in §3.8. A comment on the module notes that `insertPrice` (INSERT successor + bump offering `version` in one transaction) is the only write the CRUD fast-follow may add.

### 3.5 Service — `services/product/list-offerings.ts` (new)

```ts
export const DEFAULT_OFFERING_LIST_PAGE_SIZE = 5;

export async function listOfferings(
  params: OfferingListSearchParams,
): Promise<OfferingListPage> { … }
```

Steps: (1) resolve page size — `systemConfigRepository.findActiveValue(db, "products", "offering_list_page_size")`, accept only `/^\d+$/` and 1–100, else `DEFAULT_OFFERING_LIST_PAGE_SIZE` (Design #8; internal un-exported helper); (2) `productOfferingRepository.findList(db, { q: params.q, status: params.status, sort: params.sort, page: params.page, pageSize })`; (3) return `{ rows, total, page: params.page, pageSize }`. `params.offering` is selection state, irrelevant to the list — ignored here. `params` is the **already-parsed** pm02 schema output; the service never touches raw searchParams (general §1.5).

### 3.6 Service — `services/product/get-offering-detail.ts` (new)

```ts
export async function getOfferingDetail(
  productOfferingId: string,
  now: Date = new Date(),
): Promise<OfferingDetail | null> { … }
```

Steps: (1) `productOfferingRepository.findDetailById` — `null` ⇒ return `null` (no further queries); (2) `Promise.all` of `productSpecificationRepository.findByOfferingId` and `productOfferingPriceRepository.findByOfferingIdWithDerivedEnd`; (3) map each price row to a `PriceCard` by attaching `effectivityStatus` from the Design #10 rules (pure un-exported helper `resolveEffectivityStatus(startDateTime, endDateTime, now)` — boundary semantics `[start, successorStart)`); (4) assemble `OfferingDetail`. No filtering — all price rows returned (Design #9). Nothing here reads `AUDIT_LOG` (Inv. #7) or filters by ACTIVE — v1 is a viewer; ACTIVE-only selection is a *later-module* billing rule (Inv. #6) that these repositories make trivial by exposing `lifecycleStatus`.

### 3.7 Migration — `db/migrations/0008_product_config.sql` (new, data-only)

Generate an empty custom migration (`npx drizzle-kit generate --custom --name=product_config`) so the meta journal stays consistent, then add:

```sql
INSERT INTO "core"."system_config" ("config_group", "config_version", "config_key", "config_value", "description", "is_secret", "status", "modified_by") VALUES ('products', 1, 'offering_list_page_size', '5', 'Rows per page for the Product Offering catalog table (1-100).', false, 'ACTIVE', NULL);
```

New `config_group` `'products'` (platform §3: SYSTEM_CONFIG partitioned by `config_group`). No DDL, no schema change, no `drizzle.config.ts` change. The row appears automatically on the System Configuration admin page — verify no pre-existing test asserts config-row counts (none known as of pm02; if one exists, that count update is conscious and called out in the PR).

### 3.8 Guardrail tests owned by this unit

**Unit suite (`vitest.config.ts`, no DB — repositories mocked via `vi.mock`, pattern: existing `tests/services/*.service.test.ts`):**

- `tests/services/list-offerings.service.test.ts` —
  - `status: null` passes through as `null` (repository owns the RETIRED exclusion) and an explicit `status` passes verbatim; `q`/`sort`/`page` forwarded untouched.
  - Page-size resolution: config `'5'` ⇒ 5; config `'25'` ⇒ 25; missing / `''` / `'abc'` / `'0'` / `'101'` / `'-5'` / `'10.5'` ⇒ `DEFAULT_OFFERING_LIST_PAGE_SIZE`.
  - Returned `OfferingListPage` echoes `page` and resolved `pageSize`, and carries the repository's `rows`/`total` unmodified.
- `tests/services/get-offering-detail.service.test.ts` — with a **fixed injected `now`** (e.g. `2026-07-04T00:00:00Z`):
  - Unknown ID ⇒ `null`, and spec/price finders are **not called**.
  - Effectivity statuses: start `2026-01-01`, end `2027-01-01` ⇒ `current`; start `2027-01-01`, end `null` ⇒ `future` (future-dated successor does **not** displace the current price — guardrail §9.4); start `2025-01-01`, end `2026-01-01` ⇒ `superseded`.
  - Boundary instants: `now === start` ⇒ `current`; `now === endDateTime` ⇒ `superseded` (window `[start, successorStart)`).
  - Open-ended price ⇒ `endDateTime: null`, `current` when started.
  - Assembly: `specifications` and `prices` arrive from the mocked finders in order; `lastEditedByName: null` passes through.
- `tests/db/product-repository-exports.test.ts` — **structural no-mutation assert** (pm00): import all three repository objects; `Object.keys()` of each contains no name matching `/^(insert|create|update|delete|remove|set)/` (v1, Inv. #11); test comment marks the price-repository `update*`/`delete*` prohibition as **permanent** (Inv. #1) — at CRUD time the pattern is relaxed for `insert*` only, never for the price repo's `update*`/`delete*`.

**Integration suite (`vitest.integration.config.ts`, `describe.skipIf(!databaseUrl)` — pattern: `product-schema.integration.test.ts`):**

- `tests/db/product-repositories.integration.test.ts` — fresh-migrate (incl. `0008`), then insert **self-contained fixtures** directly with the Drizzle client (test code, not a production write path — Inv. #11 untouched; payloads still `.parse()`d through the pm02 Zod schemas, code-standards §1.7). Fixtures mirror the pm02 template shape: ≥ 7 offerings for pagination (page size 5 ⇒ a genuine second page; mixed DRAFT/ACTIVE/RETIRED, distinct names incl. a searchable substring), one offering carrying the three-price recurring chain (past `2025-01-01` → current `2026-01-01` → future `2027-01-01`) plus a tiered usage price. Assert:
  - `findList` default (`status: null`) excludes RETIRED rows; `status: 'RETIRED'` returns only them.
  - Search: case-insensitive substring match; `%`/`_` in `q` are treated literally (escaping works); no-match ⇒ `rows: [], total: 0`.
  - Sort: `name` vs `-name` reverse each other; ties break by `product_offering_id ASC`; `-last_modified` orders correctly.
  - Pagination: `pageSize` slices; page 2 continues where page 1 ended with no overlap/gap; `total` counts all matches; past-the-end page ⇒ empty rows, true `total`.
  - **Derived effectivity from real SQL** (guardrail §9.4): the recurring chain yields ends `2026-01-01` / `2027-01-01` / `null`; partition correctness — a same-offering price of a *different* `price_type` does not truncate the chain; `getOfferingDetail` with injected `now = 2026-07-04` marks the chain `superseded`/`current`/`future` and never filters rows (all superseded + future rows present, Design #9).
  - `findDetailById`: `lastEditedByName` resolves via the APPUSER join (fixture with a real user FK) and is `null` for a NULL `last_edited_by`; unknown ID ⇒ `null`.
  - `0008` seeded row: `findActiveValue(db, 'products', 'offering_list_page_size')` returns `'5'`.
  - Cleanup mirrors the pm02 harness (`DROP SCHEMA "product" CASCADE` before `core`).

### 3.9 Commit

One commit, e.g. `product repositories + services/product: list, detail, derived effectivity (pm03)`. Contents: exactly §3.1–§3.8. Explicitly **not** in this commit: any `app/**`, `components/**`, or nav file (pm04/pm05); `actions/product/` or `app/api/product*` (forbidden in v1); any mutation export in the three repositories; edits to migrations `0000`–`0006` or to pm02's seed/validation/schema files; any `AUDIT_LOG` write; any npm dependency or lockfile change. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 3 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages** (pm00: Drizzle, Zod, vitest already installed; the window function is raw SQL through Drizzle's `sql` tag). **No DB extensions.** Config deltas: none to `drizzle.config.ts` or `package.json` — migration `0008` rides the existing `db:migrate`. Requires pm02's migration `0006`, seeds, `validation/product/` schemas, and `types/product.ts` unions in place.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only: `types/product.ts` (extended), `db/repositories/product-offering.ts` + `product-specification.ts` + `product-offering-price.ts` (new), `services/product/list-offerings.ts` + `get-offering-detail.ts` (new), `db/migrations/0008_product_config.sql` + meta journal (new), and the new test files. Nothing else.
- [ ] No `actions/product/`, `app/api/product*`, `app/**`, or `components/**` change; no edit to migrations `0000`–`0006` or pm02 files.
- [ ] `services/product/**` imports no `next/*` and no `react` (framework-agnostic — pm00 boundary).
- [ ] `grep -rn "update\|delete" db/repositories/product-*` shows no mutation function; no `AUDIT_LOG` reference anywhere in the diff (reads not audited; audit never a pricing source, Inv. #7).
- [ ] No `TODO`, commented-out code, or `console.*` introduced.

**Build gates**
- [ ] `npm run typecheck` green — read models are the declared return types; `endDateTime` is `Date | null` end-to-end (no string leak from the window column).
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — both vitest configs; **zero pre-existing test assertions change** (page size arrived via config row, not code constants; if a config-row count assertion exists, §3.7's conscious update is the sole exception, called out in the PR).

**Backend guardrails (the point of the unit)**
- [ ] Structural test proves the three product repositories export no mutation functions (Inv. #1/#11).
- [ ] Derived-effectivity tests pass at unit level (injected `now`, boundary instants) **and** against real SQL (LEAD window, partition per `price_type`) — incl. the future-dated successor not displacing the current price and open-ended ⇒ `endDateTime: null` (guardrail §9.4, Inv. #3).
- [ ] `getOfferingDetail` returns **all** price rows with statuses `superseded`/`current`/`future` (Design #9/#10); unknown ID ⇒ `null` without spec/price queries.
- [ ] List behavior proven against seeded-style fixtures: RETIRED hidden by default, explicit RETIRED filter works, case-insensitive search with literal `%`/`_`, stable sort + tie-breaker, pagination slices with true `total`.
- [ ] Fresh DB: `npm run db:setup` applies `0008`; psql `SELECT config_value FROM core.system_config WHERE config_group='products' AND config_key='offering_list_page_size'` → `'5'`; changing the row to `'25'` changes `listOfferings` page size on the next call with no deploy; junk values fall back to 5.
- [ ] With the pm02 seed data and today's clock: offering 1's 2026 recurring price is `current` (end `2027-01-01`), the 2027 successor is `future` (end `null`) — spot-checked via a scratch invocation or the integration suite.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` marks Unit 3 complete with the commit reference.
- [ ] This spec records the three 2026-07-04 user decisions (page size 5 + SYSTEM_CONFIG-configurable — revised from 10 at spec close; all price rows returned; effectivity status with injectable `now`) — done with this file.

**Pipeline**
- [ ] CI green end-to-end including SAST + ZAP DAST baseline (no new routes; runtime behavior unchanged until pm05 consumes these services).

Any failing item means the unit is not done (workflow §8). pm05 (page) must not consume these services until this commit is verified and merged; pm04 (nav) is independent and may proceed in parallel.
