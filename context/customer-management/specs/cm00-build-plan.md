# CM00 — Customer Management Module Build Plan (Units in Build Order)

**Sources:** `custmgmt-project-overview.md` (v1 features, flows, scope), `custmgmt-update-overview.md` + `_updatemodule-customer-accounts-invoice-template-binding-plan.md` (Invoice Template Binding update, decisions D1–D16, test matrix §11), `custmgmt-architecture.md` (stack = platform `architecture.md` §1 unchanged; §2 folders, §3 storage, §4 permission matrix, §6 Module Invariants #1–#18, §7 update deltas), `custmgmt-code-standards.md` (§7 file tree, §8 permission map, §9 guardrail tests), `custmgmt-ai-workflow-rules.md` (§2 Phase 1 units, §9 update rules).

## How units are cut

1. **One visible result per unit** — a migration that introspects cleanly, a page or tab that renders, an action that mutates, audits and is inspectable in the DB.
2. **One system boundary per unit** — see the boundary key.
3. **Dependencies just in time** — a repository function, validator or read service is introduced in the first unit that calls it, never upfront.
4. **Merge always-done-together units** — e.g. a page container with its first mutation; an action with the only UI that calls it.
5. **Merge units with no standalone visible result** — e.g. Zod schemas, validators and read services merge into the first unit that renders or mutates with them.

**Boundary key:** `DB` = `db/**` schema, migrations, seeds · `APP` = `app/(app)/customers/**`, `components/customers/**`, `actions/customer/**`, `services/customer/**`, `validation/customer/**`, and, for the binding update only, the Accounts-side files a customer screen calls (`actions/accounts/**`, `services/accounts/**`, `validation/accounts/onboard-customer-accounts.schema.ts`; the `billing_account` table is Accounts-owned, `custmgmt-architecture.md` §7) · `TESTS` = `tests/**` cross-cutting guardrail/authz sweep.

---

## Phase 1 — v1 full CRUD (cm01–cm16) — DELIVERED

_Compacted 2026-10-10. Per-unit detail lives in `specs/cm01.md`–`specs/cm16-authz-guardrail-sweep.md`; the build record is `custmgmt-progress-tracker.md`._

| Unit | Name | Boundary | Visible result |
|---|---|---|---|
| cm01 | DB foundation: `customer` schema, 3 tables, constraints, `customers` permission (READ/EDIT) + `CUSTOMER_SEARCH_RESULT_LIMIT` seed | DB | Migration applies; constraint guardrails (one non-closed role per org, nullable-unique `registration_number`, composite preferred-contact FK) fail as designed |
| cm02 | Validation schemas, transition maps, JSON-only specification check, read repositories, `search-customers`, `get-customer-detail` | APP | Search and detail assembly proven by unit tests |
| cm03 | Nav: "Customer" section | APP | Sidebar shows View/Manage Customer _(nav now governed by the platform `NAV_REGISTRY` rule)_ |
| cm04 | View Customer: search page | APP | READ user searches, capped results, `?q=` deep-link |
| cm05 | View Customer: read-only detail page (three stacked sections + `InconsistencyBanner`) | APP | Full read-only profile; mismatch banner warns only |
| cm06 | Manage Customer: search page | APP | EDIT user searches; USER rejected server-side |
| cm07 | Create customer (org + role) + add-new page | APP | Customer created at REGISTERED/INITIALIZED, audited |
| cm08 | Edit page container + update organization | APP | Org edit saves; stale save → `CONFLICT` reload prompt |
| cm09 | Transition organization status | APP | Map-driven transitions with mandatory reason |
| cm10 | Transition customer status | APP | INITIALIZED → VALIDATED → ACTIVE; no skipping |
| cm11 | Add contact (auto-preferred contact + method) | APP | First contact and first method auto-preferred |
| cm12 | Update contact | APP | Contact edits keep preferred pointers |
| cm13 | Delete contact (the one physical delete) | APP | Non-preferred delete works; preferred delete blocked |
| cm14 | Set preferred contact | APP | Preferred marker moves; audited |
| cm15 | Set preferred contact method | APP | Preferred method switches between populated methods |
| cm16 | Authz matrix + full guardrail sweep (ship gate) | TESTS | All eight code-standards §9 guardrails green |

**Phase 1 durable notes:** no `DELETE` permission level (READ/EDIT only); write-repository functions were introduced only in the mutation unit that first needed them; deferred and out of scope: shape validation on `party_role_specification`, MERGED-status migration tooling, multi-value contact fields, individual (person) customers, TMF/external APIs, merge tooling. `party_role.account` stays display-only (Inv. #9).

---

## Phase 2 — Invoice Template Binding update (cm17–cm22) — PLANNED

Plumbing only: a per-BAN invoice template reference (v1 `NULL` = follow the active template), confirmed at onboarding, reset on Manage Customer, shown on a tabbed View Customer with a read-only Accounts tab. Posting ignores the reference (D4, Inv. #18). No new permission, table, technology or background job. Units follow `custmgmt-ai-workflow-rules.md` §9; every DB-gated test runs on a throwaway Postgres marked disposable.

### Unit cm17 — Billing Account template reference column

- **Boundary:** DB
- **Builds:** one forward migration adding nullable `billing.billing_account.ref_bill_template_version_id text` with a real FK to `billing.bill_template_version(bill_template_version_id)`; the Drizzle mirror in `db/schema/billing/accounts.ts`. No default literal, no backfill (D9, D10).
- **Visible result:** the migration applies cleanly; the column and FK are inspectable; existing BANs read back `NULL`; inserting a non-existent template id is rejected by the FK (`tests/db/billing-account-template-column.integration.test.ts`).
- **Dependencies:** delivered Accounts module (`billing.billing_account`, ac02) and the Billing template catalog (`billing.bill_template_version`, bm50 / migration `0046`).

### Unit cm18 — Onboarding wizard: "Invoice template" field

- **Boundary:** APP
- **Builds:** the shared `assertBindableTemplate(tx, id | null)` validator, accepting `null` only (D13; introduced here, its first caller); optional `billTemplateVersionId` on `validation/accounts/onboard-customer-accounts.schema.ts`; `services/accounts/onboard-customer-accounts.ts` writing it on the BAN insert and adding it to `ACCOUNTS_ONBOARDED.afterData`; the single-option *Follow active template* select with help text in `components/customers/onboard-accounts-wizard.tsx` (D2, D11). Guard unchanged (`customers : EDIT` + `accounts_transactions : EDIT`).
- **Merged because:** the validator and the service change have no visible result without the wizard field, and the field has nothing to submit without them.
- **Visible result:** a MANAGER validating an `INITIALIZED` customer sees the Invoice template field; the created BAN has `ref_bill_template_version_id = NULL`; the audit event carries the field; a non-`NULL` id is rejected with `TEMPLATE_NOT_BINDABLE` and the whole onboarding transaction rolls back (V7 still green).
- **Dependencies:** cm17 (column); delivered cm10 / ac04 onboarding wizard.

### Unit cm19 — View Customer: tab shell (Profile · Contacts · Accounts)

- **Boundary:** APP
- **Builds:** `app/(app)/customers/view/[id]/page.tsx` as a URL-driven tab layout (`?tab=profile|contacts|accounts`, default `profile`, unknown → `profile`), a `validation/customer` tab enum and a link-strip tab component in `components/customers/` following the `run-detail-tabs.tsx` precedent; Profile = `OrganizationSection` + `CustomerRoleSection`, Contacts = `ContactDetailsSection`, Accounts = an empty placeholder; `InconsistencyBanner` above the strip (D5, Inv. #14). **Rewrites** `tests/app/customers-view-detail-page.test.tsx` to the tabbed contract in the same unit.
- **Visible result:** a READ user opens a customer and switches Profile/Contacts tabs; `?tab=contacts` deep-links; an invalid tab falls back to Profile; the banner shows on every tab; not-found and guard behaviour unchanged; the rewritten page test passes.
- **Dependencies:** delivered cm05 (detail page and sections). No dependency on cm17/cm18.

### Unit cm20 — View Customer: Accounts tab

- **Boundary:** APP
- **Builds:** `services/accounts/get-customer-accounts-summary.ts` (Financial Account by party-role key, BANs, FA balances via `getFinancialAccountDetail`, per-BAN receivables in one grouped `pgledger_accounts_view` read; Inv. #13, #15) and the template-label resolver (`findActive ?? findDefault`, "Follows active template (currently: <name> vN), as of now"; D11) — both introduced here, their first caller; the Accounts tab content in `components/customers/`: FA summary card, one card per BAN (id, state chip, cycle, resolved term, live balance, tied template), paginated FA-level documents via `listTransactionDocuments` with deep-links into the Accounts module; four states — locked (no `accounts_view : READ`, nothing fetched), not onboarded, onboarded-empty, normal; loaded in an async child under Suspense only when `tab=accounts` (D6, D7, D8, D14, D16, Inv. #12); one new `system_config` page-size key `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` seeded by `db/seeds/customer.ts` (O3).
- **Merged because:** the read service and label resolver have no visible result without the tab.
- **Visible result:** a user with `accounts_view : READ` sees an onboarded customer's FA summary, BAN card with the template label, and paginated documents that link into Accounts; without the permission the tab shows the locked card; an `INITIALIZED` customer shows the not-onboarded state; Profile and Contacts issue no account query.
- **Dependencies:** cm19 (tab shell), cm17 (column read by the label resolver).

### Unit cm21 — Manage Customer: Billing account panel + template reset

- **Boundary:** APP
- **Builds:** `services/accounts/set-billing-account-template.ts` (one transaction: `findStateByIdForUpdate`, `last_modified` compare, `BAN_NOT_FOUND` / `BAN_CLOSED` / `CONFLICT` / `TEMPLATE_NOT_BINDABLE`, no write and no audit when unchanged, `last_edited_by`, `BILLING_ACCOUNT_TEMPLATE_CHANGED` before/after; does not touch `party_role.last_modified_datetime`, Inv. #17); `actions/accounts/set-billing-account-template.ts` re-checking `customers : EDIT` **and** `accounts_transactions : EDIT`, `revalidatePath` on manage and view; the "Billing account" panel on `app/(app)/customers/manage/[id]/page.tsx` listing the customer's BANs with the template label and a *Reset to follow active template* button, read-only with `EDIT_DISABLED_TITLE` for a user without `accounts_transactions : EDIT` (D3, D12, D15, Inv. #16); the audit event added to the audit category map; authz-matrix rows for the action (O4 name confirmed here).
- **Merged because:** the service and action are only ever called from this panel, and the panel has nothing to do without them.
- **Visible result:** a MANAGER with both permissions resets a BAN's template (audited, or a no-op with no audit when already `NULL`); a stale save shows the conflict message; a closed BAN is rejected; a user with `customers : EDIT` only sees the panel greyed; a direct action call missing either permission is rejected.
- **Dependencies:** cm18 (`assertBindableTemplate`), cm20 (summary service + label resolver), cm17 (column).

### Unit cm22 — Binding update ship gate: guardrails, end-to-end flow, docs

- **Boundary:** TESTS
- **Builds:** the two boundary guardrails — customer pages import no Accounts mutation, `post-document` or pgledger function (Inv. #11), and no file under `services/billing/**` reads `billing_account.ref_bill_template_version_id` (Inv. #18); a DB-gated service-level journey test onboard → accounts summary → template label → reset path (`tests/e2e/customer-accounts-journey.integration.test.ts`, following `customer-core-flow.integration.test.ts`; browser e2e deferred to `_newmodule-playwright-e2e-testing-plan.md`); a re-run of the posting stamp tests (bm18/bm19/bm54) proving posting is unchanged; the docs close-out per `custmgmt-ai-workflow-rules.md` §9.7 (`cm05` spec, overview Features, code-standards §7/§8, update overview → Delivered, progress tracker; Accounts-side doc edits by approval).
- **Visible result:** CI green with the plan §11 matrix complete, both guardrails passing, the journey test passing, and posting stamps unchanged; `custmgmt-update-overview.md` status set to Delivered.
- **Dependencies:** cm17–cm21.

### Mapping to the plan

| Unit | Plan task (§14) |
|---|---|
| cm17 | T1 |
| cm18 | T3 (+ T2 validator) |
| cm19 | T5 (tab shell) |
| cm20 | T5 (Accounts tab) |
| cm21 | T2 (service/action), T4 |
| cm22 | T6, T7 |

---

## Dependency graph

```
Phase 1 (delivered): cm01 ─► cm02 ─► cm04 ─► cm05      cm03 ─► cm04, cm06
                                └─► cm06 ─► cm07 ─► cm08 ─► cm09, cm10, cm11 ─► cm12–cm15
                     cm01–cm15 ─► cm16

Phase 2 (planned):
  cm17 (column + FK) ──► cm18 (onboarding field + validator) ──┐
     │                                                          ├─► cm21 (Manage panel + reset)
  cm05 ─► cm19 (tab shell) ──► cm20 (Accounts tab + summary) ──┘
     cm17 ──────────────────────► cm20
  cm17–cm21 ──► cm22 (ship gate)
```

cm19 depends only on delivered cm05 and can be built in parallel with cm17/cm18.

## Notes

- **Just-in-time introduction (Phase 2):** the column in cm17; `assertBindableTemplate` in cm18 (first caller); `getCustomerAccountsSummary`, the label resolver and the page-size config key in cm20 (first caller); the reset service, action and audit event type in cm21.
- **Not in any unit (Phase 3, `TODOS.md`):** a template catalog or picker, any non-`NULL` binding, a template-line identifier, CSV/layout binding, and posting reading the reference.
- **Per-unit checklist:** `custmgmt-ai-workflow-rules.md` §8 and §9.8 apply to every Phase 2 unit.
