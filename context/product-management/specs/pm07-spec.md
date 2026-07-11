# PM07 — Specifications Panel

- **Unit:** 7 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm06 (offering detail section) **verified and merged** — it added the `offering: OfferingDetail | null` (+ `locale`, `timezone`) props to `OfferingDetailRegion`, filled the **Details** seam with `<OfferingDetail>`, and left the **Specifications** frame as the pm05 `{/* pm07: specs cards */}` placeholder. pm07 fills that Specifications seam and nothing else. Transitively depends on pm03 (the `SpecificationCard` read model and `offering.specifications`, already assembled per selection by `getOfferingDetail`) and pm02 (`ProductSpecCharacteristics` = flat `Record<string,string>`, `types/product.ts`). pm07 must not start before pm06 is merged (`pm00-build-plan.md` dependency graph: `pm06 → pm07`).
- **Authorizing sections:** overview *User Flow step 6*, *Features — Specifications panel* ("Cards per `product_specifications` row scoped to the selected offering: mandatory/default indicators, `default_value`, and JSONB characteristics rendered as key–value chips"); `prodmgmt-architecture.md` §2 (`components/products/**` — frontend section component, no DB/SQL/service), §3 (specs FK → offering; characteristics in `product_spec_characteristics` JSONB), §4 (READ gates everything — Inv. #10); `prodmgmt-ui-context.md` §3 (spec characteristic chips: key `--text-overline` neutral-500 / value `--text-mono` neutral-800 on `--surface-sunken` `--radius-xs`; `Mandatory` = info-50/info-700, `Default` = neutral-100/neutral-700), §5 (mono SST/SD values, `--surface-card` sections), §6 (badges pair icon + label, empty states on `--surface-sunken`); `prodmgmt-code-standards.md` §4.1 (`CharacteristicChip` — one JSONB key–value pair, used by the specifications panel), §7 (`components/products/specifications-panel.tsx # SpecificationsPanel`, `characteristic-chip.tsx # CharacteristicChip`), §4.3 (tokens in `globals.css`, no inline hex); platform `architecture.md` §2 (boundary: UI → services; components hold no DB access or business logic), Inv. #9; general `code-standards.md` §2.4 (explicit return types), §3 (RSC / `"use client"` split).
- **Codebase state assumed at start (re-verify before implementing):** pm01–pm06 merged. Concretely:
  - `components/products/offering-detail-region.tsx` is a Server Component taking `hasSelection: boolean`, `notFound: boolean`, `offering: OfferingDetail | null`, `locale: string`, `timezone: string`. On the populated branch (`hasSelection && !notFound`) it renders the **Details** frame with `<OfferingDetail offering={offering} locale={locale} timezone={timezone} />` (pm06) and two remaining titled frames — **Specifications** with a `{/* pm07: specs cards */}` placeholder and **Prices** with a `{/* pm08: prices cards */}` placeholder (pm05 scaffold, laid out `grid gap-4 lg:grid-cols-2`, specs bottom-left / prices bottom-right).
  - `app/(app)/products/product-offering/page.tsx` already threads `offering={selectedOffering}` into the region (pm06 §3.4). **pm07 does not touch the page** — `offering.specifications` arrives inside the region for free.
  - `types/product.ts` exports `SpecificationCard` (`productSpecId`, `name`, `isMandatory`, `isDefault`, `defaultValue: string | null`, `characteristics: ProductSpecCharacteristics`) and `OfferingDetail.specifications: SpecificationCard[]` (pm03 §3.1); `ProductSpecCharacteristics` is a flat `Record<string, string>` (pm02 §3.6 / Decision #9).
  - Established patterns pm07 mirrors: the `cva`/token badge of `components/products/lifecycle-badge.tsx` (pm05) and `components/status-badge.tsx`; the presentational, prop-only Server Component shape of `components/products/offering-detail.tsx` (pm06); the labeled field row of the user-detail panel and pm06's `Last Modified` / `Last Edited By` grid (`--text-muted` labels, `—` for null values).

---

## 1. Goal

Replace the pm05/pm06 `OfferingDetailRegion` **Specifications** placeholder with a populated `SpecificationsPanel` that renders one card per `SpecificationCard` in `offering.specifications`: a mono `productSpecId` eyebrow, the spec `name`, a `Mandatory` badge (when `isMandatory`) and a `Default` badge (when `isDefault`), a labeled **Default value** row (when `defaultValue` is non-null), and the `product_spec_characteristics` JSONB rendered as `CharacteristicChip` key–value chips (e.g. `SST_ID: 01`, `SD_ID: A0C4E2`). When the selected offering has no specifications, the panel shows a muted empty state. Visible result: clicking a row — or opening a deep link `?offering=PRDOFR000001` — shows Section 3 populated with the offering's specification cards; the Details section (pm06) and the Prices placeholder (pm08) behave exactly as before.

## 2. Design

### 2.1 Boundary & composition

Boundary is **frontend section component only** (`prodmgmt-architecture.md` §2; code-standards §7). pm07 touches exactly three files plus tests:

1. **`components/products/characteristic-chip.tsx`** (new) — the `CharacteristicChip` presentational component: one JSONB key–value pair as a chip (code-standards §4.1). Created here because the specifications panel is its first and only v1 consumer.
2. **`components/products/specifications-panel.tsx`** (new) — the `SpecificationsPanel` presentational component: the card list (or empty state) for `offering.specifications`.
3. **`components/products/offering-detail-region.tsx`** (edit) — render `<SpecificationsPanel specifications={offering.specifications} />` in the **Specifications** seam only. The Details frame (pm06) and the Prices placeholder (pm08) are untouched.

No `app/`, `services/`, `db/`, `validation/`, `actions/`, or `app/api/` change — `getOfferingDetail` and the `OfferingDetail`/`SpecificationCard` read models (specs already scoped to the offering and ordered `name ASC, product_spec_id ASC`, pm03 §3.3/Design #11) are consumed as-is. No new service call, no re-fetch, no DB access from the component (Inv. #9). No mutation, no CTA (read-only v1, Inv. #11; ui-context §5). **The page (`page.tsx`) is not edited** — pm06 already threads `offering` into the region; pm07 reads `offering.specifications` inside the region, so the region is the only existing file it changes.

### 2.2 Server vs client

`SpecificationsPanel` and `CharacteristicChip` are **pure presentational with no interactivity** → Server Components (no `"use client"`), consistent with `offering-detail.tsx` and `offering-detail-region.tsx`. They receive fully-resolved props (`SpecificationCard[]` / a key + value string) and render markup only. No `formatDatetime`, `locale`, or `timezone` is needed — specification cards carry no dates — so, unlike pm06, the region passes the panel **no** locale/timezone props.

### 2.3 Layout — card list *(mirrors pm06's section chrome ownership)*

Section 3 is a single `--surface-card` on `--surface-app` with `--border-default` (ui-context §5), titled **"Specifications"**. As in pm06, the **region owns the `<h2>Specifications</h2>` title / section chrome** (it already draws the titled frame from pm05); `SpecificationsPanel` renders the frame's *body* — the stack of spec cards, or the empty state — so the region owns section chrome consistently across §2/§3/§4. Confirm at implementation time which side draws the `<h2>` and avoid rendering it twice.

Each specification renders as a nested card (`--surface-sunken` or a subtly bordered inner card on the section's `--surface-card`; pick one treatment and apply it uniformly — the chips already sit on `--surface-sunken` per §2.5, so give the card itself `--border-subtle` on the section surface to avoid a sunken-on-sunken flatten):

```
┌ Specifications ─────────────────────────────────┐
│ ┌──────────────────────────────────────────────┐│
│ │ PRDSMD000001                  ← mono eyebrow  ││
│ │ Network Slice eMBB   [Mandatory] [Default]    ││  ← name + badges
│ │ Default value   standard                      ││  ← labeled row (only if non-null)
│ │ ┌ SST_ID ─┐ ┌ SD_ID ──┐                        ││  ← CharacteristicChip row
│ │ │ 01      │ │ A0C4E2  │                        ││
│ │ └─────────┘ └─────────┘                        ││
│ └──────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────┐│
│ │ PRDSMD000002   QoS Profile                    ││  ← optional spec: no badges
│ │ Default value   standard                      ││
│ │ ┌ 5QI ┐ ┌ ARP ┐                                ││
│ │ │ 9   │ │ 8   │                                ││
│ │ └─────┘ └─────┘                                ││
│ └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

- **Eyebrow** *(user decision 2026-07-04 — show the spec ID)*: `spec.productSpecId` in `--font-mono` `tabular-nums`, `--text-overline`/muted, above the name — matching pm06's offering-ID eyebrow so the four sections read consistently.
- **Name row**: `spec.name` as the card's prominent line (weight 600, `--text-foreground`), with the badges (§2.4) inline to its right in a `flex flex-wrap items-center gap-2` row, wrapping below the name on narrow widths.
- **Default value row** *(user decision 2026-07-04 — badge + separate value row)*: a labeled row **"Default value"** → `spec.defaultValue`, rendered **only when `defaultValue !== null`** — independent of the `isDefault` flag (a spec can carry a `default_value` without being flagged default, and vice-versa). Label `--text-muted` `--text-overline`; value `--text-body`. When `defaultValue` is `null`, the row is omitted entirely (no em dash — the field simply isn't shown, matching the "flag chips only when true" idiom of pm06 §2.4).
- **Characteristics row**: the JSONB `spec.characteristics` rendered as `CharacteristicChip`s (§2.5), one per key–value pair, in a `flex flex-wrap gap-2` row. When `characteristics` is an empty object `{}` (allowed by pm02 §3.2), render no chip row (the card still shows its ID/name/badges/default-value).

### 2.4 Spec badges — Mandatory & Default (ui-context §3)

Two quiet badges, shown **only when their flag is true** (same idiom as pm06's flag chips), each pairing a leading icon + label so meaning never depends on color (ui-context §6):

| Read-model field | Icon (lucide) | Badge label | Tint (ui-context §3) | Show when |
|---|---|---|---|---|
| `isMandatory` | `Asterisk` | `Mandatory` | `info-50` bg / `info-700` text | `isMandatory === true` |
| `isDefault` | `Star` | `Default` | `neutral-100` bg / `neutral-700` text | `isDefault === true` |

An optional, non-default spec (both false — e.g. a `QoS Profile` that isn't mandatory) shows **no** badge; the name stands alone. There is no "Optional" badge and no per-flag em dash. Icons `size={12}`, `aria-hidden`. Tint classes reference the existing `--color-info-*` / `--color-neutral-*` custom properties that already back `status-badge.tsx` / `lifecycle-badge.tsx`; if the `info-50` / `info-700` tokens are missing, define them in `globals.css` with the ui-context §3 hexes — never inline hex (code-standards §4.3).

> **Note on `Default` badge vs. `Default value` row:** they are independent surfaces (user decision). The `Default` badge reflects the `isDefault` boolean; the `Default value` row reflects the `defaultValue` text and appears whenever that text is present. A spec that is `isDefault: true` with `defaultValue: null` shows the badge but no value row; a spec that is `isDefault: false` with `defaultValue: "standard"` shows the value row but no badge.

### 2.5 `CharacteristicChip` (ui-context §3, code-standards §4.1)

One chip per JSONB key–value pair, on `--surface-sunken` with `--radius-xs`:

- **Key** (e.g. `SST_ID`): `--text-overline`, `--color-neutral-500`, uppercase tracking as the overline token defines.
- **Value** (e.g. `01`, `A0C4E2`): `--font-mono`, `--color-neutral-800`, `tabular-nums` (SST/SD identifiers are mono per ui-context §5).
- Layout: key over value, or key–value inline with a subtle separator — pick one and apply uniformly; the reference render is `KEY` (overline) above `value` (mono) in a compact chip.

Characteristics render in **`Object.entries` insertion order** (JSONB preserves the seeded key order, so `SST_ID` renders before `SD_ID` as in the docs); no re-sorting. Chips are the only place `product_spec_characteristics` is displayed — no raw JSON, no `JSON.stringify`.

### 2.6 Empty state (ui-context §6)

When `offering.specifications` is an empty array (an offering with no `product_specifications` rows), `SpecificationsPanel` renders a single muted empty state inside the section body — `--text-muted` on `--surface-sunken`, an icon (lucide `ListChecks` or `FileText`) + "No specifications for this offering." — never a blank card. (Both seeded offerings have ≥ 1 spec, so this is the defensive path, proven by a fixture in tests.)

### 2.7 What pm07 explicitly does NOT do

- No prices rendering (pm08) — the region's **Prices** placeholder frame stays exactly as pm05/pm06 left it; pm07 edits only the **Specifications** seam. No `PriceTypeBadge`, `TierTable`, `formatCurrency`, amount, or effectivity rendering.
- No change to the **Details** section (pm06), the not-found / no-selection empty states (pm05), the offerings table (pm05), or the nav (pm04).
- No `page.tsx` change (pm06 already threads `offering` into the region).
- No guard, searchParams, or selection logic (pm05); no service, repository, validation, or migration change (pm02/pm03); the `SpecificationCard` shape and spec ordering are consumed as-is.
- No `actions/`, `app/api/`, mutation, or CTA (Inv. #11).
- No authz-matrix entry (pm09 owns the matrix + guardrail sweep).

## 3. Implementation

### 3.1 `components/products/characteristic-chip.tsx` (new)

Server Component, explicit return type (general §2.4). One key–value pair:

```tsx
import type { JSX } from "react";

type CharacteristicChipProps = {
  chKey: string; // the JSONB key, e.g. "SST_ID" (avoid the reserved word `key`)
  value: string; // the JSONB value, e.g. "01"
};

export function CharacteristicChip({
  chKey,
  value,
}: CharacteristicChipProps): JSX.Element {
  return (
    <span className="inline-flex flex-col rounded-[--radius-xs] bg-[color:var(--surface-sunken)] px-2 py-1">
      <span className="text-overline text-[color:var(--color-neutral-500)]">
        {chKey}
      </span>
      <span className="font-mono tabular-nums text-[color:var(--color-neutral-800)]">
        {value}
      </span>
    </span>
  );
}
```

- Props are two plain strings; the panel maps `Object.entries(spec.characteristics)` to `<CharacteristicChip chKey={k} value={v} />` (§3.2). Never pass the whole object.
- Token/utility classes only — no inline hex (code-standards §4.3); reuse the existing `--surface-sunken`, `--radius-xs`, `--text-overline`, `--font-mono`, and `--color-neutral-*` custom properties (they already exist for prior components; if `--surface-sunken`/`--radius-xs` are missing, define per the shared `ui-context`, never inline).

### 3.2 `components/products/specifications-panel.tsx` (new)

Server Component, explicit return type. Props typed to the pm03 read model:

```tsx
import { Asterisk, ListChecks, Star } from "lucide-react";
import type { JSX } from "react";
import { CharacteristicChip } from "@/components/products/characteristic-chip";
import type { SpecificationCard } from "@/types/product";

type SpecificationsPanelProps = {
  specifications: SpecificationCard[];
};

export function SpecificationsPanel({
  specifications,
}: SpecificationsPanelProps): JSX.Element {
  // empty array → muted empty state (§2.6)
  // else → one card per spec: eyebrow → name + badges → default-value row → chips
}
```

- **Empty state**: `specifications.length === 0` ⇒ the §2.6 muted "No specifications for this offering." block (icon + text on `--surface-sunken`). Return early.
- **Card list**: `specifications.map((spec) => …)` keyed on `spec.productSpecId`, each rendering:
  - **Eyebrow**: `<p className="font-mono tabular-nums text-overline …">{spec.productSpecId}</p>`.
  - **Name + badges**: name heading, then the badges in a `flex flex-wrap items-center gap-2` row — a local `SpecBadge` helper (§3.3) rendering `Mandatory` (info) when `spec.isMandatory` and `Default` (neutral) when `spec.isDefault`.
  - **Default value row**: `spec.defaultValue !== null` ⇒ a labeled row (`dt`/`dd` or a `--text-muted` label + value) **"Default value"** → `spec.defaultValue`; omitted when `null` (§2.3).
  - **Characteristics**: `Object.entries(spec.characteristics)` non-empty ⇒ a `flex flex-wrap gap-2` row of `<CharacteristicChip chKey={k} value={v} key={k} />`; empty ⇒ nothing.
- Surfaces/borders per ui-context §5 (`--surface-card` section owned by the region; inner cards `--border-subtle`); no inline hex (code-standards §4.3).

### 3.3 Spec badges (in `specifications-panel.tsx`)

A local presentational helper + derivation (§2.4), mirroring pm06's `FlagChip`:

```tsx
function SpecBadge({
  icon: Icon,
  label,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  tone: "info" | "neutral";
}): JSX.Element {
  // info: info-50 bg / info-700 text; neutral: neutral-100 bg / neutral-700 text
  // inline-flex items-center gap-1, --radius-xs (or --radius-pill to match badges),
  // icon size={12} aria-hidden + label
}

function specBadges(s: SpecificationCard) {
  const badges = [];
  if (s.isMandatory)
    badges.push(<SpecBadge key="m" icon={Asterisk} label="Mandatory" tone="info" />);
  if (s.isDefault)
    badges.push(<SpecBadge key="d" icon={Star} label="Default" tone="neutral" />);
  return badges;
}
```

Each badge always pairs an (aria-hidden) icon with a text label so meaning never depends on color (ui-context §6). Tint classes reference existing `--color-info-*` / `--color-neutral-*` custom properties; a missing `info` token is defined once in `globals.css` with the ui-context §3 hexes (never inline — code-standards §4.3).

### 3.4 `components/products/offering-detail-region.tsx` (edit)

Fill the **Specifications** seam only — no new props (the region already receives `offering: OfferingDetail | null` from pm06):

- In the populated branch (`hasSelection === true && notFound === false`), the Specifications frame renders `{offering ? <SpecificationsPanel specifications={offering.specifications} /> : null}` in place of the pm05 `{/* pm07: specs cards */}` placeholder. Because the page only sets `hasSelection && !notFound` when `selectedOffering !== null`, `offering` is non-null here; still guard defensively so type-narrowing lint stays satisfied (same idiom pm06 used for the Details seam).
- The **Details** frame (pm06 `<OfferingDetail>`) and the **Prices** frame (`{/* pm08: prices cards */}`) are untouched.
- Component stays a Server Component (still no interactivity); no import of `locale`/`timezone` for specs.

### 3.5 Guardrail / component tests owned by this unit

Component tests under `tests/` (vitest + Testing Library; patterns: `tests/components/lifecycle-badge.test.tsx`, `offering-detail.test.tsx` (pm06), `offering-detail-region.test.tsx`):

- **`tests/components/characteristic-chip.test.tsx`** (new) — renders the key as an overline label and the value in a mono class; e.g. `chKey="SST_ID" value="01"` ⇒ both `SST_ID` and `01` appear, value carries the mono/`tabular-nums` class.
- **`tests/components/specifications-panel.test.tsx`** (new) —
  - **Card per spec**: a two-spec fixture renders two cards; each shows its mono `productSpecId` eyebrow and `name`.
  - **Mandatory badge**: `isMandatory:true` ⇒ "Mandatory" badge present; `isMandatory:false` ⇒ absent (assert absence).
  - **Default badge**: `isDefault:true` ⇒ "Default" badge present; `isDefault:false` ⇒ absent.
  - **Default value row**: `defaultValue:"standard"` ⇒ a "Default value" row showing `standard`; `defaultValue:null` ⇒ **no** "Default value" row (assert absence), *independently* of `isDefault` (cover `isDefault:true, defaultValue:null` ⇒ badge yes / value row no, and `isDefault:false, defaultValue:"standard"` ⇒ badge no / value row yes).
  - **Characteristics chips**: `characteristics:{ SST_ID:"01", SD_ID:"A0C4E2" }` ⇒ two `CharacteristicChip`s with those key/value pairs, in insertion order; `characteristics:{}` ⇒ no chips (assert none), card still renders name/badges.
  - **Empty panel**: `specifications:[]` ⇒ the "No specifications for this offering." empty state, no cards.
  - Every badge pairs an (aria-hidden) icon with a text label (ui-context §6).
- **`tests/components/offering-detail-region.test.tsx`** (edit — **intended, called-out change**) — pm06 asserted the populated **Specifications** frame is an *empty* titled placeholder; that assertion changes to: when `offering.specifications` is non-empty, the Specifications frame renders the populated `SpecificationsPanel` (assert a spec `name`/`productSpecId` appears). The **Details** frame assertion (pm06's populated `OfferingDetail`) and the **Prices** frame placeholder assertion (pm08) remain **unchanged**; the `hasSelection:false` ("Select an offering…") and `notFound:true` ("Offering not found") cases are re-asserted unchanged.

Aside from the one intended edit above (region populated-Specifications assertion), **no pre-existing test assertion changes** — pm07 adds two new components + two new test files and fills one seam. The page test (`tests/app/product-offering-page.test.tsx`) is **not** touched (no page change).

### 3.6 Commit

One commit, e.g. `product offering specifications panel: populated SpecificationsPanel (pm07)`. Contents: `components/products/characteristic-chip.tsx` (new), `components/products/specifications-panel.tsx` (new), `components/products/offering-detail-region.tsx` (edit — Specifications seam), `tests/components/characteristic-chip.test.tsx` (new), `tests/components/specifications-panel.test.tsx` (new), and the one intended test edit (`offering-detail-region.test.tsx`, §3.5). Explicitly **not** in this commit: any `services/**`, `db/**`, `validation/**` change; `app/(app)/products/product-offering/page.tsx` (untouched); `components/products/offering-detail.tsx` (pm06 — not touched); `components/products/offering-table.tsx` (pm05); `components/admin-nav.tsx` (pm04); any prices rendering, `PriceTypeBadge`, `TierTable`, or `formatCurrency` (pm08); any `actions/product/`, `app/api/product*`, mutation, or CTA; any authz-matrix file (pm09); any dependency or lockfile change. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 7 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages.** Everything is already installed: `lucide-react` (`Asterisk`, `Star`, `ListChecks`/`FileText` icons), `class-variance-authority` + `cn` (if the badges reuse the `cva` pattern), vitest + Testing Library. No DB, schema, migration, validation, or service change (pm07 is UI-only). Requires pm06 merged: the `OfferingDetailRegion` populated branch with the `offering` prop and the Specifications seam; and (transitively) pm03's `SpecificationCard` read model / `offering.specifications` (specs scoped + ordered in the service) and pm02's `ProductSpecCharacteristics` flat-record type.

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**

- [ ] `git status` shows only: `components/products/characteristic-chip.tsx` (new), `components/products/specifications-panel.tsx` (new), `components/products/offering-detail-region.tsx` (edit), `tests/components/characteristic-chip.test.tsx` (new), `tests/components/specifications-panel.test.tsx` (new), and the one intended test edit (`offering-detail-region.test.tsx`). Nothing else.
- [ ] No `app/**` (incl. `page.tsx`), `services/**`, `db/**`, `validation/**`, `actions/**`, `app/api/**`, `components/admin-nav.tsx`, `components/products/offering-table.tsx`, or `components/products/offering-detail.tsx` change.
- [ ] `SpecificationsPanel` / `CharacteristicChip` hold no DB access, no service call, no raw SQL, no `next/*` data fetching — they consume the `SpecificationCard[]` / string props only (architecture §2, Inv. #9).
- [ ] No price field rendering, no `PriceTypeBadge`, no `TierTable`, no `formatCurrency` (pm08); the Prices placeholder frame is byte-unchanged; the Details section (pm06) is byte-unchanged.
- [ ] No CTA / edit affordance; `permissionMap` not consulted for any UI (read-only v1, ui-context §5).
- [ ] No `TODO`, commented-out code, or `console.*` (the pm08 seam remains the pre-existing `{/* … */}` marker); no raw `JSON.stringify` of characteristics.

**Build gates**

- [ ] `npm run typecheck` green — props typed to `SpecificationCard`; `characteristics` is `Record<string,string>`; `defaultValue` is `string | null`.
- [ ] `npm run lint` and `npm run format:check` green (no `next/*` server import misuse; no inline hex — tokens only).
- [ ] `npm run test` green — both vitest configs; only the one intended assertion edit changes (§3.5), every other pre-existing assertion unchanged.

**Behavior — the point of the unit**

- [ ] Signed in with `products : READ`, selecting `TOREMOVE-Template-5G-Nationwide-Service-Plan` shows Section 3 with two spec cards: `Network Slice eMBB` (mono `PRDSMD…` eyebrow, `Mandatory` + `Default` badges, `SST_ID: 01` / `SD_ID: A0C4E2` chips) and `QoS Profile` (`Default value: standard` row, `5QI: 9` / `ARP: 8` chips).
- [ ] Selecting `TOREMOVE-Template-Enterprise-IoT-Access` shows its `Network Slice mMTC` spec card (`SST_ID: 03` / `SD_ID: B1D2E3`).
- [ ] **Badges**: a mandatory spec shows the "Mandatory" badge; a default spec shows the "Default" badge; an optional non-default spec shows neither.
- [ ] **Default value**: a spec with `default_value` shows the "Default value" row with that text; a spec with `default_value = NULL` shows no such row (independent of the Default badge).
- [ ] **Chips**: each `product_spec_characteristics` pair renders as a `CharacteristicChip` (key overline, value mono) in seeded key order; a spec with `{}` characteristics renders its card without a chip row.
- [ ] **Deep link**: opening `?offering=PRDOFR000001` in a fresh session renders the same populated specs (pm05 selection wiring + pm06 detail + pm07 specs).
- [ ] **Empty / not-found unchanged**: `offering=null` still shows "Select an offering…"; `?offering=PRDOFR999999` still shows "Offering not found"; an offering with zero specs shows the panel's "No specifications for this offering." state — pm07 did not regress pm05/pm06 states.
- [ ] Layout: card list on a flat `--surface-card` section, chips on `--surface-sunken`, no gradients (ui-context §0.2, §5); specs sit bottom-left with the Prices frame bottom-right on `lg:` widths.

**Docs in sync**

- [ ] No companion-doc edit required: overview *Features — Specifications panel* and architecture §2/§3 already describe this section; the authz-matrix entry is **pm09**.
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm07 complete with the commit reference.

**Pipeline**

- [ ] CI green end-to-end, including pm01's rename-invariance test and the SAST/DAST baseline (no new route, no new finding — pm07 is a component fill under the existing `products : READ` guard).

Any failing item means the unit is not done (workflow §8). Unit pm08 (prices panel) may start once this commit is verified and merged — it fills the region's **Prices** seam using the `offering.prices` already loaded per selection, completing the four-section page.
