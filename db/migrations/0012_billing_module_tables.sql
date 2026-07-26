-- `billing` already exists from ac01's pgledger migration (0011) — drizzle-kit
-- generates an unconditional CREATE SCHEMA here since `billing` wasn't yet in
-- `schemaFilter` when 0011 ran; hand-corrected to IF NOT EXISTS so this
-- migration is idempotent against a freshly-migrated ac01 database.
CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint
CREATE SEQUENCE "billing"."billing_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."financial_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_cycle_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."gl_mapping_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_adj_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_crn_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_dbn_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_dep_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_line_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_pay_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."ledger_binding_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."billing_account" (
	"billing_account_id" text PRIMARY KEY DEFAULT 'BAN' || lpad(nextval('billing.billing_account_seq')::text, 6, '0') NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"ref_party_role_id" text NOT NULL,
	"contact" jsonb,
	"ref_financial_account_id" text NOT NULL,
	"currency" char(3) NOT NULL,
	"rating_type" text DEFAULT 'postpaid' NOT NULL,
	"payment_status" text DEFAULT 'paid' NOT NULL,
	"credit_limit_amount" numeric(18, 2),
	"ref_bill_cycle_id" text NOT NULL,
	"payment_due_days_override" integer,
	"default_payment_method_ref" text,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text NOT NULL,
	CONSTRAINT "billing_account_state_check" CHECK (state IN ('active','suspended','closed')),
	CONSTRAINT "billing_account_rating_type_check" CHECK (rating_type IN ('prepaid','postpaid')),
	CONSTRAINT "billing_account_payment_status_check" CHECK (payment_status IN ('paid','due','in_dispute'))
);
--> statement-breakpoint
CREATE TABLE "billing"."financial_account" (
	"financial_account_id" text PRIMARY KEY DEFAULT 'FIN' || lpad(nextval('billing.financial_account_seq')::text, 6, '0') NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"ref_party_role_id" text NOT NULL,
	"contact" jsonb,
	"currency" char(3) NOT NULL,
	"credit_limit_amount" numeric(18, 2),
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text NOT NULL,
	CONSTRAINT "financial_account_state_check" CHECK (state IN ('active','suspended','closed'))
);
--> statement-breakpoint
CREATE TABLE "billing"."bill_cycle" (
	"bill_cycle_id" text PRIMARY KEY DEFAULT 'BCY' || lpad(nextval('billing.bill_cycle_seq')::text, 6, '0') NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"cycle_day" integer DEFAULT 1 NOT NULL,
	"payment_due_days" integer DEFAULT 30 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text,
	CONSTRAINT "bill_cycle_name_unique" UNIQUE("name"),
	CONSTRAINT "bill_cycle_frequency_check" CHECK (frequency IN ('monthly','quarterly','annually')),
	CONSTRAINT "bill_cycle_cycle_day_check" CHECK (cycle_day BETWEEN 1 AND 28),
	CONSTRAINT "bill_cycle_state_check" CHECK (state IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "billing"."gl_account" (
	"gl_code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account_class" text NOT NULL,
	"normal_balance" text NOT NULL,
	"parent_gl_code" text,
	"is_postable" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text,
	CONSTRAINT "gl_account_account_class_check" CHECK (account_class IN ('asset','liability','equity','revenue','expense')),
	CONSTRAINT "gl_account_normal_balance_check" CHECK (normal_balance IN ('debit','credit')),
	CONSTRAINT "gl_account_state_check" CHECK (state IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "billing"."gl_mapping" (
	"gl_mapping_id" text PRIMARY KEY DEFAULT 'GLM' || lpad(nextval('billing.gl_mapping_seq')::text, 6, '0') NOT NULL,
	"selector_type" text NOT NULL,
	"selector" text NOT NULL,
	"currency" char(3),
	"ref_gl_code" text NOT NULL,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text,
	CONSTRAINT "gl_mapping_selector_type_selector_currency_unique" UNIQUE("selector_type","selector","currency"),
	CONSTRAINT "gl_mapping_selector_type_check" CHECK (selector_type IN ('ledger_role','system_account'))
);
--> statement-breakpoint
CREATE TABLE "billing"."reason_code" (
	"reason_code" text PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"doc_type" text NOT NULL,
	"posting_nature" text NOT NULL,
	"auto_post_limit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text,
	CONSTRAINT "reason_code_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ')),
	CONSTRAINT "reason_code_posting_nature_check" CHECK (posting_nature IN ('revenue','revenue_adj','write_off','rounding','cash','deposit_movement')),
	CONSTRAINT "reason_code_state_check" CHECK (state IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "billing"."document" (
	"document_id" text PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"ref_financial_account_id" text NOT NULL,
	"ref_billing_account_id" text,
	"reason_code" text NOT NULL,
	"currency" char(3) NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"payment_mode" text,
	"mode_ref" jsonb,
	"reference_date" timestamp with time zone DEFAULT now() NOT NULL,
	"reference_info" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"posted_at" timestamp with time zone,
	"reversal_of" text,
	"created_by" text NOT NULL,
	"approved_by" text,
	"metadata" jsonb,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text NOT NULL,
	CONSTRAINT "document_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ')),
	CONSTRAINT "document_state_check" CHECK (state IN ('draft','pending_approval','posted','reversed','cancelled')),
	CONSTRAINT "document_payment_mode_check" CHECK (payment_mode IN ('bank_transfer','cash','cheque'))
);
--> statement-breakpoint
CREATE TABLE "billing"."document_line" (
	"document_line_id" text PRIMARY KEY DEFAULT 'DLN' || lpad(nextval('billing.document_line_seq')::text, 8, '0') NOT NULL,
	"ref_document_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"line_kind" text NOT NULL,
	"ref_billing_account_id" text,
	"ref_settled_document_id" text,
	"amount" numeric(18, 2) NOT NULL,
	"pgledger_transfer_id" text,
	"reversed_by_line_id" text,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text NOT NULL,
	CONSTRAINT "document_line_pgledger_transfer_id_unique" UNIQUE("pgledger_transfer_id"),
	CONSTRAINT "document_line_ref_document_id_line_no_unique" UNIQUE("ref_document_id","line_no"),
	CONSTRAINT "document_line_line_kind_check" CHECK (line_kind IN ('capture','allocation','charge','release','refund')),
	CONSTRAINT "document_line_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."ledger_binding" (
	"ledger_binding_id" text PRIMARY KEY DEFAULT 'LBD' || lpad(nextval('billing.ledger_binding_seq')::text, 6, '0') NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"ledger_role" text NOT NULL,
	"pgledger_account_id" text NOT NULL,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text NOT NULL,
	CONSTRAINT "ledger_binding_pgledger_account_id_unique" UNIQUE("pgledger_account_id"),
	CONSTRAINT "ledger_binding_owner_type_owner_id_ledger_role_unique" UNIQUE("owner_type","owner_id","ledger_role"),
	CONSTRAINT "ledger_binding_owner_type_check" CHECK (owner_type IN ('billing_account','financial_account')),
	CONSTRAINT "ledger_binding_ledger_role_check" CHECK (ledger_role IN ('receivables','unapplied_cash','deposits'))
);
--> statement-breakpoint
CREATE TABLE "billing"."accounting_period" (
	"period" text NOT NULL,
	"currency" char(3) NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"last_modified" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_edited_by" text,
	CONSTRAINT "accounting_period_period_currency_pk" PRIMARY KEY("period","currency"),
	CONSTRAINT "accounting_period_state_check" CHECK (state IN ('open','closed'))
);
--> statement-breakpoint
ALTER TABLE "billing"."billing_account" ADD CONSTRAINT "billing_account_ref_party_role_id_party_role_party_role_id_fk" FOREIGN KEY ("ref_party_role_id") REFERENCES "customer"."party_role"("party_role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."billing_account" ADD CONSTRAINT "billing_account_ref_financial_account_id_financial_account_financial_account_id_fk" FOREIGN KEY ("ref_financial_account_id") REFERENCES "billing"."financial_account"("financial_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."billing_account" ADD CONSTRAINT "billing_account_ref_bill_cycle_id_bill_cycle_bill_cycle_id_fk" FOREIGN KEY ("ref_bill_cycle_id") REFERENCES "billing"."bill_cycle"("bill_cycle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."billing_account" ADD CONSTRAINT "billing_account_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."financial_account" ADD CONSTRAINT "financial_account_ref_party_role_id_party_role_party_role_id_fk" FOREIGN KEY ("ref_party_role_id") REFERENCES "customer"."party_role"("party_role_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."financial_account" ADD CONSTRAINT "financial_account_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_cycle" ADD CONSTRAINT "bill_cycle_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."gl_account" ADD CONSTRAINT "gl_account_parent_gl_code_gl_account_gl_code_fk" FOREIGN KEY ("parent_gl_code") REFERENCES "billing"."gl_account"("gl_code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."gl_account" ADD CONSTRAINT "gl_account_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."gl_mapping" ADD CONSTRAINT "gl_mapping_ref_gl_code_gl_account_gl_code_fk" FOREIGN KEY ("ref_gl_code") REFERENCES "billing"."gl_account"("gl_code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."gl_mapping" ADD CONSTRAINT "gl_mapping_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."reason_code" ADD CONSTRAINT "reason_code_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_ref_financial_account_id_financial_account_financial_account_id_fk" FOREIGN KEY ("ref_financial_account_id") REFERENCES "billing"."financial_account"("financial_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_reason_code_reason_code_reason_code_fk" FOREIGN KEY ("reason_code") REFERENCES "billing"."reason_code"("reason_code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_reversal_of_document_document_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "billing"."document"("document_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_created_by_appuser_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_approved_by_appuser_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_ref_document_id_document_document_id_fk" FOREIGN KEY ("ref_document_id") REFERENCES "billing"."document"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_ref_settled_document_id_document_document_id_fk" FOREIGN KEY ("ref_settled_document_id") REFERENCES "billing"."document"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_reversed_by_line_id_document_line_document_line_id_fk" FOREIGN KEY ("reversed_by_line_id") REFERENCES "billing"."document_line"("document_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_binding" ADD CONSTRAINT "ledger_binding_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."accounting_period" ADD CONSTRAINT "accounting_period_closed_by_appuser_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."accounting_period" ADD CONSTRAINT "accounting_period_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Composition views (db/schema/billing/views.sql) -- hand-appended, not
-- drizzle-kit-authored (ac02-spec §2.4/§3.2: drizzle-kit cannot express the
-- pgledger joins). Declared `.existing()` in db/schema/billing/views.ts so
-- drizzle-kit never tries to manage/diff them.
-- ---------------------------------------------------------------------------

-- account_view (Q6/Q28, Module Inv. #10 n/a -- this is the identity view).
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

-- gl_resolution_view (Module Inv. #10 -- total and unambiguous). Every
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

-- gl_journal_view (Module Inv. #10 -- Sum debit = Sum credit per period,
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