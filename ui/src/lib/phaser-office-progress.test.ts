import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import type { OfficeAction, OfficePresence } from "./pixel-office";
import { OfficeProgressTracker, officeWorkRunIds, readOfficeProgressEvent, readOfficeRunOutput, visibleOfficeWorkOutput } from "./phaser-office-progress";

const now = Date.parse("2026-10-08T10:00:00Z"), duration = 12000;
const event = (payload: Record<string, unknown>, offset = 0): LiveEvent => ({ id: 1, companyId: "company", type: "heartbeat.run.progress", createdAt: new Date(now + offset).toISOString(), payload: { agentId: "agent", runId: "run", phase: "run_activity", ...payload } });
const setup = () => { const tracker = new OfficeProgressTracker(); tracker.reconcile("company", new Map([["agent", "run"]])); return tracker; };

describe("actual work output bubbles", () => {
  it("briefly displays a public work update and expires without a new event", () => {
    const tracker = setup();
    const output = readOfficeProgressEvent(event({ message: "我先检查登录逻辑，然后运行回归测试。" }));
    expect(output?.text).toBe("我先检查登录逻辑");
    expect(tracker.accept(output, now, duration)).toBe(true);
    expect(tracker.snapshot(now).get("agent")?.text).toBe("我先检查登录逻辑");
    expect(tracker.snapshot(now + duration).size).toBe(0);
  });
  it.each(["工作中", "休息中", "Waiting", "run_activity", "item delta", "session started"])("does not turn %s into a permanent output bubble", message => {
    expect(readOfficeProgressEvent(event({ message }))).toBeUndefined();
  });
  it("does not renew or replay the same output on polling or repeated progress events", () => {
    const tracker = setup();
    tracker.accept(readOfficeProgressEvent(event({ message: "开始运行测试" })), now, duration);
    expect(tracker.accept(readOfficeProgressEvent(event({ message: "开始运行测试" }, 11000)), now + 11000, duration)).toBe(false);
    expect(tracker.snapshot(now + 12000).size).toBe(0);
    expect(tracker.accept(readOfficeProgressEvent(event({ message: "开始运行测试" }, 13000)), now + 13000, duration)).toBe(false);
    expect(tracker.snapshot(now + 13000).size).toBe(0);
    expect(tracker.accept(readOfficeProgressEvent(event({ message: "已经定位到失败用例" }, 14000)), now + 14000, duration)).toBe(true);
  });
  it("rejects stale, future, foreign-company and wrong-run output", () => {
    const tracker = setup(), candidate = readOfficeProgressEvent(event({ message: "检查登录逻辑" }))!;
    for (const value of [{ ...candidate, at: now - duration }, { ...candidate, at: now + duration + 1 }, { ...candidate, companyId: "other" }, { ...candidate, runId: "old" }, { ...candidate, agentId: "other" }]) expect(tracker.accept(value, now, duration)).toBe(false);
    expect(tracker.snapshot(now).size).toBe(0);
  });
  it("does not replace newer live output with an older snapshot", () => {
    const tracker = setup();
    tracker.accept(readOfficeProgressEvent(event({ message: "开始运行回归测试" }, 3000)), now + 3000, duration);
    expect(tracker.accept(readOfficeProgressEvent(event({ message: "检查登录逻辑" })), now + 3000, duration)).toBe(false);
    expect(tracker.snapshot(now + 3000).get("agent")?.text).toBe("开始运行回归测试");
  });
  it("starts fresh for a new run and clears all output when changing company", () => {
    const tracker = setup();
    tracker.accept(readOfficeProgressEvent(event({ message: "开始运行测试" })), now, duration);
    tracker.reconcile("company", new Map([["agent", "new-run"]]));
    expect(tracker.snapshot(now).size).toBe(0);
    expect(tracker.accept(readOfficeProgressEvent(event({ runId: "new-run", message: "开始运行测试" })), now, duration)).toBe(true);
    tracker.reconcile("other-company", new Map());
    expect(tracker.snapshot(now).size).toBe(0);
  });
  it("summarizes actual tool names without including raw arguments or guessing a thread is a file read", () => {
    expect(readOfficeProgressEvent(event({ currentToolName: "exec_command", message: "Using exec_command", payload: { command: "private argument" } }))?.toolKey).toBe("office.output.command");
    expect(readOfficeProgressEvent(event({ currentToolName: "ReadFile", message: "Using ReadFile" }))?.toolKey).toBe("office.output.read");
    expect(readOfficeProgressEvent(event({ currentToolName: "send_message_to_thread", message: "Using send_message_to_thread" }))?.toolKey).toBe("office.output.tool");
  });
  it("does not expose reasoning, raw stderr or code blocks", () => {
    const source = { ...event({ message: "hidden", eventType: "assistant.reasoning" }), type: "heartbeat.run.event" as const };
    expect(readOfficeProgressEvent(source)).toBeUndefined();
    expect(readOfficeProgressEvent({ ...source, payload: { ...source.payload, eventType: "item.delta", payload: { item: { channel: "analysis" } } } })).toBeUndefined();
    expect(readOfficeProgressEvent(event({ stream: "stderr", message: "raw stack trace" }))).toBeUndefined();
    expect(readOfficeProgressEvent(event({ message: "```js\nconst x = 1;\n```" }))).toBeUndefined();
  });
  it("joins public streaming fragments and ignores their mirrored status updates", () => {
    const tracker = setup();
    const delta = (text: string, offset: number, id = "message-a") => readOfficeProgressEvent({ ...event({ eventType: "assistant.text_delta", lastAssistantSnippet: text, payload: { messageId: id } }, offset), type: "heartbeat.run.event" });
    expect(tracker.accept(delta("我", 0), now, duration)).toBe(false);
    tracker.accept(delta("先检查", 100), now + 100, duration);
    tracker.accept(delta("登录逻辑", 200), now + 200, duration);
    expect(tracker.snapshot(now + 200).get("agent")?.text).toBe("我先检查登录逻辑");
    expect(tracker.accept(readOfficeProgressEvent(event({ message: "登录逻辑" }, 200)), now + 200, duration)).toBe(false);
    tracker.accept(delta("开始运行测试", 300, "message-b"), now + 300, duration);
    expect(tracker.snapshot(now + 300).get("agent")?.text).toBe("开始运行测试");
  });
  it("preserves spacing from public text deltas and excludes command-output deltas", () => {
    const tracker = setup();
    for (const [index, fragment] of ["I", " will", " check login"].entries()) {
      tracker.accept(readOfficeProgressEvent({ ...event({ eventType: "assistant.text_delta", lastAssistantSnippet: fragment.trim(), payload: { messageId: "message", delta: fragment } }, index), type: "heartbeat.run.event" }), now + index, duration);
    }
    expect(tracker.snapshot(now + 3).get("agent")?.text).toBe("I will check login");
    expect(readOfficeProgressEvent({ ...event({ eventType: "command.output_delta", payload: { delta: "raw command output" } }), type: "heartbeat.run.event" })).toBeUndefined();
  });
  it("uses fresh public snapshot progress rather than a task title", () => {
    const value = readOfficeRunOutput("company", { id: "run", agentId: "agent", status: "running", currentStatusMessage: "正在检查界面布局", currentStatusUpdatedAt: new Date(now) });
    expect(value?.text).toBe("正在检查界面布局");
    expect(readOfficeRunOutput("company", { id: "run", agentId: "agent", status: "running", issueId: "task" })).toBeUndefined();
  });
  it.each<OfficeAction>(["waiting", "resting", "walking", "away", "error", "applicant", "departed"])("never keeps a work bubble on a %s employee", action => {
    const presence: OfficePresence = { action, screen: "off", run: { id: "run", agentId: "agent", status: "running" } };
    expect(officeWorkRunIds(new Map([["agent", presence]]), []).size).toBe(0);
    const output = { ...readOfficeProgressEvent(event({ message: "开始运行测试" }))!, expiresAt: now + duration };
    expect(visibleOfficeWorkOutput(output, "company", "run", action, now)).toBeUndefined();
  });
  it("can bind a confirmed issue execution and expires by real time even when animation is paused", () => {
    const presence: OfficePresence = { action: "working", screen: "working", phase: "working", issueId: "issue" };
    const bindings = officeWorkRunIds(new Map([["agent", presence]]), [{ agentId: "agent", issueId: "issue", phase: "working", runId: "run", currentRun: true }]);
    expect(bindings.get("agent")).toBe("run");
    const output = { ...readOfficeProgressEvent(event({ message: "开始运行测试" }))!, expiresAt: now + duration };
    expect(visibleOfficeWorkOutput(output, "company", "run", "working", now)).toBe(output);
    expect(visibleOfficeWorkOutput(output, "company", "run", "working", now + duration)).toBeUndefined();
    expect(visibleOfficeWorkOutput(output, "company", "other-run", "working", now)).toBeUndefined();
  });
});
