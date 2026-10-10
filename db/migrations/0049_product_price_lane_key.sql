-- pm46a: the price lane key adds the envelope priceType, closing the gap pm46
-- flagged against its own rekey. Every flat_fee row has unit_of_measure NULL,
-- so under (offering, component_type, unit_of_measure) a recurring and a
-- one-time flat fee shared one lane: a later one-time fee superseded the
-- recurring one, and the two could not start at the same instant. The lane is
-- now (offering, component_type, unit_of_measure, price_component->>'priceType').
-- For every other component type the envelope priceType is a fixed literal per
-- type (pm47), so only flat_fee splits (recurring / oneTime).
--
-- A UNIQUE constraint takes columns only, so the key becomes a unique INDEX.
-- NULLS NOT DISTINCT is kept (G-F): without it two identical recurring flat
-- fees (NULL unit) at one start would both insert. The new key is strictly
-- finer than the old one, so existing rows cannot violate it; no backfill.
-- Forward-only: 0006_product.sql stays locked. No grant change.
-- Locking: plain CREATE UNIQUE INDEX takes a SHARE lock on the (small) catalog
-- price table for the build, blocking price writes but not reads.
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_component_start_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_price_lane_start_unique" ON "product"."product_offering_price" USING btree ("product_offering_id", "component_type", "unit_of_measure", ("price_component" ->> 'priceType'), "start_date_time") NULLS NOT DISTINCT;
