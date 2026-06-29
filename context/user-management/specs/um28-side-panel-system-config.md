# Spec: um28 — Side Panel & System Config

- **Boundary:** FRONTEND & BACKEND
- **Builds:** a collapsible left admin panel (icon-rail ↔ full width, persisted), a configurable company logo on the login page + sidebar header, five new editable `system_config` rows, a new read-only `description` column on `core.system_config`, and the locale/currency thread-through that makes date/money formatting configuration-driven.
- **Visible result:** The left panel can be collapsed to a narrow icon rail and restored to full width, and the choice survives a full page reload with no flash. The login page and sidebar header show an admin-configurable company logo (or fall back to the "Enterprise Billing" wordmark). The System Configuration page shows five new rows (Locale, Default Currency, Company Name, Company Address, Company Billing PIC), each annotated with a seeded description shown as a sublabel under its key; setting Locale / Default Currency changes how dates and money render across the admin pages.
- **Source:** `_change-admin-chrome-branding-plan.md` (whole doc — this unit ships the combined plan in full, _including_ the configurable logo and the locale/currency wiring); `usrmgmt-architecture.md` §2 (folder ownership — `app/(admin)`, `components/`, `services/`, `db/`, `lib/`, `types/`), §3 (`core.system_config` non-secret config; `is_secret` always FALSE), §4 (one core schema, one Drizzle migration history, no manual prod DDL), §6 (`system_config:READ`/`EDIT` gate the System Configuration page); `usrmgmt-ui-context.md` §0/§2.1 (nav chrome on `--surface-nav`, marketing gradients reserved for `/login` + `/no-access`), token table (`--color-primary-*`, `--text-on-brand`, `--surface-selected`, `--focus-ring`).
- **Decisions taken (sign-off, 2026-06-28):** **logo IS in scope** (full branding plan); **locale/currency wired now** (formatter thread-through, not store-only); **all five config rows** seeded; **the additive `description` column** added (the unit's only schema change). Logo value constrained to committed `/brand/...` paths (no arbitrary URLs); plain `<img>` (not `next/image`); collapse state persisted via a non-`HttpOnly` `sidebar_collapsed` cookie; default collapse state on first visit = **expanded**; Locale/Default Currency constrained to curated allow-lists in the read path (not free text), seeded `en-MY` / `MYR`; the three company rows are stored for later billing/invoice modules; `timeZone: "UTC"` stays hardcoded (display timezone deferred to `_change-system-timezone-plan.md`).

> This unit replaces the admin chrome's inline `<aside>` and the login wordmark with shared, prop-driven components, and turns `core.system_config` into the source of the chrome branding and the app's locale/currency. It ships as **one unit** because the sidebar collapse toggle and the logo share the sidebar header block — splitting them forces a merge conflict on `app/(admin)/layout.tsx` and two rounds of config seeds. **Not in this unit:** display timezone (the `APP_TIMEZONE` env var, a `formatDatetime` timezone parameter, and the audit-log UTC-day-boundary fix are deferred to `_change-system-timezone-plan.md`); upload/blob logo infra (logo bytes are committed assets); editable descriptions (descriptions are seeded read-only documentation); any new RBAC permission, audit event, or Server Action (the existing `system_config:EDIT`-gated `ConfigEditDialog` already edits the new rows).

---

## 1. Goal

Make the admin chrome collapsible and brandable, and make locale/currency configurable, with no new runtime dependency and exactly one additive nullable schema column. Concretely: (1) extract the sidebar into a `"use client"` component that owns a `collapsed` flag, toggles `w-64` ↔ `w-16`, and persists the choice in a cookie the Server Component layout reads back on reload; (2) render a company logo — selected by a `system_config` row pointing at a committed `/brand/...` asset — on the login page and the sidebar header, falling back to the existing wordmark when unset or invalid; (3) seed five editable `system_config` rows and add a nullable `description` column surfaced read-only on the System Configuration page; (4) thread a resolved locale (and a currency for `formatMoney`) from the server through `lib/formatters.ts` so date/money output is configuration-driven while the formatters stay pure.

---

## 2. Design

### 2.1 The shared sidebar header — built once

The sidebar header block hosts **both** the logo (left) and the collapse toggle (right). Building it in two places would conflict, so the whole `<aside>` currently inlined in `app/(admin)/layout.tsx` is extracted into one `"use client"` component, `AdminSidebar`, which renders the header, nav, and footer and switches between an expanded and a collapsed layout from a single `collapsed` flag.

| State              | `<aside>` width | Header                                                              | Nav items                                                           | Footer                                                   |
| ------------------ | --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| Expanded (default) | `w-64`          | logo (plated, §2.3) on the left + toggle on the right, in a row     | icon + label; active = left-border treatment                        | name/email + sign-out label                              |
| Collapsed          | `w-16`          | **vertical stack**: logo _mark_ (plated) above, toggle below (§2.4) | icon centered in a light active-square (§2.5), `aria-label`/`title` | sign-out **icon only** (no identity strip — by decision) |

**Collapsed header is a vertical stack, not a row.** 64px minus padding can't comfortably hold the mark and the toggle side-by-side, so the collapsed header stacks them (mark on top, toggle beneath). If even the stack feels tight against the mark, fall back to **toggle-only** in the collapsed rail — the expand affordance is the only control that must be reachable there; the mark is decorative when collapsed.

Width transition: `motion-safe:transition-[width] duration-200 ease-in-out` on `<aside>` (respects reduced motion); the sibling `<main className="flex-1 ...">` reflows automatically. **Labels fade with the width**, not pop: nav labels live in the DOM and animate `opacity` (+ `overflow-hidden` on the rail) in step with the 200ms width transition, rather than being conditionally unmounted — otherwise React swaps `icon` ↔ `icon+label` instantly while the rail is still mid-animation and the text reflows visibly. The existing `<Toaster />` in the layout is untouched.

### 2.2 Client/server boundary — the crux (architecture §2)

The sidebar must own _live_ collapse state → it is `"use client"`. But the logo needs a _server-side_ DB read of `system_config`, and a client component cannot call an async server data function. **Resolution:** every read stays in the **server** layout; the resolved, plain-serializable values are passed as **props** into `AdminSidebar`. This keeps DB access in `db/**` behind a `services/**` reader (architecture Inv. #14 — UI never imports the DB client) and keeps the boundary clean.

```tsx
// app/(admin)/layout.tsx (server, already async + force-dynamic)
const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
const identity = await getCurrentUserIdentity(); // existing auth/ helper
const logo = await getBrandingLogo(); // new services/ reader

return (
  <div className="flex h-screen overflow-hidden">
    <AdminSidebar
      defaultCollapsed={collapsed}
      identity={identity}
      logo={logo}
    />
    <main className="flex-1 overflow-y-auto bg-background">{children}</main>
    <Toaster />
  </div>
);
```

`cookies()` is awaited (Next async API); the layout is already `async` + `force-dynamic`, so the branding read already runs per request.

### 2.3 `BrandLogo` — pure presentational, shared by both trees

`components/brand-logo.tsx` is **not** `"use client"`, has **no async, no DB**. Props: `logo: BrandingLogo | null` and `variant: "login" | "nav" | "nav-collapsed"`. It renders a plain `<img>` when `logo` is present, else the existing text wordmark. Because it is prop-driven and side-effect-free, it renders identically inside the **client** `AdminSidebar` tree and the **server** login page tree — the `system_config` read lives only in the server reader (§2.6), never here.

**Single asset on a logo plate (resolves the two-surface contrast problem).** The login lockup sits on a **white** card (`--surface-card`) while the sidebar sits on **dark navy** (`--surface-nav`), so one bare logo can't have guaranteed contrast on both. Rather than ship two assets, `BrandLogo` wraps the `<img>` in a **plate**: a consistent light background (`bg-[color:var(--surface-card)]`), `--radius-sm`, a 1px demarcation **border**, and small padding — so a single (dark or full-color) logo always sits on a known light backdrop and reads on both surfaces. Border token by surface: `--border-default` on the white login card (a clean hairline frame), and `border-[color:var(--text-on-brand)]/15` (a faint light rule) for the plated chip on the dark nav. The plate is the deliberate, common "logo chip in dark chrome" look; it also frames the login logo cleanly on white. (If real artwork later ships as a proper on-dark reversed mark, the plate can be dropped per-variant — but that's not needed now.)

- Login: `<BrandLogo variant="login" logo={logo} />` → `max-h-12 w-auto`, centered, replaces the `<span className="text-h4 font-semibold text-foreground">Enterprise Billing</span>` lockup.
- Sidebar expanded: `<BrandLogo variant="nav" logo={logo} />` → `max-h-8 w-auto`.
- Sidebar collapsed: `<BrandLogo variant="nav-collapsed" logo={logo} />` → uses `markSrc` if present, else a monogram/text fallback that fits the `w-16` rail.

Plain `<img>` is chosen over `next/image`: `next/image` blocks SVG optimization unless `dangerouslyAllowSVG` is set (a CSP concern), and the optimizer buys nothing for a local `/public` SVG. This keeps `next.config.ts` untouched.

### 2.4 `AdminSidebar` — owns collapse state (the merge point)

`components/admin-sidebar.tsx` (`"use client"`). Props: `defaultCollapsed: boolean`, `identity: { userName: string; userEmail: string } | null`, `logo: BrandingLogo | null`. State is seeded **at `useState` init from the prop** — never synced via `useEffect` — so SSR and first client render agree (no hydration mismatch) and the enforced `react-hooks/set-state-in-effect` rule is satisfied:

```tsx
const [collapsed, setCollapsed] = useState(defaultCollapsed);

function toggle() {
  const next = !collapsed;
  setCollapsed(next); // instant, local
  document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
}
```

No Server Action for the toggle: a network round-trip for a cosmetic flag would be laggy. App-Router layouts persist across client navigation, so collapse state already survives in-app nav in memory; the cookie only restores it on a **full reload**. The cookie is intentionally **not** `HttpOnly` (JS must write it) and carries no sensitive data.

`SIDEBAR_COOKIE` is a single shared constant (e.g. `lib/sidebar.ts`, `export const SIDEBAR_COOKIE = "sidebar_collapsed"`) imported by both the server read and the client write so the name can't drift.

### 2.5 Nav icons + collapsed rail (`AdminNav`)

`NAV_ITEMS` gains an `icon` per row: Users → `Users`, **Roles → `ShieldHalf`**, System Configuration → `Settings`, Audit Log → `ScrollText`. The toggle button uses `PanelLeftClose` / `PanelLeftOpen`. `AdminNav` takes a `collapsed` prop.

> **Roles icon — avoid the badge collision.** The design system already assigns the filled **`shield-check`** glyph to the **`SSO` `AuthMethodBadge`** (ui-context §3.5), so reusing `ShieldCheck` for the Roles nav would make one glyph mean two things (SSO vs Roles). Use **`ShieldHalf`** instead — it stays in the shield/authority family (right for RBAC) while being visually distinct from the SSO badge. (`Settings` for System Configuration is intentionally kept — it already matches the icon `ConfigTable`'s empty state uses; `Key`/`KeyRound` is avoided because `key` is the `LOCAL` auth-method badge glyph.) **Verify `ShieldHalf` is present in the pinned `lucide-react` before use; if absent, fall back to `UserCog`** (users + gear = role administration), which is also collision-free.

- **Expanded:** icon + label; the existing active treatment is unchanged — `border-l-[3px]`, active `border-[color:var(--color-primary-200)] bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]`, inactive `text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]`, `aria-current="page"` via `usePathname().startsWith`.
- **Collapsed — explicit active treatment (the expanded idiom doesn't translate).** The expanded active state is a full-width light pill with a 3px **left** border; on a 64px rail with a centered icon that left-border accent fights the centered geometry. So collapsed active renders as a **centered light square**: `bg-[color:var(--surface-selected)]` + `--radius-sm`, the icon centered inside it in `--text-primary`, and the `border-l-[3px]` left-accent **dropped**. Inactive icons are `text-[color:var(--text-on-brand)]` with `hover:bg-[color:var(--action-ghost-hover)]`. The link keeps an accessible name via `title` + `aria-label`; the "Administration" caption (`<span>…Administration</span>`) is hidden.

> **Considered — stacked mini-label (a "second row" under the icon).** An alternative to icon-only-with-`title` is a two-line item: icon on top, a tiny `--text-overline` label beneath (improves discoverability without relying on the native `title`, since no Tooltip primitive exists). It's noted as an option, **not** adopted by default, because the longest label ("System Configuration") won't fit a 64px rail without an abbreviation ("Config") — which introduces a label-mismatch between expanded and collapsed. If adopted, define the abbreviated labels in `NAV_ITEMS` (e.g. `shortLabel`) rather than truncating at render.

`components/nav-sign-out-button.tsx` gains an optional `collapsed`/`iconOnly` prop → renders `LogOut` icon only + `title` when collapsed.

### 2.6 Branding read path (`services/` + `db/`)

1. **Repository** (`db/repositories/system-config.repository.ts`): add `findActiveValue(db, group, key): Promise<string | null>` — selects `config_value` where `(config_group, config_key)` match, `status = 'ACTIVE'`, `is_secret = false`, **`ORDER BY config_version DESC LIMIT 1`**. (The existing repo has only `findAllNonSecret`, `findById`, `updateValue` — no "one ACTIVE value by group+key" path.) **The `ORDER BY` is load-bearing, not cosmetic:** the unique index is `(config_group, config_version, config_key)`, so two **ACTIVE** rows for the same `(group, key)` at different versions can legally coexist. Without a deterministic order the returned row is nondeterministic; `config_version DESC` makes "latest active version wins" explicit. (All current seeds are `config_version = 1`, so this is forward-hardening, not a present bug.)
2. **Service** (`services/system-config/app-config-read.service.ts`, **new**): `getBrandingLogo()` — reads `app/app_logo_path` (+ `app/app_logo_mark_path` if used) and `app/app_name` (for `alt`); **validates** each path is a same-origin `/brand/...` string (must start with `/brand/`; reject any scheme, leading `//`, or `..`); returns `{ src, markSrc?, alt } | null` (`null` ⇒ wordmark). Wrapped in `React.cache` so the layout and any child dedupe within a request.
3. **Consumers:** `app/(auth)/login/page.tsx` and `app/(admin)/layout.tsx` call it server-side and pass the result down as the `logo` prop.

Why `/brand/`-only: the value renders into an `<img src>` on the **unauthenticated** login page, so an external / `data:` / `javascript:` value would be a stored-injection + visitor-IP-leak vector. A `/brand/`-only check closes it with one guard and needs no `next.config.ts` / CSP / `images.remotePatterns` change. A true paste-any-URL experience, if ever wanted, is the upload+blob path — out of scope.

### 2.7 New config rows (architecture §3 — non-secret, `is_secret = FALSE`)

Seed five new **non-secret, ACTIVE** rows. `locale`/`default_currency` live in the existing `app` group (application behavior); the three company-identity rows live in a **new `company` group** (keeps them grouped on the page and distinct from `app_name`, which is the _application_ name, not the operating company). All are editable in place via the existing `system_config:EDIT`-gated `ConfigEditDialog` — no per-key UI change.

| group     | key                   | seed value   | type                                                                  | consumed by                           |
| --------- | --------------------- | ------------ | --------------------------------------------------------------------- | ------------------------------------- |
| `app`     | `locale`              | `en-MY`      | BCP-47 tag, **allow-list**                                            | date/number formatting **now** (§2.9) |
| `app`     | `default_currency`    | `MYR`        | ISO-4217 code, **allow-list**                                         | money formatting **now** (§2.9)       |
| `company` | `company_name`        | `""` (blank) | text                                                                  | later billing/invoice docs            |
| `company` | `company_address`     | `""` (blank) | text (multi-line ok — dialog is a `Textarea`)                         | later billing/invoice docs            |
| `company` | `company_billing_pic` | `""` (blank) | **single free-text** contact blob (name + email + phone in one field) | later billing/invoice docs            |

Blank company values render as the existing "—" empty treatment in `ConfigTable`.

Also seed `app/app_logo_path` (blank by default ⇒ wordmark) so the logo is admin-editable from the page after deploy. (`app/app_name` already exists from `0004` and is reused for `alt`.)

### 2.8 Curated allow-lists (Locale + Default Currency)

`ConfigEditDialog` is a generic `Textarea` (value-only, `max(2000)`), so it cannot offer a dropdown without a per-key UI change (out of scope). Enforcement therefore lives in the **read path**: the stored string is validated against a curated constant and falls back to a default. Define both lists in a new `lib/locale.ts` (framework-agnostic, importable server + client like `lib/formatters.ts`):

```ts
export const SUPPORTED_LOCALES = [
  "en-MY",
  "ms-MY",
  "en-SG",
  "en-GB",
  "en-US",
] as const;
export const DEFAULT_LOCALE = "en-GB"; // matches today's hardcoded formatter output
export const SUPPORTED_CURRENCIES = [
  "MYR",
  "SGD",
  "USD",
  "EUR",
  "GBP",
] as const;
export const DEFAULT_CURRENCY = "MYR";
```

Why a curated list, not "any Intl-valid tag": locale here drives **`Intl` date/number/currency formatting only — not UI translation** (the app has no message catalogs). An open list would let an admin pick, say, `ja-JP` expecting Japanese text and get only reformatted numbers. The seeded `en-MY` formats dates identically to the `en-GB` code default, so behavior is unchanged until an admin chooses otherwise. Extend the constants as the carrier's footprint grows — a one-line edit, no migration.

### 2.9 Wiring into formatting (`lib/formatters.ts` — the non-trivial part)

`lib/formatters.ts` is pure and currently hardcodes `en-GB` + `timeZone: "UTC"` in `formatDatetime`. To make locale/currency configurable **without breaking that purity**:

1. **Resolve once, server-side.** Add `getAppLocale()` + `getAppCurrency()` to the new `services/system-config/app-config-read.service.ts` (alongside `getBrandingLogo`, all `React.cache`d). Each reads its `app`-group value via `findActiveValue`, checks the allow-list (§2.8), and falls back to `DEFAULT_LOCALE` / `DEFAULT_CURRENCY` on blank/unknown.
2. **Thread as parameters.** `formatDatetime(date, fallback?)` → `formatDatetime(date, locale, fallback?)`. **`timeZone: "UTC"` stays hardcoded** (display timezone deferred). Add `formatMoney(amount, locale, currency)`. Formatters stay pure — they receive locale/currency, never read config.
3. **Pass from call sites — all four date components are `"use client"`.** The four current `formatDatetime` callers — `components/users/user-table.tsx`, `components/users/user-detail.tsx`, `components/roles/role-table.tsx`, `components/roles/role-detail.tsx` — are **all client components**, so they **cannot** call the server-side `getAppLocale()` themselves. Locale is therefore threaded strictly as a **prop**: see §3.5 for the exact server-page → client-component path. The required-param signature change force-updates every caller, so none is missed. `formatMoney` has **no callers yet** (no money is displayed in the current admin module) — it ships ready for billing, unit-tested only.
4. **Update determinism tests.** Tests asserting fixed `en-GB` strings assert against the passed locale / default constant instead.

**`formatMoney` exact output (verified at runtime — do not re-derive):** `Intl.NumberFormat` separates the currency symbol from the amount with a **non-breaking space (U+00A0)**, not an ASCII space — so `formatMoney(1234.56, "en-MY", "MYR")` produces `"RM 1,234.56"` (rendered "RM 1,234.56"), and `formatMoney(1234.56, "en-US", "USD")` produces `"$1,234.56"` (no separator). The unit test **must** account for the NBSP — assert the exact codepoint, or normalize with `.replace(/ /g, " ")` before comparing. A naïve `toBe("RM1,234.56")` or even `toBe("RM 1,234.56")` (ASCII space) will fail. This is the single most likely place a test author loses time.

**`formatDatetime` signature is back-compatible (verified):** all eight existing call sites pass a single argument (`formatDatetime(x.field)`); none passes a positional `fallback`. Inserting `locale` as the 2nd positional parameter (before the optional `fallback`) therefore can't silently slide an existing fallback string into the `locale` slot.

> **Note vs. the source plan:** the plan listed `ConfigTable`'s "Last Modified" as a `formatDatetime` caller. It is **not** — `ConfigTable` uses `formatRelativeTime` (a relative formatter that takes no locale). So the "Last Modified" column needs no change. The accurate `formatDatetime` caller set is the four components above.

**Cost & risk:** the locale thread-through is the only change that fans out beyond the chrome (the `formatDatetime` signature + its four call sites). Mechanical but broad. The `en-GB` default makes a missing/blank `locale` row reproduce today's output exactly, so the change is behavior-preserving until an admin sets a value. `formatMoney` adds no fan-out now.

### 2.10 `system_config.description` column (the unit's only schema change)

Add a nullable `description` text column to `core.system_config` so every config row can explain what its value does, shown read-only on the page.

- **Schema** (`db/schema/system-config.ts`): add `description: text("description")` — **nullable** (no `.notNull()`), so existing/secret rows without a description are fine. This is the only schema change in the unit.
- **Repository:** add `description: systemConfig.description` to the `select({...})` projections in `findAllNonSecret` **and** `findById`. (`findActiveValue` returns only the value and doesn't need it.)
- **Type** (`types/system-config.ts`): add `description: string | null` to `SystemConfigDisplayRow`. Also add a `BrandingLogo` type (`{ src: string; markSrc?: string; alt: string }`) used by the reader, `BrandLogo`, and `AdminSidebar`.
- **UI — render as a sublabel under the key, NOT a new column** (`components/system-config/config-table.tsx`): the System Configuration table is already four dense columns (Key, Value, Status, Last Modified). Adding a fifth long-text column would force Status + Last Modified rightward and truncate docs behind a native `title` (no Tooltip primitive exists, per um18 — low discoverability). Instead, render `description` as **muted helper text on a second line inside the existing Key cell** — `--text-muted` at `--text-caption` size beneath the mono `configKey`. This keeps the table at four columns, shows the full description without truncation, and reads as documentation attached to its key. **The group-header `colSpan` stays `canEdit ? 5 : 4` (unchanged) — no column is added.** Blank description ⇒ render nothing (no "—" placeholder; the key simply has no sublabel). `ConfigEditDialog` is **not** changed (it still edits only the value) — descriptions are seeded documentation, not admin-authored (there is no "add config row" feature).
- **Seeded descriptions** (examples): `app_name` → "Application display name."; `app_logo_path` → "Path under /public (must start with /brand/) to the company logo; blank shows the text wordmark."; `locale` → "BCP-47 locale for date/number formatting (not UI language)."; `default_currency` → "Default ISO-4217 currency code for money formatting."; `company_name` / `company_address` / `company_billing_pic` → "Operating company … (used on billing documents)."

### 2.11 Assets

- `public/brand/logo.svg` (+ optional square `logo-mark.svg` for the collapsed rail) — committed placeholder until real artwork is available; swap later with no code change. `public/` is currently empty.

> **Validation is format-only, not existence (deliberate, per source-plan Q2 "render optimistically").** `getBrandingLogo()` validates the _shape_ of the path (`/brand/…`, no scheme/`//`/`..`), not that the file exists on disk. A valid-format but nonexistent path (e.g. a typo'd `/brand/logp.svg`) therefore yields a broken-image icon rather than the wordmark/monogram fallback — the fallback only fires on a `null`/format-invalid value. To keep the seeded path always resolvable, **commit `logo-mark.svg` if `app_logo_mark_path` is seeded non-blank** (else seed it blank and let the monogram fallback handle the collapsed rail).

### 2.12 Visual / a11y details (ui-context tokens)

- Toggle: a real `<button>`, ghost on dark chrome — `text-[color:var(--color-primary-300)] hover:bg-[color:var(--color-primary-700)] hover:text-[color:var(--text-on-brand)]`, `focus-visible:[box-shadow:var(--focus-ring)]`, `PanelLeftClose`/`PanelLeftOpen` size 18, `aria-label` "Collapse sidebar" / "Expand sidebar", `aria-expanded={!collapsed}`.
- Logo `<img>` always has a meaningful `alt` (from `app_name`); collapsed nav links keep accessible names; focus order unchanged.
- All colors via the Tailwind v4 `[color:var(--token)]` arbitrary-value form — no hardcoded hex (code-standards §4.3). Nav chrome stays on `--surface-nav`; marketing gradients remain reserved for `/login` + `/no-access` (ui-context §0/§2.1).

---

## 3. Implementation

### 3.1 Migration `0005_admin_chrome_config` (`db/migrations/` + `meta`)

`db/migrations/` holds `0000`–`0004` (`0000_core`, `0001_audit`, `0002_rbac`, `0003_roles_name_ci_unique`, `0004_system_config`) and `_journal.json` matches — **`0005` is the correct next index**, no renumbering. Unlike a data-only migration, this one carries a real schema change: after adding `description` to the Drizzle schema (§2.10), `drizzle-kit generate` **will** emit `ALTER TABLE "core"."system_config" ADD COLUMN "description" text;` (with its `meta` snapshot + journal entry). Then **hand-append** to the same `0005` file:

- `INSERT` rows: `app/app_logo_path` (blank), `app/locale` (`en-MY`), `app/default_currency` (`MYR`), `company/company_name` (blank), `company/company_address` (blank), `company/company_billing_pic` (blank) — each non-secret, ACTIVE, `config_version = 1`, `modified_by = NULL`, and each with its seeded `description`.
- `UPDATE` `app/app_name` to set its `description`.

### 3.2 Schema, repository, types

- `db/schema/system-config.ts`: add `description: text("description")` (nullable).
- `db/repositories/system-config.repository.ts`: add `description` to the two `select` projections (`findAllNonSecret`, `findById`); add `findActiveValue(db, group, key)` (§2.6).
- `types/system-config.ts`: add `description: string | null` to `SystemConfigDisplayRow`; add the `BrandingLogo` type.

### 3.3 Service + lib

- `services/system-config/app-config-read.service.ts` (**new**): `getBrandingLogo()` (path validation), `getAppLocale()`, `getAppCurrency()` (DB read via `findActiveValue` + allow-list validation + fallback) — all `React.cache`d.
- `lib/locale.ts` (**new**): `SUPPORTED_LOCALES` / `DEFAULT_LOCALE`, `SUPPORTED_CURRENCIES` / `DEFAULT_CURRENCY` (§2.8).
- `lib/sidebar.ts` (**new**, or fold into an existing `lib/` constants file): `export const SIDEBAR_COOKIE = "sidebar_collapsed"`.
- `lib/formatters.ts`: `formatDatetime(date, locale, fallback?)`; **new** `formatMoney(amount, locale, currency)`. `formatRelativeTime`, `groupConfigRows`, `formatPasswordPolicyHints` unchanged.

### 3.4 Chrome components

- `components/brand-logo.tsx` (**new**): pure presentational logo-or-wordmark renderer (§2.3).
- `components/admin-sidebar.tsx` (**new**, `"use client"`): collapse state, header (`BrandLogo` + toggle), `<AdminNav collapsed={collapsed} />`, footer, cookie write (§2.4).
- `components/admin-nav.tsx`: add per-item `icon`; add `collapsed` prop; expanded vs icon-rail render; hide the "Administration" caption when collapsed (§2.5).
- `components/nav-sign-out-button.tsx`: optional `collapsed`/`iconOnly` prop → icon-only + `title`.
- `app/(admin)/layout.tsx`: read cookie + identity + branding; render `<AdminSidebar … />` in place of the inline `<aside>`.
- `app/(auth)/login/page.tsx`: read branding; swap the wordmark `<span>` for `<BrandLogo variant="login" logo={logo} />`.

### 3.5 Locale thread-through (call sites — definitive)

All four `formatDatetime` callers are `"use client"` components rendered by two `async` + `force-dynamic` server pages, so locale is threaded **strictly as a prop** (a client component cannot call the server-side `getAppLocale()`). The exact, complete fan-out:

1. **`app/(admin)/administration/users/page.tsx`** (server): add `getAppLocale()` to the existing `Promise.all([...])` read block; pass the resolved `locale` as a new prop to `<UserTable locale={locale} … />` and `<UserDetail locale={locale} … />`.
2. **`app/(admin)/administration/roles/page.tsx`** (server): same — add `getAppLocale()` to its read block; pass `locale` to `<RoleTable locale={locale} … />` and `<RoleDetail locale={locale} … />`.
3. **`components/users/user-table.tsx`, `user-detail.tsx`, `components/roles/role-table.tsx`, `role-detail.tsx`** (client): add `locale: string` to each component's props and pass it to every `formatDatetime(date, locale, …)` call (8 calls total: user-table ×1, user-detail ×4, role-table ×1, role-detail ×2).

So the precise scope of the locale wiring is: **`lib/formatters.ts` signature + 2 server pages (add 1 read each) + 4 client-component prop signatures + 8 call updates.** `React.cache` on `getAppLocale()` dedupes the per-request read so the layout's branding read and a page's locale read don't double-query.

### 3.6 Config-table UI

`components/system-config/config-table.tsx`: render `description` as a **muted second-line sublabel inside the existing Key cell** (`--text-muted`, `--text-caption`, beneath the mono `configKey`) — **not** a new column. The group-header `colSpan` stays `canEdit ? 5 : 4` (unchanged). Blank description ⇒ no sublabel (no placeholder). `ConfigEditDialog` is untouched. See §2.10 for the rationale.

### 3.7 Assets

Add `public/brand/logo.svg` (+ optional `public/brand/logo-mark.svg`).

---

## 4. Dependencies

- **None.** No new runtime or dev dependency. The lucide icons used (`PanelLeftClose`, `PanelLeftOpen`, `Users`, `ShieldHalf` — or `UserCog` fallback, `Settings`, `ScrollText`, `LogOut`) should be confirmed present in the pinned `lucide-react` before use (`ShieldHalf` is the one to verify; the rest are already in use or were verified by the source plan). No new env var, no `next.config.ts` change, no `images.remotePatterns`, no new RBAC permission / audit event / Server Action.

---

## 5. Verify when done

- [ ] **Collapse:** toggle flips `<aside>` `w-64` ↔ `w-16`, updates `aria-expanded`, writes the `sidebar_collapsed` cookie; collapsed state survives a **hard reload** (cookie `=1` ⇒ collapsed first paint, no flash) and cross-page in-app nav; absent cookie ⇒ expanded (first-visit default).
- [ ] **Collapsed rail:** all four nav links reachable and labeled (`title`/`aria-label`); active item renders as a centered light square (`--surface-selected`, no left-border accent); "Administration" caption hidden; collapsed header is a vertical stack (mark above, toggle below) or toggle-only; footer collapses to a sign-out icon only (no identity strip); labels fade rather than pop during the width transition; reduced-motion respected.
- [ ] **Roles icon:** Roles nav uses `ShieldHalf` (or `UserCog` fallback) — **not** `ShieldCheck`, which is the SSO badge glyph; confirm the chosen icon is present in the pinned `lucide-react`.
- [ ] **Logo (single asset + plate):** with `app_logo_path` set to a valid `/brand/...` asset, login page (white card) **and** sidebar header (dark nav) both show the image legibly on its demarcation plate (correct `alt` from `app_name`); blank ⇒ wordmark; an external URL / `//host` / `../` value ⇒ treated as unset ⇒ wordmark.
- [ ] **Config rows:** the five new rows (`locale`, `default_currency`, `company_name`, `company_address`, `company_billing_pic`) appear on the System Configuration page, are editable via `ConfigEditDialog`, and blank company values render "—"; `app_logo_path` row present and editable.
- [ ] **Description sublabel:** each config key shows its seeded description as a muted second line beneath the key (no new column; `colSpan` unchanged); blank ⇒ no sublabel; `app_name` shows its seeded description; description is **not** editable in `ConfigEditDialog`.
- [ ] **Locale/currency wiring:** setting `locale` to an allow-listed value changes date rendering on Users/Roles tables + details; the seeded `en-MY` reproduces today's `en-GB` output **(verified at runtime — both yield `"09 Mar 2026, 07:05"` for the `formatDatetime` options)**; an unknown/blank value falls back to the default; `formatMoney` formats per locale+currency (`en-MY`/`MYR` ⇒ `RM 1,234.56` **with a U+00A0 non-breaking space**, `en-US`/`USD` ⇒ `$1,234.56`).
- [ ] **Locale tests prove live wiring, not just defaults:** a test asserts `en-MY === en-GB` for the `formatDatetime` options (locks the behavior-preserving invariant) **and** a non-en locale genuinely differs (`ms-MY` ⇒ `"09 Mac 2026, …"`), so a silently-inert thread-through can't pass; `formatMoney` test handles the NBSP (exact codepoint or whitespace-normalized — a naïve ASCII-space assertion fails).
- [ ] **`findActiveValue` is deterministic:** with two ACTIVE rows for the same `(group, key)` at different `config_version`s, it returns the highest version (`ORDER BY config_version DESC`); `null` for missing/RETIRED/secret.
- [ ] **Migration:** `0005` is born with the `description` column + all six seeded rows (correct group/secret/status and non-null descriptions); pre-existing `app_name` got its description; `tests/db/migration.integration.test.ts` column-list assertion extended to include `description`.
- [ ] No TypeScript errors (`tsc --noEmit`).
- [ ] No console errors; no hydration warning from the collapse seed.
- [ ] ESLint clean (incl. import-boundary rules and `react-hooks/set-state-in-effect`); Prettier clean.
- [ ] Responsive at mobile and desktop.
- [ ] `npm run build` passes.

---

## 6. Open items carried from the source plan (decide before/at build)

1. **Collapsed-rail mark:** ship a separate square `logo-mark.svg`, reuse the full logo, or monogram fallback? (Spec assumes optional `logo-mark.svg`, monogram fallback when absent.)
2. **Also wire `app_name`:** drive the wordmark/`alt`/`<title>` text from the existing `app_name` row, or keep the literal "Enterprise Billing" wordmark? (Spec uses `app_name` for `alt` only; the wordmark text itself stays literal unless decided otherwise.)
3. **Artwork:** commit a placeholder `logo.svg` now and swap later (assumed), or block on final artwork?
4. **Toggle placement:** in-header next to the logo (assumed) vs a floating edge tab.
5. **Tooltips:** native `title` for collapsed labels (assumed — no Tooltip primitive exists) vs introducing one.
6. **Seed defaults:** `en-MY` / `MYR` (Malaysia/DNB context, assumed) vs seeding blank so the `en-GB`/`MYR` code defaults apply until set.
7. **Allow-list contents:** confirm/extend the Locale and Default Currency sets in `lib/locale.ts`.
8. **`company` group naming:** new `company` group (assumed) vs folding into `app`.
