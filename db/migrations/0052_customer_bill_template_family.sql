-- bm67 (Invoice Template Phase 3) — the posted bill records its template family
-- (D23, Inv #41 amended). Written only by stampPosted, in the same UPDATE as
-- ref_inv_document_id, copied from the BAN's bill_run_account run stamp (bm65);
-- the finalization guard (0033) then freezes it like every other stamp.
-- Nullable plain key, NO FK — the posting-stamp rule of 0029/0046 D6 on the
-- partitioned customer_bill. Bills posted before bm67 keep NULL.
-- billrun_runtime's customer_bill INSERT/UPDATE grants are column lists that
-- never include stamps, so the column is app-only with no grant change.
ALTER TABLE "billing"."customer_bill" ADD COLUMN "ref_bill_template_family_id" text;
