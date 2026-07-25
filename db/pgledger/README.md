# db/pgledger — vendored fork

This folder is the pgledger double-entry ledger engine, forked into the
`billing` Postgres schema (ac01, Q10). It is **not** hand-written SQL — it is
a vendored pristine upstream file plus a repeatable transform pipeline that
produces the schema-qualified output actually shipped in
`db/migrations/0011_billing_pgledger.sql`.

## Files

| File | What it is |
|---|---|
| `pgledger.sql` | Pristine upstream — byte-identical to [pgr0ss/pgledger](https://github.com/pgr0ss/pgledger)'s `pgledger.sql` at `UPSTREAM_COMMIT`. Never edited. |
| `UPSTREAM_COMMIT` | The upstream git commit SHA `pgledger.sql` was vendored from. |
| `ulid.sql` | Vendored ULID helper (`uuid_to_ulid`/`format_ulid`) that pgledger's own id generation depends on — see the file's header for provenance (it is itself vendored by upstream pgledger from `scoville/pgsql-ulid`, not authored by us). Hand-qualified into `billing` (small and stable enough not to need the transform pipeline). |
| `transform.ts` | Reads `pgledger.sql` + `UPSTREAM_COMMIT`, qualifies every pgledger object into `billing`, injects `SET search_path = billing, pg_catalog` into every function, and writes `billing-pgledger.generated.sql`. |
| `billing-pgledger.generated.sql` | **Generated output — committed but never hand-edited.** The migration's DDL body (for the pgledger portion) is a literal copy of this file's content. |

## Why a fork instead of a separate schema or a hand migration

See `context/accounting-management/specs/ac01-pgledger-foundation.md` §2.1.
Short version: money-posting (Accounts module, later units) needs the ledger
in the same transaction/schema as the module's own tables, and hand-editing
upstream SQL would destroy the ability to diff against future upstream
changes.

## Upgrade procedure

1. Replace `pgledger.sql` with the newer upstream file (from the same repo,
   `pgr0ss/pgledger`).
2. Bump `UPSTREAM_COMMIT` to the new file's commit SHA.
3. Run `npm run pgledger:transform` to regenerate
   `billing-pgledger.generated.sql`.
4. **Review the generated diff carefully** — this is the whole point of the
   pipeline: the reviewer sees exactly what upstream changed and exactly
   what the transform produced. If upstream added a new object kind the
   transform doesn't recognise, `transform.ts` fails loudly (`Unrecognised
   top-level statement`) instead of silently passing it through unqualified
   — extend the qualification rules and `EXPECTED_COUNTS` in `transform.ts`
   first.
5. Land a new deliberate migration with the diff (never re-run/re-apply
   `0011_billing_pgledger.sql` — migrations are immutable once merged, per
   platform code-standards §6).

**Never hand-edit `billing-pgledger.generated.sql` or `pgledger.sql`.**
A hand-edit to either is a review-blocking defect (module invariant #14) —
the only legitimate way to change the generated output is to change an
input (`pgledger.sql` / `UPSTREAM_COMMIT`) and re-run the transform.

## Why `ulid.sql` was vendored rather than reusing `core.generate_ulid()`

`core.generate_ulid()` already exists (um27, returns `uuid`) but is not a
substitute here: it generates a whole new ULID from scratch, whereas
pgledger's own `pgledger_generate_id(prefix)` already generates its own
time-ordered id (`pgledger_uuidv7()`) and only needs a `uuid → ULID text`
converter for the last step — exactly what `ulid.sql` (`uuid_to_ulid`)
provides, and exactly what upstream pgledger itself vendors for that
purpose. Substituting `core.generate_ulid()` would mean hand-editing
`pgledger_generate_id`'s body, which module invariant #14 forbids. See
`acctmgmt-progress-tracker.md` session notes for the full reasoning.
