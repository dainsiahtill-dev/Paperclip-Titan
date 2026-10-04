import { z } from "zod";

const label = z.string().trim().min(1).max(256);
const workspaceSkillPath = z.string().trim().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || !part)
  && value.endsWith("/SKILL.md"), "Use a workspace-relative path ending in /SKILL.md");

/** Declarations compare and probe existing resources; they never change auth or install tools. */
export const agentReadinessRequirementsSchema = z.object({
  interpreters: z.array(z.enum(["python", "python3", "node", "git"])).max(4).optional(),
  skills: z.array(z.union([
    z.object({ workspacePath: workspaceSkillPath }).strict(),
    z.object({ key: label }).strict(),
  ])).max(32).optional(),
  mcp: z.array(z.object({
    connectionId: z.string().uuid(),
    requiredTools: z.array(label).min(1).max(64),
  }).strict()).max(16).optional(),
  expected: z.object({
    cwd: z.string().trim().min(1).max(4096),
    projectId: z.string().uuid(),
    target: z.enum(["local", "remote", "sandbox"]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    model: label,
    effort: label,
  }).partial().strict().optional(),
}).strict();

export type AgentReadinessRequirements = z.infer<typeof agentReadinessRequirementsSchema>;
export interface AgentPreflightCheck {
  code: string;
  status: "configured" | "resolved" | "readable" | "connected" | "unverified" | "error";
  message: string;
  /** Non-secret metadata only. Never raw command output, credentials or config. */
  detail?: string;
  fingerprint?: string;
}
export interface AgentPreflightProfile {
  source: "saved_agent" | "frozen_run";
  adapterType: string;
  cwd: string | null;
  projectId: string | null;
  target: string;
  sandbox: string | null;
  model: string | null;
  effort: string | null;
}
export interface AgentPreflightResult {
  status: "pass" | "unverified" | "fail";
  testedAt: string;
  profileDigest: string;
  profile: AgentPreflightProfile;
  checks: AgentPreflightCheck[];
  modelInvoked: false;
}
