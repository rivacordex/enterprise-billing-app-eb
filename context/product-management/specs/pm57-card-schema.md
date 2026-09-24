# pm57 — Card schema (two tables)

**Unit:** pm57 (Part 5, first unit). **Boundary:** `db/migrations/0041_ratecard_ran_usage_lkp.sql` (new), `db/schema/product.ts` (hand-synced), `types/product.ts` (one new union), `types/rbac.ts` (one `PERMISSION_NAMES` member — platform-owned, G-RC3), and the guardrail files that prove it. **No repository, service, action, component, validation, parser, seed or page.** This delivery stands up the table; no consumer is built. The nav entry and the authz rows are pm67.
**Specs from:** `prodmgmt-update-overview.md` (goal 1, goal 5; In Scope — Phase A rows 1–2) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC4, RC8, RC12, RC14, RC17**, **RV1, RV2** · `prodmgmt-architecture.md` §3.2, §3.3, §3.4, §3.8, §4, Inv. **#45, #53, #57** · `prodmgmt-code-standards.md` §1.46, §2.19, §6.23–§6.32, §7.12, §8, guardrails 13/39, Appendix A rows **A10–A13** · `prodmgmt-ai-workflow-rules.md` §4.1, §6.2–§6.5, §6.9, §6.11, §6.13, §7.1, §8.2, §8.7.
**Depends on:** **G-RC3** for the `PERMISSIONS` row. v2 touches no delivered table — no dependency on a delivered schema. Cross-part edges only — nothing in Part 5 precedes this unit.

**Gate status at authoring time (2026-09-23):**

| Gate | State for this unit |
| --- | --- |
| **G-RC1** — unit numbers | **CLOSED** by the `pm00-build-plan.md` overwrite. This spec is the per-unit spec that closure still owed. |
| **G-RC3** — the permission name (OR3) | **OPEN — blocking the `PERMISSIONS` row and the `types/rbac.ts` edit, and nothing else.** The two tables may be written and verified without it. If G-RC3 stalls, **split** per I6 rather than holding the schema. |
| **G-RC4** | Not this unit's — pm61 (the parser dependency). |

**Withdrawn under v2:** **G-RC2** (no `product_offering_price` change, so no merge-window question) and **G-RC5** (no `rp.py` amend).

---

## Goal

Land both card tables, the two partial unique indexes and the as-of index in one forward-only migration — so a database built from empty carries the whole schema, and the rules that matter are refused by Postgres rather than by application code. This delivery stands up the table; no consumer is built.

---

## Design

### D1. `0041` is the number, and it is re-checked, not assumed

Code-standards §6.25 records `0040_product_family_guards.sql` as the working tree's last migration. **Re-run a listing of `db/migrations/` before naming the file.** Part 4 is in flight on a separate branch and G-RC2 may place this update after it merges; if anything has taken `0041`, this unit takes the next free number and corrects §6.25, the code-standards §7 tree and the `pm00-build-plan.md` pm57 row in the same change set. The filename is cosmetic; the number colliding is not.

`0006_product.sql` is **not** reopened (RC12). Everything here lands in the new file.

### D2. `product.ratecard_version` — the columns, and the two that have no writer

Architecture §3.2's table is authoritative and is reproduced in the migration, not reinterpreted. Two notes the DDL must carry as comments, because they are what a later reader will misread:

- **`snapshot_date date NOT NULL`** is the file's hoisted `Date` column (RC3). It is the snapshot/extract date, it is constant across the file, it is never stored per row, and it **never participates in matching**. It is also the sole source of `retired_at` (RC17, Inv. #49).
- **`status = 'REJECTED'` and `reject_summary` have no writer in Phase A** (§1.42). A failed upload writes nothing, including no version row. Both exist for a future asynchronous ingest. Say so in the doc-block (workflow §7.11) so the next reader does not spend an afternoon hunting the code path that fills them — and **do not invent one to make the column look used** (§3.5).

`ratecard_version_id` is `RCV` + an 8-digit zero-padded per-table sequence, the module's prefix convention (§6.2, §6.24). `uploaded_by` / `activated_by` FK `core.APPUSER`, the cross-schema provenance pattern already used across `product` — they are provenance columns, **not an ownership model** (architecture §4).

### D3. `product.RATECARD_RAN_USAGE_LKP` — a different ID convention, on purpose

`ratecard_ran_usage_lkp_id uuid DEFAULT core.generate_ulid()`, not a padded sequence (§6.24). A table taking 5,500 rows per upload has no use for a human-readable id, the id is never displayed, and a shared sequence would be the upload's bottleneck. The two conventions sitting side by side in one migration is deliberate and is worth one comment line.

**One FK, and only one:** `ratecard_version_id` → `ratecard_version` `ON DELETE CASCADE`. **`lkp_subscriber_ref_id text NOT NULL` gets no FK** (RC14, Inv. #57). It carries a `product_inventory.product_inventory_id` value but is stored as uploaded and **validated structurally only** — no referential check against any delivered table, at upload or after. A superseded version must survive a subscription's removal, which a FK would prevent or make actively dangerous. Same no-FK stance as `rating.udr_rated` (Inv. #17), and the reasoning goes in the doc-block rather than being left for someone to rediscover as an omission.

**`service_code text NULL` is a plain column with no meaning** — not a key, not a partition, it selects no price and no cross-row rule reads it. It is stored as uploaded and nothing consumes it.

**No capacity column** (RC4). Not "stored but unused" — there is no column. The source column being named *"SVLCODE mapping for Buffer Usage"* is not an argument (workflow §3.3).

**No currency column** (Inv. #53). A card that carries a price is a different design and needs its own review.

### D4. `rate_per_unit` — a plain nullable column

`rate_per_unit numeric(18,6) NULL` (§6.32). A plain nullable column — **no CHECK**, no reserved rule. It is stored as uploaded when present, NULL when the cell is empty, and nothing consumes it.

The shape matches `udr_usage_rate` — `numeric(18,6)`, decimal string through Zod, **never `float`** and never through `services/accounts/money.ts` (integer-sen, throws above 2 dp). Fixing the shape costs nothing and stops it being re-litigated later.

### D5. The two partial unique indexes — and C8, which this unit must decide

`UNIQUE (card_name, version_num)`, plus a **partial unique index on `card_name WHERE status = 'ACTIVE'`** (RV1, Inv. #45). At most one live version per card, enforced by the index and **not by application code** — the direct analogue of `product_offering`'s one-ACTIVE-per-family partial index (§6.7). The service-layer status check still exists (pm65): the index changes the **failure mode**, it does not replace the check.

**C8 — the second partial index, `WHERE status = 'DRAFT'`.** The plan calls it *"recommended; mirrors the product pattern"* — a recommendation, never decided. Code-standards §6.30 states it affirmatively. One doc hedges and the other does not, and this unit writes the DDL, so it decides:

| Option | Behaviour | Consequence |
| --- | --- | --- |
| **A (recommended)** — ship it | At most one open `DRAFT` per `card_name`; a second upload while a draft is open is refused by the index. | Mirrors `product_offering`'s one-open-version index exactly (§6.7). It makes "the draft" a definite article throughout pm64, pm67 and pm68 — the diff, the version list's selection default and the activate dialog all get to assume one. The cost: there is no discard in Phase A (C2) and no `ratecard : DELETE` (§8), so **an abandoned draft blocks the next upload until it is activated**. |
| B — omit it | Many concurrent drafts per card. | Cheaper today and it dodges the abandoned-draft trap — but it makes the diff ambiguous about *which* draft, and it is a schema change to add later once rows exist. |

**Take A, and record the abandoned-draft consequence in the hand-off register in the same change set.** It is the genuine cost of A and it is not hypothetical. If the user judges it unacceptable, the answer is to revisit C2 — **not** to drop the index quietly here.

### D6. `db/schema/product.ts` is synced by hand — and `0041` is an *added* file, which changes the meta rule

No `drizzle-kit generate` (§6.25). This is an **added** migration, so the journal and a new snapshot entry are the migrator's business in the ordinary way. Mirror the two tables in `db/schema/product.ts` (§7.12: **no `db/schema/rate-card*.ts` file is created** — Appendix A row A12).

### D7. One new domain union here; the other belongs to pm60

`types/product.ts` gains **`RateCardVersionStatus`: `'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED'`**, `as const`, declared in lifecycle order (§2.19). It is **not** `LifecycleStatus` and never widens it: the two sets share three spellings and no semantics, and `LifecycleStatus` is a total-`Record` key across the module (§2.2) — reusing it would silently give a card version an `OBSOLETE` branch and an offering a `SUPERSEDED` one.

**`RateCardIssueSeverity` is pm60's**, not this unit's — it is keyed to §1.41's fixed list, which is a validation concern with no column behind it. Splitting §2.19's two unions across two units is deliberate; annotate §2.19 so the split is not read as an omission.

`reject_summary` is left untyped here and takes its `.$type<>()` at **pm60**, when `rejectSummarySchema` exists (§2.27) — a forward edge worth stating.

### D8. The `PERMISSIONS` row, `types/rbac.ts`, and the window this opens

Gated on **G-RC3**. When it clears as `ratecard`:

- The `PERMISSIONS` seed row ships **in this same migration**, beside the page's DDL (§6.26). Splitting it into a second migration creates a window in which a permission exists without its page or the reverse — exactly the failure general §1.11 forbids. **Verify — do not assume — that the role editor renders from `core.PERMISSIONS` and therefore needs no code change.**
- `types/rbac.ts` gains one `PERMISSION_NAMES` member. It is **platform-owned**, not covered by code-standards §7's tree, and **must be called out in review** rather than folded silently into the diff (§1.46, workflow §6.9).
- **Count the file, do not quote the doc** (§8). `main` lists **14** members; `ratecard` makes **15**. Architecture §1's *"15, and this makes it 16"* is wrong and is corrected by this unit (**C5**, workflow Appendix A row **W7**).
- **`ratecard` is READ and EDIT only.** The module defines no `ratecard : DELETE` (§8, workflow §3.11). Do not seed a DELETE level "for symmetry".

**The window this opens, named rather than left implicit.** `ratecard` exists as a grantable permission from pm57 until pm67 builds the page. A permission that gates nothing grants nothing, so the window is benign — it is the **inverse** (a page with no permission) that is a hole. The four authz-matrix rows land with the route at **pm67**, not here; adding them now would assert against a 404. Adding `ratecard` to a closed union must change **no existing principal's effective permissions** (Inv. #12) — assert that, do not assume it.

### D9. Grants: verify, and do not edit a bootstrap file

`app_runtime`'s `product.*` grant is schema-wide (`bootstrap-db-roles.sql`'s `ALL TABLES` grant plus its `ALTER DEFAULT PRIVILEGES` for the schema), so both new tables are readable by the app role as created — the same grant-transparency the pm46 reshape relied on. `rating_runtime` and `billrun_runtime` are not: `rating-db-roles.sql` (rm03) and `billrun-db-roles.sql` (bm14) each grant them `SELECT` on an **enumerated** per-table list only (`product.product_offering`, `product.product_offering_price`), never `ALL TABLES`, and set no default privileges for the `product` schema — so as created, neither engine role can read `ratecard_version` or `RATECARD_RAN_USAGE_LKP`. **`db/bootstrap/rating-db-roles.sql` and `db/bootstrap/billrun-db-roles.sql` are not edited** by this unit (workflow §6.13): no consumer exists yet, so there is nothing to grant a read for. A future consumer adds its own explicit per-table grant to the relevant bootstrap file as its own reviewed change.

That said, the module has paid for a wrong assumption here once already — pm09's deployed 500 (`42501: permission denied for schema product`) — so this is **verified empirically**, not just reasoned from the SQL, on a database built from empty (I6.11): `app_runtime` reaches both new tables automatically; `rating_runtime` and `billrun_runtime` do not. That gap is a **finding to raise**, not a bootstrap edit to make on initiative.

### D10. No backfill — asserted, not merely omitted

There is nothing to migrate: both tables are new. **No `db/migrations/*backfill*`, no data-fix script, no relabelling pass** (§1.30, §7.7). The *absence* is a success criterion — assert it by grep, do not just refrain from writing one (workflow §8.2).

---

## Implementation

### I1. `db/migrations/0041_ratecard_ran_usage_lkp.sql`

In one file, in this order: the `RCV` sequence; `product.ratecard_version` with its columns, `UNIQUE (card_name, version_num)` and the two partial unique indexes (D5); `product.RATECARD_RAN_USAGE_LKP` with its columns (including `lkp_subscriber_ref_id text NOT NULL`, `service_code text NULL` and `rate_per_unit numeric(18,6) NULL`, all plain), the cascade FK, the RV2 uniqueness constraint and the as-of index `(ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date DESC)`; then the `PERMISSIONS` row (D8, G-RC3).

The as-of index is **created now though nothing consumes it** (§6.31). That is deliberate: it is nearly free, it keeps a later consumer's plan stable, and creating it later on a populated table is a different operation.

Doc-block comments carry D2's two no-writer columns and D3's no-FK reasoning and D5's C8 decision. Comments here are a **deliverable**, not commentary (workflow §7.11).

### I2. `db/schema/product.ts`, `types/product.ts`, `types/rbac.ts`

Hand-mirror per D6. `RateCardVersionStatus` per D7. `types/rbac.ts` per D8, gated on G-RC3 and called out in review.

### I3. Guardrails — landed with the unit, not deferred to pm71

- **13 re-baselined a third time** (§9): both tables, both partial unique indexes, the as-of index, and the RV2 uniqueness constraint. An exact diff, not a removal.
- **39 lands here** (§9): a direct SQL insert or update producing a second `ACTIVE` version for one `card_name` is rejected **by the partial unique index**, not by application code (Inv. #45).

Guardrails land in the same commit as the behaviour (workflow §2.2). Deferring them to pm71 repeats the pm24 finding.

### I4. Documentation landed by this unit

1. **Architecture §1** — the permission count corrected to 14 → 15 (**C5**, W7).
2. **Code-standards §6.25** — the migration number if D1's re-check moved it; §6.30's C8 decision with its date and its abandoned-draft consequence; §2.19 annotated with D7's split.
3. **Code-standards §7 tree** — `0041_ratecard_ran_usage_lkp.sql` marked landed under **pm57**, and the *"unit numbers unassigned"* banner above the Phase A block deleted (G-RC1 closed it).
4. **Appendix A rows A11, A12, A13** — clearing condition is *"`0041` live in `main`"*; annotate each with this unit's number and clear them **by grep** at pm71, never from memory. **A10 does not clear here** — it clears when the name actually resolves, which is not built in this delivery.
5. **`pm00-build-plan.md`** — G-RC2's recorded decision with its date, and C5 and C8 marked settled.

### I5. Tests

Against a database built from **empty**, not from a migrated dev stack:

1. Both tables exist with exactly the architecture §3.2 / §3.3 column sets — no extra column, no missing one.
2. A second `ACTIVE` version for one `card_name` is rejected by the partial index; a second `DRAFT` likewise (D5).
3. A duplicate `(version, mno, cu, polygon, polygon_start_date)` is rejected (RV2).
4. Deleting a version cascades its rows; deleting a `product_inventory` row **does not** affect a card row (D3's no-FK, proved rather than assumed).
5. `0006_product.sql` is byte-identical.
6. No backfill script exists anywhere in the result (D10), by grep.
7. Adding `ratecard` changes no existing principal's effective permissions (D8, Inv. #12).
8. The two new tables are reachable by the app role and by `rating_runtime` with no bootstrap edit (D9).

### I6. If G-RC3 stalls

Split; do not stall the schema (workflow §4.5's treatment of `next.config.ts`, applied here). Land the two tables as `0041`; hold the `PERMISSIONS` row and the `types/rbac.ts` member for a `0042` that lands the instant G-RC3 clears and **before pm67**. Record the split in `pm00-build-plan.md` (workflow §2.3) — a split recorded implicitly in commit history is not recorded.

---

## Dependencies

**Packages to install: none.** Hand-written SQL plus the existing Drizzle mirror. The one dependency this update adds is pm61's CSV parser, and it is its own unit under G-RC4 (general §5.6).

**Commands used:** `npm run db:migrate` (against an **empty** database), `npm run db:seed`, `npx tsc --noEmit`, `npm run lint`, `npm run test`.

**Prerequisites:** **G-RC2** recorded with its date. **G-RC3** for the permission row only.

---

## Verification checklist

Gates and authorization

- [ ] G-RC2's merge-point decision is recorded with its date in `pm00-build-plan.md` **and** in `_updatemodule-ratecard-lookup-plan-v2.md` (OR11).
- [ ] G-RC3 is cleared, or I6's split is taken and recorded.
- [ ] The migration number was re-checked against `db/migrations/`, not assumed (D1).

Schema (proved against a database built from empty)

- [ ] `npm run db:migrate` produces both tables, both partial unique indexes, the as-of index, and the RV2 uniqueness constraint.
- [ ] A second `ACTIVE` version for one `card_name` is refused **by the index**; the failure names the index, not an application error.
- [ ] A second open `DRAFT` is refused (C8 option A), and the abandoned-draft consequence is in the hand-off register.
- [ ] A duplicate row key is refused (RV2).
- [ ] `RATECARD_RAN_USAGE_LKP` has exactly one FK; `lkp_subscriber_ref_id` has none, and removing a `product_inventory` row leaves card rows intact.
- [ ] `service_code` and `rate_per_unit` are plain columns — no CHECK, no key, no partition, no cross-row rule.
- [ ] There is **no capacity column and no currency column** on either table.

Boundaries and absences

- [ ] `0006_product.sql` is byte-identical.
- [ ] **No backfill or data-fix script exists** — asserted by grep, not merely unwritten.
- [ ] No `db/schema/rate-card*.ts` file is created; both tables live in `db/schema/product.ts` (A12).
- [ ] No `drizzle-kit generate` was run; the mirror is hand-written.
- [ ] No bootstrap role file is edited, and the grants were **verified empirically** on the fresh database (D9).
- [ ] `git diff --stat` touches no repository, service, action, component, validation, parser, seed or page.

Types and permission

- [ ] `RateCardVersionStatus` lands in `types/product.ts`, shares no `Record` with `LifecycleStatus`, and is declared in lifecycle order.
- [ ] `types/rbac.ts` goes from **14** members to **15**, and the review calls the file out explicitly.
- [ ] `ratecard` carries **no DELETE level**.
- [ ] Adding it changes no existing principal's effective permissions.

Guardrails and docs

- [ ] Guardrail **13** re-baselined a third time and passing; **39** landed and passing.
- [ ] Architecture §1's permission count corrected (C5 / W7).
- [ ] Code-standards §7's *"unit numbers unassigned"* banner is deleted; the tree marks `0041` under pm57.
- [ ] Appendix A rows A11–A13 annotated with this unit; **A10 left open** (it clears when a consumer is built, not in this delivery).

**Definition of done:** a database built from nothing carries both card tables and one live version per card enforced by an index rather than by code — with no backfill anywhere in the result, `0006_product.sql` untouched, and nothing consuming the table.
