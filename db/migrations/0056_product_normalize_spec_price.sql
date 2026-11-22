-- pm70 (Part 6 — Normalize Spec Characteristics & Price Components).
-- Plan §2.2–§2.7, §3, §4 option B; prodmgmt-architecture §3.1–§3.6,
-- Inv. #61–#73; prodmgmt-code-standards §6.33–§6.44.
--
-- Owner decisions (G-N1, 2026-11-19): Q1 subtype tables + view; Q2 this forward
-- migration with a self-verifying backfill; Q3 money numeric(18,6), quantity
-- numeric(20,6); Q4 keep display_order. G-N2 (Inv. #38 reversed:
-- product_offering_price.price_type returns, TMF vocabulary, FK-constrained)
-- recorded 2026-11-19. G-N6a (app_runtime REVOKE on the reference tables) is in
-- bootstrap-db-roles.sql, not here.
--
-- The storage shape of the whole update, in seven steps, each a precondition of
-- the next (code-standards §6.40):
--   1. reference tables, created and seeded (4 + 5 rows);
--   2. the five child tables, with constraints but no triggers;
--   3. header: price_type (nullable for now) + the (id, component_type) unique
--      the subtype FKs target — physically added BEFORE step 2's tables, since
--      their composite FKs reference it;
--   4. backfill, with the header's DRAFT guard disabled;
--   5. verify in SQL — abort on the first mismatch, before anything is dropped;
--   6. constraints, deferred completeness triggers, DRAFT-guard extension;
--   7. lane-key swap, drops, then the view.
--
-- ONE FILE, ONE TRANSACTION. Drizzle's postgres-js migrator runs every pending
-- file inside one transaction, so the backfill and the drops commit together or
-- not at all: a header written between "backfill" and "drop" cannot exist
-- (Inv. #71). Never split the drops into a second migration (workflow §4.7).
--
-- 0006, 0040 and 0049 are NOT reopened; the DRAFT guard is extended by
-- CREATE OR REPLACE here (0040 stays byte-identical).
--
-- SAME RELEASE (Inv. #72): the readers — bill_run_processing.template.yml, its
-- local-dev/ copy and rp.py (pm74), and the reporting worker (pm74b) — read the
-- dropped column and deploy in the same release as this file.
--
-- BOOTSTRAP RE-RUN: the role bootstraps grant on the view this file creates.
-- Every environment that already ran them must re-run `npm run
-- db:bootstrap-roles`, `npm run db:bootstrap-billrun-roles` and `npm run
-- db:bootstrap-rating-roles` after this migration (all three are idempotent). A
-- fresh `db:setup` needs nothing extra.

-- ── step 1 — reference tables, created and seeded ───────────────────────────
-- System data (Inv. #64): exactly four types and five (type, priceType) pairs.
-- pla_spec_id is NULL for flat_fee AND usage_rate — usage_rate's is derived from
-- rate_card_lookup IS NOT NULL, never stored (Inv. #65). apply_order is PC12
-- (stage then class) made explicit; capacity_commitment strictly before
-- capacity_motivation (Inv. #37).
CREATE TABLE "product"."price_component_type" (
	"component_type" text NOT NULL,
	"applies_at" text NOT NULL,
	"basis" text NOT NULL,
	"pla_spec_id" text,
	"apply_order" integer NOT NULL,
	CONSTRAINT "price_component_type_pk" PRIMARY KEY ("component_type"),
	CONSTRAINT "price_component_type_applies_at_check" CHECK (applies_at IN ('rating', 'billing', 'post_aggregation')),
	CONSTRAINT "price_component_type_basis_check" CHECK (basis IN ('quantity', 'flat'))
);
--> statement-breakpoint
INSERT INTO "product"."price_component_type" ("component_type", "applies_at", "basis", "pla_spec_id", "apply_order") VALUES
	('usage_rate', 'rating', 'quantity', NULL, 10),
	('flat_fee', 'billing', 'flat', NULL, 20),
	('capacity_commitment', 'post_aggregation', 'quantity', 'PLA_CAPACITY_COMMITMENT', 30),
	('capacity_motivation', 'post_aggregation', 'quantity', 'PLA_CAPACITY_MOTIVATION', 40);
--> statement-breakpoint
CREATE TABLE "product"."price_component_price_type" (
	"component_type" text NOT NULL,
	"price_type" text NOT NULL,
	CONSTRAINT "price_component_price_type_pk" PRIMARY KEY ("component_type", "price_type"),
	CONSTRAINT "price_component_price_type_type_fk" FOREIGN KEY ("component_type") REFERENCES "product"."price_component_type" ("component_type")
);
--> statement-breakpoint
INSERT INTO "product"."price_component_price_type" ("component_type", "price_type") VALUES
	('usage_rate', 'usage'),
	('flat_fee', 'recurring'),
	('flat_fee', 'oneTime'),
	('capacity_commitment', 'commitment'),
	('capacity_motivation', 'discount');
--> statement-breakpoint

-- ── step 3 — header: price_type (nullable until the backfill) + pinning target ─
-- Physically ahead of step 2: the subtype tables' composite FKs reference this
-- unique. NOT NULL and the pair FK come in step 6, after the backfill.
ALTER TABLE "product"."product_offering_price" ADD COLUMN "price_type" text;
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_id_type_unique" UNIQUE ("product_offering_price_id", "component_type");
--> statement-breakpoint

-- ── step 2 — the five child tables (constraints, no triggers yet) ─────────────
-- Characteristics: one row per name/value; natural PK, no surrogate id;
-- display_order 1…n per spec (Inv. #66). char_name <> '' mirrors the Zod
-- schema's min(1).
CREATE TABLE "product"."product_spec_characteristic" (
	"product_spec_id" text NOT NULL,
	"char_name" text NOT NULL,
	"char_value" text NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "product_spec_characteristic_pk" PRIMARY KEY ("product_spec_id", "char_name"),
	CONSTRAINT "product_spec_characteristic_spec_fk" FOREIGN KEY ("product_spec_id") REFERENCES "product"."product_specifications" ("product_spec_id") ON DELETE CASCADE,
	CONSTRAINT "product_spec_characteristic_order_unique" UNIQUE ("product_spec_id", "display_order"),
	CONSTRAINT "product_spec_characteristic_name_check" CHECK (char_name <> '')
);
--> statement-breakpoint
-- The type-pinning pattern (code-standards §6.36, Inv. #62): a pinned
-- component_type column plus a composite FK to the header's (id, component_type)
-- unique makes a subtype row for a header of another type unrepresentable. The
-- FK is NO ACTION on update, so a header's component_type cannot change while a
-- subtype row references it (Inv. #70). Constraint names are hand-written
-- (§6.39): Drizzle's derived FK name would exceed 63 bytes.
CREATE TABLE "product"."pop_usage_rate" (
	"product_offering_price_id" text NOT NULL,
	"component_type" text DEFAULT 'usage_rate' NOT NULL,
	"rate_per_unit" numeric(18, 6) NOT NULL,
	"rate_card_lookup" text,
	CONSTRAINT "pop_usage_rate_pkey" PRIMARY KEY ("product_offering_price_id"),
	CONSTRAINT "pop_usage_rate_header_fk" FOREIGN KEY ("product_offering_price_id", "component_type") REFERENCES "product"."product_offering_price" ("product_offering_price_id", "component_type") ON DELETE CASCADE,
	CONSTRAINT "pop_usage_rate_type_check" CHECK (component_type = 'usage_rate'),
	CONSTRAINT "pop_usage_rate_rate_check" CHECK (rate_per_unit >= 0),
	CONSTRAINT "pop_usage_rate_lookup_check" CHECK (rate_card_lookup IS NULL OR btrim(rate_card_lookup) <> '')
);
--> statement-breakpoint
CREATE TABLE "product"."pop_flat_fee" (
	"product_offering_price_id" text NOT NULL,
	"component_type" text DEFAULT 'flat_fee' NOT NULL,
	"amount" numeric(18, 6) NOT NULL,
	CONSTRAINT "pop_flat_fee_pkey" PRIMARY KEY ("product_offering_price_id"),
	CONSTRAINT "pop_flat_fee_header_fk" FOREIGN KEY ("product_offering_price_id", "component_type") REFERENCES "product"."product_offering_price" ("product_offering_price_id", "component_type") ON DELETE CASCADE,
	CONSTRAINT "pop_flat_fee_type_check" CHECK (component_type = 'flat_fee'),
	CONSTRAINT "pop_flat_fee_amount_check" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "product"."pop_capacity_commitment" (
	"product_offering_price_id" text NOT NULL,
	"component_type" text DEFAULT 'capacity_commitment' NOT NULL,
	"committed_quantity" numeric(20, 6) NOT NULL,
	CONSTRAINT "pop_capacity_commitment_pkey" PRIMARY KEY ("product_offering_price_id"),
	CONSTRAINT "pop_capacity_commitment_header_fk" FOREIGN KEY ("product_offering_price_id", "component_type") REFERENCES "product"."product_offering_price" ("product_offering_price_id", "component_type") ON DELETE CASCADE,
	CONSTRAINT "pop_capacity_commitment_type_check" CHECK (component_type = 'capacity_commitment'),
	CONSTRAINT "pop_capacity_commitment_quantity_check" CHECK (committed_quantity > 0)
);
--> statement-breakpoint
-- One row per band. The PK rejects a duplicate threshold; "strictly ascending"
-- is ORDER BY above_quantity — no step_no to keep in sync.
CREATE TABLE "product"."pop_motivation_step" (
	"product_offering_price_id" text NOT NULL,
	"component_type" text DEFAULT 'capacity_motivation' NOT NULL,
	"above_quantity" numeric(20, 6) NOT NULL,
	"rate_per_unit" numeric(18, 6) NOT NULL,
	CONSTRAINT "pop_motivation_step_pk" PRIMARY KEY ("product_offering_price_id", "above_quantity"),
	CONSTRAINT "pop_motivation_step_header_fk" FOREIGN KEY ("product_offering_price_id", "component_type") REFERENCES "product"."product_offering_price" ("product_offering_price_id", "component_type") ON DELETE CASCADE,
	CONSTRAINT "pop_motivation_step_type_check" CHECK (component_type = 'capacity_motivation'),
	CONSTRAINT "pop_motivation_step_quantity_check" CHECK (above_quantity > 0),
	CONSTRAINT "pop_motivation_step_rate_check" CHECK (rate_per_unit >= 0)
);
--> statement-breakpoint

-- ── step 4 — backfill (header DRAFT guard disabled) ───────────────────────────
-- The backfill UPDATEs released headers' price_type, which the guard refuses
-- with 23514. app_migrate owns the table, so plain DISABLE TRIGGER works;
-- session_replication_role is not used. product_specifications_draft_guard is
-- not disabled: nothing below writes that table, and the new child tables have
-- no trigger yet. Set-based, no loops.
ALTER TABLE "product"."product_offering_price" DISABLE TRIGGER "product_offering_price_draft_guard";
--> statement-breakpoint
UPDATE "product"."product_offering_price"
   SET price_type = CASE component_type
     WHEN 'flat_fee' THEN price_component ->> 'priceType'
     WHEN 'usage_rate' THEN 'usage'
     WHEN 'capacity_commitment' THEN 'commitment'
     WHEN 'capacity_motivation' THEN 'discount'
   END;
--> statement-breakpoint
INSERT INTO "product"."pop_usage_rate" ("product_offering_price_id", "rate_per_unit", "rate_card_lookup")
SELECT product_offering_price_id,
       (price_component #>> '{params,ratePerUnit}')::numeric,
       price_component #>> '{params,rateCardLookUp}'
  FROM "product"."product_offering_price"
 WHERE component_type = 'usage_rate';
--> statement-breakpoint
INSERT INTO "product"."pop_flat_fee" ("product_offering_price_id", "amount")
SELECT product_offering_price_id,
       (price_component #>> '{params,amount}')::numeric
  FROM "product"."product_offering_price"
 WHERE component_type = 'flat_fee';
--> statement-breakpoint
INSERT INTO "product"."pop_capacity_commitment" ("product_offering_price_id", "committed_quantity")
SELECT product_offering_price_id,
       (price_component #>> '{params,committedQuantity}')::numeric
  FROM "product"."product_offering_price"
 WHERE component_type = 'capacity_commitment';
--> statement-breakpoint
INSERT INTO "product"."pop_motivation_step" ("product_offering_price_id", "above_quantity", "rate_per_unit")
SELECT p.product_offering_price_id,
       (s ->> 'aboveQuantity')::numeric,
       (s ->> 'ratePerUnit')::numeric
  FROM "product"."product_offering_price" p,
       jsonb_array_elements(p.price_component #> '{params,steps}') AS s
 WHERE p.component_type = 'capacity_motivation';
--> statement-breakpoint
-- THE ONE PLACE today's jsonb key order is frozen into display_order
-- (architecture §3.5, which calls it "alphabetical") — recorded, not hidden: a
-- backfilled specification reads back in the order it rendered in yesterday,
-- the only order anyone has ever seen. jsonb stores object keys SHORTER FIRST,
-- then bytewise — not strictly alphabetical ({"ZONE","BANDWIDTH"} is stored
-- ZONE first) — and jsonb_each_text yields that stored order, which is exactly
-- what Object.entries rendered. Never "fix" this to ORDER BY key. From pm72 on,
-- display_order is the author's entry order.
INSERT INTO "product"."product_spec_characteristic" ("product_spec_id", "char_name", "char_value", "display_order")
SELECT ps.product_spec_id, e.key, e.value, e.ordinality
  FROM "product"."product_specifications" ps,
       jsonb_each_text(ps.product_spec_characteristics) WITH ORDINALITY AS e(key, value, ordinality);
--> statement-breakpoint

-- ── step 5 — verify in SQL; abort on the first mismatch ───────────────────────
-- For every header, rebuild the envelope from the new rows and compare it, as
-- jsonb, to price_component. Nothing after this step has run and nothing before
-- it is committed, so a RAISE here aborts the whole migration with nothing
-- dropped (Inv. #71). Comparison rules:
--   * jsonb equality is key-order-independent.
--   * Money is compared normalized on both sides (trim_scale(...)::text): the
--     stored string may carry trailing zeros ("5500.00") that numeric cannot
--     keep, so this proves NUMERIC equality of money; textual round-trip is
--     pm71's concern.
--   * Quantities are JSON numbers on both sides; jsonb compares numerics by
--     value (1000 = 1000.000000).
--   * The constant fields (specVersion, appliesAt, basis, plaSpecId, boundTo,
--     priceType) are rebuilt from price_component_type, unit_of_measure,
--     price_type and rate_card_lookup IS NOT NULL — so a stored envelope whose
--     appliesAt disagrees with its type, or whose params carries a key the
--     schema does not know, MISMATCHES AND ABORTS. That is the correct outcome
--     (workflow §5.4): such a row is corruption the JSON CHECKs never caught.
--     Never loosen this comparison to get a migration through.
--   * Steps are rebuilt ORDER BY above_quantity; the original is strictly
--     ascending (pricing_steps_ok), so order agrees.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT q.product_offering_price_id, q.component_type, q.rebuilt, q.original
    INTO bad
    FROM (
      SELECT p.product_offering_price_id,
             p.component_type,
             jsonb_build_object(
               '@type', p.component_type,
               'specVersion', 1,
               'plaSpecId', COALESCE(ct.pla_spec_id, CASE WHEN ur.rate_card_lookup IS NOT NULL THEN 'PLA_USAGE_RATE' END),
               'priceType', p.price_type,
               'appliesAt', ct.applies_at,
               'basis', ct.basis,
               'boundTo', CASE WHEN p.component_type = 'flat_fee' THEN 'null'::jsonb
                               ELSE jsonb_build_object('unitOfMeasure', p.unit_of_measure) END,
               'params', CASE p.component_type
                 WHEN 'usage_rate' THEN jsonb_build_object(
                   'ratePerUnit', trim_scale(ur.rate_per_unit)::text,
                   'rateCardLookUp', ur.rate_card_lookup)
                 WHEN 'flat_fee' THEN jsonb_build_object(
                   'amount', trim_scale(ff.amount)::text)
                 WHEN 'capacity_commitment' THEN jsonb_build_object(
                   'committedQuantity', cc.committed_quantity)
                 WHEN 'capacity_motivation' THEN jsonb_build_object(
                   'steps', (SELECT jsonb_agg(jsonb_build_object(
                                      'aboveQuantity', s.above_quantity,
                                      'ratePerUnit', trim_scale(s.rate_per_unit)::text)
                                    ORDER BY s.above_quantity)
                               FROM "product"."pop_motivation_step" s
                              WHERE s.product_offering_price_id = p.product_offering_price_id))
               END
             ) AS rebuilt,
             CASE p.component_type
               WHEN 'usage_rate' THEN jsonb_set(p.price_component, '{params,ratePerUnit}',
                 to_jsonb(trim_scale((p.price_component #>> '{params,ratePerUnit}')::numeric)::text))
               WHEN 'flat_fee' THEN jsonb_set(p.price_component, '{params,amount}',
                 to_jsonb(trim_scale((p.price_component #>> '{params,amount}')::numeric)::text))
               WHEN 'capacity_motivation' THEN jsonb_set(p.price_component, '{params,steps}',
                 (SELECT jsonb_agg(e.step || jsonb_build_object(
                                     'ratePerUnit', trim_scale((e.step ->> 'ratePerUnit')::numeric)::text)
                                   ORDER BY e.ord)
                    FROM jsonb_array_elements(p.price_component #> '{params,steps}') WITH ORDINALITY AS e(step, ord)))
               ELSE p.price_component
             END AS original
        FROM "product"."product_offering_price" p
        LEFT JOIN "product"."price_component_type" ct ON ct.component_type = p.component_type
        LEFT JOIN "product"."pop_usage_rate" ur ON ur.product_offering_price_id = p.product_offering_price_id
        LEFT JOIN "product"."pop_flat_fee" ff ON ff.product_offering_price_id = p.product_offering_price_id
        LEFT JOIN "product"."pop_capacity_commitment" cc ON cc.product_offering_price_id = p.product_offering_price_id
    ) q
   WHERE q.rebuilt IS DISTINCT FROM q.original
   ORDER BY q.product_offering_price_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'product_normalize_backfill_mismatch: price % (%) — rebuilt % <> stored (money-normalized) %',
      bad.product_offering_price_id, bad.component_type, bad.rebuilt, bad.original
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
--> statement-breakpoint
-- For every specification, the rows rebuilt into an object ('{}' when there are
-- none) must equal the stored jsonb. A non-string value (jsonb_each_text turned
-- 5 into "5") mismatches and aborts, as it should: characteristics are strings.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT ps.product_spec_id, ps.product_spec_characteristics AS original,
         COALESCE((SELECT jsonb_object_agg(c.char_name, c.char_value)
                     FROM "product"."product_spec_characteristic" c
                    WHERE c.product_spec_id = ps.product_spec_id), '{}'::jsonb) AS rebuilt
    INTO bad
    FROM "product"."product_specifications" ps
   WHERE COALESCE((SELECT jsonb_object_agg(c.char_name, c.char_value)
                     FROM "product"."product_spec_characteristic" c
                    WHERE c.product_spec_id = ps.product_spec_id), '{}'::jsonb)
         IS DISTINCT FROM ps.product_spec_characteristics
   ORDER BY ps.product_spec_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'product_normalize_backfill_mismatch: specification % — rebuilt % <> stored %',
      bad.product_spec_id, bad.rebuilt, bad.original
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
--> statement-breakpoint

-- ── step 6 — constraints, completeness triggers, DRAFT-guard extension ────────
ALTER TABLE "product"."product_offering_price" ALTER COLUMN "price_type" SET NOT NULL;
--> statement-breakpoint
-- Only seeded (component_type, price_type) pairs exist: replaces
-- component_type_check and envelope_type_check (§6.41).
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_price_type_fk" FOREIGN KEY ("component_type", "price_type") REFERENCES "product"."price_component_price_type" ("component_type", "price_type");
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ENABLE TRIGGER "product_offering_price_draft_guard";
--> statement-breakpoint
-- Completeness (Inv. #63, §6.37): every committed header has its subtype row,
-- and a capacity_motivation header at least one step. A CHECK cannot do this —
-- a CHECK sees one row, and completeness is a fact about two tables. So: one
-- function, five CONSTRAINT TRIGGERs, all DEFERRABLE INITIALLY DEFERRED, so the
-- check runs at COMMIT and a header may be committed together with the child
-- written after it in the same transaction. The order is HEADER FIRST: the
-- subtype FKs are NOT deferrable, so a child inserted before its header fails
-- 23503 at once. The platform's one prior DEFERRABLE object is a customer FK
-- (0009); these are its first deferred TRIGGERS.
--
-- The header id comes from NEW on the header (AFTER INSERT OR UPDATE) or from
-- OLD.product_offering_price_id on each child table (AFTER DELETE, and AFTER
-- UPDATE OF product_offering_price_id — a row or step moved to another header
-- leaves its OLD header to be re-checked, exactly as a delete would). If the
-- header no longer exists, pass: that is the discard cascade (offering → header
-- → subtype → steps), where the header is gone by the time a child's AFTER
-- DELETE is checked. Refused with 23514 — the DRAFT guard's code — so a write
-- that bypassed Zod surfaces as the same class of refusal.
--
-- Consequence: a DRAFT header whose component_type changes in place needs the
-- §1.50 order (delete subtype → update header → insert subtype) because the
-- composite FK is NO ACTION on update; this trigger makes the intermediate state
-- legal, the FK forbids a bare header UPDATE (Inv. #70).
CREATE FUNCTION "product"."price_header_is_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header_id text;
  header_type text;
  complete boolean;
  missing text;
BEGIN
  IF TG_TABLE_NAME = 'product_offering_price' THEN
    header_id := NEW.product_offering_price_id;
  ELSE
    header_id := OLD.product_offering_price_id;
  END IF;

  SELECT component_type INTO header_type
    FROM "product"."product_offering_price"
   WHERE product_offering_price_id = header_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF header_type = 'usage_rate' THEN
    missing := 'pop_usage_rate row';
    complete := EXISTS (SELECT 1 FROM "product"."pop_usage_rate" WHERE product_offering_price_id = header_id);
  ELSIF header_type = 'flat_fee' THEN
    missing := 'pop_flat_fee row';
    complete := EXISTS (SELECT 1 FROM "product"."pop_flat_fee" WHERE product_offering_price_id = header_id);
  ELSIF header_type = 'capacity_commitment' THEN
    missing := 'pop_capacity_commitment row';
    complete := EXISTS (SELECT 1 FROM "product"."pop_capacity_commitment" WHERE product_offering_price_id = header_id);
  ELSIF header_type = 'capacity_motivation' THEN
    missing := 'pop_motivation_step row';
    complete := EXISTS (SELECT 1 FROM "product"."pop_motivation_step" WHERE product_offering_price_id = header_id);
  ELSE
    missing := 'known component type';
    complete := false;
  END IF;

  IF NOT complete THEN
    RAISE EXCEPTION
      'product_price_header_incomplete: header % (%) has no %',
      header_id, header_type, missing
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "product_offering_price_complete_ct"
  AFTER INSERT OR UPDATE ON "product"."product_offering_price"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "product"."price_header_is_complete"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pop_usage_rate_complete_ct"
  AFTER UPDATE OF "product_offering_price_id" OR DELETE ON "product"."pop_usage_rate"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "product"."price_header_is_complete"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pop_flat_fee_complete_ct"
  AFTER UPDATE OF "product_offering_price_id" OR DELETE ON "product"."pop_flat_fee"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "product"."price_header_is_complete"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pop_capacity_commitment_complete_ct"
  AFTER UPDATE OF "product_offering_price_id" OR DELETE ON "product"."pop_capacity_commitment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "product"."price_header_is_complete"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pop_motivation_step_complete_ct"
  AFTER UPDATE OF "product_offering_price_id" OR DELETE ON "product"."pop_motivation_step"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "product"."price_header_is_complete"();
--> statement-breakpoint
-- The DRAFT guard (Inv. #69, §6.38), extended by CREATE OR REPLACE — 0040 is not
-- edited. The two 0040 branches (product_specifications, and the ELSE branch for
-- product_offering_price) are kept byte-for-byte; five tables are added. A
-- grandchild resolves its offering THROUGH ITS PARENT: product_spec_characteristic
-- via product_specifications.ref_product_offering_id, the four pop_* tables via
-- product_offering_price.product_offering_id. A grandchild whose parent is gone
-- resolves NULL and passes — that, plus the existing "offering not found → pass",
-- lets a discarded DRAFT cascade through three levels with no orphans. The
-- OLD-side / NEW-side re-parenting checks apply unchanged.
CREATE OR REPLACE FUNCTION "product"."child_write_requires_draft"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_id text;
  new_parent_id text;
  parent_status "product"."lifecycle_status";
BEGIN
  -- Resolve the affected parent offering id(s) from whichever column this child
  -- carries (product_specifications.ref_product_offering_id vs
  -- product_offering_price.product_offering_id). The reference is guarded by
  -- TG_TABLE_NAME so each field only appears in the branch for the table that
  -- has it: PL/pgSQL plans an expression on first execution of its OWN
  -- statement, so the untaken branch never resolves a non-existent column (a
  -- single CASE spanning both column names would be planned as one unit and
  -- fail with "record ... has no field ..." on both tables). A write can touch
  -- TWO parents: on a re-parenting UPDATE the row leaves OLD's parent and joins
  -- NEW's parent, and BOTH must be DRAFT — a direct-SQL re-parent must not strip
  -- a spec/price off a released version, which is exactly the non-application
  -- write this guard backstops (pm36 D2). OLD is read only when it exists (not
  -- INSERT); NEW only when it exists (not DELETE).
  --
  -- pm70 (0056): the grandchildren resolve the offering through their parent
  -- row; a parent that no longer exists (the discard cascade) leaves the id
  -- NULL, which passes.
  IF TG_TABLE_NAME = 'product_specifications' THEN
    IF TG_OP <> 'INSERT' THEN
      old_parent_id := OLD.ref_product_offering_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_parent_id := NEW.ref_product_offering_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'product_spec_characteristic' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT ref_product_offering_id INTO old_parent_id
        FROM "product"."product_specifications"
       WHERE product_spec_id = OLD.product_spec_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT ref_product_offering_id INTO new_parent_id
        FROM "product"."product_specifications"
       WHERE product_spec_id = NEW.product_spec_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('pop_usage_rate', 'pop_flat_fee', 'pop_capacity_commitment', 'pop_motivation_step') THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT product_offering_id INTO old_parent_id
        FROM "product"."product_offering_price"
       WHERE product_offering_price_id = OLD.product_offering_price_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT product_offering_id INTO new_parent_id
        FROM "product"."product_offering_price"
       WHERE product_offering_price_id = NEW.product_offering_price_id;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      old_parent_id := OLD.product_offering_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_parent_id := NEW.product_offering_id;
    END IF;
  END IF;

  -- The parent gaining or holding the row (INSERT / UPDATE) must be DRAFT.
  IF new_parent_id IS NOT NULL THEN
    SELECT lifecycle_status INTO parent_status
      FROM "product"."product_offering"
     WHERE product_offering_id = new_parent_id;
    IF FOUND AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'product_child_write_requires_draft: % on %.% rejected — offering % is %',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, new_parent_id, parent_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The parent losing the row (DELETE, or a re-parenting UPDATE) must be DRAFT
  -- too. Skipped when it is the same row already checked above, and allowed when
  -- the parent is gone: that is the ON DELETE cascade of a discarded DRAFT or
  -- TESTING version (pm44) — the parent row is deleted first, so this SELECT
  -- finds nothing and NOT FOUND passes it through.
  IF old_parent_id IS NOT NULL AND old_parent_id IS DISTINCT FROM new_parent_id THEN
    SELECT lifecycle_status INTO parent_status
      FROM "product"."product_offering"
     WHERE product_offering_id = old_parent_id;
    IF FOUND AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'product_child_write_requires_draft: % on %.% rejected — offering % is %',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, old_parent_id, parent_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "product_spec_characteristic_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_spec_characteristic"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "pop_usage_rate_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."pop_usage_rate"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "pop_flat_fee_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."pop_flat_fee"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "pop_capacity_commitment_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."pop_capacity_commitment"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "pop_motivation_step_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."pop_motivation_step"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint

-- ── step 7 — lane-key swap, drops, then the view ──────────────────────────────
-- The lane (Inv. #2) becomes plain columns: (product_offering_id,
-- component_type, unit_of_measure, price_type, start_date_time), NULLS NOT
-- DISTINCT. Equivalent to 0049's key: price_type is a constant per type for
-- every non-flat_fee type (adding nothing, exactly as 0049's CASE evaluated to
-- NULL for them), and for flat_fee it equals the envelope's priceType by the
-- backfill. Existing rows cannot violate it. C14: it STAYS a unique index under
-- the SAME NAME — services/product/insert-price.ts maps a 23505 on this name to
-- DUPLICATE_START, and keeping the object kind keeps the error's constraint
-- field identical. NULLS NOT DISTINCT keeps two identical NULL-unit flat fees at
-- one start colliding (G-F).
DROP INDEX "product"."product_offering_price_lane_start_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_price_lane_start_unique" ON "product"."product_offering_price" USING btree ("product_offering_id", "component_type", "unit_of_measure", "price_type", "start_date_time") NULLS NOT DISTINCT;
--> statement-breakpoint
-- The six JSON CHECKs leave by name (§6.41). component_type_check and
-- envelope_type_check are not re-added: the pair FK replaces both.
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_component_type_check";
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_envelope_type_check";
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_usage_rate_check";
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_flat_fee_check";
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_capacity_commitment_check";
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_capacity_motivation_check";
--> statement-breakpoint
DROP FUNCTION "product"."pricing_steps_ok"(jsonb);
--> statement-breakpoint
-- The four per-type unit/period CHECKs return under their existing names (the
-- schema-diff guardrail keys on names), JSON-free and keyed on price_type (D8).
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_usage_rate_check" CHECK (component_type <> 'usage_rate' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL));
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_flat_fee_check" CHECK (component_type <> 'flat_fee' OR (unit_of_measure IS NULL AND ((price_type = 'recurring' AND recurring_charge_period_length IS NOT NULL AND recurring_charge_period_type IS NOT NULL) OR (price_type = 'oneTime' AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL))));
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_capacity_commitment_check" CHECK (component_type <> 'capacity_commitment' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL));
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_capacity_motivation_check" CHECK (component_type <> 'capacity_motivation' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL));
--> statement-breakpoint
-- Dropped, not deprecated (§6.41): no view, alias, generated column or shim
-- reproduces either column for any reader.
ALTER TABLE "product"."product_offering_price" DROP COLUMN "price_component";
--> statement-breakpoint
ALTER TABLE "product"."product_specifications" DROP COLUMN "product_spec_characteristics";
--> statement-breakpoint
-- The one runtime read projection for non-application readers (Inv. #67, §6.43)
-- — created last, so it never references a column about to go. Column names and
-- the steps keys are a CROSS-MODULE CONTRACT with the bill-run flow and rp.py
-- (pm74) — renaming one breaks them at runtime, not at tsc. Three facts:
--   * p.* is expanded at creation: a future header column is NOT automatically
--     exposed — a view change is a hand-off, not a tidy-up.
--   * steps[].aboveQuantity and steps[].ratePerUnit are JSON NUMBERS (N-R4),
--     unlike the envelope's money strings.
--   * Owner-privileged (no security_invoker): a GRANT SELECT on the view is a
--     reader's entire surface; the pop_* and reference tables need no grant.
--     For billrun_runtime / rating_runtime (and reporting_runtime only if G-N7
--     grants it). No application reader and no Drizzle declaration (§1.62).
CREATE VIEW "product"."offering_price_v" AS
SELECT p.*,
       ct.applies_at,
       ct.basis,
       COALESCE(ct.pla_spec_id, CASE WHEN ur.rate_card_lookup IS NOT NULL THEN 'PLA_USAGE_RATE' END) AS pla_spec_id,
       ur.rate_per_unit,
       ur.rate_card_lookup,
       ff.amount,
       cc.committed_quantity,
       (SELECT jsonb_agg(jsonb_build_object('aboveQuantity', s.above_quantity, 'ratePerUnit', s.rate_per_unit) ORDER BY s.above_quantity)
          FROM "product"."pop_motivation_step" s
         WHERE s.product_offering_price_id = p.product_offering_price_id) AS steps
  FROM "product"."product_offering_price" p
  JOIN "product"."price_component_type" ct USING (component_type)
  LEFT JOIN "product"."pop_usage_rate" ur USING (product_offering_price_id)
  LEFT JOIN "product"."pop_flat_fee" ff USING (product_offering_price_id)
  LEFT JOIN "product"."pop_capacity_commitment" cc USING (product_offering_price_id);
--> statement-breakpoint
COMMENT ON VIEW "product"."offering_price_v" IS 'pm70 (0056): price header + reference + subtype columns for billrun_runtime / rating_runtime. Column names and steps keys (aboveQuantity, ratePerUnit — JSON numbers) are a cross-module contract (code-standards §6.43). p.* is expanded at creation. Owner-privileged by design. Not declared in Drizzle.';
