# rm03 — `rating_runtime` role, grants and the boundary — Spec

- **Unit:** rm03 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase A — the last unit of Phase A)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/bootstrap/rating-db-roles.sql`
- **Builds:** the `rating_runtime` login role and the complete grant surface that makes the rating/billing separation a **database privilege** rather than a code convention.
- **Depends on:** rm01 (the four `rating` tables, `rating.period_of()`, `rating.udr_batch_seq`).
- **Sources:** `ratemgmt-architecture.md` Inv #1, #2, #17a, #18 · `ratemgmt-code-standards.md` §9 (grant table) · `rm00-build-plan.md` Unit rm03 · precedent `db/bootstrap/bootstrap-db-roles.sql` (the pgledger exclusion block, lines 138–198).

> **Every claim in the Design section below was executed against PostgreSQL 16.13** before being written. Where a result contradicted the expected design, the design changed. Four findings in this unit were *not* in the build plan and are load-bearing — D5, D6, D7 and D8.

---

## Goal

Make Invariants #1 and #2 **unforgeable**: the rating engine cannot write to `billing` by any route, and neither role can rewrite the financial content of a rated record — enforced by `GRANT`, so a bug, a new developer, or a hand-typed `psql` session cannot cross the line.

The unit is finished when the boundary refuses the violation, not when the code declines to attempt it.

---

## Design

### D1. Two roles, two directions, one table in the middle

`rating.udr_rated` is the only table both sides touch, and each side owns a disjoint set of its columns.

| | `rating_runtime` (the engine) | `app_runtime` (the app, incl. bill run) |
| --- | --- | --- |
| `rating.udr_rated` | `SELECT`, `INSERT`, `UPDATE (status)` | `SELECT`, `UPDATE` on **six** columns |
| `rating.udr_batch` | `SELECT`, `INSERT`, `UPDATE` (lifecycle) | `SELECT` |
| `rating.process_log` | `SELECT`, `INSERT` | `SELECT` |
| `rating.event_catalog` | `SELECT` | `SELECT` |
| `billing.*` | `SELECT` on two tables; **no write, ever** | unchanged (owns it) |
| `product`/`ordering`/`inventory` | `SELECT` on five tables | unchanged |
| `DELETE` / `TRUNCATE` anywhere in `rating` | **none** | **none** |

The **six** `app_runtime`-updatable columns on `udr_rated` are exactly: `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime`.

`udr_ref_batch_id` is deliberately **not** updatable. It is the single lineage anchor (rm01 D11), set once at insert; a retired row keeps the batch that produced it, and supersession changes only `status`. `status` is therefore the **only column both roles may update** — the engine sets `SUPERSEDED`, the bill run sets `BILL_DRAFT`/`BILL_APPROVED`/`BILL_NOTUSED`. The CHECK constraint bounds the vocabulary; the grant cannot separate *which* status value each role may set. That residual is accepted and stated, not hidden.

**Verified** — with these grants in place, `app_runtime` updating `udr_rated_price` is refused (`permission denied for table udr_rated`), as is `DELETE`, as is `INSERT`; `rating_runtime` updating `billrun_ref_id` is refused; both are refused `TRUNCATE`.

### D2. No `DELETE` grant is the whole of Invariant #2's teeth

Financial content is immutable by *absence of privilege*, not by a trigger, not by a repository rule, not by review. The role holds no `DELETE` and no `UPDATE` on any money column, so there is no statement it can issue that rewrites a rated amount.

A trigger would have been the wrong instrument: triggers are bypassable by the table owner, are one migration away from being dropped, and produce a runtime error rather than a permission error — which reads as a bug rather than as a boundary.

### D3. Grants go on the partitioned **parent** only (Inv #17a)

`udr_rated` and `process_log` are partitioned. Access flows through the parent; partitions receive no grants of their own.

**Verified, twice over:**
- `app_runtime` updated a permitted column on a row that physically lives in partition `udr_rated_p202608`, addressing the parent — succeeded.
- The same role addressing the **partition directly** was refused on both `UPDATE` and `SELECT`: `permission denied for table udr_rated_p202608`.
- A partition created **after** the grants were issued was immediately usable through the parent, with no re-grant. This is what makes `pg_partman`'s monthly partition creation safe: it never needs to know about grants.

Granting on a partition would create a hole that bypasses the parent's column scoping. **Never grant on a partition.** The verification suite asserts zero non-owner ACL entries on every child.

### D4. `is_live` needs no `UPDATE` grant, and must not have one

`is_live` is `GENERATED ALWAYS … STORED` from `status`. Updating `status` recomputes it.

**Verified:** `app_runtime` holds `UPDATE` on `status` and *not* on `is_live` (`has_column_privilege(...,'is_live','UPDATE') = false`), and `UPDATE … SET status = 'BILL_APPROVED'` succeeded. Postgres does not check privilege on a generated column, because no one writes it directly.

Granting `UPDATE (is_live)` would be inert at best; the assertion in §Verification treats its presence as a failure so nobody "fixes" a non-problem by adding it.

---

### D5. **`ALTER DEFAULT PRIVILEGES` cannot be column-scoped — so the default for future `rating` tables is `SELECT` only**

The build plan called for `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate … GRANT SELECT` on future `rating` tables. That is correct, and the reason is stronger than style:

```
ALTER DEFAULT PRIVILEGES IN SCHEMA rating GRANT UPDATE (status) ON TABLES TO app_runtime;
ERROR:  default privileges cannot be set for columns
```

**Verified.** A default privilege therefore cannot express the column scoping this module's boundary is built on. Any default privilege carrying `UPDATE` would necessarily be **table-wide** — silently granting a future rating table's money columns to `app_runtime` the moment it is created.

**Rule:** default privileges in `rating` grant `SELECT` and nothing else, to either role. A future rating table needing `INSERT` or a column-scoped `UPDATE` gets an **explicit per-table grant in the same migration that creates it**. This mirrors the conservative default already used for `ordering` and `inventory` (`bootstrap-db-roles.sql` lines 234, 265) — but here it is a correctness requirement, not a preference.

---

### D6. **`PUBLIC` holds `CONNECT` on every database by default — Invariant #18 is unenforceable until it is revoked**

Inv #18 says the Kestra engine's own role holds **no `CONNECT`** on the billing database. rm04 creates that role. But a `datacl` of `NULL` means the built-in default is in force, and that default includes `CONNECT` for `PUBLIC`:

```
 datname  | datacl
-----------+--------
 granttest |          -- NULL = owner ALL + PUBLIC CONNECT, TEMP
 public_has_connect: t
```

**Verified end to end:** a freshly created role with no grants of any kind connected to the database successfully. After `REVOKE CONNECT ON DATABASE <billing_db> FROM PUBLIC`, the same role was refused — `FATAL: permission denied for database` — while `rating_runtime` and `app_runtime`, holding **explicit** `CONNECT`, were unaffected.

**This unit performs the revoke**, even though the role it protects against is created in rm04 and in another repository. Deferring it to rm04 would mean the engine role is created into a database that already admits it, and the first thing rm04 would have to do is reach back into the app repo's bootstrap script — crossing the one-repo-per-unit rule.

`bootstrap-db-roles.sql` already grants `CONNECT` explicitly to `app_runtime` (line 42) and `app_migrate` (line 61), so the revoke costs those roles nothing. **Confirm before running** that no other role on the target server reaches the billing database through `PUBLIC` — check `pg_roles` against the connection strings in use, and note that superusers and the database owner bypass the ACL entirely.

---

### D7. **`PUBLIC` holds `EXECUTE` on the four `billing` `SECURITY DEFINER` functions — `rating_runtime` can post ledger transfers on day one**

This is the finding that would have made Invariant #1 false no matter how carefully the table grants were written.

`db/migrations/0021_billing_pgledger_security_definer.sql` flips four functions to `SECURITY DEFINER`:

```
billing.pgledger_create_account(text, text, boolean, boolean, jsonb)
billing.pgledger_create_transfer(text, text, numeric, timestamptz, jsonb)
billing.pgledger_create_transfers(billing.transfer_request[])
billing.pgledger_create_transfers(billing.transfer_request[], timestamptz, jsonb)
```

It had to: `app_runtime` deliberately holds no table DML on the `pgledger_*` internals, so the wrappers must run as the definer. `bootstrap-db-roles.sql` lines 191–196 then grant `EXECUTE` on exactly those four to `app_runtime`.

**But nothing revokes `EXECUTE` from `PUBLIC` anywhere in `db/`** — verified by grep across the whole `db/` tree: zero occurrences of `FROM PUBLIC`. And `proacl IS NULL` means the default is in force, which is `EXECUTE` to `PUBLIC`.

**Verified, reproducing the exact shape:**

| Scenario | Result |
| --- | --- |
| Role with **zero** `billing` grants calls a `SECURITY **INVOKER**` function that writes | **Refused** — `permission denied for table pgledger_transfers`. The table grant still bites. |
| Same role calls a `SECURITY **DEFINER**` function that writes | **Succeeded. Row written.** |
| `REVOKE EXECUTE … FROM **rating_runtime**` (leaving the `PUBLIC` grant) | **Still succeeded** — revoking from a role does nothing while it holds the privilege through `PUBLIC`. |
| `REVOKE EXECUTE … FROM **PUBLIC**` | **Refused** — `permission denied for function`. |
| `app_runtime` (explicit grant) after that revoke | **Still succeeded** — the mitigation costs the app nothing. |

So: a `SELECT`-only posture on `billing` does **not** close Inv #1, and the intuitive fix — revoking from `rating_runtime` — is a no-op.

**What this unit does:**

1. `REVOKE EXECUTE ON FUNCTION` **each of the four by full signature** `FROM PUBLIC`. Scoped to the four deliberately: `REVOKE … ON ALL FUNCTIONS IN SCHEMA billing FROM PUBLIC` would also strip the `SECURITY INVOKER` helpers, which the table above proves are already gated by their own table grants — a broader revoke buys nothing and risks breaking a caller nobody enumerated.
2. Leave `app_runtime`'s explicit grant in place (proven sufficient above).
3. Grant `rating_runtime` **nothing** on them.
4. Add the standing assertion in §Verification so a fifth `SECURITY DEFINER` function added later without a matching revoke fails the build.

**This is a platform-wide defect that rating merely surfaced.** It should be raised against the billing module regardless of what rating does — any future login role inherits the same write path into the ledger. Recorded here because rm03 is where it was found and where it is first closed.

---

### D8. **A `DEFAULT` or `CHECK` that calls a function requires `EXECUTE` by the *inserting* role**

rm01's `udr_rated` has both:

- `CONSTRAINT udr_rated_period_matches_check CHECK (partition_period = rating.period_of(start_datetime))`
- `udr_id` / `log_id` defaulting to `core.generate_ulid()`
- `udr_batch.batch_id` defaulting to `nextval('rating.udr_batch_seq')`

**Verified, each independently:**

| Missing privilege | Result of `INSERT` by `rating_runtime` |
| --- | --- |
| No `EXECUTE` on `rating.period_of(timestamptz)` (called from the CHECK) | `ERROR: permission denied for function period_of` |
| No `USAGE` on `rating.udr_batch_seq` (called from the DEFAULT) | `ERROR: permission denied for sequence udr_batch_seq` |
| No `EXECUTE` on `core.generate_ulid()` (called from the DEFAULT) | `ERROR: permission denied for function generate_ulid` |
| No `USAGE ON SCHEMA core`, but `EXECUTE` held | **Succeeded** — a stored DEFAULT resolved its function name at DDL time, so schema `USAGE` is not re-checked at insert. |

Two consequences.

**First**, the grant list must include `USAGE ON SEQUENCE rating.udr_batch_seq` and `EXECUTE ON FUNCTION rating.period_of(timestamptz)` and `core.generate_ulid()`. Omit any one and *every* insert fails — a failure that surfaces at first use, not at bootstrap.

**Second, and the reason it is stated as a design point rather than a line item:** these work **today only because `PUBLIC` holds `EXECUTE` by default** — the same default D7 identifies as a hole. The moment anyone applies a blanket `REVOKE EXECUTE ON ALL FUNCTIONS … FROM PUBLIC`, as a hardening pass eventually will, every rating insert breaks. **Grant these explicitly, and do not rely on the `PUBLIC` default for anything this module needs.**

`USAGE ON SCHEMA core` is granted anyway — not for the DEFAULT path, which does not need it, but because any rating code calling a `core` function *by name* would.

### D9. Cross-schema reads are enumerated per table, never `ON ALL TABLES`

`rating_runtime` gets `SELECT` on exactly seven tables outside `rating`:

| Schema | Table | Why the engine reads it |
| --- | --- | --- |
| `product` | `product_offering` | resolve the pinned offering version |
| `product` | `product_offering_price` | the price effective at `start_datetime` |
| `ordering` | `product_order_item` | link subscription to offering |
| `ordering` | `order_item_price_override` | negotiated override |
| `inventory` | `product_inventory` | resolve `udr_subscriber_ref_id` |
| `billing` | `billing_account` | `udr_currency` assertion (rm09) |
| `billing` | `bill_cycle` | period boundaries |

`GRANT SELECT ON ALL TABLES IN SCHEMA product` would silently widen every time the product module ships a table. Enumerate, and let a genuinely new read requirement be a reviewed one-line change.

`USAGE ON SCHEMA` is granted for all four, and nothing more — `USAGE` alone confers no table access.

### D10. The role holds a connection limit and no password in source

`CREATE ROLE rating_runtime WITH LOGIN CONNECTION LIMIT 20` — the engine runs chunked flows and a runaway fan-out (Inv #10's failure mode) must exhaust the role's own budget rather than the server's, leaving the application able to connect while the engine is misbehaving.

The script contains **no password**, exactly as `bootstrap-db-roles.sql` does not: `ALTER ROLE … PASSWORD` is a manual provisioning step, and the value goes to Key Vault (rm04). Follow `infra/docs/db-role-verification.md`.

### D11. This is a bootstrap script, not a Drizzle migration

Same reasoning as the precedent, verbatim in force: creating a role needs `CREATEROLE`, which `app_migrate` does not hold, so it cannot live in the sequence `db/migrate.ts` iterates. Idempotent via `DO` blocks. Uses `--> statement-breakpoint` markers so `bootstrap-db-roles.ts`'s splitter can run it and `psql` can run it whole.

**New file, not an edit to `bootstrap-db-roles.sql`.** The existing file is a platform artefact covering six schemas; rating adds a seventh schema plus two revokes that reach into `billing`. Keeping it separate means the rating boundary is reviewable as one diff — and D7's revoke is visible rather than buried on line 200 of a 278-line file.

---

## Implementation

### 1. `db/bootstrap/rating-db-roles.sql`

Ordered so that nothing depends on a later statement.

**Step 1 — the role (idempotent).**

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rating_runtime') THEN
    CREATE ROLE rating_runtime WITH LOGIN CONNECTION LIMIT 20;
  ELSE
    ALTER ROLE rating_runtime WITH LOGIN CONNECTION LIMIT 20;
  END IF;
END
$$;
```

The `ELSE` branch matters: re-running must converge the connection limit, not skip it.

**Step 2 — close the `PUBLIC` `CONNECT` default (D6), then grant explicitly.**

```sql
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO rating_runtime', current_database());
END
$$;
```

`app_runtime` and `app_migrate` already hold explicit `CONNECT` (`bootstrap-db-roles.sql` lines 42, 61) and are unaffected.

**Step 3 — schema `USAGE`.**

```sql
GRANT USAGE ON SCHEMA "rating"    TO rating_runtime;
GRANT USAGE ON SCHEMA "product"   TO rating_runtime;
GRANT USAGE ON SCHEMA "ordering"  TO rating_runtime;
GRANT USAGE ON SCHEMA "inventory" TO rating_runtime;
GRANT USAGE ON SCHEMA "billing"   TO rating_runtime;
GRANT USAGE ON SCHEMA "core"      TO rating_runtime;   -- D8
GRANT USAGE ON SCHEMA "rating"    TO app_runtime;
```

**Step 4 — `rating` tables, parent only (D3), column-scoped (D1).**

```sql
-- udr_rated: insert and read freely; update `status` and nothing else.
GRANT SELECT, INSERT ON TABLE "rating"."udr_rated" TO rating_runtime;
GRANT UPDATE ("status") ON TABLE "rating"."udr_rated" TO rating_runtime;

-- udr_batch: the claim row is inserted then progressed through its lifecycle.
GRANT SELECT, INSERT ON TABLE "rating"."udr_batch" TO rating_runtime;
GRANT UPDATE (
  "status","started_at","completed_at",
  "file_checksum","file_size_bytes","declared_record_count",
  "parsed_count","rated_count","rejected_count","discarded_count","superseded_count",
  "reject_file_path","archive_file_path",
  "workflow_execution_id","workflow_flow_revision","rating_engine_version",
  "superseded_by_batch_id","supersede_reason","error_summary"
) ON TABLE "rating"."udr_batch" TO rating_runtime;

-- process_log: append-only, by construction.
GRANT SELECT, INSERT ON TABLE "rating"."process_log" TO rating_runtime;

-- event_catalog: read-only at runtime; seeded by rm02 under app_migrate.
GRANT SELECT ON TABLE "rating"."event_catalog" TO rating_runtime;
```

`udr_batch` is **not** granted `UPDATE` on `batch_id`, `file_key`, `source_file`, `file_key_rule`, `udr_type`, `batch_run_num` or `received_at` — the identity and claim columns. A batch cannot be re-pointed at a different `file_key` after the fact, which is what protects Inv #7's claim from being edited around.

**Step 5 — the billing boundary, in the app's direction (D1).**

```sql
GRANT SELECT ON TABLE "rating"."udr_rated" TO app_runtime;
GRANT UPDATE (
  "status", "billrun_ref_id", "billrun_ban_id",
  "billrun_attempt", "billrun_checksum", "upsert_datetime"
) ON TABLE "rating"."udr_rated" TO app_runtime;

GRANT SELECT ON TABLE
  "rating"."udr_batch", "rating"."process_log", "rating"."event_catalog"
TO app_runtime;
```

Six columns. Not seven. The verification asserts the count.

**Step 6 — sequences and functions the inserts actually need (D8).**

```sql
GRANT USAGE ON SEQUENCE "rating"."udr_batch_seq" TO rating_runtime;
GRANT EXECUTE ON FUNCTION "rating"."period_of"(timestamptz) TO rating_runtime, app_runtime;
GRANT EXECUTE ON FUNCTION "core"."generate_ulid"() TO rating_runtime;
```

Explicit, so the module survives a future `REVOKE EXECUTE … FROM PUBLIC`.

**Step 7 — cross-schema reads, enumerated (D9).**

```sql
GRANT SELECT ON TABLE
  "product"."product_offering",
  "product"."product_offering_price",
  "ordering"."product_order_item",
  "ordering"."order_item_price_override",
  "inventory"."product_inventory",
  "billing"."billing_account",
  "billing"."bill_cycle"
TO rating_runtime;
```

**Step 8 — the explicit `billing` write revoke (Inv #1).**

```sql
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "billing" FROM rating_runtime;
```

Strictly redundant — the role was never granted them — and kept anyway as a **declaration of intent that a reviewer reads and a test asserts**. If someone later widens `billing`'s default privileges, this line is where the conflict shows up.

**Step 9 — close the `SECURITY DEFINER` `EXECUTE` hole (D7).**

```sql
REVOKE EXECUTE ON FUNCTION
  "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb),
  "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[]),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
FROM PUBLIC;
```

Signatures copied from `bootstrap-db-roles.sql` lines 191–196 — they must match exactly or the `REVOKE` errors on an unknown function, which is the desired failure mode if the signatures ever drift.

**Step 9a — what this script deliberately does *not* do.**

It does not create the `kestra` database or the `kestra_engine` role. Those are **rm03a** (defined in `specs/rm00-build-plan.md` Phase A), a separate unit in this same repository and boundary, for one reason that matters: `kestra_engine` must be created **after** the `REVOKE CONNECT … FROM PUBLIC` in Step 2. Created before it, the role inherits access to the billing database through `PUBLIC` and Inv #18 is false from the moment it exists — silently, because nothing about the role itself looks wrong. rm03a also applies the mirror-image revoke on the `kestra` database, so `rating_runtime` and `app_runtime` cannot reach the engine's database either; Inv #18 as written is one-directional, and the reverse hole is the same hole.

**Step 10 — default privileges for future `rating` tables (D5).**

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT SELECT ON TABLES TO rating_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT SELECT ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT USAGE, SELECT ON SEQUENCES TO rating_runtime;
```

`SELECT` only. `INSERT` and any column-scoped `UPDATE` arrive per table, in the migration that creates it.

**Step 11 — `app_migrate` owns the schema.**

```sql
GRANT ALL ON SCHEMA "rating" TO app_migrate;
GRANT ALL ON ALL TABLES IN SCHEMA "rating" TO app_migrate;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "rating" TO app_migrate;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating" GRANT ALL ON TABLES TO app_migrate;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating" GRANT ALL ON SEQUENCES TO app_migrate;
```

### 2. `db/bootstrap/rating-db-roles.ts`

Copy `bootstrap-db-roles.ts` exactly: read the `.sql`, split on `--> statement-breakpoint`, execute each statement over `BOOTSTRAP_DATABASE_URL`. Register as `npm run db:bootstrap-rating-roles`.

### 3. `infra/docs/db-role-verification.md`

Extend the existing provisioning order with the rating step and the manual `ALTER ROLE rating_runtime PASSWORD` follow-up, flagged as never committed. Record D6 and D7 as **platform** changes made by this script, so an operator reading the provisioning doc learns that `PUBLIC` lost `CONNECT` on the database and `EXECUTE` on four functions.

### 4. The assertion suite — `tests/rating/grants.test.ts`

Runs against a live database (never mocks), as a **live connection per role** — `has_column_privilege` reports the ACL, but only a real statement proves the ACL is what governs. Assert both.

The per-column assertion is written as an **enumeration over `pg_attribute`, not a hand-maintained list**, so a column added to `udr_rated` in a later migration is covered automatically:

```sql
SELECT a.attname,
       has_column_privilege('app_runtime',   'rating.udr_rated', a.attname, 'UPDATE') AS app_upd,
       has_column_privilege('rating_runtime','rating.udr_rated', a.attname, 'UPDATE') AS eng_upd
FROM pg_attribute a
WHERE a.attrelid = 'rating.udr_rated'::regclass
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;
```

The test compares the result set against the expected pair per column and fails on **any** difference — a widened grant, a narrowed one, or a new column defaulting to the wrong side.

---

## Dependencies (packages to install)

**None.** Uses the existing `pg`/`drizzle-orm` client and the existing bootstrap runner pattern.

---

## Verification checklist

Every item below was executed on PostgreSQL 16.13 while writing this spec except where marked *(to run against the target server)*.

**Column boundary — `app_runtime` (Inv #2)**

1. `app_runtime` updates each of the six permitted columns individually — six separate statements, six successes.
2. `app_runtime` updating `udr_rated_price` is refused with `permission denied for table udr_rated`. ✔ verified
3. The same refusal for `udr_usage_rate`, `udr_discount_amount`, `udr_currency`, `udr_key`, `start_datetime`, `rating_engine_version` — asserted **per column**, so a widened grant fails the build.
4. `app_runtime` `INSERT` into `udr_rated` is refused. ✔ verified
5. `app_runtime` `DELETE` from `udr_rated` is refused. ✔ verified
6. The `pg_attribute` enumeration returns exactly six `app_upd = true` columns and no others — a column added later without a decision fails here. ✔ mechanism verified
7. `has_column_privilege('app_runtime','rating.udr_rated','is_live','UPDATE')` is **false**, and updating `status` still succeeds. ✔ verified (D4)

**Column boundary — `rating_runtime` (Inv #2)**

8. `rating_runtime` updates `status`; it succeeds. `rating_runtime` updating `udr_ref_batch_id` is **refused** — lineage is write-once.
9. `rating_runtime` updating `billrun_ref_id` is refused — the boundary holds in **both** directions. ✔ verified
10. `rating_runtime` updating `udr_rated_price` is refused. ✔ verified
11. `rating_runtime` holds no `DELETE` and no `TRUNCATE` on any `rating` table. ✔ verified
12. `rating_runtime` cannot `UPDATE` `udr_batch.file_key`, `.batch_run_num` or `.batch_id` — the claim cannot be edited around (Inv #7).

**Partitioning (Inv #17a)**

13. `app_runtime` updates a permitted column on a row living in a partition, addressed through the parent — succeeds. ✔ verified
14. Addressing the **partition directly** is refused for both `SELECT` and `UPDATE`, for both roles. ✔ verified
15. A partition created **after** the grants is immediately usable through the parent with no re-grant. ✔ verified
16. `SELECT relname, relacl FROM pg_class` over every partition of `udr_rated` and `process_log` returns **no** entry for `rating_runtime` or `app_runtime` — grants live on the parent only.
17. After `pg_partman` runs its monthly maintenance, item 16 still holds. *(to run against the target server)*

**Insert prerequisites (D8)**

18. `rating_runtime` inserts into `udr_batch` and the `batch_id` default fires — proves `USAGE ON SEQUENCE`. ✔ verified (and verified to fail without it)
19. `rating_runtime` inserts into `udr_rated` and the `period_of` CHECK evaluates — proves `EXECUTE ON FUNCTION rating.period_of`. ✔ verified (and verified to fail without it)
20. `rating_runtime` inserts into `process_log` and the `core.generate_ulid()` default fires. ✔ verified (and verified to fail without it)
21. Items 18–20 still pass after a hypothetical `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core, rating FROM PUBLIC` — proving the module holds its own explicit grants and does not ride on the `PUBLIC` default.

**The billing boundary (Inv #1)**

22. `rating_runtime` `SELECT`s `billing.billing_account` and `billing.bill_cycle` successfully. ✔ verified
23. `rating_runtime` `UPDATE` on `billing.billing_account` is refused. ✔ verified
24. `rating_runtime` `INSERT` into `billing.billing_account` is refused. ✔ verified
25. `rating_runtime` `SELECT` on a billing table **not** in the enumerated list — `billing.document` — is refused, proving the grant is per-table and not schema-wide.
26. **`rating_runtime` calling `billing.pgledger_create_transfer(...)` is refused with `permission denied for function`.** ✔ verified — and verified to **succeed and write a row** before the `FROM PUBLIC` revoke (D7).
27. `app_runtime` calling the same four functions still succeeds after the revoke. ✔ verified
28. **Standing assertion:** no function in schema `billing` has `prosecdef = true` and a `proacl` that is `NULL` or contains a `PUBLIC` entry. A fifth `SECURITY DEFINER` function added later without a matching revoke fails this.

```sql
SELECT p.oid::regprocedure AS fn
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'billing'
  AND p.prosecdef
  AND has_function_privilege('public', p.oid, 'EXECUTE');
-- must return zero rows
```

`has_function_privilege('public', …)` is used rather than parsing `proacl` text: a `NULL` `proacl` means "defaults in force", which *includes* `PUBLIC EXECUTE`, and a text `LIKE` over the ACL array misses that case entirely. **Verified** — the query returns `public_can_execute = f` after the Step 9 revoke and `t` before it.

**Connection boundary (Inv #18 precondition)**

29. `SELECT datacl FROM pg_database WHERE datname = current_database()` is **non-null** and contains no `PUBLIC` `CONNECT` entry. ✔ mechanism verified
30. A role with no explicit `CONNECT` is refused with `FATAL: permission denied for database`. ✔ verified
31. `app_runtime`, `app_migrate` and `rating_runtime` all connect successfully after the revoke. ✔ verified for `rating_runtime`/`app_runtime`; *(re-confirm `app_migrate` against the target server before running)*
32. `rolconnlimit` on `rating_runtime` equals the configured value, and equals it again after a second run of the script.

**Default privileges (D5)**

33. Creating a throwaway table in `rating` as `app_migrate` gives `rating_runtime` and `app_runtime` `SELECT` and **nothing else** — no `INSERT`, no `UPDATE`, no `DELETE`.
34. `ALTER DEFAULT PRIVILEGES … GRANT UPDATE (col) …` is rejected by Postgres, confirming the reason item 33 is written that way rather than as a preference. ✔ verified

**Idempotency and hygiene**

35. The script runs twice with no error and no privilege drift — the full `pg_attribute` enumeration is byte-identical after the second run.
36. Running it against a database where `rating_runtime` already exists converges the connection limit (the `ELSE ALTER ROLE` branch).
37. The script contains no password. The connection limit is a committed constant (20), identical in every environment — it is a design value, not an environment-specific one; if an environment ever needs a different limit, that is a spec change, not a deployment variable.
38. `npm run db:bootstrap-rating-roles` is registered and documented in `infra/docs/db-role-verification.md`, including the manual `ALTER ROLE … PASSWORD` step.
39. `tsc --noEmit`, ESLint, Prettier clean. No `core.PERMISSIONS` row, no page, no route.

---

## Escalations raised by this unit

| # | Finding | Scope | Action |
| --- | --- | --- | --- |
| E1 | `PUBLIC` holds `EXECUTE` on four `billing` `SECURITY DEFINER` functions; any login role can post ledger transfers | **Platform / billing module** — predates rating | Closed here by Step 9. Raise against the billing module so the revoke is owned where the functions live, and so the next `SECURITY DEFINER` function ships with it. |
| E2 | `PUBLIC` holds `CONNECT` on the billing database | **Platform** | Closed here by Step 2. Inv #18 (rm04) depends on it. |
| E3 | `ALTER DEFAULT PRIVILEGES` cannot be column-scoped, so no default privilege can express this module's boundary | **Rating** | Absorbed into D5 as a rule. Worth adding to `context/code-standards.md` alongside §6.20 if a second module adopts column-scoped grants. |
