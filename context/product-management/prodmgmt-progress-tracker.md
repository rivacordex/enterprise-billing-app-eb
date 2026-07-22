# Product Management — Progress Tracker

## Status

Phase 1 (all 9 units) implemented and committed. Module is ship-gate-verified (pm09) at the DB/test level; CI SAST/DAST baseline is a pipeline step outside this tooling.

Phase 2 (CRUD fast-follow) in progress: pm10–pm17 implemented, verified, and committed.

| Unit | Name                                                                 | Commit    |
| ---- | --------------------------------------------------------------------- | --------- |
| pm01 | Route-group rename `(admin)` → `(app)` + rename-invariance CI proof   | `313a66e` |
| pm02 | DB foundation + validation schemas + seeds (`product` schema)         | `962a2e8` (fix `232d78d`) |
| pm03 | Repositories + `services/product`                                     | `a168465` |
| pm04 | Nav refactor (`NAV_ITEMS` → `NAV_SECTIONS`)                            | `2f5fd35` |
| pm05 | Page — one section per unit (table → detail → specs → prices)         | `e0d026f` |
| pm06 | Offering detail section (populated `OfferingDetail` fields)           | `bc33109` |
| pm07 | Specifications panel (populated `SpecificationsPanel`)                | `998ed1b` |
| pm08 | Prices panel (populated `PricesPanel`, `formatCurrency`)              | `9561d27` |
| pm09 | Authz-matrix entry + guardrail sweep (ship gate)                      | `e94e565` |
| pm10 | Schema: `family_offering_id` version-lineage column (Phase 2, unit 1) | `5884e76` |
| pm11 | Backend: Create offering (`insertOffering`, `createOffering`) (Phase 2, unit 2) | `a349a97` |
| pm12 | Backend: Branch-as-draft primitive (`branchOfferingAsDraft`) (Phase 2, unit 3) | `273a764` |
| pm13 | Backend: Update offering (`updateOfferingDraftInPlace`, `updateOffering`) (Phase 2, unit 4) | `2b44f21` |
| pm14 | Backend: Specification management (Phase 2, unit 5)                   | `18f06d0` |
| pm15 | Backend: Price management (Phase 2, unit 6)                           | `efe66f7` |
| pm16 | Backend: Activation & Retirement/Discard (Phase 2, unit 7)            | `3557bfa` |
| pm17 | Nav: Relabel + "Manage Products" entry (Phase 2, unit 8)               | `fe38281` |

**Renumbering note:** `pm02-spec.md` bundles DB foundation + `validation/product/` + seeds into one unit, superseding an earlier 3-way split. Numbers above match `pm00-build-plan.md`'s 9-unit count.

## Recurring patterns (apply across units — not repeated per-unit below)

- **Permission-name ripple:** adding `"products"` to `PERMISSION_NAMES` forced `products: null`/`"DELETE"` into every hardcoded `EffectivePermissionMap` object-literal fixture across ~25+ test files (`tsc`-caught for object literals, but a few hardcoded array-length assertions in `roles-read.service.test.ts` were not). See `[[permission-name-addition-ripple]]`.
- **Cross-schema integration-test ripple:** every pre-existing `tests/**/*.integration.test.ts` doing a fresh `DROP SCHEMA core CASCADE` + migrate cycle needed `DROP SCHEMA IF EXISTS "product" CASCADE` added first (26 files) — otherwise the next file's migration fails with "schema product already exists." See `[[new-pgschema-integration-test-ripple]]`.
- **`db → validation` ESLint boundary:** both `db/schema/product.ts` (type-only JSONB import) and `types/product.ts` (`SpecificationCard`/`PriceCard` embedding Zod-owned shapes) needed `"validation"` added to their allowed-import targets in `eslint.config.mjs` — a forced companion change in pm02 and pm03, not scope creep.
- **Region-seam pattern:** pm05 built `OfferingDetailRegion` with three placeholder frames (Details/Specifications/Prices) carrying `{/* pmXX */}` seam comments; pm06/pm07/pm08 each filled exactly one seam, leaving the other two frames byte-unchanged, and each left the `<h2>` section title owned by the region (not the child component).
- **Audit event-type ripple (every Phase 2 write unit):** each new `AUDIT_EVENT_TYPES` entry needs (1) an `AUDIT_EVENT_CATEGORY_MAP` entry in `types/audit-log.ts` (`tsc`-caught) and (2) a bumped event-type count + optgroup assertion in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). See `[[audit-event-type-addition-ripple]]`.
- **Repository mutation allow-lists:** `tests/db/product-repository-exports.test.ts` and `tests/guardrails/product-module-boundaries.test.ts`'s `PRODUCT_WRITE_SERVICE_FILES` both need a new entry per write unit — expected, flagged once by pm11, not a surprise since.
- **Verification baseline per unit:** `tsc --noEmit` + `eslint .` + `prettier --check` clean, plus `npx vitest run` (unit config) and a live-DB backend-correctness pass via a disposable `tsx` script (real dev DB, distinctive name/id prefix, cleaned up and re-confirmed zero rows afterward — never checked in). CI SAST/DAST and a live dev-server browser walkthrough remain unverified (no CI/browser in-session) unless noted per-unit.

## Per-unit notes

**pm01** — Renamed `app/(admin)/**` → `app/(app)/**` (14 files, `git mv`), updated 6 test imports + 2 path comments, added `tests/app/route-manifest.test.ts` as the rename-invariance guardrail.

**pm02** — `db/schema/product.ts` (`product` schema: `lifecycle_status` enum, 3 sequences, 3 tables, full constraints), migration `0006_product.sql` + `products` permission row, permission registry wiring, `types/product.ts`, `validation/product/`, `db/seeds/product.ts`. Follow-up fix (`232d78d`, migration `0007`): `product_offering.last_edited_by` FK → `ON DELETE SET NULL`; `CHECK (amount >= 0)` added to `product_offering_price`.

**pm03** — Read backend: three finder-only repositories (price repo permanently exports no mutation, Inv. #1), `listOfferings` + `getOfferingDetail` (injectable-clock `resolveEffectivityStatus`, `LEAD() OVER` window for derived `endDateTime`). Migration `0008` (not `0007` — pm02's follow-up consumed it).

**pm04** — `components/admin-nav.tsx`: flat `NAV_ITEMS` → sectioned `NAV_SECTIONS`, new "Products" section above "Administration." Manually verified live: render order, active-state, collapsed-mode divider, clean 404 pre-route.

**pm05** — `app/(app)/products/product-offering/page.tsx`, `LifecycleBadge`, `OfferingTable`, `OfferingDetailRegion` (three-seam shell). Added route to the frozen manifest.

**pm06** — `OfferingDetail` fills the Details seam. User-verified live ("looks good").

**pm07** — `CharacteristicChip` + `SpecificationsPanel` fill the Specifications seam.

**pm08** — `formatCurrency`, `PriceTypeBadge`, `TierTable`, `PricesPanel` fill the Prices seam. Component work sequenced ahead of pm07's commit (explicit user direction); diff later split into two clean commits before push.

**pm09 (ship gate)** — Tests + CI only. Confirmed all 6 inherited guardrails green; flagged "price immutability bumps version" as untestable in v1 (no mutation path yet — correct for that phase). Added authz-matrix entries + `tests/guardrails/product-module-boundaries.test.ts`. Real deviation: `products` permission is migration-seeded DML, so the spec's "insert in bulk seed array" text would violate the unique constraint — fixed by `SELECT`-ing the seeded row instead.

**Post-ship polish (2026-07-09, `e2bb187`)** — UI density pass; deleted `CharacteristicChip`/`TierTable` per explicit instruction, inlined as plain text instead.

**Post-ship deployment bug (2026-07-09, `d5f7148`)** — deployed instance 500'd (`42501: permission denied for schema product`) because `bootstrap-db-roles.sql` only ever granted privileges on `core`. Fixed by appending a `product` grant/revoke block (incl. sequence grants). **Any future schema must add its own grant block in the same change that adds its migration, or this recurs.**

---

## Phase 2 (CRUD Fast-Follow)

**pm10 — Schema: `family_offering_id`.** Added nullable, self-referencing `familyOfferingId` (`ON DELETE RESTRICT`) + index + self-reference CHECK to `productOffering`. Migration `0010` (schema-diff generated). Two notes: self-referencing FK needed an explicit `(): AnyPgColumn =>` return-type annotation (Drizzle inference gap, compile-time only); FK constraint name truncated by Postgres's 63-char limit to `product_offering_family_offering_id_product_offering_product_of`. One in-scope test fix: `product-schema.test.ts`'s exact-column-set assertion needed the new column added.

**pm11 — Backend: Create offering.** `create-offering.schema.ts` (no `isBundle` field, ever), `insertOffering` (hardcodes `isBundle: false`/`familyOfferingId: null`/`version: 1`/`DRAFT`), `createOffering` service (insert + `PRODUCT_OFFERING_CREATED` audit, one transaction, no uniqueness pre-check). Forced companion fixes (first occurrence of the now-recurring pattern): `AUDIT_EVENT_CATEGORY_MAP` entry, `audit-log-filters.test.tsx` count bump, and both `product-repository-exports.test.ts`/`product-module-boundaries.test.ts` relaxed from blanket read-only prohibitions to named allow-lists (Phase 2 architecture explicitly permits offering-repo writes; price repo stays permanently finder-only sans `insert*`). Live-DB verified: FK-enforced atomicity (bad actorId rolls back the offering insert too), real insert produces correct defaults + exactly one audit row.

**pm12 — Backend: Branch-as-draft primitive.** `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)` clones an offering + all spec/price rows into a new `DRAFT`; `isBundle` always copied from source, never `overrides` (grep-confirmed no read path, even via `as any`). One-hop family resolution inlined, not extracted (explicit "not yet" call). No audit write — caller composes it. Live-DB verified via a script that deliberately threw to force rollback (byte-diffed before/after): version/family resolution (root and branch-of-branch), status always `DRAFT` regardless of source, override `??` semantics, full child-row cloning, zero-children case, source untouched.

**pm13 — Backend: Update offering.** `update-offering.schema.ts` (`name`/`isSellable`/`billingOnly`/`saveAsNew`), `updateOfferingDraftInPlace` (DRAFT-guarded in-place update, never touches `version`/`familyOfferingId`/`isBundle`), `updateOffering` service (four-way routing: in-place DRAFT save w/ no-op short-circuit, `branchAndAudit` shared by ACTIVE-target and `saveAsNew`, `OFFERING_RETIRED`/`NOT_FOUND` guards). Two new audit types (`_UPDATED` Change, `_BRANCHED` Additive) + the two repository/guardrail allow-list bumps. Live-DB verified via real commits against `PM13VERIFY-`-prefixed rows, fully cleaned up after: in-place edit, no-op guard, `saveAsNew` still branches even on identical values, ACTIVE-target branch with correct family/version, not-found/retired guards.

**pm14 — Backend: Specification management.** `create-specification.schema.ts`/`update-specification.schema.ts` (field-identical), `product-specification.ts` gains `insertSpecification`/`updateSpecification`/`deleteSpecification`, three services with uniform branch-first-when-ACTIVE routing + a `findClonedCounterpart` content-matching helper (duplicated once between update/delete, per spec's explicit judgment call). Three new audit types (`_CREATED`/`_UPDATED`/`_DELETED`). One undiscovered-until-test-run gap: `product-repository-exports.test.ts`'s spec-repository assertion needed the same allow-list treatment pm11 gave the offering repository (not named in pm14-spec's own diff list). Live-DB verified against `PM14VERIFY-`-prefixed rows plus the real seeded ACTIVE offering (to test `findClonedCounterpart` picking the right row among multiple candidates); one real snag: price/spec rows are `ON DELETE RESTRICT` against offering, so cleanup had to delete children before parents.

**pm15 — Backend: Price management.** `insert-price.schema.ts` + `product-offering-price.ts` gains `insertPrice` (repo's only-ever write, Inv. #1), `insertPrice` service (branch-first-when-ACTIVE, 3-day backdating tolerance checked twice — schema fast-fail + injectable-`now` service check, needed separate time sources since schema's `superRefine` uses real `Date.now()`). One new audit type (`PRODUCT_PRICE_ADDED`, Additive). Live-DB verified: direct/branch-first paths, backdating boundary, not-found/retired guards.

**pm16 — Backend: Activation & Retirement/Discard.** `activate-offering.schema.ts`/`retire-offering.schema.ts` (both single-field `reason`), `product-offering.ts` gains `findActiveInFamily` (`.for("update")` row-locks the whole family by immutable identity, first use of locking in this codebase), `activateOffering` (transactional Inv. 13 re-check + retire-sibling + flip-to-ACTIVE), `retireOffering` (unconditional flip to `RETIRED`, one method backs both retire and discard per code-standards §1 rule 11). Four new audit types (`_ACTIVATED`/`_SUPERSEDED`/`_RETIRED`/`_DISCARDED`). Live-DB verified via disposable script: all precondition/guard rejections, automatic supersession, **Inv. 13 under real concurrency run 4× — exactly one family member ended up `ACTIVE` every time**, retire/discard confirmed to share the identical repository method.

**pm17 — Nav: Relabel + "Manage Products" entry.** `components/admin-nav.tsx`'s "Products" section relabeled to "View Product" + new sibling "Manage Products" item, deliberately with no `requiredPermission` (nav-renders-regardless-of-permission convention, pm17-spec §2.2). Data-only diff, zero render-loop/type changes. §2.6 folded in: `product-offering/page.tsx`'s `metadata.title`/`H1` → "View Product," text only. Tests extended per §3.5, all pre-existing Customer-section assertions pass unmodified. `/products/manage-products` 404s until `pm18`. Full suite green (155 files / 1414 tests).

## Per-unit specs

| Unit | Spec file            | Summary                                                                                                                                                                                                                                                                  |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pm01 | `specs/pm01-spec.md` | Rename `app/(admin)/**` → `app/(app)/**` (14 files, `git mv`); update 6 test imports + 2 path comments; add rename-invariance CI proof. No other change. |
| pm02 | `specs/pm02-spec.md` | `product` schema/migration/seeds in one unit: 3 tables + enum + 3 sequences + all constraints; permission registry wiring; `validation/product/`; `db/seeds/product.ts`; unit + integration guardrail tests. No `app/**`, `actions/product/`, or repository code. |
| pm03 | `specs/pm03-spec.md` | Read backend: 3 finder-only repositories (price repo permanently exports no mutation, Inv. #1), `services/product` (`listOfferings`, `getOfferingDetail`), data-only migration seeding page-size config, `types/product.ts` read models. No `app/**`, `actions/product/`, or UI. |
| pm04 | `specs/pm04-spec.md` | `components/admin-nav.tsx`: flat `NAV_ITEMS` → sectioned `NAV_SECTIONS`, new "Products" section; collapsed-rail divider between sections. No `app/**`, permission check, or dependency change. |
| pm05 | `specs/pm05-spec.md` | `app/(app)/products/product-offering/page.tsx` (guard + searchParams parse + fetch); `LifecycleBadge` + `OfferingTable` + `OfferingDetailRegion` (new). No `services/**`, `db/**`, `validation/**`, `actions/**`, `app/api/**`; no field-level rendering (pm06–08); no authz-matrix entry (pm09). |
| pm06 | `specs/pm06-spec.md` | `OfferingDetail` (new) — populated Details section. `offering-detail-region.tsx` + page threading (edit). No backend, `admin-nav.tsx`, or `offering-table.tsx` change; no specs/prices rendering; no authz-matrix entry. |
| pm07 | `specs/pm07-spec.md` | `CharacteristicChip` + `SpecificationsPanel` (new) — populated Specifications section. `offering-detail-region.tsx` edit (Specifications seam only). No backend or prior-unit UI change; no prices rendering; no authz-matrix entry. |
| pm08 | `specs/pm08-spec.md` | `formatCurrency` (edit) + `PriceTypeBadge` + `TierTable` + `PricesPanel` (new) — populated Prices section. `offering-detail-region.tsx` edit (Prices seam only). No backend or prior-unit UI change; no authz-matrix entry. |
| pm09 | `specs/pm09-spec.md` | `guard.integration.test.ts` edit (authz matrix) + `product-module-boundaries.test.ts` (new) — the module's ship gate: authz-matrix entry + 5-assertion negative-space sweep. Tests + CI only, no product code change; no doc edit needed. |
| pm10 | `specs/pm10-spec.md` | `db/schema/product.ts` edit — nullable, self-referencing `family_offering_id` on `product_offering` + index + self-reference CHECK. Migration `0010_product_offering_family.sql` (schema-diff generated). Schema-only, first Phase 2 unit. No repository/service/type/UI code. |
| pm11 | `specs/pm11-spec.md` | Backend create path: `create-offering.schema.ts` (no `isBundle` field, ever), `insertOffering` repository method (hardcodes `isBundle: false`/`familyOfferingId: null`/`version: 1`/`DRAFT`), `createOffering` service (insert + `PRODUCT_OFFERING_CREATED` audit row, one transaction, no uniqueness pre-check). No Server Action, UI, or page — those are pm19. |
| pm12 | `specs/pm12-spec.md` | Backend data-access primitive: `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)` on `product-offering.ts` — clones an offering plus all its spec/price rows into a new `DRAFT` row, one-hop family resolution, `MAX(version)+1` numbering, `isBundle` copied unconditionally (no `overrides` key). No audit, service, action, or UI — consumed by pm13–pm16. |
| pm13 | `specs/pm13-spec.md` | Backend update path: `update-offering.schema.ts` (`name`/`isSellable`/`billingOnly`/`saveAsNew`, no `offeringId`/`isBundle`), `updateOfferingDraftInPlace` repository method (`DRAFT`-guarded in-place `UPDATE`), `updateOffering` service — four-way routing table (`ACTIVE`→branch, `DRAFT`+`saveAsNew`→branch, plain `DRAFT`→in-place with no-op guard, `RETIRED`→rejected), `PRODUCT_OFFERING_UPDATED`/`_BRANCHED` audit events. No Server Action, UI, or page — those are pm20. |
| pm14 | `specs/pm14-spec.md` | Backend specification CRUD: `create-specification.schema.ts`/`update-specification.schema.ts` (field-identical, no id keys), `product-specification.ts` gains `insertSpecification`/`updateSpecification`/`deleteSpecification` (no status backstop — table has no `lifecycle_status` column), `addSpecification`/`updateSpecification`/`deleteSpecification` services — uniform branch-first-when-`ACTIVE` routing, content-matching `findClonedCounterpart` helper to locate the branched clone's counterpart row, `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED` audit events. No Server Action, UI, or page — those are pm21. |
| pm15 | `specs/pm15-spec.md` | Backend price management: `insert-price.schema.ts` (`name`/`priceType`/`currency`/`glCode`/`startDateTime`/`priceCharacteristics`, no id key, nests `priceCharacteristicsSchema` wholesale), `product-offering-price.ts` gains `insertPrice` — the repository's only write, permanently (Inv. #1 relaxes for `insert*` only, never update/delete), `insertPrice` service — two-row branch-first-when-`ACTIVE` routing (pure new content, no counterpart-locate step), 3-day backdating tolerance checked twice (fast-fail in the schema, authoritative against injectable `now` in the service), `PRODUCT_PRICE_ADDED` audit event. No Server Action, UI, or page — those are pm22. |
| pm16 | `specs/pm16-spec.md` | Backend lifecycle: `activate-offering.schema.ts`/`retire-offering.schema.ts` (both single-field `reason`), `product-offering.ts` gains `findActiveInFamily` (`.for("update")` row-locks the whole family by immutable identity, first use of locking in this codebase), `activateOffering` (transactional Inv. 13 re-check + retire-sibling + flip-to-ACTIVE), `retireOffering` (unconditional flip to `RETIRED`, one method backs both retire and discard). Services: `activateOffering` (price/mandatory-spec preconditions read ahead of the transaction), `retireOffering` (`PRODUCT_OFFERING_RETIRED` vs `_DISCARDED` chosen from pre-transaction status). Four audit events (`_ACTIVATED`/`_SUPERSEDED`/`_RETIRED`/`_DISCARDED`). No Server Action, UI, or page — those are pm23. |
| pm17 | `specs/pm17-spec.md` | Nav: `components/admin-nav.tsx`'s "Products" section relabeled ("Product Offering" → "View Product," same href/icon) + new sibling "Manage Products" item (`/products/manage-products`, `PackagePlus` icon, no `requiredPermission` — deliberately not `cm03`'s locked pattern). Data-only diff, zero render-loop/type changes. §2.6 page-heading rename folded in: `app/(app)/products/product-offering/page.tsx` `metadata.title`/`H1` → "View Product." No backend, Server Action, or new page — `/products/manage-products` 404s until `pm18`. |
