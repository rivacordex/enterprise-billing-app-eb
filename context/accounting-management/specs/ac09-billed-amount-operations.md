# AC09 — Billed-Amount Operations (CRN + DBN): Raise Credit Note, Raise Debit Note

- **Unit:** 9 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac07` (posting core, leg-templates map, state machine, `accounts_transactions`, Transactions shell). `ac03` (`MANUAL_CHARGE` DBN/revenue/limit 10000; `GOODWILL_CREDIT` CRN/revenue_adj/limit 1000; `sys.revenue.MYR`, `sys.revenue_adj.MYR`, `sys.tax_payable.MYR`). `ac04` (BAN `receivables` accounts).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Core user flow* step 4 & 7 (DBN charge, goodwill CRN above threshold → approval → `sys.revenue_adj`), *Transactions* ("DBN, the only charge vehicle in this phase"); `acctmgmt-architecture.md` §6 Module Inv. #8 (posting nature steers counter-account — **V12**); `acctmgmt-code-standards.md` §3.3 (per-operation actions), §3.5 (greyed from context); decisions **Q1** (CRN/DBN require the selected BAN), **Q17** ("Payment adjustment credit/debit" = CRN/DBN; CRN reduces A/R, DBN adds charge), **Q19** (nature steering: revenue / revenue_adj), **Q20** (thresholds — GOODWILL_CREDIT limit 1000 routes to approval; MANUAL_CHARGE limit 10000), **Q21** (DBN is the manual charge vehicle; no invoice generation). Plan §3 story step 2 (DBN two-leg posting `revenue → A/R` + `tax → A/R`), §4 verification step **12** (CRN GOODWILL → `sys.revenue_adj`; lands under GL 4090).
- **Note on codebase verification:** planning-folder-only session. (DBN tax-line design confirmed 2026-07-25: net + tax entered manually; the tax leg is a fixed `sys.tax_payable` line, not reason-nature-driven — §2.3.)

---

## 1. Goal

Add the two billed-amount operations to the Transactions page as CRN and DBN documents over the ac07 posting core: **raise-debit-note** (`MANUAL_CHARGE`, nature `revenue` — the phase's only charge vehicle, raises a BAN's A/R, with an optional tax leg to `sys.tax_payable`) and **raise-credit-note** (`GOODWILL_CREDIT`, nature `revenue_adj` — reduces a BAN's A/R), both requiring the selected BAN in UI and re-validated server-side (Q1). Done when a DBN raises A/R (steered to `sys.revenue`, tax to `sys.tax_payable`), a CRN above its 1,000 threshold routes to approval and, once approved, reduces A/R steered to `sys.revenue_adj` (landing under GL 4090), with V12 green.

## 2. Design

Two per-operation actions + panels over ac07's `post-document`; the counter-account is chosen entirely by the reason code's `posting_nature` (Q19/Inv. #8) — never hard-coded per page. Boundary: **`services/accounts/{raise-debit-note,raise-credit-note}.ts`, `validation/accounts/{raise-debit-note,raise-credit-note}.schema.ts`, `actions/accounts/{raise-debit-note,raise-credit-note}.action.ts`, the CRN/DBN entries in `leg-templates.ts`, the CRN/DBN panels in Transactions**. No schema change, no new permission.

### 2.1 BAN-context requirement (Q1)

CRN/DBN touch `ban.{BAN}.receivables`, so they **require the selected BAN** (Q1). UI: the CRN/DBN panels are greyed until `?ban` is present in the context strip (code-standards §3.5); the server action re-validates `document.ref_billing_account_id` is set (the ac02 column is nullable at the DB level but **app-required** for CRN/DBN/ADJ). A DBN/CRN with no BAN is rejected before any posting.

### 2.2 Leg templates + nature steering (Q19/Inv. #8, plan §3)

Extend `leg-templates.ts` (keyed `(doc_type, line_kind)`); the sys counter-account is resolved from the reason code's `posting_nature` at post time (never in the template literal — the template names the *customer* leg and the *nature slot*, `post-document` fills the sys account):

| Op | reason_code | nature | line_kind | principal legs (`from → to`, amount) | Balance effect |
|---|---|---|---|---|---|
| **DBN** (charge) | MANUAL_CHARGE | `revenue` | `charge` | `sys.revenue.MYR → ban.{BAN}.receivables` | A/R → +A (customer owes more); revenue → −A (credit). |
| **CRN** (credit) | GOODWILL_CREDIT | `revenue_adj` | `charge` | `ban.{BAN}.receivables → sys.revenue_adj.MYR` | A/R → −A (reduced); revenue_adj → +A. |

The `charge` line_kind is used for both; **direction comes from `doc_type`** (DBN debits A/R, CRN credits A/R) — the map key `(doc_type, line_kind)` disambiguates. This is why the leg-template map keys on doc_type (established in ac07/ac08).

### 2.3 DBN tax line (optional second line — confirmed 2026-07-25)

A DBN may carry tax (sample: RM 5,000 + RM 400 tax). Because Inv. #7 is one line ↔ one transfer, tax is a **separate `document_line`**, not a second leg on the principal line: line 1 principal (`sys.revenue → A/R`, net), line 2 tax (`sys.tax_payable.MYR → A/R`, tax). The **tax line's counter-account is fixed to `sys.tax_payable`** (tax always goes to tax_payable regardless of the charge's revenue nature) — a fixed system leg in the template, not reason-nature-driven. `document.total_amount = net + tax = Σ lines` (ac07's `UNBALANCED_DOC` check covers it). The DBN form captures net + tax separately; tax is optional (0 tax → single line). CRN has no tax line in this phase. **V12 also asserts the tax leg lands under GL 2200** (§3.6). Tax amounts are entered manually (net + tax); there is no tax-rate engine in v1 (that arrives with the Invoicing module).

### 2.4 Approval routing (Q20 — falls out of ac07)

- **DBN** `MANUAL_CHARGE` limit 10,000: USER posts ≤ 10,000 directly; above → MANAGER approval.
- **CRN** `GOODWILL_CREDIT` limit 1,000: USER posts ≤ 1,000; above → `pending_approval`, non-creator MANAGER approves (Inv. #6). The story's "goodwill credit above RM 1,000 → approval" is exactly this — no special-case code, just the seeded limit + ac07 routing.

### 2.5 Structural decisions

- Two thin services/actions (code-standards §3.3); each builds the doc + line(s) and delegates to `post-document`. No generic "adjustment" switch (ADJ is its own unit, ac10).
- `payment_status` re-derives after a CRN/DBN posts (A/R changed) — reuse ac07's derivation (due/paid from live A/R; overdue stays read-time).
- CRN/DBN carry no `payment_mode`/`mode_ref` (they are not cash captures — Q22 modes are for PAY/DEP capture).

---

## 3. Implementation
### 3.1 `leg-templates.ts` (extend) — DBN/CRN `(doc_type, charge)` entries + the fixed-tax second-line template (§2.2/§2.3).
### 3.2 Services — `raise-debit-note.ts` (net + optional tax → two lines), `raise-credit-note.ts` (single line), both delegating to `post-document`.
### 3.3 Validation — `raise-debit-note.schema.ts` (BAN required, net amount, optional tax amount), `raise-credit-note.schema.ts` (BAN required, amount). Amount format via the decimal-string rule; arithmetic (net+tax total) via `money.ts`. Both merge ac07's `documentBaseSchema` — mandatory `event_at`/`reference_date`/`reference_info` (Q29).
### 3.4 Actions — `raise-debit-note`, `raise-credit-note` (`accounts_transactions:EDIT`), BAN-context re-validated server-side (§2.1).
### 3.5 UI — CRN/DBN panels on Transactions, greyed until `?ban`.
### 3.6 Guardrail test — **V12** `tests/accounts/v12-posting-nature-steering.integration.test.ts`: a CRN `GOODWILL_CREDIT` credits `sys.revenue_adj` and (above 1,000) routes to approval then posts → `gl_journal_view` row under **4090**; a DBN `MANUAL_CHARGE` debits A/R, credits `sys.revenue` → row under **4000**, tax (if present) under **2200**; the nature-selected sys account is never hard-coded (assert the same page/service posts to different sys accounts purely from the reason code). V1 zero-sum after each. Also: a DBN/CRN with no BAN rejected (Q1).

### 3.7 Explicitly NOT in this unit
No ADJ write-off/rounding (ac10). No reversal (ac11). No GL Journal page (ac13 renders the 4090/4000/2200 rows this unit produces). No invoice generation (Q21 — DBN is the charge vehicle). No new reason codes (ac15 adds CRUD). No CRN tax leg.

---

## 4. Dependencies (packages to install)
**None.** Pure reuse of ac07 posting core + ac03 reason codes. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: two services, two schemas, two actions, CRN/DBN + tax entries in `leg-templates.ts`, CRN/DBN panels, the V12 test. No schema/migration/permission change.
- [ ] Sys counter-account resolved from reason nature (not literal); only `post-document` posts; no `parseFloat`/`Number()` outside `money.ts`. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] DBN raises A/R (→ `sys.revenue`, tax → `sys.tax_payable`); CRN reduces A/R (→ `sys.revenue_adj`). **V12** GL rows land under 4000/4090 (2200 for tax).
- [ ] CRN above 1,000 routes to approval; DBN above 10,000 routes to approval; both reject self-approval.
- [ ] CRN/DBN greyed without a BAN and rejected server-side without one (Q1).
- [ ] `payment_status` re-derives after posting.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac09` complete, "Next Up" → `ac10`; tax-line design (§2.3) confirmed.

**Pipeline**
- [ ] CI green incl. SAST + DAST (two new actions).

Any failing item means the unit isn't done. `ac10` (ADJ write-off/rounding) is the last operation set over the posting core before the reversal workbench (ac11).
