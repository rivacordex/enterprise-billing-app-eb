-- bm13-spec §2 "Finalization latch" / architecture.md Inv. #4 [CRITICAL] /
-- code-standards §6.8 — "ref_inv_document_id NOT NULL is DB-guarded against
-- DELETE ... (trigger/constraint)". The service layer already never issues an
-- unconditional DELETE/UPDATE on a finalized `customer_bill` (rerun's trial
-- re-derivation is `DELETE ... WHERE ref_inv_document_id IS NULL`, bm05/bm08),
-- but until now nothing enforced this at the database level — a raw SQL
-- statement bypassing the repository layer could still mutate or delete a
-- posted bill. This trigger is the DB-level backstop the architecture doc
-- documents as already existing; it fires on every partition automatically
-- (row-level triggers on a partitioned parent apply to all partitions,
-- PostgreSQL 11+), including partitions pg_partman creates later.
CREATE OR REPLACE FUNCTION billing.customer_bill_finalization_guard()
  RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ref_inv_document_id IS NOT NULL THEN
      RAISE EXCEPTION
        'customer_bill % is finalized (ref_inv_document_id=%) and cannot be deleted',
        OLD.customer_bill_id, OLD.ref_inv_document_id
        USING ERRCODE = '23001';
    END IF;
    RETURN OLD;
  ELSE
    IF OLD.ref_inv_document_id IS NOT NULL THEN
      RAISE EXCEPTION
        'customer_bill % is finalized (ref_inv_document_id=%) and cannot be updated',
        OLD.customer_bill_id, OLD.ref_inv_document_id
        USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER customer_bill_finalization_guard
  BEFORE UPDATE OR DELETE ON billing.customer_bill
  FOR EACH ROW
  EXECUTE FUNCTION billing.customer_bill_finalization_guard();
