# Unit um01 — Project Scaffold & Themed App Shell — Spec

- **Boundary:** APP / INFRA (tooling)
- **Dependencies:** none (this is the first unit)
- **Confirmed toolchain choices:** Tailwind **v4** (CSS-first `@theme`), **Vitest + React Testing Library** for the test gate, **Semgrep** for the SAST gate, **npm** (package-lock.json).
- **Source sections:** build plan §"Phase 1 / um01"; architecture §1 (stack), §2 (folder ownership); code-standards §2 (TS), §3 (Next.js), §4 (styling), §7 (file org), §10 (CI gates); UI-context §1–§8 (all tokens); workflow §1–§8. Invariants touched: #14 (DB only in `db/`), #16 (Zod at the boundary), #17 (stateless), #18 (no secrets in repo/image), #19 (snake*case mapping — \_declared later*), #23 (security gates block the pipeline).

> This unit ships **tooling and a themed shell only**. There is **no database, no Better-Auth, no real authentication, no admin pages, and no Dockerfile/deploy** here. Those arrive in later units (DB → um02, auth → um03, admin pages → um06+, deploy/DAST → um25). The single deliverable is a project that boots, renders a themed public placeholder, and passes every quality gate on an otherwise empty tree.

---

## 1. Goal

Stand up a Next.js ≥ 15 (App Router, RSC) project on Node ≥ 22 with TypeScript `strict`, the full design-token system wired into Tailwind v4 + shadcn/ui, the `lib/` leaf utilities (`cn()`, logger/telemetry, `AppError` + `toHttpResponse`, env config loader), a token-driven dark-navy chrome on a public placeholder page, and the layered folder skeleton with an enforced inward-only import boundary. The unit is **done** when the app boots and renders the themed placeholder and **`tsc`, ESLint (incl. the import-boundary rule), Prettier, Vitest, and Semgrep all pass** locally and as Azure DevOps pipeline gates.

---

## 2. Design

### 2.1 Visual decisions

The look follows the UI-context doc verbatim: a formal telecoms aesthetic with a deep indigo-navy base, a 5G magenta→violet accent, a cyan connectivity secondary, and cool neutrals — **light-mode-first** for data-dense screens with a **dark navy chrome** for nav/top bar.

- **Light surfaces by default.** Page background is `--surface-app` (`#F7F8FA`), cards are `--surface-card` (`#FFFFFF`); body ink is `--text-body`, headings `--text-primary`. v1 has **no dark-mode toggle** — the app is light-mode-first; the "dark" of the chrome comes from explicit dark surface tokens (`--surface-nav` = primary-800, `--surface-topbar` = primary-700, `--gradient-chrome`), not from a theme switch. (A `.dark` class block may exist from the shadcn init but is unused and unwired in v1.)
- **Typography.** UI font is IBM Plex Sans (Inter fallback), loaded via `next/font/google` and exposed as `--font-sans`; IBM Plex Mono via `--font-mono` for IDs/timestamps. Sizes/weights match UI-context §5 (`--text-body` 14/22 default; headings 600; avoid 700+). `tabular-nums` enabled where numeric alignment matters (set up as a utility class, applied by later table units).
- **Shape & elevation.** Radius scale and shadow scale come from UI-context §6–§7 (`--radius-md` 6px default; cool low-spread shadows; `--focus-ring` = white inset + indigo ring). The default focus ring is mandatory and visible on both light surfaces and dark chrome.
- **Reserved-but-defined.** The AI/Iris-violet family and `--gradient-ai`/`--gradient-5g`/`--gradient-brand` are **defined** in `globals.css` but **must not appear on any screen in this unit** (UI-context §0/§4): User Management has no AI, and marketing gradients are reserved for `/login` and `/no-access` (not built yet). `--gradient-chrome` is allowed on the placeholder's chrome.
- **The placeholder is intentionally minimal and disposable.** It demonstrates the theme (dark-navy top bar + a light content card with the module title and a few token-driven elements). It carries **no real data, no auth, no nav links** (there are no other routes yet). The route `/` is a temporary public placeholder that will be **replaced** by the authenticated root redirect in um06.

### 2.2 Structural decisions

- **No `src/` directory.** Top-level layout exactly as code-standards §7, with the path alias `@/*` → project root.
- **Folders are created now but mostly empty**, each with a `.gitkeep`, so the layered skeleton and the import-boundary rule exist from day one: `app/`, `components/` (+ `components/ui/`), `actions/`, `validation/`, `services/`, `db/`, `auth/`, `types/`, `lib/`, `tests/`, `infra/`. Only `app/`, `components/ui/` (shadcn init), `lib/`, and `infra/` carry real files in this unit.
- **Dependencies point inward** (architecture §2; code-standards §1.4, §7.1), enforced by ESLint, not convention. The chrome lives in the **placeholder page**, not the root `layout.tsx`, so it does not leak into the future `(auth)` group (`/login` uses a different, gradient look). The root layout owns only `<html>`/`<body>`, fonts, base tokens, and metadata.
- **Telemetry is an abstraction now, a transport later.** `lib/` exposes a structured `logger` and a `reportError()` telemetry helper that currently write structured logs only. The live GlitchTip (Sentry-compatible) + OpenTelemetry transport is wired in the telemetry/infra work (um25), so this unit pulls **no** `@sentry/*`/OTel dependency. `console.*` is forbidden everywhere except inside the single logger module (code-standards §1.10).
- **Config is read in exactly one place.** `lib/config.ts` is the only module that reads `process.env`, validates it with a Zod schema, and exports a typed, frozen config object (server-only). The um01 env surface is tiny (`NODE_ENV`, `APP_URL`, `LOG_LEVEL`); DB/Entra/Key Vault keys are added by the units that need them — **no speculative env keys** (workflow §2.4).

---

## 3. Implementation

### 3.1 Project initialization

Initialize with `create-next-app` (Next ≥ 15, App Router, TypeScript, Tailwind v4, ESLint), **no `src/` dir**, import alias `@/*`:

- `npx create-next-app@latest enterprise-billing --typescript --eslint --tailwind --app --no-src-dir --import-alias "@/*"`
- Pin runtime: `package.json` → `"engines": { "node": ">=22" }`; add `.nvmrc` containing `22`.
- `package.json` scripts (CI calls these): `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `lint:fix`, `format` (`prettier --write .`), `format:check` (`prettier --check .`), `test` (`vitest run`), `test:watch` (`vitest`).
- Keep the generated `.gitignore` (ensure `.env*` is ignored except `.env.example`). Add `.env.example` with the um01 keys only.

### 3.2 TypeScript configuration (`tsconfig.json`)

Enable the mandated strict surface (code-standards §2.1) on top of the Next generated config — do **not** relax any of these (workflow §5.5):

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "ES2022",
    "paths": { "@/*": ["./*"] },
    // ...plus the Next.js defaults (jsx: preserve, lib, plugins: next, etc.)
  },
}
```

Conventions this unit must already honor (code-standards §2): no `any` (use `unknown` + narrow), explicit return types on all exported functions, `import type { … }` for type-only imports, named exports except Next-reserved files, `as const` literal unions over `enum`.

### 3.3 Folder skeleton & import boundaries

Create the layered tree (code-standards §7) with `.gitkeep` in empty folders:

```
app/            components/ (+ ui/)   actions/     validation/
services/       db/                   auth/        types/
lib/            tests/                infra/
```

Define the inward-only dependency rule with **`eslint-plugin-boundaries`** (see §3.9). Element types and their **allowed** imports (everything else is denied — deny-by-default):

| Layer (element) | Path            | May import                                                                |
| --------------- | --------------- | ------------------------------------------------------------------------- |
| `app`           | `app/**`        | `actions`, `services`, `auth`, `components`, `validation`, `types`, `lib` |
| `actions`       | `actions/**`    | `services`, `auth`, `validation`, `types`, `lib`                          |
| `services`      | `services/**`   | `db`, `types`, `lib`                                                      |
| `auth`          | `auth/**`       | `db`, `services`, `validation`, `types`, `lib`                            |
| `db`            | `db/**`         | `types`, `lib`                                                            |
| `validation`    | `validation/**` | `types` (+ `zod`)                                                         |
| `components`    | `components/**` | `components`, `types`, `lib`                                              |
| `types`         | `types/**`      | `types`                                                                   |
| `lib`           | `lib/**`        | `lib` (+ external libs only)                                              |

Rules that fall out and must be enforced: UI never imports `db/**`; `services/`, `db/`, `validation/`, `auth/` (except its Next-facing handler wiring, added later) never import `next/*`; no barrels across layers (only `components/ui/` may have an `index.ts`). Configure the `@/*` alias resolver so boundary checks and `tsc` agree.

### 3.4 Tailwind v4 + shadcn/ui init

- Tailwind v4 is CSS-first: `globals.css` starts with `@import "tailwindcss";`. PostCSS uses `@tailwindcss/postcss` (no `tailwind.config.js` content array needed). Add `prettier-plugin-tailwindcss` for class ordering.
- Run `npx shadcn@latest init` against Tailwind v4. `components.json`: `style` = `new-york`, `rsc: true`, `tsx: true`, `tailwind.css` = `app/globals.css`, `tailwind.config` = `""` (v4), `cssVariables: true`, `baseColor: neutral`, `iconLibrary: lucide`, aliases `{ components: "@/components", ui: "@/components/ui", lib: "@/lib", utils: "@/lib/utils", hooks: "@/hooks" }`.
- The init creates `lib/utils.ts` exporting **`cn()`** (`clsx` + `tailwind-merge`) — this is the canonical helper (code-standards §4.4). **Do not** add any shadcn primitive components in this unit beyond what `init` generates; `components/ui/` is a managed vendor layer (workflow §5.1). The placeholder is styled with token-based utility classes, not bespoke primitives.

### 3.5 `globals.css` — design tokens

Author the complete token system from UI-context §1–§7 as CSS custom properties on `:root`, then expose the subset Tailwind/shadcn consume via Tailwind v4 `@theme inline`. **No raw hex or fixed palette class (`bg-red-600`) may appear in any component** (code-standards §4.3) — every color is a token. Structure:

```css
@import "tailwindcss";
@import "tw-animate-css"; /* shadcn v4 animation utilities */
@custom-variant dark (&:is(.dark *)); /* defined but unused in v1 */

:root {
  /* 1. Brand scales (UI-context §1) */
  --color-primary-50: #edf0fb;
  --color-primary-100: #d4dbf4;
  --color-primary-200: #a9b6e9;
  --color-primary-300: #7c8eda;
  --color-primary-400: #5067c8;
  --color-primary-500: #2e45a9;
  --color-primary-600: #233686;
  --color-primary-700: #1b2a68;
  --color-primary-800: #131d49;
  --color-primary-900: #0c122e;
  --color-accent-50: #fde6f1;
  --color-accent-100: #fab9d8;
  --color-accent-300: #f052a0;
  --color-accent-500: #e6007e;
  --color-accent-600: #bc0067;
  --color-accent-700: #91004f;
  --color-cyan-50: #e2f8fa;
  --color-cyan-100: #b6eef2;
  --color-cyan-300: #4cd3df;
  --color-cyan-500: #00a9bc;
  --color-cyan-600: #00899a;
  --color-cyan-700: #006975;

  /* 2. Neutrals (UI-context §2) */
  --color-neutral-0: #ffffff;
  --color-neutral-50: #f7f8fa;
  --color-neutral-100: #eef0f4;
  --color-neutral-200: #e0e4eb;
  --color-neutral-300: #cad0da;
  --color-neutral-400: #99a1b0;
  --color-neutral-500: #6a7283;
  --color-neutral-600: #4c5462;
  --color-neutral-700: #353b46;
  --color-neutral-800: #1f242c;
  --color-neutral-900: #11141a;

  /* Status scales (base/-fg/-bg) (UI-context §3.4) */
  --color-success-500: #1f9d57;
  --color-success-700: #0f5c32;
  --color-success-50: #e6f6ec;
  --color-warning-500: #e08600;
  --color-warning-700: #8a5200;
  --color-warning-50: #fef4e6;
  --color-danger-500: #d92d2d;
  --color-danger-700: #8a1717;
  --color-danger-50: #fdeaea;
  --color-info-500: #1a73d9;
  --color-info-700: #0c4084;
  --color-info-50: #e7f1fd;

  /* 3.1 Surfaces & text */
  --surface-app: var(--color-neutral-50);
  --surface-card: var(--color-neutral-0);
  --surface-sunken: var(--color-neutral-100);
  --surface-selected: var(--color-primary-50);
  --surface-nav: var(--color-primary-800);
  --surface-topbar: var(--color-primary-700);
  --text-primary: var(--color-neutral-900);
  --text-body: var(--color-neutral-700);
  --text-muted: var(--color-neutral-500);
  --text-disabled: var(--color-neutral-400);
  --text-on-brand: #ffffff;
  --text-link: var(--color-primary-500);
  --text-link-hover: var(--color-primary-600);

  /* 3.2 Borders */
  --border-subtle: var(--color-neutral-100);
  --border-default: var(--color-neutral-200);
  --border-strong: var(--color-neutral-300);
  --border-focus: var(--color-primary-500);
  --border-accent: var(--color-accent-500);

  /* 3.3 Interactive */
  --action-primary-bg: var(--color-primary-500);
  --action-primary-bg-hover: var(--color-primary-600);
  --action-primary-bg-active: var(--color-primary-700);
  --action-cta-bg: var(--color-accent-500);
  --action-cta-bg-hover: var(--color-accent-600);
  --action-secondary-bg: #ffffff;
  --action-secondary-border: var(--color-neutral-300);
  --action-secondary-text: var(--color-neutral-700);
  --action-ghost-hover: var(--color-neutral-100);
  --action-disabled-bg: var(--color-neutral-200);

  /* Domain badge tokens — define now, consumed by later badge components
     (StatusBadge, AuthMethodBadge, RoleBadge, PermissionLevelTag, AuditLogTable):
     user-status (§3.4), auth-method (§3.5), role + permission-level (§3.6), audit category (§3.7).
     These reuse the status/brand scales above; map them as named aliases. */

  /* 4. RESERVED — AI/Iris + gradients (defined, NOT used in v1, UI-context §0/§4) */
  --ai-50: #f0edff;
  --ai-100: #dad2ff;
  --ai-300: #a793ff;
  --ai-500: #6d45f0;
  --ai-600: #5a2fd8;
  --ai-700: #4621b0;
  --gradient-brand: linear-gradient(135deg, #2e45a9 0%, #e6007e 100%);
  --gradient-5g: linear-gradient(120deg, #00a9bc 0%, #6d45f0 50%, #e6007e 100%);
  --gradient-ai: linear-gradient(135deg, #6d45f0 0%, #e6007e 100%);
  --gradient-chrome: linear-gradient(180deg, #1b2a68 0%, #0c122e 100%);

  /* 5. Typography */
  --font-sans:
    "IBM Plex Sans", "Inter", system-ui, -apple-system, "Segoe UI", Roboto,
    sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", "Consolas", monospace;
  /* text-* size/line/weight tokens per UI-context §5 (display, h1–h4, body-lg/body/body-sm, caption, overline, mono) */

  /* 6. Radius */
  --radius-none: 0;
  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
  --radius-pill: 9999px;

  /* 7. Elevation */
  --shadow-sm: 0 1px 2px rgba(17, 20, 26, 0.06);
  --shadow-md: 0 2px 8px rgba(17, 20, 26, 0.08);
  --shadow-lg: 0 8px 24px rgba(17, 20, 26, 0.12);
  --focus-ring: 0 0 0 2px #ffffff, 0 0 0 4px #2e45a9;

  /* shadcn semantic contract mapped onto our tokens */
  --background: var(--surface-app);
  --foreground: var(--text-primary);
  --card: var(--surface-card);
  --card-foreground: var(--text-primary);
  --popover: var(--surface-card);
  --popover-foreground: var(--text-primary);
  --primary: var(--color-primary-500);
  --primary-foreground: var(--text-on-brand);
  --secondary: var(--color-cyan-500);
  --secondary-foreground: var(--text-on-brand);
  --muted: var(--color-neutral-100);
  --muted-foreground: var(--text-muted);
  --accent: var(--color-accent-500);
  --accent-foreground: var(--text-on-brand);
  --destructive: var(--color-danger-500);
  --destructive-foreground: #ffffff;
  --border: var(--border-default);
  --input: var(--border-strong);
  --ring: var(--border-focus);
  --radius: var(--radius-md);
}

@theme inline {
  /* expose tokens as Tailwind utilities: bg-background, text-foreground, bg-primary,
     border-border, bg-destructive, rounded-md, font-sans, font-mono, etc. */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-primary: var(--primary);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-ring: var(--ring);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  /* …complete the mapping for every token the components consume… */
}
```

> The block above is the authoritative structure; fill in the remaining `text-*` typographic tokens and the full `@theme inline` mapping so that `bg-*`, `text-*`, `border-*`, `rounded-*`, `font-*` utilities resolve to these variables. Domain badge token aliases are defined here but **rendered only by the badge components built in later units** — none appear on the um01 placeholder.

### 3.6 `lib/` leaf utilities

All four are pure, framework-agnostic leaf modules (no `next/*`, no DB, no upward imports), named exports, explicit return types.

1. **`lib/utils.ts` — `cn()`** (from shadcn init). `cn(...inputs: ClassValue[]): string` = `twMerge(clsx(inputs))`. The only sanctioned way to compose class names (code-standards §4.4).
2. **`lib/errors.ts` — `AppError` + codes + `Result<T>`.**
   - `AppErrorCode` is an `as const` union: `'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'` (extendable later).
   - `class AppError extends Error` carrying `code: AppErrorCode`, a **safe** `message` (never a secret/stack/SQL — Invariant #1, code-standards §5.6), and optional `cause`. Provide thin subclasses/factory helpers (`forbidden()`, `notFound()`, `conflict()`, `validationFailed()`).
   - `type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }` (code-standards §2.9) — services return this; throwing is reserved for truly exceptional `AppError`s.
3. **`lib/http.ts` — `toHttpResponse(error: unknown): Response`.** Maps `AppErrorCode` → status centrally (code-standards §5.5/§5.7): `UNAUTHENTICATED`→401, `FORBIDDEN`→403, `VALIDATION_FAILED`→422, `NOT_FOUND`→404, `CONFLICT`→409, `INTERNAL`/unknown→500. Returns the standard failure envelope `{ "error": { "code", "message" } }` with a safe message; non-`AppError`s are coerced to `INTERNAL` with a generic message and logged via the logger.
4. **`lib/logger.ts` — structured logger + telemetry hook.** Exposes `logger.{debug,info,warn,error}(msg, fields?)` emitting structured records, and `reportError(error, context?)` for error boundaries. This is the **single module permitted to call `console.*`** (with a line-scoped `eslint-disable` + justification); everywhere else `no-console` is an error (code-standards §1.10). The GlitchTip/OpenTelemetry transport is a documented extension point, wired in um25 — not pulled in here. Never logs secrets, tokens, or passwords (Invariant #1).
5. **`lib/config.ts` — env loader.** The **only** reader of `process.env` (code-standards §3.10), server-only. Parses a Zod schema for the um01 surface and exports a frozen typed object:
   - `NODE_ENV` (`'development' | 'test' | 'production'`), `APP_URL` (URL, default `http://localhost:3000`), `LOG_LEVEL` (`'debug'|'info'|'warn'|'error'`, default `info`).
   - Fails loud (`AppError` `INTERNAL`) on invalid/missing required env (code-standards §1.12). No secrets are introduced; DB/Entra/Key Vault keys are added by their owning units.

### 3.7 Root layout, fonts, metadata, route segment files

- **`app/layout.tsx`** (Server Component, default export — Next-reserved): renders `<html lang="en">`/`<body>`, applies `--font-sans`/`--font-mono` via `next/font/google` (IBM Plex Sans + IBM Plex Mono, with `variable` set and `display: swap`), sets base `bg-background text-foreground font-sans antialiased`, and exports `metadata` (title template `"%s · User Management"`, description). It owns **no chrome** (so it does not bleed into the future `(auth)` group).
- **Route segment files** (code-standards §3.11): `app/loading.tsx` (themed skeleton/spinner), `app/error.tsx` (`'use client'`; calls `reportError()` from `lib/logger`, shows a non-leaking message + retry), `app/global-error.tsx` (top-level boundary), and `app/not-found.tsx`. These establish the required-per-segment pattern from the start.

### 3.8 Themed public placeholder (`app/page.tsx`)

A public Server Component at `/` demonstrating the theme end to end:

- A **dark-navy top bar** using `--surface-topbar` (or `--gradient-chrome`) with the product wordmark in `--text-on-brand`, IBM Plex Sans — this is the "dark navy chrome" deliverable.
- A light content area on `--surface-app` with a `--surface-card` panel (radius `--radius-lg`, `--shadow-md`) showing the module title (`--text-display`/`--text-h1`) and a short "User Management — coming online" message, plus a couple of token-driven elements (a primary-styled element and a muted caption) to prove the brand tokens, fonts, radius, and elevation render.
- **No** marketing gradient (`--gradient-brand`/`-5g`/`-ai`), **no** AI/Iris tokens, **no** nav links, **no** auth, **no** data fetching. Mark the file with a comment that `/` is a temporary placeholder replaced by the authenticated root redirect in um06.

### 3.9 ESLint + Prettier

- **ESLint flat config** (`eslint.config.mjs`, ESLint 9): extend `next/core-web-vitals` + `next/typescript`; enable **type-aware** linting (`parserOptions.project` → `tsconfig.json`). Rules set to `error`: `@typescript-eslint/no-explicit-any` (only line-scoped, justified disables permitted — code-standards §2.2), `@typescript-eslint/no-floating-promises` (§2.14), `@typescript-eslint/consistent-type-imports` (§2.5), `no-console` (override: allowed only in `lib/logger.ts`).
- **Import-boundary rule** via `eslint-plugin-boundaries`: declare element types per §3.3 and an `element-types` rule with `default: disallow` + the allow-list above; configure the settings resolver for the `@/*` alias. A violating import (e.g. a `components/**` file importing from `db/**`) **must fail lint**.
- **Prettier**: one shared `.prettierrc` (no per-file overrides — code-standards §10.3) with `prettier-plugin-tailwindcss`; add `eslint-config-prettier` last in the ESLint config so formatting concerns belong to Prettier. `format:check` is the CI gate.

### 3.10 Testing (Vitest + RTL) — green on an empty tree

- **`vitest.config.ts`**: `environment: 'jsdom'`, `globals: true`, `setupFiles: ['tests/setup.ts']`, and `vite-tsconfig-paths` so `@/*` resolves in tests. `tests/setup.ts` imports `@testing-library/jest-dom`.
- Tests live under **`tests/`** mirroring the source (code-standards §7.9). Seed the suite so the gate is meaningful (not literally empty):
  - `tests/lib/cn.test.ts` — `cn()` merges/deduplicates conflicting utilities.
  - `tests/lib/errors.test.ts` — `AppError` carries code + safe message; `toHttpResponse` maps each code → expected status and envelope shape.
  - `tests/lib/config.test.ts` — loader parses a valid env and rejects an invalid one (loud failure).
  - `tests/app/page.test.tsx` — the placeholder renders the wordmark + module title (RTL).
- The per-route × per-level **authorization matrix** is **not applicable** in this unit (no guarded routes exist yet); it begins at um06. Note this explicitly so the omission is intentional, not an oversight (workflow §8.3).

### 3.11 CI quality gates (Azure DevOps)

- **`infra/azure-pipelines.yml`** (pipelines live in `infra/` — code-standards §7; this file is protected from casual edits per workflow §5.5). On PR + main: a single job on a Node 22 image runs `npm ci`, then the gates — any failure fails the build (Invariant #23):
  1. `npm run typecheck` — `tsc --noEmit` clean under the strict config.
  2. `npm run lint` — ESLint clean incl. the boundary rule, `no-floating-promises`, `no-explicit-any`.
  3. `npm run format:check` — Prettier clean.
  4. `npm run test` — Vitest green.
  5. **Semgrep SAST** — run `semgrep ci` (or `semgrep scan --error`) via the Semgrep container/task with rulesets `p/typescript`, `p/javascript`, `p/nextjs`, `p/owasp-top-ten`, `p/secrets`; **fail on any high/critical finding**. This is the SAST gate the build plan says is "already gating from um01."
- **Out of scope here (um25):** the OWASP ZAP **DAST** stage, Dockerfile, container build, the gated migration step, Key Vault/Managed Identity, and the least-privilege DB role. The pipeline in um01 is the **quality-gate** pipeline only; deployment stages are appended later.

### 3.12 Explicitly NOT in this unit

No Drizzle/Postgres/`db` schema (um02), no Better-Auth/`auth` config or field mapping (um03), no RBAC/resolver/guard (um05–um06), no admin/auth pages or real components beyond the placeholder, no Dockerfile/Container Apps/secrets/DB-role/DAST (um25), no live GlitchTip/OTel transport, no `react-hook-form` (arrives with the first form unit). Adding any of these here is scope creep (workflow §2.4).

---

## 4. Dependencies (packages to install)

> Versions follow whatever `create-next-app@latest` resolves (Next ≥ 15, React 19, Tailwind v4); do not hand-pin unless a conflict forces it (workflow §5.6 — dependency changes are deliberate, not drive-by). Semgrep is a **CI tool**, not an npm package.

**Runtime (`dependencies`)**

- `next`, `react`, `react-dom` — framework (from create-next-app).
- `clsx`, `tailwind-merge`, `class-variance-authority` — `cn()` + variant styling (shadcn deps).
- `lucide-react` — the single icon library (code-standards §4.11).
- `tw-animate-css` — Tailwind v4 animation utilities used by shadcn.
- `zod` — env-config validation now; the single source of input shapes for `validation/` later (Invariant #16).

**Dev (`devDependencies`)**

- `typescript`, `@types/node`, `@types/react`, `@types/react-dom`.
- `tailwindcss` (v4), `@tailwindcss/postcss`, `postcss`.
- `eslint`, `eslint-config-next`, `typescript-eslint` (or `@typescript-eslint/parser` + `/eslint-plugin`), `eslint-plugin-boundaries`, `eslint-config-prettier`, `globals`.
- `prettier`, `prettier-plugin-tailwindcss`.
- `vitest`, `@vitejs/plugin-react`, `jsdom`, `vite-tsconfig-paths`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/jest-dom`, `@testing-library/user-event`.

**Tooling (not npm)** — `shadcn` CLI (via `npx`), **Semgrep** (pipeline container/task). Fonts (IBM Plex Sans/Mono) load via `next/font/google` — no package.

---

## 5. Verification checklist

A tooling-unit subset of workflow §8; every item must pass before um01 is "done."

1. **Boots & themed.** `npm run dev` serves `/`; the dark-navy top bar, IBM Plex fonts, light card, radius, and shadow all render from tokens; no raw hex or palette class anywhere in the placeholder (code-standards §4.3).
2. **Production build.** `npm run build` succeeds with no type or build errors.
3. **Type gate.** `npm run typecheck` (`tsc --noEmit`) is clean under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` + `forceConsistentCasingInFileNames`.
4. **Lint gate + boundary proof.** `npm run lint` is clean. Add a temporary `components/**` → `db/**` import and confirm ESLint **fails** with the boundary error, then remove it (proves the inward-only rule is live, not just configured).
5. **Format gate.** `npm run format:check` reports no changes.
6. **Test gate.** `npm run test` (Vitest) is green: `cn()`, `AppError`/`toHttpResponse`, `config` loader, and the placeholder render tests pass. (Route × level matrix is N/A this unit — no guarded routes yet.)
7. **SAST gate.** Semgrep runs locally and in the pipeline with the listed rulesets and reports **no high/critical** findings.
8. **Pipeline green.** `infra/azure-pipelines.yml` runs all five gates (typecheck, lint, format, test, Semgrep) green on a PR; any single failure fails the build.
9. **Structure & boundaries.** All layered folders exist (`.gitkeep` where empty); `@/*` resolves in app, tests, and ESLint; dependencies point inward; only `lib/`, `components/ui/`, `app/`, `infra/` carry real files.
10. **`lib/` contract.** `cn()`, `AppError` + `Result<T>`, `toHttpResponse` (correct code→status map + envelope), `logger`/`reportError`, and the Zod-validated server-only `config` all exist, are named exports with explicit return types, and contain no `next/*`/DB imports.
11. **No secrets, no console, no dead code.** No secret in repo/image (`.env.example` only; `.env*` git-ignored — Invariants #1/#18); `console.*` appears only in `lib/logger.ts`; no `TODO`, commented-out, or dead code (code-standards §1.10).
12. **Reserved tokens unused.** AI/Iris tokens and `--gradient-ai/-5g/-brand` are defined in `globals.css` but appear on **no** rendered surface (UI-context §0/§4).
13. **Scope honored.** No DB, Better-Auth, RBAC, admin pages, Dockerfile, deploy, or DAST were added (workflow §2.4); `components/ui/` was not hand-edited beyond token rules (workflow §5.1); strict/ESLint/Prettier/pipeline configs were not weakened (workflow §5.5).
14. **Docs in sync.** No permission-map rows change in this unit (none exist yet); confirm architecture §6 / code-standards §9 are untouched and this spec is the unit-of-record (workflow §6).
