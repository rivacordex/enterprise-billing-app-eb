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
  IF TG_TABLE_NAME = 'product_specifications' THEN
    IF TG_OP <> 'INSERT' THEN
      old_parent_id := OLD.ref_product_offering_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_parent_id := NEW.ref_product_offering_id;
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
CREATE TRIGGER "product_specifications_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_specifications"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "product_offering_price_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_offering_price"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
