CREATE TABLE "event_consumers" (
	"consumer" varchar(160) PRIMARY KEY NOT NULL,
	"event_types" text[] NOT NULL,
	"materialized_through" timestamp with time zone DEFAULT '1970-01-01T00:00:00Z' NOT NULL,
	"last_drained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"event_id" uuid NOT NULL,
	"consumer" varchar(160) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_deliveries_event_id_consumer_pk" PRIMARY KEY("event_id","consumer"),
	CONSTRAINT "event_deliveries_status_check" CHECK ("event_deliveries"."status" IN ('pending', 'done', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"trace_id" varchar(100) NOT NULL,
	"correlation_id" varchar(100) NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_event_id_event_outbox_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_outbox"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_deliveries_claim_idx" ON "event_deliveries" USING btree ("consumer","next_attempt_at") WHERE "event_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "event_deliveries_dead_idx" ON "event_deliveries" USING btree ("consumer","updated_at") WHERE "event_deliveries"."status" = 'dead';--> statement-breakpoint
CREATE INDEX "event_outbox_created_idx" ON "event_outbox" USING btree ("created_at","event_id");--> statement-breakpoint
CREATE INDEX "event_outbox_type_created_idx" ON "event_outbox" USING btree ("event_type","created_at","event_id");--> statement-breakpoint
CREATE INDEX "event_outbox_trace_idx" ON "event_outbox" USING btree ("trace_id");