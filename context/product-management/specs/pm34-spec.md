# pm34 — Update Ship Gate: Authz Matrix + Guardrail Sweep

## Goal

Land the update's ship gate: authz-matrix entries for both new pages, the update-specific guardrail suite (grandfathering, insert-only surfaces, boundary sweeps, gap-free history), full verification pass, and doc sync — CI green proves pm25–pm33 done.

## Design

- Mirrors pm09/pm24 (and ac17/ac23): tests + CI + doc sync only — **no product code changes**. Any gap found here is fixed by reopening the owning unit's files under this unit's commit, flagged in the progress tracker.
- Guardrails are named and numbered continuing the module's §9 list in `prodmgmt-code-standards.md` (15–22), which this unit also writes — the update's conventions land in code-standards now, per its scope note.

## Implementation

### 1. Authz matrix (`tests/**/guard.integration.test.ts`)

`/products/orders` and `/products/subscriptions` × every role/level combination: no-grant → `/no-access`; READ sees lists but forced mutations return `FORBIDDEN`; EDIT enables mutations; **cross-permission separation proven both directions** — a `products : DELETE` catalog principal has no access to either new page, and a `product_orders`/`product_inventory` principal has no catalog write access; approval additionally proven MANAGER-gated (EDIT-without-role refused).

### 2. Update guardrail suite (code-standards §9 additions 15–22)

15. **Insert-only surfaces** — override + history repositories export no `update*`/`delete*` (structural, re-asserted here as the permanent home even though first landed in pm26).
16. **Grandfathering** — activate a new version of the ordered offering (catalog services); assert the subscription's pinned `product_offering_id` unchanged, its `OrderPriceLine`/rating reads still resolve from the now-`RETIRED` version's rows byte-identically (Inv. #17).
17. **Gap-free history** — the pm32 derivability helper run across every seeded + test-created instance: latest history `to_status` ≡ `status` column; windows derive strictly in `effective_date` order.
18. **Write-once core** — no code path updates `product_order_item` columns or inventory core columns (structural: item repo exports insert+finders only; inventory repo update surface is exactly `updateStatus` + `updateCharacteristics`).
19. **Boundary sweeps** — `EXPECTED_ORDERING_ACTION_FILES` / `EXPECTED_INVENTORY_ACTION_FILES` exact; `app/api/ordering*` / `app/api/inventory*` / `app/api/product*` absent; `components/products/*` (View Product) still imports nothing from ordering/inventory/write paths; `db/schema/product.ts` still byte-identical.
20. **No-cycle-column** — schema introspection: no column named like `%cycle%`/`%frequency%` in `ordering.*`/`inventory.*` (Inv. #20).
21. **Route manifest** — both new routes exactly once each.
22. **Reviewer ≠ submitter** — DB CHECK fires on direct SQL; service path already covered in pm30, referenced not duplicated.

### 3. Full verification pass (workflow §8)

`tsc --noEmit`, ESLint, Prettier, full suite, `next build`, SAST + ZAP DAST baseline; existing catalog + Administration + Accounts pages green and byte-identical URLs; audit-filter counts consistent with all 11 new event types; live-DB smoke of the two happy paths (standard order; override → approve → suspend/resume).

### 4. Doc sync (merged here — no standalone visible result)

- `prodmgmt-code-standards.md`: update conventions — file tree additions (§7), permission map rows for both pages + approval (§8), guardrails 15–22 (§9), the cross-module transactional-read rule (§1), replacing the interim scope note.
- `prodmgmt-completed-tracker.md`: pm25–pm34 unit notes (ripple patterns included: new-pgSchema test setup, audit-filter counts, cross-module locked finders).
- `prodmgmt-architecture.md`: flip the update's status markers from PLANNED to SHIPPED; drop the dead FK-fallback sentence.
- `prodmgmt-ai-workflow-rules.md`: the update's permanent rules move from "once built" phrasing into the standing §1.4 list.

## Dependencies

None. pm25–pm33 committed.

## Verification checklist

- [ ] Authz matrix green for every combination in §1, including both-directions separation and the MANAGER gate.
- [ ] Guardrails 15–22 all green; each maps to a named test file under `tests/`.
- [ ] §3 full pass clean; no high/critical SAST/DAST finding.
- [ ] Live smoke: both happy paths executed against the dev DB and cleaned up.
- [ ] All four docs in §4 updated in this same change set; no doc contradicts a shipped behavior.
- [ ] No product-code diff in this unit beyond reopened-gap fixes explicitly listed in the tracker note.
