CREATE TABLE "issue_watchdog_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watchdog_id" uuid NOT NULL,
	"source_fingerprint" text NOT NULL,
	"observed_fingerprint" text NOT NULL,
	"claimed_fingerprint" text,
	"attempt_number" integer NOT NULL,
	"watchdog_run_id" uuid,
	"disposition" text,
	"disposition_request_id" uuid,
	"disposition_request_digest" text,
	"action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" text,
	"verification_due_at" timestamp with time zone,
	"verification_outcome" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_watchdog_attempts_bound" CHECK ("issue_watchdog_attempts"."attempt_number" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "issue_watchdog_recovery_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watchdog_id" uuid NOT NULL,
	"watchdog_run_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"observed_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_watchdog_recovery_batches_status" CHECK ("issue_watchdog_recovery_batches"."status" in ('applied', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "issue_watchdog_recovery_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watchdog_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_reason" text,
	"accepted_wake_id" text,
	"settled_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"delivered_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_watchdog_recovery_outbox_status" CHECK ("issue_watchdog_recovery_outbox"."status" in ('pending', 'enqueued', 'published', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "configuration_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_disposition" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_claimed_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "verification_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "restoration_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "issue_watchdog_attempts" ADD CONSTRAINT "issue_watchdog_attempts_watchdog_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("watchdog_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdog_attempts" ADD CONSTRAINT "issue_watchdog_attempts_company_id_watchdog_id_issue_watchdogs_company_id_id_fk" FOREIGN KEY ("company_id","watchdog_id") REFERENCES "public"."issue_watchdogs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdog_recovery_batches" ADD CONSTRAINT "issue_watchdog_recovery_batches_watchdog_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("watchdog_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdog_recovery_batches" ADD CONSTRAINT "issue_watchdog_recovery_batches_company_id_watchdog_id_issue_watchdogs_company_id_id_fk" FOREIGN KEY ("company_id","watchdog_id") REFERENCES "public"."issue_watchdogs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdog_recovery_outbox" ADD CONSTRAINT "issue_watchdog_recovery_outbox_company_id_watchdog_id_issue_watchdogs_company_id_id_fk" FOREIGN KEY ("company_id","watchdog_id") REFERENCES "public"."issue_watchdogs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdog_recovery_outbox" ADD CONSTRAINT "issue_watchdog_recovery_outbox_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_watchdog_attempts_lineage_uq" ON "issue_watchdog_attempts" USING btree ("company_id","watchdog_id","source_fingerprint","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_watchdog_recovery_batches_run_uq" ON "issue_watchdog_recovery_batches" USING btree ("company_id","watchdog_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_watchdog_recovery_batches_request_uq" ON "issue_watchdog_recovery_batches" USING btree ("company_id","watchdog_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_watchdog_recovery_outbox_key_uq" ON "issue_watchdog_recovery_outbox" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "issue_watchdog_recovery_outbox_pending_idx" ON "issue_watchdog_recovery_outbox" USING btree ("company_id","delivered_at","created_at");--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_restoration_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("restoration_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_bounded_attempts" CHECK ("issue_watchdogs"."restoration_max_attempts" in (2,3) and "issue_watchdogs"."restoration_attempt_count" between 0 and "issue_watchdogs"."restoration_max_attempts");--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_disposition" CHECK ("issue_watchdogs"."restoration_disposition" is null or "issue_watchdogs"."restoration_disposition" in ('legitimate_stop', 'restoration_claimed', 'escalated'));
