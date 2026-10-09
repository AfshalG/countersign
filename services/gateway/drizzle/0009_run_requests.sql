CREATE TABLE "run_requests" (
	"run_id" text NOT NULL,
	"request_id" text NOT NULL,
	CONSTRAINT "run_requests_run_id_request_id_pk" PRIMARY KEY("run_id","request_id")
);
--> statement-breakpoint
CREATE INDEX "run_requests_request_idx" ON "run_requests" USING btree ("request_id");--> statement-breakpoint
-- Runs sent before Slice 16 list the requests they created.
INSERT INTO "run_requests" ("run_id", "request_id") SELECT "run_id", "id" FROM "payment_requests" WHERE "run_id" IS NOT NULL ON CONFLICT DO NOTHING;
