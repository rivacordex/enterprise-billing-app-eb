# Bill Run — Build Plan (Units, in build order)

Decomposition of the Billing Management (Bill Run) module into build units. Sources of truth: `billmgmt-project-overview.md` (delivered phases 1–4), `billmgmt-update-overview.md` (in-flight Part 1 Target Capacity + Part 2 Invoice Template), `billmgmt-architecture.md` (Module Invariants §6, #1–#50 — #15 is a retired tombstone; dated delta sections; open conflicts X1–X4), `billmgmt-code-standards.md` (file tree §7, permission map §8, guardrail tests §9 items 1–56, conflicts C1–C4), `billmgmt-ai-workflow-rules.md` (unit discipline, mandatory splits, load-bearing order), `billmgmt-ui-context.md` (tokens, §10 Invoice Settings). Stack per `context/architecture.md` §1 and `billmgmt-architecture.md` §1 + the dated stack deltas. **Per-unit detail lives in `specs/bm*.md`; full current state in `billmgmt-progress-tracker.md`.**

_Revised 2026-10-07: Part 1 status re-verified against `enterprise-billing-app` `dev1`; **Part 4 — Invoice Template (Units 47–63)** added._

**Decomposition rules:** each unit produces **one visible result**, stays within **one domain boundary**, lands dependencies **just-in-time**; units always done together — or with no standalone visible result — are **merged**. Every unit finishes green (`tsc` / lint / tests incl. the route × level matrix), carries its own guardrail tests, and syncs its owning doc before the next starts.

---

> ## Status — Phases 1–4 (bm01–bm39) DELIVERED
>
> Phase 1 (bm01–bm13) control plane; Phase 2 (bm14–bm21) two-writer boundary + rendering + posting + distribution; Phase 3 (bm22–bm35) real compute plane; Phase 4 (bm36–bm39) processor signal-back + the self-driving `SCHEDULED → COMPLETED` lifecycle + production deployable/wired. **Do not rebuild.** Taxation stays the ratified `0.00` interim (`total = subtotal`). The production **cloud cutover** is a later gated ops step — bm38 landed it deployable + wired; **Phase 4 added no new schema or migrations** (flow YAML + bicep + Key Vault secrets + a smoke test). The **Target Capacity Pricing update** (Units 40–46, `bm40`–`bm46`) is **in delivery** — see **Part 3** below. The **Invoice Template update** (Units 47–63, `bm47`–`bm63`) has **specs written (2026-10-07), not built** — see **Part 4** below.
>
> **Verified state, 2026-10-07 (`enterprise-billing-app` `dev1`):**
>
> | Units | State |
> | --- | --- |
> | bm40–bm44 | **Committed** (`792d681` bm41 … `0bde815` bm44 + review fixes) |
> | bm45 | **Committed** (`c77cb7d` + SonarQube fixes `eeb6450`, `266a5d8`) |
> | bm46 | **Committed** (`60be173` + CodeRabbit fixes `501456f`) — Part 3 entry gate for Part 4 met |
> | bm47–bm63 | **Specs written 2026-10-07**; no code. Each spec lists its open G-items; a unit's build waits until they are recorded as decided. bm61's G14 was decided 2026-10-10 (option C), then 2026-10-11 (no four-eyes) |
>
> The progress tracker's "bm40–bm46 planned, not delivered" line is stale; correct it with the next tracker touch (workflow rules §7.3). Latest applied migration: `0044_customer_bill_line_capacity.sql`.

---

# Delivered units (numbering record)

| Unit | Spec   | Name                                                                               |
| ---- | ------ | ---------------------------------------------------------------------------------- |
| 1    | `bm01` | Billing section & RBAC scaffold                                                    |
| 2    | `bm02` | Bill Runs list + lazy materialization                                              |
| 3    | `bm03` | Trigger a run (+ Scoping + outbound engine)                                        |
| 4    | `bm04` | M2M stage ingest + stage-timeline observability                                    |
| 5    | `bm05` | Draft bill generation (Claim + Aggregation)                                        |
| 6    | `bm06` | Taxation                                                                           |
| 7    | `bm07` | Verification, Uncharged & Errors tabs                                              |
| 8    | `bm08` | Rerun (full & partial)                                                             |
| 9    | `bm09` | Accounts-side INV & posting enablement _(cross-module)_                            |
| 10   | `bm10` | Approve (four-eyes gate)                                                           |
| 11   | `bm11` | Post to the ledger                                                                 |
| 12   | `bm12` | Stall detection & recovery                                                         |
| 13   | `bm13` | End-to-end journey & phase-1 ship gate                                             |
| 14   | `bm14` | `billrun_runtime` role & the two-writer grant boundary                             |
| 15   | `bm15` | `_SAMPLE_*` `udr_rated` seed + placeholder-mode rename                             |
| 16   | `bm16` | Engine registry + two executions + processing flow (placeholder) + M2M record-only |
| 17   | `bm17` | `udr_rated` approve/reject/release lifecycle + **Reject** action                   |
| 18   | `bm18` | Rendering foundation + draft PRO-FORMA preview                                     |
| 19   | `bm19` | Posting on real charges + final render + store                                     |
| 20   | `bm20` | Distribution flow + `bill_run_distribution` + Distribution tab                     |
| 21   | `bm21` | Phase-2 ship gate                                                                  |
| 22   | `bm22` | Environmental gate                                                                 |
| 23   | `bm23` | `customer_bill_line` schema, partitions & grants                                   |
| 24   | `bm24` | Claim release on reject / cancel / rerun                                           |
| 25   | `bm25` | Rating in-flight guard + `LOAD_BLOCKED_INFLIGHT` _(cross-module)_                  |
| 26   | `bm26` | Sample seed → `RAN_USAGE`, unclaimed (`ci` profile)                                |
| 27   | `bm27` | Real Collection: correlation & claim                                               |
| 28   | `bm28` | Real Aggregation (`USAGE`) + `BillLineTable`                                       |
| 29   | `bm29` | Real Aggregation (`RECURRING`) + price resolver                                    |
| 30   | `bm30` | Verification + bill↔charge reconciliation                                          |
| 31   | `bm31` | `charge_checksum` re-anchored on `customer_bill_line`                              |
| 32   | `bm32` | Uncharged redefinition + exception surface                                         |
| 33   | `bm33` | Retire `BILLRUN_PLACEHOLDER_MODE`                                                  |
| 34   | `bm34` | Real distribution: SFTP transport + multi-target                                   |
| 35   | `bm35` | Phase-3 ship gate                                                                  |
| 36   | `bm36` | Processor signal-back (per-stage `DONE` + terminal `FAILED`/`/status`)             |
| 37   | `bm37` | Local end-to-end assertion + reconcile alignment                                   |
| 38   | `bm38` | Production deployable + wired (infra / doc only)                                   |
| 39   | `bm39` | Phase-4 ship gate                                                                  |

---

## Phase 4 — durable notes (detail in `specs/bm36`–`bm39`)

- **bm36 was the unblocker.** The processor's real `io.kestra.plugin.core.http.Request` signal-back — per-stage `DONE` + per-account HARD `FAILED` + a run-level terminal `/status` — replaced the `Log` stubs, so a triggered run drives itself to `PROCESSED` and a failed account settles via the signal, not the stall gate. No app/receiver change, no schema.
- **Sequencing (durable):** 36 → 37 → 38 → 39. 36 before everything (nothing reaches `PROCESSED` on its own without it); 37 (local E2E proof) before 38 (prod wiring) to de-risk; 39 (ship gate) assembles and signs off 36–38 and owns the full-journey run + tracker sync.
- **Merged into their units (so they are not re-litigated):** terminal `FAILED`/`/status` settlement → bm36 (same flow file/session as the `DONE` POSTs); reconcile-gate alignment → bm37 (no standalone visible result; proven by the same smoke); flow promotion + `template.yml` "separate repo" fiction-correction + the cutover runbook → bm38 (one deployable-path result, shared infra boundary).
- **No unit, deliberately:** taxation (`0.00` ratified interim, no build); provisioning-grant hygiene (bm23 added the `customer_bill_line` grant; the rest is the bm38 cutover-runbook ops note); new schema (Phase 4 introduced none).

---

# Part 3 — Target Capacity Pricing update (in delivery, Units 40–46)

Decomposition of the Target Capacity Pricing update into build units, continuing the delivered `bm01`–`bm39` sequence (**bm40–bm44 committed, bm45 uncommitted, bm46 not started** — see the status block above). Sources: `_updatemodule-billing-billrun-target-capacity-plan.md`, `billmgmt-update-overview.md`, `billmgmt-architecture.md` (Target Capacity deltas, Inv #29–#38). **Stack: no new technology** — inline SQL in the existing `bill_run_processing` flow, two new `customer_bill_line` columns, three read grants, and an invoice-render appendix. **Hard precondition for the whole part:** `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscriber_ref_id → udr_subscription_ref_id` rename, the real resolver) is treated as shipped (TC45/TC53).

Decomposition rules applied: one visible result per unit; one system boundary; dependencies just-in-time; always-together units merged; no-standalone-result units merged. Per-unit design detail lives in the capacity plan's decision register (TC1–TC58) and open items (O-TC1–O-TC7).

| Unit | Spec   | Name                                                                      | Boundary                              | Depends on                                                           |
| ---- | ------ | ------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| 40   | `bm40` | Unit 0 — flow rename + extracted-SQL harness + DB-test safety             | flow + tests (no capacity logic)      | rating-config rename shipped; PC14 + resolver repair already shipped |
| 41   | `bm41` | `customer_bill_line` capacity columns + grants                            | migration + Drizzle + grants          | 40                                                                   |
| 42   | `bm42` | Capacity aggregation — floor, motivation, six guards, calc trace (+ seed) | flow (`aggregation`)                  | 41, 40, PER_UNIT rating                                              |
| 43   | `bm43` | Capacity verification — Model-2 cross-check + `CAPACITY_RATE_MATCHING`    | flow (`verification`)                 | 42                                                                   |
| 44   | `bm44` | Checksum re-anchor (`rated_amount`) + bill-line read model                | app (repository + read surface)       | 42, 43                                                               |
| 45   | `bm45` | Invoice usage appendix — per-polygon by state/district                    | invoice render + aggregation snapshot | 42, 41                                                               |
| 46   | `bm46` | Capacity ship gate — live-Kestra E2E + guardrail/audit sign-off           | cross-cutting (tests)                 | 40–45                                                                |
| 42a  | `bm42a` | Flow fixes — aggregation SQL, trace money as text, plain-USAGE tamper check (follow-up to bm42/bm43; known-issues §21) | flow (`aggregation`, `verification`) | 42, 43, 45; bm40 harness fix `2a95617` |

### Unit 40 — Unit 0: flow rename + extracted-SQL harness + DB-test safety (`bm40`) — _live P0, ships first_

- **Boundary:** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` + `tests/db/**` + `vitest.integration.config.ts` (`globalSetup`). **No capacity logic.**
- **Re-scope (verified against `enterprise-billing-app`, 2026-10-04):** the plan's original Unit-0 headline — repair the bm29 resolver off `pop.amount`/`pricing_model`/`price_type` — is **already shipped** (the flow is on the PC14 `price_component` model via pm46/pm52/PC8/PC14; neither the flow nor the test double carries stale SQL). **Do not rebuild it.** bm40 is re-based onto the three gaps still live:
- **Builds:** **(1)** finish the `udr_subscriber_ref_id → udr_subscription_ref_id` rename in the flow (live joins at lines 159/248/570/812 + comments) + its template + README — the live P0, since the deployed flow joins a column the schema no longer has while the hand-copied double masks it; **(2)** replace the hand-copied `tests/db/helpers/billrun-aggregate.ts` + `billrun-verify.ts` doubles with a harness that extracts and runs the flow's real SQL (TC43 — would have caught the drift); **(3)** add the fail-closed destructive-DB preflight and remove the cross-cluster `DROP DATABASE … WITH (FORCE)` (TC58).
- **Visible result:** the deployed flow runs again on the current schema (today it fails every account at Collection on the dropped `udr_subscriber_ref_id`); the aggregation/recurring/volume/verification/checksum suites run the flow's **extracted** SQL; a flow↔schema drift now fails a suite instead of being masked.
- **Depends on:** the rating-config rename shipped; the PC14 schema + the already-shipped resolver repair (delivered).
- **Why first:** a live P0 independent of capacity (TC44) — it must deploy before anything builds on it. See `bm40-rename-sql-harness-db-safety.md`.

### Unit 41 — `customer_bill_line` capacity columns + grants (`bm41`)

- **Boundary:** one hand-authored migration + Drizzle mirror (`db/schema/billing/customer-bill-line.ts`) + `db/bootstrap/billrun-db-roles.sql`.
- **Builds:** add `rated_amount numeric(18,2)` and `additional_info jsonb` to `customer_bill_line` (the partitioned-parent `ALTER` propagates); grant `billrun_runtime` per-table `SELECT` on `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version`.
- **Visible result:** the migration applies and the grant assertions pass (schema + access exist); no behavior yet.
- **Depends on:** 40.
- **Merge rationale:** schema-before-behavior (mirrors bm23) — lands and verifies alone so every later consumer builds on a proven schema.

### Unit 42 — Capacity aggregation (`bm42`) — _the core result_

- **Boundary:** the `aggregation` step of `bill_run_processing.yml`, as `billrun_runtime`; + the pricing `_SAMPLE_` seed fixtures (merged — a seed has no standalone visible result).
- **Builds:** capacity identification by component + pinned-version resolution (Inv #31/#32); the commitment floor + motivation discount as inline SQL CTEs (Model 1), N-band with the `capacity_max_bands` guard; the six HARD guards; `rated_amount` on all USAGE lines; the capacity line at `(offering, unit)` generated even at zero usage; the `additional_info` calc trace + `summary`; round-once/derive (Inv #34). Seed: a `_SAMPLE_` capacity offering (100/EA, commitment 1000, motivation >1000 @ 50) with accounts for 800 / 1000 / 2000 / 0 EA.
- **Visible result:** a triggered run on the capacity seed writes the four anchor bills (800 → 100,000; 1000 → 100,000; 2000 → 150,000; 0 → 100,000) with the calc trace; a mis-configured account HARD-fails only itself while siblings bill.
- **Depends on:** 41 (the columns + grants), 40 (the as-of reader + repaired flow), PER_UNIT rating (TC45).

### Unit 43 — Capacity verification + Model-2 gate (`bm43`)

- **Boundary:** the `verification` step of `bill_run_processing.yml`.
- **Builds:** the bm30 changes (replay each USAGE line against `rated_amount`; capacity replay by `(offering, unit, udrType)`; the identity assertions); the independent **Model-2** cross-derivation (`max(Q, target) × baseRate`); the `CAPACITY_RATE_MATCHING` gate — default ON → HARD-fail with both rates + both version sources named; OFF → WARN, bill Model 1, record the flag state (Inv #29/#30).
- **Visible result:** a capacity bill reconciles on a consistent run; a rate mismatch HARD-fails loudly, or warns and proceeds (recorded) under OFF.
- **Depends on:** 42.
- **Merge rationale:** the Model-2 cross-check and the rate-match gate have no standalone visible result — they are proven by the same verification run, so they fold into this unit rather than a separate pass.

### Unit 44 — Checksum re-anchor + bill-line read model (`bm44`)

- **Boundary:** app — `db/repositories/billing/customer-bill-line.ts` (the posting `charge_checksum`, SQL-only) + the Customers & Bills read model / `BillLineTable`.
- **Builds:** append `rated_amount` as the **last** `charge_checksum` tuple element (Inv #35 — never mid-tuple, never hash `additional_info`); surface `rated_amount`/`additional_info` in the read model; render the `discount_amount` column now that a capacity motivation line carries a non-zero discount (ui-context §6b).
- **Visible result:** a posted capacity line's checksum covers `rated_amount` (altering it changes the hash); Customers & Bills shows the capacity line with its discount.
- **Depends on:** 42 (columns populated), 43 (verified lines).
- **Merge rationale:** the checksum append and the read-model surfacing are both the app-side `rated_amount` surface and land together — the app-boundary counterpart to the flow's bm43 (mirrors the delivered bm30/bm31 split).

### Unit 45 — Invoice usage appendix (`bm45`)

- **Boundary:** the invoice render template (`services/billing/render-invoice-template.ts`) + the appendix snapshot at `aggregation`; + the multi-polygon / multi-state-district `_SAMPLE_` fixture.
- **Builds:** the per-polygon usage appendix on the posted invoice PDF, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard (never `udr_rated`); snapshot-at-aggregation sourcing so the render does no cross-schema join; per-polygon only, bounded ≤ 10,000 rows/account, load-tested to it; a card-missing polygon surfaced not dropped (TC49/TC57, O-TC6).
- **Visible result:** a posted capacity invoice PDF renders the per-polygon appendix grouped by state/district.
- **Depends on:** 42 (the aggregation to snapshot), 41 (the `additional_info` column + the ratecard grants).
- **Sequencing:** after the 42/43 pricing core is green, so a render/appendix wobble cannot hold up money-correctness (O-TC6).

### Unit 46 — Capacity ship gate (`bm46`)

- **Boundary:** cross-cutting — tests + docs/tracker. **No new build** — audit, assemble, sign off (bm13/bm21/bm35/bm39 discipline).
- **Builds:** drive the full `SCHEDULED → COMPLETED` capacity journey through a **real Kestra execution** on the `ci` seed (not only the extracted-SQL harness — Inv #38/TC54); confirm the capacity guardrails (the anchors, the six guards, Model-2/rate-match, dual-detector verification, the checksum append, the appendix render) are present and green; confirm no new migration beyond bm41; sync `billmgmt-progress-tracker.md`.
- **Visible result:** the Target Capacity update declared shippable — a capacity account bills end-to-end on its own.
- **Depends on:** 40–45.

### Sequencing that is load-bearing

- **40 before everything** — the flow fails every account on PC14 until repaired; it is the P0 base and ships as its own PR first.
- **41 before 42** — the capacity line cannot be written without its columns.
- **42 before 43 / 44 / 45** — nothing to verify, checksum, or render an appendix for until the capacity line exists.
- **45 after the 42/43 core** — the appendix must not gate money-correctness (O-TC6).
- **46 last** — the ship gate assembles and signs off 40–45 and owns the live-Kestra capacity run.

### Open items carried into the build (from the capacity plan)

- **O-TC7 (business):** the partial-period pro-ration policy — blocks any future partial-period unit; **not in this part**.
- **O-TC1 / O-TC2 / O-TC6 (build-plan):** rerun snapshot vs re-resolve (bm42/bm43), the capacity line's `quantity` (bm42), and the appendix sourcing / ratecard version (bm45) — resolve inside the owning unit above, not as separate units.

---

# Part 4 — Invoice Template update (specs written, Units 47–63)

> **2026-10-07 — specs `bm47`–`bm63` written.** Decided: **G1 = R9**, **G2** (all USAGE rows, 10,000/account, over-limit parks with `INVOICE_USAGE_OVER_LIMIT`), **G3** (index excludes the default), **G7** (fixed layout text), **G15 = option A**. Kept **open** at the owner's request, with the interim rule from the table below cited in each spec: G4, G5, G6, G8, G9, G10, G11, G12, G13. Still open and blocking: **G14** (bm61 BLOCKED). **New: G16** (prod app blob auth: Key Vault connection string vs a container-scoped Managed Identity; see bm52). The decided items still need recording in the overview, architecture and code-standards trackers (workflow rules §7.2).
>
> **Corrections from reading `dev1` while writing the specs** (the unit text below predates them; the specs win):
> - **Unit 48:** rating does not read `rate_per_unit` from the ratecard (the rate comes from `product_offering_price`). The ratecard cell match lives in **PRP** (`prp.py:430-480`). Geo is captured there, carried through RP's Parquet and appended to RL's `COPY_COLUMNS`. The migration is a forward `0045_rating_udr_rated_geo.sql`.
> - **Unit 50** is migration **`0046`**. `app_runtime`'s grants live in `db/bootstrap/bootstrap-db-roles.sql`, not `billrun-db-roles.sql`. No seed applies the `ratecard` role grants the plan cites as precedent. Multi-file versions are checksummed through a `checksums.json` index. CSV v1 drops the per-line tax and `po_reference` columns.
> - **Unit 52:** the prod app reaches blob with a Key Vault **connection string**, not a Managed Identity, and `invoices` is not declared in bicep. bm52 declares all three app containers and puts the MI role behind a parameter (G16).
> - **Units 58 / 60:** blob paths are content-addressed (`v{n}-{digest12}/`, `sha256-{digest12}/`), so a retry after a failed transaction can't collide with its own orphans.
> - **Unit 60:** `sharp` is **not** a usable dependency (only an optional transitive of `next`). Dimensions come from pure PNG, JPEG and SVG header parsers. No image library is added.
> - **Unit 63:** there is no Playwright e2e suite. The admin e2e drives the installed `playwright` library from vitest. `@playwright/test` would be a stop-and-ask.

This part breaks the Invoice Template update (`billmgmt-update-overview.md` Part 2) into build units, continuing from `bm46`. Sources: `_updatemodule-billing-invoice-template-merged-plan.md` (**§15 R1–R11 overrides §§1–14**), `billmgmt-architecture.md` (Inv #39–#50 + _Invoice Template update — architecture deltas_), `billmgmt-code-standards.md` (_Invoice Template update — code-standards deltas_, guardrails 43–56, C1–C4), `billmgmt-ai-workflow-rules.md` (§2.4 load-bearing order, §3 mandatory splits, §5 open-item stop list), `billmgmt-ui-context.md` §10, `invoice-template/placeholder-catalog.md`.

**Stack additions.** Each one arrives just in time, in the unit that first needs it:

| Addition | First needed by | Unit |
| --- | --- | --- |
| **Handlebars 4.7** (direct dependency, and the only new package Part 2 authorizes) | The binder's render of the new layout | 47 (its own commit inside the unit) |
| Embedded IBM Plex `@font-face` in the layout (O4) | The first layout render | 47 |
| Four `billing` catalog tables, two `customer_bill` columns and the `invoice_settings` permission row | The first version-resolved render | 50 |
| Generalized write-once blob client + `invoice-templates` / `invoice-assets` containers (Azurite) | Seed upload and checksum-verified load | 51 |
| Prod containers + Managed Identity write grant (`infra/**`) | Any prod release that resolves templates from blob | 52 |
| Compiled-template memo (the one sanctioned cache) | Template load | 53 |
| ~~`sharp` (already installed) for logo dimensions~~ Pure PNG/JPEG/SVG dimension parsers; no image library (`sharp` is only an optional transitive of `next`) | Logo upload | 60 |
| No new scheduler, no AI and no billing change to `workflow-management/**`. Unit 48 is owned by rating | — | — |

**How the rules were applied.** Each unit produces one visible result, stays inside one system boundary and brings in its dependencies just in time. Work that is always done together is merged. Work with no standalone visible result is merged into its first consumer.

**The module's mandatory splits (workflow rules §3) override "merge what's always done together."** These units stay separate because of them:

- schema and grants on their own (50)
- the blob-store refactor on its own (51)
- infra on its own (52)
- the posting stamps on their own (54)
- each screen's read path before its mutations
- each mutation as its own unit with its own audit event (57–61)
- logo upload separate from profile activation (60 / 61)
- the rating geo change kept whole and free of billing code (48)
- the usage section after charge reconciliation is green (49 after 47)

## Entry gate — before any Part 4 spec is written

1. **Part 1 is finished.** bm45 is committed and bm46 is green (workflow rules §1.2, X4). Part 4 rewrites the same render files: `render-invoice-template.ts`, `render-invoice.ts`, `post-run.ts` and `customer-bill-line.repository.ts`.
2. **The gating decisions below are recorded** in all three places that track them: the overview's _Open items_, the architecture's _Open cross-update conflicts_ and the code-standards C-table (workflow rules §7.2). Each spec cites the resolution it builds on.

| # | Decision | Tracked as | Gates unit(s) | Interim / recommended |
| --- | --- | --- | --- | --- |
| G1 | Usage-section geo source: the Part 1 ratecard snapshot, or `state`/`district` persisted on `udr_rated` | X1 = C1 | 48, 49 | Recommended: **R9** (bm45 itself calls it the durable fix). If chosen, the Inv #36 amendment lands in 48 |
| G2 | Usage-section scope, row limit and what happens over the limit | X2 | 47 (multi-page fixture), 49 | Multi-page tests use Part 1's limit of 10,000 rows |
| G3 | `is_default` vs one-ACTIVE | X3 = C3 | 50 | C3: the partial unique index excludes the default. Resolution order is pinned → non-default ACTIVE → default |
| G4 | Same file, two rewrites | X4 | 47 | **Resolved by this plan:** Part 4 starts after bm46, and 47 carries the bm45 appendix into the layout |
| G5 | `ONE_TIME` charge sourcing | C2 | 47 | The binder groups by the existing `USAGE`/`RECURRING`/`OCC` union. No `ONE_TIME` member |
| G6 | Checksum algorithm for templates and assets | O2 = C4 | 50, 53 | SHA-256 for new blobs, md5 for invoice PDFs. The algorithm is recorded with each checksum |
| G7 | Notes & terms and the footer sentence: fixed layout text, or profile fields? | O3 | 47 (layout v1), 59 | **Must be decided before 50 seeds layout v1,** because seeded layouts are immutable |
| G8 | Embedded fonts | O4 | 47 | IBM Plex Sans and Mono, embedded (ui-context §10c) |
| G9 | Customer SST no., PO reference and contract reference | O5 | 47 | Hidden while blank. No columns added |
| G10 | Retention of retired versions | O10 | 50 | Nothing deletes a version |
| G11 | Seeded `invoice_settings` role grants | code-standards §8 | 50 | ADMIN/MANAGER EDIT, USER READ (the `ratecard` precedent) |
| G12 | Where the CSV template version column lives | architecture storage deltas vs code-standards | 50 | `customer_bill.ref_csv_template_version_id` (code-standards data rule 4) |
| G13 | Mapping `udr_key` → `(mno_public_key, commercial_unit_public_key, polygon_id)` | overview rating follow-ups | 48 | Rating decides (`ratemgmt` §5.1) |
| G14 | Four-eyes on company-profile activation | architecture _Noted gap_ vs code-standards ("does not apply") | 61 | **Decided 2026-10-11: no four-eyes** — one EDIT signature, bank changes included (supersedes option C of 2026-10-10) |
| G15 | **New:** how invoices render before the first profile is activated. Option A: issuer and payment blocks hidden, `ref_invoice_profile_version` NULL. Option B: a seeded profile v1 | Not tracked yet. Add it to all three places | 47, 53, 54 | Recommended: option A. Today's invoice has no issuer block, so nothing regresses. A seeded profile would print placeholder legal and bank details on real invoices |
| G16 | **New (bm52):** prod app blob auth — keep the Key Vault connection string, or switch to the app's user-assigned Managed Identity with container-scoped `Storage Blob Data Contributor` | Tracked (bm52): overview open items, architecture open items, code-standards C5 | 52 (prod release of 53, 58, 60) | Recommended: Managed Identity. bm52 builds it behind `appBlobAuth`, default `connectionString` |

## Unit table

| Unit | Spec | Name | Boundary | Depends on |
| ---- | ---- | ---- | -------- | ---------- |
| 47 | `bm47` | Invoice binder on `customer_bill_line` + reconciliation (Handlebars layout `INVTPL-STD-A4` v1) | app render path | bm46; G2, G4, G5, G7, G8, G9, G15 |
| 48 | `bm48` | Rating persists `state`/`district` on `udr_rated` _(cross-module; only if G1 = R9)_ | rating module | G1, G13 |
| 49 | `bm49` | Usage annex: billed usage by state → district, with subtotals | app render path (usage read + layout partial) | 47, 48 (if R9); G1, G2 |
| 50 | `bm50` | Invoice template catalog schema, seed rows, permission row and grants | migration + Drizzle + grants | 49; G3, G6, G10, G11, G12 |
| 51 | `bm51` | Generalized write-once blob store + template/asset containers | `services/billing/blob-store.ts` | delivered blob store (bm19/bm34) |
| 52 | `bm52` | Prod `invoice-templates` / `invoice-assets` containers + MI write grant | `infra/**` | 51 |
| 53 | `bm53` | Template and profile resolution, checksum-verified load, seed upload | app render services | 50, 51 (52 before prod); G6, G15 |
| 54 | `bm54` | Posting-time version stamps | posting transaction (`post-run.ts` + `stampPosted`) | 53; G15 |
| 55 | `bm55` | Invoice Settings shell + Invoice template read page, generator and live preview | app admin page + generator service | 53, 54 |
| 56 | `bm56` | Company profile read page | app admin page | 55 |
| 57 | `bm57` | Invoice template: save draft | action + service | 55 |
| 58 | `bm58` | Invoice template: activate | action + service + blob write | 57, 54 (52 before prod) |
| 59 | `bm59` | Company profile: save draft | action + service | 56; G7 |
| 60 | `bm60` | Company profile: logo upload + sanitization | action + service + blob write | 59, 51 (52 before prod) |
| 61 | `bm61` | Company profile: activate | action + service | 59, 60, 54; G14 (decided: no four-eyes) |
| 62 | `bm62` | Invoice CSV output | app service + GET route | 54, 53 |
| 63 | `bm63` | Invoice Template ship gate | cross-cutting (tests + docs) | 47–62 |

### Unit 47 — Invoice binder on `customer_bill_line` + reconciliation (`bm47`) — _binder first (R10, Inv #39)_

- **Boundary:** the app render path:
  - `services/billing/invoice-template/{bind,helpers}.ts`
  - `db/repositories/billing/invoice-render-input.ts`
  - `services/billing/render-invoice-template.ts`, which becomes the binder's entry point
  - `services/billing/render-invoice.ts`, limited to the `page_setup` read and `footerTemplate`. The semaphore, concurrency cap and close-timeout stay as they are
  - `types/billing.ts`
  - the repo files `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**`, which are written here but **not seeded yet**
- **Builds:**
  - **Handlebars 4.7** as a direct dependency, added in its own commit at the start of the unit (workflow rules §3.2). This spec authorizes the lockfile change.
  - The `InvoiceRenderInput` type (`company, payment, invoice, customer, totals, lineGroups, usage, isDraft, locale, timezone`). Its keys match the placeholder-catalog roots.
  - The `invoice-render-input` repository. It reads `customer_bill_line`, `customer_bill_tax_item`, `billing.document`, `customer.organization` and `contact_medium` in one repeatable-read, read-only transaction. Any missing `app_runtime` grant is added per table (Inv #23).
  - `bind()`:
    - groups lines by the existing `ChargeSource` union (G5)
    - takes totals from SQL
    - shows tax as a bill-level summary only (Inv #50)
    - **checks `Σ net_amount = customer_bill.subtotal` before rendering**, and fails with `INVOICE_RECONCILIATION_FAILED` if they differ
  - The nine helpers, which wrap `formatCurrency` / `formatCalendarDate`. Templates compile in locked mode: `knownHelpersOnly`, `strict`, auto-escaping on, no triple-stash.
  - Layout `INVTPL-STD-A4` v1:
    - `manifest.json`, without the `accountSummary` section or the `Tax` column
    - `shell.hbs`, with the §10c print palette and embedded IBM Plex fonts (G8)
    - `footer.hbs`, `partials/*.hbs` and `sample-data.json`
    - a hand-written **default generated** `invoice.hbs` + `footer.hbs`, with every optional section and column on. As a stopgap, these load from the repo until unit 53.
  - The bm45 usage appendix, **carried over** into the `usageAnnex` partial. It still reads the Part 1 `additional_info.appendix` snapshot (the X1 interim rule) and is never dropped.
  - Pagination:
    - A4 `page_setup` from the manifest
    - `displayHeaderFooter` + `footerTemplate`, used only for "Page X of Y"
    - the table header repeats on every page
    - `break-inside: avoid` on each line group
    - the `position:fixed` watermark is unchanged and not clipped
  - The `company` and `payment` roots stay empty until a profile exists (G15), so their fragments are hidden.
  - **Delete** `buildDraftInvoiceHtml` / `buildFinalInvoiceHtml` and their `rating.udr_rated` read. Any failure parks the account through the existing render-pending surface (Inv #40). There is no fallback and no flag.
  - Tests:
    - rewrite the bm18/bm19 suites against the binder
    - guardrails **43, 44, 49, 50, 54**
    - the layout lint (`invoice-layout-lint.test.ts`)
    - a golden-render structural snapshot
- **Visible result:** on the `ci` seed, the draft PRO-FORMA preview and the posted PDF both show:
  - **every** RECURRING and USAGE line, with discounts
  - `Σ net_amount = subtotal`
  - the capacity usage appendix
  - "Page X of Y"

  An unbalanced fixture parks its account in `RenderPendingRow`, and the other accounts still render.
- **Depends on:** bm46 green (G4). G2, G5, G7, G8, G9 and G15 recorded.
- **Merge rationale:** the Handlebars dependency, the helpers, the layout files and the pagination CSS have no visible result on their own. They merge into their first consumer, the binder render. No editor UI merges before this unit is green (workflow rules §1.3).

### Unit 48 — Rating persists `state`/`district` on `udr_rated` (`bm48`) — _cross-module; only if G1 = R9_

- **Boundary:** the rating module only, under `ratemgmt-ai-workflow-rules.md`:
  - a rating-owned migration adding nullable `state` and `district` to `rating.udr_rated`
  - the RAN-usage rating flow's write
  - the rating Drizzle mirror
  - the **Inv #36 amendment** in `billmgmt-architecture.md`, in the same change set (workflow rules §7.2)

  **No billing code** (workflow rules §3.8).
- **Builds:** the rating step already reads the matched `ratecard_ran_usage_lkp` row to get `rate_per_unit`. It now also writes that row's `state` and `district` at INSERT. No `UPDATE` grant reaches these columns, so the values can't change afterwards. The `udr_key` mapping is confirmed (G13). This applies to new rows only. Existing rows are not backfilled.
- **Visible result:** a newly rated `RAN_USAGE` row carries the `state` and `district` from its ratecard row. Rows rated earlier stay NULL.
- **Depends on:** G1 = R9 and G13. It doesn't depend on 47, so it can run alongside it. It must land before 49.
- **If G1 goes to the Part 1 snapshot instead:** this unit is **retired** and its number is not reused (like Inv #15). Unit 49 then builds on the snapshot.

### Unit 49 — Usage annex by state → district, with subtotals (`bm49`)

- **Boundary:**
  - the binder's usage read. Under R9 this is a read in `rated-lines.repository.ts`, which stays read-only. Under the snapshot option it is the existing appendix read.
  - the `usageAnnex` partial of layout v1 (repo files, still not seeded)
- **Builds:** one usage-section binder, never two (C1):
  - the scope G2 settles on. The R9 direction is every billed `udr_rated` row for the account, across all USAGE.
  - rows grouped by state, then district
  - per-district and per-state subtotal rows, styled per ui-context §6c/§10c
  - the row limit and over-limit behaviour from G2
  - rows with no geo are shown, not dropped
  - no ratecard query at render time (Inv #47)

  Under R9 the binder stops reading the bm45 snapshot. The flow keeps writing it, because Part 2 makes no change to `workflow-management/**`.
- **Visible result:** the posted PDF's usage annex lists each billed row under its state and district, with correct subtotals. The multi-page fixture at the G2 limit passes guardrail 54.
- **Depends on:** 47; 48 (if R9); G1, G2.
- **Why it sits here:** the usage section ships only after the binder's charge reconciliation is green (workflow rules §3.9). It also has to come **before 50**, because layout v1 can't be changed once it is seeded (workflow rules §6.6).

### Unit 50 — Invoice template catalog schema, seed rows, permission row and grants (`bm50`)

- **Boundary:**
  - one hand-written migration, numbered after `0044` (or after unit 48's rating migration)
  - Drizzle schema in `db/schema/billing/{bill-format,bill-template-version,bill-asset}.ts`
  - `db/bootstrap/billrun-db-roles.sql`
  - the permission constants
  - read repositories `bill-template-version.ts` and `bill-asset.ts`
- **Builds:**
  - The tables `bill_format`, `bill_template_version`, `bill_asset` and `bill_asset_version`, none of them partitioned. They carry:
    - UNIQUE `(ref_bill_format_id, kind, version_no)`
    - a partial index allowing one ACTIVE version, excluding the default (G3)
    - CHECKs on status, `change_note` and `ref_layout_version_id`
    - a trigger that only allows appending and retiring (`DEFAULT_VERSION_IMMUTABLE`)
  - Two new `customer_bill` columns: `ref_invoice_profile_version` (integer) and `ref_csv_template_version_id` (G12).
  - Seed rows, each with its `blob_ref` and the SHA-256 checksum of its repo file (G6):
    - `INVOICE`
    - `INVTPL-STD-A4` v1 (`layout`)
    - the default generated v1 (`is_default`, ACTIVE)
    - CSV v1 (`system/csv/v1` column map). It is seeded here so unit 54 can stamp all four columns in one change to the money transaction.
  - The permission set:
    - the `invoice_settings` permission row (`ON CONFLICT DO NOTHING`)
    - `PERMISSIONS.INVOICE_SETTINGS` and the `PermissionName` member
    - the map rows in architecture §4 and code-standards §8
    - the seeded role grants (G11)
  - The `NAV_REGISTRY` entry and its icon wait for the first page (unit 55). A nav entry pointing to a page that doesn't exist would fail the nav guardrail. The spec should confirm this exception to "the permission set moves as one".
  - Grants:
    - `app_runtime` gets per-table grants, with no `DELETE`
    - **revoke** `billrun_runtime`'s column grants on `ref_bill_format_id` / `ref_bill_template_version_id` (Inv #41)
  - Unions and ID formats: `BillFormatCode`, `TemplateKind`, `TemplateVersionStatus`, `BillAssetKind`, and the `BTV` / `INVAST` / `INVASV` prefixes.
- **Visible result:**
  - the migration applies on a fresh database
  - `bill_format` has exactly one row
  - the default layout and generated versions are ACTIVE with `is_default = true`
  - the trigger refuses to retire or delete either one (the database half of guardrail 45)
  - the grant checks over `information_schema` pass (the grants half of guardrail 56)
- **Depends on:** 49, because layout v1 has to be final before its checksums are seeded. G3, G6, G10, G11, G12.
- **Merge rationale:** schema comes before behavior (the bm23 / bm41 precedent, workflow rules §3.1). The permission row, seed rows and grants all go in one migration and have no separate visible result.

### Unit 51 — Generalized write-once blob store (`bm51`)

- **Boundary:** `services/billing/blob-store.ts` only.
- **Builds:**
  - `putObject` / `getObject(container, path, bytes, contentType, { writeOnce })`, with write-once enforced by `if-none-match: *`
  - `putInvoice` / `getInvoice` become thin wrappers and keep md5 as built
  - the `invoice-templates` and `invoice-assets` containers are created automatically, but only on the Azurite connection-string path
  - each object records which checksum algorithm was used
- **Visible result:** invoice PDF writes are byte-for-byte unchanged. The existing bm19/bm34 suites and a new byte-equality test prove it. A write-once put to an existing path is refused.
- **Depends on:** only the delivered blob store. It stays separate from every consumer (workflow rules §3.3).

### Unit 52 — Prod containers + Managed Identity write grant (`bm52`)

- **Boundary:** `infra/**` only (general §2.8, workflow rules §3.4).
- **Builds:**
  - bicep for all three app containers — `invoices` (previously undeclared: it existed in prod only through the app's connection-string `createIfNotExists`), `invoice-templates` and `invoice-assets`
  - a parameter-gated (`appBlobAuth`, G16; default `connectionString` = no change) switch of the app from its Key Vault connection string to its Managed Identity, with a `Storage Blob Data Contributor` scoped to each of the three containers — a change of auth path, not an added grant
  - a step in the cutover runbook. The containers must exist before deploy.
- **Visible result:** bicep what-if or deploy shows the three containers; with `appBlobAuth=managedIdentity`, also the three container-scoped role assignments and the app env switch. The runbook lists them.
- **Depends on:** 51, which fixes the container names. Must be deployed before any prod release that includes 53.

### Unit 53 — Template and profile resolution, checksum-verified load, seed upload (`bm53`)

- **Boundary:**
  - `services/billing/invoice-template/{resolve-template,load}.ts`
  - `db/repositories/billing/invoice-profile.ts` (read) and `validation/billing/invoice-profile.schema.ts`
  - the `db:setup` seed upload
- **Builds:**
  - `db:setup` uploads the seeded layout, default generated and CSV v1 files, write-once.
  - `resolveTemplate` resolves both the generated template and the profile version, in the order pinned → current non-default ACTIVE → `is_default` (Inv #42). If no profile is ACTIVE, G15 applies.
  - `load` runs `getObject` → SHA-256 check → compile → the module-level memo, keyed by version id.
  - The profile is parsed into `InvoiceProfile`. A parse failure is a typed error, never a partial profile.
  - Logo bytes are checksum-verified before they are inlined as a data URI (`ASSET_CHECKSUM_MISMATCH` on failure).
  - The stopgap repo-file loader from unit 47 is deleted.
- **Visible result:** a run with no admin activity renders from the default stored in blob. Changing one byte of a stored `.hbs` parks that account with `TEMPLATE_CHECKSUM_MISMATCH`, and the other accounts still render (guardrails 45, 47).
- **Depends on:** 50, 51; 52 before prod.
- **Merge rationale:** the seed upload shows nothing until something loads the files, and the profile read shows nothing until the binder uses it. Both merge into their first consumer.

### Unit 54 — Posting-time version stamps (`bm54`)

- **Boundary:** the posting transaction: `services/billing/post-run.ts` + `customerBillRepository.stampPosted`. It stays separate from the renderer (workflow rules §3.5).
- **Builds:**
  - Inside the per-account posting transaction, resolve the ACTIVE generated, profile and CSV versions. The profile can be NULL, per G15.
  - Stamp all four columns **in the same `UPDATE` as `ref_inv_document_id`** (Inv #41):
    - `ref_bill_format_id = 'INVOICE'`
    - `ref_bill_template_version_id`
    - `ref_invoice_profile_version`
    - `ref_csv_template_version_id`
  - The final render and `retryRenderInvoice` read only the stamps.
  - Reprint stays a download of the stored bytes (Inv #43).
- **Visible result:**
  - a posted bill carries its four stamps
  - inserting a newer ACTIVE version (a DB fixture until unit 58) leaves the posted bill's stamps and stored PDF bytes unchanged, while a new draft preview uses the newer version
  - trying to stamp afterwards is refused by `0033` (guardrail 46)
- **Depends on:** 53; G15.

### Unit 55 — Invoice Settings shell + Invoice template read page, generator and live preview (`bm55`)

- **Boundary:**
  - `app/(app)/administration/invoice-settings/{layout,page}.tsx` and `invoice-template/**`
  - `services/billing/invoice-template/generate.ts`
  - `actions/billing/invoice-settings/preview-invoice-template.action.ts` (READ, saves nothing)
  - the GET handler for `.hbs` / `structure.json`
  - the nav entry
- **Builds:**
  - The generator. It resolves `[[if sections.*]]`, `[[if columns.*]]`, `[[num …]]` and `[[body]]` into a `.hbs` that contains only `{{ }}`. A hidden section produces no markup.
  - The strict Zod `structure` schema, with a check that every mandatory section is on.
  - The screen components:
    - `InvoiceSettingsTabs`
    - `InvoiceTemplatePage` (`?tab=edit|generated|history`)
    - `InvoiceStructureForm`, read-only below EDIT, with mandatory checkboxes locked
    - `InvoicePreviewFrame`, a sandboxed `srcDoc` iframe
    - `GeneratedHbsViewer` and `VersionHistoryTable`
    - `TemplateVersionStatusBadge`, plus the `Default` chip
  - Previewing a posted bill uses that bill's pinned versions and also requires `billrun_view`.
  - The `NAV_REGISTRY` entry and its `NAV_ICONS` icon.
  - The index redirect. It points to `invoice-template` until unit 56 switches it to `company-profile`.
- **Visible result:**
  - an EDIT user switches optional sections and columns on and off, and the preview updates live without saving anything
  - a READ user sees the form disabled
  - the Generated .hbs tab and its download serve the stored, checksum-verified default
  - Version history lists v1 as `Default`
- **Depends on:** 53, and 54 because the posted-bill preview reads the stamps.
- **Tests:**
  - guardrail **48**, covering all 128 combinations
  - a parity test: `generate(layout v1, default structure)` equals the seeded default generated bytes
  - route × level rows for the page, the preview and the download (guardrail 56)
- **Merge rationale:** the generator shows nothing on its own, and its first consumer is the live preview. The shell and nav also show nothing without a page.

### Unit 56 — Company profile read page (`bm56`)

- **Boundary:** `app/(app)/administration/invoice-settings/company-profile/**`, the logo GET handler, and the exclusion on the generic System Config page.
- **Builds:**
  - `CompanyProfilePage` (`?tab=edit|history`)
  - `CompanyProfileForm`, read-only below EDIT, with fields shown as plain text
  - `VersionHistoryTable` and `TemplateVersionStatusBadge`, reused
  - the logo bytes handler: checksum-verified, sent with `CSP: sandbox` and `nosniff`
  - `invoice.profile` removed from the generic System Config page's editable list
  - the index redirect switched to `company-profile`
- **Visible result:** a READ user opens Company profile and sees the ACTIVE profile and its history, or an empty state if there isn't one yet. The System Config page no longer lists `invoice.profile`.
- **Depends on:** 55 (the shell) and 53 (the profile repository).

### Unit 57 — Invoice template: save draft (`bm57`)

- **Boundary:** `save-template-draft.action.ts` + `services/billing/invoice-template/save-template-draft.ts`.
- **Builds:**
  - one transaction: validate → resolve the user → check `invoice_settings` EDIT → service → `INVOICE_TEMPLATE_DRAFT_SAVED` audit
  - a DRAFT row that holds a `structure` and no files
  - editing a DRAFT's `structure`, the only update allowed on a DRAFT
- **Visible result:**
  - an EDIT user saves a draft, which shows in Version history as `DRAFT` and is never used for invoices
  - the server refuses a save from a READ user
  - a structure with a mandatory section switched off is rejected (`MANDATORY_SECTION_HIDDEN`)
- **Depends on:** 55.

### Unit 58 — Invoice template: activate (`bm58`)

- **Boundary:** `activate-template.action.ts`, `services/billing/invoice-template/activate-template.ts` and `ActivateVersionDialog`.
- **Builds:**
  - Activation runs in this order:
    1. validate
    2. generate `invoice.hbs` + `footer.hbs`
    3. test-render against `sample-data.json`
    4. write the blobs write-once, with SHA-256 checksums
    5. one transaction: insert the new ACTIVE version, retire the previous non-default ACTIVE one, and write `INVOICE_TEMPLATE_ACTIVATED` with both version IDs and the `change_note`
  - `ActivateVersionDialog`: a change note is required, and the button uses the Deep Petrol CTA.
  - Blobs orphaned by a failed transaction are left in place, never deleted inline.
- **Visible result:**
  - activation adds v n+1 as ACTIVE and moves v n to RETIRED in Version history
  - the next draft preview uses the new version
  - bills already posted keep their stamps and PDFs
  - a forced DB failure after the blob write leaves the previous version ACTIVE (guardrail 53)
- **Depends on:** 57, 54; 52 before prod.

### Unit 59 — Company profile: save draft (`bm59`)

- **Boundary:** `save-profile-draft.action.ts` + `services/billing/invoice-profile/save-profile-draft.ts`.
- **Builds:**
  - `CompanyProfileForm` becomes editable at EDIT, using React Hook Form and the shared Zod schema with the formats from placeholder-catalog §B, plus any profile fields G7 adds
  - a DRAFT `config_version` in `invoice.profile`
  - an `INVOICE_PROFILE_DRAFT_SAVED` audit row
- **Visible result:** an EDIT user saves a draft profile, which shows as `DRAFT` in history. Invalid TIN, SST, postcode, SWIFT, email or colour values are rejected both in the form and on the server.
- **Depends on:** 56; G7.

### Unit 60 — Company profile: logo upload + sanitization (`bm60`)

- **Boundary:** `upload-logo.action.ts`, `services/billing/invoice-profile/{upload-logo,sanitize-logo}.ts` and `LogoUploadField`.
- **Builds:**
  - A `FormData` upload that fits the existing `bodySizeLimit`.
  - Server-side checks, in this order:
    1. the actual byte length is 500 KB or less
    2. the magic bytes are PNG, JPEG or SVG and match the declared MIME type
    3. the shorter side is at least 300 px (pure PNG `IHDR` / JPEG `SOFn` / SVG root-attribute parsers; no image library — bm60)
    4. an SVG is rejected if it contains `<script`, `on*=` attributes, `<foreignObject` or an external `href`/`url(`. It is rejected, never repaired
  - A `bill_asset` / `bill_asset_version` row and a write-once blob in `invoice-assets`.
  - The draft profile's `logo_asset_version_id`.
  - An `INVOICE_LOGO_UPLOADED` audit row.
  - Optionally, a first-setup import of `/brand/logo.svg`.
- **Visible result:** a valid logo shows in the dropzone preview. Each bad case is rejected with its own `LOGO_REJECTED` reason (guardrail 52).
- **Depends on:** 59, 51; 52 before prod.

### Unit 61 — Company profile: activate (`bm61`) — G14 decided 2026-10-11 (no four-eyes)

- **Boundary:** `activate-profile.action.ts` + `services/billing/invoice-profile/activate-profile.ts`, reusing `ActivateVersionDialog`.
- **Builds:**
  - server-side `PROFILE_LOGO_REQUIRED` and `CHANGE_NOTE_REQUIRED` checks
  - a full validity gate before DRAFT → ACTIVE: the version must pass `readInvoiceProfile` (schema parse + logo asset row) and `inlineLogo` (logo blob checksum), else activation is refused (as built in bm61, per its spec D2: `PROFILE_LOGO_REQUIRED` for a missing or non-ACTIVE logo asset, `VALIDATION_ERROR` with field errors for the full schema, `ASSET_CHECKSUM_MISMATCH` for the logo blob; DR-01 closed). Posting stamps the ACTIVE profile version without validating it (bm54 D1) and the stamp is permanent (guardrail 46), so an invalid ACTIVE version would leave every bill posted under it render-pending forever (design review DR-01)
  - DRAFT → ACTIVE, the previous version → RETIRED, and an `INVOICE_PROFILE_ACTIVATED` audit row
  - the "Bank details change on every new invoice" warning callout
  - no second signature (G14 decided 2026-10-11, superseding option C of 2026-10-10)
- **Visible result:**
  - activating with a logo and a note makes the profile ACTIVE
  - the next draft preview shows the issuer block, logo and bank details
  - the next posting stamps the profile version
  - bills already posted don't change
  - activation without a logo or a note is refused (guardrail 51)
- **Depends on:** 59, 60, 54. G14 decided 2026-10-11 (no four-eyes).

### Unit 62 — Invoice CSV output (`bm62`)

- **Boundary:** `services/billing/invoice-template/invoice-csv.ts` + `GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv` (`billrun_view` READ).
- **Builds:**
  - the fixed column map, taken from the bill's stamped CSV version and checksum-verified
  - one row per `customer_bill_line`
  - cells made safe against spreadsheet formulas
  - a download link next to the stored invoice
- **Visible result:** a posted bill's CSV downloads with one row per line. Its `net_amount` column adds up exactly to `customer_bill.subtotal`, compared as strings after an SQL sum (guardrail 55).
- **Depends on:** 54, 53.

### Unit 63 — Invoice Template ship gate (`bm63`)

- **Boundary:** cross-cutting: tests, docs and the tracker. **Nothing new is built** (the bm13/bm21/bm35/bm39/bm46 discipline).
- **Builds:**
  - The full journey on a fresh database:
    1. with no admin activity, a bill run renders with the default
    2. activate template v2 and profile v1, then post
    3. activate template v3 and profile v2
    4. check that pinning holds, reprint returns the stored bytes and `charge_checksum` recomputes
    5. change one byte of a stored file and check that only that account parks
  - The Playwright admin e2e across both screens.
  - Guardrails **43–56**, plus whichever of 1–35 cover the touched files, all green.
  - The route × level matrix and the ZAP/Semgrep scope cover the five new routes and six actions.
  - Docs:
    - fold Part 2 into `billmgmt-project-overview.md` and remove it from `billmgmt-update-overview.md`
    - sync the architecture, code-standards and progress tracker
    - close every resolved open item in all three places that track it
- **Visible result:** the Invoice Template update is declared shippable, with overview success criteria 1–12 shown working end to end.
- **Depends on:** 47–62 (48 only if G1 = R9).

### Order that must not change

- **bm46 before 47.** Both updates rewrite the render files (X4), and 47 carries the bm45 appendix forward.
- **47 before the rest of Part 4.** The binder comes first (R10, Inv #39). No editor page, action or component merges until 47 is green.
- **48 before 49, and 49 before 50.** Geo has to exist before the binder reads it, and layout v1 has to be final before it is seeded and can't change.
- **50 and 51 before 53, and 52 before any prod release that includes 53.** Resolution needs the rows, the blob client and, in prod, the containers.
- **53 before 54.** The stamps record what resolution returns.
- **54 before 55, 58, 61 and 62.** Pinning has to be proven before anything can activate a version or read a stamp.
- **Each read page before its mutations.** Template: 55 → 57 → 58. Profile: 56 → 59 → 60 → 61. The template screen goes first for two reasons: the generator is item 6 of the load-bearing order, and profile activation is waiting on G14.
- **63 last.**

### Out of scope (deliberately no unit)

These features are left out of Part 4 on purpose:

- credit notes, debit notes and a separate pro-forma type
- per-MNO or per-customer templates
- admin control of section order, position, labels, wording, colours inside the template, fonts or page setup
- an admin code editor or a visual designer
- issuing invoices from more than one company
- an account summary or balance brought forward
- per-line tax
- `kind = xml`, MyInvois and `einvoice.*`
- a shared asset library and DuitNow QR codes
- bilingual invoices
- re-rendering for reprint
- any fallback to the legacy template
- backfilling geo onto existing `udr_rated` rows
- a new `ONE_TIME` `ChargeSource`
- real taxation (the `0.00` interim stays)
