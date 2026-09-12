# Plan: Dynamic application name — drive the wordmark & titles from `system_config.app_name`

Status: Draft for review · Date: 2026-09-11
Boundary: **FRONTEND** (one new `services/` reader + one new `lib/` constant + prop thread-through). **No schema change, no migration, no new RBAC/audit/Server-Action surface, no new dependency.**

> **What this is.** The admin chrome and the auth pages render a **hardcoded** `"Enterprise Billing"` text wordmark. The `app`/`app_name` config row already exists, is non-secret + ACTIVE, and is **already admin-editable** on the System Configuration page — but nothing reads it for display (it currently only feeds the logo `alt`, and only when a logo is set). This change wires that value through so editing `app_name` re-brands the app.
>
> This is exactly **open item #2 of the shipped um28 spec** (`context/user-management/specs/um28-side-panel-system-config.md` §6.2): _"Also wire `app_name`: drive the wordmark/`alt`/`<title>` text from the existing `app_name` row… the wordmark text itself stays literal unless decided otherwise."_ That decision is now: **wire it.**

---

## 0. Locked / proposed decisions

- **Single source of truth.** The displayed application name is the highest-version ACTIVE `app`/`app_name` value, resolved once server-side via a new `getAppName()` reader (`React.cache`d, symmetric with the existing `getAppLocale()` / `getAppCurrency()`), and threaded to every wordmark surface as a plain `appName: string` prop. `BrandLogo` stays pure (no DB/async) — same boundary discipline as um28.
- **Fallback = `"Enterprise Billing"`.** A blank/missing row falls back to a `DEFAULT_APP_NAME = "Enterprise Billing"` constant — matching today's literal wordmark, so a wiped config never renders an empty header.
- **In scope for consistency: all four visible wordmark surfaces.** The two the user named (top-left sidebar header, sign-in page) **plus** the two other pages that hardcode the same literal (`set-password`, `no-access`). Fixing only the first two would leave `set-password` / `no-access` showing a stale, now-inconsistent brand.
- **Browser `<title>` (tab) — proposed in scope, flagged.** The user said "the title"; the visible wordmark is the primary target, but the `<title>` metadata strings also hardcode "Enterprise Billing". Making them dynamic needs `generateMetadata()` (a small, mechanical async conversion). Recommended in scope for the admin layout + auth pages; the **root** `app/layout.tsx` metadata is deliberately **excluded** (see §3.3 / Q3).
- **No change to how the value is edited.** `app_name` is already a non-secret ACTIVE row surfaced by `ConfigTable` and editable through the `system_config:EDIT`-gated `ConfigEditDialog`. Because the layout and auth pages are already `force-dynamic`, the next request after an edit reflects the new name — no cache-bust, no new UI.

---

## 1. Goal

Make the application name **configuration-driven** so that changing the `app_name` value on the System Configuration page re-brands:

1. **The app name in the top-left sidebar header** — currently the hardcoded `BrandLogo variant="nav"` (and `nav-collapsed` monogram) wordmark.
2. **The sign-in page brand name** — currently the hardcoded `BrandLogo variant="login"` wordmark.

…and, for consistency, the same literal on the **Set-Password** and **No-Access** pages, plus (proposed) the browser tab `<title>` on those chrome/auth surfaces.

---

## 2. What exists today (verified — do not re-derive)

- **`services/system-config/app-config-read.service.ts`** — has `getBrandingLogo()`, `getAppLocale()`, `getAppCurrency()` (all `React.cache`d), and a sync `getAppTimezone()`. **No `getAppName()`.** `getBrandingLogo()` already reads `app`/`app_name` for the logo `alt` with its own inline fallback `(appName ?? "").trim() || "Enterprise Billing"` — **but only returns anything when a logo path is set**; when no logo is configured it returns `null`, so `app_name` never reaches the wordmark path.
- **`components/brand-logo.tsx`** — pure presentational (no `"use client"`, no async, no DB). Prop `logo: BrandingLogo | null`, `variant: "login" | "nav" | "nav-collapsed"`. When `logo === null` it renders the **hardcoded** literals: `"Enterprise Billing"` for `login` and `nav`, and a hardcoded `"EB"` `<Monogram>` for `nav-collapsed`.
- **`components/admin-sidebar.tsx`** (`"use client"`) — renders `<BrandLogo logo={logo} variant="nav" />` (expanded) and `variant="nav-collapsed"` (collapsed). Receives `logo` as a prop from the server layout; **no `appName` prop today.**
- **`app/(app)/layout.tsx`** (async, `force-dynamic`) — resolves `cookies()`, `getCurrentUserIdentity()`, `resolveEffectivePermissions()`, `getBrandingLogo()` and passes them to `<AdminSidebar>`. Static `metadata = { title: "Administration — Enterprise Billing" }`.
- **`app/(auth)/login/page.tsx`** (async, `force-dynamic`) — reads `getBrandingLogo()`, renders `<BrandLogo variant="login" logo={logo} />`. Static `metadata = { title: "Sign In", description: "Sign in to the Enterprise Billing System" }`.
- **`app/(auth)/set-password/page.tsx`** (async, `force-dynamic`) — renders a **hardcoded** `<span class="text-h4 …">Enterprise Billing</span>` (does **not** use `BrandLogo`). Static `metadata = { title: "Set Password", … }`.
- **`app/(app)/no-access/page.tsx`** (async) — renders a **hardcoded** `<span class="text-h4 …">Enterprise Billing</span>` (does **not** use `BrandLogo`). Static `metadata = { title: "No Access — Enterprise Billing" }`.
- **`app/layout.tsx`** (root, **not** `force-dynamic`) — `metadata.title` template `"%s · User Management"`, default `"User Management"`, `description: "Enterprise Billing App — User Management Module"`. Outer shell for the whole app.
- **`db/repositories/system-config.repository.ts`** — already has `findActiveValue(db, group, key): Promise<string | null>` (highest-version, ACTIVE, non-secret, `ORDER BY config_version DESC LIMIT 1`). **No repo change needed.**
- **Migration `0004`** seeds `app`/`app_name` = **`"Enterprise Billing System"`** (note: **"…System"**, which differs from the "Enterprise Billing" literal the wordmarks show today — see Q1). `0005` set its `description = "Application display name."`. Row is non-secret, ACTIVE, editable.

Convention constraint (code-standards §4.3): all colors via the Tailwind v4 `[color:var(--token)]` form; no behavior change to styling here — only the text content.

---

## 3. Design

### 3.1 New reader — `getAppName()` (`services/system-config/app-config-read.service.ts`)

Add, alongside the existing readers and following the identical `React.cache` shape:

```ts
export const getAppName = cache(async (): Promise<string> => {
  const value = await systemConfigRepository.findActiveValue(db, "app", "app_name");
  return value?.trim() || DEFAULT_APP_NAME;
});
```

- `DEFAULT_APP_NAME` is a new constant (§3.4). Blank/whitespace/missing → the default, so the header is never empty.
- `React.cache` dedupes the per-request read: the layout's branding read and its app-name read collapse to a single query per request; the auth pages read once.
- **Consolidation (recommended):** change `getBrandingLogo()`'s inline `alt` fallback to call `getAppName()` instead of re-reading `app_name` and re-implementing the fallback literal. Both are `React.cache`d, so this is one query, and the `"Enterprise Billing"` default then lives in exactly one place.

### 3.2 `BrandLogo` gains a required `appName` prop (`components/brand-logo.tsx`)

Add `appName: string` to `BrandLogoProps` and replace the three hardcoded literals with it:

- `variant === "login"` fallback: `<span …>{appName}</span>`.
- `variant === "nav"` fallback: `<span …>{appName}</span>`.
- `variant === "nav-collapsed"` fallback: `<Monogram>` derives its 1–2 letters from `appName` instead of the literal `"EB"` — e.g. first letters of the first two words, uppercased, capped at 2 chars (`"Enterprise Billing System"` → `"EB"`, `"Acme"` → `"A"`). Keep it a tiny local helper in this file (the monogram is the only consumer).

Making `appName` **required** means the type-checker forces every call site to supply it — no wordmark surface can be silently missed. The `alt` on the plated `<img>` (when a logo *is* set) continues to come from `logo.alt`; `appName` only drives the text/monogram fallback.

`BrandLogo` stays pure — `appName` is a plain string prop resolved server-side, so it serializes cleanly across the server→client boundary into the `"use client"` `AdminSidebar`.

### 3.3 Thread `appName` from the server

| Surface | Change |
| --- | --- |
| `app/(app)/layout.tsx` (server) | Add `const appName = await getAppName();`; pass `appName={appName}` to `<AdminSidebar>`. |
| `components/admin-sidebar.tsx` (client) | Add `appName: string` to `AdminSidebarProps`; pass it to **both** `<BrandLogo>` renders (expanded `nav` + collapsed `nav-collapsed`). |
| `app/(auth)/login/page.tsx` (server) | Add `const appName = await getAppName();`; pass `appName={appName}` to `<BrandLogo variant="login" …>`. |
| `app/(auth)/set-password/page.tsx` (server) | Replace the hardcoded `<span>Enterprise Billing</span>` with the resolved name. **Recommended:** `const appName = await getAppName();` then render `{appName}` in the existing span (minimal, no logo read). *(Optional parity: adopt `<BrandLogo variant="login" logo={await getBrandingLogo()} appName={appName} />` to also show the logo here — see Q2.)* |
| `app/(app)/no-access/page.tsx` (server) | Same as set-password: resolve `getAppName()` and render `{appName}` in the existing span. |

`getAppName()`'s `React.cache` + the pages already being `force-dynamic` means this adds at most one lightweight single-row query per request.

### 3.3.1 Browser `<title>` metadata (proposed — flagged, see Q3)

Static `metadata` exports can't read the DB, so making tab titles dynamic means converting them to `generateMetadata()`:

- `app/(app)/layout.tsx`: `export async function generateMetadata()` → `{ title: `Administration — ${await getAppName()}` }`.
- `app/(auth)/login/page.tsx`: `{ title: "Sign In", description: `Sign in to ${appName}` }` (or keep `title` literal; the visible wordmark is the primary target).
- `app/(auth)/set-password/page.tsx`, `app/(app)/no-access/page.tsx`: fold `appName` into their titles.
- **Excluded: `app/layout.tsx` (root).** Its metadata is module-scoped (`"User Management"`), it is **not** `force-dynamic`, and making the outermost shell await a DB read on every request has broader caching implications for the whole tree. Leave it literal; revisit separately if desired.

### 3.4 New constant — `DEFAULT_APP_NAME` (`lib/branding.ts`, new)

A one-line, framework-agnostic module (importable from both the server reader and — if ever needed — client code, mirroring `lib/locale.ts` / `lib/sidebar.ts`):

```ts
// Fallback application name when the `app`/`app_name` config row is blank or
// unset. Matches the wordmark literal used before app_name was wired, so a
// wiped config renders an unchanged brand rather than an empty header.
export const DEFAULT_APP_NAME = "Enterprise Billing";
```

---

## 4. Files touched

| File | Change |
| --- | --- |
| `services/system-config/app-config-read.service.ts` | **New** `getAppName()` (`React.cache`d); optionally route `getBrandingLogo()`'s `alt` fallback through it (single source of the default). |
| `lib/branding.ts` | **New** — `export const DEFAULT_APP_NAME = "Enterprise Billing"`. |
| `components/brand-logo.tsx` | Add required `appName: string` prop; replace the 3 hardcoded `"Enterprise Billing"` / `"EB"` literals with it (monogram derives initials). |
| `components/admin-sidebar.tsx` | Add `appName: string` to props; pass to both `<BrandLogo>` renders. |
| `app/(app)/layout.tsx` | Resolve `getAppName()`; pass `appName` to `<AdminSidebar>`; *(proposed)* `metadata` → `generateMetadata()`. |
| `app/(auth)/login/page.tsx` | Resolve `getAppName()`; pass to `<BrandLogo>`; *(proposed)* `generateMetadata()`. |
| `app/(auth)/set-password/page.tsx` | Resolve `getAppName()`; render it in the wordmark span; *(proposed)* `generateMetadata()`. |
| `app/(app)/no-access/page.tsx` | Resolve `getAppName()`; render it in the wordmark span; *(proposed)* `generateMetadata()`. |

**No** schema change, **no** migration (the `app_name` row already exists), **no** repository change (`findActiveValue` already exists), **no** new RBAC permission / audit event / Server Action, **no** new dependency, **no** `next.config.ts` change.

---

## 5. Testing (mirror existing `tests/` conventions)

- `tests/services/app-config-read.service.test.ts` (extend) — `getAppName()` returns the ACTIVE non-secret `app`/`app_name` value; blank / whitespace / missing / RETIRED / secret → `DEFAULT_APP_NAME`; trimmed.
- `tests/components/brand-logo.test.tsx` (extend) — each fallback variant renders the passed `appName` (not a hardcoded literal); `nav-collapsed` monogram derives initials from `appName` (`"Enterprise Billing System"` → `"EB"`, single word → 1 char); when a `logo` is present the `<img alt>` still comes from `logo.alt`.
- `tests/components/admin-sidebar.test.tsx` (extend, if present) — `appName` prop reaches both expanded and collapsed `BrandLogo` renders.
- Login / set-password / no-access page tests (extend/add) — the resolved app name renders in the wordmark; with `app_name` unset the default shows.
- *(If §3.3.1 adopted)* metadata tests — `generateMetadata()` yields a title containing the resolved app name.

Acceptance:
- [ ] Editing `app`/`app_name` on the System Configuration page changes the **top-left sidebar header** (expanded wordmark + collapsed monogram initials) and the **sign-in page** brand name on the next request — no code change, no redeploy.
- [ ] `set-password` and `no-access` pages show the same dynamic name (no residual "Enterprise Billing" literal anywhere a logo isn't set).
- [ ] Blank `app_name` → `"Enterprise Billing"` fallback everywhere; app never renders an empty header.
- [ ] When a `/brand/` logo **is** configured, the image still shows (this change only affects the text/monogram fallback path); `alt` unchanged.
- [ ] `tsc --noEmit`, ESLint (incl. import-boundary + `react-hooks/set-state-in-effect`), Prettier clean; `npm run build` passes.

---

## 6. Open questions for review

1. **Seeded value mismatch — "Enterprise Billing System" vs "Enterprise Billing".** The `app_name` row is seeded `"Enterprise Billing System"`, but every wordmark shows `"Enterprise Billing"` today. Once wired, the visible brand becomes **"Enterprise Billing System"**. Options: **(a, recommended)** accept it — the configured value is now authoritative and an admin can edit it in seconds; **(b)** add a trivial migration `UPDATE`ing the seed to `"Enterprise Billing"` for zero visible change on deploy. Pick one so the change on deploy is intentional.
2. **Logo parity on `set-password` / `no-access`.** Wire only the dynamic **name** on these two (recommended — minimal, they never showed a logo), or also adopt `BrandLogo` + `getBrandingLogo()` so they gain the configured logo too (fuller consistency, slightly more scope)?
3. **Browser `<title>` scope (§3.3.1).** Convert the admin layout + auth-page `metadata` to `generateMetadata()` so tab titles track `app_name` (recommended), or leave tab titles literal and change only the visible wordmarks (the strict reading of the request)? Root `app/layout.tsx` metadata stays excluded either way — confirm.
4. **Monogram derivation.** First-letters-of-first-two-words, uppercased, max 2 chars (recommended) — confirm, or keep a fixed `"EB"` monogram independent of `app_name`?
5. **Constant home.** `DEFAULT_APP_NAME` in a new `lib/branding.ts` (recommended, mirrors `lib/locale.ts`/`lib/sidebar.ts`) vs folding into an existing `lib/` constants module.
