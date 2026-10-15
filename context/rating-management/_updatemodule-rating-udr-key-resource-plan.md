# Rating — Raw `udr_key` and `udr_resource` Cell Label — Plan

**Date:** 2026-10-13 · **Status:** PLAN — decided in the billing phase-3 eng review (2026-10-13), reviewed together with the billing plan (2026-10-14); built on a fresh DB this round, no open decisions · **Owning module:** Rating Management (`rating` schema, `ran-usage-rating` flow: PRP, RP, RL) · **Consumer:** Billing (invoice usage section) · **Companion plan:** [_updatemodule-billing-invoice-template-phase3-billrun-plan.md](_updatemodule-billing-invoice-template-phase3-billrun-plan.md)

**What this is:** two linked changes to RAN-usage rating, so the invoice can print each polygon's original ID, its start date and its state/district **without adding any column to `rating.udr_rated`** and without the invoice ever reading the rate card.

1. **`udr_key` stops being normalised.** It keeps the values exactly as the feed sends them.
2. **`udr_resource` is populated** with the matched rate-card cell's `state|district|polygon_start_date`.

> **This reverses protected rating decisions.** The owner reversed them on 2026-10-13: the "fixed" canonical rule (`_newmodule-rating-engine-plan.md` §4.2 and rm07 D2, `ratemgmt-ai-workflow-rules.md` lines 110 and 118, `prp.py:581-589` "code-standards §6 forbidden edit"), and the "`udr_resource` is reserved, do not populate" rule (rm01 D10, `ratemgmt-architecture.md` Inv #19). §7 lists every rule and document to amend.

---

## 0. Grounding (verified against `enterprise-billing-app`, 2026-10-13)

| Fact | Where |
|---|---|
| `udr_key` is built by `canonical_udr_key`: sorted key names, `k=v` joined by `\|`, each value `strip().casefold()` | `prp.py:581-602`, used at `:768` |
| The rate-card index is keyed by the same canonical form, so a record matches by dictionary lookup. Two card rows that differ only by case/whitespace collapse and fail the batch closed | `prp.py:444-487` (`:463-475`) |
| `udr_rated` already has `state`, `district` (bm48, migration `0045`), written once at INSERT; `rating_runtime` has table-level INSERT and no role has UPDATE on them | `0045`, `udr-rated.ts:152-153`, `rating-db-roles.sql` |
| `udr_resource` is a nullable `text`, reserved and always NULL; RL does not write it | `0034_rating.sql:47`, `udr-rated.ts:61-62`, `rl.py:120-148` |
| `polygon_start_date` exists only on `product.ratecard_ran_usage_lkp` (`NOT NULL`, not a key component); `state`/`district` there are nullable text | `0041:63-70` |
| Live-row uniqueness is `UNIQUE (partition_period, udr_key, is_live)`; RL's billed/in-flight collision guard matches on `(start_datetime, udr_key)` | `udr-rated.ts:164`, `rl.py:325-362` |
| PRP reads only the **ACTIVE** version of the card named by the offering's `productCardLookUp` | `prp.py:434-441` |

---

## 1. Decision log (2026-10-13)

| # | Decision |
|---|---|
| R1 | **`udr_key` is raw.** Each key column's value is stored exactly as parsed from the feed: no trim, no case folding. The emptiness check (`MISSING_KEY_FIELD`) still treats a blank or whitespace-only value as missing. |
| R2 | **Key shape is kept** (owner confirmed 2026-10-13): key names in sorted order, `name=value`, joined by `\|`, e.g. `commercial_unit=<v>\|mno_public_id=<v>\|polygon_id=<v>`. Only the value normalisation is removed. Billing reads the polygon from the `polygon_id=` segment. |
| R3 | **Rate-card matching is exact.** The card index is keyed by the same raw serialisation of the card's `mno_public_key`, `commercial_unit_public_key`, `polygon_id`. Case or whitespace differences between the feed and the card are an `INPUT_UNMAPPED` whole-batch hard stop (existing behaviour; the card cell left unmatched also raises `RATECARD_COVERAGE_GAP`). The feed is expected to be consistent. |
| R4 | **No normalisation as a double-billing guard.** `UNIQUE (partition_period, udr_key, is_live)` and RL's collision guard now compare raw keys. The owner accepts that two records differing only in case/whitespace are different cells. No normalised backstop index. |
| R5 | **`udr_resource` = `state\|district\|polygon_start_date`** of the matched card cell, written once at INSERT. `polygon_start_date` is ISO `YYYY-MM-DD`. A blank state or district is an **empty segment** (e.g. `\|DISTRICT01\|2026-01-01`). Because the card date is `NOT NULL`, every rated RAN row has a non-empty value. |
| R6 | **`state` and `district` columns stay** (bm48 is not reversed). `udr_resource` repeats them by design. Both are write-once at INSERT, so they cannot drift. The invoice reads State and District from `udr_resource`, not from these columns (billing D8), so they have no invoice consumer. |
| R7 | **No new `udr_rated` column, no migration, no grant change.** `udr_resource` already exists; `rating_runtime`'s table-level INSERT covers it; no role may UPDATE it. |
| R8 | **Fresh DB this round (owner, 2026-10-14).** No rows predate this change, so there is no legacy-key regime, no backfill and no cutover. Billing still fails loud on a row with NULL `udr_resource` (companion plan D29). |
| R9 | **Delimiter safety (decided 2026-10-14):** if a card `state` or `district` label contains `\|`, `extract_ratecard` fails the batch closed, with a catalogued event code (`RATECARD_LABEL_INVALID`, `MAJOR`, not self-clearing, decided 2026-10-14; rm02 seed row and `RATING_EVENT_CODES` in the same change set, rm25). Otherwise the three segments cannot be split reliably. |
| ~~R10~~ | **Dropped 2026-10-14:** no cutover guard; the fresh DB removes the legacy-key problem (OI-R1 closed). |

---

## 2. Why this approach

The invoice (layout v2) must print, per polygon: the polygon ID as written, its start date, and a State-District label. Today:

- the polygon is only inside `udr_key`, and normalised (lowercased and trimmed);
- the start date exists only on the rate card, and `udr_rated` does not record which card version matched;
- state and district are already on the row.

Options weighed in the review: new `udr_rated` columns (rejected by the owner), an invoice-time rate-card join (rejected: reverses billing Inv #47 and risks card-version drift), and reusing existing columns (chosen). With raw keys the polygon ID is original-case in the key, and `udr_resource` carries the start date and the geo label. The invoice reads only `udr_rated`.

---

## 3. What changes, by component

**PRP (`prp.py`)**
- Remove `_normalise_value` and the normalising body of `canonical_udr_key` (`:581-602`). Replace with a plain `build_udr_key(profile, row)`: sorted key names, `name=value` with the raw value, joined by `|`. Update the docstrings and comments that describe canonical behaviour (`:178-179`, `:449`, `:463`, `:520`, `:577`). Row-level call at `:768` changes name only.
- `extract_ratecard` (`:444-487`): index key built with `build_udr_key` from the raw card values. Keep the `if cell in index` guard but reword it (`:463-475`): case and whitespace variants are now distinct cells and the DB constraint `ratecard_ran_usage_lkp_row_key_unique` (`0041:82`) already rejects exact duplicates, so the guard now fires only on a serialisation collision; removing it would let one cell silently overwrite another (rm26 Design).
- `_RATECARD_SQL` (`:434-441`) also selects `l.polygon_start_date`.
- `RatecardCell` (`:421-431`) gains `polygon_start_date` and a precomputed `udr_resource` string, built once per card cell at extract time, never per record. If `state` or `district` contains `|`, fail closed (R9).
- `ParsedRow` (`:681-696`) gains `udr_resource`; record enrichment copies it from the matched cell next to `state`/`district`; the chunk frame (`_chunk_frame`, `:823`) and PRP output schema carry a nullable string column `udr_resource`.
- `validate_row`: `MISSING_KEY_FIELD` check (`:729-733`) unchanged.
- No cutover guard (R10 dropped).

**RP (`rp.py`)** — pass `udr_resource` through unchanged, as it already does for `state`/`district` (`_GEO_COLUMNS`, `:121`).

**RL (`rl.py`)**
- Append `"udr_resource"` to `COPY_COLUMNS` (`:120-148`), after `"district"`.
- Add `"udr_resource"` to the named optional allowlist (`_GEO_OPTIONAL_COLUMNS`, `:154`): written NULL for a usage type that reads no card, but **required** for `RAN_USAGE`, so a chunk missing it still fails loud.
- The collision guard (`:325-362`) and the live-row constraint need no code change; they now compare raw keys.

**Flow / versioning** — bump `rating_engine_version` / the flow revision so `udr_rated.rating_flow_revision` separates rows with raw keys from legacy rows (bm48 did the same). No Kestra task change expected; deploy through the pipeline only.

**Database** — nothing. Update the code comment on `udr_resource` (`udr-rated.ts:61`, "Reserved, stays NULL") and the rm01 schema table row.

**Seeds and helpers** — `db/seeds/sample/udr-rated-sample.ts`, `seed-billrun-sample.ts`, `capacity-usage-card.ts` (capacity rows must emit raw cell keys and a populated `udr_resource`; one RAN row stays with NULL `udr_resource` to exercise the billing fail-closed path), `tests/helpers/rating-ran-harness.ts`.

---

## 4. Hardest parts and risks

1. **Double-billing protection is weaker (R4, accepted).** Today case/whitespace variants collapse to one key; now they are two live rows. This holds only while the feed formats each polygon identically every month.
2. **Exact matching is brittle (R3, accepted).** A stray space or case difference between the feed and the card is an `INPUT_UNMAPPED` and, under `HARD_STOP`, stops the batch.
3. **Mixed regimes: not applicable this round (fresh DB).** If an existing DB were ever carried forward, legacy rows would have lowercase keys and a re-rated period would not collide with them, so RL's guard and the live-row constraint could not catch a duplicate. Reintroduce a cutover guard before that.
4. **Supersede/rerun.** RL supersede is by `file_key`, so a corrected re-send of the same file is safe. RL's collision guard (`rl.py:337-347`) matches `udr_key` exactly and checks only `BILL_DRAFT`/`BILL_APPROVED` rows, so two `RATED` rows that differ only in case both go live (R4, accepted and asserted by a test). Trace the remaining cross-batch key comparisons before build (OI-R3).
5. **Delimiter.** `|` inside a card label breaks the split (R9).

---

## 5. Tests

| Test (under `tests/rating/**`) | Assertion |
|---|---|
| `rm07-prp-claim-validate-reject` (extend) | `udr_key` keeps case and whitespace of the feed value; two records differing only in case produce different keys; blank key field still `MISSING_KEY_FIELD`; matching is exact (a case-different polygon is an `INPUT_UNMAPPED`); PRP output carries `udr_resource`. |
| new PRP card-extract cases | a card `state` containing `\|` fails the batch closed (R9); blank state/district give empty segments; case-variant card cells are distinct cells, and a serialisation collision still fails closed before any claim. |
| `rm09-rl-guarded-transactional-load` (extend) | RL COPY writes `udr_resource`; a RAN chunk missing it raises; a non-RAN chunk writes NULL; billed/in-flight guard still fires for an identical raw key. |
| RL guard, accepted behaviour (new case in `rm09`) | two `RATED` rows whose keys differ only in case both load; the test makes the accepted R4 behaviour explicit. |
| `rm13-e2e-journey` (extend) | end-to-end rated row has the raw key and `udr_resource = state\|district\|date` of the matched cell. |
| `rm23-udr-geo-frozen` (extend) | after rating, re-version the card with different labels or start date: the rated row's `udr_resource` is unchanged; UPDATE of `udr_resource` is refused for `rating_runtime`, `app_runtime`, `billrun_runtime`. |
| `grants.integration.test.ts` (extend) | `udr_resource` appears in no role's UPDATE column list. |
| `rm01-schema` (update) | the column is still nullable `text`; its "reserved" assertion/comment is replaced. |
| `rm08-rp-price-resolution-snapshot` (check) | any case-normalised key literal is updated. |

---

## 6. Scope

**In:** raw `udr_key`; exact card matching; `udr_resource` population for `RAN_USAGE`; amendments in §7.

**Out:** new `udr_rated` columns; reversing bm48 (`state`/`district` stay); backfilling old rows; a cutover guard; a normalised uniqueness backstop; changes to the `udr_key` length cap (512) or the live-row constraint; non-RAN usage types (they write NULL `udr_resource`).

---

## 7. Rules and documents to amend (same change set, rating workflow rules §4/§7)

- `_newmodule-rating-engine-plan.md` §4.2 and §14 item 1 (the canonical rule), `rm07-prp-claim-validate-reject.md` D2, and `rm01-rating-schema-foundation.md` **D10** (`udr_resource` reserved) with its schema row at line 206.
- `ratemgmt-architecture.md`: **Inv #19** (`udr_resource` deferred semantics), the Inv #20(b)/#26 wording that cites `canonical_udr_key`, and any invariant describing canonical keys.
- `ratemgmt-ai-workflow-rules.md`: lines 110 and 118 (canonicalisation ordering/rule as fixed), DECIDED item at line 29 if it cites the rule.
- `ratemgmt-code-standards.md`: new §0.1 records this update's code-standard deltas; §5.2 and §5.4 gain a pointer to it. No existing rule in that file states the canonical rule.
- `ratemgmt-project-overview.md`: lines 12, 28, 56 (canonical-key rationale).
- `rm07-prp-claim-validate-reject.md` and `rm21` specs, `rm00-build-plan.md`, `ratemgmt-progress-tracker.md`.
- Billing side, same change set: `bm48-rating-udr-rated-geo.md` G13 wording and D2, `bm45` D2, `billmgmt-architecture.md` Inv #36/#47 wording, `billmgmt-known-issues.md` (OI-4 and the bm45 D4 residual), `billmgmt-code-standards.md`.

---

## 8. Sequence and dependencies

1. This rating change ships **before** the companion billing plan's slice 2 (the usage-section query and v2 detail). Billing slice 1 (family, binding, freeze, resolver) does not depend on it.
2. No billing code changes in this plan (rating workflow rules §3.8).
3. Fresh DB this round: no legacy rows, so no cutover period to plan.

---

## 9. Open items

| # | Item | Owner |
|---|---|---|
| ~~OI-R1~~ | **Closed 2026-10-14:** operational rule only; this round runs on a fresh DB, so there is no pre-cutover period (R8, R10 dropped). | — |
| ~~OI-R2~~ | **Closed 2026-10-13 (owner confirmed):** the key shape stays sorted `name=value\|...`; only value normalisation is removed (R2). | — |
| ~~OI-R3~~ | **Closed 2026-10-14:** traced (table in the rm28 spec). Supersession keys on batch lineage, not `udr_key`; every `udr_key` comparison (guard SQL, cross-period set, completeness check, in-file dedup, unique constraint) is exact-match, so raw keys behave consistently in a fresh DB. No RL change is needed for raw keys. | — |
| OI-R4 | `udr_resource` segment order and delimiter (`state\|district\|date`) are accepted; confirm no other consumer (billing UI, exports) will read the column. | Rating + Billing |
| ~~OI-R5~~ | **Closed:** "partition_start_date" means `polygon_start_date`. | — |
| ~~OI-R6~~ | **Closed 2026-10-14:** a rate-card label containing `\|` fails the batch (R9). | — |

---

## 10. Eng review outputs (2026-10-14, reviewed together with the billing plan)

### NOT in scope
- New `udr_rated` columns, reversing bm48, a cutover guard, a backfill, a normalised uniqueness backstop (all listed in §6).
- Any billing code (rating workflow rules §3.8).

### What already exists (reused)
- bm48's path PRP → RP → RL for `state`/`district`: `udr_resource` rides the same three hand-offs.
- PRP's single ratecard read per batch and in-memory cell index (no per-record query).
- The existing `udr_resource` column, `rating_runtime`'s table-level INSERT, and the no-UPDATE grants.

### Failure modes
| Path | Failure | Test | Handling | Seen as |
|---|---|---|---|---|
| Exact card match | stray case/space in feed | yes | `INPUT_UNMAPPED` / `HARD_STOP` | batch stops, clear |
| Raw key | two records differing only in case | yes (documents R4) | none, accepted | silent (accepted risk) |
| `udr_resource` build | label contains `\|` | yes (R9, pending) | batch fails closed | clear |
| RL COPY | RAN chunk missing `udr_resource` | yes | KeyError guard | loud |
No critical gap: the one silent case (R4) is an explicit owner decision and now has a test.

### Performance
No concern. The label is built once per card cell at extract time, the per-record dictionary lookup is unchanged, and COPY gains one text column.

### Implementation tasks
Decomposed into build units in `context/rating-management/specs/rm00-build-plan.md` Phase H (rm24–rm29): T4 → rm24; T1 → rm26; T2 → rm27 (RP) and rm28 (RL), split because PRP, RP and RL are separate units; T3 → tests inside each unit and rm29; T5 → rm29. The build plan adds rm25 (the `udr_resource` contract and the new event code).
- [ ] **T1 (P1)** PRP: `build_udr_key` (raw), exact card index, `RatecardCell.udr_resource`, `polygon_start_date` in the SQL, R9 guard. Files: `prp.py`. Verify: `rm07` cases.
- [ ] **T2 (P1)** RP pass-through and RL `COPY_COLUMNS` / optional allowlist. Files: `rp.py`, `rl.py`. Verify: `rm09` cases.
- [ ] **T3 (P1)** Tests in §5 including the R4 documentation case and the grants check.
- [ ] **T4 (P2)** Amend the rules and documents in §7 in the same change set.
- [ ] **T5 (P2)** Seeds and `rating-ran-harness.ts` emit raw keys and a populated `udr_resource`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found (Claude subagent) | 3 findings on this plan, 2 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 10 decisions (R1–R10), 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** the subagent flagged the double-billing blind spot of raw keys (owner accepted R4, then removed the legacy exposure with a fresh DB), the cross-plan sequencing (stated in §8), and the blank-label display rule (added to billing D21).
- **VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
