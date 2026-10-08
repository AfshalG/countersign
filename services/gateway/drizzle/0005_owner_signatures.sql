CREATE TABLE "owner_signatures" (
	"digest" text NOT NULL,
	"qx" text NOT NULL,
	"qy" text NOT NULL,
	"account" text NOT NULL,
	"purpose" text NOT NULL,
	"auth" jsonb NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_signatures_digest_qx_qy_pk" PRIMARY KEY("digest","qx","qy")
);
--> statement-breakpoint
CREATE INDEX "owner_signatures_account_idx" ON "owner_signatures" USING btree ("account","purpose");