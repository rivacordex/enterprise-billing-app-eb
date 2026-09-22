# pm49 — Component write path: repository, services, actions, cross-row validator

**Unit:** pm49 (Part 4). **Boundary:** `db/repositories/product-offering-price.ts`, the price reads in `db/repositories/product-offering.ts`, `services/product/{insert,update,delete}-price.ts`, the new `services/product/validate-offering-components.ts`, the three matching actions, and `PriceCard` in `types/product.ts`. **No page, no component, no seed, no schema, no new action file.**
**Specs from:** `prodmgmt-update-overview.md` (goal 9; Core User Flow steps 5–6; success criteria 2–3) · `_updatemodule-product-pricing-components-plan.md` **PC4, PC14**, **VI3, VI4, VI5**, O5 · `prodmgmt-architecture.md` §2, §3.5, §4 (write boundary), Inv. #30, #33, #34, #35, #39, #43 · `prodmgmt-code-standards.md` §1.2, §1.12, §1.13, §2.6, §2.9, §2.10, §2.14, §2.15, §2.16, §3.7, §6.3, §6.18, §7.6 · `prodmgmt-ai-workflow-rules.md` §4.2, §5.2 (O5), §5.5, §8.3, §8.11.
**Depends on:** **pm48** (a seeded four-component offering to write against and read back), **pm38** (the DRAFT-only guard and the two price writes this extends), and through them pm46/pm47.

---

## Goal

Make the three price writes component-writes: the repository reads and writes `component_type` + `price_component`, the read model exposes the parsed component with per-lane effectivity, and a new in-transaction cross-row validator refuses the three offering-level violations (VI3, VI4, VI5) with typed codes the UI can render — all still under pm38's DRAFT lock and pm36's trigger, and still with exactly three writes and no new action file.

---

## Design

### D1. Still exactly three writes, and never a fourth

`insertPrice`, `updatePrice`, `deletePrice` — the repository's permanent surface (§1.2, Inv. #1). The pricing update adds none: authoring four component types is four *payloads* through one insert, not four writes. `updatePrice` and `deletePrice` keep refusing a non-`DRAFT` parent, re-read `FOR UPDATE` in the same transaction, with pm36's trigger as the backstop on a direct SQL write. **`EXPECTED_PRODUCT_ACTION_FILES` is unchanged** — if a unit finds itself adding `actions/product/insert-capacity-component.action.ts`, it has left scope (§3.7, §7.7).

### D2. The read model carries the parsed component and nothing legacy

`PriceCard` becomes: `productOfferingPriceId`, `name`, **`componentType: ComponentType`**, **`component: PricingComponent`** (parsed, not raw JSON), `currency`, `unitOfMeasure`, the recurring pair, `glCode`, `policy`, `startDateTime`, `createdAt`, `endDateTime`, `effectivityStatus`. It carries **no `amount`, no `pricingModel`, no `priceType` column field** (§2.9) — those names must not reappear even as conveniences, because a component's money lives in its envelope and the two axes must never be conflated (Inv. #38).

The repository parses the JSONB **once**, at the read boundary, with `persistablePricingComponentSchema`. Everything downstream imports the envelope **type-only** (§2.18) — a page or a component never re-parses data a service already parsed. A row that fails to parse is a corruption, not a variant: surface it as a service-level error rather than rendering a partial card (the DB CHECK plus Inv. #30 make it unreachable in practice, which is exactly why a silent fallback would hide a real defect).

### D3. Effectivity is computed per `(component_type, unit_of_measure)` lane

The `lead()` window partitions by `(product_offering_id, component_type, unit_of_measure)` — the same key as pm46's `NULLS NOT DISTINCT` unique constraint (§2.6, §6.4). This is the whole point of the rekey: a newly added `capacity_motivation` must not appear to supersede the `usage_rate` beside it, and a `flat_fee` (NULL unit) forms its own lane. `endDateTime` remains **derived, never stored** (Inv. #3); `effectivityStatus` remains derived from it.

**Known gap, carried from pm46 (not fixed here).** A `flat_fee` lane does not yet split on envelope `priceType`, so a `recurring` and a `oneTime` flat fee starting the same date fall into the same `(component_type='flat_fee', unit_of_measure=NULL)` lane and can appear to supersede one another though they are unrelated charges. The correct lane key adds `price_component ->> 'priceType'` for `flat_fee`; the UI's rendering key (`prodmgmt-ui-context.md` §4) must track whatever this partition ends up being. Closing it is a follow-up unit against the repository's `lead()` window and pm46's uniqueness constraint together, not a pm49 change.

Ordering changes with the partition: rows come back ordered by `component_type`, then `unit_of_measure`, then `start_date_time`, then id — deterministic, and grouped the way the panels render.

### D4. `validateOfferingComponents` — one file, one function, three codes, `tx` first

`services/product/validate-offering-components.ts` (new — the module's first cross-row validator):

```ts
validateOfferingComponents(tx, offeringId, candidate)
  → { ok: true }
  | { ok: false; code: 'MODIFIER_WITHOUT_BASE_RATE'; unitOfMeasure: UnitOfMeasure }
  | { ok: false; code: 'AMBIGUOUS_BASE_RATE' }
  | { ok: false; code: 'CURRENCY_MISMATCH'; existingCurrency: string; candidateCurrency: string }
```

`tx` is the **first argument so the function cannot be called outside a transaction** (§2.14) — the signature is the enforcement, not a comment. All three price-write services call it **after** the DRAFT lock and before the write. The three code names are binding: pm54's banner copy keys off them (§4.19, §7.8).

| Code | Rule | Reads |
| --- | --- | --- |
| `MODIFIER_WITHOUT_BASE_RATE` | VI3 / Inv. #33 — a `capacity_commitment` or `capacity_motivation` requires a `usage_rate` of the **same `unit_of_measure`** on the same offering | sibling rows of the offering, on `tx` |
| `AMBIGUOUS_BASE_RATE` | VI4 / Inv. #34 — exactly one `usage_rate` effective per `(offering, unit_of_measure)` **at the instant being validated** | same |
| `CURRENCY_MISMATCH` | VI5 / Inv. #35 — every combinable component of one offering shares one `currency` | same |

**The candidate is included in the evaluated set.** The function validates the offering *as it would be after the write*: for an insert, siblings + candidate; for an update, siblings with the target row replaced; for a delete, siblings minus the target — which is what makes "deleting the last `usage_rate` while a `capacity_commitment` still binds to it" a `MODIFIER_WITHOUT_BASE_RATE` refusal rather than a silently orphaned modifier. State this in the function's doc comment; it is the single most likely thing for a later change to get wrong.

### D5. VI4 is validated **at an instant** — do not invent a period rule

O5 (effectivity-aware binding resolution across a period containing a dated successor) is a **bill-run-phase open item and a named stop-and-ask** (workflow §5.2). VI4 here means: at the candidate's `start_date_time`, exactly one `usage_rate` is effective for that unit. Dated successors remain legal — that is what pm46's per-lane uniqueness preserves. **Do not** write a rule that scans a period, picks a "dominant" rate, or refuses a legitimate successor; if a test seems to demand one, the test has encoded O5.

### D6. Where each rule lives, and nowhere else

VI1/VI2 → pm47's Zod branch, mirrored by pm46's CHECK. VI3/VI5/VI4 → this validator. DRAFT-only → the repository plus pm36's trigger. Backdating (3 days) → the service, with a Zod fast-fail copy (§1.12) — **unchanged by this unit**. A second copy of any of these in an action, a component or a fixture is drift (§2.16). Actions do not re-validate; they surface codes.

### D7. Audit reuses three event types — payload changes, type does not

`PRODUCT_PRICE_ADDED`, `PRODUCT_PRICE_UPDATED`, `PRODUCT_PRICE_DELETED`, one event per mutation, in the same transaction (§6.18, Inv. #5 of the platform set). Their `beforeData`/`afterData` now carry `component_type` + the `price_component` envelope in place of `price_type` / `pricing_model` / `amount`. **No new audit event type** — so `AUDIT_EVENT_TYPES`, `AUDIT_EVENT_CATEGORY_MAP` and `tests/components/audit-log-filters.test.tsx` counts are all untouched. Confirm that explicitly; the audit-filter ripple has bitten every write unit in this module's history (workflow §7.4).

### D8. `negotiated_override` cannot be written here — proved, not assumed

The repository parses against `persistablePricingComponentSchema` (pm47 I1.8), so a `negotiated_override` payload fails at the type level and at parse time, before the DB CHECK ever sees it (Inv. #39). A test asserts all three layers refuse it: `tsc` (not assignable), Zod (parse throws), and raw SQL (CHECK rejects).

### D9. Service results grow codes; their shape does not

Each price service keeps its `{ ok: true; … } | { ok: false; code: … }` union (§2.10) and gains the three `OfferingComponentViolation` codes in the failure arm, carrying their payload fields. Existing codes (`OFFERING_NOT_FOUND`, `OFFERING_RETIRED`, `BACKDATED_START_TOO_FAR`, `PRICE_NOT_FOUND`, `OFFERING_NOT_DRAFT`) stay. Branch-on-edit from an `ACTIVE` version stays exactly as pm38 left it: the validator runs against the **branched draft's** component set, not the source version's — assert it, because the branch happens mid-transaction and the offering id changes underneath the validator.

### D10. Query budget holds

A component write must not add a per-row query. The validator issues **one** sibling read per write (all components of the offering, on `tx`), and the post-write revalidation path is unchanged. Manage Products' first render still issues one families query plus its count and no per-row detail query; selecting a family still issues four (§3.14). `rateCardLookUp` never triggers a query (§1.27) — nothing resolves it here or anywhere.

---

## Implementation

### I1. `db/repositories/product-offering-price.ts`

1. `findByOfferingIdWithDerivedEnd`: select `componentType` and `priceComponent` instead of the four dropped columns; the `lead()` window partitions by `(productOfferingId, componentType, unitOfMeasure)` (D3); order by `componentType`, `unitOfMeasure`, `startDateTime`, id; parse each `priceComponent` with `persistablePricingComponentSchema` and return `PriceCard`-shaped rows with `component` and `componentType`.
2. `insertPrice(tx, offeringId, data)`: writes `componentType` + `priceComponent` (the already-parsed envelope) plus the retained row columns. It does **not** re-derive `componentType` from the envelope in a way that could disagree — write `component['@type']` as the column value from the parsed object, so Inv. #30 holds by construction and pm46's CHECK never has to fire.
3. `updatePrice` / `deletePrice`: unchanged in contract — parent id in, non-`DRAFT` refused after a `FOR UPDATE` re-read — with the payload re-keyed. **No fourth export.**
4. Delete the `PriceType` / `PricingModel` / `TieredPricingCharacteristics` imports.

### I2. `db/repositories/product-offering.ts`

Remap the price reads inside the offering detail/family read models to the same projection and the same per-lane window (D3). No other change to that file; its offering and specification reads are Part 3's.

### I3. `services/product/validate-offering-components.ts` (new)

D4's single exported function. One sibling read on `tx`; the candidate folded in per the insert/update/delete shape; three checks in a fixed order — currency first (cheapest and offering-wide), then base-rate presence, then ambiguity — so a multi-violation case reports deterministically. Exports `OfferingComponentViolation` as a union type. **No caller outside `services/product/`** (§7.6); not inlined into any service, not duplicated.

### I4. The three price services

1. Replace the `priceCharacteristics` handling with the parsed component from the input union; build the row payload per branch.
2. After the DRAFT lock (and, for the branch-on-`ACTIVE` path, after the branch), call `validateOfferingComponents(tx, targetOfferingId, candidate)`; on `{ ok: false }` return the code, rolling the transaction back.
3. Keep the 3-day backdating check, its `backdated` flag, the branch-on-`ACTIVE` behaviour and the audit write exactly as they are (D6, D7).
4. `deletePrice` calls the validator too (D4) — deleting a base rate out from under a modifier is refused with `MODIFIER_WITHOUT_BASE_RATE`.

### I5. The three actions

Unchanged in shape (`requirePermission` → `isRedirectError` catch → `safeParse` → one service → `revalidatePath` → typed result, §3.7). They carry the component payload and surface the three violation codes in the same typed result the UI reads. No new file; `EXPECTED_PRODUCT_ACTION_FILES` untouched; revalidation still narrow, still both product paths.

### I6. `types/product.ts`

Reshape `PriceCard` per D2. Nothing else — the domain unions landed at pm47.

### I7. Tests

1. **`tests/db/product-price-components.integration.test.ts` (new).** A `usage_rate`, a `capacity_commitment` and a `capacity_motivation` save as three rows on one DRAFT offering; a `flat_fee` joins them; each is readable back with its envelope parsed and its per-lane `endDateTime`/`effectivityStatus` correct (a dated `usage_rate` successor supersedes only the `usage_rate`).
2. **Cross-component refusals**, one case each with its typed code: a `capacity_commitment` in `EA` with no `usage_rate` in `EA` (→ `MODIFIER_WITHOUT_BASE_RATE`, carrying `EA`); a `capacity_motivation` in `GB` beside a `usage_rate` in `EA` (same code — same-unit is the rule, not same-offering); a second effective `usage_rate` for one unit at one instant (→ `AMBIGUOUS_BASE_RATE`); a second component in a different currency (→ `CURRENCY_MISMATCH`, carrying both); **deleting the last same-unit `usage_rate` while a modifier remains** (→ `MODIFIER_WITHOUT_BASE_RATE`).
3. **Legitimate cases that must pass:** a dated successor `usage_rate` (D5 — not `AMBIGUOUS_BASE_RATE`); a `flat_fee` with no `usage_rate` anywhere (it is not a modifier); two modifiers over one `usage_rate` in the same unit.
4. **DRAFT-only:** each of the three writes against a `TESTING`, `ACTIVE`, `OBSOLETE` and `RETIRED` parent is refused by the service/repository, and a direct SQL write is refused by pm36's trigger (workflow §8.3).
5. **Branch-on-`ACTIVE`:** adding a component to an `ACTIVE` version branches a draft and validates against the **branch's** set (D9).
6. **`negotiated_override` refused at all three layers** (D8).
7. **Audit:** exactly one event per mutation, in the same transaction, one of the three existing types, payload carrying `component_type` + the envelope; `audit-log-filters.test.tsx` counts unchanged.
8. **Validator unit tests:** `validateOfferingComponents` cannot be called without a `tx` (type-level), and its three checks fire in the documented order for a multi-violation offering.
9. **Query budget:** a component write adds no query to the page's budget (§3.14).
10. **Authz:** `products : READ` cannot write; `EDIT` can.

### I8. Documentation

1. `prodmgmt-code-standards.md` §7 file tree — add `services/product/validate-offering-components.ts`; mark the three price services and the price repository as re-keyed. Note that the tree's unit markers for the UI files (`pm50`/`pm51`/`pm52`) are **stale** against the final numbering — the renumber lands at pm53/pm54/pm55; record the discrepancy here per workflow §7.10 and fix each marker in the unit that touches the file.
2. Record in the commit message that no audit event type was added (§7.4) and that `EXPECTED_PRODUCT_ACTION_FILES` is unchanged.

---

## Dependencies

**Packages to install: none.** Existing `drizzle-orm`, `zod`, `vitest` and the live-DB harness.

**Commands used:** `npm run test`, `npm run db:migrate`, `npm run db:seed-demo`, `npx tsc --noEmit`, `npm run lint`.

---

## Verification checklist

Write path

- [ ] A `usage_rate`, a `capacity_commitment` and a `capacity_motivation` save as three rows on one DRAFT version and read back with parsed envelopes.
- [ ] The repository still exports exactly three writes; no fourth was added; no new action file exists.
- [ ] `component_type` is written from the parsed envelope's `@type`, so row and envelope agree by construction.
- [ ] Every price write against `TESTING`, `ACTIVE`, `OBSOLETE`, `RETIRED` is refused by the repository **and** by the trigger on a direct SQL write.
- [ ] Branch-on-`ACTIVE` validates against the branched draft, not the source version.

Cross-row validity

- [ ] Each of `MODIFIER_WITHOUT_BASE_RATE`, `AMBIGUOUS_BASE_RATE`, `CURRENCY_MISMATCH` is returned for its case, with its payload fields.
- [ ] Deleting the last same-unit `usage_rate` under a live modifier is refused.
- [ ] A dated successor `usage_rate` is **accepted** — VI4 is instant-scoped and O5 was not implemented.
- [ ] `validateOfferingComponents` takes `tx` first, lives in one file, has no caller outside `services/product/`, and is called by all three write services after the lock.

Read model

- [ ] `PriceCard` carries `componentType` and the parsed `component`, and carries no `amount`, `pricingModel` or `priceType`.
- [ ] `endDateTime` / `effectivityStatus` are computed per `(component_type, unit_of_measure)` lane; a new `capacity_motivation` does not supersede the `usage_rate` beside it.
- [ ] `end_date_time` is still never stored.
- [ ] The envelope is parsed once, at the repository boundary; nothing downstream re-parses it.

Boundaries and regressions

- [ ] `negotiated_override` is refused at `tsc`, at Zod and at the DB.
- [ ] Exactly one audit event per mutation, in-transaction, from the three existing types; no new type; audit-filter test counts unchanged.
- [ ] No `rateCardLookUp` resolution, lookup, join or query exists.
- [ ] No pricing computation lives in `services/product/**` or `db/**` (Inv. #43).
- [ ] The query budget holds after a component write.
- [ ] No page, component, seed or schema file changed in this unit.
- [ ] `tsc --noEmit`, ESLint and Prettier clean for this unit's files; repo-wide green is still pm54's claim (G-E).

**Definition of done:** Billing Ops can save a base rate, a commitment and a motivation onto one draft and get them back exactly as authored — while the server, inside the same transaction that locks the draft, refuses a modifier with no base rate in its unit, a second currency on the offering, and an ambiguous base rate, each with a code the UI can turn into a sentence.
