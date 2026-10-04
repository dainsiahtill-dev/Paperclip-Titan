CREATE TABLE "issue_delivery_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_revision" integer NOT NULL,
	"contract_hash" text NOT NULL,
	"criterion_id" text NOT NULL,
	"criterion_digest" text NOT NULL,
	"work_product_id" uuid NOT NULL,
	"material_version" text NOT NULL,
	"content_digest" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"review_interaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_delivery_decisions_verdict" CHECK ("issue_delivery_decisions"."verdict" in ('accepted', 'rejected')),
	CONSTRAINT "issue_delivery_decisions_actor" CHECK ("issue_delivery_decisions"."actor_type" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "material_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "producer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "producer_actor_type" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "producer_actor_id" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "material_writer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "material_writer_actor_type" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "material_writer_actor_id" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "material_updated_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "deleted_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "deleted_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delivery_policy" jsonb;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_review_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("review_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_company_id_issue_id_contract_id_completion_contracts_company_id_issue_id_id_fk" FOREIGN KEY ("company_id","issue_id","contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_delivery_decisions" ADD CONSTRAINT "issue_delivery_decisions_company_id_work_product_id_issue_work_products_company_id_id_fk" FOREIGN KEY ("company_id","work_product_id") REFERENCES "public"."issue_work_products"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_delivery_decisions_request_uq" ON "issue_delivery_decisions" USING btree ("company_id","issue_id","request_id");--> statement-breakpoint
CREATE INDEX "issue_delivery_decisions_criterion_idx" ON "issue_delivery_decisions" USING btree ("company_id","issue_id","criterion_id","created_at");--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_producer_agent_id_agents_id_fk" FOREIGN KEY ("producer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_material_writer_agent_id_agents_id_fk" FOREIGN KEY ("material_writer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_material_updated_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("material_updated_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
