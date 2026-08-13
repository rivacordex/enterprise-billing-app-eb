# pm33 — Subscriptions Page + Lifecycle UI

## Goal

Ship `/products/subscriptions`: the guarded inventory list with expandable status history and the suspend / resume / terminate / edit-characteristics dialogs wired to pm32 — killing pm27's Subscriptions 404 and completing the update's user-facing surface.

## Design

- Page mirrors the Orders page patterns: URL searchParams state (`q`, `status`, `page`, `sort`, `subscription` = selected/expanded row), thin RSC orchestrator, guard `product_inventory : READ`, actions re-checking `EDIT`.
- Row actions are status-gated in the UI exactly per pm32's transition matrix (Suspend on `ACTIVE`; Resume on `SUSPENDED`; Terminate on `ACTIVE`/`SUSPENDED`; Edit characteristics on any non-`TERMINATED`; `TERMINATED` rows: no actions, muted, "No actions — terminated" — the catalog's RETIRED-row convention). UI gating is UX; pm32 enforces.
- Status history renders as expandable indented sub-rows (`--surface-sunken`, the Manage Products family-expand affordance) with the derived suspension window summarized beneath — per `mockup-product-ordering.html`. `SubscriptionStatusBadge` wiring (ACTIVE → success, SUSPENDED → warning, TERMINATED → neutral/archive) added to `prodmgmt-ui-context.md` in this unit.

## Implementation

### 1. Page — `app/(app)/products/subscriptions/{page,loading,error}.tsx`

`requirePermission(PRODUCT_INVENTORY, LEVELS.READ)` → parse `subscriptions-list.schema.ts` → `listSubscriptions` + `getSubscriptionDetail` for the selected row → compose. `metadata.title`/`H1`: **"Subscriptions"**. Page resolves `canEdit` (EDIT level) once and threads it.

### 2. Components — `components/products/inventory/`

- `subscriptions-table.tsx` — `SubscriptionsTable`: columns Subscription id, Customer, BAN, Offer (`name (vN)` + `negotiated` pill when `hasOverride`), Qty, Start, End, `SubscriptionStatusBadge`, actions cell (icon-only, 28px, `aria-label`, quiet role; Terminate in danger role). Chevron expand → history sub-rows; Administration table primitives reused.
- `subscription-status-badge.tsx` — `SubscriptionStatusBadge`.
- `status-history-rows.tsx` — `StatusHistoryRows`: transition rows (event id, from → to, effective date, reason, actor) + derived-window note ("Suspended 2026-08-10 → 2026-08-20 — excluded from rating").
- `suspend-dialog.tsx` / `resume-dialog.tsx` / `terminate-dialog.tsx`: effective-date (default today; ≤ 3-day backdate warning banner, > 3 days field error — catalog copy patterns) + reason (required on suspend/terminate); terminate is an `AlertDialog` (danger, terminal-action copy: *"Terminating ends billing after <end date>. This cannot be undone."*).
- `edit-characteristics-dialog.tsx`: reuses pm29's `CharacteristicsEditor` against `instance_characteristics`; body notes the edit never affects pricing.

### 3. Actions — `actions/inventory/`

`suspend-subscription.action.ts`, `resume-subscription.action.ts`, `terminate-subscription.action.ts`, `update-characteristics.action.ts` — standard shape, `requirePermission(PRODUCT_INVENTORY, EDIT)`, mapped pm32 error codes (`INVALID_TRANSITION` surfaced as "Subscription is no longer <status> — refresh and retry"), `revalidatePath('/products/subscriptions')`. New `EXPECTED_INVENTORY_ACTION_FILES` allow-list guardrail created with all four entries.

### 4. Ripple

Route manifest gains `/products/subscriptions`; page-guard tests here (no-grant, and `product_orders`-only principal blocked — separation both directions); nav item now resolves (pm27's accepted 404 closed).

## Dependencies

None (npm). pm27 (nav), pm31 (a live-created subscription exists to exercise), pm32 (services) committed.

## Verification checklist

- [ ] Browser walkthrough: suspend the pm29/pm31-created subscription (reason + date), row flips `SUSPENDED`; resume it; terminate a seeded instance with end date — each action reflected in the expanded history with correct derived window text.
- [ ] Action buttons match the status matrix per row; `TERMINATED` rows show none; READ-only users see no action buttons and forced calls return `FORBIDDEN`.
- [ ] Backdate warnings/errors behave per Q19 on all three date dialogs.
- [ ] Characteristics edit persists, is audited, and changes nothing else on the row.
- [ ] Deep link `?subscription=PRDINV00000001` opens expanded; unknown id → empty state.
- [ ] Route manifest + guard tests green; `EXPECTED_INVENTORY_ACTION_FILES` complete; ui-context badge section added; `tsc`, lint, format, full suite, `next build` green.
