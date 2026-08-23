-- bm09-spec §Design/§Implementation §1 — Accounts-side INV & posting
-- enablement (cross-module). Additive only: a new per-type sequence and the
-- two doc_type CHECKs widened to admit 'INV'. Both CHECKs are dropped and
-- re-added NOT VALID (the 0014 alter idiom) so the ACCESS EXCLUSIVE lock
-- stays brief; 0032 validates them against existing rows in a separate
-- transaction.
CREATE SEQUENCE "billing"."document_inv_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "billing"."document" DROP CONSTRAINT "document_doc_type_check";--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ','INV')) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing"."reason_code" DROP CONSTRAINT "reason_code_doc_type_check";--> statement-breakpoint
ALTER TABLE "billing"."reason_code" ADD CONSTRAINT "reason_code_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ','INV')) NOT VALID;
