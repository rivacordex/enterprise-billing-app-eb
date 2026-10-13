# CM20 — View Customer: Accounts Tab

- **Unit:** 20 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** APP (customer screen + the Accounts-side read service it calls).
- **Dependencies:** `cm19` (tab shell, `?tab=accounts` placeholder); `cm17` (`billing_account.ref_bill_template_version_id`, read by the label); delivered Accounts read paths (`getFinancialAccountDetail`, `listTransactionDocuments`, `ledgerRepository`, `DocStateBadge`, `AmountCell`); delivered Billing catalog reads (`billTemplateVersionRepository.findActive/findDefault/findById`).
- **Authorizing sections:** binding plan §7.2, D6, D7, D8, D11, D14, D16; `custmgmt-update-overview.md` *Core user flow 2*, *Features → Accounts tab*; `custmgmt-architecture.md` §7.2, §7.3, Inv. #11, #12, #13, #15, #18; `custmgmt-ui-context.md` §9.2–§9.4; `custmgmt-ai-workflow-rules.md` §9.3 items 3, 5, 6, 10.
- **Decisions recorded 2026-10-10:** O3 → new `system_config` key `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` (group `customer`, default `20`).
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10.

> **Framing.** The Accounts tab brings a customer's accounting picture onto the customer screen, read-only. Everything it shows already exists in the Accounts module; this unit composes it through **one** new Accounts-side read service and renders it with customer-side components. Nothing here writes, posts or reverses. Two plan details are corrected by the codebase: (1) balances do **not** live in `billing.account_view` (it has no balance columns); they are read from `billing.pgledger_accounts_view` through `billing.ledger_binding`, exactly as `getFinancialAccountDetail` does; (2) the existing `customer` config key is seeded by `db/seeds/customer.ts` (`npm run db:seed-customer`), not by a migration, so the new key follows that path.

---

## 1. Goal

Fill the Accounts tab of View Customer with the customer's Financial Account summary (receivable, unapplied cash, deposits), one card per BAN (id, state, bill cycle, resolved payment term, live receivable, invoice-template label) and a paginated list of the FA's documents that deep-link into Accounts → Transactions, shown only to viewers with `accounts_view : READ` and fetched only when the tab is active.

## 2. Design

**Structural decisions**

- **Four states (D14).**

| State | When | Renders | Queries |
|---|---|---|---|
| Locked | viewer lacks `accounts_view : READ` | muted card "Requires accounts access" (`custmgmt-ui-context.md` §9.3) | **none** |
| Not onboarded | no Financial Account for the party role (customer `INITIALIZED`) | info card "Accounts are created when the customer is validated." | 1 (FA lookup) |
| Onboarded, empty | FA exists, zero documents | FA + BAN cards; "No transactions yet." in the list area | summary + 1 count |
| Normal | FA exists, ≥ 1 document | FA + BAN cards + paginated table | summary + 1 page |

- **Permission check in the page, once (Inv. #12).** `canViewAccounts = meetsLevel(permissionMap[PERMISSIONS.ACCOUNTS_VIEW], LEVELS.READ)` from the `permissionMap` that `requirePermission` already returns. The service is never called when false.
- **Fetch only on `tab=accounts`, under Suspense (Inv. #15, D16).** The page renders `<Suspense fallback={<AccountsTabSkeleton />}><CustomerAccountsTab … /></Suspense>` only for the Accounts tab; `CustomerAccountsTab` is an async server component that calls the service. Profile and Contacts issue no account query.
- **Find accounts by party-role key (Inv. #13).** `financialAccountRepository.findByPartyRoleIds(db, [partyRoleId])`; never `party_role.account`. Onboarding runs once per party role, so 0 or 1 FA is expected; if more rows exist, render one FA section per row in `financialAccountId` order.
- **Balances: reuse, plus one grouped read.** FA balances come from the existing `getFinancialAccountDetail(faId)` (3 balance reads, constant). Per-BAN receivables come from **one** new grouped query, `ledgerRepository.receivablesByFinancialAccount(db, faId)` (same joins as the existing `sumReceivablesForFinancialAccount`, grouped by BAN) — no per-BAN loop. This corrects the plan's "one `account_view` query" wording (doc fix in §3.9).
- **BAN term:** `resolveTerm(ban.paymentDueDaysOverride ?? null, billCycle.paymentDueDays)` from `services/accounts/term-resolution.ts`; cycles read with `billCycleRepository.findById` for the distinct cycle ids (1 today).
- **Template label (D11, Inv. #18).** One resolution per render (every v1 BAN is `NULL`): `current = findActive(db, { kind: "generated" }) ?? findDefault(db, { kind: "generated" })`; `layout = findById(db, current.refLayoutVersionId)`; name = `layout.layoutCode` (e.g. `INVTPL-STD-A4`), version = `current.versionNo`. Text: **"Follows active template (currently: INVTPL-STD-A4 v1), as of now"**. A non-`NULL` BAN value cannot exist in v1 (cm18/cm21 reject it); if one is found, render "Template reference not supported yet" and log a warning — never resolve it. The resolver never calls `resolveTemplate` or `resolveVersionsForPosting`.
- **Documents list: read-only, customer-side table.** `listTransactionDocuments(faId, null, { type: null, status: null, rev: null, q: "", sort: "-event_at", page }, pageSize)`. The Accounts module's `documents-table.tsx` is **not** reused: it is a client component that imports `ReverseButton` (a mutation path, forbidden by Inv. #11). A new server component renders: document id (mono), `actionLabel`, `DocStateBadge`, `AmountCell`, `eventAt` (`formatDatetime`). Each row links to `/accounts/transactions?party=<PTRL>&fa=<FIN>&doc=<documentId>` (the Transactions page opens its detail drawer from `?doc` when `?fa` is set). Pagination with `?tab=accounts&page=N` links (Previous / Next), page size from config.
- **Page size (O3).** `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE`, group `customer`, default `20`, read with the same graceful-fallback rule as `CUSTOMER_SEARCH_RESULT_LIMIT` (`services/customer/search-customers.ts`): missing / non-numeric / `< 1` → 20; cap at 100.
- **Presentational components:** `DocStateBadge` and `AmountCell` from `components/accounts/` are imported (presentational, no mutation import). The BAN state chip is new in `components/customers/` (no shared account-state badge exists), mapped per `acctmgmt-ui-context.md` §2 (active → success, suspended → warning, closed → neutral; closed card muted).

## 3. Implementation

### 3.1 Types — `types/accounts.ts` (extend)

```ts
// cm20 — the Accounts tab read model (components depend on types/** only).
export type CustomerAccountsSummary =
  | { kind: "notOnboarded" }
  | {
      kind: "onboarded";
      financialAccounts: Array<{
        financialAccountId: string;
        state: string;
        currency: string;
        receivableBalance: string;
        unappliedCashBalance: string;
        depositBalance: string;
        bans: Array<{
          billingAccountId: string;
          name: string;
          state: "active" | "suspended" | "closed";
          billCycleName: string;
          paymentTermDays: number;
          receivableBalance: string;
          templateLabel: string;
        }>;
        documents: { rows: TransactionDocumentRow[]; total: number; page: number; pageSize: number };
      }>;
    };
```

### 3.2 Repository — `db/repositories/accounts/ledger.repository.ts` (extend, one method)

```ts
  // cm20 — per-BAN receivable balances for one FA in a single query (the
  // grouped form of sumReceivablesForFinancialAccount). BANs with no binding
  // are absent from the map; callers default them to "0.00".
  async receivablesByFinancialAccount(
    db: Database,
    financialAccountId: string,
  ): Promise<Map<string, string>> {
    const rows = await db.execute<{ ban_id: string; balance: string }>(sql`
      SELECT ban.billing_account_id AS ban_id,
             COALESCE(pav.balance, 0)::numeric(18,2)::text AS balance
      FROM billing.billing_account ban
      JOIN billing.ledger_binding lb
        ON lb.owner_type = 'billing_account'
       AND lb.owner_id   = ban.billing_account_id
       AND lb.ledger_role = 'receivables'
      JOIN billing.pgledger_accounts_view pav ON pav.id = lb.pgledger_account_id
      WHERE ban.ref_financial_account_id = ${financialAccountId}
    `);
    return new Map(rows.map((r) => [r.ban_id, r.balance]));
  },
```

Read-only; `app_runtime` already has `SELECT` on all three relations.

### 3.3 Template label — `services/accounts/resolve-ban-template-label.ts` (new)

```ts
// cm20 (binding plan D11, custmgmt Inv. #18) — the customer-screen label for a
// BAN's invoice template reference. Live lookup, never cached or persisted,
// never presented as what a future bill will use. Mirrors the resolver's
// "current" rule (findActive ?? findDefault, kind generated) but does NOT call
// resolveTemplate/resolveVersionsForPosting.
export async function resolveCurrentTemplateLabel(db: Database): Promise<string>;
export function banTemplateLabel(refBillTemplateVersionId: string | null, current: string): string;
```

`resolveCurrentTemplateLabel` returns `"INVTPL-STD-A4 v1"`-style text (layout code from the generated version's `refLayoutVersionId`, version from `versionNo`). `banTemplateLabel(null, current)` returns `` `Follows active template (currently: ${current}), as of now` ``; a non-`NULL` value returns `"Template reference not supported yet"` (and the caller logs `logger.warn`).

### 3.4 Read service — `services/accounts/get-customer-accounts-summary.ts` (new)

`getCustomerAccountsSummary(partyRoleId: string, page: number): Promise<CustomerAccountsSummary>`:

1. `fas = financialAccountRepository.findByPartyRoleIds(db, [partyRoleId])`; empty → `{ kind: "notOnboarded" }`.
2. `pageSize = resolveDocumentsPageSize()` (config read, §2 rule) and `currentLabel = resolveCurrentTemplateLabel(db)` — once per call.
3. Per FA (expected 1), in parallel: `getFinancialAccountDetail(faId)`; `billingAccountRepository.findByFinancialAccountId(db, faId)` (full rows, for `refBillTemplateVersionId`, cycle, override); `ledgerRepository.receivablesByFinancialAccount(db, faId)`; `listTransactionDocuments(faId, null, { …defaults, page }, pageSize)`.
4. Cycles: `billCycleRepository.findById` per **distinct** `refBillCycleId`.
5. Map to the §3.1 shape (BAN receivable defaults to `"0.00"`; `paymentTermDays = resolveTerm(...)`; `templateLabel = banTemplateLabel(ban.refBillTemplateVersionId, currentLabel)`).

No writes, no transaction, no import from `actions/**`, `post-document`, or any pgledger function wrapper other than the read methods above.

### 3.5 Config seed — `db/seeds/customer.ts` (extend)

Add a second idempotent insert in the same transaction, mirroring the existing one: `configGroup: "customer"`, `configKey: "CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE"`, `configValue: "20"`, `description: "Rows per page in the View Customer Accounts tab document list."`, `isSecret: false`, `status: "ACTIVE"`. The service's fallback to 20 keeps an unseeded database working.

### 3.6 Components — `components/customers/` (new)

- `customer-accounts-tab.tsx` — async server component. Props `{ partyRoleId, canViewAccounts, page, locale, timezone }`. Locked → `AccountsLockedCard` without calling the service; otherwise awaits `getCustomerAccountsSummary` and renders the state.
- `accounts-locked-card.tsx`, `accounts-not-onboarded-card.tsx` — static cards (`custmgmt-ui-context.md` §9.3; icons `lock`, `info`).
- `financial-account-summary-card.tsx` — FA id (mono), three amounts via `AmountCell`.
- `billing-account-card.tsx` — BAN id (mono), name, `BanStateChip`, cycle name, "`N` days" term, receivable via `AmountCell`, template label (§9.4 typography, `file-text` icon). `closed` → muted card.
- `ban-state-chip.tsx` — pill per `acctmgmt-ui-context.md` §2 account mapping.
- `customer-documents-table.tsx` — server component; columns per §2; each row a link to `/accounts/transactions?party=…&fa=…&doc=…`; Previous/Next links preserve `tab=accounts`; empty → "No transactions yet."
- `accounts-tab-skeleton.tsx` — `components/ui/skeleton` blocks.

### 3.7 Page — `app/(app)/customers/view/[id]/page.tsx` (extend)

- Read `permissionMap` from the existing `requirePermission` call; compute `canViewAccounts`.
- Parse `page` for the Accounts tab: extend `customerDetailSearchParamsSchema` with `page: z.coerce.number().int().min(1).max(9999).catch(1)`.
- Replace the cm19 placeholder with `<Suspense fallback={<AccountsTabSkeleton />}><CustomerAccountsTab partyRoleId={…} canViewAccounts={…} page={page} locale={locale} timezone={timezone} /></Suspense>` rendered only when `tab === "accounts"`.

### 3.8 Tests

| File | Cases |
|---|---|
| `tests/services/get-customer-accounts-summary.test.ts` (new, mocked repos) | no FA → `notOnboarded`; FA + BAN + docs → full shape; BAN with no binding → receivable `"0.00"`; distinct-cycle reads; page size fallback (missing / `"abc"` / `"0"` → 20; `"500"` → 100); service never imports `actions/**` (static import check) |
| `tests/accounts/get-customer-accounts-summary.integration.test.ts` (new, DB-gated) | seeded onboarded customer: balances match `getFinancialAccountDetail` and `getBillingAccountDetail`; `receivablesByFinancialAccount` returns one row per bound BAN in **one** statement (query-count spy); N BANs listed; closed BAN present with `state: "closed"`; pagination honours the config key |
| `tests/services/resolve-ban-template-label.test.ts` (new) | `NULL` + only default ACTIVE → "…(currently: INVTPL-STD-A4 v1), as of now"; `NULL` + a non-default ACTIVE v2 → "…v2…"; non-`NULL` → "Template reference not supported yet"; never calls `resolveTemplate` |
| `tests/app/customers-view-detail-page.test.tsx` (extend) | `?tab=accounts` without `accounts_view` → locked card and `getCustomerAccountsSummary` **not** called; with it → service called with `(partyRoleId, page)`; on `profile`/`contacts` the service is never called |
| `tests/components/customer-accounts-tab.test.tsx` (new) | each of the four states renders its copy; document rows link to `/accounts/transactions?party=…&fa=…&doc=…`; Next/Previous keep `tab=accounts` |

DB-gated tests run only on a throwaway Postgres marked disposable.

### 3.9 Doc fixes in this unit (same change set)

- `custmgmt-architecture.md` Inv. #15 and §7 storage row, binding plan D16 and §7.2, `custmgmt-update-overview.md` Accounts-tab feature: replace "balances from one `billing.account_view` read" with "FA balances via `getFinancialAccountDetail`; per-BAN receivables in one grouped `pgledger_accounts_view` read".
- `cm00-build-plan.md` cm20 "Builds": the page-size key is seeded by `db/seeds/customer.ts`, not a migration.
- `custmgmt-code-standards.md` §4/§7: the new component names; §8 permission map: the Accounts tab sub-gate.

### 3.10 Explicitly NOT in this unit

- Any write, posting, reversal, approval or payment control (D6).
- Reusing `components/accounts/documents-table.tsx` or the Transactions drawer.
- Resolving a non-`NULL` template reference (Phase 3).
- The Manage Customer panel (cm21).

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] Locked state for a viewer without `accounts_view : READ`; the summary service is not called.
- [ ] `INITIALIZED` customer → not-onboarded card; onboarded customer with no documents → cards + "No transactions yet."
- [ ] FA card shows receivable, unapplied cash and deposits equal to the Accounts Overview values for the same FA.
- [ ] Each BAN card shows state chip, cycle, resolved term, receivable and "Follows active template (currently: … vN), as of now".
- [ ] Per-BAN receivables come from one SQL statement regardless of BAN count.
- [ ] Document rows link to `/accounts/transactions?party=…&fa=…&doc=…` and open the drawer there; pagination keeps `tab=accounts`; page size follows `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` with fallback 20.
- [ ] Profile and Contacts tabs run no account query; skeleton shows while the tab streams.
- [ ] No import from `actions/**`, `post-document`, `reversal-dialog`, `documents-table`, `resolveTemplate` or `resolveVersionsForPosting` anywhere under `app/(app)/customers/**`, `components/customers/**` or the new services.
- [ ] All tests in §3.8 green; DB-gated ones on a disposable Postgres; `npm run typecheck`, `npm run lint`, Prettier clean.
- [ ] §3.9 doc fixes applied; `custmgmt-progress-tracker.md` updated.
