-- ac12-spec §3.6 — accounts_config permission entry. Role grants
-- (MANAGER:EDIT, ADMIN:EDIT; USER gets no accounts_config access per
-- architecture §4) are applied by `db:seed-accounts`.
INSERT INTO "core"."permissions" ("permission_name", "permission_info")
VALUES ('accounts_config', 'Controls access to Chart of Accounts, GL Journal, period close, and Accounts Settings — finance-config operations restricted to managers and finance-config holders (architecture §4).');
--> statement-breakpoint
-- Update gl_resolution_view to match only active (non-retired) mapping rules.
-- The gl_mapping.state column was added in migration 0018; the view was created
-- in 0012 before that column existed. Without this fix, retired gl_mapping rows
-- would still resolve pgledger accounts, making the F5 in-transaction orphan
-- check ineffective (retiring a mapping inside a transaction would still show 0
-- unmapped because the retired row continues to match the lateral join).
CREATE OR REPLACE VIEW billing.gl_resolution_view AS
SELECT
  pav.id AS pgledger_account_id,
  gm.ref_gl_code AS gl_code
FROM billing.pgledger_accounts_view pav
LEFT JOIN billing.ledger_binding lb ON lb.pgledger_account_id = pav.id
LEFT JOIN LATERAL (
  SELECT ref_gl_code, currency
  FROM billing.gl_mapping
  WHERE
    (
      (lb.ledger_role IS NOT NULL AND selector_type = 'ledger_role' AND selector = lb.ledger_role)
      OR
      (lb.ledger_role IS NULL AND selector_type = 'system_account' AND selector = pav.name)
    )
    AND (currency IS NULL OR currency = pav.currency)
    AND state = 'active'
  ORDER BY currency NULLS LAST
  LIMIT 1
) gm ON true;
