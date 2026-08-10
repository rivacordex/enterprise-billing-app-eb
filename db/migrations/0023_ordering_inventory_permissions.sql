-- Custom SQL migration file, put your code below! --

-- pm25-spec §3: Permission registry entries for the Orders and Subscriptions
-- pages (Ordering & Inventory update). No overlap with `products` — a catalog
-- grant confers no ordering access and vice versa (architecture §4). Role
-- grants (MANAGER/ADMIN : EDIT, USER : READ, on both) are applied by
-- `db:seed-ordering` (accounts precedent — grants live in the seed, not the
-- migration).
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES
  ('product_orders', 'Controls access to the Orders page: create, approve, and reject product orders (manager approval required for negotiated prices).'),
  ('product_inventory', 'Controls access to the Subscriptions page: view product inventory and drive the suspend/resume/terminate lifecycle.');
