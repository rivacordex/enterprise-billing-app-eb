-- ac07-spec §2.6: Permission registry entry for the Transactions page
-- (draft/submit/post-within-limit/approve). MANAGER-vs-USER approval routing
-- is a service-layer rule (Q20), not a permission level — both grants below
-- are :EDIT. Role grants applied by `db:seed-accounts`.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES ('accounts_transactions', 'Controls access to the Transactions page: draft, submit, post-within-limit, and approve accounting documents.');