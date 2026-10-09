CREATE TABLE "advice_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"vault" text NOT NULL,
	"supplier_id" text NOT NULL,
	"advice" text NOT NULL,
	"reason" text,
	"invoice_number" text,
	"document_hash" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_banks" (
	"account" text NOT NULL,
	"supplier_id" text NOT NULL,
	"holder" text NOT NULL,
	"iban" text,
	"bic" text,
	"sort_code" text,
	"account_number" text,
	"routing_number" text,
	"owner_auth" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_banks_account_supplier_id_pk" PRIMARY KEY("account","supplier_id")
);
--> statement-breakpoint
CREATE INDEX "advice_checks_account_idx" ON "advice_checks" USING btree ("account","created_at");