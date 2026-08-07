# AC20 — Documents Table (Read Stack)

- **Unit:** 20 of 23 (`ac00-build-plan.md`) — the highest-value unit of the revision
- **Dependencies:** `ac19` (action bar in place, so the table lands on a restructured page), `ac02` (`billing.document` + `billing.document_line` tables and `document.repository.ts`), `ac18` (**load-bearing**: a BAN-scoped table reached by a link that drops `?ban` produces an empty table and a loop back through Overview). `ac06`'s `listTransfersForAccount` / `ledger-transfers-grid` are the shape precedents.
- **Authorizing sections:** `acctmgmt-update-overview.md` §Goals 1, 5, 6, 8, §Features "Documents workbench", §Success criteria **SC4, SC5, SC9, SC11**; `_updatemodule-accounts-transactions-plan.md` §Target design ("A real documents table"), §Backend prerequisite, decision **D2** incl. the FA-level caveat; `acctmgmt-architecture.md` §2 (new `services/accounts/list-transaction-documents.ts` — read-only), §3 (Document-list scope predicate; filter state in URL), §6 **inv. #15, #16, #19**; `acctmgmt-code-standards.md` §3.1/§3.2, §4.1 (`amount-cell`, `doc-state-badge`), §4.3 (dense tables, server pagination, sort as URL param), §9 (Result codes); `acctmgmt-ui-context.md` §2 (derived partially-reversed → Warning), §3 (mono ids, `tabular-nums`).
- **Codebase verification performed for this spec:** `billing.document` columns are `documentId, docType, state, refFinancialAccountId, refBillingAccountId, reasonCode, currency, totalAmount, paymentMode, modeRef, referenceDate, referenceInfo, eventAt, postedAt, reversalOf, createdBy, approvedBy, metadata, lastModified, lastEditedBy`; `billing.document_line` carries `reversedByLineId`. `document.repository.ts` has only `findById`, `findPendingApprovalsForFinancialAccount`, `insert`, `updateEventAt`, `compareAndUpdateState` — no list read. `listTransfersForAccount` returns `{ rows, total }` and Ledger Explorer uses a fixed `TRANSFERS_PAGE_SIZE = 20` with **zero new config**.

---

## 1. Goal

Give the Transactions page a filterable, paginated table of the documents raised against the selected context — the page's first-ever history view — by adding one read-only repository method, one read service, one search-params schema and the table component, and absorbing `PendingApprovalsList` into the table as a status filter plus an approval banner. Done when a payment capture and a deposit both appear (marked **FA-level**), documents from other BANs do not, and pending approvals are visible on arrival.

## 2. Design

**Boundary: `db/repositories/accounts/document.repository.ts` (read method), `services/accounts/list-transaction-documents.ts` (new), `validation/accounts/transactions-search-params.schema.ts` (new), `components/accounts/**` (table), `app/(app)/accounts/transactions/page.tsx` (wiring).** No write path, no migration, no new permission.

### 2.1 Why this is one unit and not four

The repository method, the service and the schema each have **no standalone visible result** and so must merge with the table that makes them visible (`ac00` unit rules). The `PendingApprovalsList` absorption merges for a different reason: shipping the table while that component still renders would display pending documents **twice** — a broken intermediate state, not a clean visible result.

### 2.2 The scope predicate — D2's implementation caveat

The table is BAN-scoped, but **four services write `refBillingAccountId: null`**: `capture-payment.ts`, `capture-deposit.ts`, `reverse-deposit.ts`, `refund-deposit.ts`. These are FA-level documents by design. A literal `ref_billing_account_id = :ban` filter would hide **every payment capture and every deposit** — the page's most common output. The predicate is therefore:

```sql
WHERE ref_financial_account_id = :fa
  AND (ref_billing_account_id = :ban OR ref_billing_account_id IS NULL)
```

**With no BAN selected**, drop the second clause and run FA-scoped. Do *not* show an empty state: captures and deposits are valid FA-level actions and the page already enables `CapturePaymentPanel` on `financialAccountId` alone — an empty table there would contradict the page's own gating. Only when **neither** FA nor BAN is present does the table render the empty state pointing back to Overview with context preserved.

Documents belonging to a *different* BAN under the same FA are never returned (the accepted D2 trade); that view lives in Accounts Overview and Ledger Explorer.

### 2.3 The unreversed-line aggregate belongs here

Both the "Partially reversed" badge and the reversibility filter are **list-level displays**, so the per-document line state is part of the list query, not something ac22 re-derives. The repository returns, per document, `unreversedLineCount` and `totalLineCount` (a grouped join on `document_line`, not an N+1 per row). From those two numbers the service derives:

- `partiallyReversed = state === "posted" && unreversedLineCount > 0 && unreversedLineCount < totalLineCount`
- `reversible = state === "posted" && unreversedLineCount > 0` — the same predicate `reverse-document.ts` enforces, consumed by ac22 for control gating (**inv. #18**: mirror, never replace)

### 2.4 Columns

| Column | Content | Notes |
|---|---|---|
| Doc | `documentId` | mono (`--text-mono`), ui-context §3 |
| Type / Action | `docType` chip + human action label + scope marker | scope marker is `BAN…` chip or **FA-level** chip, reusing `--acct-chip-ban-*` / `--acct-chip-fa-*` |
| Reason | `reasonCode` | muted |
| Amount | `totalAmount` + `currency` | via existing `AmountCell` — right-aligned, `tabular-nums`, 2dp (code-standards §4.1) |
| Status | `DocStateBadge` + derived partially-reversed | see §2.6 |
| By / Date | `createdBy` / `approvedBy`, `eventAt` | dates via `formatDatetime` with app locale/timezone, as Ledger Explorer does |

**Only five doc types exist** (`PAY, DEP, CRN, DBN, ADJ`) and a reversal reuses the original's type — there is no "reversal", "refund" or "write-off" type. Any such filter option is a defect (**inv. #19**). The human action label is derived from `docType` + `reasonCode`, not from a sixth type.

### 2.5 Filters and URL state

New `validation/accounts/transactions-search-params.schema.ts`, modelled directly on `ledger-explorer-search-params.schema.ts` — **lenient by design**: every field `.catch()`s to its default so a tampered or stale URL never 500s the page.

| Param | Values | Default |
|---|---|---|
| `type` | `PAY \| DEP \| CRN \| DBN \| ADJ` | none (all) |
| `status` | the five `DOC_STATES` | none (all) |
| `rev` | `reversible \| partial` | none (all) |
| `q` | trimmed, max 100 — matches `documentId` and `reasonCode` | `""` |
| `sort` | `event_at \| -event_at \| amount \| -amount` | `-event_at` |
| `page` | int ≥ 1 | `1` |
| `doc` | document id — reserved for ac21's drawer, parsed but unused here | `null` |

Filter state lives **only in the URL** (architecture §3), same as Ledger Explorer and GL Journal; no client filter store. Reserving `doc` now means ac21 adds no schema change.

**Page size is a fixed module constant `DOCUMENTS_PAGE_SIZE = 20`, not `system_config`** — following the explicit ac06 precedent ("no configurable page size decision in this unit; zero new config"). Introducing a config key here would be an unrequested decision.

`?party&fa&ban` remain owned solely by `parseAccountsContext`; this schema never parses them (code-standards §3.1).

### 2.6 Partially-reversed badge (ui-context §2)

Partially-reversed is **not** a `DOC_STATES` value and gets no new component. `doc-state-badge.tsx` gains a derived `partiallyReversed: boolean` prop rendered beside the `posted` badge, mirroring how `payment-status-badge.tsx` already takes `derivedOverdue`. The component never computes it — the service does (§2.3). Family: **Warning** (`warning-50`/`warning-700`), per the row added to `acctmgmt-ui-context.md` §2.

### 2.7 Approval banner + absorbing `PendingApprovalsList`

An amber banner above the filters reports the pending-approval count for the current context with a **Review now →** action that sets `?status=pending_approval`. The standalone `PendingApprovalsList` section is **deleted**; its approve affordance moves to ac21's drawer. Because ac21 is the next unit, ac20 keeps the approve action reachable in the interim by rendering it inline on `pending_approval` rows — a small, deliberate stopgap removed by ac21.

The existing `listPendingApprovals` in `get-transactions-context.ts` is retained (the banner count uses it) — it is FA-scoped and cheap. Do not delete it.

### 2.8 Read-only, in the strictest sense (inv. #15)

`list-transaction-documents.ts` and the new repository method issue **SELECTs only** — no INSERT/UPDATE/DELETE, no transaction, no call into `post-document.ts` or any pgledger function. This is enforced by a grep gate in ac23, but is stated here because it is the unit's defining constraint.

The table reads `billing.document` / `billing.document_line` only. It does **not** read pgledger: amounts come from `document.totalAmount`, not from a ledger balance. No balance is displayed, so **inv. #2** is not engaged.

---

## 3. Implementation

### 3.1 `db/repositories/accounts/document.repository.ts` — add `listForContext`

```ts
listForContext(db, {
  financialAccountId: string;
  billingAccountId: string | null;   // null → FA-scoped (§2.2)
  docType: DocType | null;
  state: DocState | null;
  q: string;                          // documentId / reasonCode
  sort: TransactionDocumentSort;
  page: number;
  pageSize: number;
}): Promise<{ rows: DocumentListRow[]; total: number }>
```

`DocumentListRow` = the document columns in §2.4 plus `unreversedLineCount` and `totalLineCount` from a grouped `LEFT JOIN billing.document_line` (§2.3). One query for rows, one for `total` — the `listTransfersForAccount` shape. Sort whitelisted to the §2.5 values; never interpolate the sort string.

### 3.2 `services/accounts/list-transaction-documents.ts` (new, read-only)

Wraps the repository, derives `partiallyReversed`, `reversible` and the human action label, and applies the `rev` filter (post-aggregate, since it is derived). Returns `{ rows, total }`. No write, no transaction (**inv. #15**).

### 3.3 `validation/accounts/transactions-search-params.schema.ts` (new)

Per §2.5, mirroring the ledger-explorer schema's lenient `.catch()` style. Export `TRANSACTION_DOCUMENT_SORT_VALUES` and the inferred type.

### 3.4 `components/accounts/doc-state-badge.tsx` — add the derived prop

Add `partiallyReversed?: boolean`; render the extra Warning chip beside `posted`. No new component, no sixth `DOC_STATES` member (§2.6).

### 3.5 `components/accounts/documents-table.tsx` (new)

Dense server-rendered table following `ledger-transfers-grid.tsx`: `text-body-sm`, sticky header, `--radius-none` grid, sortable headers as URL links (`aria-sort`), server pagination, row → `?doc=…` link (inert until ac21). Scope marker chip per §2.4. Empty state per §2.2. Amounts via `AmountCell`.

### 3.6 `components/accounts/approval-banner.tsx` (new) + page wiring

Banner per §2.7. In `page.tsx`: parse the new search params, call the new service, render banner → filters → table; **delete** the Pending Approvals section and its `PendingApprovalsList` import. Page stays `force-dynamic`.

### 3.7 Tests

`tests/accounts/transactions-documents-list.integration.test.ts`:

- **SC4 (the trap):** with FA + BAN selected, a `PAY` capture and a `DEP` capture — both `refBillingAccountId: null` — **are returned**. This is the regression that fails if someone "simplifies" the predicate to `= :ban`.
- **SC5:** a `CRN` against a different BAN under the same FA is **not** returned.
- No BAN selected → FA-scoped, still returns captures and deposits.
- Aggregate correctness: fully-unreversed → `partiallyReversed=false, reversible=true`; some lines reversed → `partiallyReversed=true, reversible=true`; all reversed → both `false`; `draft`/`pending_approval` → `reversible=false`.
- Filters compose (type × status × q); sort whitelist rejects an unknown value by falling back to `-event_at`; pagination `total` is the unfiltered-by-page count.
- **inv. #19:** the type filter offers exactly five values.

`tests/components/documents-table.test.tsx`: **SC9** partially-reversed badge renders beside `posted`; scope marker shows FA-level for null-BAN rows; empty state links to Overview.

Update `tests/accounts/route-level-transactions.test.ts` for **SC11** (banner present when approvals pending) and to drop assertions on the deleted `PendingApprovalsList`.

### 3.8 Explicitly NOT in this unit

No drawer (ac21) — `?doc` is parsed but renders nothing. No reversal control (ac22); `ReversalsPanel` unchanged. No `ClosurePanel` change (D1). No new permission, migration, table, column or document type. No write in the read path. No `system_config` key. No bulk actions, saved views, or CSV export of the table.

---

## 4. Dependencies (packages to install)

**None.** Drizzle, Zod, `AmountCell`, `DocStateBadge`, `formatDatetime` and the app locale/timezone services all exist. Zero npm installs, zero migrations.

## 5. Verification checklist

**Diff hygiene**

- [ ] Added: `listForContext` on the document repository, `list-transaction-documents.ts`, `transactions-search-params.schema.ts`, `documents-table.tsx`, `approval-banner.tsx`, the three test files. Changed: `doc-state-badge.tsx` (derived prop), `transactions/page.tsx`. Deleted: the Pending Approvals section + `pending-approvals-list.tsx`.
- [ ] The new service and repository method contain **no** `insert`/`update`/`delete`/`transaction` and no pgledger call (inv. #15).
- [ ] No migration, no new permission, no `system_config` key. No `TODO`/`console.*`.

**Build gates**

- [ ] `typecheck` · `lint` · `format:check` · `test` green; permission-count assertions do not move.

**Behavior — the point of the unit**

- [ ] **SC4:** capture a payment → it appears in the table immediately, marked **FA-level**. Same for a deposit.
- [ ] **SC5:** a document against another BAN under the same FA is absent.
- [ ] With FA but no BAN, the table is FA-scoped and populated — **not** empty.
- [ ] With neither FA nor BAN, the empty state links back to Overview with context preserved.
- [ ] **SC9:** a part-reversed posted document shows `Posted` + `Partially reversed`, and is reachable via `?rev=partial`.
- [ ] **SC11:** the approval banner appears on load; **Review now** filters to `pending_approval`; approving still rejects self-approval server-side.
- [ ] Filters, sort and page are URL params; a pasted URL reproduces the exact view; a tampered param degrades to its default rather than 500ing.

**Invariants**

- [ ] **#15** read path never writes · **#16** predicate includes `OR ref_billing_account_id IS NULL` · **#19** exactly five doc types offered · **#17** filter state in URL, no client store.

**Docs in sync**

- [ ] `acctmgmt-progress-tracker.md`: `ac20` complete, "Next Up" → `ac21`.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline.

Any failing item means the unit isn't done. **ac21** makes the `?doc` param open the detail drawer.
