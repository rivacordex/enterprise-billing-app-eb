# Billing Management (Bill Run) — UI Context (Module Delta)

This file **inherits `context/ui-context.md` unchanged** and only maps Bill Run domain objects onto the shared token families; it **redefines no shared color, type, radius, or shadow token**. The one new hue it introduces is the module-scoped **Deep Petrol** featured-action accent (`--billrun-cta-*`) defined in §7 — a scoped accent that overrides no shared token, permitted under shared doc §3.4's module-accent allowance. Every hex in §§1–6 is an existing shared token shown for reference — wire badges to the semantic tokens, never to raw hex (code-standards §4.3). **This module ships no AI/ML features (architecture §5), so the `--ai-*` scale and `--gradient-ai` are not used here** — only the shared brand/status families.

**Phase-3 delta (minimal):** one retirement — `PlaceholderBanner`/`PlaceholderBadge` and their warning mapping are **deleted** with `BILLRUN_PLACEHOLDER_MODE` (D31); one new mapping — `ChargeSource` onto the **existing** cyan/primary families (§6); one correction — `EXCLUDED` was missing from §2; plus `BLN` in the mono-ID list and the bill-line table's radius/tabular rules. **No new color, type, radius or shadow token is introduced, and the Deep Petrol CTA in §7 is unchanged.**

**Target Capacity Pricing delta (minimal, 2026-10-04):** **no** new color, typography, radius, shadow, or accent token, and the module still ships **no AI** (`--ai-*`/`--gradient-ai` stay unused); the Deep Petrol CTA (§7) is unchanged. Two UI touches only: (1) the `discount_amount` column now **renders** once a capacity **motivation** line carries a non-zero discount (§6b); (2) the posted invoice PDF gains a **per-polygon usage appendix** grouped by state/district (§6d), using existing tokens. Sources: `_updatemodule-billing-billrun-target-capacity-plan.md`, `billmgmt-update-overview.md`, `billmgmt-architecture.md`.

**Invoice Template delta (minimal, 2026-10-07):** **no** new app color, type, radius or shadow token, and still **no AI**. Four UI touches: (1) two new Administration › Invoice Settings screens (Company profile, Invoice template) mapped onto existing families in **§10**, including the new `TemplateVersionStatusBadge`; (2) **Activate** on those screens takes the existing Deep Petrol featured accent (§7); (3) the invoice **document** gets its own print palette and typography, which sit **outside** the app token system and use shared hex values only as fixed layout CSS (§10c); (4) the PDF gains a "Page X of Y" footer, and the draft watermark stays `position:fixed` (§6c). Sources: `billmgmt-update-overview.md` Part 2, `billmgmt-architecture.md` › Invoice Template deltas, `billmgmt-code-standards.md` › Invoice Template deltas.

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
| `PENDING`             | Neutral                                                     | `--text-muted` `#6A7283`        | `--color-neutral-700` `#353B46` | `--color-neutral-100` `#EEF0F4` |
| `PROCESSING`          | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `PROCESSED`           | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `INVOICED`            | Success                                                     | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `DISTRIBUTING`        | Info                                                        | `--color-info-500` `#1A73D9`    | `--color-info-700` `#0C4084`    | `--color-info-50` `#E7F1FD`     |
| `COMPLETED`           | Success                                                     | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC`  |
| `PROCESSING_FAILED`   | Danger                                                      | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `DISTRIBUTION_FAILED` | Danger                                                      | `--color-danger-500` `#D92D2D`  | `--color-danger-700` `#8A1717`  | `--color-danger-50` `#FDEAEA`   |
| `SKIPPED`             | Neutral (muted — dropped at approval, no charge)            | `--text-disabled` `#99A1B0`     | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |
| `EXCLUDED`            | Neutral (muted — scoping-time exclusion, **not** a failure) | `--text-disabled` `#99A1B0`     | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |

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
| `USAGE` (claimed from `rating.udr_rated`)      | Cyan — "measured traffic"       | `--color-cyan-500` `#00A9BC`                                              | `--color-cyan-700` `#006975`    | `--color-cyan-50` `#E2F8FA`    |
| `RECURRING` (derived from `product_inventory`) | Primary — "contractual, steady" | `--color-primary-500` `#2E45A9`                                           | `--color-primary-700` `#1B2A68` | `--color-primary-50` `#EDF0FB` |
| `OCC`                                          | —                               | **Not rendered** — reserved enum value with no producer this phase (D30). |

**§6 previously defined `PlaceholderBanner`/`PlaceholderBadge`. Both are RETIRED (D31)** along with `BILLRUN_PLACEHOLDER_MODE`; delete the components and their warning-family mapping. Nothing replaces them — see `billmgmt-code-standards.md` §4.2 for why a quieter "seeded data" badge is not substituted.

## 6b. Bill line table & the per-record drill-down (`BillLineTable`)

| Element                                                                      | Treatment                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Line rows                                                                    | Data grid — `--radius-none` `0`, `--text-body-sm`, `font-variant-numeric: tabular-nums` on all three money columns                                                                                                                                                                                                                   |
| `discount_amount` column                                                     | **Hidden while every line is `0.00`; renders once any line carries a non-zero discount.** The capacity **motivation** discount (Target Capacity update) is the first such case — a capacity line shows `discount_amount` (and `discount_rate`) in the existing money-column treatment (tabular-nums, `formatCurrency`). No new token |
| `udr_rated` drill-down (a `USAGE` row)                                       | Collapsed native `<details>` disclosure on `--surface-sunken` `#EEF0F4`, fetched **on expand only** — a `volume`-profile account sits behind thousands of records                                                                                                                                                                    |
| Price snapshot (a `RECURRING` row)                                           | Same disclosure slot, same sunken surface — the snapshot _is_ that row's evidence; there is no per-record drill-down behind it                                                                                                                                                                                                       |
| Per-record exception surface (`BILL_NOTUSED`, unresolvable subscriber — D32) | **Info** family — `--color-info-500` `#1A73D9`, text `--color-info-700` `#0C4084`, tint `--color-info-50` `#E7F1FD`. Informational, never danger: nothing failed and approval is not blocked                                                                                                                                         |

## 6c. Draft PRO-FORMA watermark & preview modal a11y (bm18, Phase-2 review folds T9/D-T2/D-T5)

**Watermark legibility.** The draft PDF's diagonal "DRAFT · PRO-FORMA · NOT A
VALID INVOICE" watermark (Danger family, `--color-danger-500` `#D92D2D`) must
never degrade the figures the reviewer opened the modal to validate (D-T5).
`services/billing/render-invoice-template.ts` resolves this structurally
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

**Invoice Template update (2026-10-07).** The watermark **stays `position:fixed`** (R5; the plan body's "move it to the page mechanism" is superseded). The new Chromium `footerTemplate` ("Page X of Y", `--text-caption`-equivalent 7.5pt, muted `#6A7283`) must sit in the bottom margin **without clipping** the watermark. A **parked** final render (checksum mismatch, compile failure, `Σ net ≠ subtotal`) reuses the existing `RenderPendingRow`: warning-700 status text, with the error reason in the destructive text color. There is no new badge, status or color for parking.

## 6d. Invoice usage appendix — per-polygon by state/district (Target Capacity, 2026-10-04)

A capacity offering's posted invoice PDF (rendered by `render-invoice-template.ts` — print CSS, **not** an app screen) carries a per-polygon usage appendix below the charge lines. It introduces **no new token** and follows the module's existing table conventions (§6b/§8/§9):

| Element                                 | Treatment                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appendix rows (one per polygon)         | Print data grid — `--radius-none` `0`, `--text-body-sm`, `font-variant-numeric: tabular-nums` on the usage-volume and rated-amount columns             |
| State / district section headers        | `--text-overline` labels; grouped **state → district → polygon** (state/district joined from the `productCardLookUp` ratecard, never from `udr_rated`) |
| Per-district / per-state / line totals  | `--text-body-sm`, tabular-nums, right-aligned; money via `formatCurrency` (code-standards §4.4)                                                        |
| A polygon with no matching ratecard row | Surfaced inline (never dropped), flagged in the **Info** family (`--color-info-*`) — informational, not danger                                         |
| Volume                                  | Per-polygon only (no district summarisation), bounded **≤ 10,000 rows/account**; paginate within that bound                                            |

No new color, typography, radius, or shadow token — the appendix is print CSS in the invoice template, reusing the shared families and the §8/§9 tabular/square-grid rules.

**Invoice Template update:** Part 2 moves this appendix into the generated layout as the optional **Usage annex** section and adds per-district and per-state **subtotal rows** (semibold, top rule `#E0E4EB`, tabular-nums), following the §10c print palette.

**bm49 — the annex is now itemised billed records, state → district (X1/X2 closed, R9).** bm49 replaces the per-polygon snapshot design above with the delivered shape: the Usage annex lists **every billed `udr_rated` row** for the account (one row per record: Date, Cell, UDR type, Quantity, Unit, Rated amount) grouped **state → district**, with per-district and per-state subtotal rows and a grand total ("Total rated usage") that equals the bill's rated usage. Geo (`state`/`district`) is read **off `udr_rated`** (bm48, R9), never from a ratecard query; a row without geo is shown under an **"Unassigned region"** state group (district label "—"), never dropped. The 8pt/11pt table, tabular-nums on the numeric columns, overline state/district headers, and the semibold `#E0E4EB`-ruled subtotal rows are unchanged from above; `thead` repeats, a state's `tbody` may span pages (no `break-inside: avoid`), and only the subtotal row pairs use `break-before: avoid`. Bounded to **10,000 rows/account** (bm45's load-tested cap); over the bound the render fails `INVOICE_USAGE_OVER_LIMIT` and the account parks. No new token.

**bm47 behavior change — renders on the draft too.** The binder has one bind path for both the draft PRO-FORMA preview and the final posted invoice (bm47-spec D1), so the Usage annex section now renders on **both**. "Final only" above described the legacy hardcoded template (`render-invoice-template.ts`, deleted in bm47), not a durable product rule — Part 2 overview Core flow 5 always intended the full layout to render on the draft.

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
| Featured **Activate** (Invoice Settings, one per screen) | `--billrun-cta-*` (same Deep Petrol values) | Activation changes every future invoice, including the bank details customers pay into, so it carries the same weight as Run. It uses petrol, not the platform magenta. **Save draft** is secondary, and **Upload logo** is secondary. The dialog's confirm button is primary indigo, enabled only once a change note is entered. |
| Primary buttons (Trigger/Rerun dialog confirm, Save)      | `--action-primary-bg` `#2E45A9`                                                  | Standard indigo primary — the featured petrol outranks it, so a screen has at most one petrol button and any number of indigo ones.                                                                                                |
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

## 9. Border radius delta (inherits shared §6)

| Element                                                                 | Token / value                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Run list / account / uncharged / errors / **bill line** tables          | `--radius-none` `0` (data grids stay square)                                                          |
| Status/category badges & pills                                          | `--radius-pill` `9999px`                                                                              |
| Run **action cards** (Current & Upcoming), pre-approval checklist panel | `--radius-md` `6px` (default)                                                                         |
| Trigger / Rerun / Cancel / Approve dialogs                              | `--radius-lg` `8px`                                                                                   |
| Stall banner                                                            | `--radius-sm` `4px` (full-width bar, minimal rounding) — the stub/placeholder banner is retired (D31) |
| `udr_rated` drill-down disclosure panel                                 | `--radius-sm` `4px` on `--surface-sunken`                                                             |
| Invoice Settings form cards, logo dropzone                              | `--radius-md` `6px`                                                                                   |
| Live preview frame (`InvoicePreviewFrame`), Version history table       | `--radius-none` `0` (the frame is a sheet of paper, and the table is a data grid)                     |
| Generated .hbs viewer                                                   | `--radius-sm` `4px` on `--surface-sunken`                                                             |
| `ActivateVersionDialog`                                                 | `--radius-lg` `8px`                                                                                   |
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
| Preview loading, queued and error states                  | Reuse the §6c PDF skeleton and captions as they are                                                                                                                                           |

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
bm55; they arrive with bm57/bm58.

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
