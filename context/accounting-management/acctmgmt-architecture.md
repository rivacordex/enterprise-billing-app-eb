# Accounts Module — Architecture

This document extends the platform-wide `context/architecture.md` — everything there (stack, folder boundaries, shared-core database design, Better-Auth/RBAC platform, Platform Invariants #1–18) applies unchanged; only Accounts-module **differences and additions** are recorded here. Functional decisions trace to `_newmodule-account-plan.md` (Q1–Q28) and `acctmgmt-project-overview.md`.

**Status:** ACTIVE (planning-complete). **Users:** Revenue Operations. **Schema:** `billing`.

---

## 1. Stack — module deltas only

| Layer | Technology | Role in this module |
|---|---|---|
| Double-entry ledger | **pgledger** fork, schema-qualified into `billing.*` (Q10) | The money core: `pgledger_accounts/transfers/entries` + functions + views. Vendored pristine upstream `pgledger.sql` + upstream commit hash + a transform script that performs the schema qualification; upgrade = re-run transform → diff → deliberate migration. |
| Migrations | Drizzle **raw-SQL migration** carries the pgledger fork (after vendored ULID helpers); normal Drizzle schema files for module tables | One migration history with the platform (Platform Inv. #10); the fork is not hand-edited — only the transform output is committed. |
| Backend logic | Existing Server Actions → `services/` pattern | Document posting is a service-layer use case: one DB transaction spanning doc state change + `pgledger_create_transfers()` + audit. No new runtime, no queue, no scheduler. |
| Frontend | Existing Next.js `(app)` shell | New left-nav section **Accounts** (5 pages) + **Administration → Accounts Settings**. No new UI technology. |

Nothing else changes: no cache tier (live balances are the feature), no file storage (CSV export is a streamed query result), no rate limiting, no new hosting components.

---

## 2. System boundaries — folder ownership additions

Same inward-dependency rule as platform §2. New/extended paths:

| Path | Owns | Must NOT contain |
|---|---|---|
| `app/(app)/accounts/**` | Pages: Accounts Overview, Ledger Explorer, Transactions, Chart of Accounts, GL Journal. Each declares its permission + level. Selection-context strip (FA/BAN/party) is URL-driven state shared by the first three (locked item 5). | DB queries; posting logic; permission logic beyond the guard. |
| `app/(app)/administration/accounts-settings/**` | Config pages: reason codes + thresholds, bill-cycle catalog, wizard defaults, flows/interaction-map documentation page. | Direct table writes (goes through actions → services). |
| `actions/accounts/**` | Mutation entry points: create-FA/BAN (wizard), document draft/submit/approve/post/reverse, period close, CoA + mapping + reason-code + bill-cycle CRUD, journal export. | Business rules; SQL. |
| `services/accounts/**` | Use cases: onboarding transaction, document state machine, threshold routing, term resolution (`coalesce(override, cycle default)`), posting-nature → sys-account selection (Q19), period validation (Q9), closure gates (Q11), journal assembly. Framework-agnostic. | `next/*`; direct DB client. |
| `db/schema/billing/**` | Drizzle schema for the 11 module tables + `account_view`, `gl_resolution_view`, `gl_journal_view`. | Business rules. |
| `db/pgledger/**` | Vendored upstream `pgledger.sql`, upstream commit hash, transform script, generated `billing.*`-qualified SQL, raw-SQL migration. | Hand edits to generated output. |
| `db/repositories/accounts/**` | The **only** callers of pgledger functions and module tables. Ledger interaction is exclusively via `pgledger_create_account` / `pgledger_create_transfer(s)` and the three views — never INSERT/UPDATE on pgledger tables. | Threshold/permission decisions. |
| `validation/accounts/**` | Zod schemas: document payloads (discriminated by `doc_type`), `mode_ref` shapes per `payment_mode` (Q22), config CRUD inputs, period ids. | Business logic. |

**Customer-module touchpoint** (locked item 9): the `VALIDATED` transition wizard lives in the Customer module's UI but calls `services/accounts/` for the atomic FA/BAN/ledger/binding creation — the Accounts service owns that transaction.

---

## 3. Storage model

All in Postgres, `billing` pg schema. No file storage (journal export streams CSV from a live query, logged to `core.AUDIT_LOG`), no cache (Platform Inv. #15 extended: **balances are never cached or stored** — always read from `pgledger_accounts_view`).

| Data | Where | Notes |
|---|---|---|
| Financial Account (`billing.financial_account`, `FIN…`) | Postgres | Party-level. Base TMF fields on the concrete table — **no supertype, no `ACC…` ids** (Q6). `ref_party_role_id` FK → `party_role` (Q28); contact = `CTMD…` jsonb refs; currency; credit limit. |
| Billing Account (`billing.billing_account`, `BAN…`) | Postgres | Contract-level. Base fields + `ref_financial_account_id`, `rating_type` (postpaid only this phase, Q23), `payment_status` (`paid \| due \| in_dispute` — **overdue derived at read time**, Q8), `ref_bill_cycle_id` (Q13), `payment_due_days_override` (Q14). |
| Account correlation (`billing.account_view`) | Postgres view | UNION ALL of the two tables with literal `account_type`; composes the TMF `relatedParty[]` shape from the FK at read time (Q28). The only unified "Account" surface; future TMF666 OpenAPI SELECT target. |
| Bill-cycle catalog (`billing.bill_cycle`, `BCY…`) | Postgres | Frequency, cycle day, `payment_due_days` (TMF `paymentDueDateOffset`), `active \| retired` — retire, never delete (Q13/Q14). |
| Reason codes (`billing.reason_code`) | Postgres | Natural-key catalog: `doc_type`, `posting_nature` (selects the sys counter-account, Q19), `auto_post_limit` (Q20), `active \| retired`. |
| Documents (`billing.document` `PAY…/DEP…/CRN…/DBN…/ADJ…` + `billing.document_line` `DLN…`) | Postgres | Workflow anchor (Q18): state machine, reason code, `payment_mode` + `mode_ref` (Q22), `event_at`, `reversal_of`, `created_by`/`approved_by`. Each posted line ↔ exactly one `pglt_…` transfer. |
| Ledger accounts / transfers / entries | Postgres (pgledger in `billing`) | Immutable append-only double entry. Naming: `ban.{id}.receivables`, `fa.{id}.unapplied_cash`, `fa.{id}.deposits`, `sys.{nature}.{ccy}` (Q15/Q19). Corrections are new transfers, never edits (Platform Inv. #18). |
| Ledger binding (`billing.ledger_binding`, `LBD…`) | Postgres | TMF row ↔ pgledger account: `ledger_role` ∈ `receivables \| unapplied_cash \| deposits`, UNIQUE per owner+role. |
| Chart of Accounts (`billing.gl_account`) + mappings (`billing.gl_mapping`, `GLM…`) | Postgres | **Mastered in this module** (Q26). Role/name mapping rules; `gl_resolution_view` + `gl_journal_view` aggregate entries to GL codes. |
| Accounting periods (`billing.accounting_period`) | Postgres | Close workflow (Q8); posting validation on every document post; no reopening in this phase (Q9). |
| GL dimensions | Deferred — metadata escrow (Q25) | Transfer/document metadata already carries doc, ban/fa, type, reason; reserved `dim_*` keys promoted into `gl_journal_view` grouping at ERP time. No dimension columns now. |

ID convention follows platform §3 (prefix + zero-padded sequence); pgledger keeps its own prefixed ULIDs (`pgla_`, `pglt_`).

---

## 4. Auth & access model

Platform RBAC unchanged (Better-Auth, code-seeded registry, READ/EDIT/DELETE levels, union-highest-wins). Module additions (Q7/Q20):

| Permission | Grants | Typical holder |
|---|---|---|
| `accounts-view` | Accounts Overview, Ledger Explorer; read-only everywhere in the section | All RevOps |
| `accounts-transactions` | Transactions page: draft/submit documents; post at/below the reason code's `auto_post_limit`; MANAGER additionally approves/posts above it | RevOps USER / MANAGER |
| `accounts-config` | Chart of Accounts, GL Journal export, period close, Administration → Accounts Settings (reason codes, thresholds, bill cycles, defaults) | RevOps MANAGER / finance-config holders |

Workflow rules enforced **server-side in `services/accounts/`**, independent of nav visibility: threshold routing per reason code; **`approved_by ≠ created_by`** on every approval; sensitive reason codes (`DEP_REVERSE`, `DEP_REFUND`, `BAD_DEBT_WRITEOFF`) seeded with limit 0 = always four-eyes; threshold changes are audited config changes. Ownership: documents belong to the module, not the creator — any permitted MANAGER may approve (except the creator).

---

## 5. Background tasks & AI

**None — deliberately.** No AI/ML. No scheduled jobs in this phase:

- **No overdue scheduler** — overdue is derived at read time from open A/R + resolved terms (Q8/Q14).
- **No bank webhooks / statement import** — all captures manual (Q21/Q22).
- **No auto cash application** — allocation is manual document lines (Q24).
- **No bill run** — charges are manual DBNs until the Invoicing module (Q8).
- GL export and trial balance are live queries executed on user action, not batch outputs.

Period close is a user-initiated `accounts-config` action, not a job. If later phases add jobs (bill run, dunning), they follow platform §6 (Container Apps Jobs, dedicated Managed Identity).

---

## 6. Module invariants

Additions to Platform Invariants #1–18; each is testable (plan Part A §4 tests in parentheses) and CI-enforced.

1. **Zero-sum ledger.** `Σ balance = 0` per currency across all `billing` pgledger accounts after every committed transaction. (V1)
2. **No stored balances.** No module table column ever holds a monetary balance; every balance, badge, and utilisation figure is computed from `pgledger_accounts_view` / `pgledger_entries_view` at read time. (V3)
3. **Money moves only through posted documents.** Every ledger transfer is created inside a document-posting transaction and carries `metadata.doc`; every posted `document_line` has exactly one `pgledger_transfer_id` (UNIQUE). No UI, action, or service calls transfer functions outside document posting. (V11)
4. **The ledger is append-only.** pgledger tables are never UPDATEd/DELETEd by application code; repositories touch pgledger only through its functions and views. Corrections are reversal documents with opposite legs (extends Platform Inv. #18). (V13)
5. **Document posting is atomic.** Doc state change + all transfers + audit entry commit in one DB transaction; any failure rolls back everything — no orphan master rows, ledger accounts, bindings, or half-posted docs. (V7)
6. **Approver ≠ creator, thresholds server-side.** A document above its reason code's `auto_post_limit` cannot reach `posted` without an approval by a MANAGER who is not `created_by`; the check lives in the service, never only in the UI. (V11)
7. **Closed periods reject postings.** Every post validates `event_at` against `billing.accounting_period`; closed → error with re-date guidance, original `event_at` preserved in the document. No force-post, no silent rerouting, no reopening. (V11, Q9)
8. **Posting nature steers the counter-account.** The sys account for every non-customer leg is selected from the reason code's `posting_nature` (Q19) — never hard-coded per page, never chosen by the user. (V12)
9. **Binding completeness.** Every BAN has exactly one `receivables` binding; every FA exactly one `unapplied_cash` and one `deposits` binding; binding currency = owner currency = pgledger account currency. (V2)
10. **GL resolution is total and unambiguous.** Every pgledger account resolves to exactly one postable GL code via `gl_resolution_view`; the CoA health check (unmapped count) must be 0 before any journal export; `Σ debit = Σ credit` in every exported period. (V5, V6)
11. **Catalogs retire, never delete.** `bill_cycle`, `reason_code`, `gl_account` rows referenced by history are never deleted; state → `retired` removes them from selection, not from joins. Assignment requires `active`. (V9)
12. **Closure requires zero.** BAN closes only at A/R = 0; FA closes only when unapplied = 0, deposits = 0, and all BANs closed; customer → CLOSED blocked while accounts remain open. Closure is the final event on an account's ledger. (V14, Q11)
13. **Terms freeze at issuance.** Resolved term = `coalesce(BAN override, cycle default)` at document time; a stamped due date (future Invoicing) or an issued document's derived dates never re-derive when catalog or override later change. (V10, Q14)
14. **Fork integrity.** The pgledger SQL in migrations is transform-script output from the vendored upstream file at the recorded commit hash — never hand-edited; upgrades go through re-transform → diff → reviewed migration. (Q10)
