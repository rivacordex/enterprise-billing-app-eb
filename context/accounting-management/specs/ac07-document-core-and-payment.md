# AC07 — Document Core + First Money Movement (PAY): `money.ts`, State Machine, Atomic Posting, Capture + Allocation

- **Unit:** 7 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac05` (Transactions will reuse the context strip, `amount-cell`, `parseAccountsContext`, nav shell; balances move visibly in Overview). `ac03` (reason codes with `auto_post_limit`/`posting_nature`; `sys.cash.MYR` for the cash leg). `ac02` (`document`/`document_line`/`ledger_binding` tables + repositories; `ledger.repository` wraps `pgledger_create_transfers`; `accounting_period` table). `ac04` (accounts + bindings to move money against). `ac06` (Ledger Explorer traces the transfers this unit posts — not a hard dep, but the visible proof).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Goal 2/3* (all operations through approval-gated documents; live balances), *Core user flow* steps 4–5 (capture + allocation), *Transactions (documents)* section; `acctmgmt-architecture.md` §2 (`services/accounts/` — document state machine, threshold routing, posting-nature selection, period validation), §6 Module Inv. **#2** (no stored balances — **V3**), **#3** (money only through posted docs; line↔transfer UNIQUE — **V11**), **#5** (atomic posting), **#6** (approver ≠ creator, thresholds server-side — **V11**), **#7** (closed periods reject — **V11**/Q9), **#8** (posting nature steers counter-account — Q19); `acctmgmt-code-standards.md` §1.1 (only `post-document.ts` calls transfer functions), §1.2 (one transaction per financial mutation), §1.4 (approver≠creator is a service check), §2.2 (**`money.ts`** — the single money-arithmetic file, sen integers, `MONEY_PRECISION`), §2.3 (signed-balance helpers), §2.4 (Result + error codes `DOC_STATE_INVALID`/`APPROVAL_REQUIRED`/`SELF_APPROVAL`/`PERIOD_CLOSED`/`UNBALANCED_DOC`), §2.5 (optimistic lock on `document`), §3.3 (per-operation actions, not a generic `postDocument`), §3.5 (greyed-out from context strip), §4.1 (`doc-state-badge`), §8 (`accounts_transactions` map); decisions **Q1** (PAY needs FA only; allocation defaults to selected BAN), **Q15** (unapplied_cash pot; advance = capture w/o full allocation), **Q19** (nature → sys account), **Q20** (threshold per reason code, MANAGER approves above), **Q22** (payment modes + `mode_ref`), **Q24** (manual allocation only), Q9 (period validation, re-date). Plan §2 (PAY00000117 doc + 2 lines + T3/T4 legs), §3 steps 4–5, §4 verification steps **3** (API balance = ledger), **8** (payment_status derivation), **11** (document state machine — threshold, approver≠creator, atomic, unbalanced-doc, closed-period).
- **Note on codebase verification:** planning-folder-only session. Confirm: (a) whether the platform already has a money/decimal utility this must not duplicate (code-standards §2.2 says `money.ts` is *the* file — verify none exists in `core` first); (b) the `pgledger_create_transfers` array/`transfer_request` signature exactly (plan §1.1 gives it — reconcile against the ac01 generated SQL); (c) the audit-event helper signature (`writeAuditEvent`) reused from Customer/Product.

---

## 1. Goal

Build the document layer and the first money movement: **`money.ts`** (the module's single money-arithmetic file — string amounts, integer-sen add/subtract/compare, `MONEY_PRECISION` on >2dp); the **document state machine** (`draft → pending_approval → posted`, `draft → cancelled`) with submit/approve transitions, **threshold routing** per reason-code `auto_post_limit` (Q20) and **approver ≠ creator** enforced server-side (Inv. #6); the **`post-document` service** that commits doc state + all `pgledger_create_transfers` + audit in one transaction, steering each non-customer leg to the reason code's posting-nature sys account (Q19) and validating `event_at` against the open period (Q9); the **Transactions page shell** with **capture-payment**, **allocation**, and the **refund-payment workbench** (payment modes + `mode_ref`, Q22; manual allocation, Q24; a BAN-scoped Payment Refund panel — refund by payment or by financial document, with cash-refund vs convert-to-advance types — four-eyes `PAYMENT_REFUND`); and the **`accounts_transactions` permission migration**. Done when a RevOps user captures RM 5,400 into `unapplied_cash` and allocates it to a BAN's A/R — balances move in Overview (ac05) and trace in Ledger Explorer (ac06) — with V3, V8, and V11 green.

## 2. Design

The module's spine: after this unit, money only ever moves through posted documents. Boundary: **`services/accounts/{money,post-document,document-state-machine,capture-payment,allocate-payment,refund-payment}.ts`, `validation/accounts/{capture-payment,allocate-payment,refund-payment,submit-document,approve-document}.schema.ts` + the `mode_ref` discriminated union, `actions/accounts/{capture-payment,allocate-payment,refund-payment,submit-document,approve-document}.action.ts`, `app/(app)/accounts/transactions/**` (shell + PAY panel), `components/accounts/doc-state-badge.tsx`, the `accounts_transactions` permission migration, and the filled `document`/`document_line` repository write bodies + `ledger.repository.pgledgerCreateTransfers`**.

### 2.1 `money.ts` (merged — code-standards §2.2)

The design decision code-standards §2.2 requires *is* this file. Amounts are `string` end-to-end (DB `numeric(18,2)` ↔ string). `money.ts` is the **only** place an amount becomes a number: it parses to integer **sen** (minor units) for `add`/`subtract`/`compare`/`sum`, returns a 2dp `string`, and throws `AppError('MONEY_PRECISION')` on >2 decimal places or a non-decimal string. No `parseFloat`/`Number()` on an amount exists anywhere else — including tests (ac17's grep gate enforces this). The header-total = Σ-lines check (§2.3) and every balance comparison route through `money.ts`.

### 2.2 Document state machine + threshold routing + approver ≠ creator

- **Transition map** (types/accounts.ts, added here — ac02 shipped the `DOC_STATES` union only): `draft → {pending_approval, posted, cancelled}`, `pending_approval → {posted}`, terminal `posted`/`reversed`/`cancelled`. `reversed` is entered only by ac11's reversal, not by a forward transition here.
- **Threshold routing (Q20):** on **submit**, the service compares `document.total_amount` to the reason code's `auto_post_limit` via `money.ts`. At/below → a `accounts_transactions:EDIT` **USER may post directly** (`draft → posted`). Above → `draft → pending_approval`; a USER attempting to post is rejected (`APPROVAL_REQUIRED`). `auto_post_limit = 0` (sensitive natures) always routes to approval.
- **Approver ≠ creator (Inv. #6, code-standards §1.4):** **approve** requires a MANAGER-capable actor whose id ≠ `document.created_by` → else `SELF_APPROVAL`. This is a **service-layer** check on every approval, independent of the UI hiding the approve button. Ownership: documents belong to the module — any permitted approver (not the creator) may approve (architecture §4).
- **Concurrency (code-standards §2.5):** state transitions compare-and-bump `document.last_modified`; two managers approving race to one winner, the loser gets `CONFLICT`.
- All transitions return `Result` (never throw) with the code-standards §2.4 error set.

### 2.3 `post-document` — the one atomic posting path (Inv. #3/#5/#8, code-standards §1.1)

The **only** code path that calls `pgledger_create_transfer(s)` (code-standards §1.1; ac17 grep-gate). `postDocument(tx, documentId, actorId)` runs in one `db.transaction`:
1. **Guard state** (must be `draft`-at/below-limit or `pending_approval`-approved) and **re-check the approver/threshold** rules server-side.
2. **Balanced-doc check:** `document.total_amount == sum(lines.amount)` via `money.ts` → else `UNBALANCED_DOC`.
3. **Open-period validation (Q9):** look up `accounting_period` for `event_at`'s `YYYY-MM` + currency; if `closed` (or absent-and-policy-closed) → `PERIOD_CLOSED` carrying the open-period hint for the re-date prompt. This check runs **inside the transaction** (code-standards §6.8) so a close racing a post can't interleave. (ac14 builds the close action + re-date UX; this unit builds the *rejection*.)
4. **Nature steering (Q19, Inv. #8):** for each line, the counter/sys leg account is selected from the reason code's `posting_nature` → `sys.{nature}.{ccy}` (never hard-coded per page, never user-chosen). PAY's `cash` nature → `sys.cash.MYR`. **Exception:** `deposit_movement` has **no** `sys.deposit_movement` account (ac03) — DEP legs (ac08) are fully template-defined (both accounts named), so template-defined legs bypass nature→sys resolution; nature steering resolves a `sys.{nature}` account only for natures that have one (`revenue`, `revenue_adj`, `write_off`, `rounding`, `cash`).
5. **Post legs:** build the transfer array per line's `line_kind` template (§2.4) and call `pgledger_create_transfers([...], event_at, metadata)` once (atomic, deadlock-safe). Stamp each `document_line.pgledger_transfer_id` (1:1, UNIQUE — Inv. #7) and set transfer `metadata.doc = document_id` (both-way trace).
6. **State + audit:** `document.state = posted`, `posted_at = now()`; `writeAuditEvent('DOCUMENT_POSTED', …)`. Any failure rolls back everything — no half-posted legs, no orphan state (Inv. #5).

### 2.4 PAY leg templates — capture + allocation (Q1/Q15/Q22/Q24, plan §2 T3/T4)

PAY is captured and allocated as **two line kinds** (a doc may carry both, or allocation may follow later against remaining unapplied — Q1/Q15):
- **`capture`** (line 1, Q22): books received money. Legs (plan T3): **`fa.{FIN}.unapplied_cash` → `sys.cash.MYR`** for `amount`. Requires FA context only (Q1); `payment_mode` NOT NULL + `mode_ref` per mode (bank_transfer→`{bankRef}`, cheque→`{chequeNo,bank}`, cash→`{receiptNo}` — Q22). After capture, `unapplied_cash` holds the money (advance payment = a capture with no/partial allocation — Q15).
- **`allocation`** (line 2, Q24): applies unapplied cash to a specific **financial document** (a DBN charge; future invoices) belonging to a BAN. Legs (plan T4): **`ban.{BAN}.receivables` → `fa.{FIN}.unapplied_cash`** for `amount`; the line records **`ref_settled_document_id`** (the charge it settles) and `ref_billing_account_id` (the BAN, implied by the document). A single capture may be split across multiple allocation lines / documents / BANs (Q1). **Manual only** (Q24) — no auto-application. Partial allocation leaves the remainder unapplied. This **payment↔document application** is what the refund workbench (§2.4b) reads to show "payments assigned to a document" / "documents a payment settled."

- **`refund` (Q17/Q20 — payout leg):** the bank-payout leg is **`sys.cash.MYR` → `fa.{FIN}.unapplied_cash`** for `amount` (unapplied → 0, cash paid out); reason `PAYMENT_REFUND`, nature `cash`, `auto_post_limit = 0` → **always four-eyes** (Q20). The *simplest* refund — an unallocated overpayment / unapplied remainder — is just this leg. Refunds of **settled** payments and the **convert-to-advance** type compose this leg with an allocation reversal — see the Payment refund workbench (§2.4b). The identical `(PAY, refund)` payout leg is reused by ac08's deposit refund.

Both legs are unsigned `amount` into `pgledger_create_transfers`; the direction is the from/to accounts above. Reason codes: `CUST_PAYMENT`/`ADVANCE_PAYMENT` (nature `cash`, limit 100000 — USER posts directly for normal amounts); `PAYMENT_REFUND` (nature `cash`, limit 0 — always four-eyes).

### 2.4b Payment refund workbench (Q17 story)

The Transactions page hosts a **Payment Refund** panel (PAY doc, reason `PAYMENT_REFUND`, four-eyes), **BAN-scoped** — one billing account per refund transaction (the story's "same business unit"). It reads the **payment↔document applications** (allocation lines, §2.4, via `ref_settled_document_id`). Two entry modes reach the same **assigned items** — the payment applications to refund:
- **Mode A — by payment:** a **Payments** table lists the BAN's payments; select payment(s) → *Confirm selection*; the selected payments and their applications (the documents each was assigned to) appear as **assigned items**.
- **Mode B — by financial document:** a **Financial documents** table lists the BAN's paid documents (DBN charges; future invoices); select one → **all payments assigned to it** appear as assigned items. The operator enters a **Refunded amount per assigned payment**; the refund total = **Σ of the refunded amounts** of the assigned payments.

**Refund type:**
- **Refund payment (cash):** reverse the selected application(s) — the settled document's A/R restored, funds → `unapplied_cash` — then post the payout leg `sys.cash → unapplied_cash`. Net: charge owed again, cash paid out.
- **Convert to advance payment:** reverse the selected application(s) only — A/R restored, funds become an **advance / unapplied** credit on the debtor's account. No bank movement, no payout leg.

**One refund line per assigned item** (multi-line PAY doc; `total_amount = Σ refunded amounts`, `UNBALANCED_DOC` check applies). Reversal legs post via `post-document`'s explicit-leg primitive **`postExplicitLegs` (introduced in this unit, §3.3; reused by ac11's reversal workbench)**; the simplest case — refunding an **unallocated overpayment** (no application) — needs only the payout leg.

**Enforced server-side:** each refunded amount ≤ the original payment / assigned amount; all selected items belong to **one BAN**; currency = MYR (Q12). **GL resolved read-only** — the cash leg steers to `sys.cash` by nature (Q19) → GL 1050; **no user GL override** (Invariants #8/#10 maintained). **Dates/refs:** the panel captures the standard Q29 document fields — `event_at` (entry date), `reference_date`, `reference_info` (date-only capture, default today) — like every document. The whole refund posts **atomically** through `post-document` (reversal + payout legs in one transaction; four-eyes; V1 zero-sum holds).

### 2.5 Transactions page shell + per-operation actions (code-standards §3.3/§3.5)

- Page `/accounts/transactions` (`force-dynamic`, `accounts_transactions:READ` to view). Reuses the context strip; **actions render disabled until required context is present** (code-standards §3.5): PAY capture needs FA (always) — greyed until `?fa` set; allocation needs a BAN — greyed until `?ban`. The server action re-validates the same requirement (never trusts the greyed UI).
- **Per-operation actions** (code-standards §3.3 — no generic `postDocument(anything)`): `capture-payment.action.ts` (creates a PAY doc + `capture` line, submits, posts-or-routes), `allocate-payment.action.ts` (adds/posts an `allocation` line), `refund-payment.action.ts` (the Payment Refund workbench, §2.4b), `submit-document.action.ts`, `approve-document.action.ts`. Each declares its own Zod schema + permission level.
- **`doc-state-badge.tsx`** (code-standards §4.1) — one variant per `DOC_STATES`, mapped to ui-context §2 families.

### 2.6 `accounts_transactions` permission (code-standards §8, Q7/Q20)

Migration + typed constant + grants. `accounts_transactions:READ` = view Transactions; `:EDIT` = draft/submit/post-within-limit/approve. **MANAGER-vs-USER approval routing is NOT a permission level** (code-standards §8) — both hold `:EDIT`; the threshold/approver check (Q20/Inv. #6) is the service-layer workflow rule on top. Seed grants: `MANAGER → accounts_transactions:EDIT`, `USER → accounts_transactions:EDIT` (both draft/post-within-limit; only a non-creator MANAGER can approve above-limit — enforced in service, not by the grant). Route × level tests seed ac17's matrix.

### 2.7 `payment_status` derivation (V8)

On allocation posting, the app flips `billing_account.payment_status`: A/R > 0 → `due`; A/R = 0 → `paid` (computed from the live `receivables` balance via `ledger.repository`, not stored balance — Inv. #2). `overdue` remains **derived at read time** (ac05's badge), never written to `payment_status` (Q8). V8 asserts invoice→due, pay-in-full→paid; the cross-cycle overdue case is the read-time derivation (ac05).

### 2.8 Structural decisions

- **`money.ts` and the doc state machine are pure** (framework-agnostic services). Actions are thin (permission + Zod + call service + map Result).
- **Header `total_amount`** is set from Σ lines at draft time and re-checked at post (`UNBALANCED_DOC`) — the DB stores it (ac02), the service guarantees it.
- **Three mandatory date/reference fields (Q29)** on every document: `event_at` (**entry date** — the document date used for the transaction, UI label "Entry Date"; drives period validation + GL journal), `reference_date` (a reference date the user enters), and `reference_info` (free-text, e.g. transaction code; distinct from `mode_ref`). All are **`timestamptz` in the DB but captured date-only in the UI, defaulting to today** (Q2-1/2/5); the user may pick another date. A shared `documentBaseSchema` enforces all three. A posting whose `event_at` falls in a **closed period is rejected** (Q9); the user corrects the entry date to an open period and re-submits — no separate posting date, no original-date preservation. `reference_date`/`reference_info` are untouched by that correction.

---

## 3. Implementation

### 3.1 `services/accounts/money.ts` (new) — §2.1. `add/subtract/compare/sum(...strings) → string`, sen integers, `MONEY_PRECISION`. No other file does money arithmetic.
### 3.2 State machine — `types/accounts.ts` (transition map) + `services/accounts/document-state-machine.ts` — submit (threshold routing Q20), approve (approver≠creator, Inv. #6), cancel (draft only); compare-and-bump `document.last_modified`; Result codes §2.4.
### 3.3 `services/accounts/post-document.ts` (new) — the sole `pgledger_create_transfers` caller; §2.3 steps 1–6. Also exposes the internal **`postExplicitLegs(tx, legArray, doc, event_at, metadata)`** primitive (arbitrary/opposite legs — used by the refund workbench's allocation reversals, §2.4b) — **introduced here**, reused by ac11's reversal workbench; it stays inside `post-document`, so the "only transfer caller" rule (Inv. #3) holds.
### 3.4 PAY services — `capture-payment.ts` (creates PAY doc + `capture` line, §2.4), `allocate-payment.ts` (`allocation` line + `payment_status` flip §2.7), `refund-payment.ts` (the Payment Refund workbench §2.4b — both entry modes + both refund types; composes the allocation reversal via `post-document`'s explicit-leg path + the payout leg; multi-line, BAN-scoped, each refunded amount ≤ original, reads live balances, four-eyes). Leg templates per `(doc_type, line_kind)` live in a `leg-templates.ts` map consumed by `post-document` (keyed on doc_type so `(PAY, refund)` is distinct from ac08's `(DEP, refund)`).
### 3.5 Validation — a shared `document-base.schema.ts` makes `event_at` (entry date), `reference_date`, and `reference_info` mandatory on **every** document (Q29); dates are captured date-only (default today) though stored `timestamptz`. Merged into each operation schema below. `capture-payment.schema.ts` (FA required, amount decimal-string, `payment_mode` + `mode_ref` discriminated union Q22), `allocate-payment.schema.ts` (BAN required, amount), `refund-payment.schema.ts` (BAN required; entry mode `by_payment | by_document`; refund type `cash | convert_to_advance`; selected items with per-item refunded amount ≤ original; MYR; Reference + Entry dates), `submit`/`approve` schemas (doc id + lock).
### 3.6 Actions — `capture-payment`, `allocate-payment`, `refund-payment`, `submit-document`, `approve-document` (§2.5), each own schema + `accounts_transactions` level; re-validate context server-side (§2.5).
### 3.7 Page + component — `/accounts/transactions` shell + PAY panel (capture + allocation) + **Payment Refund panel** (§2.4b — two entry modes, selection tables, Assigned-items, refund-type toggle, per-item amounts), greyed-from-context; `doc-state-badge.tsx`.
### 3.8 `accounts_transactions` migration + typed constant + grants (§2.6).
### 3.9 Repository write bodies — `document.repository` (per-type id assembler from ac02 §2.2, insert/state-transition/compare-bump), `document-line.repository` (insert, stamp transfer id), `ledger.repository.pgledgerCreateTransfers`.

### 3.10 Guardrail tests — **V3**, **V8**, **V11**
- `v11-document-state-machine.integration.test.ts`: USER posts at/below limit; above limit → `pending_approval` and USER post rejected (`APPROVAL_REQUIRED`); `approved_by == created_by` rejected (`SELF_APPROVAL`); approve posts all lines atomically; `total_amount ≠ Σ lines` rejected (`UNBALANCED_DOC`); post into a **closed period** rejected (`PERIOD_CLOSED`) with re-date hint (seed a closed `accounting_period` in setup). Every posted line has exactly one `pgledger_transfer_id`; no transfer exists without a posted line (Inv. #3).
- `v03-balance-equals-ledger.integration.test.ts`: after capture + allocation, Overview/service balances (FA unapplied, BAN A/R) equal `pgledger_accounts_view`; the §2 story reproduces (capture 5400 → unapplied −5400/held; allocate → A/R 0, unapplied 0).
- `v08-payment-status.integration.test.ts`: charge (fixture DBN via test setup, or a fixture A/R transfer) → `due`; full allocation → `paid`.
- `refund-payment.integration.test.ts`: (a) **overpayment refund** — capture an unallocated overpayment, refund pays it out (`sys.cash → unapplied_cash`); (b) **cash refund of a settled payment** — reverse the allocation (A/R restored) + payout (cash out, unapplied 0); (c) **convert-to-advance** — reverse only (A/R restored, unapplied advance, no cash leg); all **always four-eyes** (limit 0 — USER post rejected, non-creator MANAGER approves, self-approval rejected); refunded amount above the original/assigned amount rejected; a multi-BAN selection rejected (one BAN per transaction); multi-line `total_amount = Σ refunded`; V1 zero-sum after each.
- `money.test.ts`: `add/subtract/compare` correctness; `MONEY_PRECISION` on 3dp; no float drift.
- V1 zero-sum re-asserted after each posting (workflow §5).
- Route × level for `/accounts/transactions` (`accounts_transactions` READ/EDIT).

### 3.11 Explicitly NOT in this unit
No DEP/CRN/DBN/ADJ operations (ac08–ac10 — they add per-operation actions reusing this posting core + leg templates). No reversal (ac11). No period **close** action or re-date **UX** (ac14 — this unit builds only the closed-period *rejection*). No CoA/GL Journal pages (ac12/ac13). No Accounts Settings threshold editing (ac15 — limits come from ac03 seeds). No overdue write (stays derived). No auto-application (Q24).

---

## 4. Dependencies (packages to install)
**None.** `money.ts` is hand-rolled integer-sen arithmetic (no `decimal.js` — code-standards §2.2 mandates the single in-repo file; confirm no platform money util exists first, §"Note" (a)). Reuses ac02–ac06 repositories/components and the platform audit helper. Zero new npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `services/accounts/{money,document-state-machine,post-document,capture-payment,allocate-payment,leg-templates}.ts`, the four validation schemas + `mode_ref` union, the four actions, `app/(app)/accounts/transactions/**`, `components/accounts/doc-state-badge.tsx`, `accounts_transactions` migration + wiring + grants, filled document/line/ledger write repositories, tests.
- [ ] **`post-document.ts` is the only file calling `pgledger_create_transfer(s)`**; **no `parseFloat`/`Number()` on an amount outside `money.ts`** (both ac17 grep-gates — assert clean now). No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green; permission-count assertions +1.

**Behavior — the point of the unit**
- [ ] Capture RM 5,400 (mode + `mode_ref`) → `unapplied_cash` holds it; allocate → BAN A/R 0, unapplied 0; balances move in Overview and trace in Ledger Explorer (**V3**).
- [ ] **V11:** threshold routing, `APPROVAL_REQUIRED`, `SELF_APPROVAL`, atomic multi-leg post, `UNBALANCED_DOC`, `PERIOD_CLOSED` all enforced server-side; every posted line ↔ one transfer.
- [ ] **Payment refund workbench:** overpayment refund (payout only), cash refund of a settled payment (reverse + payout), and convert-to-advance (reverse only) all post atomically, always four-eyes; BAN-scoped; refunded amount ≤ original enforced; GL resolved read-only (no override).
- [ ] Every document requires `event_at` (entry date), `reference_date`, and `reference_info` (Q29) — captured date-only, default today; a document missing any is rejected.
- [ ] **V8:** `payment_status` due→paid derivation.
- [ ] `money.ts` throws `MONEY_PRECISION` on >2dp; no float drift.
- [ ] Actions greyed until context present and re-validated server-side.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac07` complete, "Next Up" → `ac08`; §"Note" reconciliations recorded.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (`/accounts/transactions` route + the four actions).

Any failing item means the unit isn't done. `ac08` (deposits) and `ac09` (CRN/DBN) reuse this unit's `post-document`, leg-template map, state machine, and permission — they are new operations over the same posting core.
