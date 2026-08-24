-- Validate the constraints added NOT VALID in 0031, in a separate transaction
-- so the ACCESS EXCLUSIVE lock from ADD CONSTRAINT is released before these
-- SHARE UPDATE EXCLUSIVE locks are acquired (mirrors 0014 -> 0016).
ALTER TABLE "billing"."document" VALIDATE CONSTRAINT "document_doc_type_check";--> statement-breakpoint
ALTER TABLE "billing"."reason_code" VALIDATE CONSTRAINT "reason_code_doc_type_check";
