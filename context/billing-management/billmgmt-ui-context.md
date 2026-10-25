# Billing Management (Bill Run) — UI Context (Module Delta)

This file **inherits `context/ui-context.md` unchanged** and only maps Bill Run domain objects onto the shared token families; it **redefines no shared color, type, radius, or shadow token**. The one new hue it introduces is the module-scoped **Deep Petrol** featured-action accent (`--billrun-cta-*`) defined in §7 — a scoped accent that overrides no shared token, permitted under shared doc §3.4's module-accent allowance. Every hex in §§1–6 is an existing shared token shown for reference — wire badges to the semantic tokens, never to raw hex (code-standards §4.3). **This module ships no AI/ML features (architecture §5), so the `--ai-*` scale and `--gradient-ai` are not used here** — only the shared brand/status families.

**Phase-3 delta (minimal):** one retirement — `PlaceholderBanner`/`PlaceholderBadge` and their warning mapping are **deleted** with `BILLRUN_PLACEHOLDER_MODE` (D31); one new mapping — `ChargeSource` onto the **existing** cyan/primary families (§6); one correction — `EXCLUDED` was missing from §2; plus `BLN` in the mono-ID list and the bill-line table's radius/tabular rules. **No new color, type, radius or shadow token is introduced, and the Deep Petrol CTA in §7 is unchanged.**

**Target Capacity Pricing delta (minimal, 2026-10-04):** **no** new color, typography, radius, shadow, or accent token, and the module still ships **no AI** (`--ai-*`/`--gradient-ai` stay unused); the Deep Petrol CTA (§7) is unchanged. Two UI touches only: (1) the `discount_amount` column now **renders** once a capacity **motivation** line carries a non-zero discount (§6b); (2) the posted invoice PDF gains a **per-polygon usage appendix** grouped by state/district (§6d), using existing tokens. Sources: `_updatemodule-billing-billrun-target-capacity-plan.md`, `billmgmt-update-overview.md`, `billmgmt-architecture.md`.

**Invoice Template delta (minimal, 2026-10-07):** **no** new app color, type, radius or shadow token, and still **no AI**. Four UI touches: (1) two new Administration › Invoice Settings screens (Company profile, Invoice template) mapped onto existing families in **§10**, including the new `TemplateVersionStatusBadge`; (2) **Activate** on those screens takes the existing Deep Petrol featured accent (§7); (3) the invoice **document** gets its own print palette and typography, which sit **outside** the app token system and use shared hex values only as fixed layout CSS (§10c); (4) the PDF gains a "Page X of Y" footer, and the draft watermark stays `position:fixed` (§6c). Sources: `billmgmt-update-overview.md` Part 2, `billmgmt-architecture.md` › Invoice Template deltas, `billmgmt-code-standards.md` › Invoice Template deltas.

**Invoice Template Phase 3 delta (minimal, 2026-10-15; delivered bm64–bm72, signed off by bm73 on 2026-10-17):** **no** new app color, type, radius, shadow or accent token, still **no AI**, and the Deep Petrol CTA (§7) is unchanged. Three UI touches:
1. The Invoice template editor keeps one section toggle (**Payment information**) and gains **Footnote** lines; every other toggle is removed (D56, §10b).
2. The rewritten layout v1 replaces the Usage annex with per-type, per-State-District detail pages and a Total Amount page. It reuses the §10c `--inv-*` print palette and adds **no** layout variable (§10d).
3. New park/skip reasons surface on existing surfaces with existing families (§10d).

**Invoice Template Types delta (minimal, 2026-10-25; planned, not built):** **no** new app color, type, radius, shadow or accent token, still **no AI**, and the Deep Petrol CTA (§7) stays on **Activate** only. Four UI touches, all on existing families:
1. Invoice Settings › Invoice template becomes a **type list** with a per-type detail page. Type statuses (Usable / Not yet usable / Retired) map onto the version families (§10a). The Standard-only heading is corrected (§10b).
2. **Upload layout package**, **overwrite warning**, **retire** and **export** controls (§10e). Destructive confirms use the danger role **inside their dialog only** (§7).
3. Upload rejections render as one Danger alert listing every problem, never a toast (§10e).
4. Customer Management's BAN type select and labels are specified in `custmgmt-ui-context.md` §9.5, not here.

Sources: `billmgmt-update-overview.md` (the in-flight design), `billmgmt-architecture.md` › Invoice Template Types deltas, `billmgmt-code-standards.md` › Invoice Template Types deltas (Styling rules 1–6). Earlier deltas: `billmgmt-project-overview.md` › Invoice Template Phase 3, and the matching architecture and code-standards sections.

**Rendering rule (shared §8):** every badge/pill renders the dark `-fg` text on the light `-bg` tint (never white-on-tint) and always pairs color with an icon **and** label, so meaning never depends on colour alone. Match the component names in `billmgmt-code-standards.md` §4.

---

## 1. Run status → token family (`RunStatus` → `RunStatusBadge`)

| Domain state          | Family                          | Base token / hex                | Text (`-fg`) / hex              | Tint (`-bg`) / hex              |
| --------------------- | ------------------------------- | ------------------------------- | ------------------------------- | ------------------------------- |
| `SCHEDULED`           | Neutral (idle)                  | `--text-muted` `#6A7283`        | `--color-neutral-700` `#353B46` | `--color-neutral-100` `#EEF0F4` |
| `PROCESSING`          | Info (in-flight)                | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `PROCESSED`           | Warning (needs review/approval) | `--color-warning-500` `#E08600` | `--color-warning-700` `#8A5200` | `--color-warning-50` `#FEF4E6`  |
| `APPROVED`            | Brand (authorised, locked)      | `--color-primary-500` `#2E45A9` | `--color-primary-700` `#1B2A68` | `--surface-selected` `#EDF0FB`  |
| `POSTING`             | Info (money moving)             | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `INVOICED`            | Success (money posted)          | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `DISTRIBUTING`        | Info                            | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `COMPLETED`           | Success (strong)                | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `PROCESSING_FAILED`   | Danger (rerunnable)             | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `DISTRIBUTION_FAILED` | Danger (rerunnable)             | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `CANCELLED`           | Neutral (muted, terminal)       | `--text-disabled` `#99A1B0`     | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |

`STALLED` is a **derived** display flag, not a status — render the `StallBanner` in the **Warning** family (`--color-warning-*`), never a persisted pill (code-standards §4.3).

## 2. Account status → token family (`AccountStatus` → `AccountStatusBadge`)

| Domain state          | Family                                                      | Base / hex                      | Text (`-fg`) / hex              | Tint (`-bg`) / hex              |
| --------------------- | ----------------------------------------------------------- | ------------------------------- | ------------------------------- | ------------------------------- |
| `PENDING`             | Neutral                                                     | `--text-muted` `#6A7283`        | `--text-muted` `#6A7283`        | `--color-neutral-100` `#EEF0F4` |
| `PROCESSING`          | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `PROCESSED`           | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `INVOICED`            | Success                                                     | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `DISTRIBUTING`        | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `COMPLETED`           | Success                                                     | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `PROCESSING_FAILED`   | Danger                                                      | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `DISTRIBUTION_FAILED` | Danger                                                      | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `SKIPPED`             | Neutral (muted — dropped at approval, no charge)            | `--text-disabled` `#99A1B0`     | `--text-disabled` `#99A1B0`     | `--color-neutral-100` `#EEF0F4` |
| `EXCLUDED`            | Neutral (muted — scoping-time exclusion, **not** a failure) | `--text-disabled` `#99A1B0`     | `--text-disabled` `#99A1B0`     | `--color-neutral-100` `#EEF0F4` |

`EXCLUDED` was missing from this table while `AccountStatusBadge` covered all ten values. It matters more from phase 3: an `EXCLUDED` account forgoes the month's recurring **and** usage (Inv #26), so it must never render in the danger family — it is a deliberate scoping outcome, not something that went wrong.

## 3. Stage status → token family (`StageStatus` → `StageStatusBadge`, on the `StageTimeline`)

| Domain state | Family          | Base / hex                      | Tint (`-bg`) / hex              |
| ------------ | --------------- | ------------------------------- | ------------------------------- |
| `PENDING`    | Neutral         | `--text-muted` `#6A7283`        | `--color-neutral-100` `#EEF0F4` |
| `RUNNING`    | Info            | `--color-info-500` `#1A73D9`    | `--color-info-50` `#E7F1FD`     |
| `DONE`       | Success         | `--color-success-500` `#1F9D57` | `--color-success-50` `#E6F6EC`  |
| `FAILED`     | Danger          | `--color-danger-500` `#D92D2D`  | `--color-danger-50` `#FDEAEA`   |
| `SKIPPED`    | Neutral (muted) | `--text-disabled` `#99A1B0`     | `--color-neutral-100` `#EEF0F4` |

## 4. Error class → token family (`ErrorClass` → `ErrorClassBadge`, on the Errors tab)

| Domain state                            | Family  | Base / hex                      | Text (`-fg`) / hex              | Tint (`-bg`) / hex             |
| --------------------------------------- | ------- | ------------------------------- | ------------------------------- | ------------------------------ |
| `HARD` (blocking; excluded at approval) | Danger  | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`  |
| `SOFT` (finding; stage still succeeded) | Warning | `--color-warning-500` `#E08600` | `--color-warning-700` `#8A5200` | `--color-warning-50` `#FEF4E6` |
| `INFRA` (retryable / transient)         | Info    | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`    |

## 5. Bill category → token family (`BillCategory` → `BillCategoryBadge`)

| Domain state                                      | Family            | Base / hex                      | Tint (`-bg`) / hex                        |
| ------------------------------------------------- | ----------------- | ------------------------------- | ----------------------------------------- |
| `trial` (draft, pre-posting)                      | Neutral (outline) | `--color-neutral-500` `#6A7283` | `--surface-card` `#FFFFFF` (outline only) |
| `normal` (posted)                                 | Success           | `--color-success-500` `#1F9D57` | `--color-success-50` `#E6F6EC`            |
| `last` (closure/final bill — reserved, off-cycle) | Warning           | `--color-warning-500` `#E08600` | `--color-warning-50` `#FEF4E6`            |

## 6. Charge source → token family (`ChargeSource` → `ChargeSourceBadge`, on `BillLineTable`)

A bill line's **source** is a category, not a status — so it maps onto the **brand secondary families**, never onto success/warning/danger/info. Zero new hues.

| Domain value                                   | Family                          | Base / hex                                                                | Text (`-fg`) / hex              | Tint (`-bg`) / hex             |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| `USAGE` (claimed from `rating.udr_rated`)      | Info (as built — see gap note)  | `--color-info-500` `#1A73D9`                                              | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`    |
| `RECURRING` (derived from `product_inventory`) | Primary — "contractual, steady" | `--color-primary-500` `#2E45A9`                                           | `--color-primary-700` `#1B2A68` | `--color-primary-50` `#EDF0FB` |
| `OCC`                                          | —                               | **Not rendered** — reserved enum value with no producer this phase (D30). |

⚠ Code gap (2026-10-12): the rule above calls for Cyan ("measured traffic") on `USAGE`, but `components/billing/charge-source-badge.tsx` renders it in the **Info** family (`--color-info-50` / `--color-info-700`), which this section forbids for a category. Tracked in billmgmt-known-issues.md.

**§6 previously defined `PlaceholderBanner`/`PlaceholderBadge`. Both are RETIRED (D31)** along with `BILLRUN_PLACEHOLDER_MODE`; delete the components and their warning-family mapping. Nothing replaces them — see `billmgmt-code-standards.md` §4.2 for why a quieter "seeded data" badge is not substituted.

## 6b. Bill line table & the per-record drill-down (`BillLineTable`)

| Element                                                                      | Treatment                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Line rows                                                                    | Data grid — `--radius-none` `0`, `--text-body-sm`, `font-variant-numeric: tabular-nums` on all three money columns                                                                                                                                                                                                                   |
| `discount_amount` column                                                     | **Hidden while every line is `0.00`; renders once any line carries a non-zero discount.** The capacity **motivation** discount (Target Capacity update) is the first such case — a capacity line shows `discount_amount` in the existing money-column treatment (tabular-nums, `formatCurrency`). No new token |
| `udr_rated` drill-down (a `USAGE` row)                                       | Collapsed native `<details>` disclosure on `--surface-sunken` `#EEF0F4`, fetched **on expand only** — a `volume`-profile account sits behind thousands of records                                                                                                                                                                    |
| Price snapshot (a `RECURRING` row)                                           | Same disclosure slot, same sunken surface — the snapshot _is_ that row's evidence; there is no per-record drill-down behind it                                                                                                                                                                                                       |
| Per-record exception surface (`BILL_NOTUSED`, unresolvable subscriber — D32) | **Info** family — text `--color-info-700` `#0C4084`, tint `--color-info-50` `#E7F1FD`. Informational, never danger: nothing failed and approval is not blocked. **As built it is not in `BillLineTable`:** it lives on the **Uncharged** tab (`components/billing/uncharged-table.tsx`) as a local `InfoBadge` pill labelled "Not used" (`BILL_NOTUSED`) or "Orphan" |

⚠ Code gap (2026-10-12): `InfoBadge` in `uncharged-table.tsx` renders a label with **no icon**, which breaks the rendering rule at the top of this file (colour + icon + label). Tracked in billmgmt-known-issues.md.

## 6c. Draft PRO-FORMA watermark & preview modal a11y (bm18, Phase-2 review folds T9/D-T2/D-T5)

**Watermark legibility.** The draft PDF's diagonal "DRAFT · PRO-FORMA · NOT A
VALID INVOICE" watermark (Danger family, `--color-danger-500` `#D92D2D`) must
never degrade the figures the reviewer opened the modal to validate (D-T5).
The layout's `shell.hbs` (`db/seeds/invoice-templates/INVTPL-STD-A4/v1/shell.hbs`,
moved there from the legacy `render-invoice-template.ts`, R5) resolves this structurally
rather than by tuning an opacity-vs-contrast ratio: the watermark is a
`position: fixed` layer at `z-index: 0` (Chromium's print engine repeats a
fixed-position element on every page, which is what makes it appear on every
sheet without a header/footer template per page); the invoice content sits in
an **opaque** `.sheet` card (`background: #ffffff`, `z-index: 1`) on top of
it. The watermark is only ever visible in the page's empty margins/whitespace
around the invoice card — never through the printed line items or totals,
regardless of the chosen opacity (kept low, `0.14`, purely so the watermark
itself doesn't read as aggressive on the page background). Do not remove the
opaque background from `.sheet` without re-deriving an opacity/contrast
budget to replace it.

**Preview modal a11y contract** (`InvoicePreviewModal` and `StoredInvoiceModal`,
the latter landed bm19): built on the shared `Dialog` (Radix `Dialog.Root`), which
already provides a **focus trap**, **Esc-to-close**, and **focus return to
the trigger** for free — no bespoke implementation needed for those three.
The one addition every such modal must carry itself: an accessible `<iframe
title>` — `"Draft PRO-FORMA invoice — {BAN}"` for a draft, `"Invoice {INV…}"`
for a stored invoice.

**Loading/queued/error states** (D-T2, ui-context delta only — no new token):
a PDF-shaped skeleton (`.pdfwrap` frame + shimmer lines, `animate-pulse`) with
caption **"Rendering draft invoice…"**; past the render-side concurrency
guard's normal-render window the caption reads **"Queued — rendering
shortly"**; a failed/timed-out render shows an inline **Retry** button with a
plain-language reason, in the destructive text color — never a frozen or
empty frame.

**Invoice Template update (2026-10-07).** The watermark **stays `position:fixed`** (R5; the plan body's "move it to the page mechanism" is superseded). The new Chromium `footerTemplate` (`footer.hbs`: "Page X of Y", inline Arial 7.5px, muted `#6A7283`) must sit in the bottom margin **without clipping** the watermark. A **parked** final render (checksum mismatch, compile failure, `Σ net ≠ subtotal`) reuses the existing `RenderPendingRow`: warning-700 status text, with the error reason in the destructive text color. There is no new badge, status or color for parking.

## 6d. Invoice usage appendix — per-polygon by state/district (Target Capacity, 2026-10-04) — SUPERSEDED (bm71)

> **Superseded by bm71 (built 2026-10-16).** The Usage annex, its partial and its CSS are deleted from v1; the per-polygon detail pages in §10d replace them. The rest of this section is the historical record.

A capacity offering's posted invoice PDF (rendered from the layout `shell.hbs` + generated template — print CSS, **not** an app screen) carries a per-polygon usage appendix below the charge lines. It introduces **no new token** and follows the module's existing table conventions (§6b/§8/§9):

| Element                                 | Treatment                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appendix rows (one per polygon)         | Print data grid — `--radius-none` `0`, `--text-body-sm`, `font-variant-numeric: tabular-nums` on the usage-volume and rated-amount columns             |
| State / district section headers        | `--text-overline` labels; grouped **state → district → polygon** (state/district joined from the `productCardLookUp` ratecard, never from `udr_rated`) |
| Per-district / per-state / line totals  | `--text-body-sm`, tabular-nums, right-aligned; money via `formatCurrency` (code-standards §4.4)                                                        |
| A polygon with no matching ratecard row | Surfaced inline (never dropped), flagged in the **Info** family (`--color-info-*`) — informational, not danger                                         |
| Volume                                  | Per-polygon only (no district summarisation), bounded **≤ 10,000 rows/account**; paginate within that bound                                            |

No new color, typography, radius, or shadow token — the appendix is print CSS in the invoice template, reusing the shared families and the §8/§9 tabular/square-grid rules.

**Invoice Template update:** Part 2 moves this appendix into the generated layout as the optional **Usage annex** section and adds per-district and per-state **subtotal rows** (semibold, top rule `#E0E4EB`, tabular-nums), following the §10c print palette.

**bm49 — the annex is now itemised billed records, state → district (X1/X2 closed, R9).** bm49 replaces the per-polygon snapshot design above with the delivered shape: the Usage annex lists **every billed `udr_rated` row** for the account (one row per record: Date, Cell, UDR type, Quantity, Unit, Rated amount) grouped **state → district**, with per-district and per-state subtotal rows and a grand total ("Total rated usage") that equals the bill's rated usage. Geo (`state`/`district`) is read **off `udr_rated`** (bm48, R9), never from a ratecard query; a row without geo is shown under an **"Unassigned region"** state group (district label "—"), never dropped. The 8pt/11pt table, tabular-nums on the numeric columns, overline state/district headers, and the semibold `#E0E4EB`-ruled subtotal rows are unchanged from above (as built, that annex CSS exists only in the seeded `generated/INVOICE/v1/invoice.hbs`; see the gap note below); `thead` repeats, a state's `tbody` may span pages (no `break-inside: avoid`), and only the subtotal row pairs use `break-before: avoid`. Bounded to **10,000 rows/account** (bm45's load-tested cap); over the bound the render fails `INVOICE_USAGE_OVER_LIMIT` and the account parks. No new token.

**Superseded by Invoice Template Phase 3 (built, bm71).** The rewritten v1 removes the Usage annex. Per-polygon detail moves into `chargeDetails`, grouped type of service → State-District, with rows built from `udr_key`/`udr_resource` (§10d). Everything in this §6d describes the bm49 annex that bm71 retired.

⚠ Code gap (2026-10-12): the layout `shell.hbs` has no `.annex` / `table.usage` rules and the generator does not inject them, so any template **generated on Activate** renders the Usage annex unstyled (9pt body, no subtotal/header styling). Only the seeded `generated/INVOICE/v1` carries the styling. Tracked in billmgmt-known-issues.md §20 (fix in layout v2).

**bm47 behavior change — renders on the draft too.** The binder has one bind path for both the draft PRO-FORMA preview and the final posted invoice (bm47-spec D1), so the Usage annex section now renders on **both**. "Final only" above described the legacy hardcoded template (the string builders in `render-invoice-template.ts`, deleted in bm47; the file remains as the binder's entry point), not a durable product rule — Part 2 overview Core flow 5 always intended the full layout to render on the draft.

## 7. Accent, CTA & destructive usage

**Featured-action colour — Bill Run overrides the platform magenta.** For this money-moving, four-eyes module the platform `--action-cta-bg` magenta (`#E6007E`) reads as consumer-marketing energy, not the gravity a bill run warrants. Bill Run therefore defines **one module-scoped accent** — **"Deep Petrol"**, the brand's deepest connectivity teal — and uses it for the featured action in place of the magenta. This does **not** redefine the shared `--action-cta-bg`; every other module keeps magenta.

```css
/* globals.css — Bill Run-scoped featured accent; NOT a redefinition of the shared CTA token */
--billrun-cta-bg: #006975; /* Deep Petrol — brand cyan-700 */
--billrun-cta-bg-hover: #00525c; /* darkened petrol */
--billrun-cta-bg-active: #003e46; /* pressed */
--billrun-cta-text: #ffffff; /* AA on the petrol fill */
```

| Purpose                                                   | Token / hex                                                                      | Rule                                                                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Featured **Run** CTA (one per screen)                     | `--billrun-cta-bg` `#006975` → hover `#00525C`, active `#003E46`, text `#FFFFFF` | **Deep Petrol** — a toned-down, premium jewel tone. Use **once** per screen — the "Run" action on an operable run card. Every other action (Rerun, Check status, tab controls) uses the quieter primary/secondary/ghost treatment. |
| Featured **Activate** (Invoice Settings, one per screen) | `--billrun-cta-*` (same Deep Petrol values) | Activation changes the invoices of every bill run started after it, including the bank details customers pay into, so it carries the same weight as Run. It uses petrol, not the platform magenta. **Save draft** is secondary, and **Upload logo** is secondary. The dialog's confirm button is primary indigo, enabled only once a change note is entered. |
| Primary buttons (Trigger/Rerun dialog confirm, Save)      | `--action-primary-bg` `#2E45A9`                                                  | Standard indigo primary — the featured petrol outranks it, so a screen has at most one petrol button and any number of indigo ones.                                                                                                |
| **Invoice Template Types:** Create type, Upload layout package, Export | `--action-primary-bg` `#2E45A9` (Create, Upload); Export is an outline/secondary link in Version history | Primary indigo, never petrol. On a type's detail page **Activate stays the one petrol button**, because it is what changes customers' invoices; Upload only creates a DRAFT. |
| **Invoice Template Types:** Overwrite draft, Retire type (confirms) | Danger role, `--color-danger-500` `#D92D2D`, **inside the `AlertDialog` only** | The page-level triggers ("Upload layout package", "Retire type…") are not danger-styled; only the confirm inside the dialog is. Retire's confirm stays disabled until the typed name matches. Same rule as Cancel run. |
| **Approve & Post** confirm (irreversible)                 | Danger role — `--color-danger-500` `#D92D2D`                                     | The money-gate confirm sits in the danger role **inside its confirmation dialog only**; the self-approval block renders disabled with its reason.                                                                                  |
| Cancel run confirm                                        | Danger role, inside the spelled-out confirm dialog                               | Never a bare row action.                                                                                                                                                                                                           |
| AI accent (`--ai-*`, `--gradient-ai`)                     | —                                                                                | **Not used** — this module has no AI features (architecture §5).                                                                                                                                                                   |
| Marketing gradients (`--gradient-brand`, `--gradient-5g`) | —                                                                                | Not used on these data-dense screens; keep tables/forms flat (shared §4).                                                                                                                                                          |

**Alternative — maximum restraint (zero new hues).** If you'd rather not add a module accent at all, give the "Run" action the deep brand indigo instead: base `--color-primary-600` `#233686`, hover `--color-primary-700` `#1B2A68` (both existing tokens). "Run" then becomes a deeper, weightier version of the standard primary rather than a distinct accent — the most conservative, brand-pure option. Deep Petrol is the recommendation because it keeps the featured action visually distinct from the many indigo buttons on the run pages while still reading premium and calm.

## 8. Typography delta (inherits shared §5)

| Concern                                                                                    | Token                                                                      | Rule                                                                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| IDs — `BRN`/`BRA`/`BRS`/`CBL`/**`BLN`**/`CBT`/`BTV` and the posted invoice number (`INV…`) | `--text-mono` (`--font-mono`, IBM Plex Mono)                               | All run/account/bill/invoice IDs render mono, per shared §5.                                                                        |
| Money columns (line `gross`/`discount`/`net`, subtotal, tax, totals, run total)            | `--text-body` / `--text-body-sm` with `font-variant-numeric: tabular-nums` | Every currency/numeric column uses tabular figures so bill amounts align; format via `lib/` `formatCurrency` (code-standards §4.4). |
| Dates (`gl_event_at`, `period_*`, `payment_due_date`, timeline `*_at`)                     | `--text-body-sm` / `--text-caption`                                        | Via `formatDatetime`; `<time dateTime>` stays ISO-8601 UTC.                                                                         |
| Table headers, badge labels                                                                | `--text-overline`                                                          | Unchanged from shared.                                                                                                              |
| Invoice Settings IDs and values: layout code (`INVTPL-STD-A4`), version IDs (`INVASV…`, `v{n}`), checksums, `#RRGGBB` colour inputs, the Generated .hbs viewer | `--text-mono`                                                              | Mono, like every other ID. Checksums are truncated with a copy button. "Used by N invoices" uses tabular-nums. |
| **Invoice Template Types:** type code (`WHOLESALE`), layout code (`INVTPL-WHOLESALE`), "Next layout version" (`v{n}`), export file name (`INVTPL-WHOLESALE-v3-s4.zip`), upload problem file paths and codes (`partials/billTo.hbs`, `LAYOUT_EXTERNAL_FETCH`) | `--text-mono` | Mono, like every other ID. The type **name** is ordinary text (`--text-body`; `--text-h2` in the detail heading). |

## 9. Border radius delta (inherits shared §6)

| Element                                                                 | Token / value                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Run list / account / uncharged / errors / **bill line** tables          | `--radius-none` `0` (data grids stay square)                                                          |
| Status/category badges & pills                                          | `--radius-pill` `9999px`                                                                              |
| Run **action cards** (Current & Upcoming), pre-approval checklist panel | `--radius-md` `6px` (default)                                                                         |
| Trigger / Rerun / Cancel / Approve / Reject / Force-complete confirms   | `rounded-md` `6px` — as built these are **inline confirm panels**, not modals (`role="alertdialog"`; Rerun and Reject use `role="group"`); Force-complete has a danger-500 border |
| Stall banner                                                            | `--radius-sm` `4px` (full-width bar, minimal rounding) — the stub/placeholder banner is retired (D31) |
| `udr_rated` drill-down disclosure panel                                 | `--radius-sm` `4px` on `--surface-sunken`                                                             |
| Invoice Settings form cards                                             | `--radius-md` `6px`                                                                                   |
| Logo dropzone                                                           | Square (`0`) as built — no rounded class in `logo-upload-field.tsx`                                   |
| Live preview frame (`InvoicePreviewFrame`), Version history table       | `--radius-none` `0` (the frame is a sheet of paper, and the table is a data grid)                     |
| Generated .hbs viewer                                                   | `--radius-sm` `4px` on `--surface-sunken`                                                             |
| `ActivateVersionDialog`                                                 | `rounded-xl` `12px` — inherited from the shared `DialogContent` (`components/ui/dialog.tsx`)          |
| **Invoice Template Types:** type list table                             | `--radius-none` `0` (data grid)                                                                       |
| **Invoice Template Types:** Create type, Upload, Overwrite, Retire dialogs | `rounded-xl` `12px`, inherited from `components/ui/dialog.tsx` / `alert-dialog.tsx` as built; never overridden |
| **Invoice Template Types:** upload problems alert                       | `rounded-lg` `8px`, inherited from `components/ui/alert.tsx` as built                                 |
| Invoice **document** (print)                                            | Square throughout (`0`); the logo is never clipped or rounded                                         |

No new radius, shadow, or elevation tokens — shared §6/§7 apply as-is.

## 10. Invoice Settings (Administration) — Invoice Template update, 2026-10-07

### 10a. Version status → token family (`TemplateVersionStatus` → `TemplateVersionStatusBadge`)

One badge serves both template and company-profile versions (code-standards › Invoice Template deltas, UI rule 7). Never fork it.

| Domain state                             | Family                              | Base / hex                      | Text (`-fg`) / hex              | Tint (`-bg`) / hex                        |
| ---------------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------- | ----------------------------------------- |
| `DRAFT` (saved, never used on invoices)  | Neutral (outline)                   | `--color-neutral-500` `#6A7283` | `--color-neutral-700` `#353B46` | `--surface-card` `#FFFFFF` (outline only) |
| `ACTIVE` (used by new invoices)          | Success                             | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`            |
| `RETIRED` (kept, still pinned by issued invoices) | Neutral (muted, terminal)  | `--text-disabled` `#99A1B0`     | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4`           |
| `Default` chip (`is_default`, alongside the status) | Primary (outline) + `Lock` icon | `--color-primary-500` `#2E45A9` | `--color-primary-700` `#1B2A68` | `--surface-card` `#FFFFFF` (outline only) |

`RETIRED` is muted, never danger: retiring a version is the normal result of activating its successor.

**Invoice Template Types (planned): type status on the type list and detail heading.** The same `TemplateVersionStatusBadge`, with three more states. Never a second badge component.

| Type state (derived, never stored) | Family (reuses the row above) | Base / hex | Text (`-fg`) / hex | Tint (`-bg`) / hex |
| --- | --- | --- | --- | --- |
| `USABLE` (has an ACTIVE version, not retired) | Success, as `ACTIVE` | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC` |
| `NOT_YET_USABLE` (no ACTIVE version yet) | Neutral outline, as `DRAFT` | `--color-neutral-500` `#6A7283` | `--color-neutral-700` `#353B46` | `--surface-card` `#FFFFFF` (outline only) |
| `RETIRED` (type retired; history kept) | Neutral muted, as `RETIRED` | `--text-disabled` `#99A1B0` | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |
| `Default` chip on Standard | Primary outline + `Lock` icon, as the `Default` chip above | `--color-primary-500` `#2E45A9` | `--color-primary-700` `#1B2A68` | `--surface-card` `#FFFFFF` (outline only) |

A retired **type** is muted, never danger: it is a deliberate, completed action.

### 10b. Editor and profile screen elements

| Element                                                   | Treatment                                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory section (locked on)                             | Checked + disabled checkbox, `Lock` icon, "Required" label in `--text-muted`. The label stays `--text-body` (not `--text-disabled`), so a locked-on section never looks switched off. |
| Optional section / column checkbox                        | Standard shared checkbox (`--radius-xs`, checked fill `--action-primary-bg`)                                                                                                                 |
| "Show placeholders" overlay                               | **Cyan** family: tint `--color-cyan-50` `#E2F8FA`, text `--color-cyan-700` `#006975`, mono label (e.g. `company.tin`). A data-source annotation, not a status                                 |
| "Outline" overlay                                         | 1px dashed `--color-neutral-400` `#99A1B0` around each section box                                                                                                                            |
| Hidden optional section in the preview                    | **Absent**, with no ghost or placeholder box. The gap closes, as the generated `.hbs` does                                                                                                     |
| Logo dropzone                                             | `--surface-sunken`, 1px dashed `--border-strong` `#CAD0DA`, focus `--focus-ring`. A rejection (`LOGO_REJECTED`) shows inline in Danger `-fg` with the specific reason                          |
| Missing logo on activate (`PROFILE_LOGO_REQUIRED`)        | Inline Danger message by the dropzone. **Activate** stays enabled, and the server error is shown, because the rule is enforced server-side                                                    |
| Colour fields (`brandColor`, `accentColor`)               | Mono `#RRGGBB` input plus a 20×20 swatch (`--radius-xs`, `--border-default`). **Recommended:** a non-blocking **Warning** hint when white text on the brand colour is below 4.5:1 contrast        |
| Bank details changed vs the ACTIVE version                | **Warning** family callout in `ActivateVersionDialog` ("Bank details change on every new invoice"). This addresses the single-signature gap in the architecture without adding a new hue      |
| Read-only view (READ without EDIT)                        | Fields render as text, with no disabled-input grey wash. Save, Activate and Upload are not rendered                                                                                          |
| Company profile empty state (no ACTIVE profile) | **Info** alert, no action for READ: "No company profile is active. Invoices are issued without the issuer and payment blocks until a profile is activated." EDIT users get a "Create a draft" outline button (built in bm59) that focuses the empty edit form below the alert |
| Preview loading, queued and error states                  | Reuse the §6c PDF skeleton and captions as they are                                                                                                                                           |
| **Phase 3:** page heading                                 | "Invoice template — Standard (default)" in `--text-h2`; "(default)" in `--text-muted`. No family switcher: only Standard exists (D45). **Superseded by Invoice Template Types (§10e):** the page becomes a type list, and each type's detail page is headed "Invoice template type — {name}", with "(default)" only on Standard |
| **Phase 3:** section toggles                              | One optional checkbox, **Payment information**. The Usage annex and Notes rows and all four column toggles are removed (D56); the mandatory sections keep the locked row above |
| **Phase 3:** Footnote field                               | Group label "Footnote", hint "Printed after Total Amount on the last page" in `--text-muted`. 1–5 single-line inputs (`--radius-sm`), each with a visible label "Line 1"…"Line 5" and a `0/200` counter in `--text-caption`; an outline **Add line** button (`Plus`) is hidden at 5 lines, and a ghost icon button (`X`, `aria-label="Remove line N"`) is hidden at 1 line. Errors show under the line in Danger `-fg` |
| **Phase 3:** footnote in READ view                        | The lines render as plain text in a list, with no inputs |
| **Phase 3:** Activate dialog summary                      | Lists `+ Payment information shown` / `− Payment information hidden` and `Footnote: "old" → "new"` per changed line (mono quotes), or "No change in structure." |

**Phase 3 rows confirmed as built (bm72).**
- **Heading.** "Invoice template — Standard (default)": the family name comes from the page data, and "(default)" is in `--text-muted`. The version number (`v{n}`, mono) and the status badge follow it.
- **Toggles.** Payment information is the only checkbox, and the locked mandatory rows are unchanged.
- **Footnote field.** A `<fieldset>` with the legend "Footnote" and the hint. Each line has a `<Label>` "Line N", an `Input` (`rounded-sm`) and an `n/200` counter that turns Danger `-fg` (`--color-danger-700`) past 200. The ghost `X` button (`aria-label="Remove line N"`) is hidden at one line, and the outline **Add line** (`Plus`) is hidden at five. The schema's messages show under the line (`role="alert"`, Danger `-fg`), and the input carries `aria-invalid`.
- **READ view.** A `<ul aria-label="Footnote lines">`.
- **Activate dialog.** Each footnote change reads `Footnote line N: "old" → "new"`, `Footnote line N added: "…"` or `Footnote line N removed`, with the values in mono quotes (`StructureChangeSummary`, `activate-version-dialog.tsx`). This is the row's per-line wording, with the line number.
- **Preview.** It does not refresh while a line is invalid; the last good preview stays.

**Confirmed as built (bm55).** The preview service appends one
`<style data-preview="true">` to the rendered document. It is never part of a
stored file. On "Show placeholders" it adds
`.ph { background:#E2F8FA; color:#006975 }` (the cyan-50 / cyan-700 hexes
above), and the generator wraps each text-content placeholder in
`<span class="ph" data-ph="…">`. The mono label is the `data-ph` attribute.
On "Outline" it adds `.sec { outline:1px dashed #99A1B0 }`. These are raw hex
because the iframe document cannot use app tokens (§10c).

A posted bill previews its stored, stamped template. That template is not
regenerated, so only the outline applies to it, and the form shows a
"Showing as issued under template vN" Info-family status line. The frame is
`<iframe sandbox="" srcDoc>`, A4-proportioned (`aspect-[210/297]`) and square.

The read-only view renders "Shown"/"Hidden" as text, and mandatory sections
keep their `Lock` "Required" mark. Neither Save nor Activate is rendered in
bm55.

**Save draft (bm57).** An EDIT user sees an outline **Save draft** button
right-aligned under the form. It is disabled while the structure equals the
last saved one and while a save is in flight. Success is a toast "Draft v{n}
saved — not used on invoices". `DRAFT_CONFLICT` is a Warning toast with a
**Reload** action. A refused mandatory section shows Danger text under that
row. When the page opens on the working draft, a neutral Info line above the
form reads "Editing draft v{n} — saved {relative time} by {user}. Drafts are
never used on invoices." READ users never see the draft on the edit tab. In
Version history the DRAFT row shows the Draft badge, "—" for activated and
retired, and no download.

**Company profile Save draft (bm59).** EDIT users get the editable form
(Company, Payment, Branding, Defaults; mono inputs for IDs, account no. and
colours; State is a `Select` of the 16 MyInvois codes; Country is read-only
`Malaysia (MY)`; the logo shows read-only until bm60). Optional fields are
labelled "(optional)", and SST no. carries the hint "Hidden on the invoice
when blank". Each colour field has the 20×20 swatch and, when white text on it
is below 4.5:1, a non-blocking Warning-family hint (`TriangleAlert`,
`--color-warning-700`) naming the ratio; it never blocks the save. Invalid
formats show the schema's message under the field (the same text the server
returns). The outline **Save draft** button sits right-aligned under the form,
disabled while pristine or saving; success is a toast "Draft profile v{n}
saved — not used on invoices". A save that changes nothing once trimmed and
normalised ("Acme " → "Acme") is an Info toast "No changes — nothing was
saved." (no write, no audit). `DRAFT_CONFLICT` is the Warning toast with
**Reload**. The page opens EDIT users on the working draft (the bm57 "Editing
draft v{n} — saved … by …" Info line), else the ACTIVE values, else empty
fields under the empty-state alert, whose **Create a draft** action focuses the
first field. While a draft exists, other versions are read-only with an "Edit
draft v{n}" link.

**Logo upload (bm60).** `LogoUploadField` sits in the Branding group as
built: the dropzone (`--surface-sunken`, dashed `--border-strong`, the focus
ring on `focus-within`) shows the stored logo through the GET route (never a
`blob:` URL), a caption "PNG, JPEG or SVG, up to 500 KB, at least 300 px on
the shorter side and at most 2,000 px on either side", and an outline **Choose file** button (the file input is
visually hidden and the button is the keyboard path). It is disabled with
"Save the draft first." when no draft exists, and with "Save your changes
first." while the form has unsaved edits (an upload re-renders the form on the
draft's new token). A rejection shows inline in Danger (`--color-danger-700`)
with its reason ("The image is 200×900 px; the shorter side must be at least
300 px.", "The image is 2400×900 px; each side must be at most 2,000 px.", "The SVG contains <script>, which is not allowed."). Success is a
toast "Logo v{n} added to draft v{m}"; `DRAFT_CONFLICT` is the Warning toast
with **Reload**. A ghost **Use the current app logo** button appears only
while no logo asset exists (D8).

**Company profile Activate (bm61).** On the working draft only, EDIT users get
the Deep Petrol **Activate v{n}** button beside the outline Save draft (§7: the
one Deep Petrol button). It reads "Save draft first" and is disabled while the
form has unsaved edits. It opens the shared `ActivateVersionDialog`. Its
summary lists every field that differs from the ACTIVE version as
`label: old → new` (mono values, account numbers in full; "No change from the
active profile." when none). When any payment field differs, including the first
activation, the Warning callout reads "Bank details change for bill runs started from now on.
Customers will be asked to pay into the new account from the next bill run." A
server refusal shows inline in Danger in the dialog. `PROFILE_LOGO_REQUIRED`
also shows inline by the logo field, and Activate stays enabled. There is no
four-eyes refusal (G14 decided 2026-10-11). Success is a toast "Company profile
v{n} activated".

**Activate (bm58).** The page-level **Activate v{n}** button is the one Deep Petrol
button on the screen (§7). It is enabled only when a saved draft exists and the
form has no unsaved edits; with edits it reads "Save draft first", and with no
draft it is disabled. It opens `ActivateVersionDialog`: a summary of what
changes against the version in use (`+ Usage annex shown`, `− Discount column
hidden`, or "No change in structure."), an optional Warning callout, and a
required change-note field with a 500-character counter. The dialog's confirm
button is the standard **primary (indigo)** button and stays **disabled until a
note is entered** (owner decision 2026-10-10, following §7; the bm58 spec's
wording for this button was overruled). A server refusal renders inline in
Danger. Version history captions the non-default ACTIVE version "In use for new
invoices" and the default "Fallback" while a non-default version is in use.

### 10c. Invoice document palette and typography (print — not app tokens)

The invoice is print CSS in the layout's `shell.hbs` (code-standards › Invoice Template deltas, rendering rule 1). It **cannot** use `globals.css` variables or Tailwind. The layout defines its own `--inv-*` custom properties. The fixed values below reuse shared hexes so the invoice reads as the same family as the app. Only the two profile colours are admin-controlled.

| Layout variable      | Value                                     | Source                                | Use                                                         |
| -------------------- | ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `--inv-brand`        | `{{company.brandColor}}`                  | Company profile (admin)               | Title, section headings, table header rule, total-due band  |
| `--inv-accent`       | `{{company.accentColor}}`                 | Company profile (admin)               | Thin accent rules and the amount-due highlight only, never body text |
| `--inv-ink`          | `#11141A`                                 | shared neutral-900                    | Headings, amounts                                           |
| `--inv-body`         | `#353B46`                                 | shared neutral-700                    | Body and table cells                                        |
| `--inv-muted`        | `#6A7283`                                 | shared neutral-500                    | Labels, captions, the page footer                           |
| `--inv-line`         | `#E0E4EB`                                 | shared neutral-200                    | Table rules, subtotal rules                                 |
| `--inv-soft`         | `#F7F8FA`                                 | shared neutral-50                     | Zebra rows, the amount-due panel fill                       |
| `--inv-on-brand`     | `#FFFFFF`                                 | shared `--text-on-brand`              | Text on a brand-filled band                                 |
| `--inv-watermark`    | `#D92D2D` at opacity `0.14`               | shared danger-500                     | Draft watermark only (§6c)                                  |

**Recommended v1 seed values:** brand `#2E45A9` (primary-500) and accent `#006975` (cyan-700 / Deep Petrol). Both pass AA with white text. The sample-data values (`#12355B` / `#1F9E89`) are only fixture data. Admins may change them.

**Typography (closes O4 if accepted):** fonts are fixed and **embedded** in the layout as base64 `@font-face`, so a render never fetches a font (Inv #47). The legacy template's Arial is replaced. Use IBM Plex Sans 400/600 for text and IBM Plex Mono 400 for IDs, both OFL-licensed and the same faces as the app.

**Superseded by bm70 (§10d):** the rewritten v1 embeds the fonts. **As built before bm70 (layout v1): fonts are not embedded.** `shell.hbs` declares the three `@font-face` rules but their `src` lines are commented placeholders, and `fonts/` holds only `OFL.txt`. Renders fall back to Arial/Helvetica (text) and Courier New (mono); no font is fetched. Open follow-up for layout v2 (billmgmt-known-issues.md §23e).

| Role                                         | Size / line height | Weight | Notes                                         |
| -------------------------------------------- | ------------------ | ------ | --------------------------------------------- |
| Document title ("TAX INVOICE")               | 16pt / 20pt        | 600    | `--inv-brand`                                 |
| Section heading                              | 9pt / 12pt         | 600    | Uppercase, +0.06em, as shared `--text-overline` |
| Body, bill-to, issuer block                  | 9pt / 13pt         | 400    | `--inv-body`                                  |
| Charge-detail and usage tables               | 8pt / 11pt         | 400    | tabular-nums on every numeric column, right-aligned |
| Amount due                                   | 14pt / 18pt        | 600    | tabular-nums                                  |
| INV no., BAN, offering ID, SSM / TIN / SST   | 8.5pt / 12pt       | 400    | IBM Plex Mono                                 |
| Page footer ("Page X of Y")                  | 7.5pt / 10pt       | 400    | `--inv-muted`                                 |

Weights stay at 400 and 600 only (shared §5). The CSV output has no styling.

### 10d. Invoice document — Standard layout v1 rewrite (Invoice Template Phase 3, delivered bm70–bm72)

Print CSS in the rewritten v1 `shell.hbs` and partials. It uses the §10c `--inv-*` variables **only** and adds no new one. The business mockup (`mockup-invoice-layout-v2.html`) sets the arrangement, **not** the tokens: its `#12355B` is sample brand data (the admin's `--inv-brand` replaces it), and its weight 700 maps to 600.

**Fonts:** IBM Plex Sans 400/600 and IBM Plex Mono 400 are **embedded** in the rewritten v1 as base64 `@font-face`. This supersedes §10c's "As built (layout v1): fonts are not embedded" and closes known-issues §23e.

| Element | Size / line height | Weight | Treatment |
| --- | --- | --- | --- |
| Document title "Invoice" | 16pt / 20pt | 600 | `--inv-brand`, under the logo |
| Recipient name (omitted if blank) | 9pt / 13pt | 600 | `--inv-ink`, first line of the bill-to block |
| Type-of-service block heading (page 1, one per type) | 9pt / 12pt | 600 | Uppercase, +0.06em, `--inv-brand`; a 1px `--inv-line` rule under it |
| Utilised / Unutilised / Total rows | 9pt / 13pt | 400; Total 600 | Label left, amount right, tabular-nums; Total sits on a 1px `--inv-line` top rule |
| "Other charges" block (absent when empty) | 9pt / 13pt | 400; Sub Total 600 | Same row pattern: Description left, Amount right |
| Total charges · Adjustments · Tax @ x% | 9pt / 13pt | 400 | Amount rows; Adjustments always shown, `0.00` included |
| Grand Total (the amount due) | 14pt / 18pt | 600 | `--inv-soft` panel with an `--inv-accent` left rule, tabular-nums; carries the fixed "current charges only" line in 8pt `--inv-muted` (Inv #50) |
| Detail page heading (each type starts a new page) | 12pt / 16pt | 600 | Type name in `--inv-brand`; "Access Seeker: {name}" beneath in 9pt 400 `--inv-body` |
| State-District group label row (repeats on every page via `<thead>`) | 9pt / 12pt | 600 | Uppercase, `--inv-ink` on `--inv-soft` fill; label `STATE - DISTRICT`, one part, or "Unassigned region". No "(continued)" text |
| Detail column header row (repeats with the label) | 8pt / 11pt | 600 | `--inv-muted`; numeric headers right-aligned; 1px `--inv-line` bottom rule |
| Detail rows: Polygon Start Date · Polygon Name · Capacity (Mbps) · Rate/Mbps (MYR) · Utilised Capacity Charges (MYR) | 8pt / 11pt | 400 | Polygon Name in IBM Plex Mono; numbers right-aligned, tabular-nums; dates DD/MM/YYYY; Mbps whole or 2 dp; rows never split (`break-inside: avoid`) |
| Group Sub Total row | 8pt / 11pt | 600 | 1px `--inv-line` top rule, amount right-aligned |
| Total Amount page heading "Summary of Utilised Capacity Charges" | 12pt / 16pt | 600 | `--inv-brand`; the page starts with `break-before: page` |
| Total Amount | 12pt / 16pt | 600 | `--inv-ink` with a 1px `--inv-line` top rule. **Never** the `--inv-soft`/`--inv-accent` amount-due panel, so it cannot be read as the amount due (architecture P10) |
| Footnote lines | 8pt / 11pt | 400 | `--inv-muted`, one paragraph per line, after Total Amount |
| Page footer "Page X of Y" | 7.5pt / 10pt | 400 | `--inv-muted`, **right-aligned** (was centred) |

**As built (bm70), page 1:** the title, supplier block (D102), recipient line, type-of-service blocks, "Other charges", Total charges · Adjustments · Tax @ x% and the Grand Total rows above are confirmed in the rewritten v1 (`.svc-block`, `.svc-heading`, `.svc-row`, `.svc-total`, `.other-charges`, `.totals-row`, `.grand-total-panel`). The panel's left rule is 3px `--inv-accent`. The identification block also prints the due date (D60 table row 2). The detail-page, Total Amount, footnote and right-aligned footer rows are bm71/bm72.

**As built (bm71), detail pages:** `chargeDetails` holds one `<section class="detail-type" style="break-before: page">` per type of service (`.detail-heading`, `.access-seeker`), then one `table.detail-group` per State-District group whose `thead` carries the `tr.group-label` row and the `tr.col-head` row, and a `tr.subtotal` Sub Total row. `tr { break-inside: avoid }`, `.detail-group { break-inside: auto }`, `thead { display: table-header-group }`; Polygon Name uses `.mono`. A type with no claimed row prints its heading and "No utilised capacity this period." (`.no-usage`, `--inv-muted`). The rate column uses `money` (2 decimals, read at 2 decimals in SQL), so it prints as "RM 100.00" like the amount column. The footer's "Page X of Y" span is `text-align: right` (it already sat last in the footer's flex row). The Total Amount page and footnote rows are bm72.

**As built (bm72), last page:** `chargeDetails` ends with `<section class="total-amount-page" style="break-before: page">`. It holds the `.detail-heading` "Summary of Utilised Capacity Charges", then `.total-amount` ("Total Amount" and `{{money totals.totalAmount}}` in a right-aligned tabular-nums `.num`): 12pt/16pt 600 `--inv-ink` with a 1px `--inv-line` top rule, outside `.grand-total-panel` and with no `--inv-soft`/`--inv-accent`. Last comes `.footnote`, one `<p>` per line at 8pt/11pt 400 `--inv-muted`, omitted when there are no lines. There is no per-type breakdown (D60), and the page prints "RM 0.00" when the bill has no capacity line. The "Notes & terms" section is gone.

No colour signals sign or status on the invoice. Unutilised is a normal amount, not a warning. A negative Utilised can never print (Inv #55). The draft watermark (§6c, `--inv-watermark`) is unchanged.

**Park and skip reasons in the app** reuse existing surfaces and families, with no new token or component:

| Code | Where it shows | Family and copy |
| --- | --- | --- |
| `INVOICE_POLYGON_DATA_MISSING` | Draft preview error (§6c); `RenderPendingRow` | Danger `-fg`: "Polygon data is missing for a billed record (no polygon ID or region). Fix the rated data and rerun this account." **Confirmed (bm71)** in `describeInvoiceRenderCode`. |
| `INVOICE_NEGATIVE_UTILISED` | Same | Danger `-fg`: "Utilised capacity charges came out negative. Check the rate-matching setting and rerun this account." **Confirmed (bm70)** in `describeInvoiceRenderCode`. |
| `INVOICE_RECONCILIATION_FAILED` | Same (existing code) | Draft preview (bm66): Danger `-fg`: "The invoice lines do not add up to the bill total. Rerun this account; if it repeats, report it." `RenderPendingRow` keeps its own retry text. |
| `INVOICE_USAGE_OVER_LIMIT` | Same (existing code) | Draft preview (bm66): Danger `-fg`: "This account has more than 10,000 billed usage records, over the invoice limit." `RenderPendingRow` keeps its own retry text. |
| `TEMPLATE_VERSION_NOT_FOUND` (`FAMILY_HAS_NO_ACTIVE_VERSION`) | Draft preview error; at posting, the account shows the existing `SKIPPED` `AccountStatusBadge` with this reason (D58) | Danger `-fg`: "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account." |

**As built (bm66; review fix 2026-10-16):** the `TEMPLATE_VERSION_NOT_FOUND` copy above is shown only for its D55 reason (`detail.reason = FAMILY_HAS_NO_ACTIVE_VERSION`); any other cause (a missing blob, an uncaptured row) keeps the generic text. The route computes the message from the code and reason, and the modal shows the route's message. Posting progress lists an account posting skipped (zero total, or this reason at posting) with a neutral **Skipped** badge and its `error_detail`, counts it apart from "{n}/{N} posted", and its completion line names the skipped count. The approve page's blocking `template_versions_captured` check uses the existing failed-check row. The draft-preview copy lives in one map, `describeInvoiceRenderCode(code)` (`lib/invoice-render-messages.ts`), shared by the draft route's `422 { error: { code, message } }` body and `InvoicePreviewModal`. Any code without its own row keeps the generic "Could not render the draft invoice. Please try again." The modal keeps its existing error layout (Danger `-fg` text and Retry). bm70 and bm71 add the two `INVOICE_*` polygon/utilised rows to the map.

### 10e. Invoice template types — list, detail, upload, retire, export (Invoice Template Types update, planned)

Existing families only; strings are owned by `components/billing/invoice-settings/template-type-messages.ts` (code-standards › Invoice Template Types, Styling rule 6).

| Element | Treatment |
| --- | --- |
| Type list (`TemplateTypeList`) | Data grid (`--radius-none`). Columns: Name (`--text-body`), Status (§10a badge), Default chip on Standard, Bound BANs (tabular numerals), Active version (`v{n}` mono) and its date. A "Retired" filter toggle (shadcn `Toggle`, existing styling). |
| Type detail heading | "Invoice template type — {name}" in `--text-h2`, then the §10a status badge. Below it, a key–value row in `--text-body-sm`: **Layout code** and **Next layout version** (both mono). |
| Not-yet-usable type empty state | **Info** alert (`--color-info-50` / `--color-info-700`): "No layout uploaded yet. Upload a layout package to create the first draft." EDIT users see the **Upload layout package** button (primary) inside it. |
| Upload dialog, no open draft | Plain `Dialog`; confirm button "Create draft v{n}" (primary indigo). |
| Upload dialog, open draft (overwrite warning) | `AlertDialog` with a **Warning** family callout (`--color-warning-50` / `--color-warning-700`, `alert-triangle` icon) holding the exact warning text; confirm "Overwrite draft" in the danger role (§7). |
| Restore note (export with `settings.json`) | **Info** line inside the upload dialog: "The package's settings (Payment and footnote) will replace the draft settings." and "Restored from v{n}" (mono). |
| Upload problems | One **Danger** `Alert` (`--color-danger-50` / `--color-danger-700`, `alert-circle` icon), grouped by file (mono), each line `code` (mono) + message. Never a toast; it stays until the next upload attempt. |
| Draft changed since the warning | Same Danger alert pattern with the reason; the dialog reloads its draft data and shows the warning again. |
| "Layout was replaced by an upload" (settings save conflict) | **Warning** inline alert above the settings form with the exact text; the unsaved values stay in the inputs. |
| Retire dialog | `AlertDialog`: the bound-BAN count prominent (`--text-h3`, tabular numerals), a paginated BAN list (mono ids), a target `Select` (usable types; Standard first and preselected), a typed-name `Input`; confirm "Retire type" in the danger role, disabled until the name matches. |
| Retired type, detail page | **Info** status line "Retired {date}. History and exports remain available."; no Upload, Save, Activate or Retire control. Export stays available. |
| Export link in Version history | Outline/ghost link "Export" per version row; downloads `{layout_code}-v{n}-s{m}.zip`. |
| READ-only user | Every EDIT control absent (not greyed); export visible. |

No new color, type, radius or shadow token. No AI accent. Status is never shown by color alone.

## 11. Implemented UI not covered above (as built, dev1 614743a)

All on existing token families; no new token.

| Component / route | As built |
| ----------------- | -------- |
| `DistributionOutcomeBadge` | `DELIVERED` → Success (`CheckCircle2`, "Delivered"); `FAILED` → Danger (`XCircle`, "Failed") |
| `RunDetailTabs` (`run-detail-tabs.tsx`) | Tabs: Workflow, Customers & Bills, Uncharged, Errors, Distribution, Audit |
| `RunFlowProgress`, `PostingProgressView` | Run-flow and posting progress views. `RenderPendingRow` (inside `PostingProgressView`): "Invoice artifact render pending." in `--color-warning-700` plus an outline **Retry render** button (`RotateCcw`; "Retrying…" in flight) |
| `StartDistributionControl`, `RerunDistributionControl`, `ForceCompleteDistributionDialog` | Distribution controls; Force-complete is an inline confirm panel with a danger-500 border (§9) |
| `RejectDialog`, `AuditTable` | Inline reject panel (§9); the Audit tab's data grid |
| `BillRunsFilters`, `BillRunsPagination`, `BillRunsEmptyState` | Bill-runs list filters, pagination and empty state |
| `ExportRunsButton`, `ExportUnchargedButton` | Export buttons for the runs list and the Uncharged tab |
| `InvoiceSettingsTabs`, `GeneratedHbsViewer`, `ColourSwatch` | Section tabs (Company profile / Invoice template); read-only `.hbs` viewer (mono, `--radius-sm` on `--surface-sunken`); the 20×20 colour swatch |
| "Preview with" select (`invoice-structure-form.tsx`) | Preview source: **Sample bill** or one of the recent posted bills |
| `InvoicePreviewModal` stored-invoice **Download CSV** | Outline button (`FileSpreadsheet`, "Preparing CSV…" in flight), posted bills only; fetch + blob download |
| Bill-run routes | `bill-runs/[runId]/approve`, `bill-runs/[runId]/draft-invoice/[banId]`, `bill-runs/[runId]/stored-invoice/[banId]`, `bill-runs/[runId]/stored-invoice/[banId]/csv` |
| Invoice Settings routes | `company-profile/logo/[assetVersionId]`, `invoice-template/versions/[versionId]/files/[file]`; `?tab=` selects the tab (template: `edit`/`generated`/`history`; company profile: `edit`/`history`; default `edit`) |
