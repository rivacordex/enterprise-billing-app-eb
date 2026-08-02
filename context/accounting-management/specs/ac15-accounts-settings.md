# AC15 — Accounts Settings: Reason-Code + Threshold CRUD, Bill-Cycle Catalog CRUD, Wizard Defaults, Flows Doc

- **Unit:** 15 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac12` (`accounts_config:EDIT`; catalog CRUD + optimistic-lock + retire-not-delete patterns to mirror). `ac07` (reason-code `auto_post_limit` drives threshold routing — editing it changes routing live). `ac04` (the wizard reads the default bill cycle/currency/credit-limit config this page edits; `resolveTerm`). `ac03` (the seeded reason codes, bill cycles, and wizard-default config rows this page now makes editable).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Pages & access* ("Administration → Accounts Settings (reason codes, thresholds, bill-cycle catalog, defaults, flows documentation)"); `acctmgmt-architecture.md` §2 (`app/(app)/administration/accounts-settings/**` ownership), §4 (`accounts-config`; threshold changes are audited config), §6 Module Inv. **#11** (catalogs retire never delete — **V9**), **#13** (terms freeze — **V10**); `acctmgmt-code-standards.md` §2.5 (catalog optimistic lock), §8 (`accounts_config:EDIT`); **Locked UI direction item 8** (Accounts Settings — reason codes, thresholds, flows; BillCycle catalog + default; flows/interaction-map doc page); decisions **Q13** (bill-cycle catalog maintained here; retire never delete; wizard default), **Q14** (term resolution), **Q20** (threshold per reason code, limit changes audited). Plan §4 verification steps **9** (BillCycle catalog integrity — retired cycle rejected for new BANs, retiring a referenced cycle succeeds but removes it from wizard, no delete path) and **10** (term resolution — coalesce(override, default); changing either post-issuance doesn't move stamped due dates).
- **Note on codebase verification:** confirmed. Administration page follows the `app/(app)/administration/**` server-component pattern with `force-dynamic` and `requirePermission`. Wizard-default writes go through `systemConfigRepository.updateValue` (called inside `db.transaction` in `services/accounts/wizard-defaults.ts`), the same repository used by all system-config mutations.

---

## 1. Goal

Add `/administration/accounts-settings` (permission `accounts_config:EDIT`) — CRUD for reason codes including their `auto_post_limit` thresholds (audited config changes, Q20), CRUD for the bill-cycle catalog with retire-not-delete and default-cycle designation (Q13), editing of the wizard defaults (default cycle/currency/credit-limit config rows), and a config-driven flows/interaction-map documentation page (locked item 8). Done when retiring a bill cycle removes it from the onboarding wizard (ac04) while leaving existing BANs untouched (V9), changing a reason-code threshold changes ac07's approval routing on the next post, and the term-resolution invariant (coalesce(override, cycle default), frozen at issuance) holds (V10).

## 2. Design

Config surface under Administration (not the Accounts nav). The catalogs it edits have been seeded and working since ac03 (JIT — the build plan ships Settings late because seeds carried config until now). Boundary: **`app/(app)/administration/accounts-settings/**`, `actions/accounts/{upsert-reason-code,retire-reason-code,upsert-bill-cycle,retire-bill-cycle,set-wizard-defaults}.action.ts`, `services/accounts/{reason-code,bill-cycle,wizard-defaults}.ts`, `validation/accounts/{reason-code,bill-cycle,wizard-defaults}.schema.ts`, the `reason-code`/`bill-cycle` repository bodies (extend)**. No schema change, no new permission.

### 2.1 Reason-code + threshold CRUD (Q20)

Grid of `reason_code` rows (doc_type, posting_nature, `auto_post_limit`, state). Add a code, edit its threshold/label, retire it (never delete — Inv. #11). **Threshold changes are audited config** (Q20) — every `auto_post_limit` edit writes an audit event (before/after). Because ac07 reads the limit live at submit time, changing a threshold **changes approval routing on the next post** (no cached limits) — the visible result. `posting_nature`/`doc_type` of an in-use code are not freely re-typeable (changing a posted code's nature would rewrite history semantics) — edits to those are restricted or produce a new code; the safe editable field is `auto_post_limit` + label + state. Optimistic lock (`last_modified`).

### 2.2 Bill-cycle catalog CRUD (Q13 — V9)

Grid of `bill_cycle` rows (name, frequency, cycle_day, payment_due_days, state). Add/edit a cycle; **retire** (never delete — Inv. #11): a retired cycle disappears from the ac04 wizard's active-only options but stays in joins so existing BANs referencing it are unaffected (V9). Assigning a retired cycle to a new BAN is rejected (ac04's active-check, re-asserted here). Designate the **default cycle** (writes `ACCOUNTS_DEFAULT_BILL_CYCLE`).

### 2.3 Wizard defaults

Edit the `system_config` rows ac03 seeded: `ACCOUNTS_DEFAULT_BILL_CYCLE`, `ACCOUNTS_DEFAULT_CURRENCY` (MYR — read-only in practice this phase, Q12), `ACCOUNTS_DEFAULT_CREDIT_LIMIT` (the resolved-in-ac03 optional pre-fill). Written via the config repository (`config_version` bump or in-place per the platform's `system_config` convention). ac04's wizard reads these live.

### 2.4 Flows documentation page (locked item 8)

A config-driven flows/interaction-map documentation page — a static-but-config-aware reference describing the transaction flows (PAY capture→allocation, DEP capture→reverse→refund, CRN/DBN, ADJ, reversal), the reason-code → nature → sys-account → GL mapping, and the approval thresholds — rendered from the live catalogs so it never drifts from the actual seeded/edited config. Read surface (no writes); `accounts_config:READ` to view.

### 2.5 Term resolution (V10 — resolution testable now, freeze lands with Invoicing)

`resolveTerm` (built in ac04) = `coalesce(BAN override, bill_cycle.payment_due_days)`. This unit completes **V10**: override set → override wins; null → cycle default; **changing a cycle's `payment_due_days` or a BAN's override after a document is issued does not move any already-derived/stamped due date** (frozen-at-generation, Inv. #13). The full stamped-due-date test lands with the Invoicing module; the resolution function + the "later change doesn't re-derive issued dates" property is testable now (a re-date/re-read of an issued doc uses the term as of issuance, not current catalog).

### 2.6 Structural decisions

- Config services + audited mutations; retire-not-delete (no delete functions, code-standards §1.3). Optimistic lock on every catalog row (code-standards §2.5).
- Under `administration/`, guarded `accounts_config:EDIT` (the flows doc sub-view is `:READ`).
- No new pgledger/GL objects — pure catalog + config editing.

---

## 3. Implementation
### 3.1 Route — `/administration/accounts-settings/page.tsx` (+ sub-sections/tabs: reason codes, bill cycles, defaults, flows), `force-dynamic`, guarded `accounts_config`.
### 3.2 Services — `reason-code.ts` (list/upsert/retire, audited threshold change), `bill-cycle.ts` (list/upsert/retire/set-default), `wizard-defaults.ts` (read/write the config rows).
### 3.3 Validation — `reason-code.schema.ts` (limit ≥ 0, editable fields restricted per §2.1), `bill-cycle.schema.ts` (cycle_day 1–28, due_days ≥ 0), `wizard-defaults.schema.ts`.
### 3.4 Actions — `upsert-reason-code`, `retire-reason-code`, `upsert-bill-cycle`, `retire-bill-cycle`, `set-wizard-defaults` (`accounts_config:EDIT`), all audited.
### 3.5 Repository bodies — `reason-code.repository`, `bill-cycle.repository` (list/upsert/retire; no delete).
### 3.6 Flows doc page — config-driven reference (§2.4).
### 3.7 Guardrail tests — **V9** `tests/accounts/v09-bill-cycle-integrity.integration.test.ts`: assigning a retired cycle to a new BAN rejected; retiring a cycle referenced by open BANs succeeds and removes it from the wizard's active options while existing BANs are unaffected; no delete path exists. **V10** `tests/accounts/v10-term-resolution.test.ts`: coalesce(override, default) both ways; changing cycle default or override after issuance doesn't move an issued doc's resolved term. Plus: a threshold change is audited and changes ac07 routing on the next post (integration — edit `GOODWILL_CREDIT` limit down, then a formerly-auto-post amount now routes to approval). Route × level: `accounts_config:EDIT`; USER blocked; flows doc viewable at `:READ`.

### 3.8 Explicitly NOT in this unit
No new doc operations. No period/close/export (ac14). No CoA/GL pages (ac12/ac13). No account closure (ac16). No `posting_nature`/`doc_type` free-rewrite of in-use reason codes (§2.1). No second-currency config beyond the ready MYR family (Q12). No stamped-due-date logic (Invoicing module — only the resolution/freeze property is tested here).

---

## 4. Dependencies (packages to install)
**None.** Reuses ac12 catalog-CRUD patterns + ac03/ac04 config + platform audit/`system_config`. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `app/(app)/administration/accounts-settings/**`, five config actions, three services, three schemas, extended `reason-code`/`bill-cycle` repositories, flows doc page, V9/V10 tests. No schema/migration/permission change.
- [ ] No delete path for `reason_code`/`bill_cycle`; all mutations audited; optimistic lock. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] **V9:** retire a cycle → gone from wizard, existing BANs unaffected, retired cycle rejected for new BANs, no delete path.
- [ ] **V10:** resolved term = coalesce(override, default); post-issuance changes don't move issued terms.
- [ ] Changing a reason-code threshold is audited and changes ac07 approval routing on the next post.
- [ ] Wizard defaults editable and read live by ac04; flows doc reflects live catalogs.
- [ ] Route × level: `accounts_config:EDIT` (flows doc at `:READ`); USER blocked.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac15` complete, "Next Up" → `ac16`.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (`/administration/accounts-settings`).

Any failing item means the unit isn't done. `ac16` (account closure gates) is the last feature unit — walking an account from live balances to closed using the operations ac07–ac11 and the settings this page governs.
