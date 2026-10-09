-- A payment can be decided twice (the checker's hold, then an owner's refusal): one record each
-- (Slice 18). The column's primary key, as Postgres names it, gives way to a two-column key.
ALTER TABLE "decision_records" DROP CONSTRAINT "decision_records_pkey";--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_request_id_decided_by_pk" PRIMARY KEY("request_id","decided_by");
