# Billing Management (Bill Run) — UI Context (Module Delta)

This file **inherits `context/ui-context.md` unchanged** and only maps Bill Run domain objects onto the shared token families; it **redefines no color, type, radius, or shadow token** and invents no new hue (shared doc §3.4). Every hex below is an existing shared token shown for reference — wire badges to the semantic tokens, never to raw hex (code-standards §4.3). **This module ships no AI/ML features (architecture §5), so the `--ai-*` scale and `--gradient-ai` are not used here** — only the shared brand/status families.

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
| `SKIPPED` | Neutral (muted — excluded, no charge) | `--text-disabled` `#99A1B0` | `--color-neutral-600` `#4C5462` | `--color-neutral-100` `#EEF0F4` |

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

## 6. Stub-data mode (`StubDataBanner` / `StubBadge`)

While the stub-data environment flag is set (Inv. #15), badge **every** run loudly — Warning family, never hidden:

| Surface | Family | Tint bg / hex | Text / hex | Border / hex |
|---|---|---|---|---|
| `StubDataBanner` (persistent, every tab) | Warning | `--color-warning-50` `#FEF4E6` | `--color-warning-700` `#8A5200` | `--color-warning-500` `#E08600` |
| `StubBadge` (list-row chip) | Warning (outline) | `--surface-card` `#FFFFFF` | `--color-warning-700` `#8A5200` | `--color-warning-500` `#E08600` |

Copy: **"Stub data — figures are fixtures, not production charges."** Always paired with a warning icon.

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
| IDs — `BRN`/`BRA`/`BRS`/`CBL`/`CBT`/`BTV` and the posted invoice number (`INV…`) | `--text-mono` (`--font-mono`, IBM Plex Mono) | All run/account/bill/invoice IDs render mono, per shared §5. |
| Money columns (subtotal, tax, totals, run total) | `--text-body` / `--text-body-sm` with `font-variant-numeric: tabular-nums` | Every currency/numeric column uses tabular figures so bill amounts align; format via `lib/` `formatCurrency` (code-standards §4.4). |
| Dates (`gl_event_at`, `period_*`, `payment_due_date`, timeline `*_at`) | `--text-body-sm` / `--text-caption` | Via `formatDatetime`; `<time dateTime>` stays ISO-8601 UTC. |
| Table headers, badge labels | `--text-overline` | Unchanged from shared. |

## 9. Border radius delta (inherits shared §6)

| Element | Token / value |
|---|---|
| Run list / account / uncharged / errors tables | `--radius-none` `0` (data grids stay square) |
| Status/category badges & pills | `--radius-pill` `9999px` |
| Run **action cards** (Current & Upcoming), pre-approval checklist panel | `--radius-md` `6px` (default) |
| Trigger / Rerun / Cancel / Approve dialogs | `--radius-lg` `8px` |
| Stub banner / stall banner | `--radius-sm` `4px` (full-width bar, minimal rounding) |

No new radius, shadow, or elevation tokens — shared §6/§7 apply as-is.
