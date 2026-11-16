CREATE TYPE "public"."job_board_provider" AS ENUM('greenhouse', 'lever', 'ashby');--> statement-breakpoint
CREATE TABLE "job_sources" (
	"source_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "job_board_provider" NOT NULL,
	"board_token" text NOT NULL,
	"company_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_job_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_sources_provider_board_token_key" UNIQUE("provider","board_token"),
	CONSTRAINT "job_sources_board_token_check" CHECK ("job_sources"."board_token" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')
);
