# bm67 — Posted invoices use the captured template

**Unit:** bm67 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** the posting transaction (`post-run.ts`, `stampPosted`) and its migration · **Depends on:** bm66
**Authorizes:** D12, D23, D33, D35, D55, D58 · Inv #4, #6, #41 (amended), #51 (posting half), #53 (closes it), #58 (posting half) · code-standards Phase 3 General rules 1, 3, Data rule 4 · architecture P1, P3 · guardrail items 57, 58, 60 · closes known-issues §19

## Goal

Make posting stamp each bill with the template versions captured for that BAN at run start, and the family, instead of resolving "current" inside the money transaction. Then a version activated mid-run cannot change a posted invoice. A BAN whose captured version is NULL is skipped before any INV is created.

## Design

**What posting reads.** `customerBillRepository.lockBillForPosting` already joins `bill_run_account` in the one row-locked read that returns the trial bill and `attemptCount` (~l.335–360). It now also returns the BAN's five run stamps: `refBillTemplateFamilyId`, `refBillTemplateVersionId`, `refInvoiceProfileVersion`, `refCsvTemplateVersionId`, `templateCapturedAt`. There is no second query and no extra lock.

**Order inside `postAccount`** (`services/billing/post-run.ts` ~l.251), with the new step marked:

1. `lockBillForPosting` (now with stamps).
2. Already posted (`refInvDocumentId`) → `skipped` (unchanged).
3. Zero-total → `SKIPPED` / `ZERO_TOTAL_NOT_INVOICED` (unchanged).
4. **New, D58:** if `templateCapturedAt` is set and `refBillTemplateVersionId` is NULL, call `billRunAccountRepository.updateStatus` with:
   - `status: "SKIPPED"`
   - `errorCode: "TEMPLATE_VERSION_NOT_FOUND"`
   - `errorDetail: "No invoice issued: this account's invoice template family had no active version when the run started. Activate a version in Invoice Settings and rerun the account."`
   - `expectedStatus: "PROCESSED"`

   Then return `skipped`. **No INV is created and no invoice number is used** (Inv #7). The bill is not finalized, so it can still be rerun before approval, and next period's run captures it again.
5. If `templateCapturedAt` is NULL (an account captured before bm65, which cannot exist on the fresh DB), throw `Error("postAccount: account … has no captured template stamps")`. This fails loud through the existing `POSTING_FAILED` path rather than resolving live. This branch is a guard, not a feature.
6. INV create, lines, `postDocument`, and `computeChargeChecksum` (unchanged).
7. **Changed:** `stampPosted(tx, …, { refInvDocumentId, postedAttempt, chargeChecksum, refBillFormatId: "INVOICE", refBillTemplateFamilyId, refBillTemplateVersionId, refInvoiceProfileVersion, refCsvTemplateVersionId })`, all copied from the run stamps. The call to `resolveVersionsForPosting(tx)` (~l.420) is deleted.
8. `INVOICED` (unchanged); render and store after commit (unchanged, D10).

The step-4 skip happens before the INV row exists, so Inv #4 (the finalization boundary) and Inv #6 (per-account transaction) are untouched.

**`resolveVersionsForPosting` is deleted** (`services/billing/invoice-template/resolve-template.ts` ~l.103), together with the `PostingVersionStamps` type if nothing else uses it; otherwise it narrows to `refBillFormatId`. Its import in `post-run.ts` (~l.14) goes. After this unit the only live resolutions are capture (bm65) and `preview-family` (bm66), which is guardrail item 57.

**Schema (migration `0052_customer_bill_template_family.sql`, new, additive):**
```sql
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_bill_template_family_id" text;
```
- Nullable, plain key, **no FK**: the `0029`/`0046` D6 posting-stamp rule on the partitioned `customer_bill`. Bills posted before this unit keep NULL. None exist on the fresh DB.
- It is written only by `stampPosted`, in the same `UPDATE` as `ref_inv_document_id`. The finalization guard (`0033`) then freezes it like every other stamp (Inv #41).
- Hand-written journal entry `idx 52`.

**Grants:** none. `billrun_runtime`'s `customer_bill` INSERT/UPDATE grants are column-scoped lists (`billrun-db-roles.sql` Step 5, ~l.120–135) that never included stamp columns, so the new column is app-only automatically. Only the Step 5 comment gets `ref_bill_template_family_id` added to its list of excluded stamps. `app_runtime` already has table-level DML on `customer_bill`.

**Retry-render and reprint are unchanged.** `retryRenderInvoice` (~l.139) and the stored-invoice route resolve from the bill's own stamps (`final` mode), and the CSV path uses `final` too (bm66 note). `PostedBillStamps` (`types/billing.ts`) gains `refBillTemplateFamilyId` for completeness. Resolution does not use it; the version id already pins the layout.

**Deliberately not done:** no UI change; the `SKIPPED` reason shows through the existing posting-progress and account surfaces (UI context §10d, the existing `AccountStatusBadge`). Distribution is unchanged: a SKIPPED account has no artifact, the same as a zero-total skip. No change to `billing_account`.

**Visible result:** in one run, trigger, then activate a new Standard version, then approve and post. Every posted bill's four version stamps equal its `bill_run_account` stamps, every stored PDF uses the captured version, and `customer_bill.ref_bill_template_family_id` = `BTF00000001`. With the NULL-stamp fixture, that BAN ends `SKIPPED` with `TEMPLATE_VERSION_NOT_FOUND`, holds no INV, and has no gap in the invoice-number sequence, while its sibling accounts post.

## Implementation

### 1. Migration `0052` and Drizzle mirror

- `db/migrations/0052_customer_bill_template_family.sql` (the `ALTER` above; the header cites bm67, D23 and the plain-key stamp rule); `_journal.json` entry `idx 52`.
- `db/schema/billing/customer-bill.ts`: `refBillTemplateFamilyId: text("ref_bill_template_family_id")`, placed with the other reserved stamp columns (~l.78) and with the same comment style.
- `db/bootstrap/billrun-db-roles.sql`: update the Step 5 comment only. No grant statement changes.

### 2. Repository

`db/repositories/billing/customer-bill.repository.ts`:
- `lockBillForPosting`: add the five `billRunAccount` stamp columns to the select, and widen the return type.
- `stampPosted`: the `data` parameter becomes `{ refInvDocumentId; postedAttempt; chargeChecksum; refBillFormatId: "INVOICE"; refBillTemplateFamilyId: string; refBillTemplateVersionId: string; refInvoiceProfileVersion: number | null; refCsvTemplateVersionId: string }`, and `.set` adds `refBillTemplateFamilyId`. The version id is non-null by type: step 4 guarantees it.
- `findForAccount` / `readBillStamps` (`invoice-render-input.ts`): add `refBillTemplateFamilyId` to the returned `PostedBillStamps`.

### 3. Service

`services/billing/post-run.ts`:
- Add steps 4 and 5 after the zero-total block (~l.343), mirroring its comment style and citing D58 / Inv #58 / Inv #7.
- Replace `const versions = await resolveVersionsForPosting(tx);` and `...versions` with the explicit stamp fields from `bill`.
- Remove the import.

### 4. Resolver cleanup

`services/billing/invoice-template/resolve-template.ts`: delete `resolveVersionsForPosting` and the `posting (bm54)` line in the header comment. Note in the comment that posting copies the run stamps (Inv #41 amended). If `currentVersions` is now used only by `resolveCurrentVersionsForFamily`, fold it in.

### 5. Guardrail item 57 and pinning tests

- New `tests/guardrails/no-live-template-resolution.test.ts`, a static-source test in the cm22 file's style:
  - scans **comment-stripped** code (the cm22 file's `stripComments`), so a historical doc comment is not a call. `services/accounts/resolve-ban-template-label.ts` keeps a comment naming the deleted function, and D46 forbids touching Customer Management files;
  - fails if `resolveVersionsForPosting` appears in code anywhere under `services/`, `db/` or `app/`;
  - fails if `post-run.ts`, `render-invoice-template.ts`, `invoice-csv.ts` or the `draft-invoice` route contains `"preview-family"` or imports `resolveCurrentVersionsForFamily`;
  - asserts no file other than `capture-template-stamps.ts` and `preview.ts` imports `resolveCurrentVersionsForFamily`, and that `capture-template-stamps.ts` does. `preview.ts` reaches the live resolver through `resolveTemplate`'s `preview-family` case rather than importing it;
  - asserts `preview.ts` is the only file that builds a `preview-family` mode (code-standards Phase 3 TS rule 1).

  > **Corrected 2026-10-16.** The bm66 spec first had `render-invoice-template.ts` build the `preview-family` mode for the editor override, which the second bullet forbids. bm66 is corrected: the override carries the mode `preview.ts` built. The checklist's `grep -rn resolveVersionsForPosting services db app` still finds the one Customer Management comment above; the guardrail is the authority.
- `tests/guardrails/invoice-version-pinning.integration.test.ts` (guardrail 46): rewrite the posting half:
  1. trigger (capture v2, profile v1);
  2. activate generated v3 and profile v2;
  3. approve and post;
  4. assert the bill's stamps are v2/v1 plus `BTF00000001`, equal to `bill_run_account`, and that the stored PDF was rendered from v2.

  A second run triggered after the activation posts with v3/v2.
- New `tests/db/posting-skips-null-template.integration.test.ts` (guardrail item 60, posting half):
  - the bm65 NULL-stamp fixture through approve and post;
  - that account ends `SKIPPED` with `TEMPLATE_VERSION_NOT_FOUND`, has no `billing.document` row, and its `customer_bill.ref_inv_document_id` is NULL;
  - the INV sequence has no gap; siblings are `INVOICED`;
  - the run reaches `INVOICED`.
- `tests/db/customer-bill-stamps.integration.test.ts`: `ref_bill_template_family_id` is stamped in the same UPDATE, and a later UPDATE is refused by `0033`.
- `tests/db/customer-bill-schema.test.ts`: the new column is nullable with no FK.
- `tests/guardrails/customer-accounts-binding-boundaries.test.ts`: `post-run.ts` still never reads the BAN template reference (the bm65 assertion), unchanged.

## Dependencies

- **Packages:** none.
- **Units:** bm66, which moved every other caller off live resolution so `resolveVersionsForPosting` can be deleted here.
- **Environment:** a fresh database per the bm64 runbook.

## Verification checklist

- [ ] `0052` applies after `0051`; journal entry `idx 52`; no existing migration edited.
- [ ] `grep -rn resolveVersionsForPosting services db app` returns nothing. Guardrail item 57 is green.
- [ ] Guardrail item 58 (freeze end to end) and item 60 (NULL stamp: draft throws, posting skips, rerun recovers) are green.
- [ ] Guardrail 46 is rewritten as above and green. Guardrails 43–45, 47 and 55 are green.
- [ ] A skipped NULL-stamp account consumes no invoice number (Inv #7); the run reaches `INVOICED`; distribution completes without it.
- [ ] Grants over `information_schema`: `billrun_runtime` has no INSERT or UPDATE on `customer_bill.ref_bill_template_family_id`.
- [ ] The cm22 guardrail still passes; `post-run.ts` never reads `billing_account.ref_bill_template_version_id`.
- [ ] `npm run typecheck`, `npm run lint`, and the unit and integration suites are green.
- [ ] Docs:
  - known-issues §19 closed;
  - architecture Inv #41 amendment and Inv #51/#53/#58 marked "built (bm67)";
  - code-standards guardrail items 57, 58 and 60 marked "built (bm67)";
  - progress tracker updated.

## Open questions

None that need a decision. One note: the step-4 skip message (`errorDetail`) is proposed wording in the same voice as the existing `ZERO_TOTAL_NOT_INVOICED` text. It surfaces on the run's account rows, so RevOps may want to tune it.
