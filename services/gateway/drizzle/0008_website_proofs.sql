CREATE TABLE "supplier_websites" (
	"account" text NOT NULL,
	"supplier_id" text NOT NULL,
	"url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_websites_account_supplier_id_pk" PRIMARY KEY("account","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "website_proofs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"listed" text,
	"signed_at" timestamp with time zone,
	"proof_hash" text,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "proof_status" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "proof_url" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "proof_source" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "proof_id" bigint;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "proof_error" text;--> statement-breakpoint
CREATE INDEX "website_proofs_url_idx" ON "website_proofs" USING btree ("url","created_at");