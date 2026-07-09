# PM06 — Offering Detail Section

- **Unit:** 6 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm05 (page guard + searchParams + offerings table) **verified and merged** — it landed the `?offering=` selection, the `requirePermission('products','READ')` guard, the `getOfferingDetail(parsed.offering)` call threaded into `OfferingDetailRegion`, and the reusable `LifecycleBadge`. pm06 fills the region's `{/* pm06: populated detail */}` seam and nothing else. Transitively depends on pm02 (`types/product.ts`, `PERMISSIONS.PRODUCTS`) and pm03 (`getOfferingDetail`, the `OfferingDetail` read model with `lastEditedByName` already resolved). pm06 must not start before pm05 is merged (`pm00-build-plan.md` dependency graph: `pm05 → pm06`).
- **Authorizing sections:** overview *User Flow step 5*, *Features — Offering detail* ("All `product_offering` columns displayed: flags, lifecycle badge, `version`, `last_modified`, `last_edited_by` resolved to a user display name via FK to APPUSER"); `prodmgmt-architecture.md` §2 (`app/(app)/products/product-offering/` + `components/products/**` — frontend section component, no DB/SQL), §3 (`is_bundle` display-only, `version` in-place counter, `last_edited_by` FK → `core.APPUSER`), §4 (READ gates everything — Inv. #10); `prodmgmt-ui-context.md` §1 (`LifecycleBadge`), §3 (offering flag chips + the "Not sellable" warning exception), §5 (mono IDs/version, `tabular-nums`, `--surface-card` sections), §6 (badges never white-on-tint, icon + label, empty states); `prodmgmt-code-standards.md` §7 (`components/products/offering-detail.tsx # OfferingDetail`), §4.3 (tokens in `globals.css`, no inline hex); platform `architecture.md` §2 (boundary: UI → services; components hold no DB access or business logic), Inv. #10; general `code-standards.md` §2.4 (explicit return types), §3 (RSC / `"use client"` split).
- **Codebase state assumed at start (re-verify before implementing):** pm01–pm05 merged. Concretely:
  - `app/(app)/products/product-offering/page.tsx` exists; it computes `locale` (`getAppLocale()`) and `timezone` (`getAppTimezone()`), resolves `selectedOffering: OfferingDetail | null` via `getOfferingDetail(parsed.offering)`, and renders `<OfferingDetailRegion key={parsed.offering ?? "none"} hasSelection={…} notFound={…} />` — **without** yet passing `offering`, `locale`, or `timezone` (the pm05 seam, §3.1 of pm05, comment: "pm06–08 will consume `offering={selectedOffering}` here").
  - `components/products/offering-detail-region.tsx` exists as a Server Component taking `hasSelection: boolean` + `notFound: boolean`, rendering the not-found and "Select an offering…" empty states and, on the populated branch, three titled empty frames (Details / Specifications / Prices) as pm06–08 seams.
  - `components/products/lifecycle-badge.tsx` exports `LifecycleBadge` (cva, keyed by `LifecycleStatus`, icon + label; pm05 §3.2).
  - `types/product.ts` exports `OfferingDetail` (fields: `productOfferingId`, `name`, `isBundle`, `isSellable`, `billingOnly`, `lifecycleStatus`, `version`, `lastModified: Date`, `lastEditedByName: string | null`, `specifications`, `prices`) and `LifecycleStatus` (pm03 §3.1).
  - `lib/formatters.ts` exports `formatDatetime(date, locale, timezone, fallback?)` (um29 precedent); config accessors `getAppLocale()` / `getAppTimezone()` live in `services/system-config/app-config-read.service`.
  - Established patterns pm06 mirrors: the `cva` badge of `lifecycle-badge.tsx` / `components/status-badge.tsx`; the labeled read-only field grid of the user-detail panel on `app/(app)/administration/users/page.tsx` (label/value rows, `--text-muted` labels, `—` for null values); the sellable-chip rule already implemented inline in `offering-table.tsx` (pm05 §3.3), which pm06 reproduces for the detail flags.

---

## 1. Goal

Replace the pm05 `OfferingDetailRegion` **Details** placeholder with a populated `OfferingDetail` section component that renders every `product_offering` column for the `?offering=` selection: the offering ID (mono eyebrow), name, `LifecycleBadge`, the `is_bundle` / `is_sellable` / `billing_only` flag chips, `version`, `last_modified`, and `last_edited_by` resolved to the APPUSER display name (`—` when unresolved). Visible result: clicking a row — or opening a deep link `?offering=PRDOFR000001` — shows the offering's full detail in Section 2, while the "Select an offering", "Offering not found", and specs/prices placeholders (pm07/pm08) behave exactly as pm05 left them.

## 2. Design

### 2.1 Boundary & composition

Boundary is **frontend section component only** (`prodmgmt-architecture.md` §2; code-standards §7). pm06 touches exactly three files plus tests:

1. **`components/products/offering-detail.tsx`** (new) — the `OfferingDetail` presentational component that renders the field surface.
2. **`components/products/offering-detail-region.tsx`** (edit) — add the `offering: OfferingDetail | null`, `locale`, `timezone` props and render `<OfferingDetail>` in the populated **Details** seam. The not-found / no-selection branches and the specs/prices placeholder frames are untouched (pm07/pm08 own those).
3. **`app/(app)/products/product-offering/page.tsx`** (edit) — thread the already-computed `selectedOffering`, `locale`, and `timezone` into `<OfferingDetailRegion>` (the one-line seam pm05 deliberately left open).

No `services/`, `db/`, `validation/`, `actions/`, or `app/api/` change — `getOfferingDetail` and the `OfferingDetail` read model (with `lastEditedByName` already joined from `core.APPUSER`, pm03 §3.2/§3.6) are consumed as-is. No new service call, no re-fetch, no DB access from the component (Inv. #9). No mutation, no CTA (read-only v1, Inv. #11; ui-context §5).

### 2.2 Server vs client

`OfferingDetail` is **pure presentational with no interactivity** → a Server Component (no `"use client"`), consistent with `offering-detail-region.tsx`. It receives a fully-resolved `OfferingDetail` object plus `locale`/`timezone` strings as props and formats `lastModified` server-side via `formatDatetime`. Because the component is server-rendered inside the already-`force-dynamic` page, no config is read in the client (um28/um29 precedent: client components cannot read `SYSTEM_CONFIG`; locale/timezone are threaded as props from the page).

### 2.3 Layout — header block + labeled grid *(user decision 2026-07-04)*

Section 2 renders as a single `--surface-card` on `--surface-app` with `--border-default` (ui-context §5), titled **"Details"**, containing:

```
┌ Details ────────────────────────────────────────┐
│ PRDOFR000001                     ← mono eyebrow  │
│ 5G Nationwide Service Plan   [ACTIVE] [Bundle]   │  ← name (h-weight) + badge + flag chips
│ ────────────────────────────────────────────────│
│ Version         3                                │  ← labeled grid (label muted, value)
│ Last Modified   3 Jul 2026, 14:22                │
│ Last Edited By  Jordan Rivera                    │
└──────────────────────────────────────────────────┘
```

- **Eyebrow** *(user decision 2026-07-04 — show the ID)*: `offering.productOfferingId` in `--font-mono` `tabular-nums`, `--text-overline`/muted, above the name. It is the deep-link key and the support/share handle; the build plan's "all `product_offering` columns" includes it.
- **Name row**: `offering.name` as the section's prominent line (`--text-h3`/h4 weight 600, `--text-foreground`), with `<LifecycleBadge status={offering.lifecycleStatus} />` and the flag chips (§2.4) inline to its right, wrapping below the name on narrow widths.
- **Field grid**: a two-column label/value grid (`dl`-style; mirror the user-detail panel). Labels in `--text-muted` `--text-overline`; values in `--text-body`.
  - **Version** — `offering.version` in `--font-mono` `tabular-nums` (ui-context §5).
  - **Last Modified** — `formatDatetime(offering.lastModified, locale, timezone)`, `whitespace-nowrap`.
  - **Last Edited By** — `offering.lastEditedByName ?? "—"` (seeded rows have `last_edited_by IS NULL` ⇒ `lastEditedByName: null`; render the em dash, pm03 §3.6 — "rendering '—' is pm06's concern").

### 2.4 Offering flag chips (ui-context §3)

Render quiet neutral chips (`--radius-xs`, `neutral-100` bg / `neutral-700` text) with a leading icon + label, **only when the flag is true**:

| Column (read model field) | Icon (lucide) | Chip label | Show when |
|---|---|---|---|
| `is_bundle` (`isBundle`) | `Boxes` | `Bundle` | `isBundle === true` |
| `is_sellable` (`isSellable`) | `ShoppingCart` | `Sellable` | `isSellable === true` |
| `billing_only` (`billingOnly`) | `Receipt` | `Billing only` | `billingOnly === true` |

**Warning exception** (ui-context §3, identical to pm05's table cell): when `isSellable === false` **and** `lifecycleStatus === "ACTIVE"`, render a warning-tinted **"Not sellable"** chip (`warning-50` bg / `warning-700` text, e.g. `ShoppingCart`/`AlertTriangle` icon) instead of omitting the sellable chip — the combination Billing Ops must notice. In every other case a false flag renders nothing (no "—" for individual flags; the em dash is only for `Last Edited By`). If all flags are false and the offering is not the ACTIVE-not-sellable case, the badge row shows only the `LifecycleBadge`.

This rule already exists inline in `offering-table.tsx` (pm05 §3.3). pm06 **does not edit** `offering-table.tsx`; to keep the boundary clean it defines the chips locally in `offering-detail.tsx` (a small `FlagChip` presentational + the derivation). A shared `components/products/offering-flags.tsx` extraction that both the table and detail consume is a reasonable future tidy-up but is **out of scope here** — pm06 must not churn the pm05 table file or risk changing its tests.

### 2.5 What pm06 explicitly does NOT do

- No specifications rendering (pm07) or prices rendering (pm08) — the region's specs/prices placeholder frames stay exactly as pm05 left them; pm06 edits only the **Details** seam.
- No `PriceTypeBadge`, no spec chips, no tier table.
- No change to the not-found / no-selection empty states (pm05 owns them; pm06's populated branch is reached only when `hasSelection && !notFound`).
- No guard, searchParams, or selection logic (pm05); no service, repository, validation, or migration change (pm02/pm03).
- No `actions/`, `app/api/`, mutation, or CTA (Inv. #11).
- No authz-matrix entry (pm09 owns the matrix + guardrail sweep).
- No nav change (pm04).

## 3. Implementation

### 3.1 `components/products/offering-detail.tsx` (new)

Server Component. Explicit return type (general §2.4). Props typed to the pm03 read model:

```tsx
import { AlertTriangle, Boxes, Receipt, ShoppingCart } from "lucide-react";
import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { formatDatetime } from "@/lib/formatters";
import type { OfferingDetail as OfferingDetailModel } from "@/types/product";

type OfferingDetailProps = {
  offering: OfferingDetailModel;
  locale: string;
  timezone: string;
};

export function OfferingDetail({
  offering,
  locale,
  timezone,
}: OfferingDetailProps): React.JSX.Element {
  // …eyebrow (mono id) → name + LifecycleBadge + flag chips → labeled grid…
}
```

- **Eyebrow**: `<p className="font-mono tabular-nums …">{offering.productOfferingId}</p>` (mono per ui-context §5).
- **Name + badges**: name heading, then `<LifecycleBadge status={offering.lifecycleStatus} />` and the flag chips (§3.2 below) in a `flex flex-wrap items-center gap-2` row.
- **Field grid**: a `<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 …">` with three `dt`/`dd` pairs — Version (`font-mono tabular-nums`), Last Modified (`formatDatetime(offering.lastModified, locale, timezone)`), Last Edited By (`offering.lastEditedByName ?? "—"`). Labels `--text-muted`.
- Surfaces/borders per ui-context §5 (`--surface-card`, `--border-default`); no inline hex — reuse existing tokens/utility classes (code-standards §4.3). The outer card + "Details" title may live here or stay in `offering-detail-region.tsx`; keep the title in the region (it already renders the titled frame in pm05) and let `OfferingDetail` render the card's *body* so the region owns the section chrome consistently across §2/§3/§4. Confirm at implementation time which side draws the `<h2>Details</h2>` and avoid rendering it twice.

### 3.2 Flag chips (in `offering-detail.tsx`)

A local presentational helper + derivation (§2.4). Sketch:

```tsx
function FlagChip({
  icon: Icon,
  label,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  tone?: "neutral" | "warning";
}): React.JSX.Element {
  // neutral: neutral-100 bg / neutral-700 text; warning: warning-50 / warning-700
}

function offeringFlagChips(o: OfferingDetailModel) {
  const chips = [];
  if (o.isBundle) chips.push(<FlagChip icon={Boxes} label="Bundle" />);
  if (o.isSellable) chips.push(<FlagChip icon={ShoppingCart} label="Sellable" />);
  else if (o.lifecycleStatus === "ACTIVE")
    chips.push(<FlagChip icon={AlertTriangle} label="Not sellable" tone="warning" />);
  if (o.billingOnly) chips.push(<FlagChip icon={Receipt} label="Billing only" />);
  return chips;
}
```

Icon `size={12}`, `aria-hidden`; chip always pairs icon + label so meaning never depends on color (ui-context §6). Tint classes reference existing `--color-neutral-*` / `--color-warning-*` custom properties (they already back `LifecycleBadge` and `status-badge.tsx`; if a token is missing, define it in `globals.css` with the ui-context §3 hexes, never inline — code-standards §4.3).

### 3.3 `components/products/offering-detail-region.tsx` (edit)

Add the three props and render `<OfferingDetail>` in the **Details** seam only:

- Extend props: `offering: OfferingDetail | null`, `locale: string`, `timezone: string` (pm05 §3.4 anticipated `offering`; add `locale`/`timezone` since `OfferingDetail` needs them for `formatDatetime`).
- In the populated branch (`hasSelection === true && notFound === false`), the Details frame renders `{offering ? <OfferingDetail offering={offering} locale={locale} timezone={timezone} /> : null}` in place of the pm05 `{/* pm06: populated detail */}` placeholder. Because the page only sets `hasSelection && !notFound` when `selectedOffering !== null`, `offering` is non-null on this branch; still guard defensively so a type-narrowing lint stays satisfied.
- Specifications and Prices frames keep their `{/* pm07: specs cards */}` / `{/* pm08: prices cards */}` placeholders unchanged.
- Component stays a Server Component (still no interactivity).

### 3.4 `app/(app)/products/product-offering/page.tsx` (edit)

One-line seam fill: pass the already-resolved values into the region (all three are already computed in the page for `OfferingTable` / the `getOfferingDetail` call):

```tsx
<OfferingDetailRegion
  key={parsed.offering ?? "none"}
  hasSelection={parsed.offering !== null}
  notFound={parsed.offering !== null && selectedOffering === null}
  offering={selectedOffering}
  locale={locale}
  timezone={timezone}
/>
```

No other page change — the guard, searchParams parse, `Promise.all`, and header are untouched (pm05).

### 3.5 Guardrail / component tests owned by this unit

Component tests under `tests/` (vitest + Testing Library; patterns: `tests/components/lifecycle-badge.test.tsx`, `offering-detail-region.test.tsx` from pm05, the user-detail panel test):

- **`tests/components/offering-detail.test.tsx`** (new) —
  - Renders all `product_offering` fields for a fully-populated `OfferingDetail` fixture: mono `productOfferingId` eyebrow; `name`; `LifecycleBadge` showing the status label; `version` mono; `Last Modified` formatted via a mocked/known `formatDatetime` with the passed `locale`/`timezone`; `Last Edited By` = `lastEditedByName`.
  - **Null editor**: `lastEditedByName: null` ⇒ renders `—` (not "null", not blank).
  - **Flag chips**: `isBundle:true` ⇒ "Bundle" chip; `billingOnly:true` ⇒ "Billing only" chip; `isSellable:true` ⇒ "Sellable" chip. A `false` flag renders no chip (assert absence).
  - **Not-sellable warning**: `isSellable:false, lifecycleStatus:"ACTIVE"` ⇒ "Not sellable" warning chip present; `isSellable:false, lifecycleStatus:"DRAFT"` ⇒ **no** sellable/not-sellable chip.
  - Every chip pairs an (aria-hidden) icon with a text label (ui-context §6).
- **`tests/components/offering-detail-region.test.tsx`** (edit — **intended, called-out change**) — pm05's assertion "populated branch → three *empty* titled frames (Details / Specifications / Prices)" changes: the **Details** frame now renders the populated `OfferingDetail` (assert the offering name/id appear when an `offering` prop is supplied). The Specifications and Prices frames remain the pm07/pm08 placeholder assertions **unchanged**. The `hasSelection:false` ("Select an offering…") and `notFound:true` ("Offering not found") cases are re-asserted unchanged.
- **`tests/app/product-offering-page.test.tsx`** (edit — intended) — extend the existing pm05 page test so that, on a resolved deep link (`offering:"PRDOFR000001"`, `getOfferingDetail` mocked → a fixture), `OfferingDetailRegion` receives `offering` (non-null) plus `locale`/`timezone`. The guard-first, tampered-URL-defaults, and unknown-ID → `notFound` assertions from pm05 stay green unchanged.

Aside from the two intended edits above (region populated-Details assertion; page threading `offering`/`locale`/`timezone`), **no pre-existing test assertion changes** — pm06 adds one new component + one new test file and fills one seam.

### 3.6 Commit

One commit, e.g. `product offering detail section: populated OfferingDetail (pm06)`. Contents: `components/products/offering-detail.tsx` (new), `components/products/offering-detail-region.tsx` (edit — props + Details seam), `app/(app)/products/product-offering/page.tsx` (edit — thread `offering`/`locale`/`timezone`), `tests/components/offering-detail.test.tsx` (new), and the two intended test edits (§3.5). Explicitly **not** in this commit: any `services/**`, `db/**`, `validation/**` change; `components/admin-nav.tsx` (pm04); `offering-table.tsx` (pm05 — not touched); any specs/prices field rendering, `PriceTypeBadge`, spec chip, or tier table (pm07/pm08); any `actions/product/`, `app/api/product*`, mutation, or CTA; any authz-matrix file (pm09); any dependency or lockfile change. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 6 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages.** Everything is already installed: `lucide-react` (`Boxes`, `ShoppingCart`, `Receipt`, `AlertTriangle` icons), `class-variance-authority` + `cn` (via the reused `LifecycleBadge`), vitest + Testing Library. No DB, schema, migration, or validation change (pm06 is UI-only). Requires pm05 merged: `OfferingDetailRegion` seam + `LifecycleBadge`, the page's `getOfferingDetail` wiring and `locale`/`timezone` computation; and (transitively) pm03's `getOfferingDetail` + `OfferingDetail` read model with `lastEditedByName` resolved, and `lib/formatters.formatDatetime`.

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**

- [ ] `git status` shows only: `components/products/offering-detail.tsx` (new), `components/products/offering-detail-region.tsx` (edit), `app/(app)/products/product-offering/page.tsx` (edit), `tests/components/offering-detail.test.tsx` (new), and the two intended test edits (`offering-detail-region.test.tsx`, `product-offering-page.test.tsx`). Nothing else.
- [ ] No `services/**`, `db/**`, `validation/**`, `actions/**`, `app/api/**`, `components/admin-nav.tsx`, or `components/products/offering-table.tsx` change.
- [ ] `OfferingDetail` holds no DB access, no service call, no raw SQL, no `next/*` data fetching — it consumes the `OfferingDetail` prop only (architecture §2, Inv. #9).
- [ ] No spec/price field rendering, no `PriceTypeBadge`, no spec chips, no tier table (pm07/pm08); the Specifications/Prices placeholder frames are byte-unchanged.
- [ ] No CTA / edit affordance; `permissionMap` not consulted for any UI (read-only v1, ui-context §5).
- [ ] No `TODO`, commented-out code, or `console.*` (the pm07/pm08 seams remain the pre-existing `{/* … */}` markers).

**Build gates**

- [ ] `npm run typecheck` green — props typed to `OfferingDetail`/`LifecycleStatus`; `lastModified` is `Date`; `lastEditedByName` is `string | null`.
- [ ] `npm run lint` and `npm run format:check` green (no `next/*` server import misuse; no inline hex — tokens only).
- [ ] `npm run test` green — both vitest configs; only the two intended assertion edits change (§3.5), every other pre-existing assertion unchanged.

**Behavior — the point of the unit**

- [ ] Signed in with `products : READ`, clicking a row (e.g. `TOREMOVE-Template-5G-…`) shows Section 2 populated: mono ID eyebrow, name, `LifecycleBadge`, `version` (mono), `Last Modified` (formatted in the app locale/timezone), `Last Edited By` (`—` for the seeded NULL editor).
- [ ] **Flags**: an offering with `is_bundle=true` shows the "Bundle" chip; `billing_only=true` shows "Billing only"; `is_sellable=true` shows "Sellable"; each false flag shows nothing.
- [ ] **Not-sellable warning**: an `ACTIVE` offering with `is_sellable=false` shows the warning "Not sellable" chip; a non-ACTIVE not-sellable offering shows no sellable chip.
- [ ] **Deep link**: opening `?offering=PRDOFR000001` in a fresh session renders the same populated detail (pm05 selection wiring + pm06 fields).
- [ ] **Empty / not-found unchanged**: `offering=null` still shows "Select an offering…"; a well-formed nonexistent `?offering=PRDOFR999999` still shows "Offering not found" — pm06 did not regress pm05's states.
- [ ] **RETIRED**: selecting a retired offering (via the Retired filter) renders its detail with the RETIRED `LifecycleBadge`; detail is not muted-to-illegibility (row muting is the table's concern, not the detail card).
- [ ] Layout: header block (eyebrow + name + badges) over a labeled field grid, flat `--surface-card`, no gradients (ui-context §0.2, §5).

**Docs in sync**

- [ ] No companion-doc edit required: overview *Features — Offering detail* and architecture §2/§3 already describe this section; the authz-matrix entry is **pm09**.
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm06 complete with the commit reference.

**Pipeline**

- [ ] CI green end-to-end, including pm01's rename-invariance test and the SAST/DAST baseline (no new route, no new finding — pm06 is a component fill under the existing `products : READ` guard).

Any failing item means the unit is not done (workflow §8). Unit pm07 (specifications panel) may start once this commit is verified and merged — it fills the region's Specifications seam using the `offering.specifications` already loaded per selection.
