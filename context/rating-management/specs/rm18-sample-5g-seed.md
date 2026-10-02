# rm18 — Sample 5G seed + MNO-key shape + new event codes — Spec

- **Unit:** rm18 of Phase G (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` · **Boundary:** `db/seeds/sample/**` + `db/seeds/rating-event-catalog.data.ts` + `validation/customer/**` + `types/rating` (event-code constant)
- **Authorizes from:** `_change-rating-configuration-plan.md` (Workstream D; A1/A2 config); `ratemgmt-update-overview.md` (core user flow steps 1–3); `ratemgmt-architecture.md` Inv 14 (new codes catalogued), 20–24.

## Goal

Seed one end-to-end **Sample 5G** dataset — a product offering with its three specs + a scalar `usage_rate` price, a customer whose `party_role` carries the MNO key, its single RAN_USAGE subscription, and an active ratecard whose `lkp_subscriber_ref_id` points at that customer — plus the MNO-key validation shape and the nine new `event_catalog` rows, so the flow (rm19–rm21) can resolve and rate a real record and every emitted event code resolves.

## Design

- **New sample seed, not a migration.** Follows the `db/seeds/sample/` pattern (prod-guarded, idempotent, one transaction, `_SAMPLE_`-marked), the same home as `udr-rated-sample.ts` / `seed-billrun-sample.ts`. The offering/spec/price catalog convention lives in `db/seeds/demo/`; reuse its helpers for the offering + price rows.
- **Dependency-ordered inserts within one transaction:** event codes + validation shape (independent) → customer `party_role` → billing account → product offering + specs + price → order item → `product_inventory` (the subscription) → ratecard version → ratecard lkp rows. The ratecard's `lkp_subscriber_ref_id` needs the **`party_role_id`**, so the customer is created first and its generated id is threaded into the lkp rows.
- **`lkp_subscriber_ref_id = party_role_id`** (the customer), **not** `product_inventory_id` — the update's change (pm57a banner). This is what makes factor-2 stable across re-subscribe.
- **The `usage_rate` price is a plain scalar** — `rateCardLookUp = null`, `plaSpecId = null`, `ratePerUnit` set — so it satisfies the existing `usageRateComponentSchema` invariant untouched (the ratecard reference is the `productCardLookUp` spec, not a price field).
- **The three specs are simple keyed values** on `product_specifications` (`name` + `default_value`): `udrType=RAN_USAGE`, `singleSubInstPerCust=true`, `productCardLookUp=RATECARD_RAN_USAGE_LKP`.
- **All nine new event codes are non-auto-clearing** — integrity failures; a later clean batch does not make the earlier problem untrue (rm12/rm02 D5 rule).

## Implementation

### 1. New event codes (`db/seeds/rating-event-catalog.data.ts` + the `RATING_EVENT_CODES` constant)
Add nine rows, each with `default_severity`, X.733 `event_type`, `probable_cause`, description, `is_auto_clearing = false`, `clear_event_code = null`:

| `event_code` | `default_severity` | Meaning |
| --- | --- | --- |
| `UNKNOWN_SUBSCRIBER` | `MAJOR` | MNO key resolved to no active RAN subscription (incl. empty `{}`) |
| `SUBSCRIBER_REF_MISMATCH` | `MAJOR` | ratecard `lkp_subscriber_ref_id` ≠ the resolved `party_role_id` (factor 2) |
| `PRODUCT_PIN_MISMATCH` | `MAJOR` | resolved offering family id ≠ the `subscription_product_name` pin (factor 3) |
| `SERVICE_CODE_MISMATCH` | `MAJOR` | input `service_code` ≠ the matched ratecard row's |
| `RATECARD_COVERAGE_GAP` | `MAJOR` | an active ratecard polygon has no input row (`HARD_STOP` mode) |
| `RATECARD_COVERAGE_GAP_WARN` | `WARNING` | same, under `WARN` mode (self-clearing? **no** — informational, non-clearing) |
| `INPUT_UNMAPPED` | `MAJOR` | an input row maps to no ratecard entry |
| `UDRTYPE_MISMATCH` | `MAJOR` | dataset `udr_type` ≠ the offering's `udrType` spec |
| `CARD_DRIVEN_RATING_UNSUPPORTED` | `CRITICAL` | RP resolved a card-driven `usage_rate` (unbuilt) |
| `MNO_KEY_NOT_UNIQUE` | `MAJOR` | one MNO key resolves to >1 customer (the uniqueness guard) |

Add each code to `RATING_EVENT_CODES` in the same change set (rm02/§7.11 rule: seed row + constant + emitter together — the emitters are rm20/rm21).

### 2. MNO-key validation shape (`validation/customer/party-role-specification.schema.ts`)
A Zod schema for the `party_role_specification` MNO entry — a **numbered series**, single key required for now:
```ts
// mnoPublicKey1 required; mnoPublicKey2.. reserved (multi-key is a future phase)
export const mnoKeySpecSchema = z.object({ mnoPublicKey1: z.string().min(1) }).passthrough();
```
`passthrough()` because `party_role_specification` is the platform's "well-formed JSON only" jsonb (custmgmt Inv #7) and may carry other keys. The resolver (rm20) reads `->>'mnoPublicKey1'`; this shape is what the ordering/seed side writes.

### 3. Sample 5G offering + specs + price (`db/seeds/sample/sample-5g-rating.ts`)
- `product.product_offering`: `name = "Sample 5G Services"`, `lifecycle_status = 'ACTIVE'`, `is_sellable = true`, `version = 1`, `family_offering_id = null`.
- `product.product_specifications` (three rows, `ref_product_offering_id` = the offering): `("udrType", default_value "RAN_USAGE", is_mandatory true, is_default true)`, `("singleSubInstPerCust", "true", true, false)`, `("productCardLookUp", "RATECARD_RAN_USAGE_LKP", true, false)`.
- `product.product_offering_price`: `component_type = 'usage_rate'`, `price_component` = the scalar `usage_rate` variant `{ "@type":"usage_rate", ratePerUnit:"100.000000", rateCardLookUp:null, plaSpecId:null }` (validated by the existing `pricing-component.schema.ts`), `unit_of_measure = "Mbps"`, `currency = "MYR"`, `start_date_time` set.

### 4. Customer + subscription (reuse `db/seeds/customer.ts` + `ordering-inventory.ts` helpers)
- `customer.party_role`: `party_role_specification = {"mnoPublicKey1":"MNO-001"}`, `status = 'ACTIVE'`. Capture the generated `party_role_id`.
- A `billing.billing_account` (`currency = "MYR"`, matching the price) for the customer.
- `ordering.product_order_item` → `inventory.product_inventory`: `product_offering_id` = the Sample 5G offering, `customer_party_role_id` = the party role, `billing_account_id`, `status = 'ACTIVE'`, `quantity = 1`, `start_date` set. This is the single RAN subscription (`singleSubInstPerCust`).

### 5. Ratecard (`product.ratecard_version` + `product.ratecard_ran_usage_lkp`)
- `ratecard_version`: `card_name = "RATECARD_RAN_USAGE_LKP"`, `version_num = 1`, `status = 'ACTIVE'`, `snapshot_date`, `source_file`, `row_count = 3`.
- Three `ratecard_ran_usage_lkp` rows (`ratecard_version_id` = the version), matching the sample feed cells:
  | mno_public_key | commercial_unit_public_key | polygon_id | state | district | service_code | lkp_subscriber_ref_id | rate_per_unit |
  |---|---|---|---|---|---|---|---|
  | MNO-001 | CU-042 | PCU-042_04 | (state) | DIST-1 | SVL-100 | **`<party_role_id>`** | `NULL` |
  | MNO-001 | CU-042 | PCU-042_08 | (state) | DIST-2 | SVL-101 | `<party_role_id>` | `NULL` |
  | MNO-001 | CU-042 | PCU-042_15 | (state) | DIST-3 | SVL-102 | `<party_role_id>` | `NULL` |
  `polygon_start_date` set; `polygon_end_date` NULL (open). `lkp_subscriber_ref_id` = the seeded `party_role_id` (structural text, no FK).

### 6. Wiring
Add an npm script (`db:seed-sample-5g`) or fold into the existing sample-seed entry; **prod-guarded** like the other sample seeds; idempotent (check-before-insert on stable keys); one transaction.

## Dependencies

**None.** Reuses `drizzle-orm`, `postgres`, the existing seed helpers (`get-or-create-appuser`, the demo offering/price helpers, the ordering-inventory helpers) and `zod`.

## Verification checklist

- [ ] The seed runs idempotently in one transaction, prod-guarded; a second run inserts nothing new.
- [ ] Each of the nine new `event_code`s resolves in `event_catalog` with a severity; the `INDETERMINATE` count stays zero; each is in `RATING_EVENT_CODES`.
- [ ] `mnoKeySpecSchema` validates `{"mnoPublicKey1":"MNO-001"}` and rejects `{}` / a non-string value; a `{}`-spec customer is representable (the resolver turns it into `UNKNOWN_SUBSCRIBER`, not a seed error).
- [ ] The Sample 5G offering is `ACTIVE` with exactly three specs (`udrType`/`singleSubInstPerCust`/`productCardLookUp`) and one scalar `usage_rate` price (`rateCardLookUp = null`) that passes `pricing-component.schema.ts`.
- [ ] The customer has exactly **one** `ACTIVE` RAN_USAGE `product_inventory`; the price currency, `billing_account.currency`, and system config are all `MYR`.
- [ ] The active `ratecard_version` has three `ratecard_ran_usage_lkp` rows whose `lkp_subscriber_ref_id` equals the seeded `party_role_id` (not a `product_inventory_id`); `rate_per_unit` is `NULL`.
- [ ] A dry resolve (`mno_public_id = MNO-001` → `party_role_specification->>'mnoPublicKey1'` → the party role → the RAN offering-filtered subscription) returns exactly one `product_inventory_id` — the seed is rateable end-to-end.
- [ ] `tsc`/ESLint/Prettier clean; diff is `db/seeds` + `validation/customer` + the event-code constant only.
