CREATE TABLE "demo_accounts" (
	"account" text PRIMARY KEY NOT NULL,
	"qx" text NOT NULL,
	"qy" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
