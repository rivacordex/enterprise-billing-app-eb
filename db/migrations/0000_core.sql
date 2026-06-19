CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."account" (
	"account_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_id_check" CHECK (provider_id IN ('credential','microsoft'))
);
--> statement-breakpoint
CREATE TABLE "core"."appuser" (
	"user_id" text PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"user_email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"user_phonenum" text,
	"auth_method" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"force_password_change" boolean DEFAULT false NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_datetime" timestamp with time zone,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appuser_auth_method_check" CHECK (auth_method IN ('SSO','LOCAL')),
	CONSTRAINT "appuser_status_check" CHECK (status IN ('PENDING','ACTIVE','DISABLED','DELETED'))
);
--> statement-breakpoint
CREATE TABLE "core"."session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "core"."verification" (
	"verification_id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_datetime" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified_datetime" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."account" ADD CONSTRAINT "account_user_id_appuser_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."appuser"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."session" ADD CONSTRAINT "session_user_id_appuser_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."appuser"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_unique" ON "core"."account" USING btree ("provider_id","provider_account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "core"."account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appuser_email_unique" ON "core"."appuser" USING btree ("user_email") WHERE status <> 'DELETED';--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "core"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "core"."session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "core"."verification" USING btree ("identifier");