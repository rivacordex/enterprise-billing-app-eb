ALTER TABLE "product"."product_offering" DROP CONSTRAINT "product_offering_last_edited_by_appuser_user_id_fk";
--> statement-breakpoint
ALTER TABLE "product"."product_offering" ADD CONSTRAINT "product_offering_last_edited_by_appuser_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_amount_check" CHECK (amount >= 0);