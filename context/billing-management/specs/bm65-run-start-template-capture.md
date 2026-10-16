# bm65 — Template captured at run start and on rerun

**Unit:** bm65 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** the bill-run trigger and rerun services, with their repository and migration · **Depends on:** bm64
**Authorizes:** D10, D12, D13, D23, D35 (with the 2026-10-15 trigger-audit extension), D46, D55 · Inv #51 (capture half), #52, #54, #58 (capture half) · code-standards Phase 3 General rules 2–5, TS rule 2, Data rules 4–5 · guardrail item 59, the capture half of item 60

## Goal

When RevOps triggers a run, record on every non-EXCLUDED `bill_run_account` row which template family and versions that BAN will be invoiced with: family, generated version, invoice profile version, CSV version and capture time. A rerun re-records them for exactly the rerun BANs. Both audit rows list what was captured.

## Design

**Where capture runs.** Both paths already do all their work in one transaction that also triggers the engine. Capture runs inside it, **before** the engine is triggered, so the flow never starts on an uncaptured account and an engine failure rolls the stamps back with everything else.
- `trigger-run.ts`: right after `billRunAccountRepository.insertSnapshot(tx, snapshotRows)` (~l.133), before `engineRegistry.trigger`. The `BILL_RUN_TRIGGERED` audit (~l.170) is written afterwards and carries the stamps.
- `rerun-run.ts`: right after the eligible set (`banIds`) is computed and **before** the `BILL_RUN_RERUN` audit insert (~l.118). The audit then carries the stamps, and "audit before re-trigger" still holds.

**What gets captured for each BAN.**
- **Family:**
  - `billing_account.ref_bill_template_version_id` NULL → the default family (`bill_template_family.is_default`);
  - non-NULL → that version's `ref_bill_template_family_id` (follow-the-line, matching `0050`'s column comment).

  Today every BAN is NULL (`assertBindableTemplate` accepts NULL only), so every BAN gets Standard.
- **Generated version:** the family's non-default ACTIVE `generated` version, else its default version. A family with neither (only a non-default family can be in that state) gets **NULL**, with no throw and no EXCLUDED (D55, Inv #58). The render and posting units (bm66, bm67) act on the NULL.
- **Profile version:** the ACTIVE `invoice.profile` `config_version`, else NULL (G15 A, unchanged).
- **CSV version:** the non-default ACTIVE `csv` version, else the default.
- **`template_captured_at`:** `now()` (transaction time).
- **EXCLUDED rows:** all five columns stay NULL. A rerun never selects EXCLUDED rows (`rerun-run.ts` ~l.105), so they are never captured.

**One resolver (D33).** "Current" stays defined in exactly one place, `services/billing/invoice-template/resolve-template.ts`. bm65 adds one export, `resolveCurrentVersionsForFamily(db, familyId)`, built from the existing private helpers. It returns `{ generated: BillTemplateVersion | null, csv: BillTemplateVersion, profileVersion: number | null }`:
- `generated`: the family's non-default ACTIVE, else the family's default, else `null` (no throw);
- `csv` and `profileVersion`: from the existing `currentVersion(db, "csv")` and `invoiceProfileRepository.findActiveVersion(db)`.

The existing `draft` mode and `resolveVersionsForPosting` stay untouched in this unit (bm66 and bm67 change them).

**Set-based, not a loop.**
1. One SELECT returns `{ banId, familyId }` for every BAN in the call.
2. The service resolves current versions once per **distinct** family (one family today).
3. One UPDATE writes all rows from parallel `unnest` arrays.

No per-BAN statement.

**Schema (migration `0051_bill_run_account_template_stamps.sql`, new, additive).**
```sql
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_bill_template_family_id" text;
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_bill_template_version_id" text;
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_invoice_profile_version" integer;
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_csv_template_version_id" text;
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "template_captured_at" timestamptz;
```
- Nullable, plain keys, **no FK**. This follows the posting-stamp precedent on the partitioned `customer_bill` (`0029`, `0046` D6: "nullable, no FK, the plain-key stamp rule"). The catalog rows they point at are guard-protected from DELETE (bm50).
- `ALTER TABLE` on the partitioned parent propagates to every pg_partman partition.
- A hand-written journal entry `0051`, like `0047`–`0050`.

**Grants:** none. `app_runtime` already has table-level DML on `bill_run_account`. `billrun_runtime` keeps table-level SELECT (`billrun-db-roles.sql` ~l.322) and the explicit write REVOKE (~l.350), so the flow may read the stamps but never write them.

**The cm22 guardrail is narrowed, not removed.**
- `tests/guardrails/customer-accounts-binding-boundaries.test.ts` ("posting never reads the billing_account template reference", ~l.286) today fails on any read of `billing_account.ref_bill_template_version_id` under `services/billing/` or `db/repositories/billing/`.
- Its own source comment (`assert-bindable-template.ts`) calls that a Phase 3 tripwire.
- bm65 adds **one** named exemption, `db/repositories/billing/bill-run-account.repository.ts` (the capture SELECT), with a comment citing Inv #54.
- Posting files (`post-run.ts`, `customer-bill.repository.ts`, `invoice-render-input.ts`) stay held to "never reads".
- This is a test change only: no Customer Management production file is touched (D46).

**Audit `afterData`** (no new event type):
- `BILL_RUN_TRIGGERED`: `{ banCount, excludedCount, executionId, templateStamps: Array<{ banId, familyId, versionId }> }`.
- `BILL_RUN_RERUN`: `{ accounts, fromStage, attempt, reason, templateStamps: Array<{ banId, familyId, versionId }> }`.

`versionId` may be `null` (D55).

**Deliberately not done:** no reader of the stamps yet (bm66 drafts, bm67 posting); no UI; no change to `billing_account` or any Customer Management production file; no flow change.

**Visible result:** after **Run**, every non-EXCLUDED account row carries `BTF00000001` and `BTV00000002` (or the latest activated Standard version), the profile and CSV versions and a capture time, and the Audit tab's trigger row lists them. Activate a new Standard version, then rerun one BAN: only that BAN's stamps change, and the rerun audit row lists it.

## Implementation

### 1. Migration `0051` and Drizzle mirror

- `db/migrations/0051_bill_run_account_template_stamps.sql` with the five `ALTER TABLE` statements above, separated by `--> statement-breakpoint`. A header cites bm65, D35 and the plain-key stamp rule.
- `db/migrations/meta/_journal.json`: append entry `idx 51`, tag `0051_bill_run_account_template_stamps`, following the `0050` entry's shape.
- `db/schema/billing/bill-run-account.ts`: add `refBillTemplateFamilyId: text("ref_bill_template_family_id")`, `refBillTemplateVersionId: text("ref_bill_template_version_id")`, `refInvoiceProfileVersion: integer("ref_invoice_profile_version")`, `refCsvTemplateVersionId: text("ref_csv_template_version_id")`, `templateCapturedAt: timestamp("template_captured_at", { withTimezone: true, precision: 3, mode: "date" })`. Precision follows the file's existing `lastProcessedAt`.

### 2. Types

`types/billing.ts`:
```ts
export type RunTemplateStamps = Pick<
  typeof billRunAccount.$inferSelect,
  "refBillTemplateFamilyId" | "refBillTemplateVersionId" | "refInvoiceProfileVersion" | "refCsvTemplateVersionId"
>;
export type CapturedTemplateStamp = { banId: string; familyId: string; versionId: string | null };
```

### 3. Resolver export

`services/billing/invoice-template/resolve-template.ts`: add `resolveCurrentVersionsForFamily(db, familyId)` as described in Design. It needs family-scoped reads on `billTemplateVersionRepository`: add `findActiveInFamily(db, { familyId })` (non-default ACTIVE `generated` in the family; at most one, by `btv_one_active_family_uq`) and `findDefaultInFamily(db, { familyId })`. Comment: "the only live resolution on a run path, run at capture (Inv #51, #53)".

### 4. Repository

`db/repositories/billing/bill-run-account.repository.ts`:
- `listBanFamilies(tx, banIds): Promise<{ banId: string; familyId: string }[]>`:

  ```sql
  SELECT ba.billing_account_id AS ban_id,
         COALESCE(btv.ref_bill_template_family_id, dft.bill_template_family_id) AS family_id
  FROM billing.billing_account ba
  LEFT JOIN billing.bill_template_version btv ON btv.bill_template_version_id = ba.ref_bill_template_version_id
  CROSS JOIN (SELECT bill_template_family_id FROM billing.bill_template_family WHERE is_default) dft
  WHERE ba.billing_account_id = ANY($banIds)
  ```

  Comment: "the one sanctioned billing read of the BAN template reference (Inv #54, D46)".
- `captureTemplateStamps(tx, billRunId, rows: { banId; familyId; versionId: string | null }[], shared: { profileVersion: number | null; csvVersionId: string }): Promise<void>`. One UPDATE … FROM `unnest($banIds::text[], $familyIds::text[], $versionIds::text[])`, setting the five columns with `template_captured_at = now()`, `WHERE ref_bill_run_id = $billRunId AND ref_billing_account_id = u.ban_id AND status <> 'EXCLUDED'`.
- `readStamps(tx, billRunId, banId): Promise<RunTemplateStamps | null>`, for bm66/bm67 and the tests.

### 5. Capture service

New `services/billing/capture-template-stamps.ts`:

```ts
export async function captureTemplateStamps(
  tx: Database, billRunId: string, banIds: string[],
): Promise<CapturedTemplateStamp[]>
```

1. `listBanFamilies`.
2. Group by family and call `resolveCurrentVersionsForFamily` once per distinct family. CSV and profile are taken from the first call; they are global.
3. `billRunAccountRepository.captureTemplateStamps`.
4. Return the stamp list for the audit.

No `next/*` import and no SQL (platform Inv #9). An empty `banIds` returns `[]`.

### 6. Wire into trigger and rerun

- `services/billing/trigger-run.ts`:
  - after `insertSnapshot`, `const stamps = await captureTemplateStamps(tx, run.billRunId, pending.map(p => p.refBillingAccountId));`
  - add `templateStamps: stamps` to the `BILL_RUN_TRIGGERED` `afterData`;
  - leave the CANCELLED re-trigger path as it is (it deletes and rebuilds the rows, so capture runs on the fresh rows).
- `services/billing/rerun-run.ts`:
  - after `banIds`/`newAttempt` are computed and before the audit insert, `const stamps = await captureTemplateStamps(tx, run.billRunId, banIds);`
  - add `templateStamps: stamps` to the `BILL_RUN_RERUN` `afterData`;
  - update the step-numbering comment ("0. capture template stamps (bm65, Inv #52)").

### 7. Guardrail narrowing

`tests/guardrails/customer-accounts-binding-boundaries.test.ts`:
- add `const RUN_START_CAPTURE_FILES = ["db/repositories/billing/bill-run-account.repository.ts"];` and exclude it from `readsBanTemplateColumn` offenders;
- assert it is still scanned and still reads the column (not vacuous);
- assert `services/billing/post-run.ts` never reads it;
- update the header comment: "posting never reads it; run-start capture is the one reader (billing Inv #54, bm65)".

### 8. Tests

- `tests/db/trigger-run.integration.test.ts`: after trigger, every non-EXCLUDED row has `BTF00000001`, the current Standard version, the profile/CSV versions and a non-NULL `template_captured_at`. EXCLUDED rows are all NULL. The audit `afterData.templateStamps` lists every captured BAN. A cancelled-then-re-triggered run has no stale stamps.
- New `tests/db/run-template-capture.integration.test.ts`:
  1. **Activation after trigger leaves stamps unchanged.** Trigger; activate a new Standard version (`activate-template` service); the stamps are unchanged.
  2. **Rerun re-captures only the rerun BAN.** Rerun one BAN; only that BAN's version changes; `BILL_RUN_RERUN.afterData.templateStamps` lists it.
  3. **No ACTIVE version → NULL, never EXCLUDED** (D55). Fixture: a second, non-default family (`BTF…`, inserted in the test only) with no ACTIVE version, and a BAN whose `ref_bill_template_version_id` points at a retired version of that family (inserted by SQL in the test, bypassing `assertBindableTemplate`). The trigger succeeds; the BAN gets that family with a NULL version; its status is not EXCLUDED.
- `tests/services/billing/trigger-run.service.test.ts` and `rerun-run.service.test.ts`: update the expected `afterData` shapes; capture is called before `engineRegistry.trigger`; an engine failure rolls the stamps back.
- `tests/db/bill-run-account-schema.test.ts`: the five columns exist, are nullable and have no FK.

## Dependencies

- **Packages:** none. The unit uses Drizzle, `postgres` and vitest, already installed.
- **Units:** bm64 (the family table and the family-scoped indexes).
- **Environment:** a fresh database per the bm64 runbook.

## Verification checklist

- [ ] `0051` applies on an empty database after `0050`; the journal has a new `idx 51` entry; no existing migration is edited.
- [ ] Guardrail item 59 and the capture half of item 60 pass (the tests in §8).
- [ ] Capture runs before `engineRegistry.trigger` in both services. A forced engine failure leaves no stamps (the transaction rolls back).
- [ ] `BILL_RUN_TRIGGERED` and `BILL_RUN_RERUN` carry `afterData.templateStamps`. No new `AUDIT_EVENT_TYPES` member.
- [ ] The cm22 guardrail passes with exactly one new exemption, and `post-run.ts` is still held to "never reads".
- [ ] `git diff --stat` shows no change under `services/accounts/`, `components/customers/`, `app/(app)/customers/` or `actions/accounts/`, and none to `0050`.
- [ ] Grants: `billrun_runtime` has SELECT and no write on `bill_run_account` (unchanged), asserted over `information_schema`.
- [ ] `npm run typecheck`, `npm run lint`, and the unit and integration suites are green. Earlier guardrails still pass: compute boundary, trial-bill compute boundary, the cm22 file (apart from the narrowing), 46 (pinning, still on live posting until bm67).
- [ ] Docs:
  - architecture Inv #51 (capture half), #52 and #54 marked "built (bm65)";
  - code-standards guardrail item 59 marked "built (bm65)";
  - progress tracker updated;
  - the doc corrections below applied.

## Open questions

None that need a decision. Doc corrections to apply with this unit:
1. **No FKs on the stamp columns.** Following the `0029`/`0046` stamp precedent, the stamps on the partitioned `bill_run_account` have no FKs. Code-standards Phase 3 Data rule 4 names FKs `bra_btf_fk`/`bra_btv_fk` (and `cb_btf_fk` for bm67), so it should say "no FK — plain-key stamp rule". The same applies to architecture's storage row and bm00's bm65/bm67 text.
2. **`billrun_runtime` can read the stamps.** Code-standards Data rule 5 says it has "no column grant on any new stamp column". It in fact holds table-level SELECT on `bill_run_account`, so it can read them, though never write them. Reword to "no write".
3. **Inv #18 wording.** Customer Management's architecture Inv #18 ("posting never reads `billing_account`'s template reference") still holds. Add a note that run-start capture (billing bm65) is the one sanctioned reader. That's a doc note in `context/customer-management/`, not a code change.
