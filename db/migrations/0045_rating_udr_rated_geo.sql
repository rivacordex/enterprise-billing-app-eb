-- bm48 (udr_rated.state / .district) REVERSED 2026-10-27 — rating Phase J (rm33,
-- _change-rating-drop-udr-rated-geo-columns-plan.md D4/D5). The matched ratecard
-- cell's geo lives only in udr_resource (Inv 28). Rewritten in place for the
-- Phase J fresh-DB round only (no production exists; every environment is set
-- up from an empty database on this release): on a fresh database the columns
-- never existed, so this is a no-op. Any later column removal is a forward
-- migration (db/migrations/README.md rule 4). Rating-owned; no grant change.
ALTER TABLE "rating"."udr_rated" DROP COLUMN IF EXISTS "state", DROP COLUMN IF EXISTS "district";
