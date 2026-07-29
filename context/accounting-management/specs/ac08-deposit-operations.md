# AC08 — Deposit Operations (DEP): Capture, Reverse-to-Account, Refund

- **Unit:** 8 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac07` (the posting core — `post-document`, `document-state-machine`, threshold routing, `leg-templates` map, `money.ts`, Transactions shell, `accounts_transactions` permission, `doc-state-badge`; DEP reuses all of it). `ac03` (`SEC_DEPOSIT`/`DEP_REVERSE`/`DEP_REFUND` reason codes with limits 50000/0/0, nature `deposit_movement`; `sys.cash.MYR`). `ac04` (the FA's `deposits` and `unapplied_cash` accounts + bindings).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Core user flow* steps 3 & 8, *Transactions* ("security-deposit lifecycle: capture, reverse-to-account, refund"); `acctmgmt-architecture.md` §6 Module Inv. #3/#5/#8 (posting core reused), #12 (closure requires zero — deposit lifecycle ends at zero, **V14**); `acctmgmt-code-standards.md` §3.3 (per-operation actions), §4.1 (`amount-cell`/`doc-state-badge`); decisions **Q4** (deposit FA-level only), **Q15** (deposits pot = refundable guarantee, never silently settles), **Q16 rev.** (three ops split by destination; reverse = release to account; refund = bank payout; apply-to-debt = reverse + normal allocation), **Q20** (DEP_REVERSE/DEP_REFUND seed limit 0 = always four-eyes), Q22 (payment mode on capture — cheque in the sample). Plan §2/§3 security-deposit variant (`deposits → sys.cash` capture; the reverse/refund legs), §4 verification step **14** (deposit lifecycle capture→reverse→allocate→refund ends deposits=0, unapplied=0, closure-eligible; reverse/refund always four-eyes).
- **✓ Leg-direction (resolved & confirmed 2026-07-25):** Q16's decision-log arrows for reverse/refund are **conceptual shorthand**; the actual pgledger `from → to` follows the **balance-correct / sample-story / V14** direction (signed convention — a transfer `X → Y` makes `X` decrease and `Y` increase; T3: `unapplied → cash` drives unapplied to −5400, cash to +5400). Only this direction yields V14's end-state (`deposits = 0`, `unapplied = 0`). The reconciled legs are in §2.2; the plan's Q16 now records that its arrows are conceptual. Deposit refund pays from `unapplied_cash`, sharing the payout leg with the payment refund (ac07).

---

## 1. Goal

Add the three security-deposit operations to the Transactions page as DEP documents over the ac07 posting core: **capture** (`SEC_DEPOSIT`, USER posts ≤ 50,000 — books a received deposit as a held liability), **reverse-to-account** (`DEP_REVERSE`, always four-eyes — releases the held deposit into ordinary unapplied cash, no bank movement), and **refund** (`DEP_REFUND`, always four-eyes — pays the refundable balance out of the bank). Done when a deposit can be captured, reversed, allocated (via ac07's normal allocation), and refunded — the full lifecycle ending at `deposits = 0` and `unapplied = 0` (closure-eligible per Q11) with V14 green, and both sensitive ops routing to MANAGER approval.

## 2. Design

Three new per-operation actions + panels; **no new posting mechanism** — everything routes through ac07's `post-document`, which reads the reason code's nature (`deposit_movement`) and the DEP leg templates added here. Boundary: **`services/accounts/{capture-deposit,reverse-deposit,refund-deposit}.ts`, `validation/accounts/{capture-deposit,reverse-deposit,refund-deposit}.schema.ts`, `actions/accounts/{capture-deposit,reverse-deposit,refund-deposit}.ts`, the DEP entries added to `leg-templates.ts`, and the DEP panels in `app/(app)/accounts/transactions/**`**. No schema change, no new permission (reuses `accounts_transactions`).

### 2.1 DEP is FA-level (Q4/Q15/Q1)

A deposit belongs to the party, not a contract — it moves the FA's `deposits` and `unapplied_cash` pots and `sys.cash`. So DEP requires **FA context only** (Q1); a BAN may be referenced in `document.metadata` as the motivating contract but the money is FA-level (Q4). The deposit pot is a **refundable guarantee — it never silently settles invoices** (Q15); settling against debt is an explicit reverse-then-allocate (§2.3), not an automatic deposit application.

### 2.2 Leg templates (confirmed direction — see ✓ above; nature `deposit_movement` → cash leg is `sys.cash`, no `sys.deposit_movement` account per ac03 §2.2)

Extend `leg-templates.ts` (keyed by `(doc_type, line_kind)` — DEP capture legs differ from PAY capture, so the map must key on doc_type too; refine ac07's map accordingly):

| Op | reason_code | line_kind | pgledger legs (`from → to`, amount) | Balance effect |
|---|---|---|---|---|
| **Capture** | SEC_DEPOSIT | `capture` | `fa.{FIN}.deposits → sys.cash.MYR` | deposits → −A (held liability), cash → +A. `depositHeld = A`. |
| **Reverse-to-account** | DEP_REVERSE | `release` | `fa.{FIN}.unapplied_cash → fa.{FIN}.deposits` | deposits → 0, unapplied → −A (now holds the money). **Internal only — no `sys.cash` leg, no bank movement.** |
| **Refund** | DEP_REFUND | `refund` | `sys.cash.MYR → fa.{FIN}.unapplied_cash` | unapplied → 0, cash → −A (paid out of bank). |

- **Apply-to-debt needs no op** (Q16): it is **reverse** (money → unapplied) then ac07's normal **allocation** (`ban.receivables → unapplied`) settling A/R. The Transactions UI guides this as the settle-first path (fully assembled in ac16's guided closure).
- **Direct refund of a still-held deposit** (refund without reverse-first): if finance wants to refund a deposit that was never released, the money is still in `deposits`, not `unapplied`. This unit's `refund` template pays out of `unapplied` (V14's path). A direct `sys.cash → deposits` refund is **out of scope here** — the canonical path is reverse → refund (V14); note this so ac16's guided path uses reverse-then-refund, and if a direct-refund is later needed it is an additive template, not a redesign.

### 2.3 The lifecycle (V14) and closure eligibility (Q11)

Capture → reverse → (ac07 allocation against final A/R) → refund remainder. End-state: `deposits = 0`, `unapplied = 0` — which is exactly Q11's FA closure gate (unapplied = 0, deposits = 0). ac08 proves the lifecycle reaches zero; **ac16** consumes that to actually close the account. This unit does not close anything.

### 2.4 Approval routing (Q20)

- **Capture** `SEC_DEPOSIT` limit 50,000: a USER posts directly ≤ 50,000; above → MANAGER approval (ac07 threshold routing — nothing new).
- **Reverse** `DEP_REVERSE` and **Refund** `DEP_REFUND` limit **0**: **always** `pending_approval` → non-creator MANAGER approves (Inv. #6 four-eyes). This falls straight out of ac07's threshold routing with limit 0 — no special-case code, just the seeded limit.

### 2.5 Structural decisions

- **Three thin services + actions** (code-standards §3.3), each building the DEP doc + its single line and delegating to `post-document`. No generic "deposit op" switch.
- **`mode_ref` on capture only** (Q22) — reverse/refund are internal/payout ops; capture carries `payment_mode` + `mode_ref` (cheque no. in the sample). Reverse has no mode (no bank movement); refund records the payout reference in `mode_ref` if a mode is chosen (bank_transfer payout) — decide per finance need; default: refund carries a payout `mode_ref` like capture, reverse carries none.
- **Panels reuse the context strip greyed-rule** (code-standards §3.5): DEP actions enabled once `?fa` is set (BAN not required, Q4/Q1).

---

## 3. Implementation

### 3.1 `leg-templates.ts` (extend) — the three DEP `(doc_type, line_kind)` entries (§2.2). The map is already keyed `(doc_type, line_kind)` (ac07); DEP refund's payout leg (`sys.cash → unapplied_cash`) is the **same** leg as ac07's `(PAY, refund)` payment refund — the two share the payout mechanism, differing only by `doc_type`/reason.
### 3.2 Services — `capture-deposit.ts`, `reverse-deposit.ts`, `refund-deposit.ts` (new): build DEP doc + line, delegate to `post-document`.
### 3.3 Validation — `capture-deposit.schema.ts` (FA required, amount, `payment_mode` + `mode_ref`), `reverse-deposit.schema.ts` (FA required, amount ≤ held), `refund-deposit.schema.ts` (FA required, amount ≤ refundable, optional payout `mode_ref`). Amount-vs-balance checks read live balances in the service (Inv. #2), never trust a client figure. All merge ac07's `documentBaseSchema` — mandatory `event_at`/`reference_date`/`reference_info` (Q29).
### 3.4 Actions — `capture-deposit`, `reverse-deposit`, `refund-deposit` (`accounts_transactions:EDIT`).
### 3.5 UI — DEP panels on `/accounts/transactions` (capture/reverse/refund), greyed until `?fa`.
### 3.6 Guardrail test — **V14** `tests/accounts/v14-deposit-lifecycle.integration.test.ts`: onboard → capture 10,000 (`depositHeld = 10,000`, requires approval only if > 50,000 → USER posts directly at 10,000) → reverse (deposits 0, unapplied −10,000; **routes to approval**, USER post rejected, non-creator MANAGER approves) → allocate part against a fixture A/R (ac07 allocation) → refund remainder (**routes to approval**) → assert `deposits = 0`, `unapplied = 0`, Q11 closure-eligible true. V1 zero-sum after each step. Also: refund/reverse with `approved_by == created_by` → `SELF_APPROVAL`.

### 3.7 Explicitly NOT in this unit
No account closure (ac16 consumes the zero end-state). No CRN/DBN/ADJ (ac09/ac10). No reversal-workbench correction of a posted DEP (ac11 — Q16 says erroneous DEP captures are corrected via the generic Q5 workbench, not a named deposit op). No direct `sys.cash → deposits` refund template (§2.2). No new permission/schema/period logic.

---

## 4. Dependencies (packages to install)
**None.** Pure reuse of ac07 posting core + ac03 reason codes. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: three services, three schemas, three actions, DEP entries in `leg-templates.ts`, DEP panels, the V14 test. No schema/migration/permission change.
- [ ] DEP legs match §2.2 (reconciled direction); reverse has no `sys.cash` leg. No `parseFloat`/`Number()` outside `money.ts`; only `post-document` calls transfer functions. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] **V14:** capture → reverse → allocate → refund ends `deposits = 0`, `unapplied = 0`, closure-eligible; V1 green throughout.
- [ ] Capture ≤ 50,000 posts directly (USER); reverse & refund **always** route to approval (limit 0) and reject self-approval.
- [ ] Reverse is internal (no bank leg); refund pays out of `sys.cash`.
- [ ] DEP enabled with FA context only (no BAN required).

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac08` complete, "Next Up" → `ac09`; the leg-direction (§2.2) confirmed — Q16 arrows are conceptual.

**Pipeline**
- [ ] CI green incl. SAST + DAST (three new actions on the existing route).

Any failing item means the unit isn't done. `ac09` (CRN/DBN) is the next operation set over the same posting core; `ac16` consumes this unit's zero end-state to close accounts.
