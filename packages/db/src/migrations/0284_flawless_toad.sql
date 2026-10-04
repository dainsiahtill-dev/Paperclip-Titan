CREATE TABLE "issue_comment_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"target_run_id" uuid,
	"target_turn_id" text,
	"target_session_id" text,
	"session_generation" integer NOT NULL,
	"controller_id" text NOT NULL,
	"controller_boot_id" uuid,
	"comment_version" timestamp with time zone NOT NULL,
	"payload_sha256" text NOT NULL,
	"queue_revision" text NOT NULL,
	"correlation_id" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"activity_actor_type" text NOT NULL,
	"activity_actor_id" text NOT NULL,
	"activity_agent_api_key_id" uuid,
	"last_error_code" text,
	"dispatched_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_comment_deliveries_status_check" CHECK ("issue_comment_deliveries"."status" IN ('pending', 'dispatching', 'acknowledged', 'uncertain', 'superseded', 'cancelled')),
	CONSTRAINT "issue_comment_deliveries_mode_check" CHECK ("issue_comment_deliveries"."delivery_mode" IN ('acp', 'native'))
);
--> statement-breakpoint
ALTER TABLE "issue_comment_deliveries" ADD CONSTRAINT "issue_comment_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_deliveries" ADD CONSTRAINT "issue_comment_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_deliveries" ADD CONSTRAINT "issue_comment_deliveries_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_deliveries" ADD CONSTRAINT "issue_comment_deliveries_queue_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_deliveries" ADD CONSTRAINT "issue_comment_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_deliveries_correlation_uq" ON "issue_comment_deliveries" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "issue_comment_deliveries_run_comment_idx" ON "issue_comment_deliveries" USING btree ("company_id","target_run_id","comment_id");