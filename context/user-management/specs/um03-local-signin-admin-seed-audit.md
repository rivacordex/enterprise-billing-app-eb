# Spec: um03 — Local Sign-in + Seeded Break-glass Admin + Audit Foundation

- **Boundary:** AUTH / APP (+ DB seed)
- **Dependencies:** Unit um02 (Drizzle connection, `core` schema, four identity tables, repository scaffold, `lib/config`).
- **Source sections:** overview §"Core User Flow", §"Authentication & sessions", §"Audit Events"; architecture §1 (Better-Auth, scrypt), §2 (folder ownership: `app/(auth)/`, `auth/`, `app/api/`, `db/`), §3 (storage model — HTTP-only cookie, session row is authoritative), §5 (auth model — credential provider, DB-backed sessions, seeded admin), §7 (no background tasks in this unit); code-standards §1.7 (atomic audit writes), §2.6 (`as const` unions), §3.2 (Server Components default), §3.5 (Route Handlers — Better-Auth owns `app/api/auth/[...all]`), §4 (Tailwind/shadcn, tokens), §6.1 (DB access via repositories only), §6.5 (transactional audit write), §6.6 (INSERT-only), §7 (file org), §8 (permission naming); ui-context §0 (login gradients allowed), §3.4 (status badges defined here for future use), §5 (typography). Invariants touched: **#1** (no plaintext credentials), **#2** (authz never in session), **#11** (audit log append-only; every successful sign-in audited), **#14** (DB access only in `db/**`), **#15** (one migration history), **#17** (stateless), **#18** (secrets in env only), **#19** (Better-Auth field mapping declared once in `auth/`).

> This unit wires Better-Auth with the credential provider, declares the snake_case field mapping once, ships the `/login` page and `LoginForm`, introduces the `AUDIT_LOG` table and its atomic INSERT-only repository helper, seeds the permanent break-glass local ADMIN user (ACTIVE, scrypt-hashed password from env), and writes a `LOCAL_LOGIN` audit row on every successful local sign-in. **Not in this unit:** per-account lockout (um04); RBAC tables, grants, role assignment (um05); the effective-permission resolver and route guards (um06); the `/set-password` forced-change page and its middleware (um09); Entra/SSO provider (um10); any user-facing page requiring an ADMIN permission check.

---

## 1. Goal

Wire Better-Auth with the credential provider and snake_case field mapping (declared once in `auth/`), ship the `/login` page + `LoginForm`, introduce the `AUDIT_LOG` table and the atomic audit-INSERT helper, seed the permanent break-glass local ADMIN user (ACTIVE, password from env), and write a `LOCAL_LOGIN` audit event in the same database transaction as the `last_login_datetime` update on every successful local sign-in — so that after this unit, signing in at `/login` as the seeded admin produces a DB-backed session row and an audit row, both verifiable by direct DB inspection.

---

## 2. Design

### 2.1 Visual: `/login` page

The login page is the one marketing-style surface in the admin tool. Per ui-context §0 and §4, `--gradient-brand` (indigo → magenta, `linear-gradient(135deg, #2E45A9 0%, #E6007E 100%)`) is permitted here and on `/no-access`; it must not appear on any of the four Administration pages.

**Layout.** Vertically and horizontally centered card on a full-viewport branded background. The background uses `--gradient-brand` as a subtle body wash (low-opacity overlay or gradient on `--surface-nav`), not a garish full-bleed poster — the aesthetic is formal telecoms, not consumer splash. The card sits on `--surface-card` (`#FFFFFF`) with `--shadow-lg` (`0 8px 24px rgba(17,20,26,0.12)`) and `--radius-lg` (`8px`). Card width is capped at `440px`; it fills the viewport width with horizontal padding on narrow screens (mobile-first per code-standards §4.10).

**Inside the card:**

1. App logo / wordmark (placeholder in this unit; the real asset is a later concern). Centered at top.
2. Page heading: "Sign in" — `--text-h2` (22px/30px SemiBold), `--text-primary`.
3. Supporting copy: "Use your assigned credentials to access the system." — `--text-body` (14px/22px), `--text-muted`.
4. `LoginForm` (client component — §2.2).
5. No "Forgot password", no "Sign up", no social sign-in links. These are explicitly out of scope (overview §"Out of Scope") and must not appear.

**Error states.** Inline, below the submit button, using `--danger-500` text. Three distinct messages (all surfaced from the Better-Auth response, not by guessing which field failed):

- Invalid credentials: `"Invalid email or address."` — generic; never reveal which field is wrong (Invariant #1).
- Account not eligible to sign in (PENDING, DISABLED, DELETED): `"Your account is not currently active. Contact your administrator."` — no status detail leaked.
- Account locked (introduced fully in um04 but the error surface exists in um03): `"Your account has been temporarily locked. Contact your administrator."` — shown when the hook returns a locked error. In um03, lockout logic itself does not exist; this message string is placed correctly now so um04 only adds the triggering logic.

**Typography (ui-context §5).** Use IBM Plex Sans (with Inter fallback). All form labels use `--text-body` (14px), helper/error text uses `--text-caption` (12px).

### 2.2 `LoginForm` client component

Lives at `components/login-form.tsx` (`'use client'`). Constructed with shadcn `Form` + React Hook Form + Zod resolver (code-standards §4.12). The Zod schema is imported from `validation/login.schema.ts` — the resolver uses this schema so client-side and any server-side reparsing share one shape.

Fields:

- **Email** — `<Input type="email" autoComplete="email" />` with a visible `<Label>`.
- **Password** — `<Input type="password" autoComplete="current-password" />` with a show/hide toggle (Lucide `Eye`/`EyeOff`). The toggle is keyboard-accessible and labeled.
- **Sign in button** — primary variant, full-width, shows a spinner and becomes disabled during submission (no double-submit). Label: "Sign in". `--action-primary-bg` (`#2E45A9`).

On successful sign-in Better-Auth sets the session cookie and the component calls `router.push('/')`. The root `/` is a placeholder redirect target in this unit; it becomes meaningful in um06.

On error, the component surfaces the message inline below the button (not a toast). The error string is derived from the Better-Auth client response code, mapped to the three user-facing messages in §2.1 — never the raw error object.

Every interactive element has a visible focus ring (`--focus-ring`: `0 0 0 2px #FFFFFF, 0 0 0 4px #2E45A9`, code-standards §4.9).

### 2.3 Better-Auth structural decisions

**Single config export in `auth/`.** Better-Auth is configured once in `auth/index.ts` via `betterAuth({…})`. The export is `auth` (server-side handler instance). A separate `auth/client.ts` exports the client-side `authClient` instance (initialized with `createAuthClient` from `better-auth/react` or equivalent). Nothing outside `auth/` re-declares or wraps the Better-Auth config.

**Field mapping declared here, never bypassed.** The field mapping is the bridge between Better-Auth's camelCase internal model names and the snake_case columns in `core`. It is declared exactly once — inside the `betterAuth()` call in `auth/index.ts` — and covers all four managed models. Application code derives row types from the Drizzle table definitions (as established in um02), not from Better-Auth's default field names. The mapping must never be replicated or short-circuited by hand-written SQL (Invariant #19, code-standards §6.4).

**Database adapter.** Better-Auth's Drizzle adapter (imported from `better-auth/adapters/drizzle` or the equivalent path in the installed version) receives the `db` handle imported from `db/client.ts`. The adapter is the only path through which Better-Auth reads and writes its managed tables at runtime; it does not bypass the repository layer for its own model operations, and our application code does not duplicate those writes.

**Session cookie.** HTTP-only, `SameSite: Lax`, `Secure: true` in production (controlled by Better-Auth's `advanced.useSecureCookies` config, set conditionally from `config.nodeEnv`). Expiry defaults to Better-Auth's default (configurable later). The cookie carries only the session token; the session row in `core.session` is the authoritative source of truth (architecture §3, §5). No authz state is placed in the cookie (Invariant #2).

**Credential provider.** Enabled via Better-Auth's `emailAndPassword` plugin (or built-in credential block depending on the installed version). Scrypt hashing is Better-Auth's built-in behavior — no application code invokes crypto directly. `autoSignIn: true` so that successful credential sign-in immediately establishes a session (Better-Auth default).

**Sign-in hook for audit + `last_login_datetime`.** Better-Auth exposes lifecycle hooks (the exact API surface depends on the version; use `after` hooks or the `emailAndPassword.onSignIn` callback). The hook fires after a successful credential sign-in. Its responsibilities are exactly two: update `appuser.last_login_datetime` and insert a `LOCAL_LOGIN` audit row. Both happen in a single `db.transaction(async (tx) => { … })` call so they are atomic with each other (code-standards §1.7, §6.5). The sign-in itself (session creation) is handled by Better-Auth before the hook fires; if the hook's transaction fails, the error is logged via `lib/logger` and the sign-in proceeds (the session already exists). The hook accesses the database via repository functions only — never raw SQL (code-standards §6.1, Invariant #14).

**Status check in the sign-in hook.** The hook must verify `appuser.status === 'ACTIVE'` before allowing the sign-in to complete. If status is not ACTIVE (PENDING, DISABLED, DELETED), the hook must signal Better-Auth to reject the attempt. Better-Auth's credential provider supports a `checkCredentials` or `authorize` callback for this purpose — consult the installed version's docs. This guard is Invariant #4 (deny by default; non-ACTIVE accounts resolve to no access). The PENDING → ACTIVE activation flow (first login) is **not** in this unit — the seeded admin is already ACTIVE and all other users are um08+.

**`auth/` folder structure for um03:**

```
auth/
  index.ts      # betterAuth() config, field mapping, credential provider, sign-in hook
  client.ts     # createAuthClient() — client-side instance (imported by LoginForm)
```

No permission registry, resolver, or lockout hook yet (those are um05 and um04 respectively). Those files are added in their owning units.

### 2.4 `AUDIT_LOG` table decisions

The table is introduced just-in-time for the first audited event (Invariant #11; build plan rule 3). It lives in the `core` schema alongside the identity tables. Its schema file is `db/schema/audit.ts`; drizzle-kit generates its migration as the next ordered file after um02's migration.

**Append-only contract.** The `AUDIT_LOG` table has no `updated_at` column — there is nothing to update. The application DB role has INSERT-only on this table (enforced in um25; documented here as the target). Application code must never issue UPDATE or DELETE against `audit_log` (code-standards §6.6, §6.8, Invariant #11).

**`actor_user_id` FK.** References `core.appuser(user_id)` with `ON DELETE SET NULL`. APPUSER rows are never physically deleted (Invariant #12), so this FK will never trigger in practice. `SET NULL` is nonetheless specified as a safety contract: if the constraint were ever exercised, the audit row is preserved with `actor_user_id = NULL` rather than cascade-deleted, keeping the log intact.

**`before_data` / `after_data` typing.** Drizzle `jsonb` columns, nullable. For mutation events, these carry a JSON snapshot of the relevant fields before and after the change. For sign-in events (`LOCAL_LOGIN`, `SSO_LOGIN`), `before_data` is `null`; `after_data` carries `{ "last_login_datetime": "<ISO-8601 UTC string>" }` — the only state change on the `appuser` row during a sign-in.

**`event_type` values.** Stored as text (not a Postgres enum) so new event types can be added by later modules without a DDL change. The full registry of v1 event type strings is defined once as an `as const` union in `types/audit.ts` (code-standards §2.6). In um03 only `LOCAL_LOGIN` is emitted.

### 2.5 Admin seed decisions

The seed creates the one permanent break-glass account that allows signing in even when Entra is unconfigured or unavailable. It is idempotent — re-running it does not create a duplicate or fail.

**Implementation form.** A programmatic TypeScript seed script at `db/seeds/seed-admin.ts`, run via `npm run db:seed`. It is separate from the SQL migration because it must hash a runtime-supplied password using Better-Auth's scrypt function — embedding a pre-computed hash would require knowing the password at spec-write time, defeating the env-sourcing contract. The `db:migrate` npm script is extended to also call the seed: `npm run db:migrate && npm run db:seed` (or equivalent compound command), so the gated CI/CD pipeline (um25) applies schema and seed in one step.

**Idempotency.** The seed checks whether an `appuser` row with `user_email = config.bootstrapAdminEmail` already exists before inserting. If found, it skips (no update). This means changing `BOOTSTRAP_ADMIN_PASSWORD` after initial seeding does not rotate the password — a deliberate choice; password rotation for the break-glass account goes through the admin UI's reset flow (um15) once it exists, or a manual DB operation. The spec notes this explicitly so implementors are not surprised.

**What is seeded.** Two rows in one transaction:

1. `core.appuser` — `user_name: 'System Administrator'`, `user_email: <BOOTSTRAP_ADMIN_EMAIL>`, `email_verified: false`, `auth_method: 'LOCAL'`, `status: 'ACTIVE'` (break-glass is active from day one; no first-login flow), `force_password_change: false`, `failed_login_count: 0`.
2. `core.account` — `provider_id: 'credential'`, `provider_account_id: <the appuser's user_id>`, `password: <scrypt hash of BOOTSTRAP_ADMIN_PASSWORD>`.

No RBAC rows (ROLE_ASSIGN) are seeded here — that is um05's responsibility. The admin can sign in in um03 but has no granted permissions until um05.

**Password hashing in the seed.** Use Better-Auth's exported scrypt hash utility (the exact import path — e.g., `better-auth/crypto` or `better-auth/utils/hash` — must be verified against the installed version's exports). This guarantees the stored hash is exactly the format Better-Auth's `verify` function expects. Do not use Node's `crypto.scrypt` directly; the parameters must match Better-Auth's defaults precisely.

---

## 3. Implementation

### 3.1 `lib/config` — new env surface

Extend the um02 Zod config schema (the only `process.env` reader, code-standards §3.10) with four new required fields:

| `process.env` key          | `config` property               | Zod type             | Fail-loud guard                               |
| -------------------------- | ------------------------------- | -------------------- | --------------------------------------------- |
| `BETTER_AUTH_SECRET`       | `config.betterAuthSecret`       | `z.string().min(32)` | Yes — must be at least 32 characters          |
| `BETTER_AUTH_URL`          | `config.betterAuthUrl`          | `z.string().url()`   | Yes — must be a valid URL                     |
| `BOOTSTRAP_ADMIN_EMAIL`    | `config.bootstrapAdminEmail`    | `z.string().email()` | Yes                                           |
| `BOOTSTRAP_ADMIN_PASSWORD` | `config.bootstrapAdminPassword` | `z.string().min(16)` | Yes — enforces a minimum seed password length |

All four are required; the config loader fails loud on absence (code-standards §1.12). Add all four to `.env.example` with placeholder values and comments explaining that `BOOTSTRAP_ADMIN_PASSWORD` is used once at seed time to generate the scrypt hash and can be removed from `.env` afterward (the hash lives in the DB, not the env).

In production (um25), `BETTER_AUTH_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` are sourced from Key Vault via Managed Identity. Add a header comment in `lib/config.ts` above these entries noting that.

### 3.2 `db/schema/audit.ts` — `AUDIT_LOG` table

New schema file alongside `db/schema/identity.ts`. Import `core` from `identity.ts` (the `pgSchema('core')` object is defined once and imported, not re-declared).

| Column             | Drizzle type  | Constraints                                                 |
| ------------------ | ------------- | ----------------------------------------------------------- |
| `audit_id`         | `uuid`        | PK, `.defaultRandom()`                                      |
| `event_type`       | `text`        | NOT NULL                                                    |
| `actor_user_id`    | `uuid`        | nullable; FK → `core.appuser(user_id)` `ON DELETE SET NULL` |
| `target_entity`    | `text`        | nullable                                                    |
| `target_id`        | `text`        | nullable                                                    |
| `before_data`      | `jsonb`       | nullable                                                    |
| `after_data`       | `jsonb`       | nullable                                                    |
| `created_datetime` | `timestamptz` | NOT NULL; default `now()`                                   |

No `updated_at` column (append-only, §2.4). No CHECK constraint on `event_type` — new types are added by later modules without DDL.

Indexes:

- Non-unique index on `actor_user_id` (FK lookups, future "audit by actor" query).
- Non-unique index on `event_type` (future "audit by event type" filter, overview §"Audit Log" viewer).
- Non-unique index on `created_datetime` (date-range filter).

After defining this table, run `npm run db:generate` to emit the next ordered SQL migration file (e.g. `0001_audit_log.sql`). Hand-review the generated SQL before committing: confirm table is in `core`, column names are snake_case, the `SET NULL` FK action is present, `audit_id` is UUID with `gen_random_uuid()` default, no `updated_at`.

### 3.3 `db/schema` index updates

Update `db/schema/index.ts` (the combined schema object imported by `db/client.ts` and `drizzle.config.ts`) to also re-export from `audit.ts`. The pattern mirrors the existing identity re-export.

Derive and export the `AuditLog` and `AuditLogInsert` row types from `$inferSelect` / `$inferInsert` (code-standards §2.7). Re-export the cross-layer subset through `types/audit.ts`.

### 3.4 `types/audit.ts` — event-type registry

Define the `AuditEventType` constant and union once (code-standards §2.6):

```ts
export const AUDIT_EVENT_TYPES = [
  "LOCAL_LOGIN",
  "SSO_LOGIN",
  "USER_FIRST_LOGIN",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_DELETED",
  "USER_LOCKED",
  "USER_UNLOCKED",
  "USER_PASSWORD_RESET",
  "USER_PASSWORD_CHANGED",
  "USER_AUTH_METHOD_CHANGED",
  "ROLE_CREATED",
  "ROLE_UPDATED",
  "ROLE_DELETED",
  "ROLE_ASSIGNED",
  "ROLE_REVOKED",
  "PERMISSION_MAPPING_CHANGED",
  "SYSTEM_CONFIG_CHANGED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
```

The full registry is defined in um03 even though only `LOCAL_LOGIN` is emitted here, so later units can reference `AuditEventType` without reopening this file. Only `LOCAL_LOGIN` gets a test in um03; others are tested in their owning units.

### 3.5 `db/repositories/audit.repository.ts`

Single repository function for the INSERT-only audit table:

```ts
export async function insertAuditEvent(
  db: Database,
  event: {
    eventType: AuditEventType;
    actorUserId: string | null;
    targetEntity: string | null;
    targetId: string | null;
    beforeData: Record<string, unknown> | null;
    afterData: Record<string, unknown> | null;
  },
): Promise<void>;
```

The parameter is typed explicitly (not `AuditLogInsert` directly) so callers are not forced to construct the full Drizzle insert shape — the repository handles the mapping. Internally it issues a single `db.insert(auditLog).values({…})` and returns `void`. The function accepts either the pool `db` or a transaction `tx` as its first argument (the `Database` type alias from um02), composing into the caller's transaction.

No read functions exist on this repository in um03. The audit log read path (the Audit Log page, um24) adds query functions in that unit.

### 3.6 `db/repositories/appuser.repository.ts` — add `updateLastLogin`

Extend the um02 stub with one write function:

```ts
export async function updateLastLogin(
  db: Database,
  userId: string,
  loginDatetime: Date,
): Promise<void>;
```

Issues a `db.update(appuser).set({ last_login_datetime: loginDatetime }).where(eq(appuser.user_id, userId))`. Used exclusively by the sign-in hook. Explicit return type; no business logic.

### 3.7 `auth/index.ts` — Better-Auth config + field mapping

The full `betterAuth()` configuration. Key sections:

**Database adapter.** Use Better-Auth's Drizzle adapter, passing the `db` handle from `db/client.ts`. The adapter operates on the Drizzle-typed tables via the schema object.

**`baseURL`.** Set to `config.betterAuthUrl` (from §3.1).

**`secret`.** Set to `config.betterAuthSecret`.

**Field mapping (Invariant #19).** Declared inside the `betterAuth()` call, covering all four managed models. The mapping binds Better-Auth's camelCase field names to the snake_case column names defined in um02's schema. The exact config key depends on the Better-Auth version (may be `user.fields`, `modelName`, etc.); consult the installed version's docs. The target columns are:

_`user` model → `core.appuser`:_
| Better-Auth field | Snake_case column |
|---|---|
| `id` | `user_id` |
| `name` | `user_name` |
| `email` | `user_email` |
| `emailVerified` | `email_verified` |
| `createdAt` | `created_datetime` |
| `updatedAt` | `last_modified_datetime` |

The model itself is renamed from `user` to `appuser` (the physical table name).

_`session` model → `core.session`:_
| Better-Auth field | Column |
|---|---|
| `id` | `session_id` |
| `userId` | `user_id` |
| `token` | `session_token` |
| `expiresAt` | `expires_at` |
| `ipAddress` | `ip_address` |
| `userAgent` | `user_agent` |
| `createdAt` | `created_datetime` |
| `updatedAt` | `last_modified_datetime` |

_`account` model → `core.account`:_
| Better-Auth field | Column |
|---|---|
| `id` | `account_id` |
| `userId` | `user_id` |
| `providerId` | `provider_id` |
| `accountId` | `provider_account_id` |
| `accessToken` | `access_token` |
| `refreshToken` | `refresh_token` |
| `idToken` | `id_token` |
| `accessTokenExpiresAt` | `access_token_expires_at` |
| `refreshTokenExpiresAt` | `refresh_token_expires_at` |
| `createdAt` | `created_datetime` |
| `updatedAt` | `last_modified_datetime` |

_`verification` model → `core.verification`:_
| Better-Auth field | Column |
|---|---|
| `id` | `verification_id` |
| `identifier` | `identifier` |
| `value` | `value` |
| `expiresAt` | `expires_at` |
| `createdAt` | `created_datetime` |
| `updatedAt` | `last_modified_datetime` |

**Credential provider.** Enable Better-Auth's email-and-password plugin. No email verification (`requireEmailVerification: false`). No automatic sign-up (`disableSignUp: true` or equivalent — this application never allows self-registration; Invariant #10). The credential provider must reject sign-in attempts for any user not found in the database.

**Status check.** Configure a `checkCredentials` (or `authorize`) callback on the credential provider that loads the user's `status` from `core.appuser` via a repository call and returns an error if status is not `'ACTIVE'`. This check runs before Better-Auth creates a session. The error payload returned must be distinguishable from "wrong password" so the hook (§3.7 below) and the client can map it to the correct user-facing message.

**Sign-in hook for audit.** Register an `after` hook on the credential sign-in path. After Better-Auth confirms credentials are valid and before returning the response:

1. Obtain the signed-in user's `user_id` from the hook context.
2. Open `db.transaction(async (tx) => { … })`.
3. Inside the transaction, call `updateLastLogin(tx, userId, new Date())`.
4. Inside the same transaction, call `insertAuditEvent(tx, { eventType: 'LOCAL_LOGIN', actorUserId: userId, targetEntity: 'appuser', targetId: userId, beforeData: null, afterData: { last_login_datetime: <ISO string> } })`.
5. Commit. If the transaction throws, catch it, log the error via `lib/logger` (never `console.*`), and allow the sign-in to continue (the session row was already committed by Better-Auth). The hook must not re-throw in a way that would void the established session.

The hook must not branch on authz logic, call services, or do anything beyond the `last_login_datetime` + audit write. All other post-sign-in logic (e.g., first-login activation, password change enforcement) belongs to later units.

**Session config.** HTTP-only cookie, `sameSite: 'lax'`, `secure: config.nodeEnv === 'production'`. No authz fields in the session (Invariant #2).

**No `image` field mapping.** `image` is intentionally absent from the user model (documented in um02 §2.1.1); do not map it.

### 3.8 `auth/client.ts` — client-side auth instance

Exported as `authClient`, initialized with `createAuthClient({ baseURL: process.env.NEXT_PUBLIC_APP_URL })`. Note: `NEXT_PUBLIC_APP_URL` is a non-secret public env var (the app's base URL for client routing). Add it to `.env.example`. This is the **only** `NEXT_PUBLIC_` variable introduced in this unit and it is non-sensitive.

`auth/client.ts` is a client-safe module (no server secrets). It is the only module the `LoginForm` imports from `auth/`. It must never import `auth/index.ts` (the server config).

### 3.9 `app/api/auth/[...all]/route.ts` — Better-Auth handler

```ts
import { auth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

(Exact import path for `toNextJsHandler` may vary by Better-Auth version; consult the installed version's Next.js adapter docs.) No custom logic here — Better-Auth config and hooks live in `auth/index.ts`. This file exists only to mount the handler.

`export const dynamic = 'force-dynamic'` is set on this route to opt out of Next.js static generation (code-standards §3.8).

### 3.10 `validation/login.schema.ts`

```ts
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email({ message: "Enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
});

export type LoginInput = z.infer<typeof loginSchema>;
```

Client-side validation through the React Hook Form resolver using this schema catches obvious errors before a network round-trip. The schema is the single source for both client validation and any server-side reparsing. Password is validated only for presence here — strength validation would be on the set-password form (um09), not sign-in.

### 3.11 `app/(auth)/login/` — page files

Three files:

**`page.tsx` (Server Component, default export `LoginPage`):**

- Sets page `metadata` (`title: 'Sign In'`, `description: 'Sign in to the Enterprise Billing System'`, code-standards §3.12).
- Resolves the current session server-side (via Better-Auth's session-reading helper for Next.js). If a valid session exists, `redirect('/')` immediately — the login page is public but not useful if already authenticated.
- Renders the branded background and centered card layout (§2.1), with `<LoginForm />` inside.

**`loading.tsx`:** Skeleton card matching the login card's dimensions. No spinner text; keep it minimal.

**`error.tsx` (`'use client'`):** Reports to GlitchTip via the lib telemetry helper; shows a generic message ("Something went wrong. Please try again.") — no stack trace or internal detail.

### 3.12 `components/login-form.tsx` — `LoginForm`

`'use client'`. Uses `authClient.signIn.email({ email, password, callbackURL: '/' })` (or the equivalent method in the installed Better-Auth client version) inside the React Hook Form `onSubmit`. Handles the response:

- Success: Better-Auth's client sets the cookie and `router.push('/')` navigates.
- Error with status-not-active code: display the not-active message (§2.1).
- Error with locked code: display the locked message (§2.1).
- Any other credential error: display the generic invalid-credentials message.
- Network or unexpected error: display "Something went wrong. Please try again."

The component must not attempt to read `error.message` directly — map from the response `code` or `status` so the user-facing string is always one of the pre-defined messages, never a raw internal string.

### 3.13 `db/seeds/seed-admin.ts` — break-glass admin seed

A standalone TypeScript script (run via `npm run db:seed`, executed with `tsx --env-file=.env`).

Logic:

1. Import `config` from `@/lib/config` — reads `bootstrapAdminEmail` and `bootstrapAdminPassword`. The script fails loud if either is absent (Invariant #18).
2. Connect to the DB using a dedicated `postgres(config.databaseUrl, { max: 1 })` client (not the pool from `db/client.ts`).
3. Check whether an `appuser` row with `user_email = config.bootstrapAdminEmail` already exists.
4. If found: log "Bootstrap admin already exists, skipping seed." and exit 0.
5. If not found: open a transaction and:
   a. Import and call Better-Auth's scrypt hash utility on `config.bootstrapAdminPassword` to produce `hashedPassword`. Verify the import path from the installed version's exports (expected: something like `import { hashPassword } from 'better-auth/crypto'`).
   b. `INSERT INTO core.appuser` with columns: `user_id` (generate via `crypto.randomUUID()`), `user_name: 'System Administrator'`, `user_email`, `email_verified: false`, `auth_method: 'LOCAL'`, `status: 'ACTIVE'`, `force_password_change: false`, `failed_login_count: 0`, `created_datetime: now()`, `last_modified_datetime: now()`.
   c. `INSERT INTO core.account` with columns: `account_id` (generate via `crypto.randomUUID()`), `user_id: <above user_id>`, `provider_id: 'credential'`, `provider_account_id: <above user_id>`, `password: hashedPassword`, `created_datetime: now()`, `last_modified_datetime: now()`.
   d. Commit.
6. Log "Bootstrap admin seeded successfully." and exit 0.
7. On any error: log the error via `lib/logger`, exit 1.

The seed does **not** write any RBAC rows (those are um05). The seed does **not** write an `AUDIT_LOG` row for this bootstrapped account creation — the audit log table exists, but the seeded user is infrastructure, not an admin action. This is a deliberate, documented exception to the "every mutation is audited" rule: the break-glass seed happens at deployment time, not in the application's operational lifetime. A comment in the seed script records this.

**Add to `package.json`:**

```json
"db:seed": "node --env-file=.env --import tsx db/seeds/seed-admin.ts",
"db:setup": "npm run db:migrate && npm run db:seed"
```

`db:setup` is the single command for fresh deployments. CI/CD calls this in the gated migration step (um25).

### 3.14 Explicitly NOT in this unit

- Per-account lockout (`failed_login_count`, `locked_until` enforcement) — um04.
- RBAC tables, role/permission seed, role assignment for the seeded admin — um05.
- The effective-permission resolver, `requirePermission` guard, route protection — um06.
- The `/no-access` page — um06.
- The root `/` resolver (first READ-able page redirect) — um06.
- Forced first-login password change enforcement (middleware, `/set-password` page) — um09. The `force_password_change` column already exists on `appuser` (um02) and is `false` for the seeded admin; the enforcement is not wired until um09.
- Entra/Microsoft SSO provider — um10.
- The `StatusBadge`, `AuthMethodBadge`, `RoleBadge` components — um07 (first unit to render them).
- Least-privilege DB role enforcement and Key Vault wiring — um25.

---

## 4. Dependencies

> Install as runtime dependencies unless marked dev. Pin to current stable; no speculative installs (workflow §5.6).

**Runtime (`dependencies`)**

- `better-auth` — the auth framework: credential provider, scrypt hashing, session management, Drizzle adapter, Next.js handler, `createAuthClient`. Single package covering all Better-Auth functionality.

**Dev (`devDependencies`)**

No new dev dependencies in this unit. `tsx`, `drizzle-kit`, `zod`, `react-hook-form`, `@hookform/resolvers` are already present from um01/um02 (or if `react-hook-form`/`@hookform/resolvers` were not installed in um01, install them now as runtime dependencies since they ship in the client bundle).

**Verify `react-hook-form` and `@hookform/resolvers` are present.** These were likely installed in um01 (shadcn/ui's Form component depends on them). If not, add as runtime deps now.

**`NEXT_PUBLIC_APP_URL`** — not a package but a new env key (§3.8). Add to `.env.example`.

---

## 5. Verification Checklist

Every item must pass before um03 is "done."

### Better-Auth config & field mapping

- [ ] `auth/index.ts` exports `auth` (the `betterAuth()` instance); `auth/client.ts` exports `authClient`. No other file declares a Better-Auth instance.
- [ ] The field mapping in `auth/index.ts` covers all four managed models (`appuser`, `account`, `session`, `verification`) with all snake_case column targets from §3.7. Verified by inspecting what columns Better-Auth writes at runtime (see session row and account row after sign-in).
- [ ] `betterAuth()` is configured with `disableSignUp: true` (or equivalent) — a sign-up attempt against `/api/auth/sign-up/email` returns an error and creates no row.
- [ ] No `image` field appears in the field mapping.
- [ ] `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are absent from `lib/config` → the app throws a startup error with a clear message.

### `AUDIT_LOG` table

- [ ] `npm run db:generate` emits the next SQL migration containing `CREATE TABLE core.audit_log` with all columns from §3.2.
- [ ] No `updated_at` column exists on `audit_log`.
- [ ] The FK `actor_user_id → core.appuser(user_id)` is present with `ON DELETE SET NULL`.
- [ ] Three indexes exist: on `actor_user_id`, `event_type`, `created_datetime`.
- [ ] `npm run db:migrate` applies both migrations (0000 identity + 0001 audit_log) cleanly to a fresh DB; idempotent on re-run.
- [ ] `AuditEventType` union in `types/audit.ts` includes all 20 event type strings from §3.4. `AuditLog` and `AuditLogInsert` types are Drizzle-derived, not hand-written.

### Seed

- [ ] `npm run db:seed` against a fresh DB (migrations already applied) inserts exactly one `appuser` row and one `account` row.
- [ ] The seeded `appuser` has `status = 'ACTIVE'`, `auth_method = 'LOCAL'`, `force_password_change = false`.
- [ ] The seeded `account` has `provider_id = 'credential'`, `password` is a non-null scrypt hash (not plaintext).
- [ ] Re-running `npm run db:seed` on a DB that already has the admin row: exits 0 and creates no duplicate.
- [ ] `npm run db:seed` with `BOOTSTRAP_ADMIN_EMAIL` or `BOOTSTRAP_ADMIN_PASSWORD` unset: exits 1 with a clear error message.
- [ ] No `AUDIT_LOG` row is written by the seed (documented exception, §3.13).

### Sign-in flow

- [ ] `POST /api/auth/sign-in/email` with the seeded admin's email + correct password:
  - Returns a 200 with a `Set-Cookie` header (HTTP-only, the session token).
  - A `core.session` row exists for the user with a future `expires_at`.
  - A `core.audit_log` row with `event_type = 'LOCAL_LOGIN'` and `actor_user_id = <admin user_id>` exists.
  - `core.appuser.last_login_datetime` for the admin is updated to approximately now.
- [ ] `POST /api/auth/sign-in/email` with incorrect password: returns an error; no session row; no audit row.
- [ ] `POST /api/auth/sign-in/email` for a non-existent email: returns an error; no session row; no audit row. The error message must not reveal whether the email exists.
- [ ] The `LOCAL_LOGIN` audit row and `last_login_datetime` update are atomic: if the audit insert fails (simulated by a test that temporarily makes `audit_log` unwritable), `last_login_datetime` is also not updated (the transaction rolled back). The sign-in session itself is unaffected.
- [ ] After sign-in, `GET /api/auth/session` (or Better-Auth's session endpoint) returns the active session data. `status` and permissions are NOT in the session payload (Invariant #2).

### `/login` page

- [ ] Navigating to `/login` with no active session renders the `LoginPage` with the `LoginForm` (email + password fields, Sign in button). Page title is "Sign In".
- [ ] Navigating to `/login` with an active session redirects to `/`.
- [ ] Submitting the form with the seeded admin credentials redirects to `/`. A `core.session` row exists after redirect.
- [ ] Submitting with an incorrect password shows the generic invalid-credentials message inline (not a toast, not a page reload, not a leaked error object).
- [ ] The email and password fields have associated `<label>` elements. The password field has a functional show/hide toggle that is keyboard-operable. The Submit button is disabled + shows a spinner during submission.
- [ ] Focus ring (`--focus-ring`) is visible on all interactive elements when tabbed to.
- [ ] The page is mobile-responsive; the card does not overflow at 375px viewport width.
- [ ] No "Forgot password" or "Sign up" link exists anywhere on the page.

### Boundary & quality gates

- [ ] `npm run typecheck` is clean. No `any`, no non-null assertions across boundaries (code-standards §2.2–§2.3).
- [ ] `npm run lint` is clean. Import boundary rule: `auth/**` does not import `app/**`, `actions/**`, `services/**`; `components/**` does not import `db/**`; `db/**` does not import `auth/**`. ESLint import-boundary rule enforces these (code-standards §7.1).
- [ ] `npm run format:check` reports no changes.
- [ ] `npm run test` is green. Tests include:
  - Unit test for `insertAuditEvent` repository: inserts a row, confirms it appears in DB, confirms no UPDATE/DELETE methods exist on the repository.
  - Unit test for `loginSchema`: valid inputs pass, invalid email rejected, empty password rejected.
  - Integration test for the sign-in flow (requires DB): verifies the session row, audit row, and `last_login_datetime` update as described in the sign-in checklist above.
  - Integration test for atomic rollback: audit write failure does not commit `last_login_datetime` update.
  - Integration test for `disableSignUp`: sign-up endpoint returns an error.
- [ ] Semgrep SAST reports no high/critical findings. Secret scanner: no `BETTER_AUTH_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, or any credential committed.
- [ ] No `console.*` in any file. All diagnostics via `lib/logger`.
- [ ] No `TODO` or commented-out code.

### Scope guard

- [ ] No lockout logic (`failed_login_count` checks, `locked_until` updates, `USER_LOCKED` events) was added (um04).
- [ ] No RBAC tables, no `ROLES`/`PERMISSIONS`/`ROLE_ASSIGN`/`ROLE_PERMISSION_ASSIGN` schema, no permission resolver (um05/um06).
- [ ] No Entra/Microsoft provider in `auth/index.ts` (um10).
- [ ] No `/set-password` page, no `force_password_change` middleware (um09).
- [ ] The route × level authorization matrix is N/A in this unit (no guarded routes exist yet — the first guarded route is um06); note this explicitly in the test file as an intentional omission (workflow §8.3).
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record.
