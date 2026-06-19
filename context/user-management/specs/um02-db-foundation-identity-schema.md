# Unit um02 — Database Foundation & Better-Auth Identity Schema — Spec

- **Boundary:** DB
- **Dependencies:** Unit um01 (the scaffold, `lib/config`, the `db/` folder + import-boundary rule).
- **Confirmed toolchain choices:** **Drizzle ORM** + **drizzle-kit** (committed SQL migrations via `generate`, never `push`); **postgres.js** (`postgres`) as the client driver; **`DATABASE_URL`** supplies the connection string (no `docker-compose` in this unit — an external/CI-provided Postgres 16 is assumed); **tsx** + Node 22's built-in `--env-file` to run the migration script; the migration result is proven by an **automated Vitest integration test** that applies the migration and introspects Postgres.
- **Source sections:** build plan §"Phase 1 / um02"; architecture §1 (stack: Drizzle, Postgres ≥ 16), §3 (storage model), §4 (multi-module DB design — one logical DB, the `core` schema, one Drizzle migration history); code-standards §2.7 (row types derived from Drizzle), §6 (data & storage rules), §7.6 (db file org). Invariants touched: **#14** (DB access only in `db/**`), **#15** (one shared DB, one `core` schema, Drizzle-owned committed/gated migrations, no manual DDL), **#18** (no secret in repo/image — connection string via env; Key Vault sourcing is _later_), **#19** (the four managed tables are snake*case **targets** the Better-Auth field mapping binds to — \_the mapping itself is declared in um03, not here*).

> This unit ships the **database plumbing and the four identity tables only**. There is **no Better-Auth config, no field-mapping declaration, no `auth/` code, no authentication, no `AUDIT_LOG`, no RBAC/config tables, no seeds, no least-privilege DB role, no Key Vault, and no deploy/migration pipeline** here. Those arrive later (Better-Auth + field mapping + `AUDIT_LOG` + admin seed → um03; RBAC tables → um05; `SYSTEM_CONFIG` → um22; gated migration step + DB role + Key Vault + DAST → um25). The single deliverable is: the first migration applies cleanly against a Postgres 16 database, and the four Better-Auth identity tables (`appuser`, `account`, `session`, `verification`) exist in the `core` schema as snake_case Drizzle tables whose columns are the exact targets um03's field mapping will bind to.

---

## 1. Goal

Stand up the Drizzle ORM data layer — a server-only postgres.js connection sourced from `DATABASE_URL` (with a documented Key Vault placeholder for um25), a programmatic migration runner, the `db/` repository scaffold and Drizzle-derived row types, and the `core` Postgres schema — and define the four Better-Auth identity tables (`appuser`, `account`, `session`, `verification`) as snake_case Drizzle tables carrying every Better-Auth-managed field plus `APPUSER`'s custom columns, constraints, and indexes. The unit is **done** when `npm run db:migrate` applies the generated migration cleanly to a fresh Postgres 16 database, the four tables exist in `core` and match Drizzle's definitions under introspection (asserted by an automated integration test), and `tsc`, ESLint (incl. the import boundary), Prettier, Vitest, and Semgrep all pass.

---

## 2. Design

### 2.1 Schema-shape decisions

This is a DB-boundary unit, so the "visual" decision is the **logical layout** of the schema, not any UI.

- **Namespacing via a Postgres `core` schema (architecture §4).** The migration creates `CREATE SCHEMA IF NOT EXISTS core`; all four identity tables live in `core`, declared through Drizzle's `pgSchema('core')`. Later modules get their own schemas (`product`, `customer`, …) and reference `core` by foreign key. Nothing in v1 uses the `public` schema for application data.
- **Lowercase snake_case table and column names everywhere (code-standards §6.4, Invariant #19).** The overview writes `APPUSER` in caps as a label; the physical table is `core.appuser` (unquoted, lowercase). The other three keep Better-Auth's model names (`account`, `session`, `verification`). Every column is **explicitly** named in snake_case in the Drizzle column builder (e.g. `text('user_email')`) — the casing is authoritative in the table definition, not inferred from a global transform — so um03's Better-Auth field mapping has a stable, hand-verified target for each managed field.
- **These four tables are Better-Auth-managed at runtime, but Drizzle owns their DDL.** um02 defines the columns Better-Auth expects (remapped to snake_case) so the migration creates them; um03 then points Better-Auth at these columns via its field mapping. Therefore the column set must satisfy **Better-Auth's managed model**, not only the overview's custom-field view — see §2.1.1.
- **Identifiers are `text` primary keys.** Better-Auth generates string IDs by default; um02 types every PK / FK id column as `text` and does not pre-decide an ID-generation strategy (that is Better-Auth config in um03). No `uuid`/`serial` is introduced — keeping the column shape aligned with Better-Auth's default generator means um03 needs no `advanced.database.generateId` override.
- **Timestamps are `timestamptz`** (`timestamp` with `withTimezone: true`, `mode: 'date'`), mapping Better-Auth's `createdAt`/`updatedAt` to `created_datetime`/`last_modified_datetime`; `created_datetime`/`last_modified_datetime` default to `now()` (code-standards §2.13 — `Date` in process, ISO-8601 UTC on the wire). The same `created_datetime`/`last_modified_datetime` pair is used **consistently across all four tables** (no mixed `created_at`/`updated_at` naming) so the field-mapping target set is uniform.
- **Constraints expressed in the schema, not the app.** `CHECK` constraints pin `appuser.auth_method` ∈ {`SSO`,`LOCAL`}, `appuser.status` ∈ {`PENDING`,`ACTIVE`,`DISABLED`,`DELETED`}, and `account.provider_id` ∈ {`credential`,`microsoft`} (the v1 provider set; later providers extend it by migration). These mirror the `as const` unions in `types/` (code-standards §2.6) but are enforced by Postgres.
- **Email reuse after tombstone is a partial unique index (overview flow #8).** `appuser.user_email` is unique only among non-tombstoned rows: `UNIQUE (user_email) WHERE status <> 'DELETED'`. The tombstoned row is preserved but excluded, so the email is reusable.
- **Entra-identity reuse is resolved by account-row removal at tombstone, not a cross-table partial index.** A partial unique index on `account.provider_account_id` cannot reference `appuser.status` (Postgres partial predicates are single-table), so `account` carries a plain `UNIQUE (provider_id, provider_account_id)` (Better-Auth's standard account-link uniqueness). **Reuse is achieved because the tombstone action (um17) removes the user's `account` rows in the same transaction**, freeing the Entra object id; um02 records this as the resolved contract so um17 implements it rather than inventing a conflicting mechanism. (The `appuser` row itself is still never physically deleted.)

#### 2.1.1 Better-Auth managed field set — what um02 must include

Two managed columns are easy to miss because the overview's `APPUSER` list shows the _custom-field_ view:

- **`email_verified` is INCLUDED.** Better-Auth's `user` model treats `emailVerified` as a managed, non-optional field; um02 maps it to `email_verified boolean NOT NULL DEFAULT false`. Better-Auth sets `emailVerified = true` on the Entra callback (a matched Entra email is considered verified) and leaves it `false` for credential sign-ins unless a verification flow completes. In this application there is **no email-verification flow** (no SMTP; admin-pre-created accounts), so application logic never branches on its value — the column is carried for Better-Auth schema completeness and to avoid a field-mapping gap. um03 maps `emailVerified` → `email_verified`.
- **`image` is INTENTIONALLY OMITTED.** It is optional in Better-Auth's model and the architecture (§3) ships no avatars/uploads in v1. Omission is a deliberate, documented call (not an oversight); if avatars are ever added, the column arrives by migration in that unit.
- The OAuth token columns on `account` (`access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`) **are included but nullable** and stay null under simplified SSO (overview Data Model) — Better-Auth's account model declares them, so they must exist for the mapping to bind.

### 2.2 Structural decisions

- **All DB code lives under `db/**`, and only there (Invariant #14, code-standards §7.6).** No `app/**`, `actions/**`, `services/**`, or `auth/**`file imports the client or runs SQL. The um01 import-boundary rule already allows`db`to import`types`, `lib`, and external libraries (here `drizzle-orm`, `postgres`); no other layer may import `postgres`/`drizzle-orm`.
- **One connection module, one config reader.** `db/client.ts` builds the postgres.js client from `config.databaseUrl` (the typed value from `lib/config`, the _only_ reader of `process.env` per code-standards §3.10) and wraps it with Drizzle. The connection string is read from `DATABASE_URL`; a header comment marks that production sourcing via **Azure Key Vault + Managed Identity is wired in um25** (the "Key Vault placeholder" the build plan calls for). No Key Vault SDK is pulled in this unit (Invariant #18).
- **The migration runner is a standalone, idempotent script.** `db/migrate.ts` opens a dedicated single-connection postgres.js client (`max: 1`), runs Drizzle's programmatic `migrate()` against `db/migrations/`, then closes the connection and exits. It is invoked by `npm run db:migrate`. This is the same runner the **gated CI/CD migration step (um25)** will call; um02 only establishes it, it does not build the pipeline stage.
- **Drizzle's own migration journal is namespaced out of `core`.** The runner records applied migrations in a `drizzle` schema (`migrationsSchema: 'drizzle'`), keeping the `core` schema clean of bookkeeping tables, so introspection of `core` sees only the four identity tables.
- **Schema files are split by area; no cross-layer barrels.** Table definitions live in `db/schema/identity.ts`; drizzle-kit is pointed at `db/schema/*` so later areas (`rbac.ts` in um05, `config.ts`/`audit.ts` later) drop in without config changes. Barrels (`index.ts`) remain forbidden outside `components/ui/` (code-standards §7.11); modules import tables directly.
- **Repository scaffold + Drizzle-derived row types, no speculative queries.** `db/repositories/` is established with the repository convention (every query function takes a Drizzle DB-or-transaction handle as its first argument, so it composes inside the mutation+audit transaction introduced in um03). um02 ships exactly one minimal identity read — `findUserById` — to prove the data-access layer compiles, resolves `@/*`, and obeys the boundary; broad user/role queries arrive with the units that need them. Row types are derived (`$inferSelect`/`$inferInsert`, code-standards §2.7), never hand-written, and surfaced through `types/` for cross-layer use.
- **No seeds, no writes.** Better-Auth owns inserts to these tables at runtime (from um03); the seeded break-glass admin is a um03 seed migration. um02 writes no rows — `verification` in particular stays empty in v1 (overview Data Model).

---

## 3. Implementation

### 3.1 Dependencies & npm scripts

Install the data-layer packages (§4) and add scripts to `package.json`:

- `"db:generate": "drizzle-kit generate"` — diff the schema and emit a new ordered SQL migration into `db/migrations/`.
- `"db:migrate": "node --env-file=.env --import tsx db/migrate.ts"` — apply pending migrations via the runner (Node 22's built-in `--env-file` loads `DATABASE_URL`; **no `dotenv` dependency**).
- `"db:introspect": "drizzle-kit introspect"` — optional, for manual verification/diffing.
- Extend the existing `test` gate to include the DB integration suite, run as a separate Vitest project so unit tests stay DB-free (§3.7).

Add **`DATABASE_URL`** to `.env.example` as a non-secret placeholder (e.g. `postgresql://postgres:postgres@localhost:5432/enterprise_billing`); the real value is never committed (Invariant #18). `.env*` stays git-ignored from um01.

### 3.2 `lib/config` — add the DB env surface

Extend the um01 Zod config schema (still the only `process.env` reader) with:

- `DATABASE_URL` — a Postgres connection URL, validated (`z.string().url()` / a postgres-URL refinement), **required**; the loader fails loud on absence (code-standards §1.12). Expose it as `config.databaseUrl`.

No Entra, Key Vault, or DB-role keys are added — those belong to their owning units (workflow: no speculative env keys). A header note records that in production `DATABASE_URL` is injected from Key Vault via Managed Identity (um25).

### 3.3 `drizzle.config.ts`

At the project root:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema", // every area file is picked up
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! }, // CLI-only context; app reads via lib/config
  schemaFilter: ["core"], // generate/introspect only our schema
  verbose: true,
  strict: true,
});
```

> drizzle-kit is a build/CLI tool run with `--env-file`; the `process.env` access here is the sanctioned exception to "config is read in one place" because it executes outside the app runtime (document this with a comment). The application never imports this file.

### 3.4 `db/schema/identity.ts` — the `core` schema + four tables

Declare the schema and tables with Drizzle's `pgSchema`. Authoritative column set (Better-Auth field → snake_case column):

```ts
import {
  pgSchema,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const core = pgSchema("core");
```

**`core.appuser`** — Better-Auth `user` model, renamed, + custom fields:

| Better-Auth field | Column (`core.appuser`)  | Type          | Constraints                                                                    |
| ----------------- | ------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `id`              | `user_id`                | `text`        | **PK**                                                                         |
| `name`            | `user_name`              | `text`        | NOT NULL                                                                       |
| `email`           | `user_email`             | `text`        | NOT NULL; **partial unique** `WHERE status <> 'DELETED'`                       |
| `emailVerified`   | `email_verified`         | `boolean`     | NOT NULL, default `false`                                                      |
| —                 | `user_phonenum`          | `text`        | nullable                                                                       |
| —                 | `auth_method`            | `text`        | NOT NULL; CHECK ∈ {`SSO`,`LOCAL`}                                              |
| —                 | `status`                 | `text`        | NOT NULL, default `PENDING`; CHECK ∈ {`PENDING`,`ACTIVE`,`DISABLED`,`DELETED`} |
| —                 | `force_password_change`  | `boolean`     | NOT NULL, default `false`                                                      |
| —                 | `failed_login_count`     | `integer`     | NOT NULL, default `0`                                                          |
| —                 | `locked_until`           | `timestamptz` | nullable                                                                       |
| —                 | `last_login_datetime`    | `timestamptz` | nullable                                                                       |
| `createdAt`       | `created_datetime`       | `timestamptz` | NOT NULL, default `now()`                                                      |
| `updatedAt`       | `last_modified_datetime` | `timestamptz` | NOT NULL, default `now()`                                                      |

_(`image` omitted — §2.1.1. The password hash and SSO id are **not** here; they live in `account`.)_

> Define the partial unique index and CHECK constraints in the Drizzle table's extra-config callback: `uniqueIndex('appuser_email_unique').on(t.user_email).where(sql\`status <> 'DELETED'\`)`, `check('appuser_auth_method_check', sql\`auth_method IN ('SSO','LOCAL')\`)`, `check('appuser_status_check', sql\`status IN ('PENDING','ACTIVE','DISABLED','DELETED')\`)`. Drizzle emits these as the partial `CREATE UNIQUE INDEX`and`ADD CONSTRAINT ... CHECK (...)` in the migration SQL.

**`core.account`** — Better-Auth `account` model (one row per auth method per user):

| Better-Auth field       | Column (`core.account`)    | Type          | Constraints                                                      |
| ----------------------- | -------------------------- | ------------- | ---------------------------------------------------------------- |
| `id`                    | `account_id`               | `text`        | **PK**                                                           |
| `userId`                | `user_id`                  | `text`        | NOT NULL; **FK** → `core.appuser(user_id)` (`ON DELETE CASCADE`) |
| `providerId`            | `provider_id`              | `text`        | NOT NULL; CHECK ∈ {`credential`,`microsoft`}                     |
| `accountId`             | `provider_account_id`      | `text`        | NOT NULL                                                         |
| `password`              | `password`                 | `text`        | nullable (scrypt hash; only when `provider_id = 'credential'`)   |
| `accessToken`           | `access_token`             | `text`        | nullable                                                         |
| `refreshToken`          | `refresh_token`            | `text`        | nullable                                                         |
| `idToken`               | `id_token`                 | `text`        | nullable                                                         |
| `accessTokenExpiresAt`  | `access_token_expires_at`  | `timestamptz` | nullable                                                         |
| `refreshTokenExpiresAt` | `refresh_token_expires_at` | `timestamptz` | nullable                                                         |
| `scope`                 | `scope`                    | `text`        | nullable                                                         |
| `createdAt`             | `created_datetime`         | `timestamptz` | NOT NULL, default `now()`                                        |
| `updatedAt`             | `last_modified_datetime`   | `timestamptz` | NOT NULL, default `now()`                                        |

Indexes: `UNIQUE (provider_id, provider_account_id)`; non-unique index on `user_id`.

**`core.session`** — Better-Auth `session` model:

| Better-Auth field | Column (`core.session`)  | Type          | Constraints                                                      |
| ----------------- | ------------------------ | ------------- | ---------------------------------------------------------------- |
| `id`              | `session_id`             | `text`        | **PK**                                                           |
| `userId`          | `user_id`                | `text`        | NOT NULL; **FK** → `core.appuser(user_id)` (`ON DELETE CASCADE`) |
| `token`           | `session_token`          | `text`        | NOT NULL; **UNIQUE**                                             |
| `expiresAt`       | `expires_at`             | `timestamptz` | NOT NULL                                                         |
| `ipAddress`       | `ip_address`             | `text`        | nullable                                                         |
| `userAgent`       | `user_agent`             | `text`        | nullable                                                         |
| `createdAt`       | `created_datetime`       | `timestamptz` | NOT NULL, default `now()`                                        |
| `updatedAt`       | `last_modified_datetime` | `timestamptz` | NOT NULL, default `now()`                                        |

Indexes: index on `user_id`; index on `expires_at` (supports the future daily purge job, architecture §7). _Deleting rows here = instant revocation; the FK cascade also clears sessions when a user row is ever removed — which never happens for users, but keeps referential integrity sound._

**`core.verification`** — Better-Auth `verification` model (required by core; no rows in v1):

| Better-Auth field | Column (`core.verification`) | Type          | Constraints               |
| ----------------- | ---------------------------- | ------------- | ------------------------- |
| `id`              | `verification_id`            | `text`        | **PK**                    |
| `identifier`      | `identifier`                 | `text`        | NOT NULL                  |
| `value`           | `value`                      | `text`        | NOT NULL                  |
| `expiresAt`       | `expires_at`                 | `timestamptz` | NOT NULL                  |
| `createdAt`       | `created_datetime`           | `timestamptz` | NOT NULL, default `now()` |
| `updatedAt`       | `last_modified_datetime`     | `timestamptz` | NOT NULL, default `now()` |

Index: index on `identifier`.

> Every column is named explicitly in snake_case in the Drizzle builder. Do **not** add Better-Auth config, the field-mapping object, or a `betterAuth()` call in this unit — those are um03. um02 produces only the Drizzle table definitions and the migration.

### 3.5 `db/client.ts` — connection (server-only)

- Import `config` from `lib/config`; create the postgres.js client `postgres(config.databaseUrl, { … })` and wrap it: `export const db = drizzle(client, { schema })`. Pass the imported `schema` so `db.query` and inferred types are available.
- Connection options: `max: 10` (pool ceiling, sufficient for a single Container Apps replica; tune later), `idle_timeout: 30` (seconds), `connect_timeout: 10` (seconds).
- Mark the module server-only (no `next/*`; `db/` is framework-agnostic). Export the typed `db` handle and a `Database` type alias (`typeof db`) used by repository signatures.
- Header comment: _production `DATABASE_URL` is sourced from Key Vault via Managed Identity (um25); here it comes from the env via `lib/config`._
- The migration runner uses its own `max: 1` client (§3.6) so DDL never contends with the app pool.

### 3.6 `db/migrate.ts` — migration runner

A standalone script (run via `npm run db:migrate`, executed by tsx with `--env-file`):

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "@/lib/config";

async function main(): Promise<void> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });
  } finally {
    await sql.end();
  }
}

void main().catch((err) => {
  /* log via lib/logger, then process.exit(1) */
});
```

- Uses a dedicated single connection; always closes it (`finally`); exits non-zero on failure (fail loud, code-standards §1.12). Diagnostics go through `lib/logger`, never `console.*` (code-standards §1.10).
- `migrate()` first ensures the schemas referenced by the migration exist; the generated SQL itself contains `CREATE SCHEMA IF NOT EXISTS "core"` (§3.8).
- This is the **only** migration entry point; it is never imported by application code (it is a one-shot CLI tool, and the gated CI/CD step in um25 calls it before traffic shifts).

### 3.7 `db/repositories/identity-repository.ts` — scaffold

- Establish the repository convention: each function takes the Drizzle handle (`db` **or** a transaction `tx`) as its first parameter so callers in later units can compose it inside the mutation+audit transaction (introduced in um03). No function reads `process.env` or builds its own connection.
- Ship one minimal read to exercise the layer: `findUserById(db: Database, id: string): Promise<AppUser | null>` selecting from `core.appuser`. This is the only query in um02; it proves the data-access path compiles, the `@/*` alias resolves, and the import boundary holds.
- Export the derived row types from `db/schema/identity.ts` (`export type AppUser = typeof appuser.$inferSelect`, `AppUserInsert = typeof appuser.$inferInsert`, and the same for `account`/`session`/`verification`); re-export the cross-layer subset through `types/` (code-standards §2.7, §7.7). Do **not** hand-declare column shapes.

### 3.8 Generate & commit the first migration

- Run `npm run db:generate` to emit `db/migrations/0000_<name>.sql` (+ the `meta/` journal). The file must contain `CREATE SCHEMA IF NOT EXISTS "core"`, the four `CREATE TABLE core.*` statements, the `CHECK` constraints, the two foreign keys, the `UNIQUE`/partial-unique indexes, and the secondary indexes from §3.4.
- **Review the generated SQL by hand** before committing (it is the artifact CI/CD will apply in um25): confirm snake_case names, the partial unique predicate `WHERE status <> 'DELETED'`, the provider/auth-method/status CHECKs, and that nothing lands in `public`. Commit the migration as the single ordered file for the whole database's one Drizzle history (Invariant #15). Never edit an applied migration; corrections are new migrations.

### 3.9 Testing — schema unit test + migration integration test

Two suites, configured as separate Vitest projects so the DB-dependent suite is opt-in:

- **Schema unit test** (`tests/db/identity-schema.test.ts`, no DB): asserts the Drizzle table objects expose the exact snake_case column set and that `$inferSelect` keys for `appuser`/`account`/`session`/`verification` match §3.4 — guarding the precise targets um03's field mapping binds to (catches an accidental rename without a database).
- **Migration integration test** (`tests/db/migration.integration.test.ts`, requires `DATABASE_URL`, `vitest.integration.config.ts`): against a clean Postgres 16, runs the migration runner, then introspects `information_schema` / `pg_catalog` to assert: the `core` schema exists; the four tables exist in `core` with the expected snake_case columns and nullability; the `appuser` partial unique index on `user_email` (with its `DELETED` predicate); the `account` and `session` FKs to `core.appuser`; the `session_token` UNIQUE; and the three `CHECK` constraints. Tears down (drop schema or use a disposable database) so the suite is repeatable.
- **CI provides Postgres as a service** (the connection string is exported as `DATABASE_URL`); locally the suite runs against the developer's `DATABASE_URL`. If the variable is absent the integration project **skips with an explicit message** (not a silent pass), while the schema unit test always runs.
- The per-route × per-level **authorization matrix is N/A** in this unit (no routes, no auth) — note it explicitly so the omission is intentional (workflow §8.3); it begins at um06.

### 3.10 Explicitly NOT in this unit

No Better-Auth install/config/`betterAuth()` call, no field-mapping object, no `auth/` files, no credential/Microsoft providers, no `/api/auth` handler (all um03). No `AUDIT_LOG` table or atomic audit-write helper (um03). No RBAC tables or seeds (um05). No `SYSTEM_CONFIG` (um22). No seeded admin or any row writes (um03). No `docker-compose`, Dockerfile, Container Apps, Key Vault SDK, Managed Identity, least-privilege DB role, or gated migration pipeline stage (um25). No repository methods beyond the single `findUserById` scaffold. Adding any of these here is scope creep (workflow §2.4).

---

## 4. Dependencies (packages to install)

> Pin to current stable; dependency changes are deliberate, not drive-by (workflow §5.6). drizzle-kit and tsx are dev/CLI tools.

**Runtime (`dependencies`)**

- `drizzle-orm` — the ORM, schema builder, `pgSchema`, query layer, and the postgres-js migrator.
- `postgres` — the postgres.js client driver (`drizzle-orm/postgres-js`).

**Dev (`devDependencies`)**

- `drizzle-kit` — `generate` / `introspect` CLI (committed SQL migrations).
- `tsx` — runs the TypeScript migration script (`db/migrate.ts`) for `npm run db:migrate`.

**Not added** — `dotenv` (Node 22's `--env-file` covers it); any Key Vault / Azure SDK (um25); `pg` / `@types/pg` (postgres.js is the chosen driver); Better-Auth (um03). `zod` (already present from um01) validates `DATABASE_URL` in `lib/config`.

---

## 5. Verification checklist

Every item must pass before um02 is "done" (a DB-unit subset of workflow §8).

1. **Migration applies cleanly.** `npm run db:migrate` against a fresh Postgres 16 completes with no error and is **idempotent** (a second run applies nothing).
2. **Schema & tables exist.** The `core` schema exists; `core.appuser`, `core.account`, `core.session`, `core.verification` exist in `core` (and nothing application-related in `public`); Drizzle's journal lives in the `drizzle` schema.
3. **Columns match the mapping.** Every table's columns are the snake_case names in §3.4 with the right types/nullability/defaults — the exact targets um03's field mapping will bind to. `email_verified` is present; `image` is intentionally absent. All PK/FK id columns are `text`.
4. **Constraints present.** CHECKs on `appuser.auth_method`, `appuser.status`, `account.provider_id`; the `appuser.user_email` **partial** unique index with `WHERE status <> 'DELETED'`; `UNIQUE (provider_id, provider_account_id)`; `session_token` UNIQUE; FKs `account.user_id` and `session.user_id` → `core.appuser(user_id)` (`ON DELETE CASCADE`); the `user_id`/`expires_at`/`identifier` secondary indexes.
5. **Introspection test green.** `tests/db/migration.integration.test.ts` applies the migration and asserts items 2–4 via `information_schema`/`pg_catalog`; it skips loudly (never silently passes) when `DATABASE_URL` is unset, and runs in CI against the Postgres service.
6. **Schema unit test green.** `tests/db/identity-schema.test.ts` confirms the four tables' inferred column sets without a database.
7. **Type gate.** `npm run typecheck` is clean under the strict config; row types are Drizzle-derived (`$inferSelect`/`$inferInsert`), none hand-written.
8. **Lint gate + boundary intact.** `npm run lint` is clean; `db/**` imports only `types`, `lib`, and the allowed externals (`drizzle-orm`, `postgres`); no `app/**`/`actions/**`/`services/**`/`auth/**` file imports the client or runs SQL (Invariant #14). Confirm a temporary `services/**` → `db/client` import **fails** lint, then remove it. A grep (`grep -r "from 'drizzle-orm'" --include="*.ts" app/ actions/ services/ auth/`) returns no results.
9. **Format & SAST gates.** `npm run format:check` reports no changes; Semgrep reports no high/critical findings (incl. the secrets ruleset — no connection string committed).
10. **One config reader; connection from env.** `db/client.ts` reads the URL from `config.databaseUrl` (via `lib/config`), not `process.env`; `DATABASE_URL` is validated and fails loud when missing; the Key Vault placeholder comment is present (Invariant #18).
11. **No secrets, no console, no dead code.** `.env.example` carries a placeholder `DATABASE_URL` only; `.env*` is git-ignored; `console.*` appears nowhere (diagnostics via `lib/logger`); no `TODO`/commented-out/dead code (code-standards §1.10).
12. **Migration reviewed & committed.** The generated `0000_*.sql` was hand-reviewed and committed as the single ordered file of the database's one Drizzle migration history; no applied migration is edited in place (Invariant #15).
13. **Repository scaffold.** `db/repositories/identity-repository.ts` exists and imports without TypeScript errors; it ships only `findUserById` and reads no `process.env`/builds no connection; `db/migrate.ts` is not imported by any application module.
14. **Scope honored.** No Better-Auth/field mapping/`auth/`, no `AUDIT_LOG`/RBAC/`SYSTEM_CONFIG` tables, no seeds or row writes, no Dockerfile/compose/Key Vault SDK/DB-role/pipeline stage were added (workflow §2.4). The route × level matrix is correctly N/A this unit.
15. **Docs in sync.** No §6/§9 permission-map rows change in this unit (no pages); confirm the architecture, code-standards, and overview docs are untouched and this spec is the unit-of-record (workflow §6).
    </content>
    </invoke>
