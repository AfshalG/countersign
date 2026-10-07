CREATE TABLE "agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"registry" text NOT NULL,
	"wallet" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "agent_address" text;