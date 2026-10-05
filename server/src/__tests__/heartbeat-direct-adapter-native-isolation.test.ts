import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  projects,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;
const DIRECT_ADAPTERS = [
  ["codex_local", "codex"],
  ["claude_local", "claude"],
  ["opencode_local", "opencode"],
] as const;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping direct-adapter native-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("direct adapter native-runner isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let privateRoot: string;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-direct-adapter-isolation-",
    );
    db = createDb(tempDb.connectionString);
    privateRoot = mkdtempSync(path.join(tmpdir(), "direct-adapter-private-"));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
    for (const [adapterType] of DIRECT_ADAPTERS) {
      registerServerAdapter({
        type: adapterType,
        supportsLocalAgentJwt: false,
        execute,
        testEnvironment: async () => ({
          adapterType,
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        }),
      });
    }
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runStatuses = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns);
    const pendingRuns = runStatuses.filter(
      (run) => run.status === "queued" || run.status === "running",
    );
    expect(pendingRuns).toEqual([]);
    vi.clearAllMocks();
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "native_run_finalizations",
        "status_decisions",
        "work_assessments",
        "native_run_results",
        "completion_contracts",
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const [adapterType] of DIRECT_ADAPTERS) {
      unregisterServerAdapter(adapterType);
    }
    await tempDb?.cleanup();
    rmSync(privateRoot, { recursive: true, force: true });
  });

  it.each(DIRECT_ADAPTERS)(
    "executes flag-off %s once without creating native records",
    async (adapterType, provider) => {
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const directProofJson =
        '{"schema":"direct-proof.v1","value":"byte-stable"}';
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: `test-${provider}`,
        summary: "Direct adapter summary.",
        resultJson: { directProofJson },
      });

      await db.insert(companies).values({
        id: companyId,
        name: "Direct compatibility",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      const cwd = path.join(privateRoot, agentId);
      mkdirSync(cwd, { recursive: true });
      await db.insert(projects).values({ id: companyId, companyId, name: "Private direct execution", executionWorkspacePolicy: { enabled: true, defaultMode: "adapter_default" } });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Direct ${provider}`,
        role: "engineer",
        status: "idle",
        adapterType,
        adapterConfig: { cwd },
        runtimeConfig: {},
        permissions: {},
      });

      const queued = await heartbeat.invoke(agentId, "on_demand", { projectId: companyId }, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).toHaveBeenCalledOnce();
      expect(finished).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        signal: null,
        runtimeMode: "legacy",
        nativePhase: null,
      });
      const persistedResult = finished?.resultJson as Record<
        string,
        unknown
      > | null;
      expect(persistedResult?.directProofJson).toBe(directProofJson);

      const nativeRows = await Promise.all([
        db.select().from(completionContracts),
        db.select().from(nativeRunResults),
        db.select().from(workAssessments),
        db.select().from(statusDecisions),
        db.select().from(nativeRunFinalizations),
      ]);
      expect(nativeRows.every((rows) => rows.length === 0)).toBe(true);
    },
  );
});
