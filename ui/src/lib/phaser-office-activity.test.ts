import { describe, expect, it } from "vitest";
import { deriveOfficeActivity, type OfficeActivityIssue } from "./phaser-office-activity";
import { deriveOfficePresence, type OfficeAgent, type OfficePresence } from "./pixel-office";

const agent: OfficeAgent = {
  id: "agent-a",
  companyId: "company-a",
  name: "Agent A",
  title: null,
  role: "general",
  reportsTo: null,
  status: "idle",
};

function issue(overrides: Partial<OfficeActivityIssue> = {}): OfficeActivityIssue {
  return {
    id: "issue-a",
    companyId: "company-a",
    assigneeAgentId: "agent-a",
    status: "in_progress",
    title: "Build the office",
    identifier: "OFF-1",
    ...overrides,
  };
}

describe("office activity summaries", () => {
  it.each([
    ["working", "waiting_for_access", "office.activity.working"],
    ["waiting", "working", "office.activity.waiting"],
    ["resting", "working", "office.activity.resting"],
    ["walking", "failed", "office.activity.walking"],
    ["away", "finishing", "office.activity.away"],
    ["error", "working", "office.activity.error"],
    ["applicant", "recovery_needed", "office.activity.applicant"],
    ["departed", "queued", "office.activity.departed"],
  ] as const)("keeps %s authoritative over an incompatible %s phase", (action, phase, summaryKey) => {
    expect(deriveOfficeActivity(agent, { action, screen: "off", phase }, [])).toEqual({
      action,
      phase,
      issueId: null,
      summaryKey,
    });
  });

  it.each([
    ["queued", "office.activity.queued"],
    ["preparing", "office.activity.preparing"],
    ["confirming", "office.activity.confirming"],
    ["reconnecting", "office.activity.reconnecting"],
    ["retry_scheduled", "office.activity.retry"],
    ["waiting_for_access", "office.activity.access"],
    ["waiting_for_answer", "office.activity.answer"],
  ] as const)("explains the waiting phase %s", (phase, summaryKey) => {
    const activity = deriveOfficeActivity(agent, { action: "waiting", screen: "waiting", phase }, []);
    expect(activity.summaryKey).toBe(summaryKey);
    expect(activity.action).toBe("waiting");
  });

  it("shows finishing only for confirmed working presence", () => {
    expect(deriveOfficeActivity(agent, { action: "working", screen: "working", phase: "finishing" }, []).summaryKey)
      .toBe("office.activity.finishing");
    expect(deriveOfficeActivity(agent, { action: "waiting", screen: "waiting", phase: "finishing" }, []).summaryKey)
      .toBe("office.activity.waiting");
  });

  it("distinguishes recovery from a failed execution", () => {
    expect(deriveOfficeActivity(agent, { action: "error", screen: "error", phase: "recovery_needed" }, []).summaryKey)
      .toBe("office.activity.recovery");
    expect(deriveOfficeActivity(agent, { action: "error", screen: "error", phase: "failed" }, []).summaryKey)
      .toBe("office.activity.error");
  });

  it("keeps a completed execution resting", () => {
    expect(deriveOfficeActivity(agent, { action: "resting", screen: "off", phase: "completed" }, []).summaryKey)
      .toBe("office.activity.resting");
  });
});

describe("office current activity tasks", () => {
  it.each(["working", "waiting", "error"] as const)("does not infer a %s task from assigned backlog or todo issues", (action) => {
    const activity = deriveOfficeActivity(agent, { action, screen: "off" }, [
      issue({ status: "backlog" }),
      issue({ id: "issue-b", status: "todo" }),
    ]);
    expect(activity.issueId).toBeNull();
    expect(activity.task).toBeUndefined();
  });

  it("does not use a run issue association when presence has no issueId", () => {
    const activity = deriveOfficeActivity(agent, {
      action: "waiting",
      screen: "waiting",
      run: { id: "run-a", agentId: agent.id, status: "queued", issueId: "issue-a" },
    }, [issue({ status: "backlog" })]);
    expect(activity.issueId).toBeNull();
    expect(activity.task).toBeUndefined();
  });

  it("normalizes an empty issueId without inferring a task", () => {
    const activity = deriveOfficeActivity(agent, { action: "working", screen: "working", issueId: "" }, [issue()]);
    expect(activity.issueId).toBeNull();
    expect(activity.task).toBeUndefined();
  });

  it.each([
    { companyId: "company-b" },
    { assigneeAgentId: "agent-b" },
    { assigneeAgentId: null },
    { id: "issue-b" },
  ])("rejects an issue with mismatched ownership or identity: %o", (overrides) => {
    const activity = deriveOfficeActivity(agent, {
      action: "working", screen: "working", issueId: "issue-a",
    }, [issue(overrides)]);
    expect(activity.issueId).toBe("issue-a");
    expect(activity.task).toBeUndefined();
  });

  it.each(["done", "cancelled"] as const)("does not describe a terminal %s issue as the current task", (status) => {
    expect(deriveOfficeActivity(agent, {
      action: "working", screen: "working", issueId: "issue-a",
    }, [issue({ status })]).task).toBeUndefined();
  });

  it.each(["resting", "walking", "away", "applicant", "departed"] as const)("does not attach a task to %s presence despite an issue association", (action) => {
    const activity = deriveOfficeActivity(agent, {
      action, screen: "off", phase: "working", issueId: "issue-a",
    }, [issue()]);
    expect(activity.issueId).toBe("issue-a");
    expect(activity.task).toBeUndefined();
  });

  it("describes actual working activity with a clean title and original identifier", () => {
    const activity = deriveOfficeActivity(agent, {
      action: "working", screen: "working", phase: "working", issueId: "issue-a",
    }, [issue({ title: "  Build\n  the\t office  " })]);
    expect(activity).toEqual({
      action: "working",
      phase: "working",
      issueId: "issue-a",
      summaryKey: "office.activity.working",
      task: { id: "issue-a", title: "Build the office", identifier: "OFF-1" },
    });
  });

  it.each(["waiting", "error"] as const)("retains an exact linked task for %s presence", (action) => {
    expect(deriveOfficeActivity(agent, {
      action, screen: "off", issueId: "issue-a",
    }, [issue({ identifier: null })]).task).toEqual({
      id: "issue-a", title: "Build the office", identifier: null,
    });
  });

  it("describes a real queued run linked to backlog as queued without claiming work started", () => {
    const presence = deriveOfficePresence(agent, [{
      id: "run-a",
      agentId: agent.id,
      status: "queued",
      issueId: "issue-a",
      execution: { phase: "working" },
    }]);
    expect(deriveOfficeActivity(agent, presence, [issue({ status: "backlog" })])).toEqual({
      action: "waiting",
      phase: "queued",
      issueId: "issue-a",
      summaryKey: "office.activity.queued",
      task: { id: "issue-a", title: "Build the office", identifier: "OFF-1" },
    });
  });

  it.each(["", " \n\t "])("ignores an empty task title %j", (title) => {
    const presence: OfficePresence = { action: "working", screen: "working", issueId: "issue-a" };
    expect(deriveOfficeActivity(agent, presence, [issue({ title })]).task).toBeUndefined();
  });
});
