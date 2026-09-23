# Product Management — Module Code Standards

**Read `context/code-standards.md` first** — it owns every module-agnostic rule (TypeScript strictness, the Server Action shape, styling tokens, API-route policy, file placement, permission naming, CI gates), and this file is only Product Management's delta to it. Nothing general is restated here; if a rule seems missing, it lives in the general file, unchanged.

**Companion docs:** `prodmgmt-project-overview.md` and `prodmgmt-update-overview.md` (product spec) · `prodmgmt-architecture.md` (technical design, numbered **Module Invariants**) · `prodmgmt-ui-context.md` (module token wiring) · `prodmgmt-ai-workflow-rules.md` (build process) · `specs/pm00-build-plan.md` (units pm46–pm53). Authoritative decisions for everything marked **(pricing update)**: **PC1–PC14**, validation invariants **VI1–VI5** and open items **O1–O10** in `_updatemodule-product-pricing-components-plan.md`. Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

> **Status (2026-09-21).** Rules are written as the standard **in force for the module's target state** and are stated once, in the present tense. Three layers are in play and a reader must not conflate them:
>
> 1. **Delivered and verified:** the catalog surfaces (View Product, Manage Products), Orders and Subscriptions as built through pm34.
> 2. **The Manage Products rebuild (pm35–pm45) — delivery unverified.** `pm00-build-plan.md` §0 records that `git ls-tree -r` finds none of `submit-for-testing` / `obsolete-offering` / `delete-offering` / `price-input` / `pricing-component` on `main`, `dev1`, `dev2` or the three `claude/*` branches, and the working tree confirms it (`types/product.ts` still exports a three-value `LIFECYCLE_STATUSES`). Every rule below that depends on the five-value lifecycle, `updatePrice`/`deletePrice`, the DRAFT-guard trigger or the expression unique indexes is therefore **the target standard, not an observed fact**. Do not cite this file as evidence that pm35–pm45 shipped.
> 3. **The Pricing Components update (pm46–pm53) — PLANNED, gated.** Everything marked **(pricing update)** is not built. It is blocked on gate **G-0** (Part 3 live in `main`) and gate **G-C** (written user authorization to edit `0006_product.sql` in place). Build nothing marked **(pricing update)** until both are closed.
>
> **Appendix A is re-opened** (rows A1–A9) because the pricing update supersedes rules that are still asserted in code today.

---

## 1. General Rules (module-specific)

Items 1–20 are the catalog and Manage-rebuild standard. Items 21–34 are the pricing update's.

1. **Writes flow exclusively through the mutation stack.** Every production code path that mutates `product.*` goes through `actions/product/**` → `services/product/**` → repositories, gated by `products : EDIT`/`DELETE`. No `app/api/product*` route exists, or ever will.
2. **Price rows are immutable once their version leaves DRAFT — enforced in code shape, not discipline.** The price repository exports exactly three writes: `insertPrice`, `updatePrice`, `deletePrice`. The latter two take the parent offering id and refuse unless its `lifecycle_status` is `DRAFT`, re-read under `FOR UPDATE` in the same transaction. No fourth write is ever added — the pricing update adds none either.
3. **View Product reads are not audited.** Every Manage Products mutation writes exactly one audit event inside the same transaction as the data change.
4. **The audit log is never a pricing/rating source** (Inv. #7). Historical price state is reconstructed from price rows + `start_date_time`. The single thing that lives only in the audit log is a hard-deleted DRAFT — content that was never billable.
5. **Schema changes are additive, with disclosed exceptions only:** `family_offering_id` (a genuinely new column), the D11 in-place edit of `0006_product.sql`, and the pricing update's second in-place edit, which requires its own written authorization (§6.14). Widening `LifecycleStatus` to five members is a breaking change for every exhaustive switch over it (§2.2) — intended, and never softened with a `default` branch.
6. **The `(admin)` → `(app)` route-group rename changed no URL** (Inv. #12).
7. **Seeds obey the same validation as every other write.** A seed row passes the same Zod schema and satisfies the same completeness CHECKs as user input, in `db/seeds/product.ts`, `db/seeds/demo/product-demo.ts` and `db/seeds/sample/**` alike. **(pricing update)** the schema becomes the `PricingComponent` union and the CHECKs become per-`component_type` (§6.5); a seed emitting a malformed envelope must fail twice — at Zod before insert, and at the CHECK if Zod is bypassed.
8. **Template seed rows keep the `TOREMOVE-Template-` name prefix.** No production code depends on them existing.
9. **`is_bundle` is never user-editable, in any form, ever.** No `isBundle` field in any schema; `insertOffering` hardcodes `false`; `branchOfferingAsDraft` copies the source value through.
10. **Editing a released version never mutates it in place.** An edit targeting an `ACTIVE` version routes through `branchOfferingAsDraft` first. A `TESTING` version is not branched — it is returned to `DRAFT` and edited directly. `OBSOLETE` and `RETIRED` versions have no edit path at all: the UI offers none and the services refuse.
11. **Discard is a delete; withdrawal is a status change; they are three separate services.** `deleteOffering` hard-deletes a `DRAFT` or `TESTING` version that was never `ACTIVE`; `obsoleteOffering` moves `ACTIVE` → `OBSOLETE`; `retireOffering` moves `OBSOLETE` → `RETIRED` behind the subscription gate. They differ in precondition, in audit event, and in whether rows survive.
12. **Backdating tolerance is a service-layer check, not a DB constraint.** `insertPrice` and `updatePrice` reject a `start_date_time` more than 3 days before the transaction's `now()` and flag anything backdated within the window; the Zod copy is a fast-fail only. Unchanged by the pricing update.
13. **Every status read that gates a branch-or-write decision happens inside the transaction, immediately before the decision.** A pre-transaction read is a TOCTOU window. This covers `updateOffering`, the three specification writes, `insertPrice`, `updatePrice`, `deletePrice`, `submitForTesting`, `returnToDraft`, `activateOffering`, `obsoleteOffering`, `retireOffering` and `deleteOffering` — and, **(pricing update)**, the offering-level component validator, which reads sibling rows on `tx` after the lock (§2.14).
14. **Cross-module transactional reads never call another module's service.** A display or form read calls the other module's `services/*` function normally; an in-transaction precondition re-check calls that module's repository's locked (`FOR UPDATE`) finder directly. `retireOffering` calls `productInventoryRepository.countLiveForOfferingForUpdate(tx, offeringId)`, never `services/inventory/**`.
15. **One transition, one service, one audit event.** No generic `setLifecycleStatus(id, status)` helper exists in any layer, and no action takes a target status as a parameter. Each legal transition (Inv. #23) has its own service, preconditions and event type.
16. **A list page never fans out to per-row detail.** A list renders from one paged query. Fetching per-row detail in a loop — `getOfferingDetail` per row, `Promise.all` over rows, or any concurrency-limited mapper over a row set — is prohibited in `app/**` and `services/product/**`. `fetchAllForStatus`, `fetchAllOfferingRows`, `fetchSpecificationsByOfferingId`, `mapWithConcurrencyLimit`, `groupIntoFamilies` and `MAX_COMBINED_ROWS` do not exist and are not to be reintroduced under other names.
17. **Grouping, filtering and paging happen in SQL, in the repository.** `findFamilyPage` returns rows the page renders as-is; a page never groups, slices or re-sorts a result set.
18. **The database is the backstop for every catalog rule that can be expressed there.** DRAFT-only child writes → trigger (§6.8); one open and one ACTIVE version per family → unique indexes (§6.7); component completeness → CHECK constraints (§6.5). The service-layer check stays in all three cases; the database is what holds when a direct SQL write or a future bug goes around it.
19. **A warning never blocks a save; a validation error never renders as a warning.** **(pricing update)** the two tiered warning copies retire with `pricing_model`; the surviving warnings are the two not-yet-billable capacity copies and the absent-rate-card copy (§4.14). A missing required field, a unit outside the list or an unmapped charge period is still a field-level error. The cross-component rules VI3–VI5 are neither: they are a panel-level **blocking** error (§4.19).
20. **Deleting is never offered for a version that was ever ACTIVE**, in the UI or in a service. The affordance is absent, not disabled-with-a-tooltip.
21. **(pricing update) The envelope is the only price shape.** After pm47 there is exactly one way to express a price in this module: a `PricingComponent` object in `price_component`, discriminated on `@type`. Any code path that reads a price shape from a column, from a `pricing_model` string, or from a `tiers[]` array is a defect, not a legacy allowance.
22. **(pricing update) One component per row, and the row never disagrees with the envelope.** `component_type` always equals `price_component ->> '@type'` (Inv. #30). A row whose discriminator and envelope disagree is corruption, not a variant.
23. **(pricing update) Never conflate the envelope's `priceType` with the column `price_type`** (PC13, Inv. #38). The envelope's `priceType` is the TMF axis (`usage` / `recurring` / `oneTime` / `discount` / `commitment`); the dropped column was the legacy product axis (`recurring` / `usage` / `once`), which survives only on `ordering.order_item_price_override`. Never map one onto the other, never derive one from the other, and **never reintroduce `price_type` on `product_offering_price` under any name**.
24. **(pricing update) Money is a decimal string; quantities are numbers** (PC3, Inv. #32). Money matches `^\d+(\.\d+)?$` — in the envelope, in tests, in seeds and in fixtures. No float arithmetic on money anywhere. `committedQuantity` and every `steps[].aboveQuantity` are finite numbers, never strings.
25. **(pricing update) `currency` and `unit_of_measure` are row columns and never envelope data** (PC3). The single echo of the unit inside the envelope is `boundTo.unitOfMeasure`, and it exists solely to resolve a modifier's binding (PC4). `params` never restates either.
26. **(pricing update) Product defines and stores components; it never prices them** (Inv. #43). No capacity resolver, no schedule evaluation, no rate-card lookup, no proration and no rounding policy lives in `services/product/**` or `db/**`. The composition contract is asserted here as a pure function (§2.17) and executed in Bill Run.
27. **(pricing update) `rateCardLookUp` is a name, not a reference** (PC10, Inv. #42). It is an unresolved string with no FK, no join and no table behind it. Build no lookup and no fallback logic; record PC10's precedence in the schema doc-block and stop there.
28. **(pricing update) TMF620 alignment is documentation, never a runtime dependency** (Inv. #40). No adapter, no SDK, no mapper, no serializer, no DTO, no `toTmf620()`. One `plaSpec` doc-block per `@type` plus the mapping table in `pricing-component.schema.ts` **is** the deliverable.
29. **(pricing update) `negotiated_override` is a projection, never a catalog row** (PC9, Inv. #39). It is a branch of the Zod union and it is **excluded from the `component_type` CHECK enum**. `ordering.order_item_price_override` is never reshaped: one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`, and its repository never gains an `update*` or `delete*`.
30. **(pricing update) No backfill, no data-fix script, no relabelling migration, no dual-read shim.** PC14 runs under fresh install: the old shape is deleted, not migrated. A compatibility path that reads `amount` "just in case" is a defect, and the absence of such a script is a success criterion, not an omission.
31. **(pricing update) `tiered` does not survive anywhere** (PC8, Inv. #41). `pricing_model`, the `tiered` literal, `tierSchema`, `tieredPricingCharacteristicsSchema` and `TieredPricingCharacteristics` are deleted outright. Do not re-express tiers as a generic "tier" helper, a `steps` alias or a deprecated export.
32. **(pricing update) The envelope is closed: exactly eight fields, exactly five types.** `@type`, `specVersion`, `plaSpecId`, `priceType`, `appliesAt`, `basis`, `boundTo`, `params`; `usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`, `negotiated_override`. A ninth field or a sixth type is a new phase, not a unit. **No `sequence` field** — apply order is canonical by stage then class (PC12, Inv. #37), and that omission is considered, not a gap.
33. **(pricing update) `specVersion` is present on every stored envelope** (Inv. #44). A reader that ignores it is a defect; a shape change without incrementing it is a breaking change disguised as a patch.
34. **(pricing update) This update has no cross-module reach — with one flagged exception, now resolved.** No unit reads or writes `ordering/**`, `inventory/**`, `billing/**` or `rating/**`, other than the one authorized crossing below. **The exception:** `services/ordering/order-preconditions.ts:95` resolved an override target with `price.priceType === override.priceType && price.pricingModel === "flat"`. Both properties disappeared when pm46 dropped the columns, so `tsc` broke in a folder every workflow rule forbids this update to touch, and `prodmgmt-architecture.md` §3.7 (which said that line ships with this update) contradicted `prodmgmt-ai-workflow-rules.md` §3.2 and §6.5 (which said it must not be touched). **G-G authorization GRANTED 2026-09-22 (Khek)**, naming exactly `services/ordering/order-preconditions.ts`, `validation/ordering/create-order.schema.ts` (comments only) and the four ordering integration test fixtures (`create-order`, `review-order`, `ordering-read`, `subscription-lifecycle`), and stating the crossing is a re-key with no behaviour change. **Delivered by pm50**, re-keyed to `component_type` (`usage_rate` / `flat_fee`) per pm50-spec D2/D3 — no compatibility shim, `ordering.order_item_price_override` untouched (§1.29/§6.21 still hold).

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions**, defined once as `as const` string-literal unions in `types/product.ts`:
   - `LifecycleStatus`: `'DRAFT' | 'TESTING' | 'ACTIVE' | 'OBSOLETE' | 'RETIRED'`. Declare the members in **lifecycle order**, not alphabetically — sort order in the UI derives from the array index, and nothing else may re-declare that order.
   - `UnitOfMeasure`: `'Mbps' | 'GB' | 'MB' | 'EA'` — **case-sensitive literals**. `'MBPS'`, `'mbps'` and `'Gb'` are not members and are not normalised on the way in.
   - `RecurringPeriodType`: `'months'` (single member; `months` only, length ∈ (1, 3, 12), per bm29's resolver). Adding a member requires a migration changing the CHECK **and** a confirmed mapping in the bill run's recurring resolver — never a TypeScript-only edit.
   - **(pricing update)** `ComponentType`: `'usage_rate' | 'flat_fee' | 'capacity_commitment' | 'capacity_motivation'` — the four **persistable** types, and the exact list the `component_type` CHECK admits. `negotiated_override` is a union branch, **not** a `ComponentType` member (§1.29).
   - **(pricing update)** `EnvelopePriceType`: `'usage' | 'recurring' | 'oneTime' | 'discount' | 'commitment'` (the TMF axis, PC7). `AppliesAt`: `'rating' | 'post_aggregation' | 'billing'`. `Basis`: `'quantity' | 'flat'`.
   - **(pricing update) Deleted:** `PricingModel` and `PriceType`. Neither is renamed, aliased or re-exported; `tsc` proving they have no referent is the test.
2. **Every map keyed by a domain union is a total `Record`.** `Record<LifecycleStatus, X>` for badge variants, labels, allowed actions and sort weight; **(pricing update)** `Record<ComponentType, X>` for badge wiring, form branches, field requirements and completeness expectations. Adding a member must break the build in every such map rather than fall through to a default. No `switch` over a domain union without an exhaustive `never` default.
3. **JSONB typing per general §6.17.** `ProductSpecCharacteristics` lives in `validation/product/`; the Drizzle `.$type<T>()` type derives from it. **(pricing update)** `price_component` is `.$type<PricingComponent>()`, deriving from `validation/product/pricing-component.schema.ts`.
4. **(pricing update) `PricingComponent` is a Zod discriminated union on `@type`, and every branch is a `strictObject`** (PC1/PC2, Inv. #31). An unknown key is **rejected, never stripped**. The type is `z.infer<typeof pricingComponentSchema>` — never declared alongside the schema. The DB CHECK is the backstop, never the primary guard.
5. **Money per general §2.15.** Envelope money (`ratePerUnit`, `amount`, `steps[].ratePerUnit`) is a decimal string validated by one shared `moneyStringSchema` declared once in `pricing-component.schema.ts`. No money arithmetic in this module's production code.
6. **`end_date_time` exists only as a computed field** — `endDateTime: Date | null` on the read model. No stored end (Inv. #3). **(pricing update)** it is computed **per `(component_type, unit_of_measure)` lane** (§6.4), so a `capacity_motivation` never supersedes the `usage_rate` beside it.
7. **Entity IDs are plain `string`s validated by Zod format schemas** (`/^PRDOFR\d{8}$/` etc.). Both `?family=` and `?version=` are parsed against the offering-ID schema before any repository call.
8. **(pricing update) Price input is discriminated by `componentType`, not `priceType`.** `price-input.schema.ts` is rebuilt as a discriminated union on the component type: the `usage_rate` branch requires `unitOfMeasure` and forbids the recurring-period pair; the `flat_fee` branch forbids `unitOfMeasure` and requires the period pair **iff** its envelope `priceType` is `recurring`; the two capacity branches require `unitOfMeasure` and forbid the period pair. Optional-and-nullable fields are not an acceptable substitute — the impossible combination must be untypeable, not merely rejected at runtime.
9. **Read models live in `types/` as composed shapes**, returned by services so pages never re-join: `OfferingListRow`, `OfferingDetail`, `SpecificationCard`, `PriceCard`, `FamilyListRow`, `FamilyPage`, `VersionSummary`. `OfferingFamilyRow`, `selectPrimary` and `resolveFamilyId` do not exist. **(pricing update)** `PriceCard` carries `componentType: ComponentType`, the parsed `component: PricingComponent`, and the per-lane `endDateTime` / `effectivityStatus`; it carries no `amount`, no `pricingModel` and no `priceType` column field.
10. **Transition results are typed unions, never thrown errors** (general §2.9). Each transition service returns `{ ok: true; … }` or `{ ok: false; code: … }` with codes drawn from a single exported union per service — e.g. `RETIRE_BLOCKED_BY_SUBSCRIPTIONS` carries `liveCount: number`.
11. **`effectivityStatus` stays derived, `lifecycleStatus` stays stored.** Never add a derived "is billable" or "is orderable" column or field.
12. **(pricing update) `plaSpecId` is a literal per branch, not free text.** `capacity_commitment` → `'PLA_CAPACITY_COMMITMENT'`; `capacity_motivation` → `'PLA_CAPACITY_MOTIVATION'`; `flat_fee` and `negotiated_override` → `null`; `usage_rate` → `'PLA_USAGE_RATE'` **only when `rateCardLookUp` is non-null**, `null` otherwise — a cross-field refinement inside the branch, not a caller's responsibility.
13. **(pricing update) `boundTo` is `{ unitOfMeasure: UnitOfMeasure }` or `null`**, plus `priceType` on `negotiated_override` only. It is binding data, never display data, and never a price-id pointer (PC4).
14. **(pricing update) The cross-row validator is one exported function with typed codes.** `validateOfferingComponents(tx, offeringId, candidate)` in `services/product/validate-offering-components.ts` returns `{ ok: true }` or `{ ok: false; code: OfferingComponentViolation; … }`, where `OfferingComponentViolation` is exactly `'MODIFIER_WITHOUT_BASE_RATE'` (VI3 — carries the required `unitOfMeasure`) · `'AMBIGUOUS_BASE_RATE'` (VI4) · `'CURRENCY_MISMATCH'` (VI5 — carries both currencies). It takes `tx` as its first argument so it cannot be called outside a transaction, and all three price-write services call it after the DRAFT lock. These names are binding: the UI copy in §4.19 keys off them.
15. **(pricing update) VI4 is validated at the instant being validated, not across a period.** Do not invent a period-wide resolution rule to close the dated-successor case: that is open item **O5** and it belongs to the bill-run phase.
16. **(pricing update) No re-declaration of a DB-enforced rule outside its one home.** VI1/VI2 live in the Zod branch (mirrored by the CHECK); VI3–VI5 live in §2.14's validator; the DRAFT gate lives in the repository and the trigger. A second copy in an action, a component or a test fixture is drift.
17. **(pricing update) The composition contract is a test-local pure function and exports nothing to production.** It lives with its test (`tests/product/pricing-composition-contract.test.ts`), takes the envelope types as input, and reproduces the worked figures: `800 EA → 100,000`, `2000 EA → 150,000`, `3000 EA → 175,000` with the second `@25` band, plus the commitment-exceeds-first-step case. Stated plainly: this asserts the reference implementation's arithmetic, not production behaviour — nothing in this module prices components (§1.26), and Bill Run must reproduce these figures when it does.
18. **(pricing update) `import type` the envelope everywhere.** `PricingComponent`, `ComponentType` and the branch types are type-only imports outside `validation/`; a component or a page never imports `pricingComponentSchema` itself to re-parse data a service already parsed.

---

## 3. Next.js Rules (module-specific)

1. **Both catalog pages are thin RSC orchestrators.** `product-offering/page.tsx`: guard (READ) → await `searchParams` → parse → services → compose. `manage-products/page.tsx`: guard (EDIT) → await `searchParams` → parse `q`/`status`/`page`/`family`/`version` → `listFamilies` → compose the families table, and, when `family` is present, the version bar and the three panels. No fetch loop, no grouping, no DB access in the page.
2. **List and selection state lives in URL searchParams.** View Product: `q`, `status`, `sort`, `page`, `offering`. Manage Products: `q`, `status`, `page`, `family`, `version`. No client-side store, no `useState` mirror of the URL. **(pricing update)** adds no search param — a component type is never a URL filter.
3. **searchParams are parsed, never trusted.** Unknown or malformed values fall back to schema defaults. A `family` that matches no row renders the empty-selection state; a `version` that is not a member of that family is ignored and the family's primary version is selected instead — neither is a 404 and neither is an error boundary.
4. **Row selection is a `<Link>` that rewrites the searchParams**, preserving the others. This applies to Manage Products' family rows and version-bar entries too. No `onClick` + `router.push` + component state.
5. **Manage Products shows every lifecycle status**; View Product hides `RETIRED` by default, server-side, and its default filter also hides `OBSOLETE`. The status filter can surface both.
6. **`'use client'` only at interaction leaves.** The families table, version bar, specification panel and price panel render as server components. **(pricing update)** the client leaves grow by exactly three — the component-type picker, the `steps[]` editor and the component sub-form — and no more: `ManagePricesPanel` does **not** become a client component because a branch inside it is editable.
7. **Every `actions/product/*` file follows one shape**: `requirePermission` → `isRedirectError` catch → `schema.safeParse` → delegate to one write service → `revalidatePath` → typed `{ok, code}` result. **(pricing update)** the three price actions carry the component payload and surface §2.14's violation codes in that same typed result; no action file is added and `EXPECTED_PRODUCT_ACTION_FILES` is unchanged.
8. **Revalidate narrowly.** A mutation revalidates `/products/manage-products` and `/products/product-offering`; the page must not re-fetch unselected families' details to satisfy it — §1.16 holds after a mutation exactly as it holds on first load. `router.refresh()` is not the success path; the action's `revalidatePath` is.
9. **Nav renders per the platform's permission-filtered registry**; each page guard enforces.
10. **Page metadata:** View Product's title and `H1` are "View Product"; Manage Products' are "Manage Products". Both segments ship `loading.tsx` and `error.tsx`. `manage-products/loading.tsx` renders the families-table skeleton only — not panel skeletons, which have nothing to load until a family is selected.
11. **`export const dynamic = 'force-dynamic'` stays on both pages** (authz-dependent data is never cached, general §3.8).
12. **(pricing update) The update adds no route, no page, no segment and no permission.** If a unit finds itself creating one, it has left scope.
13. **(pricing update) A cross-component refusal is a server result, never a client pre-check.** The picker may disable a branch the offering cannot yet accept as a convenience, but the authoritative refusal is §2.14's code returned from the action, and the banner renders from that result (§4.19). Never mirror VI3–VI5 in client state as the decision.
14. **(pricing update) The query budget is part of the page contract.** Manage Products' first render issues one families query plus its count and **no** per-row detail query; selecting a family issues the version, detail, specification and price queries once each — and the budget holds unchanged after a component write. A component's `rateCardLookUp` never triggers a query (§1.27).

---

## 4. Styling (module-specific)

Token values are owned by `prodmgmt-ui-context.md` and are not duplicated in code or restated here; this section binds names, structure and copy.

1. **Shared indicator components**, created exactly with these names: `LifecycleBadge` and — **(pricing update)** — `PricingComponentBadge`, which **replaces `PriceTypeBadge`** when `price_type` is dropped. `LifecycleBadge` covers all five statuses from a total `Record<LifecycleStatus, …>` (§2.2):

   | Status     | Treatment                                          | Icon            |
   | ---------- | -------------------------------------------------- | --------------- |
   | `DRAFT`    | warning tint                                       | `pencil-line`   |
   | `TESTING`  | info tint                                          | `flask-conical` |
   | `ACTIVE`   | success tint                                       | `check-circle`  |
   | `OBSOLETE` | neutral tint, row muted, still actionable (Retire) | `history`       |
   | `RETIRED`  | neutral tint, row muted, no actions                | `archive`       |

   Icon + label always; never colour-only meaning.

2. **JSONB entries render as plain text, not widgets** — spec characteristics as `key: value`. **(pricing update)** `capacity_motivation.steps` render as ascending semicolon-separated inline text (`base 100; above 1000: 50; above 2000: 25`), and `capacity_commitment` renders as `committed 1,000 EA` — quantity and unit only, **no currency**, because the component carries no money. No `CharacteristicChip`, no `TierTable`, no `StepTable`.
3. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for the View Product table and the families table. Never fork a parallel table implementation.
4. **Four-section layout.** View Product: table, detail, then specs and prices side-by-side at `lg:`, stacking on narrow viewports. Manage Products uses the same grid with a version bar between the table and the panels, stacking table → version bar → detail → specifications → prices.
5. **Money formatting goes through `formatCurrency(amount, currency, locale)`.** No inline `toFixed`, no hardcoded symbols. **(pricing update)** envelope money arrives as a decimal string and is formatted with the **row's** `currency`; it is never re-parsed to a different precision and never converted to a number on the way to the formatter.
6. **Datetime display goes through `formatDatetime(date, locale, timezone, …)`** with the timezone threaded as a prop; `<time dateTime>` stays ISO-8601 UTC. Calendar dates (the subscription `end_date` in the retirement message) use `formatCalendarDate`.
7. **Boolean flags** (`is_bundle`, `is_sellable`, billing-only) render through one shared yes/no indicator.
8. **Component names are binding**, created exactly as written: `FamilyTable`, `VersionBar`, `OfferingForm`, `SpecificationForm`, `ManageSpecificationsPanel`, `PriceForm`, `ManagePricesPanel`, `CreateOfferingDialog`, `SubmitForTestingDialog`, `ActivateOfferingDialog`, `ObsoleteOfferingDialog`, `RetireOfferingDialog` (OBSOLETE → RETIRED only), `DeleteVersionDialog`. **(pricing update)** adds exactly four — `PricingComponentBadge`, `ComponentTypePicker`, `CapacityMotivationStepsEditor`, `OfferingComponentErrorBanner` — and retires `PriceTypeBadge`. There is no family-expand tree and no per-row action cluster.
9. **`--action-cta-bg` is used exactly once per view** — the "New offering" button in the Manage Products header. Version-level actions use the quiet secondary/ghost treatment; Obsolete, Retire and Delete use the danger role and only inside their confirmation dialogs. **(pricing update)** the picker, the steps editor and the error banner introduce **no** accent-filled action.
10. **Version-level actions live in the selected version's header, not on every list row.** The families table carries navigation and status only.
11. **Inline editing affordances.** An editable panel row shows its value as text until activated, then an input with explicit Save and Cancel. No auto-save on blur, no optimistic row mutation — the server action's typed result is what updates the view. A panel on a non-`DRAFT` version renders the read-only variant with **no disabled inputs**, so "not editable now" never looks like "broken". Keyboard contract: `Esc` cancels and restores the prior value; `Enter` saves a single-field row; `Cmd`/`Ctrl+Enter` saves a multi-field row; focus returns to the edited row on save and to the opening control on cancel; one row is editable at a time. **(pricing update)** a component row is multi-field, so `Cmd`/`Ctrl+Enter` is its save key.
12. **"This creates a new draft" warning** appears in the edit affordance whenever the selected version is `ACTIVE`, never on a `DRAFT` target. Warning tokens, no icon. Copy: _"`<Name>` is active. Saving will not change it — a new draft version is created instead."_
13. **Backdating warning** appears when a price start date is in the past but within the 3-day tolerance; beyond it, a standard `FieldError`. Copy: _"This price is backdated to `<date>`; historical bills may be affected."_
14. **(pricing update) The not-yet-billable warning has exactly three copies**, in the warning treatment, inline under the component row, **never blocking the save** (O10, §1.19). The two tiered copies are deleted with `pricing_model`:
    - _"Bill run does not apply a capacity commitment yet — this component is stored but not billed."_
    - _"Bill run does not apply a capacity motivation yet — usage bills at the base rate until then."_
    - _"No rate card exists yet — `<name>` falls back to the rate per unit."_
15. **Numeric conventions:** `--font-mono` for IDs, GL codes and — **(pricing update)** — a `rateCardLookUp` name, with a muted "default rate" beside it when null; `tabular-nums` for amounts, version numbers, charge-period lengths, `committedQuantity` and every `steps[].aboveQuantity`. A usage component shows `amount / unit` (e.g. `RM 0.05 / GB`); a recurring `flat_fee` shows `amount / period` (e.g. `RM 5,000.00 / month`), with the unit and period taken from the row, never inferred. The unit keeps its stored casing exactly (`Mbps`, never `MBPS`).
16. **Empty states** use `--text-muted` on `--surface-sunken`: no family selected; a family with one version (the version bar renders the single entry, with no affordance implying more); a DRAFT with no prices yet (with the "at least one price is required to submit for testing" hint). The fresh-catalog and no-filter-match states read differently and are never one blank grid.
17. **No AI/Iris-violet tokens and no marketing gradients on any product page** — unchanged module exclusion. `capacity_motivation` uses the shared **Accent** scale with `trending-down`, which is brand, not AI, and never renders in the same view as the Orders/Subscriptions "Negotiated" pill.
18. **(pricing update) `PricingComponentBadge` is one total `Record<ComponentType, …>`**, so a new component type is a compile error. `flat_fee` is the one type with **two variants** — its label and hue come from `price_component.priceType` (`recurring` vs `oneTime`), **never** from the charge-period columns: a `flat_fee` with no period is `oneTime`, not a broken recurring price. `negotiated_override` gets no badge here (§1.29).
19. **(pricing update) Cross-component violations render as a panel-level danger banner, not a `FieldError`.** `OfferingComponentErrorBanner` sits at the top of the pricing panel with `alert-triangle` in the danger role, names the offending components by their §4.18 badge label, and **disables Save while it is present**. Copy states the missing counterpart, not the rule name — _"Target Capacity Commitment needs a base usage rate in EA. Add one before saving."_ It is deliberately **not** the warning tint, which would understate a rule that blocks the save. This is the one place in the module where a pricing error is not row-local.
20. **(pricing update) The authoring form leads with the component type.** `ComponentTypePicker` shows the §4.18 badge label plus one line of help; the rest of the form is that branch's `params` only. `currency` and `unit_of_measure` are row-level fields **above** the branch (every component of an offering shares them — PC3/VI5), and the recurring-period fields appear on the `flat_fee` branch only. `CapacityMotivationStepsEditor` is an add/remove row list kept in ascending order by the form — **never a free-text JSON field** — and refuses a duplicate threshold before the server sees it.
21. **(pricing update) Derived envelope fields are never surfaced.** Raw `@type` / `component_type` values, `specVersion`, `plaSpecId`, `appliesAt`, `basis` and `boundTo` appear in no user-facing string, label, tooltip or table cell. The badge label is the user-facing name of a component type.

---

## 5. API Routes (module-specific)

1. **This module adds no Route Handlers, ever, in any phase** — including the Manage rebuild and the pricing update. `app/api/**` gains nothing from Product Management. Reads flow RSC page → `services/product` → repositories; writes flow through `actions/product/**`.
2. **A product Route Handler would require a platform design review first** (general §5.1 scope: auth provider, callbacks, M2M only).
3. **A PR adding any `app/api/product*` path is rejected at review**, and a guardrail test asserts the path's absence.
4. **(pricing update) TMF620 alignment is not a reason to open one.** There is no TMF620 endpoint, no adapter route and no export route — the mapping is a documentation table (§1.28). "TMF-shaped internally, no external TMF API" is the module's settled stance, not a deferral.

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `product` schema:** `product_offering`, `product_specifications`, `product_offering_price` — three, and still three after the pricing update. No fourth table, no `pla_spec` registry table, no rate-card table, no identity/RBAC/session/config/audit tables.
2. **ID prefixes:** `PRDOFR`, `PRDSMD`, `PRDOFP`; one sequence per table; prefix + 8-digit zero-padded.
3. **The price table has no `end_date_time` and no `last_update` column** (Inv. #3). Effectivity end is derived at query time by the `lead()` window; never stored, cached or backfilled.
4. **(pricing update) The uniqueness index rekeys, once, with `NULLS NOT DISTINCT`.** `product_offering_price_type_start_unique` on `(product_offering_id, price_type, start_date_time)` becomes `(product_offering_id, component_type, unit_of_measure, start_date_time)` **`NULLS NOT DISTINCT`**. `unit_of_measure` is NULL for `flat_fee`, and a plain UNIQUE treats two NULLs as distinct — so without it, two identical `flat_fee` rows on one offering at one `start_date_time` both insert and VI4 silently does not hold. Follow the `0013_gl_mapping_nulls_not_distinct.sql` precedent; **never** solve it with a sentinel `unit_of_measure` string or a `COALESCE` expression index. The `lead()` window partitions by the same key, which is what makes §2.6's per-lane effectivity correct. A second component of the same type and unit may only be **created** while the parent is `DRAFT` — the §6.8 trigger enforces that, not the index.
5. **(pricing update) Completeness is a per-`component_type` CHECK, mirrored in Zod**, one per rule, named so a violation is self-explaining. It **replaces** the flat/tiered `amount`-XOR-tiers CHECK, the `pricing_model` CHECK, the `amount >= 0` CHECK and the legacy `price_type` CHECK:

   | `component_type`      | Row columns                                                                       | Envelope `params`                                                                                                       |
   | --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | `usage_rate`          | `unit_of_measure` NOT NULL; recurring pair NULL                                   | `ratePerUnit` a money string; `rateCardLookUp` nullable                                                                  |
   | `flat_fee`            | `unit_of_measure` NULL; recurring pair present **iff** envelope `priceType = 'recurring'` | `amount` a money string                                                                                           |
   | `capacity_commitment` | `unit_of_measure` NOT NULL; recurring pair NULL                                   | `committedQuantity` finite, `> 0`                                                                                       |
   | `capacity_motivation` | `unit_of_measure` NOT NULL; recurring pair NULL                                   | `steps` non-empty; `aboveQuantity` strictly ascending, non-duplicate, `> 0`; each `ratePerUnit` a money string           |

   The `component_type` CHECK admits **exactly these four values** — `negotiated_override` is excluded (§1.29). `product_offering_price_period_value_check` (`months` + length ∈ (1, 3, 12)) and the 3-character `currency` CHECK are unchanged.
6. **`created_at` vs `start_date_time` stay distinct and both required.** Neither substitutes for the other in a query.
7. **Single-active and single-open per family are DB unique indexes on an expression**: `product_offering_one_active_per_family` on `(COALESCE(family_offering_id, product_offering_id))` `WHERE lifecycle_status = 'ACTIVE'`, and `product_offering_one_open_per_family` on the same expression `WHERE lifecycle_status IN ('DRAFT','TESTING')`. The advisory lock and the in-transaction re-check in `activateOffering` **stay** — the index changes the failure mode, it does not replace the lock. Untouched by the pricing update.
8. **Child writes require a `DRAFT` parent, enforced by a trigger**: `BEFORE INSERT OR UPDATE OR DELETE` on `product_specifications` and `product_offering_price`, rejecting any parent whose `lifecycle_status` is not `DRAFT`, and exempting a child delete when the parent row is itself being deleted (the cascade `deleteOffering` relies on). **(pricing update) the trigger is not modified** — the reshaped columns must fit under it as-is, and a component write against a `TESTING`, `ACTIVE`, `OBSOLETE` or `RETIRED` parent is refused by the repository **and** by the trigger on a direct SQL write.
9. **Child FKs cascade on delete**: `product_specifications.ref_product_offering_id` and `product_offering_price.product_offering_id` are `ON DELETE cascade`. The self-referencing `family_offering_id` stays `restrict`.
10. **`version` is a row's sequence number within its family**, assigned once at insert, never changed (Inv. #8).
11. **`lifecycle_status` gates selection, not readability** (Inv. #6, #17): ordering filters `ACTIVE`; billing reads a pinned version whatever its status. A repository finder never filters out `OBSOLETE` or `RETIRED` rows on the caller's behalf — it exposes the status and lets the caller filter.
12. **JSONB writes are schema-guarded everywhere**, seeds included (Inv. #4). **(pricing update) the discriminator moves from `pricing_model` to `component_type`**, and the guarded column from `pricing_characteristics` to `price_component`. The platform doc's example in `context/architecture.md` §3 names `pricing_model` and goes stale when this lands — a one-line follow-up there, owned by whoever lands pm46.
13. **(pricing update) Tier storage does not exist.** The deferred tier child-table decision is closed by deletion (PC8): no tier storage, no `tiers[]`, no deferred child table. This supersedes the prior "tier storage stays JSONB" rule.
14. **(pricing update) `0006_product.sql`'s second in-place edit — GRANTED (Khek, 2026-09-21), gate G-C.** The D11 one-round exception was closed at pm45 and forward-only was restored; PC14 needed a second in-place edit, and the user granted it in writing on 2026-09-21, under the same fresh-install assumption (PC14, O3/O4 resolved). **The grant also covers `0007_product_constraints_fix.sql`'s one-statement removal of `product_offering_price_amount_check`** (pm46-spec I3) — the grant's text names `0006`, but the same fresh-install reasoning applies, and pm46 records that extension here explicitly rather than silently stretching the grant. Landed by pm46: `db/schema/product.ts` kept in sync **by hand**, no `drizzle-kit generate` run, `meta/0006_snapshot.json` and `meta/_journal.json` left byte-identical, guardrail 13 re-baselined, every environment rebuilds its database from empty. **Forward-only remains the rule for every migration other than this one authorized exception** — a third in-place edit of `0006` (or a first of any other applied migration) needs its own fresh grant, not a reading of this one. **Third in-place edit — GRANTED (Khek, 2026-09-22):** a post-pm46 code-review hardening of `product.pricing_steps_ok` — each `(… ->> 'aboveQuantity')::numeric` cast is now `CASE WHEN jsonb_typeof(…) = 'number'`-guarded so a non-numeric threshold reaching the DB (a raw-SQL write bypassing Zod) fails the CHECK cleanly instead of risking a raw cast error from an unordered sibling AND/OR operand. Fresh-install regime unchanged; `db/schema/product.ts` needs no mirror change (it names the function, not its body); guardrail 13 (function exists / `IMMUTABLE` / pre-table) stays green. **Never** write a migration that adds an enum value and then uses it: the migrator applies all pending files in one transaction and Postgres rejects the use (`unsafe use of new value`, verified on PG 16.13).
15. **The retirement gate is one repository predicate, written once**: a subscription counts as live when `status <> 'TERMINATED' OR (end_date IS NULL OR end_date >= current_date)`. It lives in `productInventoryRepository.countLiveForOfferingForUpdate` and is called by `retireOffering` inside its transaction. Do not re-express it in a service, a page or a test fixture.
16. **A hard delete's audit payload is the only surviving record**: `PRODUCT_OFFERING_DELETED.beforeData` carries the version id, name, `version`, `lifecycle_status`, and the counts of specifications and prices removed, written in the same transaction as the delete.
17. **Reason text on a transition is captured in the audit payload (`transitionReason`), not a column.** This covers every transition in Inv. #23.
18. **(pricing update) No new audit event type.** Component writes reuse `PRODUCT_PRICE_ADDED`, `PRODUCT_PRICE_UPDATED` and `PRODUCT_PRICE_DELETED`; their before/after payloads carry `component_type` + the `price_component` envelope in place of `price_type` / `pricing_model` / `amount`. If a new type is ever approved it needs its `AUDIT_EVENT_TYPES` entry, its `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught) **and** a count/optgroup fix in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught) — the ripple that has bitten every write unit in this module's history.
19. **(pricing update) The dropped columns are dropped, not deprecated.** `price_type`, `pricing_model`, `amount` and `pricing_characteristics` leave `product_offering_price` together, along with `product_offering_price_pricing_model_check`, `product_offering_price_amount_xor_tiers_check`, `product_offering_price_amount_check` and `product_offering_price_type_check`. No view, alias, generated column or compatibility shim reproduces them.
20. **(pricing update) The two new columns are `component_type text NOT NULL`** (CHECK-constrained to the four persistable types, indexed) **and `price_component jsonb NOT NULL`** (`$type<PricingComponent>`). `currency`, `unit_of_measure`, `start_date_time`, the recurring-period pair, `gl_code` and `policy` are retained unchanged; `policy` stays NULL and stays out of the form.
21. **(pricing update) The blast radius of the drops is wider than this module — treat the reader inventory as the checklist, not the module's own file list.** `product.product_offering_price` is read by `workflow-management/worker/workflow-engine/runtime/rp.py` (`rating_runtime`: **re-keyed by pm51, 2026-09-22, G-G authorization granted** — reads `component_type = 'usage_rate'` and `(price_component #>> '{params,ratePerUnit}')::numeric`, partitions the effectivity window by `(product_offering_id, component_type, unit_of_measure)`), by `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml`'s `_bm29_resolved` CTE + D33 checks (`billrun_runtime`, contract comments mirrored in the sibling `bill_run_processing.template.yml`, same query mirrored in `tests/db/helpers/billrun-aggregate.ts`: **re-keyed by pm52, 2026-09-23, G-G authorization treated as granted per the pm50/pm51 basis** — the window is filtered on `component_type = 'flat_fee'` only, never the envelope `priceType` (pm52-spec D3's masking-hazard reasoning), reads `flat_fee.params.amount`, partitions by `(product_offering_id, component_type, unit_of_measure)`; `RECURRING_PRICE_UNSUPPORTED` now fires on the **resolved as-of row**'s envelope `priceType = 'oneTime'` with no override, D4 option A), and by `services/ordering/order-preconditions.ts` (**re-keyed by pm50**, §1.34). Grants are table-level `SELECT`, so the **additions** are grant-transparent and need no bootstrap role change; the **drops** break reader SQL at parse time. Test fixtures reach further still — `pricing_model` / `pricingModel` was seeded or asserted in the rating suites (`rm08`, `rm09`, `rm10`, `rm13`, **re-keyed by pm51**), the bill-run suites (`billrun-phase3-journey`, `billrun-recurring-aggregation`, `billrun-verification-reconciliation`, `tests/db/helpers/billrun-aggregate.ts`, **re-keyed by pm52**), the ordering suites (`create-order`, `review-order`, `ordering-read`, `subscription-lifecycle`, **re-keyed by pm50**), `ship-gate-guardrails`, and `db/seeds/sample/seed-billrun-sample.ts` (**re-keyed by pm48**). Each crossing needed its own authorization before the reshape merges — the rating, ordering and bill-run crossings are now all closed.
22. **(pricing update) The reshape is one-shot and lands on one branch — window corrected to pm46–pm54, green claimed at pm54 (gate G-E, 2026-09-21).** Dropping four columns breaks every consumer at `tsc` — repository, services, seeds, forms and the prices panel — and O3 resolved *against* a phased retirement while §1.30 forbids a dual-read shim. pm46–pm54 land on one feature branch and merge to `main` together; no unit inside that window merges to `main` alone, and the full-suite-green claim is made once, at pm54 — **not pm49**, which this rule previously (and incorrectly) named.

---

## 7. File Organization (module-specific)

Placement per general §7. The tree shows the **catalog scope at the pricing update's target state**: `(pmNN)` marks the delivering unit, `(new)` a file the update adds, `(del)` a file it deletes. Remove a `(new)` marker when the file exists; remove a `(del)` line when the file is gone. The Ordering & Inventory tree is untouched by this update and is not repeated.

```
app/(app)/products/product-offering/
  page.tsx                            # ProductOfferingPage — guard (READ)
  loading.tsx, error.tsx
app/(app)/products/manage-products/
  page.tsx                            # ManageProductsPage — guard (EDIT); families + panels
  loading.tsx, error.tsx
actions/product/
  create-offering.action.ts, update-offering.action.ts
  create-specification.action.ts, update-specification.action.ts, delete-specification.action.ts
  insert-price.action.ts              # (pm49) component payload — no new action file
  update-price.action.ts              # (pm38, pm49)
  delete-price.action.ts              # (pm38, pm49)
  submit-for-testing.action.ts        # (pm42)
  return-to-draft.action.ts           # (pm42)
  activate-offering.action.ts
  obsolete-offering.action.ts         # (pm43)  ACTIVE -> OBSOLETE
  retire-offering.action.ts           # (pm43)  OBSOLETE -> RETIRED only
  delete-offering.action.ts           # (pm44)  hard delete of a never-released version
components/products/
  offering-table.tsx, offering-detail.tsx
  specifications-panel.tsx
  prices-panel.tsx                    # (pm53) renders components — View Product's file (§7.3)
  lifecycle-badge.tsx
  pricing-component-badge.tsx         # (pm53)  PricingComponentBadge
  price-effectivity.tsx               # (pm41, pm53) per-(component_type, unit) lane
components/products/manage/
  inline-row-editor.tsx               # (pm41)  shared Save/Cancel + keyboard shell
  family-table.tsx                    # (pm39)  FamilyTable
  version-bar.tsx                     # (pm40)  VersionBar
  manage-specifications-panel.tsx     # (pm41)  server
  manage-prices-panel.tsx             # (pm41, pm54) server; hosts the banner
  editable-specifications.tsx         # (pm41)  client leaf
  editable-prices.tsx                 # (pm41, pm54/55) client leaf
  component-type-picker.tsx           # (pm54, new)  ComponentTypePicker
  offering-component-error-banner.tsx # (pm54, new)  OfferingComponentErrorBanner (VI3–VI5)
  capacity-motivation-steps-editor.tsx # (pm55, new) CapacityMotivationStepsEditor
  version-action-header.tsx           # (pm41)
  offering-form.tsx, specification-form.tsx
  price-form.tsx                      # (pm54/55) one sub-form per component_type
  create-offering-dialog.tsx, activate-offering-dialog.tsx
  submit-for-testing-dialog.tsx       # (pm42)
  obsolete-offering-dialog.tsx        # (pm43)
  retire-offering-dialog.tsx          # (pm43)
  delete-version-dialog.tsx           # (pm44)
services/product/
  list-offerings.ts, list-families.ts, get-offering-detail.ts
  list-family-versions.ts             # (pm40)
  get-live-subscription-count.ts      # (pm43)
  create-offering.ts, update-offering.ts
  add-specification.ts, update-specification.ts, delete-specification.ts
  insert-price.ts, update-price.ts, delete-price.ts    # (pm38, pm49)
  validate-offering-components.ts     # (pm49)  VI3/VI4/VI5 — tx-first (§2.14)
  submit-for-testing.ts, return-to-draft.ts            # (pm42)
  activate-offering.ts, obsolete-offering.ts, retire-offering.ts, delete-offering.ts
db/schema/product.ts                  # 3 tables; component_type + price_component; per-type CHECK
db/repositories/
  product-offering.ts                 # detail/family read models carry the component
  product-specification.ts
  product-offering-price.ts           # exactly three writes (pm38, pm49)
db/migrations/0006_product.sql        # second in-place edit landed — §6.14 (gate G-C granted); locked again after
db/seeds/product.ts, db/seeds/demo/product-demo.ts, db/seeds/sample/seed-billrun-sample.ts
validation/product/
  offering-list.schema.ts, family-list.schema.ts       # (pm39)
  pricing-component.schema.ts         # (pm47)  union + plaSpec catalog + TMF620 table
  price-input.schema.ts               # (pm38, pm47) discriminated by componentType
  insert-price.schema.ts, update-price.schema.ts       # (pm38)
  create-offering.schema.ts, update-offering.schema.ts
  create-specification.schema.ts, update-specification.schema.ts
  transition.schema.ts                # (pm42)
types/product.ts                      # PricingComponent + ComponentType; no PricingModel/PriceType
tests/
  product/pricing-composition-contract.test.ts         # (pm47)  pure function (§2.17)
  validation/pricing-component.schema.test.ts          # (pm47)
  db/product-price-component-constraints.integration.test.ts  # (pm46)
  ...                                 # mirrors source; authz matrix; guardrails (§9)
```

1. **The nav lives in the shared registry** (`lib/nav-registry.ts` + `components/nav-icons.ts`); no product-specific nav file.
2. **`services/product` stays framework-agnostic** — no `next/*` imports; parsed params in, §2.9 read models out.
3. **View Product's files are not edited to suit Manage Products** (Inv. #29). The route folder `app/(app)/products/product-offering/**` may be touched only for its nav label and page `H1`; `components/products/*.tsx` may be **imported** from `components/products/manage/**` but never reshaped for it. **(pricing update)** `prices-panel.tsx` is the exception that proves the rule: it renders the old flat/tiered shape, it belongs to View Product, and it needs a change it cannot absorb read-only — so it lands as its **own authorized unit (pm50)**, never inside the authoring diff.
4. **One transition per file** — in `actions/product/` and `services/product/` alike. Do not collapse the transition services into a state-machine module.
5. **(pricing update) `validation/product/pricing-component.schema.ts` is the in-codebase source of truth for the envelope.** Its doc-block is a **shipped deliverable, not a comment**: one `plaSpec` description per `@type` plus the TMF620 mapping table, cross-linked from the module `AGENTS.md` and `README.md` (PC11). A unit that lands the union without them is incomplete.
6. **(pricing update) The cross-row validator is one file with one exported function** (§2.14), imported by the three price-write services. Do not inline it into any of them, do not duplicate it, and do not give it a caller outside `services/product/`.
7. **(pricing update) No file is added outside the tree above.** In particular: no `db/migrations/*backfill*`, no `lib/tmf620*`, no `services/product/*resolver*`, no `db/schema/rate-card*`, and no fourth price file in `actions/product/`.

---

## 8. Permission Names & Per-Page Permission Map

**Permission name:** `products` — single, page-level, code-seeded via migration; referenced as `PERMISSIONS.PRODUCTS`. READ gates View Product **including prices** (no pricing-visibility split, Inv. #10). EDIT gates authoring and release; DELETE gates removal and withdrawal. **The module has exactly one catalog permission**; every transition is distributed across its EDIT/DELETE split, and no transition gets a permission of its own.

**(pricing update) This update changes no row in this table** — no page, no route, no permission, no level, no guard. Authoring a pricing component is ordinary DRAFT price editing under `products : EDIT`. That has been checked against the update's full file list and is stated here explicitly so the next reader does not have to re-derive it.

Authoritative; mirrors architecture §4. Every page and every mutation appears here before it ships, and any change lands **in both places in the same change set** (here and `prodmgmt-architecture.md` §4).

| Page / action                                                             | Route                        | Top-level component                                                                                                | Folder                                                           | Permission : level                                                    |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| View Product — list + detail + specs + price components                   | `/products/product-offering` | `ProductOfferingPage` → `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel`, `PricingComponentBadge` | `app/(app)/products/product-offering/`                       | `products` : **READ**                                                 |
| Manage Products — families list, version bar, panels                      | `/products/manage-products`  | `ManageProductsPage` → `FamilyTable`, `VersionBar`, `ManageSpecificationsPanel`, `ManagePricesPanel`               | `app/(app)/products/manage-products/`                            | `products` : **EDIT**                                                 |
| — create offering / edit DRAFT / branch from ACTIVE                       | `/products/manage-products`  | `CreateOfferingDialog`, `OfferingForm`                                                                             | `actions/product/{create,update}-offering.action.ts`             | `products` : **EDIT**                                                 |
| — add / update / delete a specification _(update, delete: DRAFT only)_    | `/products/manage-products`  | `ManageSpecificationsPanel`, `SpecificationForm`                                                                   | `actions/product/*-specification.action.ts`                      | `products` : **EDIT**                                                 |
| — add / update / delete a **pricing component** _(DRAFT only)_            | `/products/manage-products`  | `ManagePricesPanel`, `ComponentTypePicker`, `PriceForm`, `CapacityMotivationStepsEditor`, `OfferingComponentErrorBanner` | `actions/product/{insert,update,delete}-price.action.ts`    | `products` : **EDIT**                                                 |
| — submit for testing / return to draft                                    | `/products/manage-products`  | `SubmitForTestingDialog`, `VersionBar`                                                                             | `actions/product/{submit-for-testing,return-to-draft}.action.ts` | `products` : **EDIT**                                                 |
| — activate (TESTING → ACTIVE, supersedes to OBSOLETE)                     | `/products/manage-products`  | `ActivateOfferingDialog`                                                                                           | `actions/product/activate-offering.action.ts`                    | `products` : **EDIT**                                                 |
| — stop selling (ACTIVE → OBSOLETE)                                        | `/products/manage-products`  | `ObsoleteOfferingDialog`                                                                                           | `actions/product/obsolete-offering.action.ts`                    | `products` : **DELETE**                                               |
| — retire (OBSOLETE → RETIRED, subscription-gated)                         | `/products/manage-products`  | `RetireOfferingDialog`                                                                                             | `actions/product/retire-offering.action.ts`                      | `products` : **DELETE**                                               |
| — discard (hard delete a DRAFT/TESTING version and its components)        | `/products/manage-products`  | `DeleteVersionDialog`                                                                                              | `actions/product/delete-offering.action.ts`                      | `products` : **DELETE**                                               |
| Orders — list + New order + Review                                        | `/products/orders`           | `OrdersPage` → `OrdersTable`, `NewOrderWizard`, `OrderReviewPanel`                                                 | `app/(app)/products/orders/`, `actions/ordering/`                | `product_orders` : **READ** (list) / **EDIT** (create)                |
| — approve / reject a `PENDING` order                                      | `/products/orders`           | `ReviewActions`                                                                                                    | `actions/ordering/{approve,reject}-order.action.ts`              | `product_orders` : **EDIT** + **MANAGER role** + reviewer ≠ submitter |
| Subscriptions — list + lifecycle + characteristics                        | `/products/subscriptions`    | `SubscriptionsPage` → `SubscriptionsTable`, lifecycle dialogs                                                      | `app/(app)/products/subscriptions/`, `actions/inventory/`        | `product_inventory` : **READ** (list) / **EDIT** (mutations)          |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- A principal with `products : EDIT` but not `DELETE` reaches every authoring and release action — including every component type — and is refused `obsoleteOffering`, `retireOffering` and `deleteOffering` at the action guard. Asserted in the authz matrix, both directions.
- Deep links grant nothing: `?offering=`, `?family=` and `?version=` all pass through their page's guard first.
- `product_orders` / `product_inventory` carry no grant overlap with `products` in either direction, ship-gate-proven.
- **(pricing update)** a cross-component refusal (VI3–VI5) is a **validation** failure, not an authorization failure: it returns §2.14's typed code, never a 403-equivalent, and it never appears in the authz matrix.

---

## 9. Module Guardrail Tests (CI gate §10.4)

Guardrails 1–30 are the catalog, Ordering and Manage-rebuild set. The pricing update re-scopes two and adds four; each is that update's deliverable and must be **landed, not assumed**.

**Re-scoped by the Manage rebuild**

| #                            | Change                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 — Price immutability       | A successor insert leaves prior rows byte-identical; `updatePrice`/`deletePrice` exist, succeed on a `DRAFT` parent, and are refused for every other status — **and** a direct SQL update or delete against a non-`DRAFT` parent's price is rejected by the trigger. **(pricing update)** its fixtures move to the component payload; the assertions are unchanged. |
| 8 — Single-active-per-family | Keeps the two-concurrent-activations assertion; adds a direct-SQL insert of a second `ACTIVE` row being rejected by `product_offering_one_active_per_family`.                                                                                                                                |
| 11 — View stays read-only    | `components/products/*.tsx` (excluding `manage/`) and the View Product route import nothing from `actions/product/`, `components/products/manage/`, or a write service. The converse assertion is dropped — `manage/` importing View's read-only components is correct (Inv. #29).            |
| 16 — Grandfathering          | The superseded version is `OBSOLETE` (not `RETIRED`) and the pinned subscription's `OrderPriceLine`/rating reads resolve byte-identically from it. **(pricing update)** extended: the pinned version's resolved components are byte-identical after an activation, **envelope included**.     |

**Re-scoped by the pricing update**

| #                         | Change                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13 — Schema-diff          | Re-baselined to the reshaped price table: `component_type` + `price_component`, the per-`component_type` completeness CHECK, the rekeyed `NULLS NOT DISTINCT` uniqueness index, and the **absence** of `pricing_model`, `amount`, `pricing_characteristics` and the legacy `price_type` column. Still an exact diff, not a removal. |
| 27 — Price completeness   | Re-keyed from `price_type` to `component_type`. A `usage_rate` without `unit_of_measure`, a `flat_fee` without `params.amount`, a `capacity_commitment` with `committedQuantity <= 0`, and a `capacity_motivation` with empty, duplicate or non-ascending `steps` each fail in Zod **and** at the database; seeds are covered by the same assertions. |

**New with the Manage rebuild (23–30)** — lifecycle transition set · DRAFT-only child writes · one open version per family · hard delete · price completeness · retirement gate · no detail fan-out · status-literal sweep. In force as written.

**New with the pricing update**

31. **Tiered is gone.** `pricing_model`, the `tiered` literal, `tierSchema`, `tieredPricingCharacteristicsSchema` and `TieredPricingCharacteristics` appear nowhere in the repository. Grep-asserted, and `tsc` proves the type has no referent. _(Inv. #41)_
32. **Envelope strictness.** An unknown key in any component branch is **rejected**, never stripped; every branch is a `strictObject`; and the DB CHECK refuses the same malformed object **independently of Zod**. _(Inv. #31)_
33. **Cross-component validity.** A `post_aggregation` modifier with no same-unit `usage_rate` on the offering, a second effective `usage_rate` for one `(offering, unit)`, and two components of one offering in different currencies are each refused at the write boundary with §2.14's typed code. _(VI3, VI4, VI5)_
34. **The override is untouched.** `ordering.order_item_price_override` is still one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`, and its repository still exports no `update*` or `delete*`. Asserted by the existing exported-surface guardrail. _(Inv. #39)_

**Also gated, though not numbered guardrails:** the composition-contract test (§2.17) must reproduce its four figures; the query budget (§3.14) must hold after a component write; and the `plaSpec` doc-block + TMF620 mapping table must exist and be cross-linked from `AGENTS.md` and `README.md` (§7.5).

The authz matrix (guardrail 1) extends to every row of §8. The pricing update adds no row to it and must say so explicitly at its ship gate rather than leaving it unexamined.

---

## Appendix A — Superseded wording and the code/tests that still assert the old rules

**Re-opened by the pricing update.** Appendix A was cleared at pm45; the pricing update supersedes rules that are asserted in shipped code today, so each is tracked here until the new rule is live in `main`. **Clear a row only by grep, never from memory** — a row that outlives its code is drift.

| #   | Superseded rule (still asserted today)                                                                                                                | Replaced by                                                                                                                                       | Clears with            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A1  | ~~Inv. #5 — `amount` and tiers are mutually exclusive; `flat` ⇒ `amount NOT NULL`, `tiered` ⇒ tiers present, as a DB CHECK plus Zod mirror.~~ **CLEARED (pm46, 2026-09-21).**              | PC14 — `component_type` + `price_component`; the XOR CHECK replaced by the per-`component_type` completeness CHECK (§6.5). Both columns dropped.  | pm46 ✓                 |
| A2  | ~~Inv. #4 — "tiered tiers must be contiguous and non-overlapping" (`tierSchema.superRefine`).~~ **CLEARED (pm47, 2026-09-21).**                                                           | VI1 — `capacity_motivation.steps` non-empty, `aboveQuantity` strictly ascending, non-duplicate, `> 0`. Same idea, new home (PC8).                  | pm47 ✓                 |
| A3  | ~~Inv. #2 and `product_offering_price_type_start_unique` keyed on `price_type`.~~ **CLEARED (pm46, 2026-09-21).**                                                                          | The rekey to `(product_offering_id, component_type, unit_of_measure, start_date_time)` with `NULLS NOT DISTINCT` (§6.4).                           | pm46 ✓                 |
| A4  | ~~Inv. #28 — price completeness expressed per `price_type` (`recurring` / `usage` / `once`), and the four `price_type`-keyed CHECKs.~~ **CLEARED (pm46, 2026-09-21).**                     | Completeness expressed per `component_type`; `price_type` no longer exists on `product_offering_price` (PC13, PC14).                               | pm46 ✓                 |
| A5  | ~~`pricing_characteristics` comes from the Zod schemas in `validation/product/`; `PricingCharacteristics` is a union on `pricing_model`.~~ **CLEARED (pm47, 2026-09-21).**                 | `price_component` comes from `pricing-component.schema.ts`; `pricing-characteristics.schema.ts` is deleted with its two tier schemas.              | pm47 ✓                 |
| A6  | Forward-only migrations are the rule again (closed at pm45); `0006_product.sql` is locked.                                                             | **Gate G-C GRANTED (Khek, 2026-09-21)** — a second in-place edit, under the fresh-install assumption (PC14, O3/O4 resolved). Row stays open for the *general* forward-only rule (still in force for every migration other than this one authorized exception); only this specific edit is cleared. | gate G-C (granted)     |
| A7  | Guardrail 27 as written at pm45 — a recurring price without a period, a usage price without a unit, a `once` price carrying either.                    | Guardrail 27 re-keyed to `component_type` (§9). **pm53 delivered the rendering half** (`PricingComponentBadge` + `PricesPanel` read the reshaped row); the guardrail's own re-key is a pm56 assertion.                                                          | pm56                   |
| A8  | ~~"Tier storage stays JSONB; the child-table migration remains the rating module's deferred decision."~~ **CLEARED (pm46, 2026-09-21).**                                                   | Tiers are dropped entirely (PC8) — no tier storage and no deferred child table (§6.13).                                                            | pm46 ✓                 |
| A9  | ~~`services/ordering/order-preconditions.ts:95` resolved an override target with `price.priceType === override.priceType && price.pricingModel === "flat"`.~~ **CLEARED (pm50, 2026-09-22).** | Re-keyed to `component_type` (`usage_rate` / `flat_fee`) via an explicit `Record<OverridePriceType, {componentType; envelopePriceType?}>` lookup (D2/D3). G-G authorization granted 2026-09-22 (Khek), naming the six files pm50-spec §Gate G-G lists; recorded in workflow Appendix A row W4 in the same change set (§1.34). | pm50 ✓                  |

**Unresolved, tracked here because it has no other home:** the delivery record for pm35–pm45 and the state of `enterprise-billing-app/` disagree. Until that is reconciled, treat every "delivered" claim about the Manage rebuild in this file, in `prodmgmt-architecture.md` and in `pm00-build-plan.md` as **unverified**. The workflow-rule counterparts are in `prodmgmt-ai-workflow-rules.md` Appendix A.
