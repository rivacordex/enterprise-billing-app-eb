-- ac05-spec §3.5: Permission registry entry for the read-only Accounts module
-- surface. Role grants (MANAGER/USER : READ) are applied by `db:seed-accounts`.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES ('accounts_view', 'Controls access to the Accounts Overview and Ledger Explorer pages (read-only throughout the section).');
