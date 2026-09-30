# pm67 — Demo seed

**Unit:** pm67 (Part 5). **Boundary:** `db/seeds/demo/product-demo.ts` — the Phase 1 seed of the one tracked card. **No schema, no repository, no service, no action, no component, no page.** `db/seeds/product.ts` (the ADMIN grant seed) and `db/seeds/sample/seed-billrun-sample.ts` are **confirmed untouched and said to be so**.
**Specs from:** `prodmgmt-update-overview.md` (_Seeds_; In Scope, last row) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC7, RC11, D-A7, D-A8**, **OR7′ (confirmed 2026-09-25)**, _Phase 1 seed_ · `prodmgmt-architecture.md` §3.6, Inv. **#4, #57** · `prodmgmt-code-standards.md` §1.39, §6.12, §6.34, §7.12 · `prodmgmt-ai-workflow-rules.md` §4.7, §8.2.
**Depends on:** **pm63** (activation is how a version becomes `ACTIVE`).

**Seeds stay attributable** (workflow §4.7). The demo card version is its own unit **after the services exist**, so a seed failure traces to the seed and not to the schema that landed with it — the same rule that put pm48 after pm46/pm47 rather than inside them.

This is the **Phase 1 seed of the one tracked card** (plan §8, D-A5): a single `card_name = RAN_USAGE`, no new-card creation surface, seeded through the real upload + activate services so the config row tracks exactly this one table.

---

## Goal

Seed one `ACTIVE` card version of the single tracked card (`card_name = RAN_USAGE`), **activated through the real path**, so a fresh demo database has a populated, versioned lookup table on day one and every card guard is exercised by the seed itself. Nothing consumes the table — this seed stands up data, not a consumer.

---

## Design

### D1. Seeds are bound as tightly as user input

**Every write is parsed through the same Zod as a user upload** (Inv. #4, §6.12). A seed that bypasses validation is a seed that can encode a shape the application cannot produce, and the first time that matters is when someone debugs against it.

So a deliberately malformed seed must **fail at Zod before the insert**. That failure is a test in this unit (I3.6), not an assumption. (There is no reserved-column CHECK to trip — `rate_per_unit` is a plain nullable column, D-A2 — so a Zod-fail arm is the guard the seed proves.)

### D2. Activated through the real path, not by writing `status = 'ACTIVE'`

The seed calls **pm61's upload service and pm63's activate service** directly, not `insertVersion` with a hand-set status. It calls the **services**, not the actions, so there is no `requirePermission` in the path (a seed runs with full DB access, not a user session). But `uploaded_by` / `activated_by` FK → `core.appuser`, so the seed must pass a **real, already-seeded appuser id** — the system/ADMIN seed user that `db/seeds/` creates before the demo product seed runs — as the `uploadedBy` / `activatedBy` argument, so the version provenance and the audit trail name a real principal rather than `NULL`. Name that user explicitly in the seed; do not invent an id.

Two things fall out of that, both of them the point:

- **The activate path runs** (first with no outgoing version, then superseding one at the second activation — D6), so the seed exercises the status flips and their guards rather than side-stepping them.
- **The audit events are written**, so a fresh demo database has a plausible audit trail rather than an activated version nobody activated.

`lkp_subscriber_ref_id` values are `product_inventory_id`s, but there is **no referential assertion** — RV8 is gone (D-A1); the values are validated structurally only, exactly as an upload validates them.

A seed that writes `status = 'ACTIVE'` directly would pass every test in this unit and prove nothing about the system it is seeding.

### D3. The single tracked card, self-contained

The seed stands up **one** card and nothing else:

- `card_name = RAN_USAGE` — the single seeded value (D-A5). The seed creates **no** second card and there is no surface to create one.
- `service_code` is a **plain column** (plan §5): the rows carry values, but those values have no meaning here and are asserted only structurally.
- `lkp_subscriber_ref_id` values are `product_inventory.product_inventory_id`s in shape (`PRDINV` + 8 digits), but there is **no referential assertion** — the seed does not require them to resolve against `inventory.product_inventory` (RV8 gone, D-A1).

The card is not aligned to any offering, any price row, or any `service_code` on a price row — this delivery makes **no** `product_offering_price` change, and there is nothing downstream for the seed to line up with.

### D4. Small, and honest about being small

**Not 5,400 rows.** A demo seed is read by humans. A handful of rows — enough to cover the interesting shapes — is the right size:

| Row                                                                                         | Demonstrates                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A plain mapping                                                                             | the ordinary case                                                        |
| A row with `polygon_end_date`, `state` and `district` populated, and one leaving them empty | the descriptive validity/geo columns (D-A9/D-A10) and empty-cell hygiene |
| A row carrying a `service_code`, and one leaving it empty                                   | `service_code` is a plain, optional column — not a key                   |
| A row with a value in `rate_per_unit` and a row with it empty                               | the plain nullable column (D-A2) and empty-cell-≠-zero hygiene           |

The 5,400-row path is proved in pm60's and pm61's live-DB tests, which is where volume belongs. **Do not seed a large card to "test batching"** — a slow demo seed is a tax on every developer, every day, and it duplicates coverage that already exists.

### D5. No capacity, no currency

**No capacity column exists** (RC4) so there is nothing to seed. **`rate_per_unit` is a plain nullable column** (D-A2): the seed may populate it or leave it empty per row (D4), and an empty cell stays empty, never `0` (§7 hygiene). There is no CHECK to trip and no reserved-column ritual.

**No currency column exists** on either table. Nothing in this delivery consumes a rate or a currency.

### D6. A second version, and what it demonstrates

Seed **two** versions: an earlier one and the current `ACTIVE`, with the earlier one `SUPERSEDED` **by having been activated and then superseded through the real path** (D2).

That costs one extra activation and buys four things the single-version seed cannot show:

1. The version list renders more than one row, so `SUPERSEDED` muting, the lineage pointer and the "newest first" ordering are all visible in the demo.
2. **A removed key is visible** — a key in the earlier version that is absent from the later file shows in the diff as _removed_, is **not** in the new version, and stays readable in the superseded one (plan D-A7). Nothing is copied forward at activation.
3. Rollback has a target, so the demo can exercise pm64 without a user first uploading twice.
4. The diff has two real versions to compare.

Make **exactly one** key removed between the two versions, so the diff's removed count is `1` and the number is checkable by eye. The newer version's stored row count equals its file's `row_count` — the removed key adds nothing to it.

**Both versions carry the same `snapshot_date`, and that is correct.** The file has no date column (plan D-A8); pm61 sets `snapshot_date` to the calendar date of the upload in the app timezone, and both seed uploads happen in the same run, so both versions show the seed-run date. The seed passes the **real clock** to pm61 — it does **not** use the fixed-instant parameter pm61's tests use (pm61 D4) to backdate the first version. Backdating would make the demo show a history that never happened and would put a clock override into non-test code. The two versions are told apart by `version_num`, status and `uploaded_at`, which is what the version list already shows.

### D7. It is a demo seed, not a sample seed

`db/seeds/demo/product-demo.ts` only. **`db/seeds/sample/seed-billrun-sample.ts` is not touched** — the bill run does not read the card (architecture §3.8), and the sample seed's `_SAMPLE_` offering is Part 4's territory. **Confirm it untouched and say so** in the change description, the same discipline pm48 applied to `db/seeds/product.ts`.

**`db/seeds/product.ts` (the ADMIN grant seed) is likewise untouched** — the `ratecard` `PERMISSIONS` row ships in `0041`, not in a seed (§6.26).

---

## Implementation

### I1. `db/seeds/demo/product-demo.ts`

The two versions of D6, seeded through the real upload + activate path (D2), with the rows of D4, for the single card `card_name = RAN_USAGE` (D3). The config row (`ratecard_version`) tracks **only** this one card.

### I2. Column mapping, recorded

**OR7′ is resolved (2026-09-25).** The seed CSVs carry exactly the ten file headers of pm58 D0 — `MNO Name`, `Commercial Unit ID`, `Polygon ID`, `Polygon Start Date`, `Polygon End Date`, `State`, `District`, `Subscriber Reference ID`, `Service Code`, `Rate per Unit` — and **no `Date` column**. Build each header line from **pm58's header map, imported**; do not type the strings again (pm58 I1). `Polygon Start Date` cells are strict `YYYY-MM-DD`. The `lkp_subscriber_ref_id` values are `product_inventory_id`s in shape, but the seed asserts **no** referential resolution (D-A1). Keep the seed self-contained — it is not keyed to any offering or price row.

### I3. Tests

1. `npm run db:migrate && npm run db:seed-demo` on an **empty** database loads an `ACTIVE` card version plus one `SUPERSEDED` one, for `card_name = RAN_USAGE`.
2. **`lkp_subscriber_ref_id` is non-empty on every row** and matches the `PRDINV`+8-digit shape — a structural check only; **no** referential resolution is asserted (D-A1).
3. `rate_per_unit` follows D4 — at least one row populated and at least one empty; an empty cell is NULL, never `0`.
4. Exactly one key removed between the versions: the diff reports removed = 1; the key is absent from the `ACTIVE` version and still present in the `SUPERSEDED` one; each version's stored row count equals its `row_count` (RV3, D-A7).
5. The config row tracks exactly one `card_name` (`RAN_USAGE`); `service_code` is populated on the rows as plain data (two rows differ only by it, D4).
6. **A deliberately malformed seed fails at Zod** before the insert (D1).
7. The version was activated **through pm63's service**, not by a direct status write — assert the audit events exist (`RATECARD_VERSION_UPLOADED` ×2, `RATECARD_VERSION_ACTIVATED` ×2).
8. The seed completes in a time a developer will tolerate; the row count is small (D4).
9. `db/seeds/product.ts` and `db/seeds/sample/seed-billrun-sample.ts` are **byte-identical** (D7).
10. `npm run db:seed` (the full seed set) is green.
11. Every seed CSV's header is exactly the ten pm58 headers, built from the header map, with no `Date` column; both versions' `snapshot_date` equal the seed-run date in the app timezone (D6).

### I4. Documentation

1. **Code-standards §7 tree** — `db/seeds/demo/product-demo.ts`'s `(rate card)` marker resolved to **pm67**.
2. **`_updatemodule-ratecard-lookup-plan-v2.md`** _Phase 1 seed_ — marked delivered.

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run db:seed`, `npm run test`, `npx tsc --noEmit`, `npm run lint`.

**Prerequisites:** pm63 merged (the upload + activate services).

---

## Verification checklist

Fresh install

- [ ] `npm run db:migrate && npm run db:seed-demo` on an **empty** database produces one `ACTIVE` and one `SUPERSEDED` card version.
- [ ] `npm run db:seed` (the full set) is green.
- [ ] The seed is fast and small — not 5,400 rows.

Correctness

- [ ] The single tracked card `card_name = RAN_USAGE`; the config row tracks only it; no second card is created.
- [ ] **`lkp_subscriber_ref_id` is non-empty and `PRDINV`+8-digit shaped on every row** — structural only, **no** referential assertion (D-A1).
- [ ] `rate_per_unit` follows D4 — a populated row and an empty row; an empty cell is NULL, never `0`.
- [ ] `service_code` is populated as plain data; two rows differ only by it.
- [ ] Exactly one key removed; the diff shows removed = 1; the `SUPERSEDED` version still holds it; the `ACTIVE` version's stored rows equal its `row_count`.
- [ ] The seed CSVs use the ten pm58 headers from the header map and no `Date` column; `snapshot_date` comes from the upload path (both versions: the seed-run date), never backdated.

Through the real path

- [ ] The versions were created and activated **through pm61's and pm63's services**, not by direct status writes.
- [ ] Four audit events exist — two uploads, two activations.

Guards

- [ ] A deliberately malformed seed fails at **Zod** before the insert (D1).

Boundaries

- [ ] `db/seeds/product.ts` and `db/seeds/sample/seed-billrun-sample.ts` are **byte-identical** — confirmed and stated.
- [ ] No schema, repository, service, action, component or page in the diff.
- [ ] No capacity data, no currency anywhere in the seed; no `product_offering_price` touched.
- [ ] `tsc --noEmit`, ESLint, Prettier and the suite green.

**Definition of done:** a developer runs two commands against an empty database and gets a working rate card — two versions of the one tracked card `RAN_USAGE`, one polygon removed between them and still readable in the superseded version — created the same way a Revenue Operations user would have created it, with nothing anywhere reading the table.
