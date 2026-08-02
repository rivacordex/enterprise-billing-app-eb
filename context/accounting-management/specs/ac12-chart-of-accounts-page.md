# AC12 — Chart of Accounts Page: Tree, Code Detail + Where-Used, Mapping CRUD, Unmapped Health Panel

- **Unit:** 12 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac03` (seeded CoA + mappings — the page edits these; `gl_resolution_view` for the health panel). `ac05` (nav section shell, page chrome, route-guard pattern). `ac02` (`gl_account`/`gl_mapping` tables + repository skeletons; `gl_resolution_view`).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Ledger & GL* ("Chart of Accounts mastered in-module; role/name mapping rules; unmapped-account health check"), *Pages & access* ("Chart of Accounts"); `acctmgmt-architecture.md` §4 (`accounts-config` grants Chart of Accounts), §6 Module Inv. **#10** (GL resolution total, 0 unmapped — the health panel surfaces **V5**), **#11** (catalogs retire never delete); `acctmgmt-code-standards.md` §2.5 (catalog optimistic lock), §8 (permission map — `accounts_config : READ`/`EDIT`); `acctmgmt-ui-context.md` §2 (catalog active/retired badges); **Locked UI direction item 6** (manual GL-code naming/mapping); decisions **Q26** (CoA mastered here), Q19 (mappings resolve by role/name, no reason-code selector). Plan Part B **P4** (CoA tree, GL code detail + where-used, mapping rules grid, health panel — "the page's most important pixel"), **F5** (mapping maintenance — orphaning saves blocked with affected list), §4 verification step **5** (0 unmapped).
- **Note on codebase verification:** planning-folder-only session. Confirm the `accounts_config` permission migration + grant pattern (mirror `ac05`'s `accounts_view` and `cm01`'s seed grants — `MANAGER → accounts_config:EDIT`; USER gets no config access).

---

## 1. Goal

Add `/accounts/chart-of-accounts` (permission `accounts_config`) — a CoA tree over `gl_account` (class + normal-balance badges, postable/summary distinction, retired greyed), a GL-code detail panel with where-used (which mapping rules target the code), `gl_mapping` CRUD (add/edit/retire mapping rules; add/retire GL codes — never delete, Inv. #11), and a header **unmapped-account health panel** that live-counts unresolved pgledger accounts (V5) and renders red with a drill-down when non-zero — and land the `accounts_config` permission migration. Done when editing a mapping re-evaluates the health panel instantly, a save that would orphan accounts (drop resolution to a non-zero unmapped count) is blocked with the affected-account list, and a code with posted journal history can be retired but never deleted.

## 2. Design

First `accounts_config` page; config-grade CRUD guarded so GL errors (the costliest kind) can't silently corrupt the export. Boundary: **`app/(app)/accounts/chart-of-accounts/**`, `actions/accounts/{create-gl-code,retire-gl-code,upsert-gl-mapping,retire-gl-mapping}.action.ts`, `services/accounts/{gl-account,gl-mapping,gl-health}.ts`, `validation/accounts/{gl-account,gl-mapping}.schema.ts`, the `gl-account`/`gl-mapping` repository bodies (extend), the `accounts_config` permission migration + wiring**.

### 2.1 CoA tree (P4.1, Inv. #11)

`gl_account` rendered as a hierarchy via `parent_gl_code` (Current Assets → Cash Clearing / Accounts Receivable …). Each node shows `account_class` + `normal_balance` badges and a postable/summary indicator (`is_postable`); `retired` nodes are greyed (catalog active/retired badge, ui-context §2). Mono `gl_code`. Selecting a node populates the detail panel.

### 2.2 GL-code detail + where-used (P4.2)

Selected code's fields + **where-used**: the `gl_mapping` rules whose `ref_gl_code` targets it (so an operator sees "GL 1200 is the target of the `receivables` role rule" before changing anything). This is what makes orphan-prevention legible.

### 2.3 Mapping CRUD (P4.3) + orphan-blocking (F5, Inv. #10)

`gl_mapping` grid: `selector_type` (`ledger_role`/`system_account`), `selector`, `currency`, target `gl_code`. Add/edit a rule; add/retire a GL code. **The load-bearing guard (F5):** before committing any mapping/code change, the service re-evaluates `gl_resolution_view`'s unmapped count **as it would be after the change** (in-transaction, dry-run against a computed resolution); if the change would raise the unmapped count above 0 (orphan an account) or point a mapping at a non-`is_postable` code, the save is **blocked** with the affected-account list — never a warning-and-proceed. Editing a mapping to a valid postable code re-evaluates the health panel to still-0 and commits. Optimistic lock on the edited row (`last_modified`, code-standards §2.5).

### 2.4 Unmapped health panel (P4.4 — V5)

Header strip live-counting `select count(*) from gl_resolution_view where gl_code is null` per currency. **0 = green; non-zero = red** with a drill-down list of the unresolved pgledger accounts — "the page's most important pixel," because one unmapped account silently corrupts the eventual export (ac14). Live read on every load (`force-dynamic`); never cached. The same count is what F5's orphan-block computes prospectively.

### 2.5 Retire, never delete (Inv. #11)

No DELETE path for `gl_account` or `gl_mapping`. A GL code referenced by history moves to `retired` (removed from selection, kept in joins); a mapping rule is retired/replaced, not deleted. The repository exposes no delete function (code-standards §1.3).

### 2.6 `accounts_config` permission (code-standards §8)

Migration + typed constant + grants. `accounts_config:READ` = view CoA/GL Journal + drill-down; `:EDIT` = edit codes/mappings, period close (ac14), export (ac14), Accounts Settings (ac15). Seed grants: **`MANAGER → accounts_config:EDIT`**; USER gets **no** `accounts_config` grant (finance-config is manager/finance-holder only, architecture §4). Route × level seeds ac17's matrix.

### 2.7 Structural decisions

- Read services (`gl-account` tree, `gl-mapping` list, `gl-health` count) + config mutation services; pages orchestrate; repositories are the only `gl_*`/`gl_resolution_view` callers.
- The orphan-block is a **service-layer invariant** (code-standards §1.7) computed in the mutation transaction — never left to operator discipline.
- No AI/marketing tokens (ui-context §5); dense admin chrome.

---

## 3. Implementation
### 3.1 Route + nav — append Chart of Accounts to Accounts nav; `/accounts/chart-of-accounts/page.tsx` `force-dynamic`, guarded `accounts_config:READ`.
### 3.2 Services — `gl-account.ts` (tree, create, retire), `gl-mapping.ts` (list, upsert, retire — with the F5 prospective-orphan check), `gl-health.ts` (unmapped count + drill-down).
### 3.3 Validation — `gl-account.schema.ts` (code natural key, class, normal_balance, parent, is_postable), `gl-mapping.schema.ts` (selector_type, selector, currency, ref_gl_code; target must be postable).
### 3.4 Actions — `create-gl-code`, `retire-gl-code`, `upsert-gl-mapping`, `retire-gl-mapping` (`accounts_config:EDIT`), each with the orphan-block/postable-target check server-side.
### 3.5 Repository bodies — `gl-account.repository` (tree read, insert, retire), `gl-mapping.repository` (list, upsert, retire), `gl-health` count via `gl_resolution_view`.
### 3.6 Permission migration + wiring (§2.6).
### 3.7 Guardrail tests
- **V5 (health panel):** 0 unmapped after seeds; retiring/adding a mapping that would orphan an account is blocked with the affected list and the count never goes non-zero on a committed change; a mapping targeting a summary (non-postable) code is rejected.
- Retire-not-delete: no delete path; a code with history retires and disappears from selection but stays in resolution joins.
- Edit a mapping to a valid postable code → health re-evaluates to 0, commits; optimistic-lock conflict on concurrent edit.
- Route × level: `accounts_config:READ` to view, `:EDIT` to mutate; a USER (no `accounts_config`) blocked.

### 3.8 Explicitly NOT in this unit
No GL Journal page (ac13). No period close/CSV export (ac14). No Accounts Settings reason-code/bill-cycle CRUD (ac15). No new pgledger accounts (CoA is GL config, not ledger accounts). No reason-code selector on mappings (Q19 — mappings are role/name only).

---

## 4. Dependencies (packages to install)
**None.** Reuses ac05 chrome + ac02/ac03 tables/views. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `app/(app)/accounts/chart-of-accounts/**`, four config actions, three services, two schemas, extended `gl-account`/`gl-mapping` repositories, `accounts_config` migration + wiring + grant, nav entry, tests.
- [ ] No delete path for `gl_account`/`gl_mapping`; `force-dynamic`; no AI/gradient tokens. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green; permission-count assertions +1.

**Behavior — the point of the unit**
- [ ] Health panel shows 0 unmapped (green); editing a mapping re-evaluates instantly.
- [ ] A save that would orphan an account (or target a non-postable code) is **blocked** with the affected list — never proceeds.
- [ ] A code with history retires, never deletes; disappears from selection, stays in joins.
- [ ] Route × level: `accounts_config` READ/EDIT enforced; USER blocked.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac12` complete, "Next Up" → `ac13`.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (`/accounts/chart-of-accounts` + four actions).

Any failing item means the unit isn't done. `ac13` (GL Journal page) reads the same `gl_resolution_view`/`gl_journal_view` this page keeps healthy — a 0-unmapped CoA is the precondition for a balanced journal.
