# bm82 — Bill run captures the BAN's template type

**Unit:** bm82 (Invoice Template Types · Part 6, unit 9 of 12). **Boundary:** BILL-RUN, plus one SETTINGS-UI read: `billRunAccountRepository.listBanFamilies`, the comments of `capture-template-stamps.ts`, the type list's **Bound BANs** column (`countBoundBansByType` in `template-types.ts`), and the capture, draft and posting tests that set a BAN's template by SQL. These are the Billing files the BAN type column touches; CM workflow rules §10.6.2 keep them out of cm23. **One merge with Customer Management cm23** (`context/customer-management/specs/cm23-bind-ban-to-template-type.md`), whose `0054` drops the column this unit stops reading. **Specs from:** `billmgmt-architecture.md` Inv #51, #54 (amended: capture reads the type column directly), #55, #66, and the Invoice Template Types deltas (System boundaries row for `capture-template-stamps.ts`; Contradiction T6); `billmgmt-code-standards.md` › Invoice Template Types, General rule 8; CM `custmgmt-code-standards.md` guardrail 11; `bm00-build-plan.md` Part 6, unit 82. **Model file:** `db/repositories/billing/bill-run-account.repository.ts:44-73` (`listBanFamilies`, the one sanctioned reader).

> **Framing.** Run-start capture (bm65) maps each BAN to a template **family** through `listBanFamilies`. Today that function reads `billing_account.ref_bill_template_version_id`: NULL means the default family, and a generated version id means that version's family ("follow the line"). cm23's `0054` replaces that column with `ref_bill_template_family_id`, so capture must read the type directly. Nothing downstream changes:
> - `captureTemplateStamps` still resolves each family's current version with `resolveGeneratedForFamily`, which gives NULL for a retired type or one with no ACTIVE or default settings
> - the blocking `template_versions_captured` approval check still stops a NULL version
> - posting still skips it
>
> The function lives in the repository, not in `capture-template-stamps.ts` as the build plan's one-liner suggests; the service is unchanged except for its comment.

## Goal

With cm23 in the same merge:
- a BAN bound to Wholesale gets a draft rendered on Wholesale at the next **Run** or rerun
- a NULL BAN stays on Standard
- a BAN whose type has no usable settings version captures that type with a NULL version, which blocks approval for that BAN

Existing capture, freeze, draft and posting tests stay green on the new column.

## Design

**Structural decisions**

- **D1: The family is the column, or Standard.** `family_id = COALESCE(ba.ref_bill_template_family_id, dft.bill_template_family_id)`, and the join to `bill_template_version` goes:
  - **The old third case** ("a non-generated version gives a NULL family") disappears, because a family reference can't point at the wrong kind.
  - **A missing default family** (impossible after `0046`) still yields NULL, as today.
  - **Standard** is reached only through `is_default`, never an id literal (General rule 8).
- **D2: Retired and empty types are handled where they already are.** `listBanFamilies` doesn't filter on usability: a BAN on a retired or not-yet-usable type keeps that family id. `resolveGeneratedForFamily` returns `null` for it (a retired family, or no ACTIVE ⇒ no default for non-Standard), so the BAN's stamp is that family plus a NULL version. Bind and retire prevent this state in the app (Inv #66): a type, once usable, always keeps an ACTIVE settings version, because activation retires only the version it replaces. The state is therefore reached only by an SQL bypass, and the NULL-version path is the tripwire Inv #66 relies on ("An SQL bypass is still caught at capture").
- **D3: The capture stays a pure read of `billing_account`.** It never writes the column (Inv #54). CM guardrail 11 keeps `listBanFamilies` as one of exactly two Billing places that may name `billing_account.ref_bill_template_family_id`; the other is `template-types.ts`.
- **D4: Bound BANs on the type list.** `services/billing/invoice-template/template-types.ts` gains `countBoundBansByType(db)`: one `GROUP BY` over `billing.billing_account.ref_bill_template_family_id`, counting every BAN whatever its state, with `NULL` reported under Standard's id.
  - **Why it lives here:** CM guardrail 11 names this file as the only Billing file besides `listBanFamilies` that may reference the column.
  - **Where it shows:** bm77's `listTemplateTypes` merges the counts into `TemplateTypeListRow.boundBanCount`, and `TemplateTypeList` gains the column (tabular numerals, ui-context §10e).
  - **Why every state counts:** the count matches what bm83's retire must move to reach zero, and bm83's dialog reuses it.

## Implementation

### 1. `db/repositories/billing/bill-run-account.repository.ts` (changed)

Header comment above `listBanFamilies` (L31–43): "bm82 (Inv #54 amended): reads the BAN's type column. NULL → the default family (Standard). Never writes `billing_account`." The SQL becomes:

```ts
const rows = await tx.execute<{ ban_id: string; family_id: string | null }>(sql`
  SELECT ba.billing_account_id AS ban_id,
         COALESCE(ba.ref_bill_template_family_id, dft.bill_template_family_id) AS family_id
  FROM billing.billing_account ba
  LEFT JOIN (
    SELECT bill_template_family_id FROM billing.bill_template_family WHERE is_default
  ) dft ON true
  WHERE ba.billing_account_id = ANY(${textArray(chunk)})
  ORDER BY ba.billing_account_id`);
```

The signature, chunking (`CAPTURE_CHUNK_SIZE`) and return shape are unchanged.

### 2. `services/billing/capture-template-stamps.ts` (comment only)

The header's step 1 reads "the BAN's type (`billing_account.ref_bill_template_family_id`; NULL = Standard), via `listBanFamilies`". The version-to-family wording is removed. No code change.

### 3. Bound BANs (D4)

- **`services/billing/invoice-template/template-types.ts`:** add
  ```ts
  // bm82 (CM guardrail 11 exemption) — BANs bound per type; NULL counted under Standard.
  // Every state, matching what a retire (bm83) must move.
  export async function countBoundBansByType(db: Database): Promise<Map<string, number>>
  // SELECT COALESCE(ba.ref_bill_template_family_id, dft.bill_template_family_id) AS type_id,
  //        count(*)::int AS n
  // FROM billing.billing_account ba
  // CROSS JOIN (SELECT bill_template_family_id FROM billing.bill_template_family WHERE is_default) dft
  // GROUP BY 1
  ```
- **`listTemplateTypes`** (bm77) calls it, and sets `boundBanCount` (default 0) on each `TemplateTypeListRow`.
- **`TemplateTypeList`** gains the **Bound BANs** column after the Default chip (tabular numerals, right-aligned).

### 4. Tests (fixtures move from a version id to a type id)

**`tests/db/run-template-capture.integration.test.ts`:**
- **Tests 1–2 (NULL BANs on Standard):** unchanged.
- **Test 3 (L312):** `UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000099'` (whose only generated version, `BTV00000099`, is RETIRED). It still expects family `BTF00000099` and a NULL version.
- **Test 4 (L369):** `ref_bill_template_family_id = 'BTF00000088'` (ACTIVE `BTV00000088`) captures `BTV00000088`. After the family is retired, a rerun gives family `BTF00000088` with a NULL version.
- **Test 5 (L427), replaced:** the "CSV-kind version → NULL family" case can't be expressed any more. It becomes "a BAN bound to a type with no generated version at all (a new, empty type)", which captures that family with a NULL version, and approval is blocked by `template_versions_captured`.
- **Added:** bm78's "a type whose only versions are DRAFTs stamps a NULL version" case uses the type column.

**Other suites that set the BAN by SQL to `'BTV00000099'`:** these switch to `ref_bill_template_family_id = 'BTF00000099'`, with expectations unchanged:
- `tests/db/posting-skips-null-template.integration.test.ts` (L97)
- `tests/db/draft-uses-run-stamps.integration.test.ts` (L204)
- `tests/e2e/invoice-template-journey.integration.test.ts` (L1438, L1572)

**New case in `tests/db/run-template-capture.integration.test.ts`, the visible result:**
1. Create "Wholesale" and upload and activate v1 through the bm77–bm79 services.
2. Bind BAN A through cm23's `setBillingAccountTemplate`.
3. Trigger a run.

BAN A's stamp is Wholesale's family and settings v1, a NULL BAN B's stamp is Standard's current version, and the draft for BAN A renders through Wholesale's layout (its `templateLabel` / layout code in the HTML).

**Bound BANs:** `tests/services/billing/invoice-template/template-types.test.ts` and bm77's `tests/db/template-types-create.integration.test.ts` gain the cases: `countBoundBansByType` counts NULL BANs under Standard and bound BANs under their type, closed BANs included, and the list shows the counts.

**`tests/guardrails/customer-accounts-binding-boundaries.test.ts`:** owned by cm23 (same merge). `RUN_START_CAPTURE` stays `{ file: "db/repositories/billing/bill-run-account.repository.ts", fn: "listBanFamilies" }`, and it must now contain `ref_bill_template_family_id`.

## Dependencies

- **cm23 (same merge):** `0054` and the Drizzle mirror.
- **bm77–bm79:** a usable non-Standard type for the visible-result case.
- **Environment:** a disposable Postgres. Azurite for the draft-render case.

## Verification checklist

- [ ] `listBanFamilies` reads `ref_bill_template_family_id` with `COALESCE` to the default family. No Billing file reads `ref_bill_template_version_id` on `billing_account`.
- [ ] A BAN bound to Wholesale captures Wholesale's ACTIVE settings version at Run and rerun, and its draft renders on Wholesale. A NULL BAN captures Standard.
- [ ] A BAN on a retired or empty type captures that family with a NULL version. Approval is blocked by `template_versions_captured`, and posting skips it.
- [ ] Every capture, freeze, draft, posting and journey suite is green on the type column.
- [ ] Billing's type list shows Bound BANs, with NULL counted under Standard.
- [ ] **Merged together with cm23**, in one PR.
- [ ] `tsc --noEmit`, ESLint and Prettier pass.
- [ ] Docs:
  - Inv #54's amended text marked "built (bm82)"
  - `billmgmt-progress-tracker.md` records bm82
