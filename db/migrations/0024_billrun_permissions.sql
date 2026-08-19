-- Custom SQL migration file, put your code below! --

-- bm01-spec §3: Permission registry entries for the Bill Runs page and the
-- operate/approve capabilities (segregation of duties — three grants, not one).
-- Role grants (ADMIN : all three; BILLING_VIEWER : billrun_view READ) are applied
-- by `db:seed-billing` (accounts/ordering precedent — grants live in the seed).
-- ON CONFLICT DO NOTHING keeps a manual re-run safe against permission_name unique.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES
  ('billrun_view',    'Controls read access to the Bill Runs page: list, drill-down, and export.'),
  ('billrun_operate', 'Controls operate access to bill runs: trigger, rerun, and cancel.'),
  ('billrun_approve', 'Controls approve access to bill runs: approve and post invoices (four-eyes).')
ON CONFLICT ("permission_name") DO NOTHING;
