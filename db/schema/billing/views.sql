-- ac02-spec §2.4/§3.2 — the three composition views. Hand-appended to the
-- migration (not authored by drizzle-kit, which cannot express the
-- `billing.pgledger_*` joins from the module-table Drizzle schema). No
-- stored balances anywhere here (Module Inv. #2) — every balance/entry
-- figure is read live from ac01's `pgledger_accounts_view` /
-- `pgledger_entries_view`.

-- account_view (Q6/Q28, Module Inv. #10 n/a — this is the identity view).
-- UNION ALL of financial_account/billing_account, each projecting the TMF
-- base-Account columns plus a literal account_type discriminator, composing
-- relatedParty[] at read time from customer.party_role -> customer.organization.
CREATE VIEW billing.account_view AS
SELECT
  fa.financial_account_id AS account_id,
  'FinancialAccount' AS account_type,
  fa.name,
  fa.description,
  fa.state,
  fa.currency,
  fa.ref_party_role_id,
  jsonb_build_array(
    jsonb_build_object(
      'id', fa.ref_party_role_id,
      'role', 'customer',
      'name', o.name,
      '@referredType', 'Customer'
    )
  ) AS related_party
FROM billing.financial_account fa
JOIN customer.party_role pr ON pr.party_role_id = fa.ref_party_role_id
JOIN customer.organization o ON o.organization_id = pr.engaged_party
UNION ALL
SELECT
  ban.billing_account_id AS account_id,
  'BillingAccount' AS account_type,
  ban.name,
  ban.description,
  ban.state,
  ban.currency,
  ban.ref_party_role_id,
  jsonb_build_array(
    jsonb_build_object(
      'id', ban.ref_party_role_id,
      'role', 'customer',
      'name', o.name,
      '@referredType', 'Customer'
    )
  ) AS related_party
FROM billing.billing_account ban
JOIN customer.party_role pr ON pr.party_role_id = ban.ref_party_role_id
JOIN customer.organization o ON o.organization_id = pr.engaged_party;
--> statement-breakpoint

-- gl_resolution_view (Module Inv. #10 — total and unambiguous). Every
-- pgledger account resolves to at most one GL code: ban.*/fa.* accounts
-- resolve via their ledger_binding's ledger_role, sys.* accounts resolve by
-- matching the pgledger account name as a system_account selector. The
-- LATERAL + ORDER BY picks a currency-specific gl_mapping row over an
-- all-currencies (NULL currency) row for the same selector when both exist,
-- so resolution stays deterministic even though the table-level UNIQUE
-- constraint alone can't rule out that overlap. NULL gl_code = unmapped
-- (the health check counts these, V5).
CREATE VIEW billing.gl_resolution_view AS
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
  ORDER BY currency NULLS LAST
  LIMIT 1
) gm ON true;
--> statement-breakpoint

-- gl_journal_view (Module Inv. #10 — Σ debit = Σ credit per period,
-- asserted downstream at V6/ac13/ac14). Joins entries to their resolved GL
-- code and aggregates by gl_code + period (event_at, YYYY-MM): a positive
-- pgledger entry amount is a debit, negative is a credit (plan §1.3).
CREATE VIEW billing.gl_journal_view AS
SELECT
  grv.gl_code,
  ga.name,
  to_char(pev.event_at, 'YYYY-MM') AS period,
  sum(CASE WHEN pev.amount > 0 THEN pev.amount ELSE 0 END) AS debit,
  sum(CASE WHEN pev.amount < 0 THEN -pev.amount ELSE 0 END) AS credit
FROM billing.pgledger_entries_view pev
JOIN billing.gl_resolution_view grv ON grv.pgledger_account_id = pev.account_id
JOIN billing.gl_account ga ON ga.gl_code = grv.gl_code
GROUP BY grv.gl_code, ga.name, to_char(pev.event_at, 'YYYY-MM');
