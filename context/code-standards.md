# Code Standards — Enterprise Billing Application

> **ACTIVE** — Module-agnostic standards binding for **every module** (User Management, Product, Customer, Billing Service, Bill Run, Accounting, …).

These standards turn the architecture into enforceable conventions. Each module has a companion `<module>-code-standards.md` that adds **only** its module-specific rules (permission names, page map, domain conventions) — it never relaxes or restates the rules here. Where any doc conflicts with the architecture **Invariants**, the Invariants win and the conflict is a bug to fix.

**Stack baseline (architecture §1):** Next.js ≥ 15 (App Router, RSC) · Node ≥ 22 (Active LTS) · TypeScript `strict` · Better-Auth (scrypt) · Drizzle ORM · PostgreSQL ≥ 16 (Azure Flexible Server) · Tailwind CSS + shadcn/ui · Azure Container Apps · Azure DevOps CI/CD with SAST + OWASP ZAP DAST gates.

---

## 1. General Rules

Non-negotiable, every file, every module.

1. **Deny by default.** Access exists only with an explicit grant at the required level. Unknown routes, missing permissions, and non-`ACTIVE` accounts resolve to "no access" (inv. #4).
2. **Authorization is always server-side.** Every Server Action and Route Handler re-resolves the live `ACTIVE` user and re-checks `permission : level` before business logic. Frontend checks only show/hide — never the security boundary (inv. #3).
3. **Authorization state never lives in the session.** Status and effective permissions load from Postgres every request — never from the cookie, a JWT, or client-readable state (inv. #2).
4. **Dependencies point inward.** UI → `actions`/`app/api` → `services` → `db` → database. Inner layers never import outward. `components/`, `validation/`, `types/` are leaf modules (architecture §2).
5. **Validate all external input** against a `validation/` Zod schema at the action/handler boundary before a service (inv. #16). Treat every Server Action as a public, untrusted endpoint.
6. **No secrets in code, repo, image, or DB.** Connection strings from Key Vault + Managed Identity; provider secrets from `.env`. Never log, return, or commit a password, token, or secret (inv. #1, #18).
7. **Every mutation is audited atomically.** A state change and its `AUDIT_LOG` insert share one transaction; if the audit write fails, the mutation rolls back (inv. #11). Modules define which non-mutation events (e.g. auth events) are also written to `AUDIT_LOG` in their module standards.
8. **The audit log is append-only.** No `UPDATE`/`DELETE` against `AUDIT_LOG`; no EDIT/DELETE level for `audit_log`.
9. **Core entities are never physically deleted where the module spec says tombstone** — status flag set, dependent assignments removed in-transaction, row preserved (inv. #12). Each module's standards state which entities are tombstoned.
10. **No `TODO`, commented-out code, `console.log`, or dead code on `main`.** Use the `lib/` logger, never `console.*`.
11. **No new page or route ships without** (a) a row in the module's per-page permission map, (b) a migration adding its `PERMISSIONS` row, and (c) a route guard. A page with no declared permission is a bug, not "public" (architecture §6).
12. **Fail loud, never silent.** Catch only to translate into a typed `AppError` (§2) or an HTTP response. Never swallow an exception or hide a failure behind a fallback.
13. **Pure functions and small modules.** One thing per file; functions stay short and side-effect-free except at documented boundaries (`actions`, `app/api`, `db` repositories, `auth/` hooks).
14. **Commits are scoped and tested.** Every PR passes type-check, lint, tests (incl. the route × level matrix), and the security scan before merge (§10).
15. Stdlib does it? :use it
16. Native Platform feature? :use it
17. Installed dependency? :use it
18. One line? :one line
19. Only then: the minimum that works

---

## 2. TypeScript Conventions

1. **`strict: true`** plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `forceConsistentCasingInFileNames`. Do not relax flags per-file.
2. **No `any`.** Use `unknown` and narrow. Only escape: a line-scoped `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a one-line justification above it.
3. **No non-null assertions (`!`) across a boundary.** Narrow with a guard or Zod parse. `!` is allowed only for values the code provably owns (e.g. a ref after mount), with a comment.
4. **Explicit return types on all exported functions**, every Server Action, and every service method. Internal helpers may infer.
5. **`import type { … }`** for type-only imports; group them separately from value imports.
6. **Model fixed sets as `as const` string-literal unions, not `enum`s.**
   ```ts
   export const PERMISSION_LEVELS = ['READ', 'EDIT', 'DELETE'] as const
   export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
   ```
   Each module defines its own domain unions the same way (see module standards).
7. **Derive DB row types from Drizzle**, never hand-written: `typeof <table>.$inferSelect` / `$inferInsert`. Always derive from the Drizzle table definition — never a library's default field names where fields are remapped (inv. #19). Compose with UI/request shapes in `types/`.
8. **Zod is the single source of truth for input shapes.** Derive the type with `z.infer<typeof schema>`; never declare type and schema separately.
9. **Return typed results from services; do not throw for expected control flow.**
   ```ts
   type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }
   ```
   Throw only `AppError` subclasses (in `lib/`) for exceptional failures; map codes to HTTP status at the boundary (§5).
10. **Naming.** `PascalCase` for types/interfaces/components/classes; `camelCase` for variables/functions/keys; `SCREAMING_SNAKE_CASE` for module constants. Permission names, statuses, and levels are string literals exactly as seeded (lowercase names, uppercase levels).
11. **`interface` for extendable object/props shapes; `type` for unions, intersections, mapped types.** Be consistent within a file.
12. **No default exports except** Next.js-required files (`page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`, `route.ts`, middleware). Else named exports.
13. **Dates are `Date` in-process and ISO-8601 UTC strings on the wire.** Never pass ad-hoc date strings between layers. **Storage and reasoning are always UTC (`timestamptz`); display timezone is a presentation concern threaded as data, never baked into a formatter.** The business zone comes from one source — the `APP_TIMEZONE` env var via `getAppTimezone()` — resolved **server-side** and passed into `formatDatetime(date, locale, timezone, …)` as a required argument (the required param is what guarantees no date surface silently renders in the wrong zone). Formatters in `lib/` stay pure (they receive `locale`/`timezone`, never read config); client `components/` receive `timezone` as a prop and never read config/env directly (§1.4, inv. #14). Local-day↔UTC boundary math (e.g. a "from/to" day filter, or a billing/cut-off "today") uses the shared, total, never-throwing `lib/timezone.ts` helper — never an inline `T00:00:00.000Z` string. `<time dateTime>` stays ISO-8601 UTC (machine-readable); the human-visible `title`/text shows the configured zone. Machine logs (`lib/logger.ts`) and `audit_log` partition keys stay UTC. **DST is out of scope in v1** — a single offset is computed per request; transition-day boundaries may be off by one hour for DST zones (documented limitation, um29 §2.2).
14. **No floating promises.** `await` or explicitly `void` every promise; `no-floating-promises` is `error`.
15. **Monetary values are `string` in-process.** Postgres `numeric` maps to `string` via Drizzle end-to-end; never `number`, `parseFloat`, or float arithmetic on money. Currency is a separate ISO-4217 code field, never embedded in the amount. Arithmetic on money requires a design decision first (§6.16).

---

## 3. Next.js Rules

1. **App Router only.** No `pages/`, no `getServerSideProps`/`getStaticProps`.
2. **Server Components by default.** Add `'use client'` only for state, effects, refs, or browser APIs; keep client components small and at the leaves.
3. **Pages are thin orchestrators.** A `page.tsx` resolves its guard, fetches via a `service`, composes `components/`. No DB queries, business rules, or heavy markup (architecture §2).
4. **Mutations go through Server Actions** (`actions/**`, `'use server'`). Each, in order: (1) parse input with a `validation/` schema, (2) resolve the principal and confirm `ACTIVE`, (3) check `permission : level`, (4) call a service, (5) return a typed result. No DB access or business rules in an action.
5. **Route Handlers** (`app/api/**/route.ts`) host only auth-provider handlers, provider callbacks, and M2M endpoints — never UI or business rules.
6. **Every `(app)` route declares its permission + level** and enforces it before rendering via a shared guard (e.g. `await requirePermission('<name>', 'READ')`) at the top of the page/layout: redirect unauthenticated → `/login`, return the no-access state for authenticated-but-unauthorized (architecture §5, §6).
7. **The route guard is UX-layer defense only** — it never replaces the action/handler re-check (§1.2). Both run; the action guard is authoritative.
8. **Authz decisions and live user/permission reads are never cached.** Mark authenticated routes dynamic (`export const dynamic = 'force-dynamic'`, or `cookies()`/`headers()`) and `fetch` with `cache: 'no-store'`; no `revalidate` on authz-dependent data (inv. #20).
9. **Session-state gates (e.g. forced password change) are enforced in middleware/guard**, not per-page — see the owning module's standards for the specific flags and exempt routes.
10. **No secret or server-only value reaches the client.** Read `process.env` only in server modules; never `NEXT_PUBLIC_`-prefix a secret. The client's effective-permission map is for show/hide only.
11. **Every route segment provides `loading.tsx` and `error.tsx`.** `error.tsx` reports to GlitchTip via the `lib/` telemetry helper and shows a non-leaking message.
12. **Set `metadata`** (title, description) per page.
13. **Redirects use `redirect()` / `notFound()`.** `/` redirects to the first page the user can READ, else `/no-access`.
14. **`next/*` is never imported below the boundary.** `services/`, `db/`, `validation/`, and `auth/` (except its Next-facing handler wiring) stay framework-agnostic so the same `services/` can back a future external API.

---

## 4. Styling

Tailwind CSS + **shadcn/ui** (Radix) primitives; consistency comes from shared tokens and variants.

1. **shadcn/ui primitives live in `components/ui/`** (added via the CLI) — a managed vendor layer; don't hand-edit beyond the token rules below.
2. **Composed, app-specific components live in `components/`**, built from primitives + Tailwind. No business logic or DB access (architecture §2).
3. **Theme through CSS variables, not literal colors.** Use semantic tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `bg-destructive`) from `globals.css`. Never a raw hex or fixed palette class (e.g. `bg-red-600`) in a component.
4. **Compose classes with `cn()`** (`clsx` + `tailwind-merge`). No string concatenation or conflicting conditional classes.
5. **No inline `style={{…}}`** except genuinely dynamic values (e.g. a computed offset), with a comment.
6. **Avoid arbitrary-value utilities** (`w-[437px]`); use the scale. An arbitrary value needs a one-line justification.
7. **Variants come from `cva`.** Define each set once (e.g. `Button`: `default | destructive | outline | ghost`); pages pick a variant, never re-style a primitive ad hoc.
8. **One shared component per recurring indicator** (badges, status chips). A domain value never gets two visual treatments; modules name their shared indicator components in their standards.
9. **Accessibility is mandatory.** Use shadcn/Radix for dialogs, dropdowns, form controls; every interactive element is keyboard-reachable with a visible focus ring; every input has a `<label>`.
10. **Mobile-first responsive utilities** (`sm: md: lg:` upward). Data tables collapse or scroll on narrow viewports.
11. **Icons from one library** (`lucide-react`). Don't mix sets.
12. **Forms use shadcn `Form` + React Hook Form + Zod resolver**, with the resolver schema imported from `validation/` so client and server share one shape.

---

## 5. API Routes

Route Handlers are the only HTTP API surface — thin and uniform.

1. **Location/shape.** All at `app/api/**/route.ts`, exporting named method functions (`GET`, `POST`, …). No business rules; delegate to `services`.
2. **Auth-provider routes are owned by the provider integration** (`auth/` config and hooks); no custom logic inside the provider's handler path.
3. **Every non-public handler enforces auth first:** resolve the session, load the live `ACTIVE` user and effective permissions, check `permission : level`, then proceed. Insufficient → **403**.
4. **Validate with a `validation/` Zod schema** before use. Failed parse → **422** with field errors; never pass unparsed input to a service.
5. **Status codes.** `200` read · `201` created · `204` no content · `400` malformed · `401` unauthenticated · `403` unauthorized · `404` not found (or to avoid leaking existence) · `409` conflict · `422` validation · `500` unexpected. No others.
6. **JSON envelopes.** Success `{ "data": <payload> }`; failure `{ "error": { "code": <AppErrorCode>, "message": <safe> } }`. `code` is a stable machine string (`FORBIDDEN`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`); `message` carries no secret, stack trace, or raw SQL.
7. **Map `AppError` to status centrally** in one `lib/` helper (`toHttpResponse(error)`); handlers don't build envelopes by hand.
8. **Naming.** Lowercase `kebab-case`, resource-oriented; verbs via HTTP methods (`POST` create, `PATCH`/`PUT` update, `DELETE` tombstone) — never a verb in the path.
9. **Idempotency/safety.** `GET` is side-effect-free (no audit write). Mutating methods run inside the repository transaction that writes the audit row.
10. **No app-layer rate limiting in v1** (architecture §1); rely on the auth provider plus any module-defined lockout policy. No ad-hoc throttling without a design review.
11. **CORS stays closed by default.** Internal same-origin app; no cross-origin without an architecture decision. (A future external API is its own deployment unit, not a CORS exception.)

---

## 6. Data and Storage Rules

One PostgreSQL database; no file storage or cache tier in v1 (architecture §3, §4).

1. **`db/**` is the only place SQL/queries live.** No `app/**`, `actions/**`, `services/**`, or `auth/**` file imports the DB client or runs raw SQL; all access via repositories (inv. #14).
2. **Drizzle owns schema and migrations.** No manual production DDL; schema/seed changes are committed migration files applied as one ordered, gated CI/CD step (inv. #15).
3. **One shared DB, one `core` schema.** The shared-core tables (identity, RBAC, session, config, audit) live in `core`. No module creates its own identity/RBAC/session/config/audit tables; module domain tables go in their own schema (`product`, `customer`, `billing`, `accounting`, …) and reference `core` by FK (architecture §4).
4. **The whole database uses snake_case columns.** Third-party-managed tables keep their semantics but have fields mapped to snake_case, declared once in the owning integration (inv. #19). Our tables are snake_case natively. No camelCase columns; the mapping is never bypassed by hand-written SQL.
5. **Mutations are transactional and atomically audited.** A repository write and its `AUDIT_LOG` insert share one transaction; the row records actor, timestamp, event type, target entity/id, before/after JSON.
6. **`AUDIT_LOG` is INSERT-only.** The app DB role has no `UPDATE`/`DELETE`; no repository updates or deletes audit rows.
7. **Tombstone where the module spec says so, never hard-delete.** Status flag set, dependent assignments removed in the same transaction, row preserved; partial unique indexes exclude tombstoned rows so natural keys can be reused (inv. #12).
8. **The permission registry is code-seeded only.** No code path inserts `PERMISSIONS` rows; each module adds rows via a committed migration (inv. #7).
9. **Effective permission is computed in exactly one `auth/` helper:** union across roles, highest level wins (`DELETE ⊃ EDIT ⊃ READ`). No other code re-implements resolution (inv. #5).
10. **Credentials exist only as the auth provider's hashes** in the provider's account storage. No password, hash, or token is logged, returned, or stored elsewhere (inv. #1).
11. **Sessions are the source of truth in the DB.** The cookie holds only the token. Revocation is zero-latency: disabling a principal deletes their session rows; session validity reads `expires_at` (inv. #8; architecture §5).
12. **No cache, no file storage in v1.** No cache tier, in-memory store, or read-through cache for authz/user data; no uploads. Later, binaries → Azure Blob, DB stores a reference (architecture §3).
13. **No `organization_id` / tenant scoping / RLS.** Single-tenant; customer (MNO) records are domain data, not tenants (inv. #21).
14. **The app DB role is least-privilege:** DML on domain tables, INSERT-only on `core.AUDIT_LOG`, no runtime DDL (architecture §4).
15. **No secret in the database.** `SYSTEM_CONFIG` holds only non-secret params; `is_secret` is reserved and always `FALSE` in v1. Provider secrets live in `.env` (inv. #18).
16. **Monetary columns are `numeric`, never `float`/`double`**, mapped to `string` in Drizzle (§2.15). `currency` is its own ISO-4217 column.
17. **JSONB is schema-guarded** (architecture §3). A JSONB column is typed at the Drizzle table via `.$type<T>()` where `T` is `z.infer` of the owning `validation/` schema (discriminated per type column where applicable, e.g. per `pricing_model`). Every write — **including seeds** — passes that schema first; no unvalidated JSONB reaches the DB. No junk-drawer JSONB.
18. **Human-readable IDs** (architecture §3): domain-table IDs are a fixed prefix + zero-padded per-table DB sequence (e.g. `PRDOFR000001`). ID assembly happens in the DB layer (default expression or repository insert) — never in services or UI.

---

## 7. File Organization

Folder ownership and dependency direction come from architecture §2; these make placement concrete.

**Top-level layout**

```
app/
  (auth)/            # unauthenticated / session-bootstrap pages
  (app)/             # authenticated module pages + shared shell layout; one subfolder per module (administration/, products/, …)
  api/               # Route Handlers (auth provider, callbacks, m2m)
components/
  ui/                # shadcn/ui primitives (managed vendor layer)
  ...                # composed app components
actions/             # Server Actions ('use server') — mutation entry points
validation/          # Zod schemas (single source of input shapes)
services/            # business logic / use cases (framework-agnostic)
db/                  # Drizzle schema, migrations, seeds, repositories
auth/                # auth-provider config, field mapping, hooks, permission registry, resolver
types/               # shared TS types (cross-layer)
lib/                 # logger/telemetry, AppError, config, cn(), helpers
tests/               # unit, integration, e2e (incl. route × level matrix)
infra/               # IaC, pipelines (incl. OWASP ZAP DAST stage), Dockerfile, env templates
```

1. **One responsibility per folder; dependencies point inward** (§1.4). Enforce with an ESLint import-boundary rule.
2. **File naming is `kebab-case`** (`user-table.tsx`, `create-user.schema.ts`), except Next.js-reserved filenames.
3. **One React component per file**, `PascalCase`, file `kebab-case` matching it (`StatusBadge` → `status-badge.tsx`).
4. **Validation schemas** are `<entity>-<operation>.schema.ts` in `validation/`, exporting a `…Schema` const + inferred type.
5. **Services** grouped by domain (`services/<domain>/…`), exposing named use-case functions, not god-classes.
6. **Repositories** live in `db/repositories/<entity>.ts` (only exporters of query functions). Tables in `db/schema/<area>.ts`; migrations in `db/migrations/`; seeds in `db/seeds/`.
7. **Shared types go in `types/`** only when cross-layer; single-component types stay co-located.
8. **`auth/` holds** the auth-provider config + field mapping, providers, sign-in hooks, the code-seeded permission registry, and the single resolver. No page-specific logic.
9. **Tests mirror the source tree** and must include the route × level matrix. A guarded route isn't done until its matrix tests exist.
10. **No deep relative import chains.** Use the `@/…` alias cross-folder; relative imports only for same-folder siblings.
11. **Barrels (`index.ts`) only for `components/ui/`**, no import cycles, no cross-boundary re-exports.

---

## 8. Permission Naming Rules

1. **Permission names are lowercase `snake_case`, one per page/module**, matching `PERMISSIONS.permission_name`. Each module lists its names in its module standards.
2. **Levels are `READ`, `EDIT`, `DELETE`** with `DELETE ⊃ EDIT ⊃ READ`. View = `READ`; mutate = `EDIT`; destructive/tombstone = `DELETE`.
3. **Every page declares one permission name** for read; its mutations use the same name at a higher level. No per-button permission names.
4. **A new page needs a new permission name** added by migration **and** a new row in the module's per-page permission map, reviewed before shipping (§1.11).
5. **Reference permissions by a typed constant** defined once in `auth/` (e.g. `PERMISSIONS.USERS = 'users'`) so a typo is a compile error.

---

## 9. Per-Page Permission Map

Every module maintains an authoritative **Page → Route → Component → Permission** table in its own `<module>-code-standards.md`, mirroring the architecture's route table. New pages are appended before they ship; component names in the table are the binding convention so the page ↔ route ↔ component ↔ permission chain stays traceable. See `user-management/usrmgmt-code-standards.md` §2 and `product-management/prodmgmt-code-standards.md` §8 for the current maps.

---

## 10. Enforcement & CI Gates

A change merges only when all pass:

1. **`tsc --noEmit`** clean under the strict config (§2).
2. **ESLint** clean, incl. the import-boundary rule (§1.4, §7.1), `no-floating-promises`, `no-explicit-any` (only justified, line-scoped disables).
3. **Prettier** applied (one shared config).
4. **Test suite** green, incl. the route × level matrix (§7.9) and each module's guardrail tests from its *Success Criteria*.
5. **Migrations** present and ordered for any schema/permission-seed change; no manual DDL (§6.2).
6. **No secret** added to repo, image, or DB (§1.6); secret scanning passes.
7. **Security scan passes.** SAST plus the **OWASP ZAP** DAST baseline against the staging revision; no high/critical finding ships (architecture §1, inv. #23). Burp Suite Community for manual pen-testing outside the gating pipeline.

A PR that adds a page without its permission-map row, permission migration, and guard is rejected at review.
