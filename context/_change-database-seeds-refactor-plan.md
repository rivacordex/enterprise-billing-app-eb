# Change: Seed refactor — mandatory/demo split, de-TOREMOVE, retire BILLING_VIEWER

Status: Draft for review · Date: 2026-09-16
Boundary: **Seeds + `package.json` + RBAC types/tests only.** Splits the seed tree into a mandatory chain (`db:setup`) and an opt-in, prod-guarded demo chain (`db:seed-demo`); renames demo rows from `TOREMOVE-Template-*` to `Demo — *`; retires the `BILLING_VIEWER` role and folds its read access into the existing `MANAGER`/`USER` (Revenue Ops) roles. **No table/column change, no new `PERMISSIONS` row, no new Server Action, no new dependency. Seed-only, fresh-install scope — no migrations for already-seeded environments.**

> **What this is.** Three related asks, delivered together because they all reshape the seed tree:
>
> 1. **A clean mandatory/demo boundary** so a system installer can stand up a production-ready baseline (`db:setup`) without loading throwaway sample data, then *opt in* to demo data (`db:seed-demo`) only where wanted.
> 2. **Drop the alarming `TOREMOVE-Template-` naming** from the demo catalog and the ordering demo story, replacing it with a plain `Demo — ` prefix.
> 3. **Retire the `BILLING_VIEWER` role.** Roll its `billrun_view:READ` grant into the existing `MANAGER` and `USER` roles, and **correct the record**: bill-run viewing is not a Finance/Internal-Audit-only concern — it is ordinary Revenue Ops work (this platform is *"used internally by Revenue Ops"*, `context/architecture.md` §opening). The dedicated viewer role and its Finance/Audit framing are removed.

---

## 0. Decisions (locked with user, 2026-09-16)

- **D1 — Demo rows use a `Demo — ` display prefix.** e.g. `Demo — 5G Nationwide Service Plan`. Not the `_SAMPLE_` purge convention (that stays reserved for the bm15/bm26 bill-run sample), and not unmarked "real" names — a human-readable "this is example data" label.
- **D2 — Demo data is a dedicated, opt-in, prod-guarded `db:seed-demo`; it is never in `db:setup`.** The mandatory permission grants currently buried inside the demo files move back into the mandatory chain, so `db:setup`'s shape is unchanged — only the *content* of `db:seed-product` and `db:seed-ordering` shrinks to grants-only.
- **D3 — Seed-only, fresh-install scope.** No migrations are written to remove `BILLING_VIEWER` or rename demo rows in already-seeded environments; those are handled manually and are out of scope here.
- **D4 — `BILLING_VIEWER` is retired; `billrun_view:READ` is granted to `MANAGER` *and* `USER`.** `billrun_operate` and `billrun_approve` remain **ADMIN-only**, unchanged. Consequence, accepted deliberately: every manager and user can now view bill runs.
- **D5 — Revenue Ops correction (records amended).** The prior framing of a *"Billing Viewer role (Finance, Internal Audit)"* is withdrawn. Bill-run read access is standard Revenue Ops work carried by the platform's ordinary business roles (`MANAGER`, `USER`). All "Finance and Internal Audit" wording attached to the viewer role is removed and rolled up under Revenue Ops (see §4).

---

## 1. Goal

1. **Mandatory baseline is clean.** `npm run db:setup` seeds only what a running system genuinely needs (RBAC, admin, accounts reference data, event catalog, and the module permission grants) — zero demo/sample rows.
2. **Demo is opt-in and safe.** `npm run db:seed-demo` seeds the demo product catalog and the ordering/inventory demo story, guarded so it cannot run against production by accident.
3. **No `TOREMOVE`.** Demo rows are named `Demo — *`; the string `TOREMOVE` disappears from `db/seeds/**`.
4. **No `BILLING_VIEWER`.** The role is gone from seeds and RBAC types; `billrun_view:READ` is carried by `MANAGER` and `USER`; the Finance/Audit framing is corrected to Revenue Ops.

Non-goals: no change to how permissions are *resolved* or *checked* (all guards remain permission-based, not role-name-based); no new permission name; no schema change; no fix-up of already-deployed databases.

---

## 2. What exists today (verified against the codebase — do not re-derive)

### 2.1 The mandatory chain

`db:setup` runs (`package.json`):

```
db:migrate → db:setup-partman{,-billing,-rating}
→ db:seed → db:seed-rbac → db:seed-product → db:seed-customer
→ db:seed-accounts → db:seed-ordering → db:seed-billing → db:seed-rating
```

Genuinely mandatory and unaffected in substance: `seed-admin.ts`, `seed-rbac.ts`, the whole `accounts/` orchestrator (sys accounts, chart of accounts, GL mappings, reason codes, bill cycles, wizard defaults, accounts permissions), `customer.ts` (config + RBAC grants only — it seeds **no** customer records), and `rating-event-catalog.ts`. Note baseline `permissions` **rows** are inserted by data migrations (`0006_product.sql`, `0009_customer.sql`, `0015/0017/0020_accounts_*`, `0024_billrun_permissions.sql`), not seeds — the seeds only *grant* roles against them.

### 2.2 The two mixed files (mandatory grant + demo data in one script)

- **`db/seeds/product.ts`** — carries the mandatory `products:DELETE → ADMIN` grant (~lines 271–298) **and** 11 demo rows: two offerings + specs + prices, every one prefixed `TOREMOVE-Template-` (`TOREMOVE-Template-5G-Nationwide-Service-Plan`, `-Enterprise-IoT-Access`, etc.). Skipping `db:seed-product` to avoid the demo data also drops the mandatory ADMIN grant.
- **`db/seeds/ordering-inventory.ts`** — carries the mandatory `grantOrderingPermissions` block (`product_orders`/`product_inventory` → MANAGER/USER/ADMIN, ~lines 39–125) **and** a full demo story (`seedStory`, ~lines 155–542) built off `const PREFIX = "TOREMOVE-Template-"` (line 35): a demo org, two demo app users, a bill cycle, financial + billing accounts, and four product orders with inventory histories. It looks the demo offering up by name (`${PREFIX}5G-Nationwide-Service-Plan`), so it depends on `product.ts`'s demo rows.

> Corrects `_assessment-seed-files-strategy.md` §2, which predates the ordering seed and states `product.ts` is the *only* file with demo content — `ordering-inventory.ts` carries a demo story too.

### 2.3 The BILLING_VIEWER role

- **`db/seeds/billing.ts`** — defines `BILLING_VIEWER` (const line 17), its single grant `billrun_view:READ` (`BILLING_VIEWER_GRANTS`, lines 21–24), creates the role (lines 114–129) with descr *"Read-only access to Bill Runs (list, drill-down, export) for Finance and Internal Audit."*, and grants it (lines 131–137). `ADMIN_GRANTS` (lines 26–33) gives ADMIN `billrun_view:READ`, `billrun_operate:EDIT`, `billrun_approve:EDIT`. The `grant()` helper (lines 63–96) is a race-safe atomic upsert on `(ref_role_id, ref_permission_id)`.
- **`types/rbac.ts`** — `SEEDED_ROLE_NAMES` includes `"BILLING_VIEWER"`; `isSeededRole()` reads that list so the Roles UI protects the role from deletion.
- **Consumers verified:** all app/route guards use `requirePermission(PERMISSIONS.BILLRUN_*, ...)` and the nav registry checks the *permission*, not the role name — so nothing in app code breaks when the role is removed, provided the permission is granted elsewhere. Three tests name the role: `tests/types/rbac.test.ts`, `tests/services/roles-write.service.test.ts`, `tests/lib/nav-registry.test.ts` (a `"BILLING_VIEWER-shaped"` case asserting `{ billrun_view: "READ" }` sees only the Billing section).

---

## 3. Changes (target = `enterprise-billing-app`; specified here, executed later)

### 3.1 Split the two mixed files — mandatory portion stays, demo portion leaves

- **`db/seeds/product.ts`** → strip to the `products:DELETE → ADMIN` grant only. Remove all demo offering/spec/price inserts. Stays wired as `db:seed-product` in `db:setup`.
- **`db/seeds/ordering-inventory.ts`** → strip to `grantOrderingPermissions` only. Remove the `PREFIX` constant and the entire `seedStory` fixture. Stays wired as `db:seed-ordering` in `db:setup`.

### 3.2 New demo tree, prod-guarded

New `db/seeds/demo/`, mirroring the `accounts/` orchestrator pattern and the `sample/seed-billrun-sample.ts` guard precedent:

- **`demo/product-demo.ts`** — the offerings/specs/prices moved out of `product.ts`, renamed per §3.4.
- **`demo/ordering-demo.ts`** — the demo org/orders/inventory story moved out of `ordering-inventory.ts`, renamed per §3.4; looks the demo offering up by its **new** name.
- **`demo/seed-demo.ts`** — orchestrator; runs product-demo **before** ordering-demo (name-lookup dependency). Idempotent check-then-insert, same shape as existing seeds.
- **Prod guard** at entry (mirror `sample/seed-billrun-sample.ts`): refuse unless `DATABASE_URL` host ∈ {`localhost`,`127.0.0.1`,`db`,`postgres`} **and** `NODE_ENV !== "production"`; override with `ALLOW_DEMO_SEED=true`.

### 3.3 `package.json`

Add one script; `db:setup` chain is **unchanged**:

```json
"db:seed-demo": "node --conditions=react-server --env-file=.env --import tsx db/seeds/demo/seed-demo.ts"
```

### 3.4 Rename map (`TOREMOVE-Template-*` → `Demo — *`)

| Old | New |
| --- | --- |
| `TOREMOVE-Template-5G-Nationwide-Service-Plan` | `Demo — 5G Nationwide Service Plan` |
| `TOREMOVE-Template-Network-Slice-eMBB` | `Demo — Network Slice eMBB` |
| `TOREMOVE-Template-QoS-Profile` | `Demo — QoS Profile` |
| `TOREMOVE-Template-Monthly-Recurring-Charge` | `Demo — Monthly Recurring Charge` |
| `TOREMOVE-Template-Monthly-Recurring-Charge-2027` | `Demo — Monthly Recurring Charge (2027)` |
| `TOREMOVE-Template-Activation-Fee` | `Demo — Activation Fee` |
| `TOREMOVE-Template-Data-Overage` | `Demo — Data Overage` |
| `TOREMOVE-Template-Enterprise-IoT-Access` | `Demo — Enterprise IoT Access` |
| `TOREMOVE-Template-Network-Slice-mMTC` | `Demo — Network Slice mMTC` |
| `TOREMOVE-Template-Data-Usage` | `Demo — Data Usage` |
| ordering `PREFIX = "TOREMOVE-Template-"` | `PREFIX = "Demo — "` (→ `Demo — Order Submitter`, `Demo — Ordering Org`, `Demo — Monthly Cycle`, `Demo — Financial Account`, `Demo — Billing Account`, …) |
| emails `toremove-template-order-*@example.invalid` | `demo-order-*@example.invalid` |

### 3.5 Retire `BILLING_VIEWER`, roll `billrun_view` up to Revenue Ops (MANAGER + USER)

- **`db/seeds/billing.ts`** — remove the `BILLING_VIEWER` const, `BILLING_VIEWER_GRANTS`, the role-creation block, and its `grant()` call. Look up `MANAGER` and `USER` and grant each `billrun_view:READ` via the existing `grant()` helper. `ADMIN_GRANTS` unchanged. Rewrite the file header comment (no Finance/Audit wording).
- **`types/rbac.ts`** — remove `"BILLING_VIEWER"` from `SEEDED_ROLE_NAMES`.
- **Tests:**
  - `tests/types/rbac.test.ts` — drop `"BILLING_VIEWER"` from the seeded-role `it.each([...])`.
  - `tests/services/roles-write.service.test.ts` — same.
  - `tests/lib/nav-registry.test.ts` — rename the `"BILLING_VIEWER-shaped"` case to `"MANAGER/USER with billrun_view:READ"`; the assertion (`permissionMap({ billrun_view: "READ" })` → Billing section visible) is unchanged.
- **`db/migrations/0024_billrun_permissions.sql`** — the line-5 comment naming BILLING_VIEWER is now stale. A comment-only edit is safe; but this repo's migrator *skips* an already-applied migration, so the edit reaches new DBs only. Acceptable to leave the comment with a short "superseded — see this plan" note if editing applied migrations is discouraged by house style.

---

## 4. Coupled documentation updates (this repo)

Renaming/removing seeded data and withdrawing the Finance/Audit framing leaves several docs stale. Update in the same change:

- **`_assessment-seed-files-strategy.md`** — correct §2 (ordering-inventory also carries demo data); document the `db:seed-demo` split and the `Demo — ` naming; note the `products`/ordering grants are now the mandatory remainder of those files.
- **`context/billing-management/specs/bm01-billing-section-rbac-scaffold.md`** — remove `BILLING_VIEWER` from the seeded-roles snippet (line 63), the grant narrative (lines 72, 86–87), and the verification checklist (lines 165–166, 172); replace with `MANAGER`/`USER` carrying `billrun_view:READ` as Revenue Ops roles.
- **`context/billing-management/billmgmt-project-overview.md`** — line 89: strike *"Billing Viewer role … for Finance and Internal Audit"*; state that bill-run read access is carried by the standard Revenue Ops roles.
- **`context/billing-management/billmgmt-progress-tracker.md`** — line 248: record the role removal and the seed split.
- **`_newmodule-billing-billrun-plan.md`** — line 305: remove *"A Billing Viewer role (Finance, Internal Audit) carries `billrun_view` alone"*; replace with the Revenue Ops rollup.
- **`_change-homepage-topbar-nav-rbac-plan.md`** — the nav test matrix (lines 440, 468) lists four seeded roles including `BILLING_VIEWER`; drop it and note MANAGER/USER now see the Billing section.
- **Product specs referencing `TOREMOVE-Template-*`** — `pm02, pm03, pm05, pm06, pm07, pm08, pm10`: switch to the `Demo — ` names and note the verification data now requires running `db:seed-demo` first (it is no longer part of `db:setup`).
- Cross-reference `bm15`/`bm26` (`db:seed-sample`) as a sibling opt-in demo path; no change to the sample seed itself.

---

## 5. Verification (acceptance test on a fresh local DB)

1. **`npm run db:setup`** →
   - No demo rows: no `product_offering` named `Demo — %` or `TOREMOVE%`; no demo org/orders/inventory.
   - Mandatory grants present: `products:DELETE → ADMIN`; `product_orders`/`product_inventory` → MANAGER/USER/ADMIN; `billrun_view:READ` → ADMIN **and** MANAGER **and** USER; `billrun_operate`/`billrun_approve` → ADMIN only.
   - No `BILLING_VIEWER` role row exists.
2. **`npm run db:seed-demo`** → demo offerings + ordering story appear as `Demo — …`; re-run is idempotent (no duplicates); a non-local `DATABASE_URL` is refused unless `ALLOW_DEMO_SEED=true`.
3. **Unit tests** green: `rbac.test.ts`, `roles-write.service.test.ts`, `nav-registry.test.ts`.
4. **Greps:** `TOREMOVE` gone from `db/seeds/**`; `BILLING_VIEWER` gone from `db/seeds/**`, `types/rbac.ts`, and `tests/**`.
5. **UI smoke:** sign in as a MANAGER and as a USER → both see Billing → Bill Runs (read-only); neither can trigger/approve.

---

## 6. Out of scope / risks

- **Already-seeded environments (D3).** Existing DBs keep the orphaned `BILLING_VIEWER` role and any `TOREMOVE-*` rows until cleaned up by hand. If a follow-up wants those normalized, it is a separate migration-backed change.
- **Wider bill-run visibility (D4).** Granting `billrun_view` to USER and MANAGER means all business users can view bill runs. This is intended (Revenue Ops rollup); flagged so it is a conscious authz decision, not a drift.
