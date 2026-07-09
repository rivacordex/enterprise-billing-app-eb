# PM09 — Authz-Matrix Entry + Guardrail Sweep

- **Unit:** 9 of 9 (`pm00-build-plan.md`) — the module's **ship gate**.
- **Dependencies:** pm01–pm08 all **verified and merged** (`pm00-build-plan.md` dependency graph: `… → pm08 → pm09`). Concretely pm09 assumes: the `(admin)` → `(app)` rename + `tests/app/route-manifest.test.ts` (pm01); the `product` schema, `products` PERMISSIONS row, overlap UNIQUE + `amount`-XOR CHECK constraints, and the `products` domain-union/typed-constant wiring (pm02); repositories + `services/product` with the price repo exporting no `update*`/`delete*` and the derived-effectivity read models (pm03); the `NAV_SECTIONS` refactor (pm04); the guarded page with searchParams + deep-link behaviour (pm05); and the detail/specs/prices sections (pm06–pm08). pm09 must not start until pm08 is merged and green.
- **Authorizing sections:** build-plan *Unit pm09*; overview *Success Criteria* (the seven observable proofs) and *Access control*; `prodmgmt-architecture.md` §2 (`tests/**` row — "New page must appear in the matrix before ship, platform §5"), §4 (permission matrix), Inv. #1/#2/#3/#4/#5/#10/#11/#12; `prodmgmt-code-standards.md` §1.1/§1.3 (v1 read-only, reads not audited), §5.1/§5.3 (no `app/api/product*`), §7.2 (no `actions/product/`), §8 (per-page permission map), **§9 (the seven module guardrail tests — the checklist this unit closes)**; `prodmgmt-ai-workflow-rules.md` §2.8, §4.4, **§8 (module verification pass)**; general `code-standards.md` §1.11 (page needs map row + permission migration + guard), §7.9 (a guarded route isn't done until its route × level matrix tests exist), **§10 (CI gates, incl. SAST + OWASP ZAP DAST)**; platform `architecture.md` §5/§6 (authorization, per-page permission map), Inv. #3/#4 (server-side authz, deny by default); general `ai-workflow-rules.md` §8 (verification-before-next-unit checklist).
- **Codebase state assumed at start (re-verify before implementing):** pm01–pm08 merged. Concretely relevant to this unit:
  - **The authz "matrix" is `tests/auth/guard.integration.test.ts`** — the canonical *route × level* proof (code-standards §7.9, §10.4). It runs the real `auth/guard.ts` against a live Postgres (`describe.skipIf(!DATABASE_URL)`), seeds its **own** permissions/roles in `beforeAll` (it does **not** run `db/seeds/seed-rbac.ts`), and asserts, via `it.each`, that an admin principal satisfies every seeded `permission:level` and that a no-grants principal is redirected to `/no-access`. Today it seeds four permissions (`users`, `roles`, `system_config`, `audit_log`) and grants the admin role `users/roles/system_config:DELETE` + `audit_log:READ`.
  - **The route→permission map** lives in `prodmgmt-architecture.md` §4 and `prodmgmt-code-standards.md` §8 (the `/products/product-offering` → `products : READ` row), and `PERMISSIONS.PRODUCTS = "products"` is the typed constant in `auth/permission-constants.ts`. Per pm02/pm05 docs-in-sync (workflow §7.1–§7.2), these three surfaces land **with** the permission itself — pm09 **verifies** them, it does not introduce them.
  - **Per-page guard test** for the offering page (mock-`requirePermission` style of `tests/app/users-page.test.tsx`: "calls `requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ)` before fetching" + "propagates the `/no-access` redirect") is owned by **pm05** (build-plan: "guard blocks no-grant"). pm09 does **not** duplicate it; pm09 adds the **integration** route × level cases.
  - `PERMISSION_NAMES` (`types/rbac.ts`) and `EffectivePermissionMap` (`types/permissions.ts`, `Record<PermissionName, …>`) gained the `products` key in pm02 — so every existing `permissionMap` fixture/mock (e.g. in `tests/app/users-page.test.tsx`) already carries `products`. pm09 assumes that ripple is done; if `npm run typecheck` surfaces a missing `products` key, that is an unfinished pm02, not pm09 work.
  - CI gates already exist: `package.json` scripts `typecheck`, `lint`, `format:check`, `test` (`vitest run && vitest run --config vitest.integration.config.ts`); `infra/azure-pipelines.yml` + `infra/zap-scan-stage.yml` + `infra/zap/{rules.tsv,zap-context.xml}` run SAST and the OWASP ZAP DAST baseline. pm09 changes **no** `infra/**` file (protected, workflow §6.5).
  - No `actions/product/` folder, no `app/api/product*` path, and no `product_offering_price` `update*`/`delete*` export exist (pm02/pm03 held the line) — pm09 makes those absences **CI-asserted**, module-wide.

---

## 1. Goal

Close the module by (a) adding the `/products/product-offering` **route × level entry** to the platform authz matrix (`tests/auth/guard.integration.test.ts`: seed the `products` permission, grant it to the admin role, and assert `products:READ/EDIT/DELETE` satisfied for a grant-holder and `products` denied → `/no-access` for a no-grants principal), (b) landing a small **guardrail-sweep** test that asserts the module's negative-space invariants module-wide (no `actions/product/`, no `app/api/product*`, price repo exports no `update*`/`delete*`, no `AUDIT_LOG` write reachable from product read paths, and `/products/product-offering` present in the route manifest), and (c) running the full **workflow §8 verification pass** (typecheck, lint, format, both vitest configs, SAST + ZAP DAST baseline, Administration pages green under `(app)`). Visible result: **CI green with all seven module guardrails passing** — authz matrix, price immutability, overlap constraint, derived effectivity, JSONB validation, deep link, and rename invariance — the module's ship gate.

## 2. Design

### 2.1 Boundary — Tests / CI only

pm09's boundary is **tests + CI**, not product feature code. It writes and edits **`tests/**` files only** (plus, if a verification-pass finding requires it, a genuinely-missing doc row — see §2.4). It adds **no** `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, `app/api/**`, or `infra/**` file. Every code-standards §9 guardrail behaviour was **built** by the unit that owns the code it guards; pm09 either **inherits** that guardrail (it already ships and passes) or **adds the one remaining test** the earlier units deferred to the ship gate — never new runtime behaviour. If pm09 discovers a guardrail is *missing runtime enforcement* (not just a test), that is a defect in the owning unit (pm02/pm03/pm05), to be fixed there — pm09 does not paper over it with a test-only workaround (workflow §8: "the unit is not done").

### 2.2 The seven-guardrail ownership ledger

The build-plan visible result names **seven** guardrails. Most are already delivered and merged; pm09's *net-new* code is only the two unshaded rows. The ledger below is the design's backbone — pm09 first **audits** that each inherited guardrail is present and green (§3.1), then adds only what is left.

| # | Guardrail (code-standards §9) | Owning unit / file | pm09 action |
|---|---|---|---|
| 1 | **Authz matrix** — `/products/product-offering` × role/level, no-grant → `/no-access` | **pm09** — `tests/auth/guard.integration.test.ts` (integration route × level) + pm05's page-guard unit test | **ADD** (§3.2) — integration cases; verify pm05 page-guard test present |
| 2 | **Price immutability** — replacement price leaves old row untouched + bumps `version`; price repo exports no `update*`/`delete*` (structural) | pm02 (constraint/shape) + pm03 (`tests/db/product-offering-price-repository.integration.test.ts`, structural export assert) | **INHERIT** + re-assert the structural no-mutation-export check in the sweep (§3.3) |
| 3 | **Overlap constraint** — two same-`price_type` prices, same `start_date_time`, one offering → fails at the DB | pm02 (`tests/db/product-schema.integration.test.ts` / migration test) | **INHERIT** — audit present & green |
| 4 | **Derived effectivity** — price effective "now" from `start_date_time`; future successor doesn't displace early; open-ended → `endDateTime: null` | pm03 (`services/product` service test) | **INHERIT** — audit present & green |
| 5 | **JSONB validation** — tiered tier gap/overlap fails Zod; `flat`+`amount NULL` and `tiered`+`amount NOT NULL` both fail (Zod + DB CHECK) | pm02 (`validation/product` schema test + DB CHECK test) | **INHERIT** — audit present & green |
| 6 | **Deep link** — `?offering=PRDOFR000001` in a fresh session reproduces the view; unknown ID → empty-detail state | pm05 (`tests/app/product-offering-page.test.tsx`) | **INHERIT** — audit present & green |
| 7 | **Rename invariance** — every Administration route passes its authz matrix unchanged under `(app)`, identical URLs | pm01 (`tests/app/route-manifest.test.ts`) | **INHERIT** — audit present & green; extend manifest assertion to include `/products/product-offering` if pm05 did not (§3.3) |

pm09's net-new files: the **guard.integration matrix extension** (guardrail 1) and one **module-boundary sweep test** (guardrails 1/2/7 negative-space + module invariants). Everything else is an *audit-and-verify* step, not new code.

### 2.3 What "authz-matrix entry" means concretely

Two distinct authz surfaces already exist in this codebase; the build-plan phrase "page must be in the matrix before ship" maps onto both:

1. **The route × level *test* matrix** — `tests/auth/guard.integration.test.ts`. This is the §7.9 "route × level matrix" that makes a guarded route "done". pm09 extends it (§3.2). This is the single most important deliverable of the unit.
2. **The route → permission *doc* map** — `prodmgmt-architecture.md` §4 + `prodmgmt-code-standards.md` §8. Per docs-in-sync (workflow §7.1), the `/products/product-offering → products : READ` rows land **with** pm02's permission and pm05's guard. pm09 **verifies** the rows are present and correct (§3.4); it edits them only if the audit finds a genuine gap.

pm09 deliberately does **not** re-implement the page-level guard *unit* test (pm05 owns "guard blocks no-grant"). The integration matrix (real guard + live DB) and the page-guard unit test (mocked `requirePermission`) are complementary, not duplicative — the first proves the guard's DB-backed decision, the second proves the page *calls* the guard before fetching.

### 2.4 No new runtime behaviour, no new audit, no forbidden paths

By Inv. #11 and code-standards §1.1/§5.3/§7.2, v1 adds no mutation surface; by §1.3 reads are not audited. The sweep test (§3.3) turns these prose invariants into **executable, permanent CI assertions** so a future careless change (e.g. a CRUD-fast-follow branch merged early, or an audit write slipped into a read path) fails the build rather than the review. This is the "guardrail sweep" half of the unit: it does not add behaviour — it forbids behaviour, in code.

## 3. Implementation

### 3.1 Pre-flight guardrail audit (do first, non-optional)

Before writing anything, confirm each inherited guardrail (§2.2 rows 2–7) actually exists and is green on `main`, and record the exact file/test name in `prodmgmt-progress-tracker.md`. Command sketch (adjust to the real filenames pm02–pm08 committed):

```
# every guardrail should map to a passing test; list them
grep -rIl "immutab\|update.*price\|delete.*price" tests/db          # guardrail 2
grep -rIl "start_date_time\|overlap\|duplicate" tests/db            # guardrail 3
grep -rIl "endDateTime\|effectivit\|future-dated\|open-ended" tests # guardrail 4
grep -rIl "tier\|pricing_characteristics\|amount.*null" tests/validation tests/db  # guardrail 5
grep -rIl "offering=\|deep.link\|not.found\|empty.detail" tests/app  # guardrail 6
cat tests/app/route-manifest.test.ts                                 # guardrail 7 (pm01)
cat tests/app/product-offering-page.test.tsx                         # pm05 page-guard (guardrail 1 unit half)
```

If any inherited guardrail is **missing or red**, stop: it is the owning unit's defect (pm02/pm03/pm05), fix it there, and re-verify — do **not** invent a replacement test in pm09 (§2.1). Only once all six inherited guardrails are green does pm09 add its two net-new pieces (§3.2, §3.3).

### 3.2 Authz-matrix entry — extend `tests/auth/guard.integration.test.ts` (edit)

Add `/products/product-offering`'s permission to the integration matrix. Four surgical edits inside the existing `describe.skipIf(!databaseUrl)` block — no restructuring, no change to any existing assertion:

1. **Seed the `products` permission** — in the `beforeAll`, add one row to the `db.insert(permissions).values([...])` array:
   ```ts
   { permissionName: "products", permissionInfo: "Products" },
   ```
   (Mirrors the existing four rows; `permissionName` must be the exact seeded string `"products"`, code-standards §8.)

2. **Grant it to the admin role** — add to the `grants` array so the admin principal holds the full level range (READ/EDIT/DELETE are all seeded in v1 even though EDIT/DELETE are unused by the page):
   ```ts
   { name: "products", type: "DELETE" },   // DELETE ⊃ EDIT ⊃ READ
   ```
   A single `DELETE` grant satisfies the READ/EDIT/DELETE `it.each` rows below via `meetsLevel` (level rank), matching how `users/roles/system_config` are seeded at `DELETE`.

3. **Add the satisfied route × level cases** — append to the `requirePermission` `it.each([...])` table:
   ```ts
   [PERMISSIONS.PRODUCTS, LEVELS.READ],
   [PERMISSIONS.PRODUCTS, LEVELS.EDIT],
   [PERMISSIONS.PRODUCTS, LEVELS.DELETE],
   ```
   Each asserts `result.permissionMap[name]` is non-null for the admin principal — i.e. the page's `products:READ` gate (and the seeded-but-unused EDIT/DELETE) resolve for a grant-holder.

4. **Add `products` to the no-grants denial loop** — append `PERMISSIONS.PRODUCTS` to the `it.each([...])` list that asserts a no-grants ACTIVE user is redirected to `/no-access` for each permission at `READ`. This is the deny-by-default half (Inv. #10, platform Inv. #4): a principal lacking `products:READ` never reaches the page.

No page URL is exercised directly (the guard is permission-keyed, and route↔permission is 1:1 per §2.3); the doc map (§3.4) records the `/products/product-offering` ↔ `products` binding that this test proves at the permission layer. **PENDING/DISABLED/no-session/force-password-change** cases already cover every permission generically (they don't enumerate per-permission) — no edit needed there.

### 3.3 Guardrail sweep — `tests/guardrails/product-module-boundaries.test.ts` (new)

One new unit-suite test (runs under `vitest.config.ts`; pure `node:fs`/`node:path` + static-source assertions, no jsdom, no DB — same shape as pm01's `route-manifest.test.ts`). It makes the module's negative-space invariants permanent, executable CI facts. Assertions:

1. **No `actions/product/` folder** (Inv. #11; code-standards §7.2) — assert the path does not exist on disk.
2. **No `app/api/product*` path** (code-standards §5.1/§5.3) — walk `app/api/**` and assert no segment matches `/^product/`.
3. **Price repo exports no mutation surface** (Inv. #1; code-standards §1.2) — read `db/repositories/product-offering-price.ts` source and assert no exported identifier matches `/^(update|delete|insert(?!Price\b))/` — i.e. the only write export permitted is `insertPrice`; assert `update*`/`delete*` are absent. (Structural, string-level — complements pm03's export-shape assert; duplicated here deliberately so the ship gate re-checks it module-wide.)
4. **No `AUDIT_LOG` write reachable from product read paths** (Inv. #7; code-standards §1.3 — reads are not audited) — scan `services/product/**`, `db/repositories/product-*.ts`, `app/(app)/products/**`, `components/products/**` and assert none imports the audit-log repository or references an audit-write helper (`grep`-style match on `audit-log-repository`, `insertAuditLog`, `AUDIT_LOG`). Reads add no audit rows.
5. **Route manifest includes the new page** (guardrail 7 extension) — assert the pm01 `ROUTE_MANIFEST` (or the manifest the page test freezes) now contains `"/products/product-offering"` exactly once, so the rename-invariance guard consciously accounts for the module's one new route rather than flagging it as an unplanned page. If pm05 already extended the manifest, this is a re-assertion; if not, pm09 extends `tests/app/route-manifest.test.ts`'s frozen list here (its own consciously-versioned edit, per pm01 §3.5's design).

Each assertion carries a one-line comment citing its invariant so a future reader sees *why* the boundary exists, not just *that* it does.

### 3.4 Doc / permission-map verification (verify; edit only if a gap is found)

Confirm the three permission surfaces are present and mutually consistent (they should already be, from pm02/pm05):

- `prodmgmt-architecture.md` §4 — the `/products/product-offering (list + detail + specs + prices) | Authenticated | products : READ` row, plus the seeded-but-unused EDIT/DELETE rows.
- `prodmgmt-code-standards.md` §8 — the per-page map row (`Product Offering | /products/product-offering | ProductOfferingPage → OfferingTable, OfferingDetail, SpecificationsPanel, PricesPanel | app/(app)/products/product-offering/ | products : READ`).
- `auth/permission-constants.ts` — `PERMISSIONS.PRODUCTS = "products"`; `types/rbac.ts` `PERMISSION_NAMES` contains `"products"`.

If all present and correct: **no doc edit in pm09** (they were landed by their owning units — workflow §8.1 "docs in sync" is a *check* here, not an *edit*). If the audit finds a missing/incorrect row, that is a docs-in-sync defect in the owning unit; fix the row in the same change set and note it in the tracker (workflow §7). Do not create parallel or duplicate map tables.

### 3.5 Full verification pass (workflow §8 — the point of the ship gate)

Run the entire general §8 / module §8 checklist and record the results in the tracker. This is the unit's *work*, not an afterthought:

- `npm run typecheck` — clean under strict config (the `products` key is present across `EffectivePermissionMap` fixtures; the new tests type-check).
- `npm run lint` and `npm run format:check` — clean, incl. import-boundary and `no-floating-promises`.
- `npm run test` — **both** vitest configs green: the unit suite (incl. the new sweep test) **and** the integration suite (incl. the extended `guard.integration.test.ts`; requires `DATABASE_URL`, else that block `skipIf`-skips — the ship gate must run it against a real DB, so ensure the CI integration stage has `DATABASE_URL` set).
- **Administration regression** — every pre-existing Administration page (`/administration/users|roles|system-config|audit-log`, `/no-access`) renders at its identical URL with identical authz results under `(app)` (guardrail 7); zero pre-existing assertion changed.
- **Security scan** — SAST + OWASP ZAP DAST baseline against the staging revision: no high/critical finding. pm09 adds no new route, handler, or input surface (it is tests-only), so the DAST attack surface is unchanged from pm08; confirm the baseline is still clean and that the new `products:READ` page is exercised as an authenticated-only route (unauthenticated → `/login`, no-grant → `/no-access`).
- **Behavioural spot check** (dev server, per overview *Success Criteria*): a `products:READ` grantee reaches `/products/product-offering` from the nav, searches a 100-row catalog, and reads detail/specs/prices; a no-grant user is stopped at the guard; `?offering=PRDOFR000001` in a fresh session reproduces the view; both seeded offerings render incl. the tiered Data Overage price; inserting a replacement price (SQL) leaves the old row and bumps `version`; a duplicate same-type `start_date_time` seed fails the constraint.

Any failing item means the unit — and the module — is not done (workflow §8).

### 3.6 Commit

One commit, e.g. `product module ship gate: authz-matrix entry + guardrail sweep (pm09)`. Contents: `tests/auth/guard.integration.test.ts` (edit — products seed/grant + route × level cases + no-grant denial), `tests/guardrails/product-module-boundaries.test.ts` (new), and — only if §3.3.5 required it — the `tests/app/route-manifest.test.ts` manifest extension. Explicitly **not** in this commit: any `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, `app/api/**`, `auth/**`, or `infra/**` change; any dependency/lockfile change; any doc edit unless §3.4's audit found a genuine gap. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md`: Unit pm09 complete + the guardrail-audit results + the module ship-gate sign-off) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages.** Everything is already installed: `vitest` + `drizzle-orm`/`postgres` (integration matrix), `node:fs`/`node:path` (sweep test) — the same toolchain pm01's `route-manifest.test.ts` uses. **No DB extension, no schema/migration/validation/service/component change** (pm09 is tests + CI only). Requires pm01–pm08 merged and green (§Dependencies header) — in particular pm02's `products` permission + typed constant + `PERMISSION_NAMES`/`EffectivePermissionMap` ripple, pm03's price-repo shape + derived-effectivity read models, and pm05's guarded page + deep-link test. The CI integration stage must provide `DATABASE_URL` so the extended `guard.integration.test.ts` block actually runs (it `skipIf`-skips without it — a silently-skipped ship gate proves nothing).

## 5. Verification checklist

Run before declaring the unit — and the module — done (general workflow §8; prodmgmt-workflow §8).

**The seven guardrails (build-plan visible result — all must be green)**

- [ ] **Authz matrix** — `guard.integration.test.ts` proves an admin/grant-holder satisfies `products:READ/EDIT/DELETE` and a no-grants ACTIVE user is redirected to `/no-access` for `products:READ`; pm05's page-guard unit test (`requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ)` called before fetch, `/no-access` propagated) is present and green.
- [ ] **Price immutability** — the price repo exports no `update*`/`delete*` (structural assert green in pm03 **and** the pm09 sweep); a replacement-price insert leaves the old row untouched and bumps `version`.
- [ ] **Overlap constraint** — seeding two same-`price_type` prices with the same `start_date_time` on one offering fails at the DB (pm02 test green).
- [ ] **Derived effectivity** — price effective "now" resolves from `start_date_time`; a future-dated successor doesn't displace the current price early; open-ended prices return `endDateTime: null` (pm03 test green).
- [ ] **JSONB validation** — tiered `pricing_characteristics` with a gap/overlap fails Zod; `flat`+`amount NULL` and `tiered`+`amount NOT NULL` both fail (Zod + DB CHECK) (pm02 test green).
- [ ] **Deep link** — `?offering=PRDOFR000001` in a fresh session reproduces the view; an unknown ID → empty-detail state (pm05 test green).
- [ ] **Rename invariance** — every Administration route passes its authz matrix unchanged under `(app)` with identical URLs; `route-manifest.test.ts` is set-equal to the frozen manifest, now including `/products/product-offering` (pm01 test green, manifest extended).

**Guardrail-sweep test (net-new)**

- [ ] `tests/guardrails/product-module-boundaries.test.ts` asserts: no `actions/product/` folder; no `app/api/product*` path; price repo exposes only `insertPrice` among writes; no `AUDIT_LOG` write imported/reachable from `services/product/**`, `db/repositories/product-*`, `app/(app)/products/**`, `components/products/**`; route manifest includes `/products/product-offering` once.
- [ ] Each assertion cites its invariant in a comment; the file is `node:fs`-only (no DB, no jsdom) so it runs in the fast unit suite.

**Diff hygiene**

- [ ] `git status` shows only: `tests/auth/guard.integration.test.ts` (edit), `tests/guardrails/product-module-boundaries.test.ts` (new), and — only if needed — `tests/app/route-manifest.test.ts` (manifest extension). Nothing else.
- [ ] **No** `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, `app/api/**`, `auth/**`, or `infra/**` change; no dependency/lockfile change; no doc edit (unless §3.4 found a real gap).
- [ ] No pre-existing test assertion changed except the two intended additions (guard.integration cases; manifest entry). No `TODO`, commented-out code, or `console.*`.

**Build gates (workflow §8.7)**

- [ ] `npm run typecheck` green (`products` key present across `EffectivePermissionMap` fixtures; new tests type-check; no `any`, no cross-boundary `!`).
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — **both** configs; the integration suite runs with `DATABASE_URL` set (the ship gate does **not** accept a `skipIf`-skipped guard matrix).

**Authorization & audit (module §8.2–§8.3)**

- [ ] `requirePermission('products', 'READ')` gates the whole page; no partial rendering of specs/prices under a weaker check (Inv. #10); deep links pass the same guard.
- [ ] **No `AUDIT_LOG` writes added** — reads are not audited in v1 (code-standards §1.3); confirmed by the sweep test and by grep.

**Docs in sync (verify, don't duplicate)**

- [ ] `prodmgmt-architecture.md` §4 + `prodmgmt-code-standards.md` §8 carry the `/products/product-offering → products : READ` rows (+ seeded EDIT/DELETE); `PERMISSIONS.PRODUCTS`/`PERMISSION_NAMES` carry `"products"`. No new/parallel map introduced.
- [ ] `prodmgmt-progress-tracker.md` marks Unit pm09 complete with the commit ref, the guardrail-audit results, and the module ship-gate sign-off.

**Pipeline (workflow §8.7; code-standards §10)**

- [ ] CI green end-to-end: typecheck, lint, format, unit + integration suites, migrations ordered (no manual DDL), secret scan, **SAST + OWASP ZAP DAST baseline** (no high/critical; attack surface unchanged vs pm08 — tests-only unit); Administration pages green under `(app)`.

Any failing item means the module is not shipped (workflow §8). With pm09 verified and merged, the read-only Product Management v1 catalog viewer is complete and gated; the CRUD fast-follow is the next, separately-authorized phase.
