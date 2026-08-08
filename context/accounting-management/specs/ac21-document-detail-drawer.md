# AC21 — Document Detail Drawer

- **Unit:** 21 of 23 (`ac00-build-plan.md`)
- **Dependencies:** `ac20` (the table, its rows, and the `?doc` search param already reserved and parsed). `ac06`'s `transfer-detail-drawer.tsx` is the structural precedent. `ac07`'s `approveDocumentAction` and `ac02`'s `documentLineRepository.findByDocumentId` already exist and are reused unchanged.
- **Authorizing sections:** `acctmgmt-update-overview.md` §Features "Detail drawer", §Core user flow step 7, §Success criteria **SC11, SC14**; `_updatemodule-accounts-transactions-plan.md` §Target design ("Detail drawer per document"); `acctmgmt-architecture.md` §2 (`components/accounts/**`), §4 (READ vs EDIT affordances), §6 **inv. #15, #17**; `acctmgmt-code-standards.md` §3.1 (URL state), §4.1 (shared money components); `acctmgmt-ui-context.md` §2/§3.
- **Codebase verification performed for this spec:** `transfer-detail-drawer.tsx` is a **server-rendered, URL-driven** drawer — it takes a `closeHref` prop and is opened by `?transfer=…`, with no client open/close state. `documentLineRepository.findByDocumentId` exists and is already used by both reversal services. `approveDocumentAction` takes `{ documentId, lastModified }`. `ac20` reserved `?doc` in `transactions-search-params.schema.ts`.

---

## 1. Goal

Make a table row open a document detail drawer showing the document's fields, scope, lines with per-line reversed state, posted ledger legs, and — for `pending_approval` documents — the approval timeline with Approve & post / Reject. Done when any row can be opened and read in full, a pending document can be approved from the drawer with self-approval still rejected server-side, and the drawer's open state lives entirely in the URL.

## 2. Design

**Boundary: `components/accounts/**` (drawer), `services/accounts/list-transaction-documents.ts` or a sibling read service (per-document detail), `app/(app)/accounts/transactions/page.tsx` (wiring).** Read-only apart from reusing the existing approve action. No new repository method, no schema change, no migration.

### 2.1 URL-driven, not client state — follow the ac06 precedent

`transfer-detail-drawer.tsx` established the pattern: the drawer is **server-rendered** and opened by a search param, receiving a `closeHref` that drops that param while preserving everything else. The document drawer does the same with `?doc=<documentId>`, already parsed by ac20's schema.

This is not stylistic preference. A client-state drawer would break three things the URL version gets free: a pasted/bookmarked URL reproduces the open document; the drawer survives `router.refresh()` after an approve; and browser Back closes it. It also keeps the page a Server Component with no client data fetching, consistent with **inv. #15** and code-standards §3.1.

`closeHref` preserves `party/fa/ban` **and** the active filters/sort/page — closing the drawer must not reset the table underneath, exactly as `ledger/page.tsx` builds its own `closeDrawerHref`.

### 2.2 Content

| Section | Content | Source |
|---|---|---|
| Header | `documentId` · human action label · `DocStateBadge` (+ partially-reversed chip) · `docType` chip | ac20's row data |
| Details | account, **scope** (BAN chip or FA-level), reason code, amount, `eventAt` (captioned "Reference Date" since AC24), `entryDate` (captioned "Entry Date"), `referenceInfo`, created-by, approved-by | `billing.document` |
| Cross-links | `Reverses` → `reversalOf`; `Reversed by` → the reversing document | `reversalOf`; reverse-lookup |
| Lines | per line: `lineNo`, `lineKind`, amount, and **reversed state** | `document_line` incl. `reversedByLineId` |
| Ledger legs | the posted transfer for each unreversed line | via `pgledgerTransferId` |
| Approval | timeline + Approve & post / Reject, `pending_approval` only | `createdBy`, `postedAt`, `approvedBy` |

Amounts via `AmountCell`; ids mono; no balance is displayed, so **inv. #2** is not engaged.

### 2.3 Ledger legs — the one place this unit touches pgledger

Rendering "as posted" legs means reading transfers by `pgledgerTransferId`. That read goes through `db/repositories/accounts/ledger.repository` using **views and functions only** — `pgledger_transfers_view` — never a base-table `SELECT` (**inv. #4**, code-standards §6.3). `ledgerRepository.findTransferById` already exists (used by `reverse-document.ts`) and is reused; if a batch read is warranted for multi-line documents, add a `findTransfersByIds` on the same repository rather than looping.

If a line has no resolvable transfer, render an em-dash rather than throwing — a display surface must not 500 on inconsistent history. (The reversal *service* still treats this as an error; that asymmetry is correct: display degrades, posting does not.)

### 2.4 Approve / Reject placement (SC11, SC14)

ac20 left an inline approve affordance on `pending_approval` rows as a deliberate stopgap. **This unit removes it** and moves approval into the drawer, where the approver can see the amount, reason, lines and posting preview before acting — which is the point of four-eyes.

`approveDocumentAction({ documentId, lastModified })` is reused unchanged; `lastModified` comes from the loaded document for the existing CAS. Self-approval rejection stays server-side (**inv. #6**). The drawer surfaces the returned Result codes using the §9 catalog vocabulary — `SELF_APPROVAL`, `CONFLICT`, `DOC_STATE_INVALID` — and never re-implements the rule client-side.

**Reject** requires a `status_reason`. If no reject action exists in the shipped codebase, **do not invent one in this unit** — render Approve only and record the gap; adding a mutation is a spec change, not drawer work (workflow rules §4.3).

### 2.5 Permission-driven affordances (architecture §4)

`accounts_transactions : READ` sees the whole drawer — details, lines, legs, timeline — and **no** Approve/Reject. `EDIT` additionally sees the approval controls. Reversal is not in this unit; ac22 adds its entry point to the drawer footer.

### 2.6 No new read plumbing where ac20 already has it

The drawer's header/details fields are already in ac20's row data. Only **lines** and **legs** are new reads. Add a focused `getTransactionDocumentDetail(documentId, financialAccountId)` read service that returns document + lines + legs, and **re-checks FA ownership**, returning `WRONG_FINANCIAL_ACCOUNT` if the id in `?doc` does not belong to the context FA — a tampered `?doc` must not disclose another customer's document. This is the unit's one security-relevant behaviour.

---

## 3. Implementation

### 3.1 `services/accounts/get-transaction-document-detail.ts` (new, read-only)

`(documentId, financialAccountId) → Result<{ document, lines, legs }>` with codes `DOCUMENT_NOT_FOUND` and `WRONG_FINANCIAL_ACCOUNT` (both already in the §9 catalog — no new code). Uses `documentRepository.findById`, `documentLineRepository.findByDocumentId`, and `ledgerRepository` transfer reads. SELECTs only (**inv. #15**).

### 3.2 `components/accounts/document-detail-drawer.tsx` (new)

Server component mirroring `transfer-detail-drawer.tsx`: fixed side panel, `closeHref` link with `aria-label`, labelled sections per §2.2. Reuses `AmountCell`, `DocStateBadge`, the scope chip from ac20, and `formatDatetime` with app locale/timezone.

### 3.3 `components/accounts/document-approval-actions.tsx` (new, `"use client"`)

The only client component in this unit: Approve button → `approveDocumentAction`, busy state, Result-code → message mapping, `router.refresh()` on success. Rendered only when `canEdit && state === "pending_approval"`.

### 3.4 Page wiring

Build `closeHref` from current params minus `doc` (mirroring `ledger/page.tsx`); when `?doc` is present and resolves, render the drawer. Remove ac20's inline row-level approve stopgap. Row links already point at `?doc=…` from ac20 — no table change beyond deleting that stopgap.

### 3.5 Tests

`tests/accounts/document-detail.integration.test.ts`:

- Detail returns document + lines + legs for a posted multi-line document.
- A `?doc` belonging to **another FA** returns `WRONG_FINANCIAL_ACCOUNT` and renders nothing (§2.6).
- A line whose transfer is missing renders an em-dash rather than throwing (§2.3).
- Lines report per-line reversed state correctly on a partially-reversed document.

`tests/components/document-detail-drawer.test.tsx`:

- **SC11:** approval timeline + Approve render for `pending_approval`; absent for `posted`.
- **SC14:** with READ only, no Approve/Reject anywhere in the drawer.
- `closeHref` preserves `party/fa/ban` **and** `type/status/rev/q/sort/page` (regression: closing must not reset the table).

Update `tests/accounts/route-level-transactions.test.ts`: approve is reachable from the drawer, not from a row.

### 3.6 Explicitly NOT in this unit

No reversal control or reversal dialog (ac22) — `ReversalsPanel` still carries reversal and is unchanged. No Reject mutation if none exists (§2.4). No new permission, migration, table, column, document type, or Result code. No write beyond the existing approve action. No `ClosurePanel` change (D1).

---

## 4. Dependencies (packages to install)

**None.** `approveDocumentAction`, `documentLineRepository.findByDocumentId`, `ledgerRepository` transfer reads, `AmountCell`, `DocStateBadge` and `formatDatetime` all exist. Zero npm installs, zero migrations.

## 5. Verification checklist

**Diff hygiene**

- [ ] Added: `get-transaction-document-detail.ts`, `document-detail-drawer.tsx`, `document-approval-actions.tsx`, the two test files. Changed: `transactions/page.tsx` (drawer wiring, stopgap removal), `documents-table.tsx` (stopgap removal only).
- [ ] The detail service contains no write, no transaction, no pgledger **base-table** access — views/functions only (inv. #4, #15).
- [ ] No new Result code introduced; both used codes already exist in code-standards §9.

**Build gates**

- [ ] `typecheck` · `lint` · `format:check` · `test` green; permission-count assertions do not move.

**Behavior — the point of the unit**

- [ ] Click any row → drawer opens with details, scope, lines (with reversed state) and posted legs.
- [ ] Drawer state is URL-driven: pasting `?doc=…` reopens it; browser Back closes it; `closeHref` preserves context **and** filters/sort/page.
- [ ] **SC11:** a pending document can be approved from the drawer; self-approval is rejected with the `SELF_APPROVAL` message; a stale `lastModified` yields `CONFLICT`.
- [ ] **SC14:** a READ-only holder sees the full drawer and no approve/reject affordance.
- [ ] A `?doc` from another FA discloses nothing (`WRONG_FINANCIAL_ACCOUNT`).
- [ ] A line with an unresolvable transfer renders an em-dash; the page does not 500.

**Invariants**

- [ ] **#15** read path never writes (the approve action is a pre-existing action, not part of the read service) · **#17** drawer state in the URL, not component state · **#4** pgledger accessed via views/functions only.

**Docs in sync**

- [ ] `acctmgmt-progress-tracker.md`: `ac21` complete, "Next Up" → `ac22`. Record whether a Reject mutation exists (§2.4) as a spec gap if not.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline.

Any failing item means the unit isn't done. **ac22** adds the reversal control to rows and this drawer, and retires `ReversalsPanel`.
