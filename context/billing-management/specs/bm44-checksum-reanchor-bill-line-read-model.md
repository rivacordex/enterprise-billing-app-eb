# bm44 — Checksum re-anchor on `rated_amount` + bill-line read-model surfacing

**Unit:** bm44 (Target Capacity Pricing update). **Boundary:** app — `db/repositories/billing/customer-bill-line.repository.ts` (the posting `computeChargeChecksum`, SQL-only) + the Customers & Bills read model (`listForRun` select, `types/billing.ts` already extended by bm41) + `components/billing/bill-line-table.tsx`. **App-side `rated_amount` surface only — no flow change, no migration, no new write of `customer_bill_line` (Inv #2 two-writer boundary holds).** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §5.3 (checksum, TC22/TC41), §4.4 (read-model columns), §6 (trace stays DB-only, TC26), `billmgmt-ui-context.md` §6b (discount row); `billmgmt-update-overview.md` (Unit 44); `bm00-build-plan.md` Part 3 Unit 44; Inv #35. **Depends on:** bm41 (the `ratedAmount`/`additionalInfo` type + Drizzle columns), bm42 (the columns populated on capacity lines), bm43 (verified lines).

> **Verified against `enterprise-billing-app` (2026-10-04).**
>
> - `computeChargeChecksum` (`customer-bill-line.repository.ts:105-134`) hashes `md5(COALESCE(string_agg(json_build_array(source, ref_product_offering_id, COALESCE(udr_type,''), line_type, gross_amount::text, discount_amount::text, net_amount::text)::text, ',' ORDER BY line_no), ''))` — **seven** elements, ordered by `line_no` (not `grouping_key`; the doc at `:78-88` explains why), `json_build_array` chosen as an injective encoding (`:89-95`). This is the tuple bm44 appends to.
> - `listForRun` (`:22-68`) selects the read columns into `BillLineRow` but does **not** yet select `ratedAmount`/`additionalInfo` (bm41 adds the two columns + the type fields; bm44 wires the read).
> - `BillLineRow` (`types/billing.ts:294-314`) carries `discountAmount: string`, `snapshotPriceRef` etc. but **not** `ratedAmount`/`additionalInfo` yet (bm41's §3 adds them; bm44 consumes them).
> - `bill-line-table.tsx` already renders the Discount column **conditionally**: `showDiscount = lines.some((line) => line.discountAmount !== "0.00")` (`:45`), with the header (`:64-68`), the cell (`:139-143`), and the disclosure `colSpan` (`:155,170`) all keyed off `showDiscount`. The capacity motivation discount therefore surfaces the column **automatically** — but the file's comments (`:10-13`, `:43-45`) still assert "no discount is computed this phase / every line is `0.00`", which bm44's capacity work makes false.
> - Capacity lines are `source = 'USAGE'` with a `udrType`, so `bill-line-table.tsx:152-166` already gives them the lazy `UsageLineDrillDown` — no new disclosure is needed for them this phase (the calc trace stays DB-only, TC26).

## Goal

Extend the posting tamper-evidence to cover `rated_amount` (append it as the **last** element of the `charge_checksum` tuple, Inv #35), surface `rated_amount`/`additional_info` through the `listForRun` read model, and correct the bill-line table so a capacity line's non-zero discount renders honestly — the app-side counterpart to the flow's bm42/bm43, landing together as the `rated_amount` surface (mirrors the delivered bm30/bm31 flow/app split).

## Design

### D1 — append `rated_amount`, never insert mid-tuple (§5.3, TC22/TC41, Inv #35)

`rated_amount` becomes the **eighth and last** element of the hashed tuple: `(source, ref_product_offering_id, COALESCE(udr_type,''), line_type, gross_amount, discount_amount, net_amount, rated_amount)`. Appending — not inserting mid-tuple — preserves the delivered serialization of the first seven fields, so the change does **not** re-serialize every existing line (a recurring-only bill's stamp-time value for its other fields is unchanged in position). The same `json_build_array(...)::text` encoding, the same `ORDER BY line_no`, the same compute-at-posting timing. A capacity line's `rated_amount` (the rated-row sum, distinct from its topped-up `gross_amount`) now participates in the hash, so tampering it after posting breaks the checksum — which is the point: `additional_info` is **not** hashed (verification binds the trace to the money columns, Inv #35), and `rated_amount` is the money column the top-up/discount reconcile against, so it must be covered.

### D2 — NULL `rated_amount` is a first-class JSON `null` (not coalesced)

`rated_amount` is NULL on RECURRING lines (bm42: RECURRING is not rated). Unlike `udr_type` (coalesced to `''` because a free-text value could otherwise collide), `rated_amount::text` left NULL serializes to JSON `null` inside `json_build_array`, which is a distinct, unambiguous token from any numeric string — the injective property holds without a COALESCE, and a RECURRING line's `null` is semantically correct (it was not rated). Do **not** coalesce it to `'0.00'` — that would make a genuinely-unrated line indistinguishable from a rated-to-zero line in the hash.

### D3 — surface in the read model, keep the trace DB-only (§4.4, §6/TC26)

`listForRun` gains `ratedAmount` and `additionalInfo` in its select (the type already carries them from bm41). This makes them available to any consumer of `BillLineRow` — crucially the invoice render path bm45 reads. But the **calc trace is not rendered in the Customers & Bills UI** this phase (TC26 narrowed — the trace stays DB-only; the invoice gains only the per-polygon appendix, which is bm45/PDF). So bm44 adds the fields to the read model and does **not** add a trace disclosure to `bill-line-table.tsx`.

### D4 — the discount column is already conditional; fix the stale comments (ui-context §6b)

The table's `showDiscount` logic un-suppresses the Discount column the moment any line carries a non-`0.00` discount — so a capacity motivation line (e.g. discount 50,000) surfaces it with no code change. bm44's only edit to the component is **correcting the now-false comments** (`:10-13`, `:43-45`) that state no discount is computed this phase, so the file documents the capacity reality (a USAGE line may now carry a discount). The `types/billing.ts` header comment ("all four are `null` for USAGE") is likewise updated to note capacity USAGE lines carry `ratedAmount` + `additionalInfo`.

## Implementation

### 1. Checksum append — `computeChargeChecksum` (`customer-bill-line.repository.ts:112-119`)

Add `${customerBillLine.ratedAmount}::text` as the final argument of `json_build_array`, after `${customerBillLine.netAmount}::text`:

```ts
json_build_array(
  ${customerBillLine.source}, ${customerBillLine.refProductOfferingId},
  COALESCE(${customerBillLine.udrType}, ''), ${customerBillLine.lineType},
  ${customerBillLine.grossAmount}::text, ${customerBillLine.discountAmount}::text,
  ${customerBillLine.netAmount}::text, ${customerBillLine.ratedAmount}::text
)::text
```

Update the method doc (`:70-104`): the hash now covers `rated_amount` as the last element (Inv #35); state it is **appended** (position-preserving) and that NULL (RECURRING) serializes to JSON `null` deliberately. No change to ordering, encoding, `COALESCE(string_agg(...), '')`, or the posting call site (`services/billing/post-run.ts`).

### 2. Read-model select — `listForRun` (`:28-51`)

Add to the select object:

```ts
ratedAmount: customerBillLine.ratedAmount,
additionalInfo: customerBillLine.additionalInfo,
```

The `.map(...)` return (`:63-67`) already spreads `...r`; `ratedAmount` is a `string | null` numeric and `additionalInfo` is the `CapacityCalcTrace | null` jsonb — both pass through typed by bm41's `BillLineRow`. No cast needed beyond the existing `source`/`lineType` ones.

### 3. UI — `bill-line-table.tsx` (comments only; behaviour already correct)

- Rewrite the file-header comment (`:10-13`) and the `showDiscount` comment (`:43-45`): a capacity motivation line now carries a real per-unit discount, so the Discount column appears whenever such a line is present; a non-capacity, no-discount bill still suppresses it.
- No structural change: `showDiscount`, the header/cell/`colSpan` wiring, and the capacity line's existing `UsageLineDrillDown` all stand. **Do not** render `additionalInfo` here (TC26 — DB-only this phase).
- `types/billing.ts` header comment (`:290-293`) updated to note capacity USAGE lines carry `ratedAmount` and `additionalInfo` (not all-`null` like other USAGE lines).

## Dependencies

- **npm packages:** none.
- **Prerequisite artifacts:** bm41 (`customerBillLine.ratedAmount`/`additionalInfo` Drizzle columns + the `BillLineRow` type fields + `CapacityCalcTrace` type), bm42 (the columns populated), bm43 (lines verified before posting). The posting path (`post-run.ts`) that calls `computeChargeChecksum` is unchanged.
- **Downstream:** bm45 (invoice appendix) reads `additionalInfo`/`ratedAmount` through this read model; bm46 (ship gate) asserts the checksum append and the discount render.

## Verification checklist

- [ ] A posted capacity bill's `charge_checksum` covers `rated_amount`: mutating a capacity line's `rated_amount` after posting and recomputing yields a **different** checksum (tamper detected); mutating nothing reproduces the same checksum.
- [ ] The append is position-preserving: a **non-capacity** bill (recurring-only and usage-only) computes the same first-seven-field serialization as before; its checksum changes only by the appended `rated_amount` element (RECURRING → JSON `null`; USAGE → its numeric string = `gross_amount`), and is stable across recompute.
- [ ] A RECURRING line's appended element is JSON `null`, not `"0.00"` — a rated-to-zero USAGE line and an unrated RECURRING line do not collide in the hash.
- [ ] `listForRun` returns `ratedAmount` and `additionalInfo` on every `BillLineRow`; `tsc` passes against bm41's extended type; a capacity line carries its trace object, a RECURRING line carries `ratedAmount: null, additionalInfo: null`.
- [ ] Customers & Bills renders a capacity bill with the Discount column visible and the motivation discount shown (e.g. 50,000 on the 2000-EA anchor); a no-discount bill still hides the column; the calc trace is **not** rendered in the table (TC26).
- [ ] The corrected comments in `bill-line-table.tsx` and `types/billing.ts` no longer claim "no discount this phase"; no behavioural drift from the comment edits.
- [ ] `tsc`/eslint/the DB-free unit suite green; the checksum integration suite (`tests/db/customer-bill-line-checksum.integration.test.ts`) extended for the appended element passes on a disposable Postgres; no `customer_bill_line` write was added to app code (Inv #2).
- [ ] Docs: `bm00-build-plan.md` Part 3 Unit 44 unchanged; `billmgmt-architecture.md` Inv #35 and `billmgmt-ui-context.md` §6b name bm44 as the checksum-append + discount-render unit.
