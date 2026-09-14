# Billing Management (Bill Run) — UI Context (Module Delta)

This file **inherits `context/ui-context.md` unchanged** and only maps Bill Run domain objects onto the shared token families; it **redefines no shared color, type, radius, or shadow token**. The one new hue it introduces is the module-scoped **Deep Petrol** featured-action accent (`--billrun-cta-*`) defined in §7 — a scoped accent that overrides no shared token, permitted under shared doc §3.4's module-accent allowance. Every hex in §§1–6 is an existing shared token shown for reference — wire badges to the semantic tokens, never to raw hex (code-standards §4.3). **This module ships no AI/ML features (architecture §5), so the `--ai-*` scale and `--gradient-ai` are not used here** — only the shared brand/status families.

**Phase-3 delta (minimal):** one retirement — `PlaceholderBanner`/`PlaceholderBadge` and their warning mapping are **deleted** with `BILLRUN_PLACEHOLDER_MODE` (D31); one new mapping — `ChargeSource` onto the **existing** cyan/primary families (§6); one correction — `EXCLUDED` was missing from §2; plus `BLN` in the mono-ID list and the bill-line table's radius/tabular rules. **No new color, type, radius or shadow token is introduced, and the Deep Petrol CTA in §7 is unchanged.**

**Rendering rule (shared §8):** every badge/pill renders the dark `-fg` text on the light `-bg` tint (never white-on-tint) and always pairs color with an icon **and** label, so meaning never depends on colour alone. Match the component names in `billmgmt-code-standards.md` §4.

---

## 1. Run status → token family (`RunStatus` → `RunStatusBadge`)

| Domain state | Family | Base token / hex | Text (`-fg`) / hex | Tint (`-bg`) / hex |
|---|---|---|---|---|
| `SCHEDULED` | Neutral (idle) | `--text-muted` `#6A7283` | `--color-neutral-700` `#353B46` | `--color-neutral-100` `#EEF0F4` |
| `PROCESSING` | Info (in-flight) | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `PROCESSED` | Warning (needs review/approval) | `--color-warning-500` `#E08600` | `--color-warning-700` `#8A5200` | `--color-warning-50` `#FEF4E6` |
| `APPROVED` | Brand (authorised, locked) | `--color-primary-500` `#2E45A9` | `--color-primary-700` `#1B2A68` | `--surface-selected` `#EDF0FB` |
| `POSTING` | Info (money moving) | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `INVOICED` | Success (money posted) | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC` |
| `DISTRIBUTING` | Info | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `COMPLETED` | Success (strong) | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC` |
| `PROCESSING_FAILED` | Danger (rerunnable) | `--color-danger-500` `#D92D2D` | `--color-danger-700` `#8A1717` | `--color-danger-50` `#FDEAEA` |
| `DISTRIBUTION_FAILED` | Danger (rerunnable) | `--color-danger-500` `#D92D2D` | `--color-danger-700` `#8A1717` | `--color-danger-50` `#FDEAEA` |
| `CANCELLED` | Neutral (muted, terminal) | `--text-disabled` `#99A1B0` | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |

`STALLED` is a **derived** display flag, not a status — render the `StallBanner` in the **Warning** family (`--color-warning-*`), never a persisted pill (code-standards §4.3).

## 2. Account status → token family (`AccountStatus` → `AccountStatusBadge`)

| Domain state | Family | Base / hex | Text (`-fg`) / hex | Tint (`-bg`) / hex |
|---|---|---|---|---|
| `PENDING` | Neutral | `--text-muted` `#6A7283` | `--color-neutral-700` `#353B46` | `--color-neutral-100` `#EEF0F4` |
| `PROCESSING` | Info | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `PROCESSED` | Info | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `INVOICED` | Success | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC` |
| `DISTRIBUTING` | Info | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |
| `COMPLETED` | Success | `--color-success-500` `#1F9D57` | `--color-success-700` `#0F5C32` | `--color-success-50` `#E6F6EC` |
| `PROCESSING_FAILED` | Danger | `--color-danger-500` `#D92D2D` | `--color-danger-700` `#8A1717` | `--color-danger-50` `#FDEAEA` |
| `DISTRIBUTION_FAILED` | Danger | `--color-danger-500` `#D92D2D` | `--color-danger-700` `#8A1717` | `--color-danger-50` `#FDEAEA` |
| `SKIPPED` | Neutral (muted — dropped at approval, no charge) | `--text-disabled` `#99A1B0` | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |
| `EXCLUDED` | Neutral (muted — scoping-time exclusion, **not** a failure) | `--text-disabled` `#99A1B0` | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |

`EXCLUDED` was missing from this table while `AccountStatusBadge` covered all ten values. It matters more from phase 3: an `EXCLUDED` account forgoes the month's recurring **and** usage (Inv #26), so it must never render in the danger family — it is a deliberate scoping outcome, not something that went wrong.

## 3. Stage status → token family (`StageStatus` → `StageStatusBadge`, on the `StageTimeline`)

| Domain state | Family | Base / hex | Tint (`-bg`) / hex |
|---|---|---|---|
| `PENDING` | Neutral | `--text-muted` `#6A7283` | `--color-neutral-100` `#EEF0F4` |
| `RUNNING` | Info | `--color-info-500` `#1A73D9` | `--color-info-50` `#E7F1FD` |
| `DONE` | Success | `--color-success-500` `#1F9D57` | `--color-success-50` `#E6F6EC` |
| `FAILED` | Danger | `--color-danger-500` `#D92D2D` | `--color-danger-50` `#FDEAEA` |
| `SKIPPED` | Neutral (muted) | `--text-disabled` `#99A1B0` | `--color-neutral-100` `#EEF0F4` |

## 4. Error class → token family (`ErrorClass` → `ErrorClassBadge`, on the Errors tab)

| Domain state | Family | Base / hex | Text (`-fg`) / hex | Tint (`-bg`) / hex |
|---|---|---|---|---|
| `HARD` (blocking; excluded at approval) | Danger | `--color-danger-500` `#D92D2D` | `--color-danger-700` `#8A1717` | `--color-danger-50` `#FDEAEA` |
| `SOFT` (finding; stage still succeeded) | Warning | `--color-warning-500` `#E08600` | `--color-warning-700` `#8A5200` | `--color-warning-50` `#FEF4E6` |
| `INFRA` (retryable / transient) | Info | `--color-info-500` `#1A73D9` | `--color-info-700` `#0C4084` | `--color-info-50` `#E7F1FD` |

## 5. Bill category → token family (`BillCategory` → `BillCategoryBadge`)

| Domain state | Family | Base / hex | Tint (`-bg`) / hex |
|---|---|---|---|
| `trial` (draft, pre-posting) | Neutral (outline) | `--color-neutral-500` `#6A7283` | `--surface-card` `#FFFFFF` (outline only) |
| `normal` (posted) | Success | `--color-success-500` `#1F9D57` | `--color-success-50` `#E6F6EC` |
| `last` (closure/final bill — reserved, off-cycle) | Warning | `--color-warning-500` `#E08600` | `--color-warning-50` `#FEF4E6` |

## 6. Charge source → token family (`ChargeSource` → `ChargeSourceBadge`, on `BillLineTable`)

A bill line's **source** is a category, not a status — so it maps onto the **brand secondary families**, never onto success/warning/danger/info. Zero new hues.

| Domain value | Family | Base / hex | Text (`-fg`) / hex | Tint (`-bg`) / hex |
|---|---|---|---|---|
| `USAGE` (claimed from `rating.udr_rated`) | Cyan — "measured traffic" | `--color-cyan-500` `#00A9BC` | `--color-cyan-700` `#006975` | `--color-cyan-50` `#E2F8FA` |
| `RECURRING` (derived from `product_inventory`) | Primary — "contractual, steady" | `--color-primary-500` `#2E45A9` | `--color-primary-700` `#1B2A68` | `--color-primary-50` `#EDF0FB` |
| `OCC` | — | **Not rendered** — reserved enum value with no producer this phase (D30). |

**§6 previously defined `PlaceholderBanner`/`PlaceholderBadge`. Both are RETIRED (D31)** along with `BILLRUN_PLACEHOLDER_MODE`; delete the components and their warning-family mapping. Nothing replaces them — see `billmgmt-code-standards.md` §4.2 for why a quieter "seeded data" badge is not substituted.

## 6b. Bill line table & the per-record drill-down (`BillLineTable`)

| Element | Treatment |
|---|---|
| Line rows | Data grid — `--radius-none` `0`, `--text-body-sm`, `font-variant-numeric: tabular-nums` on all three money columns |
| `discount_amount` column | **Hidden while every line is `0.00`** — no discount is computed this phase, and an always-zero column implies a capability that is not built |
| `udr_rated` drill-down (a `USAGE` row) | Collapsed native `<details>` disclosure on `--surface-sunken` `#EEF0F4`, fetched **on expand only** — a `volume`-profile account sits behind thousands of records |
| Price snapshot (a `RECURRING` row) | Same disclosure slot, same sunken surface — the snapshot *is* that row's evidence; there is no per-record drill-down behind it |
| Per-record exception surface (`BILL_NOTUSED`, unresolvable subscriber — D32) | **Info** family — `--color-info-500` `#1A73D9`, text `--color-info-700` `#0C4084`, tint `--color-info-50` `#E7F1FD`. Informational, never danger: nothing failed and approval is not blocked |

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

## 7. Accent, CTA & destructive usage

**Featured-action colour — Bill Run overrides the platform magenta.** For this money-moving, four-eyes module the platform `--action-cta-bg` magenta (`#E6007E`) reads as consumer-marketing energy, not the gravity a bill run warrants. Bill Run therefore defines **one module-scoped accent** — **"Deep Petrol"**, the brand's deepest connectivity teal — and uses it for the featured action in place of the magenta. This does **not** redefine the shared `--action-cta-bg`; every other module keeps magenta.

```css
/* globals.css — Bill Run-scoped featured accent; NOT a redefinition of the shared CTA token */
--billrun-cta-bg:        #006975; /* Deep Petrol — brand cyan-700 */
--billrun-cta-bg-hover:  #00525C; /* darkened petrol */
--billrun-cta-bg-active: #003E46; /* pressed */
--billrun-cta-text:      #FFFFFF; /* AA on the petrol fill */
```

| Purpose | Token / hex | Rule |
|---|---|---|
| Featured **Run** CTA (one per screen) | `--billrun-cta-bg` `#006975` → hover `#00525C`, active `#003E46`, text `#FFFFFF` | **Deep Petrol** — a toned-down, premium jewel tone. Use **once** per screen — the "Run" action on an operable run card. Every other action (Rerun, Check status, tab controls) uses the quieter primary/secondary/ghost treatment. |
| Primary buttons (Trigger/Rerun dialog confirm, Save) | `--action-primary-bg` `#2E45A9` | Standard indigo primary — the featured petrol outranks it, so a screen has at most one petrol button and any number of indigo ones. |
| **Approve & Post** confirm (irreversible) | Danger role — `--color-danger-500` `#D92D2D` | The money-gate confirm sits in the danger role **inside its confirmation dialog only**; the self-approval block renders disabled with its reason. |
| Cancel run confirm | Danger role, inside the spelled-out confirm dialog | Never a bare row action. |
| AI accent (`--ai-*`, `--gradient-ai`) | — | **Not used** — this module has no AI features (architecture §5). |
| Marketing gradients (`--gradient-brand`, `--gradient-5g`) | — | Not used on these data-dense screens; keep tables/forms flat (shared §4). |

**Alternative — maximum restraint (zero new hues).** If you'd rather not add a module accent at all, give the "Run" action the deep brand indigo instead: base `--color-primary-600` `#233686`, hover `--color-primary-700` `#1B2A68` (both existing tokens). "Run" then becomes a deeper, weightier version of the standard primary rather than a distinct accent — the most conservative, brand-pure option. Deep Petrol is the recommendation because it keeps the featured action visually distinct from the many indigo buttons on the run pages while still reading premium and calm.

## 8. Typography delta (inherits shared §5)

| Concern | Token | Rule |
|---|---|---|
| IDs — `BRN`/`BRA`/`BRS`/`CBL`/**`BLN`**/`CBT`/`BTV` and the posted invoice number (`INV…`) | `--text-mono` (`--font-mono`, IBM Plex Mono) | All run/account/bill/invoice IDs render mono, per shared §5. |
| Money columns (line `gross`/`discount`/`net`, subtotal, tax, totals, run total) | `--text-body` / `--text-body-sm` with `font-variant-numeric: tabular-nums` | Every currency/numeric column uses tabular figures so bill amounts align; format via `lib/` `formatCurrency` (code-standards §4.4). |
| Dates (`gl_event_at`, `period_*`, `payment_due_date`, timeline `*_at`) | `--text-body-sm` / `--text-caption` | Via `formatDatetime`; `<time dateTime>` stays ISO-8601 UTC. |
| Table headers, badge labels | `--text-overline` | Unchanged from shared. |

## 9. Border radius delta (inherits shared §6)

| Element | Token / value |
|---|---|
| Run list / account / uncharged / errors / **bill line** tables | `--radius-none` `0` (data grids stay square) |
| Status/category badges & pills | `--radius-pill` `9999px` |
| Run **action cards** (Current & Upcoming), pre-approval checklist panel | `--radius-md` `6px` (default) |
| Trigger / Rerun / Cancel / Approve dialogs | `--radius-lg` `8px` |
| Stall banner | `--radius-sm` `4px` (full-width bar, minimal rounding) — the stub/placeholder banner is retired (D31) |
| `udr_rated` drill-down disclosure panel | `--radius-sm` `4px` on `--surface-sunken` |

No new radius, shadow, or elevation tokens — shared §6/§7 apply as-is.
