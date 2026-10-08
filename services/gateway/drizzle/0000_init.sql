CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"account" text NOT NULL,
	"vault" text NOT NULL,
	"invoice_hash" text NOT NULL,
	"pay_to" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"deadline" bigint NOT NULL,
	"agent_sig" text NOT NULL,
	"document" jsonb,
	"status" text NOT NULL,
	"reason" text,
	"decided_by" text,
	"evidence" jsonb,
	"checker_sig" text,
	"owner_auth" jsonb,
	"relayer" text,
	"relayer_nonce" integer,
	"raw_tx" text,
	"tx_hash" text,
	"block_number" bigint,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"proposed_at" timestamp with time zone,
	"voted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relayer_nonces" (
	"address" text PRIMARY KEY NOT NULL,
	"next_nonce" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_request_id_payment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_request_idx" ON "payment_events" USING btree ("request_id","id");--> statement-breakpoint
CREATE INDEX "payment_requests_status_idx" ON "payment_requests" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "payment_requests_run_idx" ON "payment_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payment_requests_tx_idx" ON "payment_requests" USING btree ("tx_hash");