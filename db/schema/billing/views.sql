-- ac02: the three composition views over the module tables + ac01's
-- pgledger fork. Raw SQL (ac02-spec §2.4/§3.2) because Drizzle can't declare
-- a pgSchema view and all three join `billing.pgledger_*`, which sits
-- outside the Drizzle schema surface. Hand-appended to this unit's migration
-- (§3.3) after `drizzle-kit generate` authors the 10 table statements —
-- never re-typed, this file is what the migration copies verbatim.

-- account_view (Q6/Q28, module Inv. #10 n/a here — this is the account
-- correlation view, not GL): UNION ALL of financial_account/billing_account,
-- each projecting the shared TMF base-Account columns plus a literal
-- `account_type` discriminator. Composes `related_party` at read time from
-- `ref_party_role_id` -> customer.party_role -> customer.organization (the
-- party's name) — no stored balance column anywhere (Inv. #2).
CREATE VIEW billing.account_view AS
SELECT
    fa.financial_account_id AS account_id,
    'FinancialAccount' AS account_type,
    fa.name,
    fa.description,
    fa.state,
    fa.currency,
    fa.contact,
    jsonb_build_array(
        jsonb_build_object(
            'id', pr.party_role_id,
            'role', 'customer',
            'name', org.name,
            '@referredType', 'Customer'
        )
    ) AS related_party
FROM billing.financial_account fa
JOIN customer.party_role pr ON pr.party_role_id = fa.ref_party_role_id
JOIN customer.organization org ON org.organization_id = pr.engaged_party
UNION ALL
SELECT
    ban.billing_account_id AS account_id,
    'BillingAccount' AS account_type,
    ban.name,
    ban.description,
    ban.state,
    ban.currency,
    ban.contact,
    jsonb_build_array(
        jsonb_build_object(
            'id', pr.party_role_id,
            'role', 'customer',
            'name', org.name,
            '@referredType', 'Customer'
        )
    ) AS related_party
FROM billing.billing_account ban
JOIN customer.party_role pr ON pr.party_role_id = ban.ref_party_role_id
JOIN customer.organization org ON org.organization_id = pr.engaged_party;
--> statement-breakpoint

-- gl_resolution_view (module Inv. #10 — total and unambiguous): every
-- pgledger account -> its postable GL code. ban.*/fa.* accounts resolve via
-- `ledger_binding.ledger_role` + a `ledger_role` gl_mapping; sys.* accounts
-- resolve by matching the pgledger account's own name against a
-- `system_account` gl_mapping. Both branches are scalar subqueries (`LIMIT
-- 1`, most-specific-currency-first via `ORDER BY currency NULLS LAST`) so a
-- currency-specific mapping wins over a currency-agnostic (`currency IS
-- NULL`) one without ever fanning a pgledger account out to >1 row — the
-- (selector_type, selector, currency) UNIQUE on gl_mapping guarantees at most
-- one candidate per branch per currency tier. NULL gl_code means unmapped —
-- the health check (ac03/V5) counts these, this view never filters them out.
CREATE VIEW billing.gl_resolution_view AS
SELECT
    pav.id AS pgledger_account_id,
    COALESCE(
        (
            SELECT gm.ref_gl_code
            FROM billing.gl_mapping gm
            WHERE gm.selector_type = 'ledger_role'
              AND gm.selector = lb.ledger_role
              AND (gm.currency IS NULL OR gm.currency = pav.currency)
            ORDER BY gm.currency NULLS LAST
            LIMIT 1
        ),
        (
            SELECT gm.ref_gl_code
            FROM billing.gl_mapping gm
            WHERE gm.selector_type = 'system_account'
              AND gm.selector = pav.name
              AND (gm.currency IS NULL OR gm.currency = pav.currency)
            ORDER BY gm.currency NULLS LAST
            LIMIT 1
        )
    ) AS gl_code
FROM billing.pgledger_accounts_view pav
LEFT JOIN billing.ledger_binding lb ON lb.pgledger_account_id = pav.id;
--> statement-breakpoint

-- gl_journal_view (module Inv. #10 — Sigma debit = Sigma credit is asserted
-- downstream, V6/ac13/ac14): pgledger entries aggregated to GL code + period
-- (the document's `event_at`, via the transfer it belongs to). pgledger's
-- signed-amount convention (plan Sec.1.3): positive entry amount = debit,
-- negative = credit.
CREATE VIEW billing.gl_journal_view AS
SELECT
    ga.gl_code,
    ga.name,
    to_char(ev.event_at, 'YYYY-MM') AS period,
    sum(CASE WHEN ev.amount > 0 THEN ev.amount ELSE 0 END) AS debit,
    sum(CASE WHEN ev.amount < 0 THEN -ev.amount ELSE 0 END) AS credit
FROM billing.pgledger_entries_view ev
JOIN billing.gl_resolution_view gr ON gr.pgledger_account_id = ev.account_id
JOIN billing.gl_account ga ON ga.gl_code = gr.gl_code
GROUP BY ga.gl_code, ga.name, to_char(ev.event_at, 'YYYY-MM');
