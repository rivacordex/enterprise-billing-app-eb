# Spec: um27 — Audit Log → ULID + Range Partitioning (pg_partman)

- **Boundary:** BACKEND (DB schema + migration + infra)
- **Builds:** partition-management capability for `core.audit_log` and converts its primary key to ULID-in-`uuid`.
- **Visible result:** A fresh deploy provisions a range-partitioned, ULID-keyed `core.audit_log` whose future partitions are pre-created and whose out-of-retention partitions are dropped automatically — i.e. the system demonstrably performs partition management with no manual DDL.
- **Source:** `_change-audit-ulid-partitioning-plan.md` (whole doc); `usrmgmt-architecture.md` §3 (storage model — audit append-only), §4 (one core schema; INSERT-only audit; one Drizzle migration history), §7 (Container App Jobs; archival is a _future_ concern), Inv. **#11** (append-only/immutable), **#14** (DB access only in `db/**`), **#15** (one migration history, no manual prod DDL).
- **Decisions taken (sign-off, 2026-06-27):** policy lives in **pg_partman `part_config`** (no custom `core.partition_management` table); **MONTHLY** cadence; **7-year** retention; maintenance driven by **`pg_cron`** (one-time `shared_preload_libraries` restart accepted); ULID generated **db-side** (no `ulidx` runtime dependency).

> This unit changes the _definition_ of `core.audit_log` so a clean migration is born partitioned and ULID-keyed (fresh-install approach — no `ALTER`/backfill, no data to preserve), and stands up pg_partman + pg_cron so future-partition creation and retention-based drop run daily. **Not in this unit:** ledger/CDR/rating/invoice tables (apply this as a template when they exist); audit-log archival-to-Blob (architecture §7, future); any read-path or UI change (`audit-log.repository.ts`, the audit-log page, filters — all already key off `created_datetime` and are unaffected).

---

## 1. Goal

Convert `core.audit_log` to a `PARTITION BY RANGE (created_datetime)` table whose primary key is a time-ordered ULID stored losslessly in the existing 16-byte `uuid` column, and configure pg_partman + a daily pg_cron maintenance job so that — on a clean Postgres 16 deploy — forward (premake) partitions are created ahead of time and partitions older than the 7-year retention window are dropped, with zero manual partition DDL.

---

## 2. Design

### 2.1 Key type — ULID stored in the `uuid` column (no type change)

`audit_id` keeps its `uuid` column type. A ULID is 128-bit, identical in width to a UUID, so it serializes losslessly into `uuid`: 16-byte indexed storage, valid-`uuid` values, and the `auditId: string` app type all stay unchanged. The win is monotonic, time-ordered ids → near-sequential B-tree inserts → low index fragmentation at high write volume, and the embedded millisecond timestamp pairs naturally with range partitioning.

**Trade-off accepted:** ids render as 32-char UUID hex, not the 26-char Crockford ULID form. If a canonical ULID string is ever needed for display, derive it at the presentation layer — storage does not change.

### 2.2 Generation — db-side default function (`core.generate_ulid()` → `uuid`)

Generation moves into Postgres as a `core.generate_ulid()` function returning `uuid`, set as the column `DEFAULT`. The current insert path supplies **no** id (`insertAuditEvent` omits `auditId`, relying on the column default), so a db-side default is a drop-in replacement for `gen_random_uuid()` and requires **no application id plumbing**.

The function follows the ULID byte layout (the geckoboard/pgulid approach, adapted to emit `uuid` instead of Crockford text):

- **48 bits** — Unix time in milliseconds (`floor(extract(epoch from clock_timestamp()) * 1000)`), big-endian.
- **80 bits** — cryptographic randomness (`gen_random_bytes(10)`).
- Concatenate to a 16-byte `bytea`, then `encode(..., 'hex')::uuid`.

**Ordering guarantee:** ids are time-ordered at **millisecond** granularity. Sub-millisecond ordering within a single millisecond is _not_ strictly monotonic (the low 80 bits are random, not a per-ms incrementing counter) — this is acceptable here because B-tree insert locality depends on the millisecond prefix, and `audit_id` remains globally unique in practice. (Strict intra-ms monotonicity would require session/txn-local state in PL/pgSQL; explicitly out of scope and unnecessary for an append-only audit table.)

> **Rejected alternative — app-side `ulidx` + Drizzle `$defaultFn` (plan §5):** would move id generation into TypeScript and add an `ulidx` runtime dependency and an id-encode/decode helper. Rejected because it adds app plumbing for no benefit over a column default, and a raw-SQL insert (or any non-Drizzle writer) would bypass it, whereas a column default is enforced by the database for every writer. The db-side default is the single source of truth.

### 2.3 Partitioning — range on `created_datetime`, monthly

`core.audit_log` becomes `PARTITION BY RANGE (created_datetime)`. Postgres requires the partition key to be part of every unique/primary key on a partitioned table, so the PK becomes **composite**:

```
PRIMARY KEY (audit_id, created_datetime)
```

Harmless here: `audit_id` is still globally unique (ULID), and id lookups inside a time window prune partitions efficiently. The FK `actor_user_id → core.appuser.user_id` and all three secondary indexes are declared on the **parent** and propagate to every partition.

Child partition naming follows pg_partman's convention, `audit_log_pYYYYMM` (e.g. `audit_log_p202606`), under the `core` schema.

### 2.4 Lifecycle — pg_partman owns it, pg_cron drives it

pg_partman natively provides both behaviours this unit needs, per-parent, from its own `part_config` row:

- **Forward creation** via `premake` — keep N months of partitions created ahead of the current period; topped up on each maintenance run.
- **Retention drop** via `retention = '7 years'` + `retention_keep_table = false` — partitions wholly older than the window are dropped (set `true` instead to _detach_ and keep offline; this unit drops).

A single daily `pg_cron` job calls `partman.run_maintenance_proc()`, which performs both the create-ahead and drop-old sweep across all configured parents in one pass. No custom PL/pgSQL manager and no `core.partition_management` metadata table — pg_partman's `part_config` is the policy store.

### 2.5 Fresh-install bootstrapping (minimum-one partition → premake)

Per plan §3.2: the table is **created** with a single bootstrap partition so the parent is valid, then `partman.create_parent(...)` is configured and `run_maintenance_proc()` is run once to materialise the premake/forward partitions. On a fresh install there are no historical partitions to create and nothing to drop.

### 2.6 Ownership of DDL — hand-authored SQL is the source of truth

Declarative partitioning, `create_parent`, `CREATE EXTENSION`, and the pg_cron schedule **cannot** be expressed by `drizzle-kit generate`. So:

- The Drizzle TypeScript schema (`db/schema/audit.ts`) still declares the table for **query typing only**, annotated that physical DDL lives in SQL.
- The **DDL of record** is the hand-authored migration (`0001_audit.sql`, rewritten) plus a provisioning script for the extension/`create_parent`/cron setup (which needs elevated privileges — see §3.4).
- Drizzle meta snapshots are regenerated so migration state stays consistent.

---

## 3. Implementation

### 3.1 `db/schema/audit.ts` — typing + composite PK + new default

Change the `auditId` column default and make the PK composite. Partitioning is **not** expressible in Drizzle and is annotated, not declared.

```ts
import {
  jsonb,
  text,
  timestamp,
  uuid,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { core, appuser } from "@/db/schema/identity";

// PHYSICAL DDL OF RECORD: db/migrations/0001_audit.sql
// This table is PARTITION BY RANGE (created_datetime) and ULID-keyed.
// Drizzle cannot express partitioning or the composite-PK-on-partitioned-table;
// this declaration exists for query typing only. Do not `drizzle-kit push` it.
export const auditLog = core.table(
  "audit_log",
  {
    // ULID generated db-side by core.generate_ulid(), stored in uuid (16 bytes).
    auditId: uuid("audit_id")
      .notNull()
      .default(sql`core.generate_ulid()`),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id").references(() => appuser.id, {
      onDelete: "set null",
    }),
    targetEntity: text("target_entity"),
    targetId: text("target_id"),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.createdDatetime] }),
    index("audit_log_actor_user_id_idx").on(t.actorUserId),
    index("audit_log_event_type_idx").on(t.eventType),
    index("audit_log_created_datetime_idx").on(t.createdDatetime),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
```

### 3.2 `db/migrations/0001_audit.sql` — rewrite (app_migrate-runnable)

Rewrite (do not supplement) the migration. This file runs under the standard gated `app_migrate` role and contains everything that role can own: the generator function, the partitioned parent, indexes, FK, and the bootstrap partition.

```sql
-- core.generate_ulid(): 48-bit ms timestamp + 80-bit randomness, emitted as uuid.
CREATE OR REPLACE FUNCTION core.generate_ulid() RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  ms       bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  ts_bytes bytea  := substring(int8send(ms) from 3 for 6);  -- low 48 bits, big-endian
BEGIN
  RETURN encode(ts_bytes || gen_random_bytes(10), 'hex')::uuid;  -- 6 + 10 = 16 bytes
END;
$$;
--> statement-breakpoint

-- Partitioned parent. Composite PK is required because created_datetime is the
-- partition key. Indexes/FK declared on the parent propagate to all partitions.
CREATE TABLE "core"."audit_log" (
  "audit_id"         uuid NOT NULL DEFAULT core.generate_ulid(),
  "event_type"       text NOT NULL,
  "actor_user_id"    text,
  "target_entity"    text,
  "target_id"        text,
  "before_data"      jsonb,
  "after_data"       jsonb,
  "created_datetime" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("audit_id", "created_datetime")
) PARTITION BY RANGE ("created_datetime");
--> statement-breakpoint

ALTER TABLE "core"."audit_log"
  ADD CONSTRAINT "audit_log_actor_user_id_appuser_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "core"."appuser"("user_id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "audit_log_actor_user_id_idx"   ON "core"."audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_type_idx"      ON "core"."audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_log_created_datetime_idx" ON "core"."audit_log" USING btree ("created_datetime");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (plan §3.2). pg_partman's create_parent + run_maintenance_proc
-- (provisioning step §3.4) then materialise the premake/forward partitions.
CREATE TABLE "core"."audit_log_default" PARTITION OF "core"."audit_log" DEFAULT;
```

> The `audit_log_default` DEFAULT partition is a safety net; pg_partman’s template + premake should make rows land in the correctly-named monthly partition. Monitor that the default stays empty (verification §5).

### 3.3 Drizzle meta — regenerate snapshots

Regenerate `db/migrations/meta/*` and update `_journal.json` so the snapshot reflects the rewritten `0001_audit.sql` (composite PK, new default). Because partitioning is not representable in Drizzle's snapshot model, confirm `drizzle-kit` does not try to "correct" the partitioned table on the next `generate` — the schema annotation in §3.1 plus a no-op verification (run `generate` and assert an empty diff for `audit_log`) guards this.

### 3.4 Provisioning script — extensions, `create_parent`, cron (elevated role)

`CREATE EXTENSION`, `partman.create_parent`, and `cron.schedule` require privileges above `app_migrate` (Azure `azure_pg_admin` / the server admin) and create objects in the `partman`/`cron` schemas. Per the established pattern (`bootstrap-db-roles.sql`, run once under an owner connection — see `postgres.bicep` header), put this in a **bootstrap/provisioning** SQL file, not the app_migrate migration history. Suggested: `db/bootstrap/audit-partman-setup.sql`, run via an `npm run db:setup-partman` step during provisioning, after `0001_audit.sql` has created the parent.

```sql
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;  -- v5+
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Register the parent: monthly range partitions on created_datetime.
SELECT partman.create_parent(
  p_parent_table := 'core.audit_log',
  p_control      := 'created_datetime',
  p_interval     := '1 month',
  p_type         := 'range',
  p_premake      := 4            -- keep 4 future months pre-created
);

-- 7-year retention; drop (not detach) out-of-window partitions.
UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = false,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'core.audit_log';

-- Materialise premake/forward partitions immediately on a fresh install.
CALL partman.run_maintenance_proc();

-- Daily maintenance: create-ahead + drop-old in one pass.
SELECT cron.schedule(
  'audit-log-partman-maintenance',
  '0 3 * * *',                       -- 03:00 daily
  $$CALL partman.run_maintenance_proc()$$
);
```

> **pg_cron database scoping (Azure):** pg_cron objects live in the database named by the `cron.database_name` server parameter (default `postgres`). If the app database differs, either set `cron.database_name` to the app DB, or schedule cross-database with `cron.schedule_in_database(...)` targeting the app DB. Confirm which DB hosts `core.audit_log` and scope the job there.
>
> **create_parent signature:** shown for pg_partman **v5.x** (named params). If the Azure image ships v4.x, the signature/`p_type` values differ (`'native'`) — pin and verify the installed version before running.

### 3.5 Infra — `infra/bicep/modules/postgres.bicep` + parameters

Add to the Flexible Server configuration (the module currently only _references_ an existing server, so these go on the referenced server's parameters / the provisioning pipeline):

1. **`azure.extensions`** allow-list — add `PG_PARTMAN` and `PG_CRON`.
2. **`shared_preload_libraries`** — add `pg_cron` (required for the scheduler). `pg_partman_bgw` is **not** added — maintenance is driven by pg_cron's `run_maintenance_proc()` call, not the background worker. This change **requires a one-time server restart** (accepted at sign-off).
3. Document the restart and the post-restart `db:setup-partman` step in `infra/docs/` alongside the existing `db-role-verification.md`.

### 3.6 Repositories — no change

`db/repositories/audit.repository.ts` (`insertAuditEvent`) and `db/repositories/audit-log.repository.ts` are unchanged. The insert omits `audit_id` (db default supplies the ULID); reads/filters already key off `created_datetime` and id, which align with partition pruning. Confirm no code path inserts a literal `audit_id`.

---

## 4. Dependencies

**Postgres extensions (infra, Azure Flexible Server allow-list):**

- `pg_partman` (≥ 5.x; pin and verify the installed major — v4 vs v5 changes `create_parent`).
- `pg_cron` (must be in `shared_preload_libraries`; one-time restart).

**npm packages:** none. The chosen db-side generation path adds **no** runtime dependency. (`ulidx` is _not_ installed — it would only be needed for the rejected app-side path of §2.2. Optionally add it as a `devDependency` if tests want an independent ULID encoder/decoder to assert byte layout; not required.)

---

## 5. Verification checklist

Each item is a concrete check; turn each into an automated test where the layer allows.

- **Generator (unit/integration):** `SELECT core.generate_ulid()` returns a valid `uuid`; 100 sequential calls within one run produce strictly increasing values when ordered by call time at ms granularity (assert the 6-byte timestamp prefix is non-decreasing); round-trips through the `uuid` column losslessly.
- **Schema:** the PK on `core.audit_log` is `(audit_id, created_datetime)` and `relkind = 'p'` (partitioned table) — query `pg_class`/`pg_partitioned_table`. The three secondary indexes and the FK exist and are inherited by partitions.
- **Drizzle consistency:** `drizzle-kit generate` yields an **empty** diff for `audit_log` after the rewrite (schema annotation + snapshot match); `npm run` migration suite applies `0001_audit.sql` clean on an empty DB.
- **Partition routing:** insert rows with `created_datetime` in two different months → they land in two differently-named partitions (`SELECT tableoid::regclass`); the `audit_log_default` partition stays empty.
- **Premake (forward creation):** after `run_maintenance_proc()`, exactly the configured number of future monthly partitions exist ahead of the current month; inserting into a near-future month covered by premake succeeds without error.
- **Retention (drop):** with `retention='7 years'`, simulate a partition older than the window (create one manually for a >7-year-old month, or fast-forward), run maintenance, confirm it is **dropped** (not just detached); confirm a partition inside the window is **not** dropped.
- **pg_cron job:** `SELECT * FROM cron.job WHERE jobname='audit-log-partman-maintenance'` exists with the daily schedule and targets the correct database; a manual run records success in `cron.job_run_details`.
- **Read path (regression):** the existing audit-log page query + filters return correct rows; `EXPLAIN` on a date-filtered query shows **partition pruning** (only relevant partitions scanned).
- **Append-only invariant (#11):** the app DB role still has only INSERT on `core.audit_log` (and partitions); UPDATE/DELETE denied — confirm grants propagate to child partitions.
- **Fresh deploy (end-to-end):** clean Postgres 16 → run migrations → run `db:setup-partman` → assert the partitioned table, generator function, premake partitions, extensions, and cron job all provision with zero manual partition DDL beyond the documented server params + restart.

---

## 6. Open items to confirm before build

1. **pg_partman major version** on the Azure image (v4 vs v5) — pins the `create_parent` signature in §3.4.
2. **Host database for pg_cron** — confirm whether `core.audit_log`'s database equals `cron.database_name`, to decide between `cron.schedule` and `cron.schedule_in_database` (§3.4).
3. **`db:setup-partman` runner identity** — which provisioning role/step executes the elevated bootstrap script (mirrors the `bootstrap-db-roles.sql` pattern).
