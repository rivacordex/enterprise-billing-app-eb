-- bm48 (Invoice Template, R9): persist ratecard geo onto rated usage at INSERT.
-- Rating-owned migration. Forward-only; no backfill. No grant change:
-- rating_runtime's table-level INSERT covers the columns; no role may UPDATE them.
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "state" text;
--> statement-breakpoint
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "district" text;
--> statement-breakpoint
COMMENT ON COLUMN "rating"."udr_rated"."state" IS 'Ratecard state label of the matched RAN cell, frozen at rating (bm48). NULL = rated before bm48 or card label blank.';
--> statement-breakpoint
COMMENT ON COLUMN "rating"."udr_rated"."district" IS 'Ratecard district label of the matched RAN cell, frozen at rating (bm48).';
