CREATE TABLE "accounts" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text,
	"indexed_to" bigint NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"vault" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"order_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"order_hash" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"expiry" bigint NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"approved_block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"supplier_name" text NOT NULL,
	"website" text,
	"pay_to" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"expiry" bigint NOT NULL,
	"document_hash" text NOT NULL,
	"document" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "orders_account_idx" ON "orders" USING btree ("account","closed");