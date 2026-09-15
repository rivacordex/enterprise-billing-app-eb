# bm31 — `charge_checksum` Re-anchored on `customer_bill_line`

**Unit:** bm31 (Phase 3 · Phase M). **Boundary:** `db/repositories/billing` (`customer-bill-line.repository.ts`, `rated-lines.repository.ts`) + `services/billing/post-run.ts`. **App-side only; no schema, flow, or grant change.** **Specs from:** `billmgmt-architecture.md` §6 **Inv #3** (checksum hashes line content — all three money columns — not surrogate ids), `_updatemodule-billing-billrun-phase3-plan.md` **D7a/D20**, `billmgmt-code-standards.md` §2.4/§6, `bm00-build-plan.md` Unit 31.

> **Framing.** The posting checksum is the tamper-evidence anchor for an issued invoice. In phase 2 it hashed the claimed `rating.udr_rated` rows — which works for usage but yields **`md5('')` for a recurring-only bill** (recurring is derived, never claimed, so there are no `udr_rated` rows to hash). Now that `customer_bill_line` **is** the bill's charge record (Inv #3) and carries both sources, the checksum re-anchors onto **line content**: `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)` over the account's lines, ordered by the same `grouping_key` that assigns `line_no`. It lands after bm29 because its regression — a bill with lines and no claimed `udr_rated` — only exists once recurring derivation is built.

## Goal

Move the posting `charge_checksum` from the `udr_rated`-based `computeChargeChecksum` (in `rated-lines.repository.ts`) to a SQL-only checksum over `customer_bill_line` content (in `customer-bill-line.repository.ts`), switch `post-run.ts` to it, and trim `rated-lines.repository.ts` to the read-only drill-down — so posting stamps a checksum derived from the invoice's own content, a recurring-only bill no longer yields `md5('')`, and altering any of the three money columns on a posted line is detectable.

## Design

**Structural decisions**

- **Hash line content, ordered by `line_no`, never a surrogate id (Inv #3, D7a/D20).** The checksum serializes `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)` per line, ordered by the deterministic `line_no` — reproducible from an archived invoice, and independent of the auto-generated `customer_bill_line_id`. (Ordered by `line_no`, the total order bm29 assigns via `row_number() OVER (ORDER BY grouping_key, source)`, NOT `grouping_key` alone: `grouping_key` is not unique — a USAGE line whose free-text `udr_type` is literally `'RECURRING'` shares the `offering:RECURRING` key of a real RECURRING line — so ordering by it leaves a tied pair in an unspecified `string_agg` order, making the recompute non-deterministic.) Each line is encoded with `json_build_array(...)::text` rather than raw `|`/`,` delimiters, so a `udr_type` containing a delimiter cannot forge a colliding hash (injective serialization).
- **All three money columns, not just `net` (Inv #3).** Hashing `gross_amount`, `discount_amount` **and** `net_amount` means a discount that preserves `net` (a future phase) still changes the checksum — tamper-evidence can't be defeated by a compensating pair.
- **Recurring-only bills stop hashing to empty.** Because the anchor is the lines (which recurring derivation writes) rather than `udr_rated` (which recurring never touches), a recurring-only bill now has a real, content-derived checksum instead of `md5('')`.
- **Scope by the bill, not the claim.** The new signature is `(tx, customerBillId, periodPartition)` — the checksum is over that bill's lines, matching how `post-run.ts` already holds `bill.customerBillId`/`bill.periodPartition`. The old `(billRunId, billingAccountId, postedAttempt)` `udr_rated` scoping retires with the old function.
- **`rated-lines.repository.ts` becomes read-only again.** With the checksum gone, the file is purely `listClaimedForAccount` (the drill-down read, bm18/bm28); its header comment is corrected to say so — no lingering claim that it computes the posting checksum.
- **No new re-verification path (accepted residual).** As phase 2 recorded (progress-tracker §12 / code-standards §6.8), the checksum is computed once at posting and not re-verified afterward, and lines carry no DB trigger (D27). bm31 re-anchors *what* is hashed; it does not add post-posting re-verification. "Detectable" means the stamped value no longer matches a recomputation over altered content — the tamper-evidence, not an active alarm.

## Implementation

### 1. `db/repositories/billing/customer-bill-line.repository.ts` — the content checksum

Add a SQL-only method to the repository bm28 introduced:

```ts
async computeChargeChecksum(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<string> {
  const [row] = await tx
    .select({
      checksum: sql<string>`md5(COALESCE(string_agg(
        json_build_array(
          ${customerBillLine.source}, ${customerBillLine.refProductOfferingId},
          COALESCE(${customerBillLine.udrType}, ''), ${customerBillLine.lineType},
          ${customerBillLine.grossAmount}::text, ${customerBillLine.discountAmount}::text,
          ${customerBillLine.netAmount}::text
        )::text,
        ',' ORDER BY ${customerBillLine.lineNo}), ''))`,
    })
    .from(customerBillLine)
    .where(
      and(
        eq(customerBillLine.refCustomerBillId, customerBillId),
        eq(customerBillLine.periodPartition, periodPartition),
      ),
    );
  if (!row) {
    throw new Error(`computeChargeChecksum: no result for bill ${customerBillId}`);
  }
  return row.checksum;
}
```

Computed entirely in SQL (`numeric`→`text`, no JS float; §2.4). A recurring-only bill hashes its RECURRING lines — never empty.

### 2. `services/billing/post-run.ts` — switch to the line checksum

Replace the `ratedLinesRepository.computeChargeChecksum(tx, run.billRunId, billingAccountId, bill.attemptCount)` call with `customerBillLineRepository.computeChargeChecksum(tx, bill.customerBillId, bill.periodPartition)`; the `stampPosted({ refInvDocumentId, postedAttempt, chargeChecksum })` write is unchanged. The checksum now reflects the invoice's own content.

### 3. `db/repositories/billing/rated-lines.repository.ts` — trim to the read

Remove `computeChargeChecksum` (moved to §1); keep `listClaimedForAccount` (the `BILL_DRAFT`/`BILL_APPROVED` drill-down read for `BillLineTable`). Correct the header comment so it describes a read-only drill-down repository and no longer implies it owns the posting checksum. It stays outside the write boundary (the `billing-rating-write-boundary` guardrail unaffected — still no `rating.*` write here).

## Guardrails (land with the unit — code-standards §9)

- **Recurring-only bill ≠ `md5('')`:** a recurring-only account (lines, no claimed `udr_rated`) posts with a real content-derived checksum.
- **Content-derived + reproducible:** the checksum recomputed from the archived line content (ordered by `line_no`) matches the stamped value.
- **All three money columns matter:** altering `gross_amount`, `discount_amount`, **or** `net_amount` on a posted line changes the recomputed checksum (tamper-evident); a `net`-preserving discount shift still changes it.
- **Boundary intact:** `rated-lines.repository.ts` writes no `rating.*`; `customer-bill-line.repository.ts`'s checksum is `SELECT`-only.

## Dependencies

- **No new npm packages, no schema/grant change.**
- **Prerequisites:** bm29 (a recurring-only bill — lines with no claimed `udr_rated` — must exist for the `md5('')` regression; this is why bm31 follows bm29); bm28 (`customer_bill_line`, its `grouping_key`, and `customer-bill-line.repository.ts`). Until this unit lands, posting keeps the phase-2 `udr_rated` checksum — a deliberate transitional state, not a gap to work around.

## Verification checklist

- [ ] `post-run.ts` stamps a checksum computed over `customer_bill_line` content `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)`, ordered by `line_no`, never by surrogate id.
- [ ] A recurring-only bill posts a non-empty, content-derived checksum (no more `md5('')`).
- [ ] Altering `gross_amount`, `discount_amount`, or `net_amount` on a posted line changes the recomputed checksum.
- [ ] `computeChargeChecksum` is gone from `rated-lines.repository.ts` (now only `listClaimedForAccount`, header corrected); it lives in `customer-bill-line.repository.ts`.
- [ ] `tsc`/lint/tests green; the write-boundary guardrail still passes; `billmgmt-progress-tracker.md` records bm31 delivered and the checksum re-anchor.
