import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import { projectTaskPlan } from "../services/task-plan-projection.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const session = "f1111111-1111-4111-8111-111111111111";
const plan = "# Goal\nDeliver safe current work.\n# Current task\nChange one field.\n# Historical notes\n" + "irrelevant background detail without execution authority\n".repeat(1850)
  + "# Constraints\nMUST stay company scoped.\nNever send external business effects.\n# Reference appendix\nFULL_PLAN_REFERENCE_CANARY\n";
function context(turn: number, reason = "issue_commented") {
  const taskPlan = { documentId: "document-pinned", revisionId: "revision-pinned", revisionNumber: 1, body: plan };
  const input = { issue: { id: "issue-pinned", identifier: "PAP-PLAN", title: "Current task", description: "Current small task" }, taskPlan, wakeComment: { id: `comment-${turn}`, body: `LATEST_STEERING_${turn}: change only field ${turn}.` } };
  const projection = projectTaskPlan({ issueId: "issue-pinned", title: "Current task", revisionId: taskPlan.revisionId, body: plan, compact: true });
  return { paperclipTaskMarkdown: buildPaperclipTaskMarkdown(input), paperclipTaskMarkdownCompact: buildPaperclipTaskMarkdown({ ...input, includeDescription: false }), paperclipTaskMarkdownResumed: buildPaperclipTaskMarkdown({ ...input, taskPlanCompact: true }),
    paperclipWake: { reason, issue: { id: "issue-pinned", identifier: "PAP-PLAN", title: "Current task", description: null, descriptionTruncated: false, status: "in_progress" }, comments: [], commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 }, fallbackFetchNeeded: false },
    paperclipPlanMetrics: { sourceChars: plan.length, resumeChars: projection.projectedChars, omittedChars: projection.omittedChars },
  };
}
async function fixture(kind: "codex" | "claude") {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plan-adapter-")); directories.push(root);
  const binary = path.join(root, kind), capture = path.join(root, "prompts.jsonl"), home = path.join(root, "home"), instructions = path.join(root, "AGENTS.md");
  await mkdir(home); await writeFile(instructions, "FIXED_AGENT_CONSTRAINT: preserve permissions and saved work.\n");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args.includes('--version')) { console.log('2.1.251'); process.exit(0); }\nif (args.includes('--help')) { console.log('--append-system-prompt-file --mcp-config --strict-mcp-config --print --output-format --verbose'); process.exit(0); }\nlet stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { stdin += chunk; });\nprocess.stdin.on('end', () => {\n  fs.appendFileSync(process.env.PLAN_CAPTURE_FILE, JSON.stringify({args, stdin}) + '\\n');\n  const resume = args.includes('--resume') || args.includes('resume');\n  if (resume && process.env.PLAN_REJECT_RESUME === '1') { ${kind === "claude" ? `console.log(JSON.stringify({type:'result', subtype:'error_during_execution', is_error:true, result:'No conversation found with session id ${session}'}));` : ""} console.error('${kind === "claude" ? "No conversation found with session id" : "unknown thread"} ${session}'); process.exit(1); }\n  ${kind === "claude" ? `console.log(JSON.stringify({type:'system', subtype:'init', session_id:'${session}', model:'claude-sonnet-4-6'})); console.log(JSON.stringify({type:'result', subtype:'success', session_id:'${session}', result:'Synthetic hello', is_error:false}));` : `console.log(JSON.stringify({type:'thread.started', thread_id:'${session}'})); console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'Synthetic hello'}})); console.log(JSON.stringify({type:'turn.completed'}));`}\n});\n`);
  await chmod(binary, 0o700);
  const config = { engine: "cli", command: binary, cwd: root, model: kind === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol", instructionsFilePath: instructions, bootstrapPromptTemplate: "FRESH_BOOTSTRAP_CONSTRAINT", timeoutSec: 10, env: { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, PLAN_CAPTURE_FILE: capture } };
  return { root, capture, config };
}
it.each(["codex", "claude"] as const)("%s sends a complete pinned plan and bootstrap when stale resume becomes fresh", async kind => {
  const setup = await fixture(kind), execute = kind === "codex" ? codexExecute : claudeExecute;
  const agent = { id: "plan-agent", companyId: "plan-company", name: "Plan fixture", adapterType: `${kind}_local`, adapterConfig: {} };
  const metrics: Array<Record<string, number>> = [];
  const first = await execute({ runId: `plan-${kind}-first`, agent, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue:issue-pinned" }, config: setup.config, context: context(0), onLog: async () => {}, onMeta: async meta => { metrics.push(meta.promptMetrics as Record<string, number>); } });
  expect(first.exitCode).toBe(0); expect(first.sessionId).toBe(session);
  const resumed = await execute({ runId: `plan-${kind}-stale`, agent, runtime: { sessionId: first.sessionId!, sessionParams: first.sessionParams, sessionDisplayId: first.sessionId!, taskKey: "issue:issue-pinned" }, config: { ...setup.config, env: { ...setup.config.env, PLAN_REJECT_RESUME: "1" } }, context: context(1), onLog: async () => {}, onMeta: async meta => { metrics.push(meta.promptMetrics as Record<string, number>); } });
  expect(resumed.exitCode).toBe(0);
  const sent = (await readFile(setup.capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; stdin: string });
  expect(sent).toHaveLength(3);
  expect(sent[1]!.stdin).not.toContain("FULL_PLAN_REFERENCE_CANARY");
  expect(sent[2]!.stdin).toContain("FULL_PLAN_REFERENCE_CANARY");
  expect(sent[2]!.stdin).toContain("FRESH_BOOTSTRAP_CONSTRAINT");
  expect(sent[2]!.stdin).toContain("LATEST_STEERING_1");
  expect(sent[2]!.stdin).toContain("MUST stay company scoped.");
  expect(sent[2]!.stdin).toContain("/documents/plan/revisions/revision-pinned");
  expect(sent[2]!.args).toContain(setup.config.model);
  expect(metrics[0]!.planOmittedChars).toBe(0);
  expect(metrics[1]!.planOmittedChars).toBeGreaterThan(0);
  expect(metrics[2]!.planOmittedChars).toBe(0);
}, 30_000);

it.each(["codex", "claude"] as const)("%s measures ten actual CLI prompts without repeating stable100KB plan", async kind => {
  const setup = await fixture(kind), execute = kind === "codex" ? codexExecute : claudeExecute;
  const agent = { id: "plan-agent", companyId: "plan-company", name: "Plan fixture", adapterType: `${kind}_local`, adapterConfig: {} };
  let runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null; sessionDisplayId: string | null; taskKey: string } = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue:issue-pinned" };
  const metadata: Array<{ promptChars: number }> = [];
  for (let turn = 0; turn < 10; turn++) {
    const result = await execute({ runId: `plan-${kind}-${turn}`, agent, runtime, config: setup.config, context: context(turn, turn === 0 || turn === 4 ? "issue_assigned" : turn === 5 ? "context_compacted" : "issue_commented"), onLog: async () => {}, onMeta: async meta => { metadata.push(meta.promptMetrics as { promptChars: number }); } });
    expect(result.exitCode).toBe(0);
    runtime = { ...runtime, sessionId: result.sessionId ?? null, sessionDisplayId: result.sessionId ?? null, sessionParams: result.sessionParams ?? null };
  }
  const sent = (await readFile(setup.capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; stdin: string });
  expect(sent).toHaveLength(10); expect(Buffer.byteLength(plan)).toBeGreaterThan(100_000);
  expect(sent[0]!.stdin).toContain("FULL_PLAN_REFERENCE_CANARY");
  expect(sent.slice(1).every(call => !call.stdin.includes("FULL_PLAN_REFERENCE_CANARY"))).toBe(true);
  for (let turn = 0; turn < 10; turn++) {
    expect(sent[turn]!.stdin).toContain(`LATEST_STEERING_${turn}`);
    expect(sent[turn]!.stdin).toContain("MUST stay company scoped.");
    expect(sent[turn]!.stdin).toContain("Never send external business effects.");
    expect(sent[turn]!.stdin).toContain("/documents/plan/revisions/revision-pinned");
    expect(metadata[turn]!.promptChars).toBe(sent[turn]!.stdin.length);
  }
  const measurement = { syntheticCli: true, kind, sourcePlanBytes: Buffer.byteLength(plan), sourcePlanChars: plan.length, billedTokenSavings: null,
    turns: sent.map((call, turn) => ({ turn, promptBytes: Buffer.byteLength(call.stdin), promptChars: call.stdin.length, estimatedPromptTokens: Math.ceil(call.stdin.length / 4), planMode: turn === 0 ? "full" : "sections", resumed: call.args.includes("--resume") || call.args.includes("resume") })) };
  if (process.env.PAPERCLIP_PLAN_MEASUREMENT_OUTPUT_DIR) await writeFile(path.join(process.env.PAPERCLIP_PLAN_MEASUREMENT_OUTPUT_DIR, `2026-10-04-plan-${kind}-measurement.json`), JSON.stringify(measurement, null, 2) + "\n");
}, 30_000);

it.each(["codex", "claude"] as const)("%s sends fresh context when saved session configuration no longer matches", async kind => {
  const setup = await fixture(kind), execute = kind === "codex" ? codexExecute : claudeExecute;
  const agent = { id: "plan-agent", companyId: "plan-company", name: "Plan fixture", adapterType: `${kind}_local`, adapterConfig: {} };
  const first = await execute({ runId: "plan-config-first", agent, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue:issue-pinned" }, config: setup.config, context: context(0), onLog: async () => {} });
  const newCwd = path.join(setup.root, "new-workspace"); await mkdir(newCwd);
  const config = kind === "codex" ? { ...setup.config, cwd: newCwd } : { ...setup.config, model: "claude-opus-4-6" };
  const next = await execute({ runId: "plan-config-next", agent, runtime: { sessionId: first.sessionId ?? null, sessionParams: first.sessionParams ?? null, sessionDisplayId: first.sessionId ?? null, taskKey: "issue:issue-pinned" }, config, context: context(2), onLog: async () => {} });
  expect(next.exitCode).toBe(0);
  const sent = (await readFile(setup.capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; stdin: string });
  expect(sent).toHaveLength(2); expect(sent[1]!.args).not.toContain("resume"); expect(sent[1]!.args).not.toContain("--resume");
  expect(sent[1]!.stdin).toContain("FULL_PLAN_REFERENCE_CANARY"); expect(sent[1]!.stdin).toContain("LATEST_STEERING_2"); expect(sent[1]!.args).toContain(config.model);
}, 30_000);
