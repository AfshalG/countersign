CREATE TABLE "api_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_generation_idx" ON "api_tokens" USING btree ("account","generation");