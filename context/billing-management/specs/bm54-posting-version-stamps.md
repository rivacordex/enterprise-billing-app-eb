# bm54 — Posting-time version stamps

**Unit:** bm54 (Invoice Template update, Part 4). **Boundary:** the posting transaction only, kept separate from the renderer (workflow rules §4.5):

- `services/billing/post-run.ts` — `postAccount` (resolve + pass the stamps), `renderAndStoreInvoice` / `retryRenderInvoice` (render from the stamps)
- `db/repositories/billing/customer-bill.repository.ts` — `stampPosted` (four more columns), `findForAccount` / `lockBillForPosting` (return the stamps)
- `services/billing/invoice-template/resolve-template.ts` — one new function, `resolveVersionsForPosting(tx)` (DB rows only, no blob I/O)

**No migration** (the columns arrived in bm50), **no grant change**, **no change to `charge_checksum`** (Inv #35/#43 — never re-anchored for Part 2).

**Specs from:** Inv #41, #42, #43, #4, #6; code-standards Part 2 General rules 4, 5, data rule 4; guardrail 46, guardrail 47 (second half); architecture §4 ownership shift.

**Depends on:** bm53.

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G15 | **Decided: option A** | `ref_invoice_profile_version` is stamped `NULL` when no profile is ACTIVE at posting |
| G12 | **OPEN** (interim) | The CSV version is stamped on `customer_bill.ref_csv_template_version_id` |

> **Build may not start until G12 is recorded as decided.**

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** `postAccount(run, billingAccountId, actorId)` (`post-run.ts:226`) opens one `db.transaction` per account (`:252`): `lockBillForPosting` (`FOR UPDATE OF cb`, `customer-bill.repository.ts:312`) → skip if posted / zero-total → `documentRepository.insert(tx,'INV',…)` (`:321`) → document lines → `postDocument` (`:375`) → `computeChargeChecksum` (`:386`) → **`stampPosted(tx, id, partition, { refInvDocumentId, postedAttempt: bill.attemptCount, chargeChecksum })`** (`:392`, throws if it returns `false`) → `billRunAccountRepository.updateStatus(… INVOICED)` (`:410`). After commit `renderAndStoreInvoice` (`:68`, `:425-427`). `stampPosted` (`customer-bill.repository.ts:401`) sets `ref_inv_document_id, posted_attempt, charge_checksum, category='normal'` `WHERE … AND ref_inv_document_id IS NULL`. `customer_bill_finalization_guard` (`0033`) raises SQLSTATE `23001` on any `UPDATE`/`DELETE` once `OLD.ref_inv_document_id IS NOT NULL`. Reprint: `GET …/stored-invoice/[banId]` → `getStoredInvoice` (md5-verified stored bytes).

## Goal

Inside each account's posting transaction, resolve the current generated-template, company-profile and CSV versions and write them onto `customer_bill` in the **same `UPDATE`** that sets `ref_inv_document_id`, then make the final render and `retryRenderInvoice` use only those stamps — so a posted bill carries its four stamps, a later activation changes neither the stamps nor the stored PDF bytes, and any attempt to stamp afterwards is refused by `0033`.

## Design

### D1 — Resolve at posting: DB rows only, inside the money transaction

```ts
resolveVersionsForPosting(tx): Promise<{
  refBillFormatId: 'INVOICE';
  refBillTemplateVersionId: string;        // generated: non-default ACTIVE ?? default
  refInvoiceProfileVersion: number | null; // ACTIVE invoice.profile config_version ?? null (G15)
  refCsvTemplateVersionId: string;         // csv: non-default ACTIVE ?? default
}>
```

- The same precedence as `resolveTemplate({ kind: 'draft' })` (bm53 D1) — one shared private helper, so the draft preview and the posting stamp can never disagree on "current".
- **No blob I/O, no compile, no Handlebars in the posting transaction.** Posting must never fail or slow because a template is unreadable; a bad template parks the render afterwards (Inv #40; code-standards §9 item 12: a render failure never rolls back a posted INV).
- Reads take no lock on the catalog rows. Accounts posted in one run may pick up different versions if an admin activates mid-run; each bill records exactly what it was posted under, which is what pinning promises. Documented; not prevented (a run-level freeze would need a new run column — out of scope).
- Called once per account, after `lockBillForPosting` and before `stampPosted`.

### D2 — Stamp in the same `UPDATE` (Inv #41)

`stampPosted(tx, id, partition, data)` — `data` gains `refBillFormatId`, `refBillTemplateVersionId`, `refInvoiceProfileVersion`, `refCsvTemplateVersionId`. One statement:

```sql
UPDATE billing.customer_bill
SET ref_inv_document_id = $doc, posted_attempt = $attempt, charge_checksum = $checksum, category = 'normal',
    ref_bill_format_id = 'INVOICE', ref_bill_template_version_id = $btv,
    ref_invoice_profile_version = $profileVersion, ref_csv_template_version_id = $csv
WHERE customer_bill_id = $id AND period_partition = $partition AND ref_inv_document_id IS NULL
```

Not a second `UPDATE`, not a trigger. After it, `0033` refuses every further `UPDATE`, so a stamp can never be added or corrected (guardrail 46). `trial-bill-compute-boundary` keeps asserting `post-run.ts` is the only caller of `stampPosted`.

### D3 — Final render and retry read only the stamps (Inv #42)

- `customerBillRepository.findForAccount` returns the four stamp columns.
- `renderAndStoreInvoice` and `retryRenderInvoice` call `buildInvoiceHtml({ …, mode: { kind: 'final', bill: stamps } })` (bm53 D1 table): the stamped generated id, the stamped profile version (`null` stays `null`), never the current ACTIVE.
- Bills posted before bm54 keep `NULL` stamps forever (`0033`) and render with the default (bm53 D1) — they are not back-stamped.
- The draft preview keeps `mode: { kind: 'draft' }` and persists nothing.

### D4 — Reprint is the stored bytes (Inv #43)

No change to `stored-invoice/[banId]/route.ts` or `getStoredInvoice`: they serve the stored PDF (md5-verified). This unit adds a test proving that an activation after posting does not change those bytes. `charge_checksum` is untouched and still recomputes from the lines.

### D5 — What a stamp means in the UI (read-only, no new component)

`BillLineTable`/Customers & Bills is unchanged in this unit. The stamps become visible in bm55's Version history ("used by N invoices") and the posted-bill preview.

## Implementation

1. `resolve-template.ts`: extract the shared "current" precedence helper; add `resolveVersionsForPosting(tx)`.
2. `customer-bill.repository.ts`: `stampPosted` signature + SQL (D2); `findForAccount` / the posting read return the stamps; update the `customer-bill.ts` schema comments ("stamped at posting by the app, bm54").
3. `post-run.ts`: in `postAccount`, `const versions = await resolveVersionsForPosting(tx)` before `stampPosted`, spread into its `data`; in `renderAndStoreInvoice` / `retryRenderInvoice`, pass `mode: { kind: 'final', bill }`. No other line changes (diff review).
4. Tests.

### Tests

| Test | Covers |
| --- | --- |
| `tests/services/billing/post-run.service.test.ts` (extend) | `stampPosted` receives the four values; G15: no ACTIVE profile → `refInvoiceProfileVersion: null`; `resolveVersionsForPosting` makes no blob call (spy) |
| `tests/db/customer-bill-stamps.integration.test.ts` (new) | after posting, `ref_bill_format_id = 'INVOICE'`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id` set **and** `ref_inv_document_id` set by the same statement (`pg_stat_statements`-free: assert via a `BEFORE UPDATE` audit trigger in the test DB that one UPDATE carried all five); a second `UPDATE … SET ref_bill_template_version_id = …` → SQLSTATE `23001` |
| `tests/guardrails/invoice-version-pinning.test.ts` (new — **guardrail 46**) | post account A under generated v2 (fixture ACTIVE row + uploaded blob) + profile v1 (fixture ACTIVE profile with logo); then insert generated v3 ACTIVE (retiring v2) + profile v2 ACTIVE (DB fixture — bm58/bm61 not built yet); assert A's four stamps unchanged, A's stored PDF bytes (`getStoredInvoice`) byte-equal to before, A's `charge_checksum` recomputes equal; `retryRenderInvoice` on a parked twin renders with v2/profile v1 (header text + template version in the footer); a **new draft preview** of account B shows v3 + profile v2 |
| `tests/guardrails/invoice-checksum-tamper.test.ts` (extend — **guardrail 47, second half**) | accounts A (pinned v1 default) and C (pinned fixture v2); tamper one byte of v2's `invoice.hbs`; cold memo; final render: C parks with `TEMPLATE_CHECKSUM_MISMATCH`, A stores its PDF |
| `tests/guardrails/billing-trial-bill-compute-boundary.test.ts` | still green (only `post-run.ts` calls `stampPosted`) |
| `tests/app/api/stored-invoice-route.test.ts` | unchanged and green (reprint = stored bytes) |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm53.
- **Downstream:** bm55 (posted-bill preview reads the stamps; "used by N invoices"), bm58 and bm61 (activation is safe only once pinning is proven), bm62 (CSV reads the stamped CSV version).

## Verification checklist

- [ ] A bill posted on the `ci` seed carries all four stamps; with no profile ACTIVE, `ref_invoice_profile_version` is `NULL`.
- [ ] The stamps land in the same `UPDATE` as `ref_inv_document_id`; a later stamp attempt fails with `0033`'s SQLSTATE `23001`.
- [ ] Inserting a newer ACTIVE generated version and profile (fixtures) leaves the posted bill's stamps and stored PDF bytes unchanged, while a new draft preview uses the newer versions (guardrail 46).
- [ ] Final render and retry-render use only the stamps (spy: `resolveTemplate` called with `kind: 'final'`); no current-ACTIVE read on the final path.
- [ ] Posting performs no blob read and no compile (spy); a broken template still posts the INV and parks the render.
- [ ] `charge_checksum` serialization unchanged (existing checksum guardrail green).
- [ ] Guardrails 43–47, 49, 50, 54 and the compute-boundary/finalization guardrails green; `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: architecture §4 ownership note ("the two reserved columns are now written by `stampPosted`"); code-standards data rule 4 confirmed as built; known-issues (mid-run activation → per-account versions; pre-bm54 bills unstamped); progress tracker.
