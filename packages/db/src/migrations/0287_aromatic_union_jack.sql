CREATE TABLE "workspace_write_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_key" text NOT NULL,
	"realm" text NOT NULL,
	"canonical_root" text NOT NULL,
	"device" text NOT NULL,
	"inode" text NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"launch_id" uuid,
	"launch_identity" jsonb,
	"stop_receipt" jsonb,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_write_owners_active_resource_idx" ON "workspace_write_owners" USING btree ("resource_key") WHERE "workspace_write_owners"."released_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_write_owners_realm_active_idx" ON "workspace_write_owners" USING btree ("realm","released_at");--> statement-breakpoint
CREATE INDEX "workspace_write_owners_company_run_idx" ON "workspace_write_owners" USING btree ("company_id","run_id");