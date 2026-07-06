# PM02 — Product Data Layer: Migration + Validation Schemas + Seeds

- **Unit:** 2 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm01 (route-group rename) verified and merged. No product code exists before this unit.
- **Authorizing sections:** overview *Goals #2, #3, #5* / *In Scope* / *Data integrity*; `_newmodule-product-module-plan.md` *Data model (v1 tables)*, Decisions #3–#7; `prodmgmt-architecture.md` §1 (Database delta), §3 (Storage Model), §4 (permission matrix), Module Inv. #1–#5, #9; `prodmgmt-code-standards.md` §1.7–§1.8, §2, §6, §7 (file tree), §8; `prodmgmt-ai-workflow-rules.md` §2.2–§2.4, §6.3–§6.4; platform `architecture.md` §3 (IDs, JSONB), §4, Inv. #6, #18; general `code-standards.md` §2.15, §6.16–§6.18, §8.
- **Codebase state verified 2026-07-04:** migrations `0000_core` … `0005_admin_chrome_config` applied (journal idx 0–5 → this unit generates `0006`); `drizzle.config.ts` has `schemaFilter: ["core"]`; `types/rbac.ts` `PERMISSION_NAMES` has 4 entries; `auth/permission-constants.ts` `PERMISSIONS` has 4 entries; `types/roles.ts` `PERMISSION_DISPLAY_NAMES` is `Record<PermissionName, string>` (adding a name without a display entry is a compile error); `tests/components/permission-matrix-editor.test.tsx:60` and `tests/components/role-detail.test.tsx` assert **4** permission rows; no `db/schema/product.ts`, `validation/product/`, or product seed exists; migrations `0004`/`0005` establish the seed-row-inside-migration precedent (`INSERT` statements appended after DDL with `--> statement-breakpoint`); `db/seeds/seed-rbac.ts` establishes the standalone idempotent seed-script pattern; `tests/db/migration.integration.test.ts` drops only `core` + `drizzle` schemas (must learn about `product`, §3.8); system default currency is `MYR`, locale `en-MY` (`core.SYSTEM_CONFIG`).

---

## 1. Goal

Create the module's entire data layer in one unit: the `product` schema with its three tables (`product_offering`, `product_specifications`, `product_offering_price`), sequences, enum, and constraints via Drizzle migration `0006_product` (which also inserts the `products` PERMISSIONS row); the `validation/product/` Zod schemas (offering-list searchParams, per-`pricing_model` price characteristics, spec characteristics); the `TOREMOVE-Template-*` seeds passed through those schemas; and the guardrail tests proving that a duplicate same-type `start_date_time` fails at the DB and that Zod rejects tier gaps/overlaps and `amount` XOR violations. Visible result: a seeded catalog queryable in psql, and deliberately bad data provably failing.

## 2. Design

No UI in this unit — "design" here is structural. Boundary: `db/**`, `validation/product/**`, plus the permission-registry wiring (`types/rbac.ts`, `auth/permission-constants.ts`, `types/roles.ts`, `types/product.ts`) that pm00 assigns to this unit.

**Pre-made decisions (cited):**

1. **Tables, columns, and ID prefixes** come verbatim from `_newmodule-product-module-plan.md` *Data model*: `PRDOFR`/`PRDSMD`/`PRDOFP` + zero-padded 6-digit per-table sequence, assembled in the DB layer as a column default (general §6.18). The module keeps the plan-doc column names `start_date_time`, `created_at`, `last_modified` verbatim even though core uses `*_datetime` — the module data model is canonical for module tables.
2. **`lifecycle_status` is a Postgres enum** in the `product` schema (`DRAFT`/`ACTIVE`/`RETIRED`, pm00). `price_type` and `pricing_model` are `text` + CHECK constraints, matching the core pattern (`role_permission_assign_type_check`, `appuser_status_check`).
3. **No stored `end_date_time`, no `last_update`** on prices (Inv. #3) — asserted structurally by a test (§3.8).
4. **JSONB is typed from Zod** (general §6.17): Drizzle `.$type<T>()` where `T` is `z.infer` of the owning `validation/product/` schema, imported **type-only** into `db/schema/product.ts` — never a hand-written duplicate (code-standards §2.2).
5. **Money:** `amount` and tier `rate` are `numeric` → `string` (general §2.15/§6.16); `currency` is its own ISO-4217 column, NOT NULL (tiered prices still bill in a currency).

**Decisions resolved 2026-07-04 (recorded here; design docs already updated where noted):**

6. **Overlap constraint (design revision, docs updated).** The btree_gist exclusion constraint was removed from pm00, `prodmgmt-architecture.md` Inv. #2/§3, `prodmgmt-code-standards.md` §6.4/§9.3, the overview, and `prodmgmt-ai-workflow-rules.md`: with no stored end, a range-exclusion constraint cannot reference the successor row. The DB rule is **UNIQUE (`product_offering_id`, `price_type`, `start_date_time`)**. Precisely: derived windows `[start, successor start)` never overlap **by construction** — a new price supersedes (truncates) its predecessor from its start instant, so a start inside an existing window is legitimate; the constraint's job is keeping the derivation well-defined (no two same-type prices tied at one instant). **Highlighted caveat (accepted 2026-07-04, not a v1 concern):** a *backdated* start rewrites derived history and could make a re-derived bill basis differ from what was originally computed; the DB cannot prevent this, so the CRUD fast-follow must restrict backdated `start_date_time` as a service rule. v1 has no write paths and the seeds use fixed, distinct starts. No DB extension is needed.
7. **ADMIN grant (user decision).** Besides the `products` PERMISSIONS row (migration), the product seed script grants **ADMIN → `products` : DELETE** via `role_permission_assign`, mirroring the UM bootstrap. The grant lives in the seed script, not the migration, because role rows are created by `seed-rbac`, not migrations; the migration owns only the registry row (platform Inv. #6).
8. **Seed volume (user decision).** Exactly the **2 detailed template offerings** — no filler rows. The overview's "catalog of 100+ rows" success criterion is satisfied at pm05 time or by go-live data, not by this unit's seeds.
9. **`product_spec_characteristics` shape (user decision).** Flat string record: `z.record(z.string().min(1), z.string())` — exactly what the chips render; numbers stored as strings (e.g. `{"SST_ID": "01"}`).
10. **Sort param encoding (this spec).** One `sort` searchParam per code-standards §3.2's param list (`q`/`status`/`sort`/`page`/`offering`): value is a sort key with optional `-` prefix for descending (e.g. `-last_modified`); default `name` (ascending). No separate `dir` param.

## 3. Implementation

### 3.1 Drizzle scope — `drizzle.config.ts`

Change `schemaFilter: ["core"]` → `schemaFilter: ["core", "product"]` so drizzle-kit manages the new schema. One-line change; nothing else in this file.

### 3.2 Drizzle schema — `db/schema/product.ts` (new)

One file (code-standards §7 tree), exporting:

```ts
export const product = pgSchema("product");
export const lifecycleStatus = product.enum("lifecycle_status", ["DRAFT", "ACTIVE", "RETIRED"]);
export const productOfferingSeq = product.sequence("product_offering_seq", { startWith: 1 });
export const productSpecificationsSeq = product.sequence("product_specifications_seq", { startWith: 1 });
export const productOfferingPriceSeq = product.sequence("product_offering_price_seq", { startWith: 1 });
```

ID columns use a SQL default assembling prefix + zero-padded sequence (general §6.18), e.g.:

```ts
productOfferingId: text("product_offering_id")
  .primaryKey()
  .default(sql`'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 6, '0')`),
```

**`product.product_offering`**

| Column | Type / constraint |
|---|---|
| `product_offering_id` | text PK, default `'PRDOFR' + lpad(seq, 6)` |
| `name` | text NOT NULL |
| `is_bundle` | boolean NOT NULL (display-only in v1, Decision #8) |
| `is_sellable` | boolean NOT NULL |
| `billing_only` | boolean NOT NULL |
| `lifecycle_status` | `product.lifecycle_status` NOT NULL DEFAULT `'DRAFT'` |
| `version` | integer NOT NULL DEFAULT 1 (in-place metadata counter, Inv. #8) |
| `last_modified` | timestamptz NOT NULL DEFAULT `now()` |
| `last_edited_by` | text NULL, FK → `core.appuser(user_id)` ON DELETE restrict (appuser is tombstoned, never hard-deleted, so restrict is safe; NULL = seeded/infrastructure write, mirroring `role_assign.assigned_by`) |

**`product.product_specifications`**

| Column | Type / constraint |
|---|---|
| `product_spec_id` | text PK, default `'PRDSMD' + lpad(seq, 6)` |
| `ref_product_offering_id` | text NOT NULL, FK → `product.product_offering` ON DELETE restrict (deletion semantics is a CRUD-phase decision; restrict blocks accidents) |
| `name` | text NOT NULL |
| `is_mandatory` | boolean NOT NULL |
| `is_default` | boolean NOT NULL |
| `default_value` | text NULL |
| `product_spec_characteristics` | jsonb NOT NULL, `.$type<ProductSpecCharacteristics>()` (empty object allowed) |

Index: `product_specifications_offering_idx` on `ref_product_offering_id` (every read is "specs of the selected offering").

**`product.product_offering_price`**

| Column | Type / constraint |
|---|---|
| `product_offering_price_id` | text PK, default `'PRDOFP' + lpad(seq, 6)` |
| `product_offering_id` | text NOT NULL, FK → `product.product_offering` ON DELETE restrict (plan-doc name — no `ref_` prefix here, verbatim) |
| `name` | text NOT NULL |
| `price_type` | text NOT NULL, CHECK `price_type IN ('recurring','usage','once')` |
| `recurring_charge_period_length` | integer NULL |
| `recurring_charge_period_type` | text NULL |
| `unit_of_measure` | text NULL |
| `amount` | numeric NULL → Drizzle `string` mode (general §2.15) |
| `currency` | text NOT NULL, CHECK `char_length(currency) = 3` |
| `gl_code` | text NULL |
| `pricing_model` | text NOT NULL, CHECK `pricing_model IN ('flat','tiered')` |
| `policy` | text NULL (semantics deferred — carry only, workflow §5.1) |
| `pricing_characteristics` | jsonb NULL, `.$type<TieredPricingCharacteristics>()` |
| `start_date_time` | timestamptz NOT NULL (billing effectivity) |
| `created_at` | timestamptz NOT NULL DEFAULT `now()` (insert time; differs from `start_date_time` when future-dated) |

Constraints and indexes:

- `product_offering_price_type_start_unique` — **UNIQUE (`product_offering_id`, `price_type`, `start_date_time`)** (revised Inv. #2, Design #6).
- `product_offering_price_amount_xor_tiers_check` — CHECK:
  `(pricing_model = 'flat' AND amount IS NOT NULL AND pricing_characteristics IS NULL) OR (pricing_model = 'tiered' AND amount IS NULL AND pricing_characteristics IS NOT NULL)` (Inv. #5).
- `product_offering_price_offering_idx` on `product_offering_id`.
- **No `end_date_time`, no `last_update` column** (Inv. #3).

Export `$inferSelect`/`$inferInsert` types per table (general §2.7). Add `export * from "@/db/schema/product";` to `db/schema/index.ts`.

### 3.3 Migration — `db/migrations/0006_product.sql`

Run `npm run db:generate` **after** §3.1 + §3.2. Verify the generated SQL creates, in order: the `product` schema, the enum, the three sequences (before the tables that reference them in defaults), the three tables with all CHECK/UNIQUE/FK constraints and indexes above. Hand-adjust ordering inside the **unapplied** file if drizzle-kit emits sequences after tables (editing an applied migration remains forbidden — workflow §6.3).

Then append the permission-registry row to the same file (precedent: `0004`/`0005` seed INSERTs):

```sql
--> statement-breakpoint
INSERT INTO "core"."permissions" ("permission_name", "permission_info") VALUES ('products', 'Controls access to the Product Offering catalog page.');
```

One migration file = the whole unit's DDL + registry row (pm00: "one migration unit"; workflow §7.2: registry row, constant, and map land as one traceable set — the guard itself is pm05). No `CREATE EXTENSION` anywhere (Design #6).

### 3.4 Permission registry wiring (typed constant + forced ripples)

1. `types/rbac.ts` — add `"products"` to `PERMISSION_NAMES` (after `"audit_log"`).
2. `auth/permission-constants.ts` — add `PRODUCTS: "products"` to `PERMISSIONS`.
3. `types/roles.ts` — add `products: "Products"` to `PERMISSION_DISPLAY_NAMES` (compile error until done — the record is keyed by `PermissionName`).
4. **Conscious test-count updates (the only pre-existing assertions this unit may touch):** `tests/components/permission-matrix-editor.test.tsx` ("renders 4 rows in PERMISSION_NAMES order") and `tests/components/role-detail.test.tsx` (4-row/4-dash assertions) become **5**. This is the registry growing as designed — the Roles UI intentionally renders every registered permission so admins can map roles to `products` at runtime. `tests/services/roles-read.service.test.ts` derives counts from `PERMISSION_NAMES.length` and needs no edit. No other existing test assertion changes.

### 3.5 Domain unions — `types/product.ts` (new)

Per code-standards §2.1, `as const` unions + inferred types: `LIFECYCLE_STATUSES` (`DRAFT | ACTIVE | RETIRED`), `PRICE_TYPES` (`recurring | usage | once`), `PRICING_MODELS` (`flat | tiered`). Re-export the Drizzle row types from `@/db/schema` (pattern: `types/rbac.ts`). Read models (`OfferingListRow` etc.) are **pm03**, not here.

### 3.6 Validation schemas — `validation/product/` (new folder)

**`validation/product/product-spec-characteristics.schema.ts`** (owning schema per code-standards §2.2)

```ts
export const productSpecCharacteristicsSchema = z.record(z.string().min(1), z.string());
export type ProductSpecCharacteristics = z.infer<typeof productSpecCharacteristicsSchema>;
```

**`validation/product/pricing-characteristics.schema.ts`**

- `tierSchema`: strict object `{ from: number (finite, ≥ 0), to: number | null, rate: string matching /^\d+(\.\d+)?$/ }` — `to: null` = open-ended top tier (code-standards §2.3).
- `tieredPricingCharacteristicsSchema`: strict object `{ tiers: Tier[] }`, non-empty, with a refinement enforcing (Inv. #4): every non-last tier has `to !== null` and `to > from`; `tiers[n].to === tiers[n+1].from` exactly (contiguous, non-overlapping); only the last tier may have `to: null`.
- `priceCharacteristicsSchema`: discriminated union on `pricing_model` covering the **XOR triple**, so Zod itself rejects both violation directions (guardrail §9.5):
  - `{ pricing_model: 'flat', amount: string /^\d+(\.\d+)?$/, pricing_characteristics: null }`
  - `{ pricing_model: 'tiered', amount: null, pricing_characteristics: tieredPricingCharacteristicsSchema }`
- Export `Tier`, `TieredPricingCharacteristics`, `PriceCharacteristics` via `z.infer`. `db/schema/product.ts` imports `ProductSpecCharacteristics` / `TieredPricingCharacteristics` **type-only** (general §6.17).

**`validation/product/offering-list.schema.ts`**

Lenient searchParams schema, `.catch()` defaults per the `audit-log-filters` precedent (tampered URLs never 500 — code-standards §3.3):

```ts
export const OFFERING_SORT_VALUES = [
  "name", "-name", "product_offering_id", "-product_offering_id",
  "lifecycle_status", "-lifecycle_status", "version", "-version",
  "last_modified", "-last_modified",
] as const;

export const offeringListSearchParamsSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(LIFECYCLE_STATUSES).nullable().catch(null), // null = default view (service hides RETIRED, pm03)
  sort: z.enum(OFFERING_SORT_VALUES).catch("name"),           // Design #10
  page: z.coerce.number().int().min(1).catch(1),
  offering: z.string().regex(/^PRDOFR\d{6}$/).nullable().catch(null), // code-standards §2.6
});
export type OfferingListSearchParams = z.infer<typeof offeringListSearchParamsSchema>;
```

Page size is a pm03 service constant, not a URL param. RETIRED-hiding is **service** behavior (pm03); the schema only carries `status: null`.

### 3.7 Seeds — `db/seeds/product.ts` (new) + npm script

Standalone idempotent script following `seed-rbac.ts` exactly: `postgres` + `drizzle` with `max: 1`, skip-if-seeded pre-check (any `product_offering` row exists → log + return), everything in **one transaction**, `logger` not `console`, `process.exit(1)` on failure. Runs **after** `db:seed-rbac` (needs the ADMIN role). Every JSONB/price payload is `.parse()`d through §3.6 schemas before insert (code-standards §1.7) — a bad payload throws and nothing lands.

Seed data (all names keep the `TOREMOVE-Template-` prefix — protected, workflow §6.8; fixed UTC ISO datetimes, not `now()`, so pm03 tests are deterministic; `last_edited_by: null`; `version: 1`; currency `MYR` per `SYSTEM_CONFIG.default_currency`):

**Offering 1 — `TOREMOVE-Template-5G-Nationwide-Service-Plan`** (ACTIVE, sellable, not bundle, not billing-only)
- Specs: `TOREMOVE-Template-Network-Slice-eMBB` (mandatory, default, characteristics `{ "SST_ID": "01", "SD_ID": "A0C4E2" }`); `TOREMOVE-Template-QoS-Profile` (optional, `default_value: "standard"`, characteristics `{ "5QI": "9", "ARP": "8" }`).
- Prices:
  1. `TOREMOVE-Template-Monthly-Recurring-Charge` — recurring, flat, amount `"5000.00"`, period 1 / `months`, `gl_code "GL-4100"`, start `2026-01-01T00:00:00Z`.
  2. `TOREMOVE-Template-Monthly-Recurring-Charge-2027` — recurring, flat, amount `"5500.00"`, start `2027-01-01T00:00:00Z` — a **future-dated successor** of the same `price_type`, giving pm03 its derived-effectivity fixture (current price ends when successor starts; successor is open-ended).
  3. `TOREMOVE-Template-Activation-Fee` — once, flat, amount `"1000.00"`, start `2026-01-01T00:00:00Z`.
  4. `TOREMOVE-Template-Data-Overage` — usage, **tiered**, `amount: null`, `unit_of_measure "GB"`, `gl_code "GL-4200"`, tiers `[{from: 0, to: 1000, rate: "0.05"}, {from: 1000, to: 10000, rate: "0.04"}, {from: 10000, to: null, rate: "0.03"}]`, start `2026-01-01T00:00:00Z`.

**Offering 2 — `TOREMOVE-Template-Enterprise-IoT-Access`** (ACTIVE, sellable, not bundle, not billing-only)
- Spec: `TOREMOVE-Template-Network-Slice-mMTC` (mandatory, default, `{ "SST_ID": "03", "SD_ID": "B1D2E3" }`).
- Prices: `TOREMOVE-Template-Monthly-Recurring-Charge` — recurring, flat, `"1200.00"`, period 1 / `months`, `gl_code "GL-4100"`, start `2026-01-01T00:00:00Z`; `TOREMOVE-Template-Data-Usage` — usage, **flat**, `"0.02"` per `GB`, `gl_code "GL-4200"`, start `2026-01-01T00:00:00Z` (flat-usage variant).

**ADMIN grant (Design #7):** in the same transaction, look up the `ADMIN` role and the `products` permission; if the `role_permission_assign` row is absent, insert it with `permission_type: 'DELETE'` (highest wins ⊃ EDIT ⊃ READ). Missing ADMIN role → throw `"ADMIN role not found. Run db:seed-rbac first."` (mirrors seed-rbac's precondition style). No `AUDIT_LOG` row — deployment-time infrastructure operation, same rationale as seed-rbac.

**`package.json` scripts** (scripts only — no dependency/lockfile change, workflow §6.6): add `"db:seed-product": "node --env-file=.env --import tsx db/seeds/product.ts"`; extend `db:setup` to `… && npm run db:seed-product`.

### 3.8 Guardrail tests owned by this unit

**Unit suite (`vitest.config.ts`, no DB):**

- `tests/validation/pricing-characteristics.schema.test.ts` — accepts: valid contiguous tiers with open-ended top; valid flat + amount. Rejects: tier gap (`to: 1000` then `from: 1500`), tier overlap (`to: 1000` then `from: 500`), `to <= from`, `to: null` on a non-last tier, negative `from`, empty `tiers`, non-numeric `rate`; **XOR both ways**: `flat` + `amount: null`, `tiered` + `amount: "5.00"`, `tiered` + `pricing_characteristics: null` (guardrail §9.5).
- `tests/validation/product-spec-characteristics.schema.test.ts` — accepts flat string record and `{}`; rejects non-string values and empty keys.
- `tests/validation/offering-list.schema.test.ts` — garbage in every field falls back to defaults (`q: ""`, `status: null`, `sort: "name"`, `page: 1`, `offering: null`); valid values pass through; `offering` regex accepts `PRDOFR000001`, rejects `PRDOFR1`, `PRDSMD000001`, injection strings.
- `tests/db/product-schema.test.ts` — column-name assertions on the Drizzle objects (pattern: `rbac-schema.test.ts`): all columns of §3.2 present; **no `end_date_time`, no `last_update`** on the price table (Inv. #3, structural).

**Integration suite (`vitest.integration.config.ts`, `describe.skipIf(!databaseUrl)` — pattern: `migration.integration.test.ts`):**

- `tests/db/product-schema.integration.test.ts` — fresh-migrate then assert: `product` schema + 3 tables + 3 sequences exist; inserted rows get `PRDOFR000001`-format IDs from the defaults; duplicate (`product_offering_id`, `price_type`, `start_date_time`) insert fails (`23505`, revised Inv. #2); `flat` + NULL `amount` and `tiered` + non-NULL `amount` both fail the CHECK (`23514`); invalid `lifecycle_status` value rejected; invalid `price_type`/`pricing_model`/`currency` rejected; `last_edited_by` FK to a nonexistent user rejected; the `core.permissions` row `products` exists after migration.
- **Update `tests/db/migration.integration.test.ts`** — its `beforeAll`/`afterAll` must also `DROP SCHEMA IF EXISTS "product" CASCADE` (drop `product` before `core` — it holds FKs into core), or re-migration fails on the pre-existing schema. Its existing assertions (core tables, nothing in `public`) remain unchanged.

### 3.9 Commit

One commit, e.g. `product data layer: schema, migration 0006, validation, seeds, guardrails (pm02)`. Contents: exactly §3.1–§3.8. Explicitly **not** in this commit: repositories or `services/product` (pm03), nav changes (pm04), any `app/**` or `components/**` file, `actions/product/` or `app/api/product*` (forbidden in v1), any npm dependency or lockfile change, any edit to an applied migration, any `AUDIT_LOG` write. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 2 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages** (pm00: drizzle-orm 0.45.x already supports `pgSchema().enum()`/`.sequence()`; Zod 4 and tsx already installed). **No DB extensions** — the btree_gist requirement was removed 2026-07-04 (Design #6). Config deltas within the unit: `drizzle.config.ts` `schemaFilter` (§3.1) and the two `package.json` script entries (§3.7).

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only: `drizzle.config.ts`, `db/schema/product.ts` (new), `db/schema/index.ts`, `db/migrations/0006_product.sql` + meta journal (new), `types/rbac.ts`, `types/product.ts` (new), `types/roles.ts`, `auth/permission-constants.ts`, `validation/product/*` (3 new), `db/seeds/product.ts` (new), `package.json` (2 script lines), the 2 conscious test-count updates (§3.4.4), the migration-harness update (§3.8), and the new test files. Nothing else.
- [ ] No `actions/product/`, `app/api/product*`, or `db/repositories/product*` path exists (repositories are pm03).
- [ ] Migrations `0000`–`0005` are byte-identical to `main`; no `CREATE EXTENSION` anywhere in `0006`.
- [ ] Price table has no `end_date_time` or `last_update` column; price-mutation code exists nowhere.
- [ ] No `TODO`, commented-out code, or `console.*` introduced; seed script uses `lib/logger`.

**Build gates**
- [ ] `npm run typecheck` green — including the forced `PERMISSION_DISPLAY_NAMES` completeness (§3.4.3).
- [ ] `npm run lint` and `npm run format:check` green (boundary rule: `db/schema/product.ts` imports from `validation/product` are type-only).
- [ ] `npm run test` green — both vitest configs; the only pre-existing assertions changed are the two 4→5 permission-row counts (§3.4.4).

**Data-layer guardrails (the point of the unit)**
- [ ] Fresh database: `npm run db:setup` (migrate → seed → seed-rbac → seed-product) completes; rerunning `db:seed-product` skips idempotently.
- [ ] psql spot-check: 2 offerings, 3 specifications, 6 prices, IDs `PRDOFR000001`/`PRDOFR000002` etc.; `SELECT … FROM product.product_offering_price WHERE pricing_model = 'tiered'` shows the Data-Overage tier JSONB.
- [ ] psql: inserting a second `recurring` price on offering 1 with `start_date_time = '2026-01-01T00:00:00Z'` fails with a unique-constraint violation (revised Inv. #2).
- [ ] psql: `flat` + NULL `amount` and `tiered` + non-NULL `amount` inserts both fail the CHECK (Inv. #5).
- [ ] Zod guardrail tests prove tier gap, tier overlap, and both XOR violations are rejected (Inv. #4, §9.5).
- [ ] `core.permissions` contains `products`; `core.role_permission_assign` maps ADMIN → products at DELETE; signing in as the bootstrap admin and opening `/administration/roles` shows the new **Products** row in the permission matrix (5 rows).
- [ ] `created_at` ≠ `start_date_time` on the future-dated 2027 price row (both present, distinct — workflow §8.4).

**Docs in sync**
- [ ] Plan-folder docs carry the 2026-07-04 constraint revision (pm00, architecture Inv. #2/§3, code-standards §6.4/§9.3, overview, workflow rules) — done with this spec.
- [ ] `prodmgmt-progress-tracker.md` marks Unit 2 complete with the commit reference.

**Pipeline**
- [ ] CI green end-to-end including SAST + ZAP DAST baseline (no runtime behavior changed — no new routes).

Any failing item means the unit is not done (workflow §8). pm03 (repositories + services) must not start until this commit is verified and merged.
