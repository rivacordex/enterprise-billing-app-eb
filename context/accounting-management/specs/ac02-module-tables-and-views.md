# AC02 — Module Tables & Views: 10 `billing.*` Drizzle Tables, 3 Composition Views, Repository Skeletons

- **Unit:** 2 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac01` (the `billing` schema exists; the `billing.pgledger_*` tables/views/functions are installed — `ledger_binding.pgledger_account_id` references pgledger account ids and `gl_resolution_view`/`gl_journal_view` read `pgledger_accounts_view`/`pgledger_entries_view`). Cross-schema FKs to `customer.party_role` (`PTRL…`, Q28) and `core.appuser` (provenance) — both assumed migrated by prior modules.
- **Authorizing sections:** `acctmgmt-project-overview.md` *In scope* (the 11-table list — 10 module tables + the pgledger fork from ac01), *Account management* ("`account_view` composes the TMF base-Account shape … `relatedParty[]` from the `ref_party_role_id` FK", Q6/Q28); `acctmgmt-architecture.md` §2 (`db/schema/billing/**`, `db/repositories/accounts/**` ownership rows), §3 (Storage model — every table row), §6 Module Invariants #2 (no stored balances), #9 (binding completeness — the UNIQUE half), #10 (GL resolution total), #13 (terms freeze — columns only); `acctmgmt-code-standards.md` §2.1 (domain unions), §2.6 (TMF composition types), §6.2 (ID prefix registry), §6.5 (JSONB shape guards), §6.6 (monetary columns `numeric(18,2)`, `currency char(3)`), §6.7 (line↔transfer UNIQUE), §7 (`db/schema/billing/`, `db/repositories/accounts/` file tree); decisions **Q6** (two tables + view, no supertype/`ACC…`), **Q13** (`bill_cycle` catalog, FK replaces loose columns), **Q18** (`document`/`document_line`), **Q28** (`ref_party_role_id` FK, TMF shape composed in view), Q14/Q19/Q20/Q22/Q23/Q25 (columns only). Plan Part A §1.2–§1.3 (verbatim table shapes), §2 (sample rows as the view fixture). Platform `architecture.md` §3 (IDs, JSONB exemption), §4 (schema-per-module, one migration history).
- **Note on codebase verification:** planning-folder-only session (as `ac01`). Confirm at implementation time: (a) next free migration index; (b) the exact `customer.party_role` id column name and `core.appuser` PK column name for the cross-schema FKs (this spec assumes `party_role.party_role_id` and `appuser.user_id`/`appuser.id` per `cm01`/prior specs — reconcile against live schema and correct in the same change); (c) whether Drizzle can express a `pgSchema('billing')` **view** or whether the three views ship as raw SQL in this unit's migration (this spec assumes raw-SQL views appended to the migration — the safest option given the pgledger joins — see §2.4).

---

## 1. Goal

Create all ten Accounts module tables in the `billing` schema in one Drizzle migration — `financial_account`, `billing_account`, `bill_cycle`, `reason_code`, `document`, `document_line`, `ledger_binding`, `gl_account`, `gl_mapping`, `accounting_period` — with their ID sequences/prefixes, enum-as-text CHECK constraints, cross-schema FKs (`ref_party_role_id → customer.party_role`, audit FKs → `core.appuser`), the UNIQUE constraints that enforce one ledger account per owner-role (Inv. #9) and one transfer per posted line (Inv. #7), and the JSONB shape guards (Q22 `mode_ref`, contact) — plus the three composition views `account_view` (Q6/Q28 TMF shape), `gl_resolution_view` (every pgledger account → one postable GL code), and `gl_journal_view` (entries aggregated to GL debit/credit), and the empty **repository skeletons** under `db/repositories/accounts/`. Done when the migration applies cleanly onto an ac01 database, the domain unions/TMF types compile, and an integration test inserts a fixture FA + BAN row and asserts `account_view` returns both with the correct `account_type` literal and composed `relatedParty[]` shape. **No seeds, no services, no pages, no repository method bodies** — the schema is queryable and the TMF shape composes; nothing writes to the ledger yet.

## 2. Design

No UI. "Design" is the schema shape, the three views' SQL, and the repository seams. Boundary: **`db/schema/billing/**`, `db/repositories/accounts/**` (skeletons only), `db/migrations/**`, `types/accounts.ts`, `validation/accounts/` (only the JSONB/shape Zod used by the schema `$type`s if colocated)** — plus `drizzle.config.ts` (`billing` already in `schemaFilter` from ac01; add module tables to the managed surface). No `services/`, `actions/`, `app/`, `components/`.

### 2.1 Enum-as-text + CHECK, matching the module unions (code-standards §2.1)

Every status/type/nature/kind column is `text` + a CHECK listing the union members, not a Postgres enum — mirroring `cm01`'s decision (2-of-3 codebase precedent) so each column lines up 1:1 with the `as const` unions in `types/accounts.ts` (code-standards §2.1 lists them verbatim) with no second pg-type migration path when a value is added. Applies to: `financial_account.state`, `billing_account.{state, rating_type, payment_status}`, `bill_cycle.{frequency, state}`, `reason_code.{doc_type, posting_nature, state}`, `document.{doc_type, state, payment_mode}`, `document_line.line_kind`, `ledger_binding.{owner_type, ledger_role}`, `gl_account.{account_class, normal_balance, state}`, `gl_mapping.selector_type`, `accounting_period.state`.

### 2.2 ID prefix registry — verbatim from code-standards §6.2

One sequence per table in `billing`, assembled as a SQL default (`'<PREFIX>' || lpad(nextval('billing.<t>_seq')::text, <pad>, '0')`), never in app code (platform §6.18):

| Prefix | Table | Pad |
|---|---|---|
| `FIN` | `financial_account` | 6 |
| `BAN` | `billing_account` | 6 |
| `BCY` | `bill_cycle` | 6 |
| `LBD` | `ledger_binding` | 6 |
| `GLM` | `gl_mapping` | 6 |
| `DLN` | `document_line` | 8 |
| `PAY`/`DEP`/`CRN`/`DBN`/`ADJ` | `document` (per-type sequences) | 8 |

`reason_code` (`reason_code` PK) and `gl_account` (`gl_code` PK) are **natural keys** — no prefix, no sequence. `accounting_period`'s PK is the composite `(period, currency)`, `period` itself formatted `YYYY-MM` (natural, §2.3). pgledger keeps its own `pgla_`/`pglt_` ULIDs (ac01) — never re-generated or parsed by app code.

**Per-type document sequences (Q18/§6.2).** `document_id` is prefix-by-`doc_type` with **five separate sequences** (`document_pay_seq`, `document_dep_seq`, …). The default expression cannot switch on a column value, so `document_id` is assembled in the **insert repository** (the documented exception to "IDs in the DB layer" — it is still the DB layer, code-standards §6.2) by selecting `nextval` for the row's `doc_type`; the column itself is a plain `text PRIMARY KEY` with no default. This is the one table whose id is not a column default, and it is called out so ac07 (the first `document` writer) does not add a default and collide.

### 2.3 Table shapes (Part A §1.2–§1.3, verbatim)

Each table below carries `last_modified timestamptz(3) NOT NULL default now()` and `last_edited_by text FK → core.appuser` (nullable where a seed/infra write with no acting user is expected — `bill_cycle`, `reason_code`, `gl_account`, `gl_mapping`, `accounting_period` seeds; NOT NULL on `document`/`document_line`/`financial_account`/`billing_account`/`ledger_binding` which are always created by an actor). All monetary columns are `numeric(18,2)`; `currency` is `char(3)` (code-standards §6.6). Optimistic-lock column is `last_modified` on `document` and on each catalog table (code-standards §2.5); millisecond precision `(3)` for the same round-trip reason as `cm01`.

- **`financial_account`** (`FIN`, 6): `name` NOT NULL, `description`, `state` CHECK ∈ ACCOUNT_STATES default `active`, `ref_party_role_id` **NOT NULL FK → customer.party_role** (Q28), `contact` jsonb (shape-guarded §2.5), `currency` char(3) NOT NULL, `credit_limit_amount` numeric(18,2). **No stored balance column** (Inv. #2).
- **`billing_account`** (`BAN`, 6): base fields as FA (`name`/`description`/`state`/`ref_party_role_id`/`contact`), `ref_financial_account_id` **NOT NULL FK → financial_account** (currency must match — asserted by test V2, not a constraint, code-standards §6.6), `currency` char(3) NOT NULL, `rating_type` CHECK ∈ {prepaid,postpaid} default `postpaid` (Q23 — `prepaid` in the union for schema stability, wizard offers postpaid only), `payment_status` CHECK ∈ PAYMENT_STATUSES {paid,due,in_dispute} default `paid` (**overdue is NOT a stored value**, Q8/Inv. #2), `credit_limit_amount` numeric(18,2), `ref_bill_cycle_id` **NOT NULL FK → bill_cycle** (must be `active` at assignment — app-checked in ac04, Inv. #11), `payment_due_days_override` integer NULL (Q14/Inv. #13), `default_payment_method_ref` text.
- **`bill_cycle`** (`BCY`, 6): `name` NOT NULL UNIQUE, `description`, `frequency` CHECK ∈ {monthly,quarterly,annually} default `monthly`, `cycle_day` integer NOT NULL default 1 (CHECK 1–28), `payment_due_days` integer NOT NULL default 30, `state` CHECK ∈ {active,retired} default `active` (Q13 — never delete).
- **`reason_code`** (natural PK `reason_code`): `name`/`description`, `doc_type` CHECK ∈ DOC_TYPES, `posting_nature` CHECK ∈ POSTING_NATURES (Q19), `auto_post_limit` numeric(18,2) NOT NULL default 0 (Q20 — 0 = always four-eyes), `state` CHECK ∈ {active,retired} default `active`.
- **`document`** (per-type prefix, 8 — §2.2): `doc_type` CHECK ∈ DOC_TYPES, `state` CHECK ∈ DOC_STATES {draft,pending_approval,posted,reversed,cancelled} default `draft`, `ref_financial_account_id` **NOT NULL FK** (context FA, locked item 5), `ref_billing_account_id` FK **nullable** (required for CRN/DBN/ADJ, app-checked ac09/ac10 — Q1), `reason_code` **NOT NULL FK → reason_code**, `currency` char(3) NOT NULL, `total_amount` numeric(18,2) NOT NULL (= Σ lines, app-checked at post — Inv. `UNBALANCED_DOC`), `payment_mode` CHECK ∈ PAYMENT_MODES **nullable** (NOT NULL for PAY/DEP capture — app-checked, Q22), `mode_ref` jsonb (discriminated on `payment_mode`, §2.5), `entry_date` timestamptz NOT NULL default now() (renamed from `reference_date` by AC24; **UI label "Entry Date"**; inert user-entered field, never read by period/GL; captured **date-only**, default today — Q29), `reference_info` text NOT NULL (free-text ref, e.g. transaction code — Q29), `event_at` timestamptz NOT NULL (the document's true business-event date; **UI label "Reference Date"** since AC24; drives period + journal; captured **date-only**, default today, backdatable but a closed-period date is rejected — Q9/Q29), `posted_at` timestamptz NULL, `reversal_of` text FK → self NULL (Q5), `created_by` NOT NULL / `approved_by` NULL FK → core.appuser (Q20 — `approved_by ≠ created_by` enforced in service, ac07), `metadata` jsonb (well-formed + reserved-key typing only — Q25 escrow, code-standards §6.5).
- **`document_line`** (`DLN`, 8): `ref_document_id` **NOT NULL FK → document**, `line_no` integer NOT NULL (**UNIQUE(ref_document_id, line_no)**), `line_kind` CHECK ∈ LINE_KINDS {capture,allocation,charge,release,refund}, `ref_billing_account_id` FK nullable (allocation target BAN — Q1), `ref_settled_document_id` text FK → document nullable (the financial document / charge an `allocation` line settles — the payment↔document application that enables the Q17 refund workbench; Q24), `amount` numeric(18,2) NOT NULL (CHECK > 0), `pgledger_transfer_id` text **UNIQUE** nullable (`pglt_…` set at post — 1:1 line↔transfer, Inv. #7/§6.7), `reversed_by_line_id` text FK → self nullable (Q5).
- **`ledger_binding`** (`LBD`, 6): `owner_type` CHECK ∈ {billing_account,financial_account}, `owner_id` text NOT NULL (polymorphic `BAN…`/`FIN…` — app/trigger-checked, not a DB FK), `ledger_role` CHECK ∈ LEDGER_ROLES {receivables,unapplied_cash,deposits}, `pgledger_account_id` text **NOT NULL UNIQUE** (the `pgla_…` from ac01's `pgledger_create_account`), **UNIQUE(owner_type, owner_id, ledger_role)** (Inv. #9 — one account per role per owner; *existence* of all three is a test, not a constraint, V2).
- **`gl_account`** (natural PK `gl_code`): `name` NOT NULL, `account_class` CHECK ∈ {asset,liability,equity,revenue,expense}, `normal_balance` CHECK ∈ {debit,credit}, `parent_gl_code` text FK → self nullable, `is_postable` boolean NOT NULL default true, `state` CHECK ∈ {active,retired} default `active` (Q26 — mastered here, never delete).
- **`gl_mapping`** (`GLM`, 6): `selector_type` CHECK ∈ {ledger_role,system_account}, `selector` text NOT NULL, `currency` char(3) nullable (null = all currencies for role selectors), `ref_gl_code` **NOT NULL FK → gl_account** (target must be `is_postable` — app/trigger-checked), **UNIQUE(selector_type, selector, currency)** (deterministic resolution — Inv. #10).
- **`accounting_period`** (composite PK `(period, currency)`, `period` = `YYYY-MM`): `currency` char(3) NOT NULL, `state` CHECK ∈ {open,closed} default `open`, `closed_at` timestamptz NULL, `closed_by` text FK → core.appuser NULL. The PK is the pair, not `period` alone — one period row per currency, MYR-only today but multi-currency-ready per Q12. Full close behaviour is **ac14**; this unit ships the table only.

### 2.4 The three views (composition, no stored balances — Inv. #2)

Shipped as **raw SQL appended to this unit's migration** (§"Note" (c)) because all three join `billing.pgledger_*` which is not in Drizzle's schema surface; they are `CREATE VIEW billing.<name>`:

1. **`account_view`** (Q6/Q28) — `UNION ALL` of `financial_account` and `billing_account`, each projecting the TMF base-`Account` columns plus a literal `account_type` discriminator (`'FinancialAccount'` / `'BillingAccount'`) and each table's id AS `account_id`. It **composes the TMF `relatedParty[]` shape at read time** by joining `customer.party_role` (→ organization name) on `ref_party_role_id` — producing `{id, role:'customer', name, @referredType:'Customer'}` (Q28). No balance columns (balances are live reads elsewhere). This is the unit's headline visible result.
2. **`gl_resolution_view`** (Inv. #10) — every `billing.pgledger_accounts_view` row → its GL code: for `ban.*`/`fa.*` accounts, join `ledger_binding` on `pgledger_account_id` to get `ledger_role`, then `gl_mapping` (selector_type `ledger_role`); for `sys.*` accounts, match `gl_mapping` (selector_type `system_account`, selector = pgledger account name), respecting `currency`. Projects `pgledger_account_id, gl_code` (NULL when unmapped — the health check counts NULLs, V5). Resolution must be **total and unambiguous** — the view resolves each account with a `LATERAL` subselect ordered to prefer a currency-specific `gl_mapping` row over an all-currencies (NULL-currency) row for the same selector, so exactly one row is picked even where the two could otherwise overlap; the 0-unmapped guarantee is a seed/test property (ac03/V5).
3. **`gl_journal_view`** (Inv. #10) — joins `billing.pgledger_entries_view` to `gl_resolution_view` and aggregates by `gl_code` + period (`event_at`): **positive entry amount = debit, negative = credit** (plan §1.3). Projects `gl_code, name, debit, credit` per period; the `Σ debit = Σ credit` total is asserted downstream (V6, ac13/ac14).

### 2.5 JSONB shape guards (code-standards §6.5)

Typed via Drizzle `.$type<…>()` and validated by Zod at the write boundary (schemas colocated in `validation/accounts/`, consumed by later writer units — this unit defines the *types*, not the write path):
- `contact` (FA/BAN): `{ refContactMedium: string /* CTMD… */, contactType: 'billing' | 'finance', name: string }[]`.
- `document.mode_ref`: discriminated union on the sibling `payment_mode` — `bank_transfer → { bankRef }`, `cheque → { chequeNo, bank }`, `cash → { receiptNo }` (Q22).
- `document.metadata`: documented exemption — well-formed JSON + reserved-key typing (`doc`, `dim_*` for Q25 escrow); unknown keys pass through.

### 2.6 Repository skeletons (code-standards §6.3, §7)

`db/repositories/accounts/` gets **skeleton files with typed signatures and no logic** (or minimal read passthroughs), establishing the seam that later units fill and that the ac17 grep-gate enforces ("only callers of pgledger functions and `billing.*` tables"):
- `financial-account.repository.ts`, `billing-account.repository.ts`, `bill-cycle.repository.ts`, `reason-code.repository.ts`, `document.repository.ts` (incl. the `document_id` per-type sequence assembler seam, §2.2), `ledger-binding.repository.ts`, `gl-account.repository.ts`, `gl-mapping.repository.ts`, `accounting-period.repository.ts`, and `ledger.repository.ts` (**the only** wrapper over `pgledger_create_account`/`pgledger_create_transfer(s)` and the three pgledger views — Inv. #3/#4, code-standards §6.3).
- `account-view.repository.ts` — the sole producer of the TMF composition types (`TmfAccountRef`, `TmfRelatedParty`, code-standards §2.6); ships a working `findByAccountId`/`search` reader now since `account_view` is this unit's visible result.

Skeletons compile and export types; empty method bodies `throw new Error('not implemented (acNN)')` with the owning unit noted, except `account-view.repository.ts` and the trivial `findById` readers needed by the fixture test.

### 2.7 Structural decisions

- **DDL split by concern in `db/schema/billing/`** (code-standards §7): e.g. `accounts.ts` (FA/BAN), `catalogs.ts` (bill_cycle/reason_code/gl_account/gl_mapping), `documents.ts` (document/document_line), `ledger-binding.ts`, `periods.ts`, plus `views.sql` (raw) referenced by the migration; `index.ts` re-exports. Match the live repo's existing per-area split convention at implementation time.
- **One migration** = all 10 tables + sequences + constraints + the three raw-SQL views, in FK-dependency order (bill_cycle before billing_account; financial_account before billing_account; gl_account before gl_mapping; document before document_line; pgledger views already exist from ac01 so the three views resolve). **No permission INSERT** (permissions land with their pages — ac05/ac07/ac12). **No seed data** (ac03).
- **`types/accounts.ts`** carries all the `as const` unions (code-standards §2.1, verbatim list) + TMF composition types (§2.6) + re-exported Drizzle row types. Domain **transition maps** (doc state machine) are **ac07**, not here.

---

## 3. Implementation

### 3.1 `db/schema/billing/*.ts` (new) — the 10 tables
Author the Drizzle tables per §2.3 using `pgSchema('billing')`, sequences, `text` PKs with the §2.2 default expressions (except `document`, §2.2), CHECK constraints for every §2.1 column, cross-schema FKs (`customer.party_role`, `core.appuser`) with `ON DELETE RESTRICT`, and the UNIQUE constraints (`ledger_binding` triple, `document_line (ref_document_id,line_no)` and `pgledger_transfer_id`, `gl_mapping` triple, `bill_cycle.name`). Export `$inferSelect`/`$inferInsert` for all ten; `db/schema/index.ts` re-exports the `billing` area.

### 3.2 `db/schema/billing/views.sql` (raw) — the 3 views
Write the three `CREATE VIEW billing.*` statements per §2.4. Kept as a raw `.sql` file inlined into the migration so the pgledger joins are expressible; commented with which invariant/verification each serves.

### 3.3 Migration — `db/migrations/00XX_billing_module_tables.sql`
`npm run db:generate` for the 10 tables (after §3.1), then **hand-append** the three views from §3.2 (drizzle-kit won't author pgledger-joined views). Verify by hand: schema/sequences precede tables; FK targets precede referrers; the composite document sequences all exist; views are created last. No permission row, no seed. Do not edit an applied migration (platform §6.2).

### 3.4 `types/accounts.ts` (new)
All `as const` unions from code-standards §2.1 (`DOC_TYPES`, `DOC_STATES`, `LINE_KINDS`, `LEDGER_ROLES`, `POSTING_NATURES`, `PAYMENT_MODES`, `ACCOUNT_STATES`, `PAYMENT_STATUSES`) + inferred types; `TmfAccountRef`/`TmfRelatedParty` (§2.6); re-export Drizzle row types. No transition maps (ac07).

### 3.5 `db/repositories/accounts/*.ts` (skeletons) + `account-view.repository.ts` (working)
Per §2.6: typed signatures, unimplemented bodies for future units, working `account_view` reader + trivial `findById`s needed by the fixture test. `ledger.repository.ts` is the sole pgledger wrapper seam.

### 3.6 `validation/accounts/` (types only)
Zod schemas for the JSONB shapes (§2.5) so `$type` and later write paths share one source. `parseAccountsContext` (URL context strip parser) is **ac05**, not here.

### 3.7 Guardrail tests owned by this unit
**Unit (no DB):** `tests/db/billing-schema.test.ts` — column/nullability/CHECK-presence assertions on all 10 Drizzle table objects; `financial_account`/`billing_account` have no balance column (Inv. #2 structural); `document_line.pgledger_transfer_id` is UNIQUE nullable; `ledger_binding` has the triple UNIQUE.
**Integration (`skipIf(!databaseUrl)`):** `tests/db/billing-schema.integration.test.ts` — fresh-migrate onto ac01; assert all 10 tables + 3 views exist; inserted FA/BAN get `FIN000001`/`BAN000001`-format ids; a `document` insert per `doc_type` yields the right prefix from the per-type sequence; **`account_view` fixture test (headline):** insert a `party_role` (or reuse a customer fixture) + FA + BAN, assert `account_view` returns two rows with `account_type` `'FinancialAccount'`/`'BillingAccount'` and a composed `relatedParty[]` of shape `{id,role,name,@referredType}`; CHECK violations rejected (`23514`); `ledger_binding` second row for same owner+role rejected (`23505`); `document_line` duplicate `pgledger_transfer_id` rejected; cross-schema FK to a nonexistent `party_role`/`appuser` rejected. Update `tests/db/*` teardown to `DROP SCHEMA billing CASCADE` (coordinate with ac01's teardown — idempotent).

### 3.8 Explicitly NOT in this unit
No seeds (`sys.*` accounts, CoA, mappings, reason codes, bill cycles — **ac03**). No repository method bodies beyond the `account_view` reader and trivial `findById`s. No services, actions, pages, components, nav, permissions. No doc state-machine map, no `money.ts` (ac07). No period-close logic (ac14). No balance/overdue derivation. No trigger enforcing `owner_id` polymorphism or `gl_mapping` postable-target — those are app/service checks in their consuming units (V2/health check).

---

## 4. Dependencies (packages to install)
**None.** `drizzle-orm`, `drizzle-kit`, `postgres`, `tsx`, `zod` already present. Zero new npm packages, zero DB extensions (every constraint is standard PG16 DDL; views are plain SQL over ac01's pgledger views).

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `db/schema/billing/*.ts` + `views.sql`, `db/schema/index.ts` (re-export), `db/migrations/00XX_billing_module_tables.sql` + journal, `types/accounts.ts`, `db/repositories/accounts/*.ts` (skeletons + working `account-view`), `validation/accounts/*` (JSONB shapes), the new test files. No `services/`, `actions/`, `app/`, `components/` path exists yet.
- [ ] No permission INSERT, no seed rows, no repository method bodies beyond `account_view`/`findById`. No `TODO`/`console.*`.

**Build gates**
- [ ] `npm run typecheck`/`lint`/`format:check` green; `db/schema/billing/**` imports only `drizzle-orm` + type-only cross-schema refs; repositories import no `services/`/`actions/`.
- [ ] `npm run test` green.

**Data-layer guardrails (the point of the unit)**
- [ ] Fresh DB `db:migrate` (ac01 → ac02) applies cleanly; all 10 tables + 3 views present; a subsequent `db:generate` produces no spurious diff on `billing.*` (pgledger + module tables both stable).
- [ ] Generated IDs match: `FIN000001`, `BAN000001`, `BCY000001`, `DLN00000001`, `LBD000001`, `GLM000001`, and `PAY00000001`/`DEP…`/`CRN…`/`DBN…`/`ADJ…` from per-type sequences.
- [ ] **`account_view` fixture**: FA+BAN rows return with correct `account_type` literals and a composed `relatedParty[]` `{id,role,name,@referredType}`.
- [ ] CHECK violations, `ledger_binding` triple-UNIQUE, `document_line` transfer-UNIQUE, and cross-schema FKs all reject as specified.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac02` complete, "Next Up" → `ac03`; §"Note" confirmations (migration index; cross-schema id column names; view mechanism) recorded/corrected.

**Pipeline**
- [ ] CI green (SAST; DAST unchanged — no routes).

Any failing item means the unit isn't done. `ac03` (seeds + GL health) must not start until this is merged — its seed test asserts `gl_resolution_view` (this unit's view) resolves to 0 unmapped.
