-- ac01-spec Module Inv. #3/#4 (code-standards §6.3): app_runtime holds no
-- table-level DML on the pgledger_* internals, only EXECUTE on the
-- create-account/create-transfer(s) wrapper functions (bootstrap-db-roles.sql).
-- That design only works if those functions run with the definer's
-- privileges rather than the caller's -- the vendored upstream functions are
-- plain SECURITY INVOKER, so app_runtime calls fail with "permission denied
-- for table pgledger_accounts". Each function already pins
-- `SET search_path = billing, pg_catalog` (set by the transform pipeline),
-- which is the standard mitigation for SECURITY DEFINER's search_path
-- hijack risk, so it's safe to flip here without touching the vendored
-- generated file (db/pgledger/README.md -- never hand-edit that output).
ALTER FUNCTION "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb)
  SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb)
  SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "billing"."pgledger_create_transfers"("billing"."transfer_request"[])
  SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
  SECURITY DEFINER;
