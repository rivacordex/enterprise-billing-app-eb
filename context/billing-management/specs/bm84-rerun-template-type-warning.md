# bm84 — Rerun warns when a BAN's type changed since run start

**Unit:** bm84 (Invoice Template Types · Part 6, unit 11 of 12). **Boundary:** BILL-RUN: `rerun-run.ts` (an extracted eligibility helper only), a new read service and read action, `billRunAccountRepository.listForRerun`, `RerunDialog`, and their tests. **Specs from:** `billmgmt-project-overview.md` › Invoice Template Types › Core user flow step 13 and Features › Rerun warning; `billmgmt-architecture.md` Inv #52 (rerun re-captures) and #66 ("a binding or a switch never touches `bill_run_account` stamps; it applies from the next run start or rerun"); `billmgmt-code-standards.md` › Invoice Template Types; CM `custmgmt-code-standards.md` guardrail 11 (the one sanctioned reader of the BAN type column); `bm00-build-plan.md` Part 6, unit 84. **Model file:** `components/billing/rerun-dialog.tsx` (the inline confirm this unit extends).

> **Framing.** A run captures each BAN's type and versions at run start (bm65), and a rerun re-captures them for the rerun BANs (Inv #52). After cm23 and bm83, a BAN's type can change mid-run: RevOps rebinds it, or a retire switches it. A rerun then silently moves that BAN's draft to another type. bm84 makes this visible **before** the rerun is confirmed. When the inline confirm opens, it lists each BAN in the rerun scope whose current type differs from its run-start stamp: "Invoice template type changed since run start: Wholesale → Standard". The warning doesn't block, and the rerun itself is unchanged: it already re-captures.

## Goal

After Wholesale is retired to Standard mid-run:
- opening **Rerun** for BAN A shows the warning line for BAN A, and confirming re-captures it, so its new draft renders on Standard
- BANs whose type didn't change show nothing
- a rerun with no changed BAN looks exactly as it does today

## Design

**Structural decisions**

- **D1: The warning's scope is the rerun's scope, computed by the same code.** The eligibility rule in `rerunRun` moves verbatim into an exported helper, `selectRerunEligible(accounts, postedIds, accountIds)`, which both the rerun and the new read call. The rule: every scoped account, minus `EXCLUDED` and posted, intersected with the selection, where empty means all. The dialog therefore never warns about a BAN the rerun won't touch, and never misses one it will.
- **D2: "Changed" compares families, through the sanctioned reader.**
  - **The comparison:** the run-start stamp is `bill_run_account.ref_bill_template_family_id`, now returned by `listForRerun`. The current type is `billRunAccountRepository.listBanFamilies(db, banIds)`, the same function the re-capture will call, which resolves NULL to Standard.
  - **When it warns:** only when the stamp is non-NULL and differs from the current family.
  - **A NULL stamp** (a run triggered before bm65, or a BAN with no default family) isn't a "change". The rerun simply captures it.
  - **The column:** reading the BAN column through `listBanFamilies` keeps CM guardrail 11's single-reader rule.
- **D3: Names come from the type rows.** For example "Wholesale → Standard", using `bill_template_family.name`. A retired source type still has its name, because rows are never deleted. Standard shows its stored name, "Standard".
- **D4: Read on open, never cached.**
  - **When:** the confirm step calls `listRerunTemplateChangesAction({ billRunId, accountIds })` when it opens, and shows the lines while the manager types the reason. Nothing is persisted.
  - **The guard:** the read action is guarded like the rerun itself (`billrun_operate : EDIT`), since only the rerun confirm uses it.
  - **Failures:** a failure of the read shows nothing, and it never blocks the rerun. The rerun's own audit already lists the re-captured stamps (bm65).
- **D5: Styling.** It uses the existing Warning family (`--color-warning-50` / `--color-warning-700`, `AlertTriangle` icon), a callout inside the inline confirm, one line per BAN with the BAN id in mono, under the heading "Invoice template type changed since run start". There is no new token. Over 10 lines, the first 10 are shown, with "and {n} more".

## Implementation

### 1. `db/repositories/billing/bill-run-account.repository.ts` (changed)

`listForRerun`'s selected columns and its return type gain `refBillTemplateFamilyId` (the run-start stamp, `bill_run_account.ref_bill_template_family_id`). Its callers ignore the extra field. `listBanFamilies` is unchanged (bm82).

### 2. `services/billing/rerun-run.ts` (refactor only)

```ts
// bm84 (D1) — the rerun's eligible set: every scoped account, minus EXCLUDED and posted,
// intersected with the selection (empty ⇒ all). Shared with the rerun warning read so the
// two can never disagree.
export function selectRerunEligible<T extends { billingAccountId: string; status: string }>(
  accounts: T[], postedIds: string[], accountIds: string[],
): T[]
```

The body is the current filter at L112–119, moved verbatim. `rerunRun` calls it, and nothing else changes: the order, the audit and the re-capture are as they are today.

### 3. Read: `services/billing/read/list-rerun-template-changes.ts` (new)

```ts
export interface RerunTemplateChange {
  billingAccountId: string; fromTypeName: string; toTypeName: string;
}

// bm84 — the BANs in the rerun scope whose current type differs from their run-start stamp.
// Read-only; never cached. Reads the BAN type column only via listBanFamilies (CM guardrail 11).
export async function listRerunTemplateChanges(
  billRunId: string, accountIds: string[],
): Promise<RerunTemplateChange[]>
```

1. `[accounts, postedIds] = Promise.all([billRunAccountRepository.listForRerun(db, billRunId), customerBillRepository.listPostedAccountIds(db, billRunId)])`, then `eligible = selectRerunEligible(…)`.
2. `current = billRunAccountRepository.listBanFamilies(db, eligible.map(a => a.billingAccountId))`.
3. `changed = eligible.filter(a => a.refBillTemplateFamilyId !== null && a.refBillTemplateFamilyId !== currentFamily(a))`.
4. Names: `billTemplateFamilyRepository.listAll(db)` (bm77), mapped by id. A NULL current family (no default; impossible after `0046`) reads "—".
5. Return the changes sorted by `billingAccountId`.

The run status isn't checked here. The rerun's own `NOT_RERUNNABLE` remains the authority.

### 4. Action: `actions/billing/list-rerun-template-changes.action.ts` (new)

1. `requirePermission(BILLRUN_OPERATE, EDIT)`; a redirect → `FORBIDDEN`.
2. Zod `listRerunTemplateChangesSchema = rerunRunSchema.pick({ billRunId: true, accountIds: true })`, so it has the same BAN-id regex, the same 5,000 cap and the same empty-means-all default.
3. The service.
4. A thrown error → `logger.warn` → `{ ok: false, code: "SERVER_ERROR" }`.

The result is `{ ok: true; changes: RerunTemplateChange[] } | { ok: false; code }`.

### 5. `components/billing/rerun-dialog.tsx` (changed)

- **State:** `templateChanges: RerunTemplateChange[] | null`. When `confirming` becomes true, it calls the action once (`accountIds` as passed), and stores `changes` on `ok`. On failure it stays `null`.
- **The callout:** when `templateChanges?.length`, a Warning callout renders between the scope sentence and the stage selector:
  - **Heading:** "Invoice template type changed since run start"
  - **One `<li>` per BAN:** `<mono>{billingAccountId}</mono>: {fromTypeName} → {toTypeName}`
  - **More than 10:** the first 10, then "and {n} more"
  - **A caption:** "The rerun uses each account's current type."
- **Unchanged:** the confirm button, the reason, the stages and the errors. The warning never disables Confirm.
- **A new header comment line:** "bm84: the template-type warning (read on open; advisory)".

### 6. Tests

**New:**
- **`tests/services/billing/read/list-rerun-template-changes.test.ts`** (mocked repositories):
  - only eligible BANs, so `EXCLUDED`, posted and unselected BANs are ignored
  - a changed family gives one row with both names
  - an unchanged family, or a NULL stamp, gives no row
  - a retired source type still names it
  - the result is sorted
- **`tests/db/rerun-template-change.integration.test.ts`** (DB-gated; types through `tests/db/helpers/template-type-db-harness.ts` and the activate service, cm23 bind, bm83 retire):
  1. Wholesale with BAN A bound, and BAN B NULL. Trigger a run, so A is stamped Wholesale and B Standard.
  2. Retire Wholesale to Standard.
  3. `listRerunTemplateChanges(run, [])` returns exactly `[{ BAN A, "Wholesale" → "Standard" }]`.
  4. `rerunRun` for BAN A re-stamps it to Standard's family and current version, and its draft renders on Standard.
  5. A second `listRerunTemplateChanges` returns `[]`.
- **`tests/actions/billing/list-rerun-template-changes.action.test.ts`:** guard first (without `billrun_operate : EDIT` → `FORBIDDEN`, service not called), Zod, mapping.

**Changed:**
- **`tests/services/billing/rerun-run.service.test.ts`:** `selectRerunEligible`'s cases, which are the current eligibility cases moved to the helper, plus a parity assertion that `rerunRun`'s `accountCount` equals `selectRerunEligible(…).length` for the same fixture.
- **`tests/components/billing/rerun-dialog.test.tsx`:**
  - the action is called once on opening the confirm
  - with changes, the Warning callout lists them (mono id, "from → to"), with "and {n} more" above 10
  - with none, or on failure, there is no callout
  - Confirm stays enabled
  - the existing cases are green
- **`tests/guardrails/customer-accounts-binding-boundaries.test.ts`:** unchanged. The new read reaches the BAN column only through `listBanFamilies`, and its file contains no `ref_bill_template_family_id` paired with `billing_account` (it reads the `bill_run_account` stamp field).

## Dependencies

- **bm82:** `listBanFamilies` on the type column.
- **bm83:** retire, for the visible-result case.
- **cm23:** binding.
- **bm77:** `billTemplateFamilyRepository.listAll`.
- **Environment:** a disposable Postgres. Azurite for the draft-render step.

## Verification checklist

- [ ] After Wholesale is retired to Standard mid-run, rerunning BAN A shows "Invoice template type changed since run start: Wholesale → Standard", and its new draft renders on Standard.
- [ ] BANs whose type didn't change, BANs outside the rerun scope, and BANs with no run-start stamp show nothing.
- [ ] The warning uses the same eligible set as the rerun (one shared helper), and never blocks Confirm.
- [ ] The BAN type column is read only through `listBanFamilies` (CM guardrail 11 green).
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The rerun, capture and dialog suites are green.
- [ ] Docs: the overview's Rerun warning marked built in `billmgmt-progress-tracker.md`, and the bm84 row recorded.
