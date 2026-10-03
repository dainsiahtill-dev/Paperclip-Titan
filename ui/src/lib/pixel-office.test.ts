import { describe, expect, it } from "vitest";
import { allocateOfficeSlots, buildOfficeDepartments, buildOfficeLayout, deriveOfficePresence, findOfficePath, type OfficeAgent } from "./pixel-office";

const agent = (id: string, reportsTo: string | null, status: OfficeAgent["status"] = "idle", companyId = "a"): OfficeAgent => ({ id, name: id, title: null, role: "general", companyId, reportsTo, status });

describe("pixel office company and org mapping", () => {
  it("uses the reporting root even when CEO role is general; groups nested reports once", () => {
    const d = buildOfficeDepartments([agent("ceo", null), agent("frontend", "ceo"), agent("lead", "frontend"), agent("dev", "lead"), agent("assistant", "ceo"), agent("foreign", null, "idle", "b")], "a");
    expect(d.map(x => [x.id, x.agents.map(a => a.id).sort()])).toEqual([["management", ["assistant", "ceo"]], ["frontend", ["dev", "frontend", "lead"]]]);
  });
  it("separates missing, cyclic and cross-company managers without dropping staff", () => {
    const d = buildOfficeDepartments([agent("ceo", null), agent("orphan", "missing"), agent("x", "y"), agent("y", "x"), agent("cross", "foreign"), agent("foreign", null, "idle", "b")], "a");
    expect(d.find(x => x.id === "unassigned")?.agents.map(a => a.id).sort()).toEqual(["cross", "orphan", "x", "y"]);
    expect(d.flatMap(x => x.agents).length).toBe(5);
  });
  it("keeps old room positions when API order or names change and reuses deleted slots", () => {
    expect(allocateOfficeSlots(["b", "a", "c"], { a: 3, b: 1, gone: 0 })).toEqual({ a: 3, b: 1, c: 0 });
    expect(allocateOfficeSlots(["c", "b", "a"], { a: 3, b: 1, c: 0 })).toEqual({ a: 3, b: 1, c: 0 });
  });
});

describe("pixel office truthful presence", () => {
  it.each([["active", "walking", "off"], ["idle", "resting", "off"], ["running", "waiting", "waiting"], ["paused", "away", "off"], ["error", "error", "error"], ["pending_approval", "applicant", "off"], ["terminated", "departed", "off"]] as const)("maps %s without inventing offline", (status, action, screen) => {
    expect(deriveOfficePresence(agent("one", null, status), []).action).toBe(action);
    expect(deriveOfficePresence(agent("one", null, status), []).screen).toBe(screen);
  });
  it("does not let cached runs erase pause or an explicit error", () => {
    const runs = [{ id: "r", agentId: "one", status: "running" }];
    expect(deriveOfficePresence(agent("one", null, "paused"), runs).action).toBe("away");
    expect(deriveOfficePresence(agent("one", null, "error"), runs).action).toBe("error");
  });
  it("does not animate typing for a queued or reconnecting run", () => {
    expect(deriveOfficePresence(agent("one", null), [{ id: "r", agentId: "one", status: "queued" }]).action).toBe("waiting");
    expect(deriveOfficePresence(agent("one", null, "running"), [{ id: "r", agentId: "one", status: "running", execution: { phase: "reconnecting" } }]).action).toBe("waiting");
  });
  it("ignores historical retry and unrelated agent runs", () => {
    expect(deriveOfficePresence(agent("one", null), [{ id: "old", agentId: "one", status: "scheduled_retry" }, { id: "other", agentId: "two", status: "running" }]).action).toBe("resting");
  });
  it("uses a current task waiting projection while honoring administrative pause", () => {
    const execution = [{ agentId: "one", phase: "waiting_for_answer" as const }];
    expect(deriveOfficePresence(agent("one", null), [], execution).action).toBe("waiting");
    expect(deriveOfficePresence(agent("one", null, "paused"), [], execution).action).toBe("away");
  });
  it("does not let a completed projection keep showing typing", () => {
    expect(deriveOfficePresence(agent("one", null, "running"), [{ id: "r", agentId: "one", status: "running", execution: { phase: "completed" } }]).action).toBe("resting");
  });
  it("uses current queue and retry projections as waiting, never as working", () => {
    for (const phase of ["queued", "reconnecting", "retry_scheduled"] as const) {
      expect(deriveOfficePresence(agent("one", null), [], [{ agentId: "one", phase, currentRun: true }]).action).toBe("waiting");
      expect(deriveOfficePresence(agent("one", null), [], [{ agentId: "one", phase }]).action).toBe("resting");
    }
  });
  it("chooses a current queued successor before its failed predecessor without erasing an explicit pause", () => {
    const runs = [{ id: "successor", agentId: "one", status: "queued", currentTask: true, execution: { phase: "queued" as const } }];
    const old = [{ agentId: "one", phase: "failed" as const, runId: "old" }];
    expect(deriveOfficePresence(agent("one", null, "error"), runs, old).action).toBe("waiting");
    expect(deriveOfficePresence(agent("one", null, "paused"), runs, old).action).toBe("away");
  });
  it("keeps queued status authoritative when the predecessor projection is still attached", () => {
    const p = deriveOfficePresence(agent("one", null), [{ id: "new", agentId: "one", status: "queued", execution: { phase: "failed" } }]);
    expect([p.action, p.phase]).toEqual(["waiting", "queued"]);
  });
  it("is deterministic for multiple tasks regardless of network completion order", () => {
    const projections = [{ agentId: "one", phase: "waiting_for_answer" as const, issueId: "b" }, { agentId: "one", phase: "recovery_needed" as const, issueId: "a" }];
    expect(deriveOfficePresence(agent("one", null), [], projections)).toEqual(deriveOfficePresence(agent("one", null), [], [...projections].reverse()));
    expect(deriveOfficePresence(agent("one", null), [], projections).action).toBe("error");
  });
  it("keeps current confirmed work active when a backup model is used", () => {
    expect(deriveOfficePresence(agent("one", null), [{ id: "backup", agentId: "one", status: "running", execution: { phase: "working" } }]).action).toBe("working");
  });
  it("keeps a primary-recovered quota retry waiting rather than declaring it started", () => {
    expect(deriveOfficePresence(agent("one", null, "error"), [], [{ agentId: "one", phase: "retry_scheduled", currentRun: true }]).action).toBe("waiting");
    expect(deriveOfficePresence(agent("one", null, "error"), [], [{ agentId: "one", phase: "retry_scheduled" }]).action).toBe("error");
  });
});

describe("dynamic room circulation", () => {
  it("connects every south door and workstation to the main entrance across extra rows", () => {
    const staff = [agent("ceo", null), ...Array.from({ length: 11 }, (_, n) => [agent("manager" + n, "ceo"), ...Array.from({ length: n % 8 + 1 }, (_, k) => agent(`dev-${n}-${k}`, "manager" + n))]).flat()];
    const departments = buildOfficeDepartments(staff, "a");
    const layout = buildOfficeLayout(departments, { rooms: {}, seats: {} }, 4);
    expect(layout.rooms.length).toBe(12);
    for (const room of layout.rooms) {
      expect(room.door.y).toBe(room.y + room.height - 1);
      expect(findOfficePath(layout, layout.entrance, room.door).length).toBeGreaterThan(0);
      for (const seat of room.seats) expect(findOfficePath(layout, layout.entrance, seat.walkPoint).length).toBeGreaterThan(0);
    }
    const path = findOfficePath(layout, layout.entrance, layout.rooms[0].door);
    expect(path[0]).toEqual(layout.entrance);
    expect(path[path.length - 1]).toEqual(layout.rooms[0].door);
  });
  it("does not allocate a workstation to applicants or terminated employees", () => {
    const layout = buildOfficeLayout(buildOfficeDepartments([agent("ceo", null), agent("wait", "ceo", "pending_approval"), agent("left", "ceo", "terminated")], "a"), { rooms: {}, seats: {} }, 2);
    expect(layout.rooms.flatMap(r => r.seats).map(s => s.agent.id)).toEqual(["ceo"]);
  });
  it("keeps existing seat coordinates when a fifth employee is added", () => {
    const initial = [agent("ceo", null), agent("manager", "ceo"), ...[0, 1, 2].map(n => agent("worker" + n, "manager"))];
    const before = buildOfficeLayout(buildOfficeDepartments(initial, "a"), { rooms: {}, seats: {} }, 2);
    const after = buildOfficeLayout(buildOfficeDepartments([...initial, agent("worker3", "manager")], "a"), before.slots, 2);
    const old = before.rooms.find(r => r.department.id === "manager")!;
    const next = after.rooms.find(r => r.department.id === "manager")!;
    for (const seat of old.seats) {
      const newSeat = next.seats.find(s => s.agent.id === seat.agent.id)!;
      expect([newSeat.x, newSeat.y]).toEqual([seat.x, seat.y]);
    }
  });
  it("reserves enough outside floor space for all away employees", () => {
    const staff = Array.from({ length: 45 }, (_, n) => agent("paused" + n, null, "paused"));
    const layout = buildOfficeLayout(buildOfficeDepartments(staff, "a"), { rooms: {}, seats: {} }, 2);
    expect(layout.height).toBeGreaterThan(layout.foyerY + 10);
  });
});
