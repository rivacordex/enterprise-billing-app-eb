# Progress Tracker

Update this file after every meaningful implementation change.

_Completed phases are archived in `custmgmt-completed-tracker.md` (commit tables,
per-unit notes, deviations, verification). Full history:
`git log -- context/customer-management/custmgmt-progress-tracker.md`; unit plan:
`context/customer-management/specs/cm00-build-plan.md`; per-unit detail:
`context/customer-management/specs/cm*.md`._

## Current state (2026-10-14)

- **Phase 1 (cm01–cm16, v1 full CRUD) — COMPLETED**, ship-gated at cm16 (`8d80e6c`).
- **Phase 2 (cm17–cm22, Invoice Template Binding update) — COMPLETED** 2026-10-14,
  ship-gated at cm22 (`e46ee32`, guardrail tightening `a3f2923`). All six units
  committed with review fixes; full unit and integration suites green apart from the
  reported baseline failures below.
- **No phase in progress.** Phase 3 (template catalog selection; posting reads the
  BAN binding) is not yet scoped.

| Phase | Units     | Status    | Ship gate |
| ----- | --------- | --------- | --------- |
| 1     | cm01–cm16 | Completed | `8d80e6c` |
| 2     | cm17–cm22 | Completed | `e46ee32` |

## Carried forward (not blocking)

- **Binding plan §11 matrix.** The source plan (`_updatemodule-…-binding-plan.md`)
  is not in the repo, so §11 could not be checked row by row and §12 O1/O3/O4 were
  closed in `custmgmt-architecture.md` / workflow rules §9.5 instead.
- **Template label format (cm20).** The label joins the *layout* code with the
  *generated* version number (e.g. "INVTPL-STD-A4 v2"), which can name a layout
  version that does not exist — in tension with Inv. #18. Kept as the spec mandates;
  decide the wording before Phase 3.
- **`EDIT_DISABLED_TITLE` copy (cm21).** Reads "accounts configuration edit access"
  but the panel gates on `accounts_transactions`; used unchanged per spec.
- **Baseline test failures** (billmgmt known-issues §21, fix as their own change):
  7 unit files fail to load without env (`lib/config`); `ratecard-parse-csv` and
  `pricing-component-guardrails` #31 time out because their repo scans walk the stale
  `.claude/worktrees/` copies (skip `.claude` or remove the worktrees).
- **Cleanup candidates (cm19/cm20 reviews):** fourth verbatim copy of the tab-strip
  markup; shared positive-int config parser (4 copies); one shared account-state chip
  with Accounts Overview; structured template label instead of the card's regex split;
  unused reads in `getFinancialAccountDetail` and serial `findActive` → `findDefault`;
  redundant BAN re-sort.
- **cm22 guardrail check 4** can approach its 30 s timeout under heavy machine load.

## Key decisions (durable)

- **Tracker split.** `custmgmt-completed-tracker.md` archives completed phases; this
  file is the live tracker every spec's checklist refers to (same split as billing).
- Phase 2 column/FK/index decisions are recorded in `custmgmt-completed-tracker.md`
  (Phase 2 key decisions) and `custmgmt-architecture.md` §7.

## Open questions

- None blocking. See *Carried forward*.
