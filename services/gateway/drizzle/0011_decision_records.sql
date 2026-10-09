CREATE TABLE "decision_records" (
	"request_id" text PRIMARY KEY NOT NULL,
	"vault" text NOT NULL,
	"decided_by" text NOT NULL,
	"decision" jsonb NOT NULL,
	"sigs" jsonb NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relayer_txs" ADD COLUMN "block_number" integer;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_request_id_payment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."payment_requests"("id") ON DELETE no action ON UPDATE no action;