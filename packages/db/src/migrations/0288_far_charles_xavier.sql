CREATE TABLE "legacy_workspace_epoch_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"realm" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"closure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_workspace_epoch_closures_active_realm_idx" ON "legacy_workspace_epoch_closures" USING btree ("realm") WHERE "legacy_workspace_epoch_closures"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "legacy_workspace_epoch_closures_realm_state_idx" ON "legacy_workspace_epoch_closures" USING btree ("realm","state");