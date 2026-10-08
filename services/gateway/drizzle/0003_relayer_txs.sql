CREATE TABLE "relayer_txs" (
	"hash" text PRIMARY KEY NOT NULL,
	"relayer" text NOT NULL,
	"nonce" integer NOT NULL,
	"raw" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_at" timestamp with time zone,
	"status" text
);
