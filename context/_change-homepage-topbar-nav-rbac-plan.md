# Plan: Landing Homepage, top-bar chrome, and permission-filtered navigation

Status: Draft for review · Date: 2026-09-12 (rev. 2 — all open questions resolved)
Boundary: **FRONTEND + platform chrome**, plus one guard correction and one config-metadata migration. One new `lib/` registry + selector, one new `components/` icon map, three new/restructured chrome components, one page moved into the `(app)` route group, one page guard lowered with its edit controls gated, one forward migration for a config `description`. **No table/column change, no new `PERMISSIONS` row, no new Server Action, no new dependency.**

> **What this is.** Two related asks, delivered together because they share one piece of new machinery — a single page registry that knows every page's route, label, and required `permission : level`:
>
> 1. **A default landing Homepage after login**, listing every page the signed-in user may open.
> 2. **Nav and Homepage both filtered by role** — a user sees only links their roles actually permit.
>
> Plus the chrome decision from the discussion: **a top bar is added, the left sidebar stays**, and — from rev. 2 — the brand moves to the top bar entirely, the sidebar defaults to collapsed, and the Accounts Settings guard is corrected so read-only users can view it with edit controls disabled.
>
> ⚠️ **This is a platform-level change** under `ai-workflow-rules.md` §2.8 (shared-nav refactor + shared shell layout). That section requires explicit authorization before the work starts, delivered as isolated units with CI proof that every existing module's behavior, URLs, and authz results are unchanged. **This plan is that authorization request.** It also amends two documented decisions (§7), which §5.7 says needs approval, not a unilateral edit.

---

## 0. Decisions

**Locked in review, 2026-09-12 (first pass):**

- **D1 — Hybrid chrome: top bar added, sidebar kept.** A full-width top bar carries the brand (logo + `app_name`), the sidebar collapse toggle, a **Home** button, and the signed-in identity + sign-out. The left sidebar keeps one job: module navigation. Rejected: top-bar-only (17 items don't fit as flat links; would need a new dropdown nav, a narrow-viewport fallback, and re-homing the accounts `?party&fa&ban` threading). Rejected: sidebar-only (loses the persistent Home affordance and leaves identity buried in a footer that vanishes when collapsed).
- **D2 — Denied pages are hidden, everywhere.** Nav and Homepage both render only what the viewer may open. The existing "locked item" treatment in `AdminNav` (greyed row, `Lock` icon, `aria-disabled`, "Requires customer read access" tooltip) is **deleted**. This is the platform-wide behavior `architecture.md` §2 anticipated — see §7.
- **D3 — The Homepage is `/`.** `app/page.tsx` moves to `app/(app)/page.tsx` so it inherits the shell. The permission-ordered `ROUTE_ORDER` redirect table is retired. A zero-grant user sees the Homepage with an empty state, not `/no-access`; `/no-access` survives for direct hits on a page the viewer lacks.
- **D4 — One registry, two consumers, one CI gate.** A single `NAV_REGISTRY` in `lib/` is the only place a page's `route → label → permission : level` is written. The sidebar, the Homepage, and a guardrail test all read it; the test asserts each entry matches the `requirePermission(...)` call in that page's own file, so the two can never drift.
- **D5 — `/` joins the session-gated exception list.** `architecture.md` §5 says a page with no permission is a bug; §7 of `ai-workflow-rules.md` allows named exceptions. The Homepage must be reachable by every ACTIVE user by definition, so it is session-gated (`requireAuthenticated()`), like `/no-access`. It discloses nothing it doesn't permit: the list it renders **is** the permission check.
- **D6 — Fail-closed stays fail-closed.** Under D2 "locked" is gone, so `AdminNav`'s no-`permissionMap` fallback becomes **hidden**: no map ⇒ no items. The layout always supplies a map for a resolved identity, so this only bites on a programming error, which is the point.

**Locked in review, 2026-09-12 (rev. 2 — the five open questions):**

- **D7 (was Q1) — Accounts Settings drops to `READ`; its edit controls grey out.** `/administration/accounts-settings` currently guards on `accounts_config : EDIT`, but **the only link to `/administration/accounts-settings/flows` lives on that page**, and `/flows` itself guards on `accounts_config : READ` — so the exact role allowed to read the flows reference cannot reach it. Fix: lower the page guard to `READ` and disable the five mutation controls unless the viewer holds `EDIT`. **Verified safe:** all five backing Server Actions (`upsertReasonCode`, `retireReasonCode`, `upsertBillCycle`, `retireBillCycle`, `setWizardDefaults`) already re-check `accounts_config : EDIT` themselves, so lowering the page guard grants no new mutation power — greying out is UX, the actions are the boundary (Inv. #3). `/flows` then needs no registry entry of its own; it is genuinely reached from its parent.
- **D8 (was Q2) — No per-page descriptions.** Homepage tiles are icon + label only. The `description` field is dropped from the registry entirely — no copy to write, no copy to maintain, no second place for a page's name to drift.
- **D9 (was Q3) — The sidebar defaults to collapsed.** With the Homepage as the directory and the brand in the top bar, the expanded rail is no longer the primary way to find a page. `defaultCollapsed` is `true` when no `sidebar_collapsed` cookie is present; an explicit user choice still wins and still persists for a year.
- **D10 (was Q4) — `BrandLogo`'s `"nav-collapsed"` variant is deleted.** The brand renders once, in the top bar, and never moves or changes with collapse state. The app name moves there with it. `"login"` and the new `"topbar"` are the only variants left.
- **D11 (was Q5) — Top-bar identity is name + email with a separator.** `Jane Tan · jane.tan@example.com` on one line.

**New in rev. 2:**

- **D12 — `app_name` gets a documented and enforced maximum of 40 characters.** The seeded `description` spells the limit out, and the write path rejects a longer value rather than relying on CSS truncation alone. See §3.13.

**Locked in review, 2026-09-12 (rev. 3):**

- **D13 — Confirmed page geometry: top bar on top, full width; sidebar beneath it, on the left; brand logo is the leftmost element of the top bar** and never moves with collapse state or route. Diagram in §3.5.
- **D14 — One-time exception: the `app_name` description is fixed by editing `0005_admin_chrome_config.sql` in place, not by a forward migration.** Granted explicitly in review as a one-off. Defensible here because the `description` is seed metadata that nothing reads but the admin UI's help text. **But see §3.14** — in this repo's migrator an edited applied migration is *skipped*, not re-applied, so the edit reaches new databases only and existing environments need one documented `UPDATE`. `db/migrations/README.md` is corrected in the same unit, because it currently describes the opposite behavior.
- **D15 — The README is rewritten around install + day-to-day admin, with the wipe/teardown material removed.** Tracked separately in `_change-readme-install-and-admin-plan.md`; the `app_name` `UPDATE` from D14 lands in its admin section.

---

## 1. Goal

1. **Homepage.** After login, every user lands on a page listing the pages they can open, grouped by module section, as a grid of icon + label tiles.
2. **Role-filtered navigation.** Every nav link and every Homepage tile is gated on the viewer's effective permissions. No visible link can bounce to `/no-access`.
3. **Top-bar chrome.** Brand, app name, Home, collapse toggle, identity and sign-out move to a persistent top bar; the sidebar becomes navigation only and starts collapsed.
4. **Close the two authorization gaps** found while mapping the nav: eight nav items that render for everyone, and an Accounts Settings guard that locks read-only users out of a page they're allowed to read.

Non-goals: no change to how permissions are granted, resolved, or seeded; no new permission name; no dashboard widgets, counts, or activity feed on the Homepage (it is a directory, not a dashboard).

---

## 2. What exists today (verified against the codebase — do not re-derive)

### 2.1 The chrome

- **`app/(app)/layout.tsx`** (async, `force-dynamic`) — resolves the collapse cookie, `getCurrentUserIdentity()`, `resolveEffectivePermissions(identity.userId)`, `getBrandingLogo()`, `getAppName()` and passes them to `<AdminSidebar>`. Renders `flex h-screen overflow-hidden` + `<aside>` + `<main class="flex-1 overflow-y-auto">`. **Runs no guard** — each child page guards itself.
- **`components/admin-sidebar.tsx`** (`"use client"`) — owns live `collapsed` state, writes the `sidebar_collapsed` cookie (`lib/sidebar.ts`; non-HttpOnly by design, 1 year, lax, "1"/"0" only). Header = `BrandLogo` + collapse toggle (stacked when collapsed). Body = `<AdminNav>`. Footer = identity strip (name + email, hidden when collapsed) + `<NavSignOutButton>`.
- **`components/admin-nav.tsx`** (`"use client"`) — `NAV_SECTIONS`, a hardcoded array of 5 sections / 17 items: `label`, `href`, `icon` (lucide), optional `requiredPermission: { name, level }`. Renders a locked `<span role="link" aria-disabled>` when the permission isn't met **or no map was passed**. The Accounts section carries `carriesAccountsContext: true`, appending a `?party&fa&ban` query built from the current URL via `parseAccountsContext` (fixed key order, `first()`-value semantics).
- **`components/brand-logo.tsx`** — pure, prop-driven; variants `"login" | "nav" | "nav-collapsed"`; required `appName`. **What it actually renders:** when `app_logo_path` in `system_config` holds a `/brand/...` path, an `<img>` on a light "plate" (white bg, 1px border, small padding) so one dark/full-colour asset sits legibly on both the white login card and the dark chrome; `nav-collapsed` uses the separate square `app_logo_mark_path` when set. When **no** logo is configured — **which is the shipped default: migration `0005` seeds `app_logo_path` as `''`** — it renders **text**: the app-name wordmark for `login`/`nav`, and for `nav-collapsed` a **monogram** built from the first letter of each of the first two words, uppercased and capped at two (`"Enterprise Billing System"` → `"EB"`). So out of the box the "logo" is a text wordmark, and the collapsed rail shows `EB`.
- **`components/nav-sign-out-button.tsx`** (`"use client"`) — the dark-chrome sign-out, separate from the light `components/sign-out-button.tsx` used on `/no-access`.
- **`--surface-topbar` (`#1B2A68`, primary-700) is defined in `ui-context.md` §3.1 and currently unused.** The sidebar uses `--surface-nav` (`#131D49`, primary-800). The token set already anticipates this exact layout: a lighter top bar over a darker sidebar.

### 2.2 The root redirect

- **`app/page.tsx`** (root, outside `(app)`, `force-dynamic`) — resolves the session; deletes stale sessions for a missing/`DISABLED`/`DELETED` user; lets `PENDING` through; resolves permissions unless `force_password_change`; calls `resolveRootRedirect(...)` and `redirect()`s. Renders nothing (`Promise<never>`). Deliberately does **not** use `auth/guard.ts` (redirect-loop risk on `force_password_change`, um06-spec §6.8).
- **`ROUTE_ORDER` is exported from that file and lists only the four administration routes.** A user whose roles grant, say, `billrun_view` but nothing under `/administration` therefore **lands on `/no-access` after a successful login.** This is the concrete bug the Homepage retires.
- **`lib/root-redirect.ts`** — the pure, tested extraction: `(session, permissionMap, routeOrder) → "/login" | "/set-password" | <first permitted route> | "/no-access"`. Five tests in `tests/lib/root-redirect.test.ts`.

### 2.3 Nav-declared permission vs. the page's actual guard — verified page by page

| Nav item | Route | Page guard (`requirePermission`) | Nav declares today | Status |
|---|---|---|---|---|
| View Product | `/products/product-offering` | `products` : READ | — | ❌ unguarded in nav |
| Manage Products | `/products/manage-products` | `products` : **EDIT** | — | ❌ unguarded in nav |
| Orders | `/products/orders` | `product_orders` : READ | — | ❌ unguarded in nav |
| Subscriptions | `/products/subscriptions` | `product_inventory` : READ | — | ❌ unguarded in nav |
| View Customer | `/customers/view` | `customers` : READ | `customers` : READ | ✅ |
| Manage Customer | `/customers/manage` | `customers` : EDIT | `customers` : EDIT | ✅ |
| Overview | `/accounts/overview` | `accounts_view` : READ | same | ✅ |
| Transactions | `/accounts/transactions` | `accounts_transactions` : READ | same | ✅ |
| Ledger Explorer | `/accounts/ledger` | `accounts_view` : READ | same | ✅ |
| Chart of Accounts | `/accounts/chart-of-accounts` | `accounts_config` : READ | same | ✅ |
| GL Journal | `/accounts/gl-journal` | `accounts_config` : READ | same | ✅ |
| Bill Runs | `/billing/bill-runs` | `billrun_view` : READ | same | ✅ |
| Users | `/administration/users` | `users` : READ | — | ❌ unguarded in nav |
| Roles | `/administration/roles` | `roles` : READ | — | ❌ unguarded in nav |
| System Configuration | `/administration/system-config` | `system_config` : READ | — | ❌ unguarded in nav |
| Audit Log | `/administration/audit-log` | `audit_log` : READ | — | ❌ unguarded in nav |
| Accounts Settings | `/administration/accounts-settings` | `accounts_config` : **EDIT** → **READ** (D7) | `accounts_config` : EDIT | ⚠️ corrected |

**Eight of seventeen nav items render for every signed-in user** and bounce to `/no-access` on click. Note **Manage Products requires `EDIT`, not `READ`** — the one item where the naive fix ("declare the module's permission at READ") would still leave a broken link.

**The Accounts Settings / flows gap (D7), in full:**

- `/administration/accounts-settings` guards on `accounts_config : EDIT`.
- `/administration/accounts-settings/flows` guards on `accounts_config : READ` and has no nav entry.
- The **only** link to `/flows` is the "Transaction Flows Reference" section at the bottom of the Accounts Settings page.
- ⇒ A `accounts_config : READ` user is allowed to read `/flows` but has no path to it. The page is effectively unreachable for exactly the role it was scoped for.
- The page's five mutation controls (`AddReasonCodeButton`, `ReasonCodeActions`, `AddBillCycleButton`, `BillCycleActions`, `WizardDefaultsForm`) take **no permission prop today** — they rely entirely on the page guard being EDIT. Their Server Actions, however, each independently call `requirePermission(ACCOUNTS_CONFIG, EDIT)`, so the enforcement boundary is already correct and lowering the page guard is not an escalation.

**Detail/child routes** (`/customers/view/[id]`, `/customers/manage/[id]`, `/customers/manage/new`, `/billing/bill-runs/[runId]`, `/billing/bill-runs/[runId]/approve`, and — after D7 — `/administration/accounts-settings/flows`) are reached from their parent pages and are **not** directory entries. They stay out of the registry; §6.3's second assertion keeps that deliberate rather than accidental.

### 2.4 `app_name` today

- Seeded by migration `0004` as `'Enterprise Billing System'`; `0005` set its `description` to *"Application display name — drives the sidebar/sign-in wordmark and browser tab titles. Kept to one line: long values are truncated with an ellipsis in the wordmark, so keep it short."* — **"short" is not a number**, which is what D12 fixes.
- Read by `getAppName()` (`React.cache`d; blank/whitespace → `DEFAULT_APP_NAME = "Enterprise Billing"`).
- Edited through `ConfigEditDialog` → `updateConfigAction` → `updateConfigValue`. Validation is `updateConfigValueSchema`, which is **generic across every config row**: `configValue: z.string().max(2000).nullable()`. It receives `configId` only — **not** the row's group/key — so it structurally cannot apply a per-key limit. Any per-key rule has to live after the row lookup, in the write service.
- `system_config.config_value` is plain `text` with no length CHECK; `0005` is an **applied migration** and per `ai-workflow-rules.md` §5.3 must never be edited — the description change is a new forward migration.

### 2.5 Constraints the change must not break

- **`tests/app/route-manifest.test.ts`** freezes the 27-route manifest and asserts set-equality in both directions against routes derived from `app/**/page.tsx`. Route-group segments are filtered out of the derived URL, so **moving `app/page.tsx` → `app/(app)/page.tsx` still derives `/`** and the manifest needs no edit. It also fails the build on any stale `(admin)` reference.
- **ESLint `boundaries/dependencies` is deny-by-default.** `lib/**` may import only `lib` and `types`. This is why the registry data lives in `lib/` and the lucide icons live in `components/` (§3.2).
- **`tests/components/admin-nav-accounts-context.test.tsx`** covers the `?party&fa&ban` threading; that behavior is carried over unchanged.
- Architecture **Inv. #3** and workflow-rules §7.4: the permission map in the chrome — and the new disabled-control logic in D7 — are **show/hide only**. Every page keeps its guard; every action keeps its re-check. Nothing here is an enforcement boundary.

---

## 3. Design

### 3.1 New — `lib/nav-registry.ts` (the single source of truth)

Pure data + one pure selector. No `next/*`, no `db/**`, no React, no lucide — so it imports only `types`, satisfies the `lib` boundary rule, and is testable in plain vitest.

```ts
import { meetsLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { PermissionName, PermissionType } from "@/types/rbac";

export interface NavPage {
  readonly label: string;
  readonly href: string;
  readonly permission: PermissionName;
  readonly level: PermissionType;
}

export interface NavSection {
  readonly caption: string;
  readonly items: readonly NavPage[];
  /** Accounts only: items carry the ?party&fa&ban selection (D7, um-era). */
  readonly carriesAccountsContext?: true;
}

export const NAV_REGISTRY: readonly NavSection[] = [ /* 5 sections, §2.3's table */ ];

/** Every href in the registry — exhaustive icon typing and the CI gate. */
export type NavHref = (typeof NAV_REGISTRY)[number]["items"][number]["href"];

/**
 * Show/hide only — never an enforcement boundary (Inv. #3).
 * Fail-closed: a null/undefined map yields no sections at all (D6).
 * Sections whose items are all filtered out are dropped entirely.
 */
export function visibleSections(
  map: EffectivePermissionMap | null | undefined,
): readonly NavSection[] {
  if (!map) return [];
  return NAV_REGISTRY
    .map((s) => ({ ...s, items: s.items.filter((i) => meetsLevel(map[i.permission], i.level)) }))
    .filter((s) => s.items.length > 0);
}
```

`permission` and `level` are **required, not optional** — "forgot to declare one" is a type error, not an unguarded link. The eight rows from §2.3 take the values in that table's third column, `Manage Products` at `EDIT` and `Accounts Settings` at `READ` per D7. **No `description` field** (D8).

### 3.2 New — `components/nav-icons.ts` (presentation, kept out of `lib/`)

```ts
export const NAV_ICONS: Record<NavHref, LucideIcon> = { /* … */ };
```

Keying by `NavHref` makes a missing or stale icon a **compile error**, so the two-file split cannot drift. The existing glyph choices and the reasoning comment atop `admin-nav.tsx` (why `ShieldHalf` not `ShieldCheck` — the filled shield-check is already the SSO badge; why `Building2` for View Customer vs `UserCog` for Manage Customer; why `PackagePlus` vs `Package`) move here verbatim: that rationale is about icons, and this is now the icons file.

### 3.3 Changed — `components/admin-nav.tsx`

- Reads `visibleSections(permissionMap)` instead of the local `NAV_SECTIONS`; resolves icons through `NAV_ICONS[item.href]`.
- **The entire locked-item branch is deleted** — the `locked` computation, the `<span role="link" aria-disabled>`, the `Lock` import, the `permissionResource` tooltip string, and the `hasLevel` import.
- Carried over unchanged: active-state matching (`pathname === href || startsWith(href + "/")`), `aria-current="page"`, the collapsed icon-rail geometry and its label fade (`max-width` + `opacity`, 200 ms), captions hidden when collapsed, and the accounts-context query threading.
- One behavior change beyond filtering: **the collapsed rail's divider count follows the number of *visible* sections**, not a fixed five.

### 3.4 New — `components/app-shell.tsx` (`"use client"`)

Collapse state is now shared by the top bar (which owns the toggle) and the sidebar (which reacts to it), so it moves up one level.

- Owns `collapsed` + the cookie write, seeded from the `defaultCollapsed` prop at `useState` init — the same no-`useEffect`-sync discipline `AdminSidebar` uses today, so SSR and first client render agree and `react-hooks/set-state-in-effect` stays satisfied.
- Renders `<AppTopBar …/>`, then a row of `<AdminSidebar collapsed …/>` + `<main>{children}</main>`.
- `children` is a server-rendered subtree passed **through** the client component as a prop — supported in the App Router, and the reason this doesn't turn every page into a client component.

### 3.5 New — `components/app-topbar.tsx`

**Page geometry (D13 — confirmed).** The top bar spans the **full viewport width and sits above everything**; the sidebar sits **beneath it**, on the left; page content fills the remainder:

```
┌──────────────────────────────────────────────────────────────────────┐
│ [LOGO] AppName  ⇤   ⌂ Home            Jane Tan · jane@ex.com  ⏻ Out  │  ← top bar, full width
├────────────┬─────────────────────────────────────────────────────────┤
│ ▣ Products │                                                         │
│ ▣ Customer │                  page content (<main>)                  │  ← sidebar under the
│ ▣ Accounts │                                                         │     top bar, on the left
│ ▣ Billing  │                                                         │
└────────────┴─────────────────────────────────────────────────────────┘
```

This is what `<div class="flex h-screen flex-col">` → `<AppTopBar/>` → `<div class="flex flex-1">` → `<aside/>` + `<main/>` produces (§3.9). The logo is the leftmost element in the bar and **never moves** — not when the sidebar collapses, not on any route. That permanence is the reason D10 could delete the `nav-collapsed` monogram: there is no longer a brand surface that changes shape.

Full-width, `--surface-topbar` (`#1B2A68`), `--text-on-brand` text, a `--color-primary-900` bottom hairline, ~56 px tall. Left to right:

| Slot | Content | Notes |
|---|---|---|
| **Brand (far left)** | `<BrandLogo variant="topbar" appName logo />` | **The leftmost element in the bar (D13).** The **only** brand surface in the authenticated app (D10). `max-w-[320px]`, `truncate` — sized against D12's 40-char cap (§3.13). Wrapped in `<Link href="/">` so the logo is also a route home, the standard affordance |
| Collapse toggle | `PanelLeftClose` / `PanelLeftOpen` | Moved from the sidebar header verbatim: same icons, same `aria-label`/`aria-expanded`, same hover token (`--color-primary-700`, never `--action-ghost-hover` — ui-context §8). Sits immediately right of the brand, so it stays over the sidebar it controls |
| Home | `<Link href="/">` + `Home` icon + "Home" | `aria-current="page"` when `pathname === "/"` |
| — | spacer | |
| Identity | `Jane Tan · jane.tan@example.com` (D11) | One line: name in `--text-on-brand`, a `·` separator in `--color-primary-300`, email in `--color-primary-300`. `min-w-0`, `truncate` on the email half |
| Sign out | `<NavSignOutButton />` | Reused as-is — already token-correct for dark chrome |

Narrow-width degradation, in order: the email half drops (name remains), then the "Home" text label (icon stays), then the brand wordmark. The toggle, Home icon, and sign-out never drop.

### 3.6 Changed — `components/admin-sidebar.tsx`

Becomes **controlled and navigation-only**. `collapsed` arrives as a prop; the `useState`, the cookie write, the toggle button, the header block (`BrandLogo` + toggle and its collapsed-stacking special case), the identity strip, and the footer `NavSignOutButton` are all removed — they live in the top bar now. What remains is the `<aside>` width transition (`w-64` / `w-16`, `motion-safe:` guarded) wrapping `<AdminNav>`.

### 3.7 Changed — `lib/sidebar.ts` + the layout: collapsed by default (D9)

The cookie semantics are unchanged ("1"/"0", 1 year, lax, non-HttpOnly). Only the **absent-cookie** default flips. Today: `cookies().get(SIDEBAR_COOKIE)?.value === "1"` — absent ⇒ expanded. New: absent ⇒ **collapsed**, i.e. `!== "0"`. Expressed as a named constant in `lib/sidebar.ts` (`DEFAULT_SIDEBAR_COLLAPSED = true`) plus a `resolveSidebarCollapsed(cookieValue)` helper, so the default is stated once and unit-testable, rather than living in a comparison operator in the layout.

### 3.8 Changed — `components/brand-logo.tsx`

- Add variant `"topbar"`: the `logo === null` branch renders the wordmark on dark chrome (same treatment as the outgoing `"nav"`); the logo branch uses the light plate with the `--text-on-brand`/15 border at `max-h-8`.
- **Delete `"nav-collapsed"` and its `Monogram` helper (D10)**, along with `monogramFor()` — the brand no longer changes with collapse state, so the monogram has no caller. `app_logo_mark_path` becomes unused by the app; the config row is left in place (removing a seeded row is a separate decision, not this change) and §7 records it.
- Delete `"nav"` too: with the brand out of the sidebar, `"login"` and `"topbar"` are the only variants. `tests/components/brand-logo.test.tsx` narrows accordingly.

### 3.9 Changed — `app/(app)/layout.tsx`

Same server-side resolutions, now passed to `<AppShell>`:

```tsx
<div className="flex h-screen flex-col overflow-hidden">
  <AppShell defaultCollapsed={resolveSidebarCollapsed(cookieValue)} identity={identity}
            permissionMap={permissionMap} logo={logo} appName={appName}>
    {children}
  </AppShell>
  <Toaster />
</div>
```

`generateMetadata` keeps returning `Administration — ${await getAppName()}`; `getAppName()` stays `React.cache`d, so the added consumer costs no extra read.

### 3.10 Moved and rewritten — `app/page.tsx` → `app/(app)/page.tsx` (the Homepage)

Server component, `force-dynamic`. The redirect preamble is carried over **verbatim** — it still cannot use `auth/guard.ts` for the same redirect-loop reason (um06-spec §6.8):

1. no session → `/login`
2. user missing / `DISABLED` / `DELETED` → delete session rows, `/login`
3. `force_password_change` → `/set-password` (`PENDING` still passes step 2)
4. otherwise resolve permissions and **render**

Then `const sections = visibleSections(permissionMap);`

**Layout — sections stack vertically, links spread horizontally within each (D8: icon + label only).**

```
PRODUCTS ──────────────────────────────────────────────────────────────
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│     ▣      │ │     ▣      │ │     ▣      │ │     ▣      │
│View Product│ │Manage Prod.│ │  Orders    │ │Subscript.  │
└────────────┘ └────────────┘ └────────────┘ └────────────┘

ACCOUNTS ──────────────────────────────────────────────────────────────
┌────────────┐ ┌────────────┐ ┌────────────┐
│     ▣      │ │     ▣      │ │     ▣      │      ← an accounts_view-only
│  Overview  │ │Transactions│ │   Ledger   │        user loses Chart of
└────────────┘ └────────────┘ └────────────┘        Accounts + GL Journal
```

- **Section header** — the registry `caption` in `--text-overline` (11 px, 600, +0.06em, uppercase) with a `--border-subtle` rule running to the right edge. A band, not a card.
- **Link row** — a fixed responsive column count: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`, `gap-4`. A four-link section fills the row exactly at `lg`, which is the shape you asked for; a section with fewer permitted links left-aligns at the **same tile size** rather than stretching. Chosen over `auto-fit`/`1fr` deliberately: with `auto-fit`, a section down to one permitted link would render a single tile stretched across the whole viewport, and tile size would differ section to section — distracting when a tile is just an icon and a word.
- **Tile** — a `<Link>` on `--surface-card`, `--radius-md`, `--border-default`, `--shadow-sm`; centred lucide icon at 24 px in `--color-primary-500` above the label at `--text-h4`; roughly square-ish (`aspect`-free, `py-6`). Hover: `--color-primary-50` wash + `--border-focus` border. Focus: `--focus-ring`. The whole tile is the hit target — one `<a>` per tile.
- **Filtering is per link, not per section.** A section renders as soon as it has ≥1 permitted link, with only those links. A section with zero permitted links is dropped entirely by `visibleSections` — header and all.
- **Zero sections** → a centred empty state: *"Your account doesn't have access to any modules yet. Contact an administrator."* This is the one place a `--gradient-brand` wash is permitted (ui-context §4 allows it for empty states). The user stays on `/`, signed in — **not** bounced to `/no-access`, which now serves only direct hits on a page the viewer lacks.
- Homepage tiles do **not** carry accounts context: `/` has no `?party&fa&ban` to thread. Noted so the omission doesn't read as a bug later.
- Above the sections: an `<h1>` "Home" and a `"Signed in as …"` line. No counts, no widgets (§1 non-goals).

### 3.11 Simplified — `lib/root-redirect.ts`

The `routeOrder` parameter and the `/no-access` fallback retire with `ROUTE_ORDER` (D3). The helper keeps the pure, testable part:

```ts
export function resolveRootRedirect(session: RootRedirectSession | null): string | null;
// null → render the Homepage
```

`RouteOrderEntry` and its export are deleted. Keeping the helper (rather than inlining three `if`s) preserves the um06-spec §6.10 testability rationale and keeps `tests/lib/root-redirect.test.ts` meaningful.

### 3.12 New — Accounts Settings at READ with disabled edit controls (D7)

- **`app/(app)/administration/accounts-settings/page.tsx`** — guard becomes `requirePermission(ACCOUNTS_CONFIG, LEVELS.READ)`, destructuring `{ permissionMap }` (the `system-config` and `roles` pages already use exactly this READ-guard + map-for-show/hide shape, so this is an established pattern, not a new one).
- **`canEdit = meetsLevel(permissionMap.accounts_config, "EDIT")`** is computed once on the page and threaded to the five controls as a single `canEdit: boolean` prop — not the whole map. A boolean is the narrowest thing that answers the question, and it keeps the components free of RBAC vocabulary.
- **`AddReasonCodeButton`, `ReasonCodeActions`, `AddBillCycleButton`, `BillCycleActions`, `WizardDefaultsForm`** each gain `canEdit`. When false: the trigger buttons render `disabled` with `--action-disabled-bg` and a `title` explaining why ("Requires accounts configuration edit access"); `WizardDefaultsForm`'s inputs render `readOnly` with its submit disabled. Disabled controls stay in the DOM rather than vanishing — the page is a settings *reference* for a READ user, and a missing button reads as a broken page where a greyed one reads as "not yours to change."
- **No action changes.** All five Server Actions already re-check `accounts_config : EDIT` and return `FORBIDDEN`; that is the enforcement boundary and it is untouched. §6.4 adds a matrix row proving a READ-only actor still gets `FORBIDDEN` from each action when the UI is bypassed.
- **`/administration/accounts-settings/flows` needs no registry entry** — with the parent now readable at READ, the "Transaction Flows Reference" link on it is a real path for every role allowed to read it. It goes in `UNLISTED_BY_DESIGN` with that reason.

### 3.13 New — `app_name` maximum length (D12)

**The number: 40 characters.** Derived from the binding surface, which after this change is the top bar, not the login card:

| Surface | Allowance | Fits at 14–16 px semibold |
|---|---|---|
| Top bar wordmark (§3.5) | `max-w-[320px]`, `text-sm` (14 px) | ~44 chars |
| Login / set-password / no-access card | `max-w-[440px]` − `p-8` = 376 px, `text-h4` (16 px) | ~45 chars |
| Browser tab `"Users — {appName}"` | ~60 chars total before the browser truncates | ~50 chars |

40 sits inside all three with headroom, so a compliant name never ellipsizes at ≥1280 px. `truncate` stays on every wordmark as the safety net for narrow viewports and for the pre-existing rows that were seeded before the cap.

**Three parts, all required — a documented limit nobody enforces is a suggestion:**

1. **Edit `0005_admin_chrome_config.sql` in place (D14 — one-time exception, granted in review).** Its final statement already `UPDATE`s the `app_name` description; only the string literal changes, to name the number:
   > `Application display name — drives the top-bar wordmark, the sign-in page and browser tab titles. Maximum 40 characters; longer values are truncated with an ellipsis in the top bar.`

   **Read §3.14 before doing this** — editing an applied migration has a specific, non-obvious consequence in this repo's migrator, and one extra step is needed to make existing environments match.
2. **`lib/config-limits.ts`** — `CONFIG_VALUE_MAX_LENGTH: Record<string, number>` keyed `"app:app_name" → 40`, with `APP_NAME_MAX_LENGTH = 40` exported for the components to use as an `<input maxLength>`. One constant, three consumers (the `0005` copy is checked against it by a test, §6.2).
3. **`services/system-config/system-config-write.service.ts`** — enforcement lands **here, not in the Zod schema**. `updateConfigValueSchema` receives only `configId`, so it structurally cannot know which key's limit applies (§2.4); the service already fetches the row (it checks `is_secret`), so it is the first place that knows the group and key. It adds a `VALUE_TOO_LONG` result carrying the limit, which `updateConfigAction` passes through and `ConfigEditDialog` renders as a field error. The generic `max(2000)` in the schema stays as the outer bound for every other row.
4. **`ConfigEditDialog`** — sets `maxLength={APP_NAME_MAX_LENGTH}` and shows a live "n/40" counter when editing the `app`/`app_name` row, so the limit is visible before submit rather than only on rejection.

Deliberately **not** a DB `CHECK` constraint: the limit is a presentation budget that may change when the chrome changes, and `system_config.config_value` is one shared `text` column across every config row — a per-key CHECK would encode a UI decision in the schema and need a migration every time the top bar is re-sized.

### 3.14 Editing `0005` in place — what actually happens (D14)

The one-time exception is granted, and for this row it is defensible: the `description` is **seed metadata**, not schema — nothing reads it but the admin UI's help text, so a stale value breaks nothing. But the mechanics are not what the repo's own docs say, and the difference decides whether the change is visible anywhere.

**`db/migrations/README.md` states: _"Never edit a migration that has already been applied anywhere (its hash is recorded; a changed file re-applies the whole thing)."_ That is wrong about this migrator, in the safe direction.** Drizzle's postgres-js migrator does not compare hashes. It reads the most recently applied row from `drizzle.__drizzle_migrations`, then applies a journal entry only when `entry.when > last_applied.created_at`. The hash is written but never verified. Concretely:

```js
const lastDbMigration = dbMigrations[0];
for (const migration of migrations) {
  if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { /* apply */ }
}
```

`0005`'s `when` is `1782...`, far below the last applied entry (`0038`, `when: 1788109629615`). So on any database where `0005` has already run, the edited file is **silently skipped** — not re-applied, not errored, not warned about.

**What this means in practice:**

| Environment | Effect of editing `0005` |
|---|---|
| A brand-new DB (`npm run db:setup` from empty) | ✅ Gets the new description — this is the path the README's install guide produces |
| Your current local dev DB | ❌ Keeps the old text until the volume is wiped and rebuilt |
| Test / staging / production | ❌ Keeps the old text indefinitely |

**So U6 carries one extra step:** a one-line statement, run once per already-migrated environment, to bring it level with what a fresh install now produces:

```sql
UPDATE core.system_config
   SET description = 'Application display name — drives the top-bar wordmark, the sign-in page and browser tab titles. Maximum 40 characters; longer values are truncated with an ellipsis in the top bar.'
 WHERE config_group = 'app' AND config_key = 'app_name';
```

This goes in the README's admin section (§9, item 4) as a documented one-off, not into a migration — putting it in a migration is precisely the forward migration the exception was granted to avoid.

**And `db/migrations/README.md` §4 must be corrected** in the same unit. Leaving "a changed file re-applies the whole thing" in place is worse after this change than before it: the next person to edit an applied migration will expect a re-apply, get a silent skip, and have no idea why their change didn't land. The corrected text should say that an edited applied migration is **skipped**, that the edit therefore reaches new databases only, and that this is why forward migrations remain the rule.

---

## 4. Delivery — seven units, in order

Per `ai-workflow-rules.md` §2.2 and §2.8, each ships green and alone.

| Unit | Scope | Ships green because |
|---|---|---|
| **U1 — registry + selector** | `lib/nav-registry.ts`, `components/nav-icons.ts`, tests, and the §6.3 CI gate. **No consumer changes.** | Purely additive; the gate proves the registry matches every page guard before anything depends on it |
| **U2 — Accounts Settings guard (D7)** | Page guard EDIT→READ; `canEdit` threaded to five components; matrix rows for READ-vs-EDIT. | Self-contained; **must land before U1's gate asserts `accounts_config : READ`** for that route |
| **U3 — nav reads the registry** | `admin-nav.tsx` consumes `visibleSections` + `NAV_ICONS`; locked branch deleted; nav tests rewritten. | Chrome-only; no route, guard or layout change. Where the eight unguarded links get fixed |
| **U4 — top bar + shell** | `app-shell.tsx`, `app-topbar.tsx`, `brand-logo.tsx` (topbar variant in, nav/nav-collapsed out), `admin-sidebar.tsx` slimmed, `lib/sidebar.ts` default flip (D9), `(app)/layout.tsx` restructured. | Pure chrome move; every page renders identically inside `<main>` |
| **U5 — Homepage** | `app/page.tsx` → `app/(app)/page.tsx`, rewritten; `lib/root-redirect.ts` simplified; `ROUTE_ORDER` deleted. | Route manifest unchanged (§2.5); redirect preamble carried over |
| **U6 — `app_name` cap (D12/D14)** | `0005` description edited in place, `lib/config-limits.ts`, write-service `VALUE_TOO_LONG`, `ConfigEditDialog` counter, the corrected `db/migrations/README.md` §4, and the one-off `UPDATE` documented in the app README. | Independent of the chrome work — can land any time after U4 fixes the wordmark's home |
| **U7 — sweep + docs** | Full route × level matrix re-run, `/no-access` reachability check, the §7 doc amendments. | Workflow-rules §6: a unit isn't done until the owning doc matches |

**Ordering constraint:** U2 before U1's gate is switched on (or the gate fails on the Accounts Settings row). U3 depends on U1. U4 and U5 are independent of each other; if U4 slips, U5 still ships inside the current sidebar-only shell. U6 is independent of everything except the §3.13 wordmark allowance.

---

## 5. Files touched

**New (5)**

- `lib/nav-registry.ts`
- `lib/config-limits.ts`
- `components/nav-icons.ts`
- `components/app-shell.tsx`
- `components/app-topbar.tsx`

_(No new migration — D14 edits `0005` in place instead. `meta/_journal.json` and `meta/0005_snapshot.json` are untouched: the change is a string literal in an `UPDATE`, not DDL, and snapshots capture schema, not data.)_

**Moved (1)**

- `app/page.tsx` → `app/(app)/page.tsx` (rewritten; `ROUTE_ORDER` deleted)

**Changed (15)**

- `db/migrations/0005_admin_chrome_config.sql` — ⚠️ applied migration, edited in place under the D14 exception; description string only
- `db/migrations/README.md` — §4's "a changed file re-applies the whole thing" corrected to "is silently skipped" (§3.14)
- `README.md` — install + admin rewrite (D15) and the D14 one-off `UPDATE`; specified in `_change-readme-install-and-admin-plan.md`

- `components/admin-nav.tsx` — registry-driven; locked branch removed
- `components/admin-sidebar.tsx` — controlled, nav-only
- `components/brand-logo.tsx` — `"topbar"` in; `"nav"`, `"nav-collapsed"`, `Monogram`, `monogramFor` out
- `components/system-config/config-edit-dialog.tsx` — `maxLength` + counter + `VALUE_TOO_LONG` error
- `components/accounts/reason-code-form.tsx` — `canEdit`
- `components/accounts/bill-cycle-form.tsx` — `canEdit`
- `components/accounts/wizard-defaults-form.tsx` — `canEdit`
- `app/(app)/layout.tsx` — renders `<AppShell>`
- `app/(app)/administration/accounts-settings/page.tsx` — READ guard + `canEdit`
- `lib/sidebar.ts` — `DEFAULT_SIDEBAR_COLLAPSED` + `resolveSidebarCollapsed`
- `lib/root-redirect.ts` — `routeOrder` retired
- `services/system-config/system-config-write.service.ts` — per-key length check

**Unchanged but load-bearing** — `auth/guard.ts`, `auth/resolver.ts`, `auth/permission-constants.ts`, `types/permissions.ts`, `types/rbac.ts`, `components/nav-sign-out-button.tsx`, `validation/update-config.schema.ts`, all five `actions/accounts/*` mutation actions, and **every other `app/(app)/**/page.tsx` guard**. Apart from Accounts Settings (D7, deliberate), **no page's `requirePermission` call is edited.**

---

## 6. Testing

### 6.1 Rewritten existing suites

- **`tests/components/admin-nav.test.tsx`** — the four locked-item cases are replaced by **absence** assertions: `queryByText("Manage Customer")` is `null`; nothing carries `aria-disabled`; no `Lock` glyph. The three "renders as a real, unlocked link even with no permissionMap prop at all" cases **invert** under D6: no map ⇒ nothing renders. Active-state, caption-order and collapsed-rail cases survive with counts driven by the visible set rather than a literal "eight links".
- **`tests/components/admin-sidebar.test.tsx`** — the four collapse-toggle cases and the two `appName` cases move to `tests/components/app-topbar.test.tsx` / `app-shell.test.tsx`; what stays asserts the `<aside>` width class from the `collapsed` prop.
- **`tests/app/admin-layout.test.tsx`** — footer identity/sign-out cases become top-bar cases; "still renders all four admin nav links" becomes permission-scoped.
- **`tests/lib/root-redirect.test.ts`** — "no session → /login" and "force_password_change → /set-password" survive; the ADMIN and no-grants cases become "returns `null` (render the Homepage)".
- **`tests/components/brand-logo.test.tsx`** — narrowed to `"login"` + `"topbar"`; the monogram cases are deleted with the variant (D10).
- **`tests/accounts/route-level-accounts-settings.test.ts`** — the existing EDIT-only matrix is **rewritten** for D7: READ renders the page, EDIT renders it with controls live, no-grant still redirects.

### 6.2 New suites

- **`tests/lib/nav-registry.test.ts`** — `visibleSections` against the four seeded role shapes (ADMIN, MANAGER, USER, BILLING_VIEWER): exact expected hrefs per role; `null`/`undefined` map ⇒ `[]` (D6); a section with every item filtered out is dropped, not rendered empty; `EDIT`-level entries excluded for a READ-only grant (the Manage Products case); `DELETE ⊃ EDIT ⊃ READ` still admits.
- **`tests/app/home-page.test.tsx`** — the permitted set for a MANAGER-shaped map; nothing from a section the map doesn't reach; **a partially-permitted section renders its header plus only its permitted tiles** (the `accounts_view`-without-`accounts_config` case); section order matches registry order; every tile is a real `<a href>` (no `aria-disabled` on the page); the zero-grant empty state; redirect-preamble parity (no session, non-ACTIVE, `force_password_change`).
- **`tests/components/app-topbar.test.tsx`** — brand + `appName`; Home link and its `aria-current`; the `name · email` identity line (D11); sign-out present; toggle `aria-expanded` + cookie write.
- **`tests/lib/sidebar.test.ts`** — `resolveSidebarCollapsed`: absent ⇒ collapsed (D9); `"0"` ⇒ expanded; `"1"` ⇒ collapsed.
- **`tests/components/accounts-settings-can-edit.test.tsx`** — each of the five controls renders disabled at `canEdit={false}` and live at `true`.
- **`tests/services/system-config-write.length.test.ts`** — a 41-char `app_name` is rejected with `VALUE_TOO_LONG`; 40 is accepted; a non-`app_name` row of the same length is unaffected; **`0005_admin_chrome_config.sql`'s description text contains the same number as `APP_NAME_MAX_LENGTH`** (so the copy and the constant can't drift — the file is read from disk, the way `route-manifest.test.ts` reads `app/**`).
- **`tests/db/migration.integration.test.ts`** (existing) — add an assertion that a freshly-migrated database's `app`/`app_name` row carries the 40-character description, which is the only automated proof the D14 in-place edit actually took effect on the path it can reach.

### 6.3 The CI gate — `tests/guardrails/nav-registry-guard.test.ts`

The load-bearing new test, in the style of `tests/app/route-manifest.test.ts` and `tests/accounts/grep-gates.test.ts`:

1. **Registry ↔ page-guard parity.** For each `NAV_REGISTRY` entry, read `app/(app)<href>/page.tsx`, extract its `requirePermission(PERMISSIONS.X, LEVELS.Y)` call, assert the name/level **equal** the registry's. Catches the §2.3 class of drift permanently; a page with no `requirePermission` at all fails outright (Inv. #4).
2. **No accidental orphans.** Every non-dynamic page under `app/(app)/**` is either in the registry or in an explicit `UNLISTED_BY_DESIGN` set — the detail/child routes plus `/administration/accounts-settings/flows` — each with a one-line reason. Adding a page without a decision fails the build.
3. **Icon exhaustiveness.** `Object.keys(NAV_ICONS)` set-equals the registry hrefs. (Belt-and-suspenders: `Record<NavHref, LucideIcon>` already makes this a type error.)
4. **No locked-item residue.** No `aria-disabled` and no `Lock` import remains in `components/admin-nav.tsx`, so D2 can't be quietly reverted.

### 6.4 Route × level matrix (U7)

Re-run every existing per-route matrix unchanged — **identical results are the §2.8 proof** that authz behavior didn't move. New rows:

- `/` renders for any ACTIVE user and never redirects to `/no-access`.
- `/no-access` is still reached by a direct hit on an unpermitted page.
- `/administration/accounts-settings` renders at `accounts_config : READ` (D7).
- Each of the five accounts-settings Server Actions returns `FORBIDDEN` for a READ-only actor **with the UI bypassed** — the assertion that makes the greyed buttons cosmetic rather than load-bearing.

### 6.5 Manual / e2e

Sign in as each seeded role (ADMIN, MANAGER, USER, BILLING_VIEWER) and confirm: the Homepage lists exactly that role's pages; the sidebar matches the Homepage exactly; every visible link lands on a rendered page; a fresh browser profile starts with the sidebar **collapsed** (D9) and an explicit expand survives a full reload; a 40-char `app_name` renders without ellipsis at 1280 px and a 41-char one is rejected at save.

---

## 7. Documentation updates required (part of the change, not a follow-up)

1. **`context/architecture.md` §2, `components/**` row — must be amended.** It currently reads: *"nav items render regardless of permission — the page guard enforces access. Any future hide-without-permission behavior applies platform-wide, never per module."* D2 **is** that platform-wide behavior. Rewrite: navigation is built from the shared `NAV_REGISTRY`; items render only when effective permissions meet the entry's `permission : level`; the page guard remains the enforcement boundary and the nav filter is show/hide only.
2. **`context/architecture.md` §5, "Per-page access declaration"** — add `/` to the named session-gated exceptions alongside `/login`, `/set-password`, `/no-access` (D5), with its one-line reason.
3. **`context/architecture.md` §2, `lib/**` row** — `lib/` now also owns the navigation registry (a routing-policy peer of `root-redirect.ts`) and the config value limits; its presentation half lives in `components/nav-icons.ts` because of the boundary rule.
4. **`context/user-management/usrmgmt-architecture.md`** — permission map gains a `/` row; `ROUTE_ORDER` marked retired; the `/administration/accounts-settings` row changes **EDIT → READ** with the D7 reason and a note that its mutations remain EDIT at the action layer.
5. **`context/accounting-management/acctmgmt-ui-context.md`** (and the `ac15` spec's permission line) — record the Accounts Settings READ-with-disabled-controls pattern.
6. **`context/ui-context.md`** — `--surface-topbar` is now in use by the app top bar (it was defined but unused); `--surface-nav` is sidebar-only; add the `app_name` 40-character budget to the typography notes so a future chrome change re-derives it rather than guessing.
7. **`AGENTS.md` (codebase root)** — the "Change Configuration" read-order block points at `_change-dynamic-app-name-plan.md`; add this plan when work starts.
8. **`ai-workflow-rules.md` §7.6** — "add a new page only with its full mapping" gains two items: a `NAV_REGISTRY` entry and a `NAV_ICONS` glyph.
9. **Note the orphaned config row** — `app_logo_mark_path` loses its only consumer when `"nav-collapsed"` is deleted (D10). The row stays; record it as unused pending a decision, so nobody wires it back to a variant that no longer exists.

---

## 8. Open questions

**None outstanding.** Q1–Q5 from rev. 1 are resolved as D7–D11 above. Two items are recorded as deliberate deferrals rather than questions:

- **`app_logo_mark_path`** is now an unused config row (§7.9). Retiring a seeded row is its own decision and is not in this change.
- **A DB `CHECK` on `app_name` length** is deliberately not added (§3.13, final paragraph) — the limit is a presentation budget on a column shared by every config row.
