# Invoice Template — Placeholder Catalog

Created by bm47 (the binder unit) — the first unit to define `InvoiceRenderInput`
(`types/billing.ts`) and so the first unit able to write this catalog down. Earlier
drafts of the Invoice Template plan referred to this file before it existed; this
version is authoritative from bm47 onward. Per `billmgmt-ai-workflow-rules.md` §7.9,
**this file and `InvoiceRenderInput` change together** — a new or renamed
placeholder updates both in the same change set.

Every root below is a key on the bound `InvoiceRenderInput` object the layout's
Handlebars template renders against (`services/billing/invoice-template/bind.ts`).
Every optional key is present with `null`, never `undefined` (Handlebars
`strict: true` throws on a missing property; a present `null` is falsy for
`{{#if}}` and does not throw).

## A. Placeholder roots

| Root | Shape | Notes |
| --- | --- | --- |
| `template.*` | `{ layoutCode, layoutVersion, version }` | `version` (the `bill_template_version` id) is `null` until bm53/54 stamp a real generated version. A `null` on a **final** render is the bm47 D8 stopgap only (an interim exception to Inv #42); from bm54 a final render must carry a stamped version. |
| `company.*` | `InvoiceCompany \| null` | `null` until a company profile exists (G15, bm53/61). Fields: `name`, `tradingName`, `registrationNo`, `tin`, `sstRegNo`, `address`, `email`, `phone`, `brandColor`, `accentColor`, `logoUrl`. |
| `payment.*` | `InvoicePayment \| null` | `null` until a profile exists (G15). Fields: `bankName`, `accountName`, `accountNo`, `swift`, `jomPayBillerCode`, `remittanceEmail`. |
| `invoice.*` | — | `number` (`null` on draft → "— pending posting —"), `isDraft`, `date` (posting date, `null` on draft), `periodStart`/`periodEnd`, `dueDate`, `currency`, `billRunId`, `cycleName`, `billRef` (= `customer_bill_id`), `poRef`/`contractRef` (always `null` this unit — G9 interim, no source before a profile exists). |
| `customer.*` | — | `billingAccountId`, `name`, `tradingName`, `registrationNo`, `tin`, `sstRegNo` (always `null` — G9), `address`, `email`, `phone`. |
| `totals.*` | — | `grossTotal`, `discountTotal`, `subtotalExclTax`, `taxTotal`, `totalAmount`, `amountDue` (= `totalAmount` — Inv #50, current charges only, no balance brought forward). All SQL strings. |
| `taxes[]` | `{ category, rate, amount }[]` | Bill-level only (Inv #50) — no per-line tax. |
| `chargeSummary[]` | `{ name, source, amount }[]` | One row per present `lineGroups` entry. |
| `lineGroups[]` | `InvoiceLineGroup[]` | Fixed order `RECURRING → USAGE → OCC`; a group with no lines is omitted. Each line: `lineNo`, `source`, `description`, `productOfferingId`, `udrType`, `udrCount`, `periodStart`/`periodEnd` (the bill's period — lines carry no own period in v1), `quantity`, `unit`, `unitPrice`, `grossAmount`, `discountAmount`, `netAmount`, `discountNote`. |
| `usage.*` | `InvoiceUsageSection \| null` | **Replaces the pre-bm47 `annex.*` root.** `null` when the bill has no billed usage rows, or when the annex section is hidden (`includeUsage: false`, D4). Shape (bm49): `rowCount`, `totalAmount`, `totalQuantity` (`null` when units mixed), `unit` (homogeneous grand-total unit or `null`), `states[]`. Each `states[]` entry: `state` (`null` = "Unassigned region"), `label`, `rowCount`, `amount`, `quantity`/`unit` (single-unit subtotal or `null`), `districts[]`. Each `districts[]` entry: `district` (`null` → label "—"), `label`, `rowCount`, `amount`, `quantity`/`unit`, `rows[]`. Each `rows[]` entry: `startDate`, `cell`, `udrType`, `quantity`, `unit`, `amount`. **Source (bm49):** every billed `udr_rated` row for the account read off `rating.udr_rated` (geo from `state`/`district`, bm48/R9) — no longer the bm45 `additional_info.appendix` snapshot. |
| `isDraft` / `locale` / `timezone` | — | Also mirrored inside `invoice.isDraft`; kept at the root too since helpers read `locale`/`currency` from `options.data.root` directly. |

**Removed, never reintroduce without a spec change:**

- `accountSummary.*` — dropped in v1 (R2, no balance-brought-forward feature).
- `invoice.einvoice.*` — no MyInvois/UBL XML in v1 (R3).

## B. Field formats

Validated by `validation/billing/invoice-profile.schema.ts` (profile fields, bm53+)
and `validation/billing/layout-page-setup.schema.ts` (page setup, bm47). If this
section and `billmgmt-code-standards.md`'s TS rule 5 ever disagree, **this file
wins** and code-standards gets corrected in the same change (workflow rules §5
item 4).

| Field | Pattern / rule |
| --- | --- |
| TIN | `^[A-Z]{1,2}\d{10,11}$` |
| SST no. | `^[A-Z]\d{2}-\d{4}-\d{8}$` (optional; hidden when blank) |
| Postcode | `^\d{5}$` |
| SWIFT | `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` |
| JomPAY biller code | digits only |
| Email | standard email format |
| Brand / accent colour | `^#[0-9A-Fa-f]{6}$` |
| MyInvois state code | `^(0[1-9]\|1[0-6])$` |

## C. Layout generation-time directives (developer layout only — bm50+)

Not placeholders — these are resolved once at template-activation time (bm55's
generator) against the admin's `structure` map, and never survive into the
generated `.hbs` bm47 commits by hand (D8 stopgap):

- `[[if sections.<key>]]` / `[[if columns.<key>]]`
- `[[num colCount|subtotalSpan|totalSpan]]`
- `[[body]]` (the one shell-level directive, replaced by every section in
  manifest order)
