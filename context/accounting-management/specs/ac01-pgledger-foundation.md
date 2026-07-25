# AC01 — pgledger Foundation: Vendored Fork, Transform Pipeline, ULID Helpers, `billing.*` Raw-SQL Migration

- **Unit:** 1 of 17 (`ac00-build-plan.md`)
- **Dependencies:** the platform migration chain only (one Drizzle migration history, Platform architecture §"Migrations"; `core.*` already migrated by prior modules). No Accounts-module unit precedes this one. Reuses nothing from the Accounts module — this is the module's first commit.
- **Authorizing sections:** `acctmgmt-project-overview.md` *Features → Ledger & GL* ("pgledger fork in the `billing` schema with vendored upstream + transform script"), *In scope* ("the forked pgledger tables/functions"); `acctmgmt-architecture.md` §1 (Stack — "Double-entry ledger / Migrations" rows), §2 (`db/pgledger/**` ownership row), §3 (Storage model — "Ledger accounts / transfers / entries" row, ID convention), §6 Module Invariants #1 (zero-sum), #4 (append-only), #14 (fork integrity); `acctmgmt-code-standards.md` §1.1, §6.3 (pgledger access rules), §6.4 (fork migration discipline), §7 (`db/pgledger/` file tree); decision **Q10** (fork into `billing`, vendored upstream + commit hash + transform), Q12 (single-currency `sys.*` family, model multi-currency-ready); plan Part A §1.1 (pgledger built-ins, verified function signatures) and §4 verification step 1 (zero-sum). Platform `architecture.md` §3 (one migration history, raw-SQL migrations allowed), general `code-standards.md` §6 (migration discipline — never hand-edit an applied migration).
- **Note on codebase verification:** this session has only the planning folder mounted (`_plan_enterprise-billing-app`), not the live `enterprise-billing-app` repo — so, as with `cm01`, no first-hand "codebase state verified" line is given. Two details must be confirmed against the live repo at implementation time and this spec corrected in the same change if they differ: (a) the **next free migration index** in `db/migrations/` (the journal is not readable this session), and (b) whether a Postgres **ULID generator already exists** in `core` from a prior module — if one does, §3.3's vendored helper is dropped and the fork references the existing function instead (the build plan's "ULID helpers (merged)" wording assumes none exists yet; verify before vendoring a duplicate).

---

## 1. Goal

Land the entire pgledger double-entry engine — its three tables (`pgledger_accounts`, `pgledger_transfers`, `pgledger_entries`), its three read views, and its functions (`pgledger_create_account`, `pgledger_create_transfer`, `pgledger_create_transfers`) — **schema-qualified into `billing`**, as one raw-SQL Drizzle migration that is *generated output* of a committed, repeatable transform pipeline (vendored pristine upstream `pgledger.sql` + an `UPSTREAM_COMMIT` file + `transform.ts`), preceded in the same migration by the vendored ULID helper the fork needs for its `pgla_`/`pglt_` ids. Done when the migration applies cleanly to a fresh Postgres 16 database, a scratch integration test creates two `billing.pgledger` accounts and posts one transfer between them, and the V1 zero-sum harness (`select sum(balance) from billing.pgledger_accounts_view where currency = 'MYR'` = 0) is green. **No module tables, no `db/schema/billing/**`, no repositories, no application code exist after this unit** — this is purely the money engine and its provenance tooling.

## 2. Design

No UI, no TypeScript domain code, no repositories. "Design" here is (a) the fork/transform discipline that makes the ledger SQL reproducible and auditable, and (b) the exact shape of the one migration. Boundary: **`db/pgledger/**` and `db/migrations/**` only**, plus the two `package.json` script lines that run the transform and the scratch test. Nothing lands in `db/schema/`, `db/repositories/`, `services/`, `validation/`, `actions/`, or `app/`.

### 2.1 Why a vendored-fork + transform pipeline, not a hand-written migration (Q10, Module Inv. #14)

pgledger is upstream SQL we do not own. Three options were possible: (1) copy the SQL into a migration and hand-edit the schema prefix, (2) install it into its own `pgledger` schema, (3) fork it into `billing` via a repeatable transform. Q10 chose (3), and Module Invariant #14 makes it a CI-enforced rule: **the pgledger SQL that ships in migrations is transform-script output from the vendored upstream file at a recorded commit hash — never hand-edited.** The rationale, restated so later maintainers do not "simplify" it away:

1. **One schema, one transaction boundary.** Onboarding (ac04) and every document post (ac07+) commit master-data rows *and* `pgledger_create_transfers()` in one DB transaction (Module Inv. #5). That atomicity is trivial when the ledger lives in the same `billing` schema as the module tables — no cross-schema transaction ceremony, no `search_path` surprises. Hence fork into `billing`, not a separate `pgledger` schema.
2. **Upgrades stay auditable.** Hand-editing upstream SQL destroys the diff against upstream. With the pipeline, upgrading is: replace `pgledger.sql` with the newer upstream file → bump `UPSTREAM_COMMIT` → re-run `transform.ts` → **review the generated diff** → land a new deliberate migration (code-standards §6.4). The reviewer sees exactly what upstream changed and exactly what the transform produced.
3. **The generated file is committed but treated as a build artifact.** Like a lockfile: it is in git (so migrations are byte-reproducible and CI needs no network), but a hand-edit to it is a review-blocking defect — the only legitimate way to change it is to change an input and re-run the transform.

### 2.2 What the transform does — and must not do

The transform is a **pure text/AST-level schema-qualification pass** over the upstream SQL. It qualifies identifiers into `billing.` and does nothing else:

- **Qualifies:** every `CREATE TABLE`/`VIEW`/`FUNCTION`/`TYPE`/`INDEX`/`SEQUENCE` target and every internal reference to a pgledger object (`pgledger_accounts` → `billing.pgledger_accounts`, `pgledger_create_transfer` → `billing.pgledger_create_transfer`, the `pgledger_accounts_view`, the entry/transfer views, any enum/composite types such as the `transfer_request` array type used by `pgledger_create_transfers`). Sets each function's `search_path` explicitly (e.g. `SET search_path = billing, pg_catalog`) so a caller's session `search_path` can never redirect a pgledger internal lookup.
- **Must NOT touch:** any business logic — the same-currency-legs check, `amount > 0` enforcement, the sorted-account locking that prevents deadlocks in `pgledger_create_transfers`, the signed-balance/version bookkeeping, the zero-sum property, `allow_negative_balance`/`allow_positive_balance` default handling. The transform changes *namespaces*, never *behaviour*. A test asserts the generated function bodies are logic-identical to upstream modulo qualification (§3.6).
- **Must NOT rename** the objects beyond prefixing: the public function names stay `pgledger_create_account` / `pgledger_create_transfer(s)` (just `billing.`-qualified) because repositories (ac02+) call them by those exact names, and the views stay `pgledger_accounts_view` / `pgledger_transfers_view` / `pgledger_entries_view` (code-standards §6.3 names them verbatim as the only permitted read surface).

### 2.3 ULID helpers "merged" into this unit

pgledger ids are prefixed ULIDs (`pgla_…` accounts, `pglt_…` transfers — architecture §3, plan §1.1). Postgres has no native ULID type, so the fork depends on a SQL ULID-generation helper. The build plan folds this dependency into ac01 ("ULID helpers (merged)") rather than giving it its own unit, following the `cm00`/`pm00` "merge always-together work" rule — the fork cannot create an account without it. Design decisions:

1. **Vendored, not hand-written.** The helper is a small, well-known SQL/PLpgSQL ULID implementation vendored as `db/pgledger/ulid.sql` with its own provenance note in a header comment (source + commit/version), consistent with the fork discipline — we do not invent crypto/encoding primitives inline.
2. **Prepended, not a separate migration.** The helper SQL is emitted **before** the pgledger SQL in the *same* migration file, because the pgledger table defaults reference the ULID function — it must exist first. One migration = ULID helper + pgledger fork (the unit's whole DDL), mirroring `cm01`'s "one migration for the whole schema" precedent.
3. **Namespace.** The ULID function is created in `billing` too (qualified the same way), so nothing pgledger touches escapes the module schema. If §"Note on codebase verification" finds an existing `core` ULID generator, this file is dropped and `transform.ts` is pointed at the existing function name instead — no duplicate primitive.

### 2.4 Currency posture (Q12) and negative balances

This unit seeds **no** `sys.*` accounts and **no** data of any kind — those are ac03. It only installs the engine. Two engine facts are load-bearing for every later unit and are asserted by the scratch test here so a regression surfaces at the foundation, not three units later:

- `allow_negative_balance` defaults to **true** (plan §1.1), so `sys.*` and `unapplied_cash` accounts (created in ac03/ac04) can hold credit (negative) balances without special flags; `pgledger_create_account(… allow_negative_balance => false)` is passed only where an overdraw must hard-fail (decided per-account in later units, not here).
- The engine enforces **same-currency legs** and **`amount > 0`** inside `pgledger_create_transfer(s)`; the scratch test proves both by asserting a cross-currency transfer and a zero/negative-amount transfer are rejected by the engine, not by app code (Module Inv. #1/#4 foundations).

### 2.5 Structural decisions

- **Raw-SQL migration, not a Drizzle schema file.** pgledger is functions + views + trigger-like logic that Drizzle's schema DSL cannot express; per architecture §1 it is carried as a **raw-SQL Drizzle migration** in the one shared history. No `pgledger` objects are ever added to `db/schema/**` or introspected by `drizzle-kit` — Drizzle owns the *ordering slot* in the journal, not the DDL body.
- **`drizzle-kit` must not try to manage these tables.** The `pgledger_*` tables live in `billing`; ac02 will add `pgSchema('billing')` module tables to `schemaFilter`. To stop a future `db:generate` from emitting spurious `DROP TABLE billing.pgledger_*` diffs (drizzle-kit would see tables it has no schema for), the pgledger tables are recorded in drizzle-kit's ignore surface — either via `schemaFilter` scoping or `tablesFilter` excluding `pgledger_*` (confirm the exact mechanism against the installed drizzle-kit version at implementation time; note it here). This is the one genuinely fiddly interaction and is called out so ac02 does not rediscover it.
- **No `CREATE EXTENSION`.** pgledger is pure SQL/PLpgSQL; the ULID helper is pure SQL/PLpgSQL. This unit adds no Postgres extension (no `pgcrypto`, no `uuid-ossp`) unless the vendored ULID helper genuinely requires `pgcrypto` for random bytes — if so, the `CREATE EXTENSION IF NOT EXISTS pgcrypto` is the migration's first statement and is called out in the verification checklist as a deliberate, reviewed addition (not silent).

---

## 3. Implementation

### 3.1 `db/pgledger/` layout (new folder)

Per architecture §2 (`db/pgledger/**` owns "vendored upstream `pgledger.sql`, upstream commit hash, transform script, generated `billing.*`-qualified SQL") and code-standards §7 file tree:

```
db/pgledger/
  pgledger.sql                     # pristine upstream, byte-identical to the file at UPSTREAM_COMMIT — never edited
  UPSTREAM_COMMIT                  # single line: the upstream git commit hash the pgledger.sql was vendored from
  ulid.sql                         # vendored ULID helper (header comment: source + version); dropped if core already has one (§2.3.3)
  transform.ts                     # the qualification pass (§3.2)
  billing-pgledger.generated.sql   # transform OUTPUT — committed, never hand-edited (the migration copies from this)
  README.md                        # 6-line note: what this folder is, the upgrade procedure (§2.1.2), "do not edit generated file"
```

`pgledger.sql` and `UPSTREAM_COMMIT` are the provenance pair Module Inv. #14 requires. The header of `billing-pgledger.generated.sql` is a generated banner: `-- GENERATED by db/pgledger/transform.ts from pgledger.sql @ <UPSTREAM_COMMIT> — DO NOT EDIT`.

### 3.2 `transform.ts` — the qualification pass

A Node script (run via `tsx`, no framework) that reads `pgledger.sql` + `UPSTREAM_COMMIT`, applies the §2.2 qualification rules, and writes `billing-pgledger.generated.sql` with the banner. Requirements:

1. **Deterministic and idempotent** — running it twice on the same inputs yields a byte-identical file (CI asserts this: re-run in a clean checkout and `git diff --exit-code db/pgledger/billing-pgledger.generated.sql`).
2. **Qualification is explicit, not a blind `s/pgledger_/billing.pgledger_/g`.** It qualifies object *definitions and references* while leaving string literals, comments' prose, and already-qualified names untouched. Prefer a tokenizer/light SQL-aware pass over a naive regex; if a regex approach is used, it is accompanied by the §3.6 logic-equivalence test as the safety net, and the regex set is enumerated in a comment.
3. **Injects `SET search_path = billing, pg_catalog` into every `CREATE FUNCTION`** (§2.2) so no session `search_path` can redirect internal lookups.
4. **Fails loudly** (`process.exit(1)`, `lib/logger` style if available in a build script, else `console.error` is acceptable in a build-only script — match the repo's existing build-script convention) if `pgledger.sql` or `UPSTREAM_COMMIT` is missing, or if the input contains an object it does not recognise how to qualify (so a future upstream that adds a new object type cannot silently pass through unqualified).

### 3.3 `db/pgledger/ulid.sql` — vendored ULID helper (§2.3; skip if core has one)

Vendored SQL defining a single function that returns a ULID string, used by pgledger's id defaults. Header comment records source + version. The transform qualifies it into `billing` alongside the pgledger objects (or it is emitted as-is into `billing` in the migration ordering before pgledger — see §3.4). **If §"Note on codebase verification" finds an existing `core` ULID generator, delete this file and set `transform.ts` to reference the existing function's qualified name; record that decision in this spec and the progress tracker.**

### 3.4 The raw-SQL migration — `db/migrations/00XX_billing_pgledger.sql` (new)

This unit does **not** run `db:generate` to author DDL (there is no Drizzle schema to diff). Instead it adds a raw-SQL migration file to the history in the next free index (§"Note on codebase verification" — confirm the index against the live journal) and its journal entry, following the platform's raw-SQL-migration path. The file, in order:

1. (Only if the vendored ULID helper needs it) `CREATE EXTENSION IF NOT EXISTS pgcrypto;` — flagged in the checklist as a reviewed addition (§2.5).
2. `CREATE SCHEMA IF NOT EXISTS "billing";` — the module schema is created here, by the module's first migration (later units assume it exists).
3. The **ULID helper** SQL (billing-qualified) — before pgledger, because pgledger id defaults call it (§2.3.2).
4. The **contents of `billing-pgledger.generated.sql`** — tables, sequences/types, functions, then views, in upstream's own dependency order (the transform preserves ordering).

The migration body for steps 3–4 is the generated file's content, copied in (or `\i`-included at build time and inlined) — never re-typed or edited. **Verify by hand** (this file is what CI/CD applies) that: the schema is created before any `billing.` object; the ULID function precedes the table that defaults to it; functions precede the views that select from them; and the file contains no reference to an unqualified `pgledger_*` name (a stray unqualified name means the transform missed something — fix the transform and regenerate, do not patch the migration).

No permission-registry INSERT in this migration (this unit ships no page and no permission — the three `accounts_*` permissions land with their first consuming page in ac05/ac07/ac12). No seed data (ac03).

### 3.5 drizzle-kit wiring (minimal)

- Ensure `billing` is not accidentally dropped by future generates: apply the §2.5 `schemaFilter`/`tablesFilter` decision now (the pgledger tables exist from this migration onward). Document the exact one-line config change in the diff.
- Add the raw-SQL migration to the drizzle journal/meta so `db:migrate` applies it in sequence (raw-SQL migrations still get a journal entry; follow the platform's existing raw-SQL-migration precedent — if none exists yet in this repo, this unit establishes it and the checklist calls that out).

### 3.6 `package.json` scripts

- `"pgledger:transform": "node --import tsx db/pgledger/transform.ts"` — regenerates `billing-pgledger.generated.sql` from the vendored inputs.
- Wire a **CI check** (existing test/lint pipeline) that runs `pgledger:transform` and fails if the generated file changes (`git diff --exit-code`) — this is what enforces Module Inv. #14 mechanically (generated file is always in sync with inputs, never hand-edited).

### 3.7 Guardrail tests owned by this unit

**Transform unit test (no DB) — `tests/pgledger/transform.test.ts`:**
- Running `transform.ts` on the vendored `pgledger.sql` produces output byte-identical to the committed `billing-pgledger.generated.sql` (idempotency / in-sync guarantee, mirrors the CI check).
- **Logic-equivalence assertion:** every `CREATE FUNCTION` body in the generated file equals the upstream body with only namespace qualification and the injected `search_path` differing (strip qualification + `SET search_path` line, then compare token streams) — proves §2.2's "changes namespaces, never behaviour."
- No unqualified `pgledger_*` or bare ULID-helper reference survives in the generated file (regex assertion over the output).

**Scratch + V1 integration test (`describe.skipIf(!databaseUrl)`) — `tests/accounts/v01-zero-sum.integration.test.ts`** (named for the plan's V1, code-standards §7.1; this is the file every later posting test re-runs its zero-sum assertion into, workflow rules §5):
- Fresh-migrate a clean PG16; assert `billing` schema, the three `billing.pgledger_*` tables, the three views, and the three functions exist under introspection.
- **Scratch scenario (the unit's visible result):** call `billing.pgledger_create_account('scratch.a', 'MYR')` and `billing.pgledger_create_account('scratch.b', 'MYR')` (ids come back `pgla_…`), then `billing.pgledger_create_transfer(a, b, '100.00')` (id `pglt_…`); assert `pgledger_accounts_view` shows `a = 100.00` and `b = -100.00` (or the engine's signed convention), and `pgledger_entries_view` shows the two legs with correct previous/current balances.
- **V1 zero-sum:** `select sum(balance) from billing.pgledger_accounts_view where currency = 'MYR'` = `0` after the transfer (plan §4 step 1).
- **Engine guardrails:** a cross-currency transfer (`MYR` → a `USD` scratch account) is rejected by the engine; a transfer with `amount <= 0` is rejected — both by pgledger itself, with no app-layer check present.
- **Teardown** drops `billing` CASCADE so re-migration against a clean DB works (mirrors `cm01`'s teardown update; note that ac02's teardown will also drop `billing`, so keep the drop idempotent / coordinate ordering).

### 3.8 Explicitly NOT in this unit

No `db/schema/billing/**` and no Drizzle module tables (`financial_account`, `billing_account`, … are **ac02**). No `account_view`/`gl_resolution_view`/`gl_journal_view` (ac02). No repositories in `db/repositories/accounts/**` (ac02 skeletons; ac01 ships zero application access to the ledger — the scratch test calls the functions directly via the raw client, which is *test* code, not app code). No `sys.*` accounts, CoA, mappings, reason codes, or bill cycles (all **ac03**). No permission migration, no page, no nav, no component, no service, no action, no `money.ts` (ac07). No overdue/balance derivation logic (read-time, later units). This unit's entire surface is the engine and its provenance tooling.

---

## 4. Dependencies (packages to install)

- **No new npm runtime packages.** `drizzle-orm`, `drizzle-kit`, `postgres`, `tsx`, and the test runner are already present from prior modules. `transform.ts` uses Node builtins (`fs`, `path`) + `tsx` to run — no new dependency.
- **Vendored (not npm):** upstream `pgledger.sql` at the commit recorded in `UPSTREAM_COMMIT`, and the ULID helper SQL (`ulid.sql`) — both committed into `db/pgledger/`, not fetched at build/deploy time (CI needs no network; provenance is the `UPSTREAM_COMMIT` file).
- **Postgres extension:** none, unless the vendored ULID helper requires `pgcrypto` (§2.5) — in which case `CREATE EXTENSION IF NOT EXISTS pgcrypto` is added as the migration's first statement and flagged as a reviewed decision. Confirm which ULID implementation is vendored before assuming.

## 5. Verification checklist

**Diff hygiene**
- [ ] Added: `db/pgledger/{pgledger.sql, UPSTREAM_COMMIT, ulid.sql, transform.ts, billing-pgledger.generated.sql, README.md}`, `db/migrations/00XX_billing_pgledger.sql` + journal/meta entry, the `drizzle.config.ts` filter line (§3.5), `package.json` (`pgledger:transform` script + CI hook), the two new test files. Nothing else — no `db/schema/`, `db/repositories/`, `services/`, `validation/`, `actions/`, `app/`, or `components/` path exists yet.
- [ ] `billing-pgledger.generated.sql` carries the generated banner and is byte-identical to a fresh `pgledger:transform` run; `pgledger.sql` is byte-identical to upstream at `UPSTREAM_COMMIT`; neither generated file nor `pgledger.sql` has been hand-edited.
- [ ] No `TODO`, no commented-out SQL, no `console.*` outside the build-only `transform.ts` (which follows the repo's build-script convention).
- [ ] `CREATE EXTENSION` appears **only** if the vendored ULID helper requires it, and if present is the migration's first statement and is noted in the PR description as reviewed.

**Build / fork-integrity gates (the point of the unit)**
- [ ] `npm run pgledger:transform` is idempotent — re-running leaves `git status` clean (Module Inv. #14 mechanical enforcement).
- [ ] Transform unit test green: output in sync with inputs; every `CREATE FUNCTION` body is logic-equivalent to upstream modulo qualification + injected `search_path`; no unqualified `pgledger_*` name survives.
- [ ] `npm run typecheck` / `lint` / `format:check` green including `transform.ts`.

**Data-layer guardrails**
- [ ] Fresh DB: `db:migrate` applies the migration cleanly on Postgres 16; `billing` schema + 3 `pgledger_*` tables + 3 views + 3 functions present under introspection; a subsequent `db:generate` produces **no** spurious `DROP`/`ALTER` on `billing.pgledger_*` (the §2.5 filter works).
- [ ] Scratch test: two `billing.pgledger` accounts created (`pgla_…` ids), one transfer posted (`pglt_…`), balances and entry legs correct.
- [ ] **V1 zero-sum** green: `sum(balance)` over `billing.pgledger_accounts_view where currency='MYR'` = 0 after the transfer.
- [ ] Engine rejects a cross-currency transfer and an `amount <= 0` transfer with no app-layer check present.

**Docs in sync**
- [ ] `db/pgledger/README.md` states the upgrade procedure (replace `pgledger.sql` → bump `UPSTREAM_COMMIT` → `pgledger:transform` → review diff → new migration) and "never edit the generated file."
- [ ] `acctmgmt-progress-tracker.md`: `ac01` marked complete with commit ref; "Next Up" → `ac02`; the two §"Note on codebase verification" confirmations (migration index; existing-ULID check) recorded as done or as spec corrections.

**Pipeline**
- [ ] CI green end-to-end (including the `pgledger:transform` sync check and SAST; DAST surface unchanged — no routes added).

Any failing item means the unit isn't done. `ac02` (module tables, views, repository skeletons) must not start until this migration is verified and merged — every module table's ledger binding and every repository depends on these functions and views existing under `billing`.
