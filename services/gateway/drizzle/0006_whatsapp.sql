CREATE TABLE "whatsapp_contacts" (
	"account" text NOT NULL,
	"wa_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_contacts_account_wa_id_pk" PRIMARY KEY("account","wa_id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_links" (
	"code" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"subject" text NOT NULL,
	"wa_id" text NOT NULL,
	"account" text NOT NULL,
	"kind" text NOT NULL,
	"via" text,
	"message_id" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_messages_subject_wa_id_pk" PRIMARY KEY("subject","wa_id")
);
--> statement-breakpoint
CREATE INDEX "whatsapp_contacts_wa_idx" ON "whatsapp_contacts" USING btree ("wa_id");--> statement-breakpoint
CREATE INDEX "whatsapp_links_account_idx" ON "whatsapp_links" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_id_idx" ON "whatsapp_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_recent_idx" ON "whatsapp_messages" USING btree ("wa_id","created_at");