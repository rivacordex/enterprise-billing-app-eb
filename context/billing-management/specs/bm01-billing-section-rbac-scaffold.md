# bm01 — Billing section & RBAC scaffold — Spec

**Unit:** bm01 (first unit of the Bill Run build, `bm00-build-plan.md`).
**Boundary:** auth/RBAC + app shell. **No domain tables** — `bill_run` and the run list arrive in bm02.
**Grounded in the delivered codebase** at `F:/Projects/enterprise-billing-app/` (read-only): patterns quoted from `auth/permission-constants.ts`, `auth/guard.ts`, `types/rbac.ts`, `db/seeds/seed-rbac.ts`, `db/migrations/0023_ordering_inventory_permissions.sql`, `components/admin-nav.tsx`, `db/schema/{permissions,roles,role-permission-assign}.ts`, `app/(app)/layout.tsx`, `app/(app)/no-access/page.tsx`.

> **Two reconciliations with the module docs, resolved to match the delivered codebase (authoritative for conventions):**
> 1. **Permission names are snake_case**, not dotted: `billrun_view` / `billrun_operate` / `billrun_approve` (matches `accounts_view/transactions/config`). Update `billmgmt-code-standards.md` §8 and `billmgmt-architecture.md` §4 accordingly.
> 2. **Route is `/billing/bill-runs`** under `app/(app)/billing/bill-runs/`, not `/bill-runs`. Every nav section maps its caption to a `/<domain>/` route prefix (`/products/*`, `/accounts/*`, `/administration/*`); Billing follows suit. Update the `billmgmt-code-standards.md` §7 file tree and §8 route column.

---

## Goal

Stand up the **Billing** navigation section and its permission-gated **Bill Runs** page (empty state) so that a user with `billrun_view` can open `/billing/bill-runs`, a user without it is blocked at `/no-access`, and all three `billrun_*` permissions plus a new **Billing Viewer** role are seeded and grantable in the Roles admin UI — with zero domain tables and no new dependencies.

---

## Design

### Structural decisions
- **Three separate permissions, not one with levels** (`billrun_view`, `billrun_operate`, `billrun_approve`) — required by segregation of duties (four-eyes: operate and approve must be grantable to different people). This mirrors the existing Accounts module (`accounts_view/transactions/config`), so it is a precedented pattern, not a new one.
- **Permission *rows* land in a migration; *grants* land in a seed** — the established split (`0023_ordering_inventory_permissions.sql` seeds rows via `INSERT … ON CONFLICT DO NOTHING`; `db:seed-ordering` applies role grants). bm01 follows it exactly.
- **Billing Viewer is a seeded (non-deletable) role** — added to `SEEDED_ROLE_NAMES` so `isSeededRole` protects it from deletion in the Roles UI, alongside ADMIN/MANAGER/USER. Created and granted `billrun_view` by the billing seed; ADMIN is granted all three billing permissions in the same seed (so the platform admin can operate the module out of the box).
- **The page is a scaffold** — after the guard it renders a static empty state. No `bill_run` table, no data fetch, no materialization (that is bm02). `loading.tsx`/`error.tsx` ship anyway (every route segment provides them, general code-standards §3.11).
- **Nav item locks, never hides** — the item sets `requiredPermission: { name: "billrun_view", level: "READ" }`, so a user without the grant sees it rendered in the disabled/lock state (the current `components/admin-nav.tsx` fail-closed convention used by Customer/Accounts), and the page guard is the real boundary.

### Visual decisions (tokens from `billmgmt-ui-context.md` / shared `ui-context.md`)
- **Nav section caption:** `Billing`. **Item:** `Bill Runs`, icon **`ReceiptText`** from `lucide-react` (invoice/receipt family; no glyph collision with the existing nav set — `Landmark`, `FileText`, `BookOpen`, etc. are already taken). Placed **between the Accounts and Administration sections**.
- **Empty state:** a centered card on `--surface-app`, using the same card/typography pattern as `app/(app)/no-access/page.tsx` — `ReceiptText` glyph in `--text-muted`, an `--text-h3` heading "No bill runs yet", and an `--text-body` `--text-muted` line: "Bill runs appear here once a billing cycle is due. Nothing to run yet." No Deep-Petrol CTA in bm01 (the Run action is bm03).
- **No `StubDataBanner`** in bm01 (it ships with the run list in bm02).
- Page `metadata.title`: **"Bill Runs"**.

---

## Implementation

### 1. Permission registry (`types/rbac.ts`, `auth/permission-constants.ts`)
Add the three permission names to the `PERMISSION_NAMES` const array (`types/rbac.ts`):
```ts
export const PERMISSION_NAMES = [
  "users", "roles", "system_config", "audit_log",
  "products", "customers",
  "accounts_view", "accounts_transactions", "accounts_config",
  "product_orders", "product_inventory",
  "billrun_view", "billrun_operate", "billrun_approve", // ← bm01
] as const;
```
Add the typed constants to `PERMISSIONS` (`auth/permission-constants.ts`):
```ts
export const PERMISSIONS = {
  // …existing…
  BILLRUN_VIEW: "billrun_view",
  BILLRUN_OPERATE: "billrun_operate",
  BILLRUN_APPROVE: "billrun_approve",
} as const satisfies Record<string, PermissionName>;
```
These are additive; `tsc` enforces that the constant values are members of `PermissionName`.

### 2. Seeded role type (`types/rbac.ts`)
Add the Billing Viewer role to the seeded set so it is protected from deletion:
```ts
export const SEEDED_ROLE_NAMES = ["ADMIN", "MANAGER", "USER", "BILLING_VIEWER"] as const;
```
`isSeededRole("BILLING_VIEWER")` now returns `true`; no other code change needed (the Roles UI reads `isSeededRole` to disable delete). This is the **one core-type file** bm01 touches — additive only.

### 3. Migration — permission rows (`db/migrations/NNNN_billrun_permissions.sql`)
Create a **custom** SQL migration (registers in the journal): `npx drizzle-kit generate --custom --name=billrun_permissions`, then fill it in — mirroring `0023`:
```sql
-- bm01-spec §3: Permission registry entries for the Bill Runs page and the
-- operate/approve capabilities (segregation of duties — three grants, not one).
-- Role grants (ADMIN : all three; BILLING_VIEWER : billrun_view READ) are applied
-- by `db:seed-billing` (accounts/ordering precedent — grants live in the seed).
-- ON CONFLICT DO NOTHING keeps a manual re-run safe against permission_name unique.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES
  ('billrun_view',    'Controls read access to the Bill Runs page: list, drill-down, and export.'),
  ('billrun_operate', 'Controls operate access to bill runs: trigger, rerun, and cancel.'),
  ('billrun_approve', 'Controls approve access to bill runs: approve and post invoices (four-eyes).')
ON CONFLICT ("permission_name") DO NOTHING;
```
No `db/schema` change and no table in this unit — permissions are core data, not a new table.

### 4. Module seed — role + grants (`db/seeds/billing.ts` + npm script)
New standalone seed (pattern from `db/seeds/seed-rbac.ts` — idempotent pre-check, one transaction; grant rows guarded by the `role_permission_assign` unique index). It must:
1. Create the **BILLING_VIEWER** role (skip if it already exists — the idempotency pre-check).
2. Grant **BILLING_VIEWER → `billrun_view` : READ**.
3. Grant **ADMIN →** `billrun_view` : READ, `billrun_operate` : EDIT, `billrun_approve` : EDIT (look up the ADMIN role id and the three permission ids inserted by the migration).
Use `.onConflictDoNothing()` on the `role_permission_assign` inserts (unique on `ref_role_id, ref_permission_id`) so a re-run is safe. Grants target the levels the guards check (view=READ, operate=EDIT, approve=EDIT — there is no DELETE level in billing v1).

Wire the script into `package.json`:
```jsonc
"db:seed-billing": "node --conditions=react-server --env-file=.env --import tsx db/seeds/billing.ts",
"db:setup": "... && npm run db:seed-ordering && npm run db:seed-billing",
```

### 5. Route, page, states (`app/(app)/billing/bill-runs/`)
Create the folder (no layout change — `app/(app)/layout.tsx` guards nothing; each page self-guards; the sidebar resolves permissions once for all children).

`page.tsx` (RSC, thin orchestrator):
```tsx
import type { Metadata } from "next";
import { requirePermission } from "@/auth/guard";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import { BillRunsEmptyState } from "@/components/billing/bill-runs-empty-state";

export const metadata: Metadata = { title: "Bill Runs" };

export default async function BillRunsPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  return <BillRunsEmptyState />;
}
```
- `requirePermission` redirects unauthenticated → `/login` (via `getActiveUser`) and unauthorized → `/no-access`; no other guard is needed.
- The route is dynamic by virtue of the session read in the guard (no explicit `force-dynamic` — matches the existing admin pages).

`loading.tsx` — a `Skeleton` card, same shape as `app/(app)/administration/system-config/loading.tsx`.

`error.tsx` — `"use client"`, `{ error, unstable_retry }`, `reportError(error)` in `useEffect`, retry button — copied from the existing `error.tsx` pattern; heading "Unable to load Bill Runs".

`components/billing/bill-runs-empty-state.tsx` — the empty-state card described in **Design** (a server component; no `"use client"`). Component name is binding.

### 6. Navigation (`components/admin-nav.tsx`)
Insert a new `NavSection` between the **Accounts** and **Administration** sections:
```tsx
{
  caption: "Billing",
  items: [
    {
      label: "Bill Runs",
      href: "/billing/bill-runs",
      icon: ReceiptText, // add to the lucide-react import
      requiredPermission: { name: "billrun_view", level: "READ" },
    },
  ],
},
```
Add `ReceiptText` to the `lucide-react` import block. Do **not** set `carriesAccountsContext` (Billing does not carry the `?party&fa&ban` selection). No other nav change; the item renders locked (fail-closed) for users without `billrun_view`.

### 7. Docs in sync (same change set)
- Update `billmgmt-architecture.md` §4 (permission model) and `billmgmt-code-standards.md` §8 (permission map) to the snake_case names and the `/billing/bill-runs` route; update the §7 file tree (`app/(app)/billing/bill-runs/`).
- Append the bm01 row to `billmgmt-progress-tracker.md`.
- The permission-map row for bm01: `Bill Runs (list shell)` · `/billing/bill-runs` · `BillRunsPage` → `BillRunsEmptyState` · `app/(app)/billing/bill-runs/` · `billrun_view : READ`.

---

## Dependencies (packages to install)

**None.** Every dependency this unit needs is already present in `package.json`: `next` 16, `react` 19, `drizzle-orm`, `postgres`, `lucide-react` (provides `ReceiptText`), `tsx` (seed runner), `better-auth`. Per the just-in-time rule, bm01 installs nothing — the workflow engine client, partitioning, and pgledger integration arrive with the units that first need them (bm03+).

---

## Verification checklist

Build & types
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` clean; `PERMISSIONS.BILLRUN_*` values type-check against `PermissionName`.
- [ ] No new dependency added to `package.json` (only the `db:seed-billing` script + its wiring into `db:setup`).

Migration & seed (run `npm run db:migrate` then `npm run db:seed-billing`)
- [ ] The migration inserts exactly three `core.permissions` rows (`billrun_view/operate/approve`); re-running it changes nothing (`ON CONFLICT DO NOTHING`).
- [ ] The seed creates the `BILLING_VIEWER` role once; re-running it is a no-op (idempotent pre-check + `onConflictDoNothing` on grants).
- [ ] After seeding: `BILLING_VIEWER` has `billrun_view:READ`; `ADMIN` has `billrun_view:READ`, `billrun_operate:EDIT`, `billrun_approve:EDIT`.

Authorization (the visible result)
- [ ] A user with `billrun_view` opens `/billing/bill-runs` and sees the empty state; the "Bill Runs" nav item is active/enabled.
- [ ] A user **without** `billrun_view` is redirected to `/no-access` when hitting `/billing/bill-runs` directly (server-enforced, not just hidden), and the nav item renders **locked**.
- [ ] An unauthenticated request to `/billing/bill-runs` redirects to `/login`.
- [ ] The three billing permissions and the Billing Viewer role are **grantable/visible in the Roles admin UI**; `BILLING_VIEWER` shows as non-deletable (`isSeededRole`).

Route × level matrix test (`tests/…`, mirrors the existing admin-page matrix)
- [ ] `/billing/bill-runs`: `billrun_view:READ` granted → renders; no grant → `/no-access`; unauthenticated → `/login`. This test exists and passes before the unit is done.

Scaffold discipline
- [ ] No `bill_run` (or any billing domain) table is created; no data fetch in `page.tsx`; no `StubDataBanner`, no CTA.
- [ ] `loading.tsx` and `error.tsx` exist for the segment; component `BillRunsEmptyState` is created with that exact name.
- [ ] Only these files changed: `types/rbac.ts`, `auth/permission-constants.ts`, `components/admin-nav.tsx`, the new migration, `db/seeds/billing.ts`, `package.json`, the three files under `app/(app)/billing/bill-runs/`, `components/billing/bill-runs-empty-state.tsx`, and the four doc updates. No drive-by edits.

Docs
- [ ] `billmgmt-architecture.md` §4, `billmgmt-code-standards.md` §7/§8, and `billmgmt-progress-tracker.md` updated in the same change set to the snake_case names and the `/billing/bill-runs` route.
