# bm33 — Retire `BILLRUN_PLACEHOLDER_MODE`

**Unit:** bm33 (Phase 3 · Phase M). **Boundary:** `lib/config.ts` + `components/billing` + `scripts/billrun-live-kestra-smoke.ts` + guardrails + docs. **App-side cleanup; no schema, flow, or grant change.** **Specs from:** `billmgmt-architecture.md` §6 **Inv #15** (the retired tombstone), `_updatemodule-billing-billrun-phase3-plan.md` **D31**, `billmgmt-code-standards.md` §4.2 / §9.8 / §9.16, `billmgmt-ai-workflow-rules.md` §0 (third reversal), `bm00-build-plan.md` Unit 33.

> **Framing.** The placeholder banner told operators "the billing steps are placeholders." Once the real processing flow is complete (bm30), that copy is **false** — the pipeline computes real money. This unit deletes the flag, the banner/badge components, and every call site; rescopes the two guardrails that were keyed on the flag; and corrects the one doc comment that referenced the placeholder flow. It is a deliberate reversal (the §0 third reversal): `BILLRUN_PLACEHOLDER_MODE` becomes retired-tombstone `Inv #15` — its number is never reused. What **stays** (D31): `_SAMPLE_` marking, unclaimed-on-seed, and the `db:seed-sample` prod guard — those are seed hygiene, not the placeholder banner.

## Goal

Delete `BILLRUN_PLACEHOLDER_MODE` and `isBillrunPlaceholderMode` (`lib/config.ts`), `components/billing/placeholder-banner.tsx` (`PlaceholderBanner` + `PlaceholderBadge`) and every call site, drop the flag's gate from the live-Kestra smoke script (keeping its `_SAMPLE_` provenance gates), rescope guardrails §9.8 and §9.16, and correct the `BILLRUN_DISTRIBUTION_FORCE_FAIL` doc comment — so the bill-run screens no longer carry a warning that contradicts what the pipeline now does, while seed provenance and prod-guard protections remain.

## Design

**Structural decisions**

- **Delete the flag and its accessor (Inv #15 tombstone).** Remove `BILLRUN_PLACEHOLDER_MODE` from `lib/config.ts`, the `isBillrunPlaceholderMode` accessor, the `.env.example` entry, and `tests/lib/config.test.ts`. Inv #15 stays a tombstone — the number is not reused (§7.2).
- **Delete the banner/badge and every call site.** Remove `placeholder-banner.tsx` (`PlaceholderBanner` + `PlaceholderBadge`) and the `placeholderMode` prop threaded through `bill-run-list.tsx`/`run-action-card.tsx`; strip the imports/renders in `bill-runs-empty-state.tsx` and the three pages (`bill-runs/page.tsx`, `[runId]/page.tsx`, `[runId]/approve/page.tsx`); update the component tests (`run-action-card.test.tsx`, `bill-run-detail-page.test.tsx`, `bill-runs-page.test.tsx`, `approve-page.test.tsx`).
- **Drop the flag's gate from the smoke script, keep the `_SAMPLE_` gates (D31).** `scripts/billrun-live-kestra-smoke.ts` currently refuses to run unless `BILLRUN_PLACEHOLDER_MODE = true`. Remove that gate; **keep** the fail-closed `_SAMPLE_` gates (every scoped account under `_SAMPLE_-BILLRUN-0001`, every candidate charge `_SAMPLE_`-marked) — the smoke run is now against real flows, so seed provenance is the only remaining safety, and it is exactly what D31 preserves.
- **Rescope the two flag-keyed guardrails.** §9.8 ("Placeholder isolation") → **non-production ledger isolation alone** — the non-prod environment stays isolated from any real-Accounts ledger, no longer keyed on the flag/badge. §9.16 ("Placeholder isolation, phase-2 additions") → **seed provenance + prod guard alone** — seeded `udr_rated` is `_SAMPLE_`-marked and `db:seed-sample` is prod-guarded and absent from `db:setup` (`billing-sample-seed-marker`/`-boundary` tests, unchanged), no longer "while the flag is set".
- **Correct the force-fail doc comment; the flag stays.** `BILLRUN_DISTRIBUTION_FORCE_FAIL`'s comment says it injects failure "against the deployed placeholder flow" — no longer true. Correct it to describe the `DISTRIBUTION_FAILED` injection switch; **the flag itself stays** (bm34 uses it to force a mandatory-target failure).
- **Kept, not retired (D31).** `_SAMPLE_` marking, unclaimed-on-seed, and the `db:seed-sample` prod guard do **not** retire with the banner — they are the seed hygiene guardrails, moved (not deleted) to §9.16's rescope. There is **no** replacement "seeded data" badge (code-standards §4.2).

## Implementation

### 1. `lib/config.ts` + env + config test

Delete `BILLRUN_PLACEHOLDER_MODE` and `isBillrunPlaceholderMode`; remove the `.env.example` line; drop the flag's case from `tests/lib/config.test.ts`. Correct the `BILLRUN_DISTRIBUTION_FORCE_FAIL` doc comment (remove "against the deployed placeholder flow"; keep the flag as the distribution-failure injection switch).

### 2. `components/billing` — delete banner/badge + call sites

Delete `components/billing/placeholder-banner.tsx`. Remove the `placeholderMode` prop and its render from `bill-run-list.tsx`, `run-action-card.tsx`, `bill-runs-empty-state.tsx`, and the three page components; drop the prop from the tests. No replacement banner.

### 3. `scripts/billrun-live-kestra-smoke.ts` — drop the flag gate

Remove the `BILLRUN_PLACEHOLDER_MODE = true` precondition; keep the `_SAMPLE_-BILLRUN-0001`/`_SAMPLE_` charge-provenance fail-closed gates. Update the script's header comment to say it runs against the real flow with seed provenance as the safety boundary.

### 4. Guardrails — rescope §9.8 and §9.16

- **§9.8:** reword to assert non-production ledger isolation alone (no flag/badge assertion).
- **§9.16:** reword to assert seed provenance (`_SAMPLE_` marking, `billing-sample-seed-marker.test.ts`) + prod guard (`db:seed-sample` prod-guarded, absent from `db:setup`, `billing-sample-seed-boundary.test.ts`) — both tests unchanged, just no longer "while the flag is set".
- **New grep gate:** no `BILLRUN_PLACEHOLDER_MODE` / `isBillrunPlaceholderMode` / `placeholderMode` / `PlaceholderBanner` / `PlaceholderBadge` reference remains outside historical spec docs (bm00/bm15/bm21) and this tracker.

### 5. Docs

Update `billmgmt-ui-context.md` §6 and `billmgmt-code-standards.md` §4.2 to record the retirement (delete the component-name references); note Inv #15 stays a tombstone; `README.md`'s flag mention removed.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm30 — the banner copy ("the billing steps are placeholders") only becomes false once the real processing flow (Validation → Collection → Aggregation → Verification) is complete.

## Verification checklist

- [ ] `BILLRUN_PLACEHOLDER_MODE`, `isBillrunPlaceholderMode`, `placeholder-banner.tsx` (`PlaceholderBanner`/`PlaceholderBadge`) and every call site are gone; the bill-run screens carry no placeholder warning.
- [ ] `scripts/billrun-live-kestra-smoke.ts` no longer requires the flag; its `_SAMPLE_` provenance gates remain (D31).
- [ ] §9.8 rescoped to non-production ledger isolation; §9.16 rescoped to seed provenance + prod guard; the grep gate finds no lingering flag/component reference outside historical docs.
- [ ] `BILLRUN_DISTRIBUTION_FORCE_FAIL`'s comment is corrected and **the flag itself stays** (bm34 needs it).
- [ ] `_SAMPLE_` marking, unclaimed-on-seed, and the `db:seed-sample` prod guard are **kept** (D31); no replacement "seeded data" badge added.
- [ ] `tsc`/lint/tests green; Inv #15 tombstone intact; `billmgmt-progress-tracker.md` records bm33 delivered and the third §0 reversal complete.
