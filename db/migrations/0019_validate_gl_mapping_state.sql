-- Validate the gl_mapping_state_check constraint added NOT VALID in 0018 in a
-- separate transaction so the ACCESS EXCLUSIVE lock from ADD CONSTRAINT is
-- released before this SHARE UPDATE EXCLUSIVE lock is acquired (same pattern
-- as 0016 validates the constraints from 0014).
ALTER TABLE "billing"."gl_mapping" VALIDATE CONSTRAINT "gl_mapping_state_check";
