import { describe, expect, it } from "vitest";
import { fetchOfficeSnapshot, selectOfficeTask, type OfficeTask } from "./pixel-office-snapshot";
import { officeEventNeedsRefresh, type OfficeAgent } from "./pixel-office";

const agent = (id: string, status: OfficeAgent["status"] = "idle", companyId = "a"): OfficeAgent => ({ id, companyId, status, name: id, role: "general", title: null, reportsTo: null });
const task = (id: string, assigneeAgentId: string, status: OfficeTask["status"] = "in_progress", companyId = "a"): OfficeTask => ({ id, assigneeAgentId, status, companyId, executionRunId: "run-" + id });

describe("office snapshot ownership", () => {
  it("shows a paused or error employee's active task before backlog work", () => {
    expect(selectOfficeTask([task("a-backlog", "error", "backlog"), task("z-active", "error")], "error")?.id).toBe("z-active");
  });
  it("retains paused and error employees' tasks and checks current error retries without fetching paused work", async () => {
    const fetched: string[] = [];
    const snapshot = await fetchOfficeSnapshot("a", {
      agents: async () => [agent("paused", "paused"), agent("error", "error"), agent("idle")],
      runs: async () => [],
      issues: async () => [task("p", "paused"), task("e", "error"), task("i", "idle")],
      execution: async id => { fetched.push(id); return null; },
    });
    expect(snapshot.issues.map(i => i.id)).toEqual(["p", "e", "i"]);
    expect(fetched).toEqual(["e", "i"]);
  });
  it("never mixes companies, closed tasks or reassigned run identities", async () => {
    const snapshot = await fetchOfficeSnapshot("a", {
      agents: async () => [agent("one"), agent("foreign", "idle", "b")],
      runs: async () => [{ id: "q", agentId: "one", issueId: "open", status: "queued" }, { id: "foreign-run", agentId: "foreign", status: "running" }],
      issues: async () => [task("open", "one"), task("closed", "one", "done"), task("foreign", "foreign", "in_progress", "b")],
      execution: async () => ({ runId: "run-open", agentId: "somebody-else", execution: { phase: "working" } }),
    });
    expect(snapshot.agents.map(a => a.id)).toEqual(["one"]);
    expect(snapshot.issues.map(i => i.id)).toEqual(["open"]);
    expect(snapshot.runs.map(r => [r.id, r.currentTask])).toEqual([["q", true]]);
    expect(snapshot.executions).toEqual([]);
  });
  it("does not accept a predecessor projection as a different current execution", async () => {
    const snapshot = await fetchOfficeSnapshot("a", {
      agents: async () => [agent("one")], runs: async () => [],
      issues: async () => [task("open", "one")],
      execution: async () => ({ runId: "old-run", agentId: "one", execution: { phase: "failed" } }),
    });
    expect(snapshot.executions).toEqual([]);
  });
});

describe("office live event cost", () => {
  it("ignores a stream of output and progress while preserving status and interaction updates", () => {
    for (let n = 0; n < 200; n++) {
      expect(officeEventNeedsRefresh({ type: "heartbeat.run.log" })).toBe(false);
      expect(officeEventNeedsRefresh({ type: "heartbeat.run.progress" })).toBe(false);
      expect(officeEventNeedsRefresh({ type: "heartbeat.run.event", payload: { eventType: "tool" } })).toBe(false);
    }
    expect(officeEventNeedsRefresh({ type: "heartbeat.run.status" })).toBe(true);
    expect(officeEventNeedsRefresh({ type: "agent.status" })).toBe(true);
    expect(officeEventNeedsRefresh({ type: "activity.logged", payload: { action: "issue.updated" } })).toBe(true);
    expect(officeEventNeedsRefresh({ type: "activity.logged", payload: { action: "issue.interaction.resolved" } })).toBe(true);
    expect(officeEventNeedsRefresh({ type: "activity.logged", payload: { action: "cost.created" } })).toBe(false);
  });
});
