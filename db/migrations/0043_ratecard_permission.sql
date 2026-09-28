-- Custom SQL migration file, put your code below! --

-- G-RC3 (pm00-build-plan.md Part 5) — the Rate Card Lookup update's own
-- permission, resolved here because its real deadline is pm61: the upload
-- (and pm63/pm64's activation) actions call requirePermission('ratecard',
-- 'EDIT') and do not compile without the types/rbac.ts member landing
-- alongside this row. READ and EDIT only — this update defines no
-- `ratecard : DELETE` (there is no standalone discard; a wrong DRAFT is
-- replaced by re-upload, pm61 D12). Role grants (ADMIN/MANAGER : EDIT,
-- USER : READ) are applied by the seed, not this migration (pm25/bm01
-- precedent). ON CONFLICT DO NOTHING keeps a manual re-run safe against the
-- permission_name unique constraint.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES
  ('ratecard', 'Controls access to the Rate Card page: upload rate card versions and review the activation diff (read and edit only — no delete).')
ON CONFLICT ("permission_name") DO NOTHING;
