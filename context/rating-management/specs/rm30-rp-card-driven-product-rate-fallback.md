# rm30 — RP: card-driven `usage_rate` falls back to the product rate — Spec

- **Unit:** rm30 of Phase I (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (wfm surface) · **Boundary:** `workflow-management/worker/workflow-engine/runtime/rp.py`, a new `tests/rating/rm30-rp-card-driven-fallback.integration.test.ts`, and the doc amendments listed under Implementation §3.
- **Authorizes from:** owner decision 2026-10-22 ("although the price is card-driven, we're not supplying a price in the rate card, so it should take it from the product"); `validation/product/pricing-component.schema.ts` PC10 precedence (card entry → card default → `params.ratePerUnit`), of which this unit enacts only the final step; `ratemgmt-architecture.md` Inv 23 and Inv 24 (amended by this unit).
- **Depends on:** rm19 (`derive_rate_type`), rm20 (RP price path), rm21 (PRP proves every input cell maps to the ACTIVE card). No app-side dependency: no migration, no grant (rm16 already grants `rating_runtime` `SELECT` on `product.ratecard_version` and `product.ratecard_ran_usage_lkp`), no event code.

## Goal

Let RP rate a card-driven `usage_rate` (`plaSpecId = 'PLA_USAGE_RATE'`) at the product's `ratePerUnit` when the rate card it names supplies no rate, instead of refusing every card-driven price with `CARD_DRIVEN_RATING_UNSUPPORTED`. Reading rates **from** the card stays a later phase.

## Design

- **D1 — Fallback, not card-rate resolution.** The amount is always the resolved `ratePerUnit` (or the order-item usage override, unchanged `COALESCE(override, ratePerUnit)` from rm08 D2). RP never selects, joins or computes with `ratecard_ran_usage_lkp.rate_per_unit`. Inv 23's "`ratecard.rate_per_unit` is never read for rating" still holds for the amount; RP only counts whether any cell rate exists.
- **D2 — Card-level check, once per batch.** For each distinct `rateCardLookUp` named by a resolved card-driven price, one set-based query counts the non-NULL `rate_per_unit` cells on that card's **ACTIVE** version (`card_rated_cells`). Results are cached across chunks; never queried per record (Inv #10).
- **D3 — Decision table** (`derive_rate_type`, `usage_rate` + `PLA_USAGE_RATE`):

  | Card state | Result |
  | --- | --- |
  | `rateCardLookUp` empty | refuse `CARD_DRIVEN_RATING_UNSUPPORTED` ("names no rate card") |
  | no ACTIVE version of the named card | refuse ("has no ACTIVE version") |
  | ACTIVE version, ≥1 cell with `rate_per_unit` | refuse ("carries N cell rate(s); reading card rates is unsupported") |
  | ACTIVE version, every `rate_per_unit` NULL | `PER_UNIT` at `ratePerUnit` |

  Refusing when any rate exists is deliberate: falling back would silently ignore rates someone uploaded. The check is card-wide, not per cell, so a partly-rated card is refused as a whole.
- **D4 — Same event code, richer message.** Every refusal reuses `CARD_DRIVEN_RATING_UNSUPPORTED` (already catalogued, rm18); the `specific_problem` names the reason and `additional_info` gains `card_name`. No catalog change, so rm02's count is unaffected.
- **D5 — Rated row unchanged.** A fallback row is indistinguishable in shape from a plain `PER_UNIT` row: `udr_rate_type = PER_UNIT`, `udr_rate_detail = {rateType, ratePerUnit, quantity, amountRaw}` (rm17 schema and golden fixture untouched), `udr_price_ref` = the card-driven price id, which is the provenance.
- **D6 — Which card.** The check uses the **price's** `rateCardLookUp`. The offering's `productCardLookUp` (the card PRP maps cells against) is expected to name the same card; by the 2026-10-22 owner decision both are `RATECARD_RAN_USAGE_LKP`. No cross-check is added this unit.
- **D7 — Card version timing is unchanged.** The check reads the card's version that is ACTIVE when RP runs, the same as PRP's mapping (no as-of card resolution).

## Implementation

### 1. `rp.py`
- `CardDrivenRatingUnsupported(pla_spec_id, price_ref, reason, card_name=None)`; message `usage_rate price … is card-driven (plaSpecId=…) and <reason> — not rated.`
- `derive_rate_type(..., card_name=None, card_rated_cells=None)` implements D3.
- `_RESOLVE_SQL` selects `pw.rate_card_lookup`; `Resolution.rate_card_lookup`. The window must read it from `price_component #>> '{params,rateCardLookUp}'` (it lives under `params`); the pre-rm30 top-level read was always NULL.
- New `_CARD_RATED_CELLS_SQL` + `card_rated_cells(conn, names)`; `process_chunks` caches per batch and passes `card_rates` to `rate_record`.
- `emit_card_driven_unsupported` adds `card_name` to `additional_info`. Module docstring and comments updated.

### 2. Tests (`tests/rating/rm30-rp-card-driven-fallback.integration.test.ts`, new)
On the maintained `rating-ran-harness` (as rm27), `describe.skipIf(!databaseUrl || !pythonRuntimeReady())`. Each graph's price is switched to card-driven by a superuser update (`set local session_replication_role = replica` — the DRAFT-guard trigger blocks child writes on an ACTIVE offering).
1. **Fallback rates.** Card with no `rate_per_unit` → RP exits 0; every rated row `PER_UNIT`, `udr_usage_rate = ratePerUnit`, `amountRaw = ratePerUnit × volume`, `udr_price_ref` = the card-driven price.
2. **Card rates present.** Same graph shape, one cell given a `rate_per_unit` → RP exits non-zero with `CARD_DRIVEN_RATING_UNSUPPORTED` "carries 1 cell rate", one RP `process_log` line, no rated manifest.
3. **Missing card.** `rateCardLookUp` naming a card with no ACTIVE version → refused "has no ACTIVE version".

The legacy rm08 suite's card-driven case (OFF5, a card name with no ACTIVE version) still expects a refusal and stays correct; it is not edited (rule 10, and it still uses the pre-rm21 PRP CLI).

### 3. Docs (same change set)
- `ratemgmt-architecture.md` Inv 23 and Inv 24 reworded to D1/D3.
- `ratemgmt-code-standards.md` §0 price-resolution paragraph.
- `ratemgmt-ai-workflow-rules.md` §0 rule 4 and §3 rule 1.
- `ratemgmt-project-overview.md` card-driven bullets.
- `rm00-build-plan.md` Phase I + summary row + rate-types note.
- `rm19` spec: forward banner only.
- `ratemgmt-completed-tracker.md` Phase I row and note.

## Verification checklist

- [ ] A card-driven price whose ACTIVE card has no `rate_per_unit` rates `PER_UNIT` at `ratePerUnit`; `udr_rate_detail` validates against the rm17 schema.
- [ ] Any non-NULL `rate_per_unit` on the ACTIVE card → refusal, one RP log line, no rated manifest.
- [ ] Missing card / empty `rateCardLookUp` → refusal.
- [ ] One card query per distinct card name per batch, not per record.
- [ ] Plain (`plaSpecId` null) and `flat_fee` paths unchanged.
- [ ] Diff touches only `rp.py`, the new rm30 suite and the listed docs: no `prp.py`, `rl.py`, migration, grant, flow YAML or catalog change.
- [ ] Live re-rate of the eMBB feed (`RATECARD_RAN_USAGE_LKP`, 0 card rates) completes with rated rows at 100/Mbps.
