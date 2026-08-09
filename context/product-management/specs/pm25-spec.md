# pm25 — Ordering & Inventory Data Layer

## Goal

Create the `ordering` and `inventory` pg schemas (5 tables, enums, sequences, constraints, cross-schema FKs), the `product_orders` / `product_inventory` permission seeds, the Zod validation layer, and seeds telling the plan's sample story — so the order → subscription data shape exists, is queryable, and provably rejects bad data before any code consumes it.

## Design

- Two schemas split on TMF component lines: `ordering` (TMF622 — write-once intake) and `inventory` (TMF637 — long-lived subscriptions, future bill-run read path). No change to `db/schema/product.ts` (guardrail: schema-diff must stay byte-identical).
- IDs: house convention, prefix + `lpad(nextval, 8, '0')` (repo-wide 8-digit standard, commit `b27bb3e`) — `PRDORD` (order), `PRDORI` (item), `PRDOPO` (override), `PRDINV` (inventory), `PRDIVE` (history); one sequence per table.
- Status enums seeded in full, used-subset documented: `ordering.order_status` = `ACKNOWLEDGED / REJECTED / PENDING / HELD / IN_PROGRESS / CANCELLED / COMPLETED / FAILED / PARTIAL`; `inventory.product_status` = `CREATED / PENDING_ACTIVE / ACTIVE / SUSPENDED / PENDING_TERMINATE / TERMINATED / CANCELLED / ABORTED`.
- All dates are **inclusive-billed** (Inv. #21) — state this in a schema-file comment block; column type `date`, not timestamptz, for `start_date` / `end_date` / `effective_date`.

## Implementation

### 1. `db/schema/ordering.ts`

- `export const ordering = pgSchema("ordering")` + `orderStatus` enum.
- `productOrder`: `product_order_id` PK (default `'PRDORD' || lpad(...)`), `customer_party_role_id` NOT NULL FK → `customer.party_role`, `billing_account_id` NOT NULL FK → `billing.billing_account`, `status` NOT NULL, `failure_reason` NULL, `submitted_by` NOT NULL FK → `core.APPUSER`, `submitted_at` NOT NULL, `reviewed_by` NULL FK → `core.APPUSER`, `reviewed_at` NULL, `completed_at` NULL, `created_at`/`updated_at`. CHECK `reviewed_by IS NULL OR reviewed_by <> submitted_by` (`product_order_reviewer_check`).
- `productOrderItem`: `product_order_item_id` PK, `product_order_id` NOT NULL FK, `product_offering_id` NOT NULL FK → `product.product_offering` (pinned version — Q5), `quantity` integer NOT NULL CHECK ≥ 1, `start_date` date NOT NULL, `ordered_characteristics` jsonb NULL `$type<Record<string,string>>()`, `created_at` only (write-once — no `updated_at`).
- `orderItemPriceOverride`: `order_item_price_override_id` PK, `product_order_item_id` NOT NULL FK, `price_type` text NOT NULL, `amount` numeric(12,2) NOT NULL CHECK > 0, `currency` text NOT NULL, `created_at`. UNIQUE (`product_order_item_id`, `price_type`).

### 2. `db/schema/inventory.ts`

- `export const inventory = pgSchema("inventory")` + `productStatus` enum.
- `productInventory`: `product_inventory_id` PK, `product_order_item_id` NOT NULL **UNIQUE** FK → `ordering.product_order_item`, `customer_party_role_id` / `billing_account_id` / `product_offering_id` NOT NULL FKs (denormalized for the bill-run read path), `quantity` CHECK ≥ 1, `instance_characteristics` jsonb NULL, `status` NOT NULL, `start_date` date NOT NULL, `end_date` date NULL CHECK `end_date IS NULL OR end_date >= start_date`, `created_at`/`updated_at`.
- `inventoryStatusHistory`: `inventory_status_history_id` PK, `product_inventory_id` NOT NULL FK (indexed), `from_status` NULL (NULL only on creation row), `to_status` NOT NULL, `effective_date` date NOT NULL, `reason` text NULL, `changed_by` NOT NULL FK → `core.APPUSER`, `created_at`. No `updated_at` — append-only by shape.
- Export both files from `db/schema/index.ts`.

### 3. Migration + permission seeds

- One generated migration (drizzle-kit, hand-verified for `CREATE SCHEMA`, sequences, enums — pm02/pm10 precedent) creating everything above.
- Second, data-only migration adding `core.PERMISSIONS` rows `product_orders` and `product_inventory` (registry pattern of `0015`/`0017`); `auth/permission-constants.ts` gains `PRODUCT_ORDERS: "product_orders"`, `PRODUCT_INVENTORY: "product_inventory"`.
- Role grants applied by seed (accounts precedent, not migration): MANAGER → EDIT on both; USER → READ on both; ADMIN → EDIT on both.

### 4. `validation/ordering/**` + `validation/inventory/**`

- `create-order.schema.ts`: `customerPartyRoleId` (`/^PTRL\d{8}$/` — match the customer module's actual format), `billingAccountId` (`/^BAN\d{8}$/`), `productOfferingId` (`/^PRDOFR\d{8}$/`) — all 8-digit, matching the repo-wide standard (commit `b27bb3e`); the spec's earlier `\d{6}` was a pre-standardization artifact, `quantity` int ≥ 1 default 1, `startDate` (ISO date; fast-fail ≥ today − 3 days — authoritative re-check in pm28's service against injectable `now`, pm15 pattern), `characteristics` `z.record(z.string().min(1), z.string())` optional, `overrides` array of `{ priceType: z.string(), amount: 2dp-string regex, currency: z.literal-set from BAN currency check deferred to service }` optional, max one per priceType (refine).
- `review-order.schema.ts`: `orderId`; `reason` optional (approve) / required min 1 (reject) — two derived schemas.
- `orders-list.schema.ts` / `subscriptions-list.schema.ts`: searchParams (`q`, `status`, `page`, `sort`, `order` / `subscription` selection) with invalid → defaults.
- `inventory` lifecycle schemas: `suspend` (`inventoryId`, `effectiveDate`, `reason` min 1), `resume` (`inventoryId`, `effectiveDate`), `terminate` (`inventoryId`, `endDate`, `reason` min 1), `update-characteristics` (`inventoryId`, `characteristics` record). All date fields carry the same 3-day fast-fail refine.

### 5. Seeds — `db/seeds/ordering-inventory.ts`

Resolve seeded party/BAN/offering ids at runtime by lookup (customer-seed pattern — never hardcode ids): one `COMPLETED` order with override (recurring 420.00 vs list) + its `ACTIVE` inventory with 3 history rows (create / suspend / resume — the plan's sample story), one standard `COMPLETED` order + `TERMINATED` inventory, one `PENDING` override order with **no** inventory, one `REJECTED` order. All characteristics rows populated. Seed script validates every jsonb write through the Zod schemas.

### 6. Guardrail tests (owned here)

Integration tests (new-pgSchema setup ripple — see progress-tracker note): each constraint trips — qty 0, duplicate (item, price_type) override, `reviewed_by = submitted_by`, `end_date < start_date`, override amount ≤ 0, duplicate inventory for one order item, FK violations to closed/absent rows. Plus: `db/schema/product.ts` byte-diff guardrail still green.

## Dependencies

None. No npm packages, no DB extensions. Prerequisites already delivered: catalog (pm02/pm10), accounts `billing.*` (ac02/ac03), customer module.

## Verification checklist

- [ ] Migration applies on a fresh DB and as a catch-up on the dev DB (`db:migrate`).
- [ ] Seeded story queryable in psql: order → item → override → inventory → 3 history rows joins resolve; `PENDING` order provably has zero inventory rows.
- [ ] Every bad-seed case in §6 fails at the **database**, not only Zod.
- [ ] `PERMISSIONS` rows exist; typed constants compile; role grants seeded (MANAGER/ADMIN EDIT, USER READ × 2).
- [ ] `db/schema/product.ts` unchanged (guardrail); no repository/service/UI files touched.
- [ ] `tsc --noEmit`, ESLint, Prettier, full existing suite green.
