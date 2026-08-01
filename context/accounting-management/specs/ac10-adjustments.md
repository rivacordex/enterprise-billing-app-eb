# AC10 — Adjustments (ADJ): Write-Off + Rounding

- **Unit:** 10 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac09` (the CRN/DBN operation pattern over the posting core; BAN-context requirement precedent). `ac07` (posting core, leg-templates, state machine, permission). `ac03` (`BAD_DEBT_WRITEOFF` ADJ/write_off/limit 0; `ROUNDING_ADJ` ADJ/rounding/limit 10; `sys.write_off.MYR`, `sys.rounding.MYR`; GL 6100 Bad Debt Expense, 6900 Rounding Differences). `ac04` (BAN `receivables`).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Transactions* ("write-off and rounding adjustments"); `acctmgmt-architecture.md` §6 Module Inv. #8 (nature steering — write-off lands in GL 6100, **V12** write-off half); `acctmgmt-code-standards.md` §3.3 (per-operation actions); decisions **Q17** ("Adjustments" entry narrows to small write-offs/rounding with dedicated reason codes), **Q19** (nature `write_off`/`rounding` → `sys.write_off`/`sys.rounding`), **Q20** (BAD_DEBT_WRITEOFF limit 0 = always four-eyes; ROUNDING_ADJ limit 10), Q1 (ADJ requires the selected BAN). Plan §4 verification step **12** (ADJ with BAD_DEBT_WRITEOFF debits `sys.write_off` → GL 6100).
- **Note on codebase verification:** planning-folder-only session. Confirm the rounding direction policy (§2.2) matches finance intent (a rounding residue can be debit or credit).

---

## 1. Goal

Add the two adjustment operations to the Transactions page as ADJ documents over the ac07 posting core: **write-off** (`BAD_DEBT_WRITEOFF`, nature `write_off`, always four-eyes — removes uncollectable A/R to bad-debt expense) and **rounding** (`ROUNDING_ADJ`, nature `rounding`, limit 10 — clears a small A/R residue), both requiring the selected BAN. Done when a write-off posts `ban.receivables → sys.write_off` (landing under GL 6100 in `gl_resolution_view`/`gl_journal_view`) via a mandatory MANAGER approval, and a small rounding adjustment clears a residue to `sys.rounding` (GL 6900), completing the V12 nature-steering set.

## 2. Design

Two more per-operation actions over `post-document`; identical pattern to ac09, different natures/limits. Boundary: **`services/accounts/{write-off,rounding-adjustment}.ts`, `validation/accounts/{write-off,rounding-adjustment}.schema.ts`, `actions/accounts/{write-off,rounding-adjustment}.ts`, the ADJ entries in `leg-templates.ts`, the ADJ panel in Transactions**. No schema change, no new permission.

### 2.1 Leg templates (nature-steered, Q19/Inv. #8)

Extend `leg-templates.ts` (`(doc_type, line_kind)`); sys account resolved from reason nature at post time:

| Op | reason_code | nature | line_kind | legs (`from → to`, amount) | Effect |
|---|---|---|---|---|---|
| **Write-off** | BAD_DEBT_WRITEOFF | `write_off` | `charge` | `ban.{BAN}.receivables → sys.write_off.MYR` | A/R → −A (removed); write_off → +A (debit expense, GL 6100). |
| **Rounding** | ROUNDING_ADJ | `rounding` | `charge` | `ban.{BAN}.receivables → sys.rounding.MYR` (or reverse for a credit residue, §2.2) | A/R residue → 0; rounding → ± small (GL 6900). |

### 2.2 Rounding direction (resolved in-spec, §"Note")

A rounding residue can be a tiny debit or credit balance. Default policy: clear a **positive A/R residue** (customer owes a few sen) via `ban.receivables → sys.rounding` (reduce A/R, debit rounding); a **credit residue** (we owe a few sen) via `sys.rounding → ban.receivables`. The service chooses direction from the sign of the residue (read live from the A/R balance via `money.ts`/signed helpers, never from client input). Capped by the `auto_post_limit` of 10 (USER posts ≤ 10 directly; above → approval — a rounding "adjustment" over 10 is suspicious and should be reviewed).

### 2.3 Approval routing (Q20)

- **Write-off** limit **0**: **always** `pending_approval` → non-creator MANAGER (Inv. #6). Bad debt is a real expense; four-eyes always.
- **Rounding** limit **10**: USER posts ≤ 10 directly; above → approval.

### 2.4 Structural decisions

- Two thin services/actions (code-standards §3.3), delegating to `post-document`; ADJ requires BAN (Q1), greyed until `?ban`, re-validated server-side (same as ac09).
- `payment_status` re-derives after posting (A/R changed).
- No `payment_mode`/`mode_ref` (not a cash capture).

---

## 3. Implementation
### 3.1 `leg-templates.ts` (extend) — ADJ write-off + rounding `(doc_type, charge)` entries (§2.1), rounding direction helper (§2.2).
### 3.2 Services — `write-off.ts`, `rounding-adjustment.ts`, delegating to `post-document`.
### 3.3 Validation — `write-off.schema.ts` (BAN required, amount ≤ open A/R), `rounding-adjustment.schema.ts` (BAN required, small amount). Balances read live in the service. Both merge ac07's `documentBaseSchema` — mandatory `event_at`/`reference_date`/`reference_info` (Q29).
### 3.4 Actions — `write-off`, `rounding-adjustment` (`accounts_transactions:EDIT`), BAN re-validated.
### 3.5 UI — ADJ panel (write-off / rounding) on Transactions, greyed until `?ban`.
### 3.6 Guardrail test — completes **V12**: `BAD_DEBT_WRITEOFF` debits `sys.write_off` → `gl_journal_view` under **6100**, and (limit 0) always routes to approval + rejects self-approval; `ROUNDING_ADJ` clears a residue → `sys.rounding` under **6900**, ≤ 10 posts directly. V1 zero-sum after each; ADJ with no BAN rejected.

### 3.7 Explicitly NOT in this unit
No reversal (ac11). No GL Journal page (ac13 renders these 6100/6900 rows). No new reason codes (ac15 CRUD). No closure residue write-off *flow* (ac16 assembles the guided settle-first path using this unit's write-off op).

---

## 4. Dependencies (packages to install)
**None.** Pure reuse of ac07 posting core + ac03 reason codes. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: two services, two schemas, two actions, ADJ entries in `leg-templates.ts`, ADJ panel, the V12-completion test. No schema/migration/permission change.
- [ ] Nature-steered sys account (not literal); only `post-document` posts; no float arithmetic outside `money.ts`. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] Write-off posts `ban.receivables → sys.write_off` → **GL 6100**; **always** four-eyes; rejects self-approval.
- [ ] Rounding clears a residue → `sys.rounding` (GL 6900); ≤ 10 posts directly, direction follows residue sign.
- [ ] ADJ greyed/rejected without a BAN.
- [ ] V1 zero-sum after each; `payment_status` re-derives.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac10` complete, "Next Up" → `ac11`; rounding-direction policy recorded.

**Pipeline**
- [ ] CI green incl. SAST + DAST.

Any failing item means the unit isn't done. `ac11` (reversal workbench) reverses any of the documents ac07–ac10 posted — the correction path for all five doc types.
