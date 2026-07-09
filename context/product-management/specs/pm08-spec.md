# PM08 — Prices Panel

- **Unit:** 8 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm07 (specifications panel) **verified and merged** — it filled the region's **Specifications** seam with `<SpecificationsPanel>` and left the **Prices** frame as the pm05 `{/* pm08: prices cards */}` placeholder. pm08 fills that Prices seam and nothing else, completing the four-section page. Transitively depends on pm03 (the `PriceCard` read model + `offering.prices`, already assembled per selection by `getOfferingDetail` with the derived `endDateTime` and computed `effectivityStatus`) and pm02 (`TieredPricingCharacteristics` = `{ tiers: Tier[] }`, `Tier = { from: number; to: number | null; rate: string }`, `types/product.ts` / `validation/product/`). pm08 must not start before pm07 is merged (`pm00-build-plan.md` dependency graph: `pm07 → pm08`).
- **Authorizing sections:** overview *User Flow step 7*, *Features — Prices panel (effectivity display)* ("Cards per `product_offering_price` row: price-type badge, flat amount or tiered mini-table, charge period, GL code, and derived effectivity window"); `prodmgmt-architecture.md` §2 (`components/products/**` — frontend section component, no DB/SQL/service), §3 (derived `end_date_time`; JSONB tiers), §4 (READ gates everything incl. prices — Inv. #10), Inv. #3 (end never stored), Inv. #1/#11 (no mutation, no CTA); `prodmgmt-ui-context.md` §2 (`PriceTypeBadge`: recurring/usage/once tints + icons), §3 (spec/flag chips — not used here), §4 (price effectivity states: current cyan-500 left border, future "Starts <date>" info tag, superseded muted + "Superseded" tag; tiered mini-table flat `--radius-none`, `--text-body-sm`, header `--text-overline`), §5 (mono IDs/GL codes/tier bounds; amount `--text-h4` weight 600, currency code `--text-caption` muted; `--surface-card` sections), §6 (badges pair icon + label; empty states on `--surface-sunken`); `prodmgmt-code-standards.md` §4.1 (`PriceTypeBadge`, `TierTable` — open-ended top tier rendered "and above", chosen once here), §4.4 (`formatCurrency(amount, currency, locale)` — one `lib/` formatter, no inline `toFixed`/symbols), §4.5 (`formatDatetime(date, locale, timezone)` threaded as prop), §7 (`components/products/prices-panel.tsx # PricesPanel`, `price-type-badge.tsx # PriceTypeBadge`, `tier-table.tsx # TierTable`), §4.3 (tokens in `globals.css`, no inline hex); platform `architecture.md` §2 (boundary: UI → services; components hold no DB access or business logic), Inv. #9; general `code-standards.md` §2.4 (explicit return types), §2.15 (money `numeric` → `string`), §3 (RSC / `"use client"` split).
- **Codebase state assumed at start (re-verify before implementing):** pm01–pm07 merged. Concretely:
  - `components/products/offering-detail-region.tsx` is a Server Component taking `hasSelection: boolean`, `notFound: boolean`, `offering: OfferingDetail | null`, `locale: string`, `timezone: string`. On the populated branch (`hasSelection && !notFound`) it renders the **Details** frame with `<OfferingDetail … locale timezone />` (pm06), the **Specifications** frame with `<SpecificationsPanel specifications={offering.specifications} />` (pm07), and the **Prices** frame with the pm05 `{/* pm08: prices cards */}` placeholder (laid out `grid gap-4 lg:grid-cols-2`, specs bottom-left / prices bottom-right).
  - `app/(app)/products/product-offering/page.tsx` already threads `offering={selectedOffering}`, `locale`, and `timezone` into the region (pm06 §3.4). **pm08 does not touch the page** — `offering.prices` and `locale`/`timezone` arrive inside the region for free.
  - `types/product.ts` exports `PriceCard` (`productOfferingPriceId`, `name`, `priceType`, `pricingModel`, `amount: string | null`, `currency`, `recurringChargePeriodLength: number | null`, `recurringChargePeriodType: string | null`, `unitOfMeasure: string | null`, `glCode: string | null`, `policy: string | null`, `pricingCharacteristics: TieredPricingCharacteristics | null`, `startDateTime: Date`, `createdAt: Date`, `endDateTime: Date | null`, `effectivityStatus: EffectivityStatus`) and `OfferingDetail.prices: PriceCard[]` (pm03 §3.1); `EFFECTIVITY_STATUSES = ["current","future","superseded"]`, `PRICE_TYPES = ["recurring","usage","once"]`, `PRICING_MODELS = ["flat","tiered"]` (pm02/pm03).
  - `lib/formatters.ts` exports `formatDatetime(date, locale, timezone, fallback?)` and `formatMoney(amount: number, locale, currency)`. There is **no `formatCurrency` yet** — pm08 adds it (§3.1, user decision 2026-07-04).
  - Established patterns pm08 mirrors: the `cva`/token badge of `components/status-badge.tsx` and `components/products/lifecycle-badge.tsx` (pm05); the presentational, prop-only Server Component shape of `components/products/offering-detail.tsx` (pm06) and `specifications-panel.tsx` (pm07); the labeled field row (`--text-muted` labels, `—` for null) of pm06's `Last Modified`/`Last Edited By` grid; the `lib/formatters.ts` pure-function + unit-test pattern (`tests/lib/formatters.test.ts`).

---

## 1. Goal

Replace the pm05–pm07 `OfferingDetailRegion` **Prices** placeholder with a populated `PricesPanel` that renders one card per `PriceCard` in `offering.prices`: a mono `productOfferingPriceId` eyebrow, the price `name` with a `PriceTypeBadge` (recurring/usage/once), the amount — **flat** = `amount` + `currency` via a new `formatCurrency`, **tiered** = a `TierTable` that displays the `pricingCharacteristics.tiers` **values as their stored JSONB text** (never a "(tiered)" placeholder, never re-modelled or re-formatted) — the recurring charge period, unit of measure, GL code, policy, created-at, and the derived effectivity window (`startDateTime` → derived `endDateTime`) styled by `effectivityStatus` (current / future / superseded). When the selected offering has no prices, the panel shows a muted empty state. Visible result: clicking a row — or opening a deep link `?offering=PRDOFR000001` — shows Section 4 populated with the offering's price cards, including the tiered **Data Overage** price showing its three tier bounds and rates; the Details (pm06) and Specifications (pm07) sections behave exactly as before. This is the final section fill — the four-section page is complete.

## 2. Design

### 2.1 Boundary & composition

Boundary is **frontend section component only** (`prodmgmt-architecture.md` §2; code-standards §7), plus the one shared `lib/` money formatter the module has been deferring to this unit (code-standards §4.4). pm08 touches exactly five files plus tests:

1. **`lib/formatters.ts`** (edit) — add `formatCurrency(amount: string, currency: string, locale: string): string` (§3.1). The module mandates this exact name/signature (code-standards §4.4); it is the first money display in the app, so it lands here with its first consumer.
2. **`components/products/price-type-badge.tsx`** (new) — the `PriceTypeBadge` presentational component: `recurring | usage | once` → tinted pill + icon (ui-context §2), built with the `cva`/token pattern of `lifecycle-badge.tsx` / `status-badge.tsx`.
3. **`components/products/tier-table.tsx`** (new) — the `TierTable` presentational component: the flat `from / to / rate` mini-table for a tiered price, **displaying each tier's stored JSONB values as text** — no numeric/currency re-formatting, no modelling of the shape beyond iterating the array (user decision 2026-07-04; ui-context §4; code-standards §4.1).
4. **`components/products/prices-panel.tsx`** (new) — the `PricesPanel` presentational component: the card list (or empty state) for `offering.prices`.
5. **`components/products/offering-detail-region.tsx`** (edit) — render `<PricesPanel prices={offering.prices} locale={locale} timezone={timezone} />` in the **Prices** seam only. The Details (pm06) and Specifications (pm07) frames are untouched.

No `app/`, `services/`, `db/`, `validation/`, `actions/`, or `app/api/` change — `getOfferingDetail` and the `OfferingDetail`/`PriceCard` read models (prices already scoped to the offering, ordered `price_type ASC, start_date_time ASC, product_offering_price_id ASC`, with `endDateTime` derived and `effectivityStatus` computed in the service — pm03 §3.4/§3.6, Design #10/#11) are consumed as-is. No new service call, no re-fetch, no DB access from the component (Inv. #9). No mutation, no CTA (read-only v1, Inv. #11; ui-context §5 — `--action-cta-bg` stays reserved). **The page (`page.tsx`) is not edited** — pm06 already threads `offering`, `locale`, and `timezone` into the region; pm08 reads `offering.prices` and the two locale/timezone props inside the region, so the region is the only existing component file it changes.

### 2.2 Server vs client

`PricesPanel`, `PriceTypeBadge`, and `TierTable` are **pure presentational with no interactivity** → Server Components (no `"use client"`), consistent with `offering-detail.tsx` (pm06) and `specifications-panel.tsx` (pm07). They receive fully-resolved props (`PriceCard[]` / a `PriceType` / a tiers array + `currency`/`locale`) and render markup only. Unlike specs, **prices carry dates** (`startDateTime`, `endDateTime`, `createdAt`), so — like pm06 and unlike pm07 — `PricesPanel` takes `locale` and `timezone` props and formats datetimes through the platform `formatDatetime` (code-standards §4.5); `<time dateTime>` stays ISO-8601 UTC. `formatCurrency` is pure and locale-parameterized (§3.1), so it is callable from these Server Components directly.

### 2.3 Layout — card list *(mirrors pm06/pm07 section chrome ownership)*

Section 4 is a single `--surface-card` on `--surface-app` with `--border-default` (ui-context §5), titled **"Prices"**. As in pm06/pm07, the **region owns the `<h2>Prices</h2>` title / section chrome** (it already draws the titled frame from pm05); `PricesPanel` renders the frame's *body* — the stack of price cards, or the empty state — so the region owns section chrome consistently across §2/§3/§4. Confirm at implementation time which side draws the `<h2>` and avoid rendering it twice.

Each price renders as a nested card on the section's `--surface-card` with `--border-subtle` (same treatment pm07 chose for spec cards, to avoid a sunken-on-sunken flatten — the tier table and any chips sit on their own surfaces inside). The card's **left border** and **muting** encode effectivity state (§2.6):

```
┌ Prices ─────────────────────────────────────────────────┐
│ ┃ PRDOFP000001                          ← mono eyebrow  │  ← ┃ = cyan-500 (current)
│ ┃ Monthly Recurring Charge  [recurring]                 │  ← name + PriceTypeBadge
│ ┃ RM 5,000.00  MYR              ← h4 amount + code muted │
│ ┃ Charge period   1 month                               │
│ ┃ GL code   GL-4100                                      │
│ ┃ Effective   01 Jan 2026, 00:00 – 01 Jan 2027, 00:00   │  ← start → derived end
│ ┃ Created     01 Jan 2026, 00:00                         │
│ ┌──────────────────────────────────────────────────────┐│
│ │ PRDOFP000002                          [Starts 01 Jan…]││  ← future: info tag
│ │ Monthly Recurring Charge 2027  [recurring]            ││
│ │ RM 5,500.00  MYR                                      ││
│ │ Effective   01 Jan 2027, 00:00 – Open-ended          ││  ← null end
│ └──────────────────────────────────────────────────────┘│
│ ┌ (muted) ─────────────────────────────────────────────┐│
│ │ PRDOFP000004                          [Superseded]    ││  ← superseded: muted + tag
│ │ Data Overage  [usage]                                 ││
│ │ ┌ From ─┬ To ───────┬ Rate ┐                           ││  ← TierTable (JSONB text)
│ │ │ 0     │ 1000      │ 0.05 │                           ││
│ │ │ 1000  │ 10000     │ 0.04 │                           ││
│ │ │ 10000 │ and above │ 0.03 │                           ││
│ │ └───────┴───────────┴─────────┘                        ││
│ │ Unit of measure  GB      GL code  GL-4200             ││
│ └──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

*(Illustrative only — the exact superseded/current assignment depends on the clock. Multiple cards may carry the "current" treatment simultaneously — see §2.6.)*

- **Eyebrow**: `price.productOfferingPriceId` in `--font-mono` `tabular-nums`, `--text-overline`/muted, above the name — matching pm06/pm07 eyebrows so the four sections read consistently.
- **Name row**: `price.name` as the card's prominent line (weight 600, `--text-foreground`), with the `PriceTypeBadge` (§2.4) inline to its right in a `flex flex-wrap items-center gap-2` row, plus the effectivity **state tag** (§2.6) at the row's end.
- **Amount / tiers** (§2.5): a `flat` price shows the formatted amount + muted currency code; a `tiered` price shows the `TierTable` — never both, never a "(tiered)" placeholder.
- **Field rows** (labeled, `--text-muted` `--text-overline` label + value; each shown **only when its field is non-null**, matching the "omit null rows" idiom of pm07 §2.3):
  - **Charge period** — `${recurringChargePeriodLength} ${recurringChargePeriodType}` (e.g. `1 month`, §2.7); shown only when `recurringChargePeriodLength !== null` (recurring prices).
  - **Unit of measure** — `unitOfMeasure` (e.g. `GB`); shown only when non-null (usage prices).
  - **GL code** — `glCode` in `--font-mono` (ui-context §5); shown only when non-null.
  - **Policy** — `policy`; shown only when non-null (all v1 seeds are null, so defensive — user decision 2026-07-04 to render it when present).
  - **Effective** — the derived window: `formatDatetime(startDateTime …)` → `formatDatetime(endDateTime …)`, with `endDateTime === null` rendering **"Open-ended"** (not an em dash — the open window is meaningful; §2.6). Always shown (`startDateTime` is `NOT NULL`).
  - **Created** — `formatDatetime(createdAt …)` in `--text-caption` muted; always shown (`createdAt` is `NOT NULL`; user decision 2026-07-04 to render it). Distinct from `startDateTime` for future-dated prices (they differ by design — pm02 §3.2 Data-and-Storage #6).

### 2.4 `PriceTypeBadge` (ui-context §2)

A quiet badge (calmer than `LifecycleBadge` so it doesn't compete with amounts — ui-context §2), pairing a leading icon + label so meaning never depends on color (ui-context §6). Built with the `cva`/token pattern of `lifecycle-badge.tsx`, one visual treatment per `PriceType` (code-standards §4.1):

| `priceType` | Icon (lucide) | Label | Tint (ui-context §2) |
|---|---|---|---|
| `recurring` | `Repeat` | `Recurring` | `primary-50` bg / `primary-700` text |
| `usage` | `Gauge` | `Usage` | `cyan-50` bg / `cyan-700` text |
| `once` | `Zap` | `Once` | `neutral-100` bg / `neutral-700` text |

Pill shape (`--radius-pill`) like the other badges; icons `size={12}`, `aria-hidden`; dark `-fg` text on the light `-bg` tint, never white-on-tint (ui-context §6). Tint classes reference the existing `--color-primary-*` / `--color-neutral-*` custom properties and the `--color-cyan-*` scale; if the `cyan` tokens (`cyan-50`/`cyan-600`/`cyan-700`, and `cyan-500 #00A9BC` used by the current-state border §2.6) are missing from `globals.css`, define them there with the ui-context §2/§4 hexes — never inline hex (code-standards §4.3).

### 2.5 Amount vs. tiers — `formatCurrency` & `TierTable`

- **Flat** (`pricingModel === "flat"`, `amount !== null`, `pricingCharacteristics === null` — the XOR guaranteed by pm02's CHECK, Inv. #5): render `formatCurrency(price.amount, price.currency, locale)` as the primary amount line — `--text-h4` weight 600, `tabular-nums` (ui-context §5) — followed by the ISO `currency` code (e.g. `MYR`) in `--text-caption` muted. (Rationale: for `MYR`/`en-MY`, `Intl` renders the symbol `RM`, which is *not* the ISO code, so the muted `MYR` caption is informative, not redundant — ui-context §5's "currency code in `--text-caption` muted." A reviewer may drop the caption if a locale's symbol already equals its code; the formatter is the single source of the numeric formatting either way.)
- **Tiered** (`pricingModel === "tiered"`, `amount === null`, `pricingCharacteristics !== null`): render `<TierTable tiers={price.pricingCharacteristics.tiers} />` in place of an amount line. No amount, no "(tiered)" text (build-plan explicit).

**`TierTable`** (ui-context §4; code-standards §4.1) — a flat mini-table, `--radius-none`, `--text-body-sm`, header row in `--text-overline`, three columns. **Per the user decision (2026-07-04), the table displays each tier's stored JSONB values as text — it does not re-model or re-format the data.** The tiers arrive as a modelled `Tier[]` at the *type* layer (pm02/pm03), but the panel simply prints the stored values:

| Column | Content | Rendering |
|---|---|---|
| **From** | `tier.from` | printed as its stored value (`tabular-nums` alignment only — **no** `Intl` grouping, e.g. `1000` not `1,000`) |
| **To** | `tier.to`, or **"and above"** when `tier.to` is `null` | printed as its stored value; **open-ended top tier (`null`) → "and above"** (user decision 2026-07-04; the one absence-rendering rule, chosen once here per code-standards §4.1) |
| **Rate** | `tier.rate` | printed **verbatim as the stored JSONB string** (e.g. `0.05`) — **not** routed through `formatCurrency` (JSONB values display as-is; the price's `currency` still appears once on the card / GL context, so the rate stays the raw stored figure) |

Tiers render in array order; no re-sorting, no arithmetic, no currency/number reformatting. `TierTable` never renders raw JSON / `JSON.stringify` — it prints the individual field values into table cells. *Tension noted for the reviewer:* code-standards §4.4 originally slated tier rates through `formatCurrency`; this unit overrides that for tier values per the 2026-07-04 "display JSONB text as-is" decision — flat `amount` (a numeric **column**, not JSONB) still uses `formatCurrency` (§2.5 flat branch).

### 2.6 Price effectivity states (ui-context §4)

Each card is styled by its own `price.effectivityStatus` (computed in the service per pm03 Design #10 — the component **does not recompute** from dates). Because the effectivity partition is per (`offering`, `price_type`), **more than one card may be `current` at once** (e.g. a recurring + a usage + a once price all effective now) — the panel styles each card independently and never picks a single "the current price" (user note 2026-07-04). Signalling uses no new hues beyond the cyan already introduced for the badge:

| `effectivityStatus` | Card treatment | Tag |
|---|---|---|
| `current` | Default card + **left border `cyan-500` (`#00A9BC`)** ("live" connectivity accent) | none |
| `future` | Default card | info-tinted tag **"Starts {formatDatetime(startDateTime)}"** — `info-50` bg / `info-700` text |
| `superseded` | Card **muted** (`--text-muted` throughout) | neutral tag **"Superseded"** — `neutral-100` bg / `neutral-700` text |

The tag sits inline at the end of the name row (§2.3). The `future` tag pairs no icon (it is dated text); the `superseded` tag likewise reads as a word — both remain legible without color (ui-context §6). All price rows are rendered regardless of state — superseded and future history stays visible (pm03 Design #9: `getOfferingDetail` returns every row); nothing is hidden or collapsed (a collapse toggle would force a client component, which §2.2 forbids — user decision 2026-07-04 to show all inline).

### 2.7 Charge-period formatting

A tiny local pure helper in `prices-panel.tsx` (not a shared `lib/` formatter — it is one panel's concern): `formatChargePeriod(length: number, type: string): string` → `` `${length} ${type}` `` trimmed (e.g. `1` + `months` → `"1 months"`). Pluralization is intentionally *not* re-derived — the stored `recurring_charge_period_type` is displayed verbatim so the DB stays the single source of the period wording (v1 keeps it simple; a grammatical singular/plural pass is a deferred nicety). Called only when `recurringChargePeriodLength !== null`.

### 2.8 Empty state (ui-context §6)

When `offering.prices` is an empty array (an offering with no `product_offering_price` rows), `PricesPanel` renders a single muted empty state inside the section body — `--text-muted` on `--surface-sunken`, a lucide `Receipt` (or `CircleDollarSign`) icon + "No prices for this offering." — never a blank card. (Both seeded offerings have ≥ 2 prices, so this is the defensive path, proven by a fixture in tests.)

### 2.9 What pm08 explicitly does NOT do

- No change to the **Details** section (pm06), the **Specifications** section (pm07), the not-found / no-selection empty states (pm05), the offerings table (pm05), or the nav (pm04). pm08 edits only the **Prices** seam of the region.
- No `page.tsx` change (pm06 already threads `offering`, `locale`, `timezone` into the region).
- No guard, searchParams, or selection logic (pm05); no service, repository, validation, or migration change (pm02/pm03). The `PriceCard` shape, price ordering, derived `endDateTime`, and computed `effectivityStatus` are consumed as-is — **the component derives no effectivity itself** (Inv. #3: end never computed in the UI).
- No `actions/`, `app/api/`, mutation, or CTA (Inv. #11). No `formatMoney` removal/rename — `formatCurrency` is added alongside it (§3.1); existing user-management call sites are untouched.
- No authz-matrix entry or guardrail sweep (pm09 owns the matrix + final verification pass).

## 3. Implementation

### 3.1 `lib/formatters.ts` (edit) — add `formatCurrency`

Add one pure, framework-agnostic function beside `formatMoney` (explicit return type, general §2.4; money is `numeric` → `string`, general §2.15):

```ts
// Product Management money display (code-standards §4.4). `amount` arrives as a
// numeric-string from the read model (`PriceCard.amount`, a numeric column);
// `currency` (ISO-4217) and `locale` are resolved server-side and threaded in,
// so the formatter stays pure. Used for the flat price amount — no inline
// `toFixed`, no hand-built currency strings, no hardcoded symbols. Tier `rate`
// is JSONB and prints as stored text (§2.5), so it does NOT pass through here.
export function formatCurrency(
  amount: string,
  currency: string,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(Number(amount));
}
```

- Signature is `(amount, currency, locale)` per code-standards §4.4 — note the argument order differs from the existing `formatMoney(amount, locale, currency)`; both coexist (§2.9). Accepts a string and parses once with `Number(...)` (the read model's `amount` always matches `/^\d+(\.\d+)?$/` — validated by the pm02 Zod schema before insert). Tier `rate` values are **not** passed here — they display as stored JSONB text (§2.5).
- Does **not** hardcode `MYR`; the currency travels on each `PriceCard`. Reuses the same `Intl.NumberFormat` engine as `formatMoney` (U+00A0 between symbol and amount — asserted in tests, §3.6).

### 3.2 `components/products/price-type-badge.tsx` (new)

Server Component, explicit return type. `cva` + token pattern of `lifecycle-badge.tsx` / `status-badge.tsx`:

```tsx
import { Gauge, Repeat, Zap } from "lucide-react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { PriceType } from "@/types/product";

const priceTypeBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      priceType: {
        recurring:
          "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
        usage:
          "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
        once: "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<PriceType, string>,
    },
  },
);

const PRICE_TYPE_ICONS = { recurring: Repeat, usage: Gauge, once: Zap } as const;
const PRICE_TYPE_LABELS = {
  recurring: "Recurring",
  usage: "Usage",
  once: "Once",
} as const satisfies Record<PriceType, string>;

export function PriceTypeBadge({
  priceType,
  className,
}: {
  priceType: PriceType;
  className?: string;
}): React.JSX.Element {
  const Icon = PRICE_TYPE_ICONS[priceType];
  return (
    <span className={cn(priceTypeBadgeVariants({ priceType }), className)}>
      <Icon size={12} aria-hidden="true" />
      {PRICE_TYPE_LABELS[priceType]}
    </span>
  );
}
```

- Tokens only — no inline hex (code-standards §4.3). If `--color-cyan-50/600/700` (and `--color-cyan-500` for §3.4) are absent, define them once in `globals.css` with the ui-context §2/§4 hexes.

### 3.3 `components/products/tier-table.tsx` (new)

Server Component, explicit return type. Props typed to the pm02 tier shape, but the body **prints the stored JSONB values as text** — no `formatCurrency`, no `Intl.NumberFormat`, no arithmetic (user decision 2026-07-04):

```tsx
import type { Tier } from "@/validation/product/pricing-characteristics.schema";

type TierTableProps = {
  tiers: Tier[];        // { from: number; to: number | null; rate: string }
};

export function TierTable({ tiers }: TierTableProps): React.JSX.Element {
  // flat table: --radius-none, --text-body-sm; header row --text-overline
  // columns From | To | Rate; row order = array order (no re-sort)
  // From: String(tier.from)                      ← stored value, verbatim
  // To:   tier.to === null ? "and above" : String(tier.to)
  // Rate: tier.rate                               ← stored JSONB string, verbatim
}
```

- Every cell prints the tier's stored value as text (`tabular-nums` for alignment only). The **only** transformation is the open-ended top tier (`to === null`) rendering **"and above"** (§2.5) — an absence-rendering choice, not a re-model. No `formatCurrency`, no `Intl` grouping, no `toFixed`.
- No `currency`/`locale` prop is needed (nothing is formatted). Import `Tier` **type-only** from the validation schema (code-standards §2.3; the `z.infer` source of truth) purely to type the array. Real `<table>`/`<thead>`/`<tbody>` markup for a11y; header cells `scope="col"`; never `JSON.stringify` — print individual field values into cells.

### 3.4 `components/products/prices-panel.tsx` (new)

Server Component, explicit return type. Props typed to the pm03 read model + datetime context:

```tsx
import { Receipt } from "lucide-react";
import { PriceTypeBadge } from "@/components/products/price-type-badge";
import { TierTable } from "@/components/products/tier-table";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import type { PriceCard } from "@/types/product";

type PricesPanelProps = {
  prices: PriceCard[];
  locale: string;
  timezone: string;
};

export function PricesPanel({ prices, locale, timezone }: PricesPanelProps): React.JSX.Element {
  // empty array → muted empty state (§2.8), return early
  // else → one card per price, keyed on price.productOfferingPriceId:
  //   eyebrow (mono id) → name + PriceTypeBadge + state tag (§3.5)
  //   → amount (flat: formatCurrency + currency code) OR <TierTable …> (tiered)
  //   → labeled rows (charge period / unit of measure / GL code / policy) — each only if non-null
  //   → Effective: formatDatetime(start) – (end ? formatDatetime(end) : "Open-ended")
  //   → Created: formatDatetime(createdAt) muted
  // card left-border / muting / tag from effectivityStatus (§3.5)
}
```

- **Empty state**: `prices.length === 0` ⇒ the §2.8 muted "No prices for this offering." block (icon + text on `--surface-sunken`). Return early.
- **Amount branch**: `price.pricingModel === "tiered"` (equivalently `amount === null`) ⇒ `<TierTable tiers={price.pricingCharacteristics!.tiers} />` (values print as stored text — §3.3); else ⇒ `formatCurrency(price.amount!, price.currency, locale)` as the `--text-h4` amount + muted `currency` caption. The non-null assertions are safe by the pm02 XOR CHECK (Inv. #5); prefer a narrowing `if (price.pricingModel === "tiered" && price.pricingCharacteristics)` to keep lint happy without `!`.
- **Datetime**: all three dates via `formatDatetime(date, locale, timezone)`; wrap in `<time dateTime={date.toISOString()}>`. `endDateTime === null` ⇒ literal `"Open-ended"` (not the `formatDatetime` "Never" fallback — pass no fallback / handle null before calling, so open-ended never reads as "Never").
- Surfaces/borders per ui-context §4/§5 (`--surface-card` section owned by the region; inner cards `--border-subtle`; current = `cyan-500` left border; superseded = muted); no inline hex (code-standards §4.3).

### 3.5 Effectivity styling + state tag (in `prices-panel.tsx`)

Local presentational helpers driven by `price.effectivityStatus` (§2.6), mirroring pm07's `SpecBadge`/`specBadges` idiom:

```tsx
function stateTag(price: PriceCard, locale: string, timezone: string): React.JSX.Element | null {
  if (price.effectivityStatus === "future")
    return <span className="/* info-50 / info-700 tag */">
      {`Starts ${formatDatetime(price.startDateTime, locale, timezone)}`}
    </span>;
  if (price.effectivityStatus === "superseded")
    return <span className="/* neutral-100 / neutral-700 tag */">Superseded</span>;
  return null; // current → no tag (cyan left border conveys it)
}

function cardClassName(status: EffectivityStatus): string {
  // base inner-card classes + border-subtle, plus:
  //   current    → left border cyan-500
  //   superseded → text-muted (whole card)
  //   future     → default
}
```

- The tag is appended to the name row's `flex flex-wrap items-center gap-2`. Meaning never depends on color: `future` is dated text, `superseded` is a word (ui-context §6).
- No date math in the component — `effectivityStatus`, `startDateTime`, and `endDateTime` all arrive resolved from the service (Inv. #3).

### 3.6 `components/products/offering-detail-region.tsx` (edit)

Fill the **Prices** seam only — no new region props (the region already receives `offering`, `locale`, `timezone` from pm06):

- In the populated branch (`hasSelection === true && notFound === false`), the Prices frame renders `{offering ? <PricesPanel prices={offering.prices} locale={locale} timezone={timezone} /> : null}` in place of the pm05 `{/* pm08: prices cards */}` placeholder. Because the page only sets `hasSelection && !notFound` when `selectedOffering !== null`, `offering` is non-null here; still guard defensively so type-narrowing lint stays satisfied (same idiom pm06/pm07 used).
- The **Details** frame (pm06 `<OfferingDetail>`) and the **Specifications** frame (pm07 `<SpecificationsPanel>`) are untouched.
- Component stays a Server Component (still no interactivity); `locale`/`timezone` are already in scope (threaded by the page for pm06) — no new import into the region.

### 3.7 Guardrail / component tests owned by this unit

Vitest + Testing Library (patterns: `tests/lib/formatters.test.ts`, `tests/components/lifecycle-badge.test.tsx`, `specifications-panel.test.tsx` (pm07), `offering-detail-region.test.tsx`):

- **`tests/lib/formatters.test.ts`** (edit — add a `formatCurrency` block) — `formatCurrency("5000.00", "MYR", "en-MY")` produces the localized `MYR` currency string (assert the digits/grouping and that a currency indication is present, tolerating the U+00A0 separator — mirror the existing `formatMoney` assertions); `"0.05"` formats with the currency's minor units; a whole-number string formats correctly. No existing `formatMoney`/`formatDatetime` assertion changes.
- **`tests/components/price-type-badge.test.tsx`** (new) — each `PriceType` renders its label (`Recurring`/`Usage`/`Once`) and an `aria-hidden` icon; the correct tint class is applied per variant (`recurring` → primary, `usage` → cyan, `once` → neutral).
- **`tests/components/tier-table.test.tsx`** (new) — a three-tier fixture (`[{from:0,to:1000,rate:"0.05"},{from:1000,to:10000,rate:"0.04"},{from:10000,to:null,rate:"0.03"}]`) renders three rows in order; bounds and rates print **verbatim as stored** (`1000`/`10000` — **not** locale-grouped `1,000`; `0.05` — **not** `formatCurrency`'d); the open-ended top tier's To cell reads **"and above"**; the header exposes From/To/Rate columns. No `currency`/`locale` prop is passed.
- **`tests/components/prices-panel.test.tsx`** (new) —
  - **Card per price**: a multi-price fixture renders one card per row; each shows its mono `productOfferingPriceId` eyebrow, `name`, and `PriceTypeBadge` label.
  - **Flat amount**: a `flat` price shows the `formatCurrency` amount and its `currency` code; **no** `TierTable`.
  - **Tiered**: a `tiered` price (`amount:null`, `pricingCharacteristics.tiers`) renders a `TierTable` (assert a tier bound + rate appear) and **no** flat-amount line; never the literal "(tiered)".
  - **Field rows**: `recurringChargePeriodLength:1, recurringChargePeriodType:"months"` ⇒ a "Charge period" row "1 months"; `null` length ⇒ **no** such row (assert absence). Same present/absent pattern for `unitOfMeasure`, `glCode`, `policy`.
  - **Effectivity**: `effectivityStatus:"current"` ⇒ card carries the cyan left-border class, no tag; `"future"` ⇒ a "Starts …" info tag (assert text); `"superseded"` ⇒ muted card + a "Superseded" tag. **Multiple `current` cards** in one fixture are each styled current (no single-current assumption).
  - **Effective window**: non-null `endDateTime` ⇒ both start and end datetimes render; `endDateTime:null` ⇒ start renders and the end reads **"Open-ended"** (assert it does **not** say "Never").
  - **Empty panel**: `prices:[]` ⇒ the "No prices for this offering." empty state, no cards.
  - Datetimes format via `formatDatetime` with an injected `timezone` (e.g. `"UTC"`) so assertions are deterministic; every badge/tag pairs legible text (ui-context §6).
- **`tests/components/offering-detail-region.test.tsx`** (edit — **intended, called-out change**) — pm07 asserted the populated **Prices** frame is an *empty* titled placeholder; that assertion changes to: when `offering.prices` is non-empty, the Prices frame renders the populated `PricesPanel` (assert a price `name`/`productOfferingPriceId` appears). The **Details** (pm06) and **Specifications** (pm07) frame assertions remain **unchanged**; the `hasSelection:false` ("Select an offering…") and `notFound:true` ("Offering not found") cases are re-asserted unchanged.

Aside from the two intended edits above (the `formatCurrency` addition to the formatters test, and the region populated-Prices assertion), **no pre-existing test assertion changes** — pm08 adds one formatter + three components + three new test files and fills one seam. The page test (`tests/app/product-offering-page.test.tsx`) is **not** touched (no page change).

### 3.8 Commit

One commit, e.g. `product offering prices panel: populated PricesPanel + formatCurrency (pm08)`. Contents: `lib/formatters.ts` (edit — add `formatCurrency`), `components/products/price-type-badge.tsx` (new), `components/products/tier-table.tsx` (new), `components/products/prices-panel.tsx` (new), `components/products/offering-detail-region.tsx` (edit — Prices seam), `tests/lib/formatters.test.ts` (edit — `formatCurrency` cases), `tests/components/price-type-badge.test.tsx` (new), `tests/components/tier-table.test.tsx` (new), `tests/components/prices-panel.test.tsx` (new), and the one intended region test edit (§3.7). Plus, only if the `--color-cyan-*` tokens are genuinely absent, the `globals.css` token additions (§3.2). Explicitly **not** in this commit: any `services/**`, `db/**`, `validation/**` change; `app/(app)/products/product-offering/page.tsx` (untouched); `components/products/offering-detail.tsx` (pm06) or `specifications-panel.tsx` (pm07) — not touched; `components/products/offering-table.tsx` (pm05); `components/admin-nav.tsx` (pm04); any `formatMoney` rename or user-management call-site change; any `actions/product/`, `app/api/product*`, mutation, or CTA; any authz-matrix file (pm09); any dependency or lockfile change. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 8 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages.** Everything is already installed: `lucide-react` (`Repeat`, `Gauge`, `Zap`, `Receipt` icons), `class-variance-authority` + `cn`, and `Intl` (platform built-in for `formatCurrency`), vitest + Testing Library. No DB, schema, migration, validation, or service change (pm08 is UI + one `lib/` formatter). Requires pm07 merged: the `OfferingDetailRegion` populated branch with the `offering` / `locale` / `timezone` props and the Prices seam; and (transitively) pm03's `PriceCard` read model / `offering.prices` (prices scoped, ordered, with derived `endDateTime` and computed `effectivityStatus`) and pm02's `TieredPricingCharacteristics` / `Tier` types and the `amount`-XOR-tiers CHECK. The only new shared surface is `formatCurrency` in `lib/formatters.ts` (§3.1).

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**

- [ ] `git status` shows only: `lib/formatters.ts` (edit), `components/products/price-type-badge.tsx` (new), `components/products/tier-table.tsx` (new), `components/products/prices-panel.tsx` (new), `components/products/offering-detail-region.tsx` (edit), `tests/lib/formatters.test.ts` (edit), `tests/components/price-type-badge.test.tsx` (new), `tests/components/tier-table.test.tsx` (new), `tests/components/prices-panel.test.tsx` (new), the one intended region test edit, and — only if needed — `globals.css` (cyan tokens). Nothing else.
- [ ] No `app/**` (incl. `page.tsx`), `services/**`, `db/**`, `validation/**`, `actions/**`, `app/api/**`, `components/admin-nav.tsx`, `components/products/offering-table.tsx`, `offering-detail.tsx`, or `specifications-panel.tsx` change.
- [ ] `PricesPanel` / `PriceTypeBadge` / `TierTable` hold no DB access, no service call, no raw SQL, no `next/*` data fetching, and **no effectivity/date math** — they consume `PriceCard[]` / `PriceType` / `Tier[]` + string props only (architecture §2, Inv. #9; end never derived in UI, Inv. #3).
- [ ] `formatCurrency` is pure (no config reads, no `Date.now()`), lives in `lib/formatters.ts`, and `formatMoney` is unchanged and un-renamed.
- [ ] No CTA / edit affordance; `permissionMap` not consulted for any UI (read-only v1, ui-context §5; READ gates prices, Inv. #10).
- [ ] No `TODO`, commented-out code, or `console.*`; no `JSON.stringify` of tiers; no inline `toFixed`, hand-built currency string, or hardcoded currency symbol (code-standards §4.4); no inline hex (tokens only, §4.3).

**Build gates**

- [ ] `npm run typecheck` green — `amount` is `string | null`, `pricingCharacteristics` is `TieredPricingCharacteristics | null`, `endDateTime` is `Date | null`, `effectivityStatus` is the `EffectivityStatus` union; `Tier` imported type-only from the validation schema.
- [ ] `npm run lint` and `npm run format:check` green (no `next/*` server-import misuse; XOR narrowing without stray `!`).
- [ ] `npm run test` green — both vitest configs; only the two intended edits change (formatters `formatCurrency` cases + region populated-Prices assertion); every other pre-existing assertion unchanged.

**Behavior — the point of the unit**

- [ ] Signed in with `products : READ`, selecting `TOREMOVE-Template-5G-Nationwide-Service-Plan` shows Section 4 with its four price cards: `Monthly Recurring Charge` (recurring, `RM 5,000.00`/`MYR`, "Charge period 1 months", `GL-4100`, effective `2026-01-01` → `2027-01-01`), `Monthly Recurring Charge 2027` (recurring, `RM 5,500.00`, future — "Starts 01 Jan 2027", effective `2027-01-01` → **Open-ended**), `Activation Fee` (once, `RM 1,000.00`), and `Data Overage` (usage, **tiered** — `TierTable` showing the stored JSONB text verbatim: `0 / 1000 / 0.05`, `1000 / 10000 / 0.04`, `10000 / and above / 0.03`, unit `GB`, `GL-4200`).
- [ ] Selecting `TOREMOVE-Template-Enterprise-IoT-Access` shows its two prices: `Monthly Recurring Charge` (recurring flat, `RM 1,200.00`) and `Data Usage` (usage **flat**, `RM 0.02`/`GB`, `GL-4200`).
- [ ] **Price-type badge**: recurring/usage/once render the correct tint + icon + label; meaning survives greyscale (icon + word).
- [ ] **Flat vs tiered**: flat prices show a `formatCurrency` amount + currency code; tiered prices show the `TierTable` and no amount line; no "(tiered)" placeholder anywhere.
- [ ] **Derived effectivity** (uses today's clock via the service): the 2026 recurring price is `current` (cyan left border, end `2027-01-01`); the 2027 successor is `future` ("Starts …" tag, `Open-ended`); a superseded price (if any relative to `now`) renders muted with a "Superseded" tag — and multiple simultaneously-current prices are each bordered current.
- [ ] **Open-ended**: a price with `endDateTime = null` shows "Open-ended", never "Never".
- [ ] **Deep link**: opening `?offering=PRDOFR000001` in a fresh session renders the same populated prices (pm05 selection + pm06 detail + pm07 specs + pm08 prices).
- [ ] **Empty / not-found unchanged**: `offering=null` still shows "Select an offering…"; `?offering=PRDOFR999999` still shows "Offering not found"; an offering with zero prices shows the panel's "No prices for this offering." state — pm08 did not regress pm05–pm07 states.
- [ ] Layout: card list on a flat `--surface-card` section, tier table flat (`--radius-none`), no gradients (ui-context §0.2, §4, §5); prices sit bottom-right with the Specs frame bottom-left on `lg:` widths, stacking table → detail → specs → prices on narrow viewports.

**Docs in sync**

- [ ] No companion-doc edit required: overview *Features — Prices panel* and architecture §2/§3/§4 already describe this section; the authz-matrix entry is **pm09**.
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm08 complete with the commit reference, and records the five 2026-07-04 user decisions (add `formatCurrency` wrapper; render all price fields incl. `unitOfMeasure`/`policy`/`createdAt`; show all price rows inline styled by state, multiple-current allowed; open-ended top tier renders "and above"; **JSONB tier values display as stored text — not modelled or re-formatted**).

**Pipeline**

- [ ] CI green end-to-end, including pm01's rename-invariance test and the SAST/DAST baseline (no new route, no new finding — pm08 is a component + formatter fill under the existing `products : READ` guard).

Any failing item means the unit is not done (workflow §8). With pm08 verified and merged, the four-section page is complete; Unit pm09 (authz-matrix entry + guardrail sweep) is the module's final ship gate.
