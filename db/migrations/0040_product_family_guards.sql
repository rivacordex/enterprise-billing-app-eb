CREATE UNIQUE INDEX "product_offering_one_active_per_family"
  ON "product"."product_offering" ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_one_open_per_family"
  ON "product"."product_offering" ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status IN ('DRAFT','TESTING');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "product"."child_write_requires_draft"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id text;
  parent_status "product"."lifecycle_status";
BEGIN
  -- Resolve the parent offering id from whichever column this child carries
  -- (product_specifications.ref_product_offering_id vs
  -- product_offering_price.product_offering_id). The reference is guarded by
  -- TG_TABLE_NAME so each field only appears in the branch for the table that
  -- has it: PL/pgSQL plans an expression on first execution of its OWN
  -- statement, so the untaken branch never resolves a non-existent column. A
  -- single CASE spanning both column names would be planned as one unit and
  -- fail with "record ... has no field ..." on both tables.
  IF TG_TABLE_NAME = 'product_specifications' THEN
    parent_id := CASE TG_OP
      WHEN 'DELETE' THEN OLD.ref_product_offering_id
      ELSE NEW.ref_product_offering_id
    END;
  ELSE
    parent_id := CASE TG_OP
      WHEN 'DELETE' THEN OLD.product_offering_id
      ELSE NEW.product_offering_id
    END;
  END IF;

  SELECT lifecycle_status INTO parent_status
    FROM "product"."product_offering"
   WHERE product_offering_id = parent_id;

  -- Parent gone: this is the ON DELETE cascade of a discarded version
  -- (pm44). Nothing to guard.
  IF NOT FOUND THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'product_child_write_requires_draft: % on %.% rejected — offering % is %',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, parent_id, parent_status
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "product_specifications_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_specifications"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "product_offering_price_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_offering_price"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
