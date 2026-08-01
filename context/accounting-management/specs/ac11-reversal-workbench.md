# AC11 — Reversal Workbench: Document- and Line-Level Reversal

- **Unit:** 11 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac07` (posting core — the single `pgledger_create_transfers` caller; state machine; `accounts_transactions`; `document`/`document_line` with `reversal_of` + `reversed_by_line_id` columns from ac02). `ac08` (deposit docs are reversible too — Q16 error correction goes through this workbench, not a named deposit op). `ac09`/`ac10` (CRN/DBN/ADJ docs reversible). The reversal reverses any posted document from ac07–ac10.
- **Authorizing sections:** `acctmgmt-project-overview.md` *Core user flow* step 6 (fix a wrong-BAN allocation via the workbench — reverse the single allocation line, bank capture untouched), *Transactions* ("Document- and line-level reversal with conservation guarantees"); `acctmgmt-architecture.md` §6 Module Inv. **#4** (append-only — corrections are reversal docs with opposite legs — **V13**), #3/#5 (posting core reused); `acctmgmt-code-standards.md` §3.3 (per-operation action), §2.4 (Result codes); decision **Q5** (document workbench + line-level; preview opposite legs; reason + approval same weight as original; payments reverse individual allocation lines returning funds to unapplied without reversing the capture; also available from document detail), Q16 (erroneous DEP captures corrected via this workbench). Plan §4 verification steps **4** (cash-application conservation through arbitrary reverse/re-apply) and **13** (line-level reversal conservation — A/R + unapplied restored, capture untouched, `reversed_by_line_id` set).
- **Note on codebase verification:** planning-folder-only session. Confirm `post-document`'s internal transfer-posting primitive can accept an explicit opposite-leg array (reversal legs are computed from the original transfers, not from the `leg-templates` map — §2.1).

---

## 1. Goal

Build the Reversals workbench on the Transactions page: pick a posted document in the selected context, preview the exact opposite legs, and reverse it — either the **whole document** or a **single line** (e.g. one allocation line of a PAY, returning funds to unapplied without touching the bank capture) — creating a new reversal document (`reversal_of` set, opposite legs, append-only per Inv. #4) that requires a reason and approval of the same weight as the original, and stamping `reversed_by_line_id` on any individually-reversed line. Done when an allocation can be reversed without reversing its capture (V13), conservation holds through arbitrary reverse/re-apply sequences (V4), and every reversal is a new posted document, never an edit or delete of the original.

## 2. Design

Reversal is a **new document with opposite legs** — never a mutation of the original doc, line, or ledger entry (Inv. #4; the ledger is append-only). Boundary: **`services/accounts/{reverse-document,reverse-line}.ts`, `validation/accounts/reverse-document.schema.ts`, `actions/accounts/reverse-document.action.ts`, the Reversals panel + preview drawer in Transactions, and a `reverse` entry point on document detail**. No schema change (ac02 shipped `reversal_of`/`reversed_by_line_id`), no new permission.

### 2.1 Opposite legs, posted through the one transfer path (Inv. #3/#4)

For each original posted `document_line`, its transfer was `from → to` for `amount`. The reversal posts the **inverse** `to → from` for the same `amount`, restoring both accounts. Because reversal legs are computed from the original transfers (not from the `leg-templates` map), `post-document` exposes an internal primitive that accepts an **explicit opposite-leg array** and still is the sole `pgledger_create_transfers` caller (code-standards §1.1 preserved — the grep-gate stays clean). The reversal document's lines mirror the reversed originals (same `line_kind`, same `amount`, target BAN), each stamped with its new `pglt_…` and `metadata.doc = reversal_doc_id`; the reversal's `metadata` also records `reverses: original_doc_id`.

### 2.2 Document-level vs line-level (Q5)

- **Document-level:** reverse every posted line of the original. The reversal doc carries one opposite line per original line.
- **Line-level (payments):** reverse **selected line(s)** — the headline case is reversing a PAY's `allocation` line (funds return to `unapplied_cash`) **without** reversing the `capture` line (bank money stays booked). The reversal doc carries only the opposite of the selected line(s); the untouched lines' balances don't move (V13).
- Line-level is offered for allocation lines specifically (Q5); document-level is available for any posted doc, including DEP (Q16 error correction) and CRN/DBN/ADJ.

### 2.3 `reversed_by_line_id` wiring (Q5)

When a specific original line is reversed, its `reversed_by_line_id` is set to the reversal doc's corresponding line id — a durable pointer marking the line as reversed and by which line. Document-level reversal sets it on every reversed line. A line already carrying `reversed_by_line_id` cannot be reversed again (the preview excludes already-reversed lines; the service rejects a double-reverse with `DOC_STATE_INVALID`/`ALREADY_REVERSED`). The original document's `state` moves to `reversed` only when **all** its lines are reversed; a partially-reversed doc stays `posted` with some lines flagged (so a PAY with its allocation reversed but capture intact is still `posted`).

### 2.4 Approval — same weight as original (Q5)

The reversal is gated **at least as strictly as the original**: it reuses the original's `reason_code` (so same nature + same `auto_post_limit`) and routes through ac07's state machine identically, **plus** a mandatory reversal reason/comment. approver ≠ creator still applies (Inv. #6). A reversal of a limit-0 doc (write-off, deposit reverse/refund) is therefore always four-eyes. (If finance later wants dedicated reversal reason codes, that's additive in ac15; this phase reuses the original's.)

### 2.5 Preview opposite legs (UI, Q5)

Selecting a posted doc opens a preview drawer showing the exact opposite legs that will post (account names + kind chips + signed amounts, reusing ac06's leg rendering) before confirmation — no reversal posts without the operator seeing the legs. Line-level shows a per-line checkbox (allocation lines selectable; already-reversed lines disabled). The workbench requires the context strip's doc selection; `reverse` is also reachable from a document-detail view.

### 2.6 Conservation invariants (V4/V13)

- **V13:** reversing a PAY's allocation restores A/R and unapplied to their pre-allocation values and leaves the capture's `sys.cash`/unapplied effect intact; `reversed_by_line_id` set; the capture line untouched.
- **V4:** across arbitrary receive/apply/reverse/re-apply sequences, `Σ received − Σ applied = −(unapplied balance)` always holds (the signed-convention conservation identity) — a property-based test (code-standards §7.2), living beside the integration tests.

---

## 3. Implementation
### 3.1 `post-document.ts` — **reuse** the `postExplicitLegs(tx, legArray, doc, event_at, metadata)` primitive **introduced in ac07 (§3.3)** for opposite-leg posting (§2.1); still the only transfer caller. (No new primitive — ac07 added it for the refund workbench; ac11 consumes it.)
### 3.2 Services — `reverse-document.ts` (all lines), `reverse-line.ts` (selected lines): compute opposite legs from the originals' transfers, build the reversal doc + lines, set `reversal_of` + each original's `reversed_by_line_id`, flip original `state → reversed` only when fully reversed (§2.3), delegate posting to §3.1.
### 3.3 Validation — `reverse-document.schema.ts` (original doc id, optional line-id selection, reversal reason/comment, lock). Merges ac07's `documentBaseSchema` — the reversal document also captures mandatory `event_at`/`reference_date`/`reference_info` (Q29; captured date-only, default today).
### 3.4 Action — `reverse-document.action.ts` (`accounts_transactions:EDIT`; approval routing per §2.4; reject `ALREADY_REVERSED`, `SELF_APPROVAL`).
### 3.5 UI — Reversals panel + preview drawer (§2.5) on Transactions; `reverse` entry on document detail.
### 3.6 Guardrail tests — **V13** `tests/accounts/v13-line-reversal-conservation.property.test.ts`: capture+allocate a PAY, reverse the allocation line → A/R restored, unapplied restored, capture untouched, `reversed_by_line_id` set; repeated re-apply/reverse always satisfies V4. **V4** `tests/accounts/v04-cash-conservation.property.test.ts`: arbitrary receive/apply/reverse sequences keep `Σ received − Σ applied = −unapplied`. Plus: document-level reversal of a DBN restores A/R (Q16 pattern for DEP too); double-reverse rejected; reversal of a limit-0 doc always four-eyes; V1 zero-sum after every reversal.

### 3.7 Explicitly NOT in this unit
No edit/delete of any original doc/line/entry (append-only — reversal is always a new doc). No GL Journal/CoA pages. No period close (ac14 — but a reversal into a closed period is rejected by ac07's existing `PERIOD_CLOSED` check, inherited). No dedicated reversal reason codes (reuses original's). No account closure (ac16 uses reversal as one step of the guided path).

---

## 4. Dependencies (packages to install)
- A **property-based testing** helper if the repo doesn't already have one (e.g. `fast-check`) for V4/V13 — confirm whether one is already installed (Customer/Product property tests may have introduced it); if present, **none**. Otherwise add `fast-check` (dev dependency) and note it.
- Otherwise zero runtime packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `reverse-document`/`reverse-line` services, `reverse-document` schema + action, `post-document` opposite-leg primitive, Reversals panel + preview drawer, document-detail reverse entry, V4/V13 property tests. No schema/migration/permission change.
- [ ] Only `post-document` calls transfer functions (opposite-leg primitive included); no original row is ever UPDATE/DELETEd except the `state`/`reversed_by_line_id` bookkeeping columns. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] **V13:** reverse a PAY allocation → A/R + unapplied restored, capture untouched, `reversed_by_line_id` set.
- [ ] **V4:** conservation holds through arbitrary reverse/re-apply sequences.
- [ ] Preview shows exact opposite legs before posting; reversal is a new posted doc (`reversal_of` set); original → `reversed` only when fully reversed.
- [ ] Reversal reuses original weight (limit-0 docs always four-eyes); self-approval rejected; double-reverse rejected; closed-period reversal rejected.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac11` complete, "Next Up" → `ac12`; property-test dependency decision recorded.

**Pipeline**
- [ ] CI green incl. SAST + DAST.

Any failing item means the unit isn't done. `ac12` (Chart of Accounts page) shifts to the GL-config surface; the transaction operation set (ac07–ac11) is now complete and every posting reverses cleanly.
