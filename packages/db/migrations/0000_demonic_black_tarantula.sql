CREATE TYPE "public"."application_mode" AS ENUM('auto', 'manual', 'review');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('draft', 'queued', 'submitting', 'submitted', 'acknowledged', 'interviewing', 'offer', 'rejected', 'withdrawn', 'failed');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('password', 'google', 'microsoft', 'saml');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'contract', 'internship', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."job_source" AS ENUM('manual', 'seed', 'greenhouse', 'lever', 'ashby', 'rss');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'student', 'recruiter', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('email', 'linkedin', 'sms', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('draft', 'scheduled', 'sent', 'delivered', 'replied', 'bounced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."organization_plan" AS ENUM('free', 'pro', 'campus', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."organization_type" AS ENUM('individual', 'university', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."remote_type" AS ENUM('onsite', 'hybrid', 'remote', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."resume_status" AS ENUM('pending', 'processing', 'parsed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'locked', 'succeeded', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"action" varchar(120) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"resource_id" varchar(200),
	"trace_id" varchar(100),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"organization_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" "organization_type" DEFAULT 'individual' NOT NULL,
	"plan" "organization_plan" DEFAULT 'free' NOT NULL,
	"slug" varchar(100),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"refresh_token_hash" varchar(64) NOT NULL,
	"user_agent" varchar(500),
	"ip_address" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_to_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"student_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"department" varchar(200),
	"graduation_year" integer,
	"current_status" varchar(80) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"email" varchar(320) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"auth_provider" "auth_provider" DEFAULT 'password' NOT NULL,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"resume_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_url" text NOT NULL,
	"original_filename" varchar(400) NOT NULL,
	"content_type" varchar(200) NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"status" "resume_status" DEFAULT 'pending' NOT NULL,
	"parsed_text" text,
	"parsed_profile" jsonb,
	"ats_score" real,
	"ats_report" jsonb,
	"embedding" vector(1536),
	"failure_reason" text,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"company_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(300) NOT NULL,
	"normalized_name" varchar(300) NOT NULL,
	"industry" varchar(200),
	"website" varchar(500),
	"domain" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_scores" (
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"score" real NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_version" varchar(80) NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_scores_job_id_user_id_pk" PRIMARY KEY("job_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"description" text,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" varchar(3),
	"salary_period" varchar(10),
	"location" varchar(300),
	"remote_type" "remote_type" DEFAULT 'unknown' NOT NULL,
	"employment_type" "employment_type" DEFAULT 'unknown' NOT NULL,
	"source" "job_source" NOT NULL,
	"external_id" varchar(400),
	"apply_url" text,
	"job_hash" varchar(64) NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1536),
	"spam_score" real DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status" NOT NULL,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"application_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"resume_id" uuid,
	"organization_id" uuid,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"mode" "application_mode" DEFAULT 'manual' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"cover_letter" text,
	"submitted_at" timestamp with time zone,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"full_name" varchar(200),
	"title" varchar(200),
	"email" varchar(320),
	"linkedin_url" varchar(500),
	"relevance_score" real,
	"embedding" vector(1536),
	"source" varchar(80) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid,
	"contact_id" uuid,
	"user_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"status" "message_status" DEFAULT 'draft' NOT NULL,
	"subject" varchar(400),
	"body" text NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"event_type" varchar(120) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace_id" varchar(100),
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_accounts" (
	"connector_account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"provider" varchar(80) NOT NULL,
	"external_account_id" varchar(300) NOT NULL,
	"secret_ref" varchar(400) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(40) DEFAULT 'active' NOT NULL,
	"consent_granted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(200) NOT NULL,
	"scope" varchar(120) NOT NULL,
	"user_id" uuid,
	"request_hash" varchar(64) NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" uuid NOT NULL,
	"consumer" varchar(160) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_event_id_consumer_pk" PRIMARY KEY("event_id","consumer")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" varchar(120) NOT NULL,
	"queue_status" "task_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(200),
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_id_resumes_resume_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("resume_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug") WHERE "organizations"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organizations_type_idx" ON "organizations" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "students_org_user_key" ON "students" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "students_grad_year_idx" ON "students" USING btree ("organization_id","graduation_year");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_profile_id_idx" ON "users" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resumes_user_content_hash_key" ON "resumes" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "resumes_user_created_idx" ON "resumes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "resumes_status_idx" ON "resumes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_normalized_name_key" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "companies_domain_idx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "companies_name_trgm_idx" ON "companies" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "job_scores_user_score_idx" ON "job_scores" USING btree ("user_id","score");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_job_hash_key" ON "jobs" USING btree ("job_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_external_id_key" ON "jobs" USING btree ("source","external_id") WHERE "jobs"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_company_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobs_active_posted_idx" ON "jobs" USING btree ("is_active","posted_at");--> statement-breakpoint
CREATE INDEX "jobs_remote_type_idx" ON "jobs" USING btree ("remote_type");--> statement-breakpoint
CREATE INDEX "jobs_title_trgm_idx" ON "jobs" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "application_events_app_created_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_idempotency_key" ON "applications" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_job_key" ON "applications" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_user_created_idx" ON "applications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_org_idx" ON "applications" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_company_email_key" ON "contacts" USING btree ("company_id","email");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_relevance_idx" ON "contacts" USING btree ("relevance_score");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_idempotency_key" ON "messages" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_status_scheduled_idx" ON "messages" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "messages_contact_idx" ON "messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "analytics_events_org_time_idx" ON "analytics_events" USING btree ("organization_id","timestamp");--> statement-breakpoint
CREATE INDEX "analytics_events_type_time_idx" ON "analytics_events" USING btree ("event_type","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_accounts_provider_external_key" ON "connector_accounts" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "connector_accounts_user_idx" ON "connector_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "connector_accounts_org_idx" ON "connector_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "tasks_claim_idx" ON "tasks" USING btree ("queue_status","available_at");--> statement-breakpoint
CREATE INDEX "tasks_type_idx" ON "tasks" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX "tasks_locked_idx" ON "tasks" USING btree ("locked_at");