import type { Agent, ExecutionProjection } from "@paperclipai/shared";

export type OfficeAgent = Pick<Agent, "id" | "companyId" | "name" | "title" | "role" | "reportsTo" | "status">;
export type OfficeAction = "working" | "waiting" | "resting" | "walking" | "away" | "error" | "applicant" | "departed";
export type OfficeScreen = "off" | "working" | "waiting" | "error";
export type OfficePhase = ExecutionProjection["phase"];
export interface OfficeRun { id: string; agentId: string; status: string; issueId?: string | null; currentTask?: boolean; execution?: { phase: OfficePhase } | null }
export interface OfficeExecution { agentId: string; phase: OfficePhase; issueId?: string; runId?: string; currentRun?: boolean }
export interface OfficePresence { action: OfficeAction; screen: OfficeScreen; phase?: OfficePhase; run?: OfficeRun; issueId?: string | null }
export interface OfficeDepartment { id: string; manager: OfficeAgent | null; agents: OfficeAgent[] }
export interface OfficePoint { x: number; y: number }
export interface OfficeSeat extends OfficePoint { agent: OfficeAgent; index: number; walkPoint: OfficePoint }
export interface OfficeRoom extends OfficePoint { department: OfficeDepartment; slot: number; width: number; height: number; door: OfficePoint; seats: OfficeSeat[] }
export interface OfficeSlots { rooms: Record<string, number>; seats: Record<string, Record<string, number>>; deskColumns?: Record<string, number>; layoutColumns?: number; columnWidths?: number[]; rowHeights?: number[] }
export interface OfficeLayout { width: number; height: number; revision: string; rooms: OfficeRoom[]; walkable: boolean[][]; entrance: OfficePoint; outside: OfficePoint; foyerY: number; outsideColumns: number; corridors: Array<OfficePoint & { width: number; height: number }>; slots: OfficeSlots }

export function allocateOfficeSlots(ids: string[], previous: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  const occupied = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    const slot = previous[id];
    if (Number.isInteger(slot) && slot >= 0 && slot < Math.max(1024, ids.length * 2) && !occupied.has(slot)) {
      result[id] = slot;
      occupied.add(slot);
    }
  }
  for (const id of ids) {
    if (id in result) continue;
    let slot = 0;
    while (occupied.has(slot)) slot++;
    result[id] = slot;
    occupied.add(slot);
  }
  return result;
}

export function buildOfficeDepartments(agents: OfficeAgent[], companyId: string): OfficeDepartment[] {
  const local = agents.filter(a => a.companyId === companyId);
  const byId = new Map(local.map(a => [a.id, a]));
  const managers = new Set(local.flatMap(a => a.reportsTo ? [a.reportsTo] : []));
  const groups = new Map<string, OfficeDepartment>();
  for (const agent of local) {
    const seen = new Set<string>();
    const chain: OfficeAgent[] = [];
    let current: OfficeAgent | undefined = agent;
    let invalid = false;
    while (current) {
      if (seen.has(current.id)) { invalid = true; break; }
      seen.add(current.id);
      chain.push(current);
      if (!current.reportsTo) break;
      current = byId.get(current.reportsTo);
      if (!current) invalid = true;
    }
    const branch = chain.at(-2);
    const id = invalid ? "unassigned" : branch && managers.has(branch.id) ? branch.id : "management";
    const group = groups.get(id) ?? { id, manager: id === "management" || id === "unassigned" ? null : byId.get(id) ?? null, agents: [] };
    group.agents.push(agent);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === "management") return -1;
    if (b.id === "management") return 1;
    if (a.id === "unassigned") return 1;
    if (b.id === "unassigned") return -1;
    return a.id.localeCompare(b.id);
  }).map(d => ({ ...d, agents: d.agents.sort((a, b) => a.id.localeCompare(b.id)) }));
}

export function deriveOfficePresence(agent: OfficeAgent, runs: OfficeRun[], executions: OfficeExecution[] = []): OfficePresence {
  const administrative: Partial<Record<OfficeAgent["status"], OfficeAction>> = { paused: "away", pending_approval: "applicant", terminated: "departed" };
  const fixed = administrative[agent.status];
  if (fixed) return { action: fixed, screen: fixed === "error" ? "error" : "off" };
  const live = runs.filter(r => r.agentId === agent.id && (r.status === "running" || r.status === "queued"));
  const liveRank = (r: OfficeRun) => r.status === "running" && r.execution && ["working", "finishing"].includes(r.execution.phase) ? 0 : r.status === "queued" ? 1 : r.execution?.phase === "completed" ? 3 : 2;
  live.sort((a, b) => liveRank(a) - liveRank(b) || a.id.localeCompare(b.id));
  const run = live[0];
  const ranks: Record<OfficePhase, number> = { working: 0, finishing: 1, recovery_needed: 2, failed: 3, waiting_for_access: 4, waiting_for_answer: 5, queued: 6, retry_scheduled: 7, reconnecting: 8, completed: 9 };
  const candidates = executions.filter(e => e.agentId === agent.id && (e.currentRun || !["queued", "retry_scheduled", "reconnecting"].includes(e.phase)));
  candidates.sort((a, b) => ranks[a.phase] - ranks[b.phase] || (a.issueId ?? "").localeCompare(b.issueId ?? "") || (a.runId ?? "").localeCompare(b.runId ?? ""));
  const current = !run ? candidates[0] : undefined;
  // A confirmed current retry/queue can wait after a quota error; it is not work.
  const currentRetry = current?.currentRun && ["queued", "retry_scheduled", "reconnecting"].includes(current.phase);
  if (agent.status === "error" && !run?.currentTask && !currentRetry) return { action: "error", screen: "error" };
  const phase = run?.execution?.phase ?? current?.phase;
  const issueId = run?.issueId ?? current?.issueId;
  if (run?.status === "queued") return { action: "waiting", screen: "waiting", phase: "queued", run, issueId };
  if (phase === "failed" || phase === "recovery_needed") return { action: "error", screen: "error", phase, run, issueId };
  if (phase === "completed") return { action: "resting", screen: "off", phase, run, issueId };
  if (phase && ["reconnecting", "retry_scheduled", "queued", "waiting_for_access", "waiting_for_answer"].includes(phase)) return { action: "waiting", screen: "waiting", phase, run, issueId };
  if (phase === "working" || phase === "finishing") return { action: "working", screen: "working", phase, run, issueId };
  if (run?.status === "running" || agent.status === "running") return { action: "waiting", screen: "waiting", run, issueId };
  return { action: agent.status === "active" ? "walking" : "resting", screen: "off" };
}

/** All dimensions are world grid cells, not hardcoded component pixel values. */
export function buildOfficeLayout(departments: OfficeDepartment[], previous: OfficeSlots, requestedColumns: number): OfficeLayout {
  const columns = Math.max(1, Math.min(4, requestedColumns));
  const roomSlots = allocateOfficeSlots(departments.map(d => d.id), previous.rooms);
  const bySlot = new Map(departments.map(d => [roomSlots[d.id], d]));
  const rowCount = Math.max(1, Math.ceil((Math.max(-1, ...Object.values(roomSlots)) + 1) / columns));
  const seatSlots: OfficeSlots["seats"] = {};
  const deskColumnsById: Record<string, number> = {};
  const metrics = new Map<string, { deskColumns: number; rows: number; width: number; height: number; agents: OfficeAgent[] }>();
  const sameColumns = previous.layoutColumns === columns;
  const columnWidths = Array.from({ length: columns }, (_, i) => sameColumns ? Math.max(9, previous.columnWidths?.[i] ?? 9) : 9);
  const rowHeights = Array.from({ length: rowCount }, (_, i) => sameColumns ? Math.max(7, previous.rowHeights?.[i] ?? 7) : 7);
  for (const d of departments) {
    const agents = d.agents.filter(a => a.status !== "terminated" && a.status !== "pending_approval");
    seatSlots[d.id] = allocateOfficeSlots(agents.map(a => a.id), previous.seats[d.id] ?? {});
    const capacity = Math.max(1, Math.max(-1, ...Object.values(seatSlots[d.id])) + 1);
    const oldColumns = previous.deskColumns?.[d.id];
    const oldCapacity = Math.max(-1, ...Object.values(previous.seats[d.id] ?? {})) + 1;
    const deskColumns = oldColumns === 2 || oldColumns === 3 ? oldColumns : (oldCapacity || capacity) > 4 ? 3 : 2;
    deskColumnsById[d.id] = deskColumns;
    const rows = Math.max(1, Math.ceil(capacity / deskColumns));
    const width = deskColumns * 3 + 3;
    const height = rows * 4 + 3;
    const slot = roomSlots[d.id];
    columnWidths[slot % columns] = Math.max(columnWidths[slot % columns], width);
    rowHeights[Math.floor(slot / columns)] = Math.max(rowHeights[Math.floor(slot / columns)], height);
    metrics.set(d.id, { deskColumns, rows, width, height, agents });
  }
  const columnX: number[] = [];
  let width = 2;
  for (const w of columnWidths) { columnX.push(width); width += w + 2; }
  const rowY: number[] = [];
  let y = 2;
  const corridors: OfficeLayout["corridors"] = [];
  for (const h of rowHeights) { rowY.push(y); corridors.push({ x: 1, y: y + h, width: width - 2, height: 3 }); y += h + 3; }
  const foyerY = y;
  const outsideColumns = Math.max(1, Math.min(11, width - 4));
  const outsideCount = departments.flatMap(d => d.agents).filter(a => ["paused", "terminated", "pending_approval"].includes(a.status)).length;
  const height = y + 6 + Math.max(1, Math.ceil(outsideCount / outsideColumns)) + 2;
  const walkable = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  const fill = (x: number, y: number, w: number, h: number, value = true) => {
    for (let iy = Math.max(0, y); iy < Math.min(height, y + h); iy++) for (let ix = Math.max(0, x); ix < Math.min(width, x + w); ix++) walkable[iy][ix] = value;
  };
  fill(1, foyerY, width - 2, height - foyerY);
  for (const c of corridors) fill(c.x, c.y, c.width, c.height);
  fill(0, 1, 2, foyerY);
  for (let col = 0; col < columns; col++) fill(columnX[col] + columnWidths[col], 1, 2, foyerY);
  const rooms: OfficeRoom[] = [];
  for (let row = 0; row < rowCount; row++) for (let col = 0; col < columns; col++) {
    const d = bySlot.get(row * columns + col);
    if (!d) continue;
    const m = metrics.get(d.id)!;
    const x = columnX[col];
    const y = rowY[row];
    const w = columnWidths[col];
    const h = rowHeights[row];
    fill(x + 1, y + 1, w - 2, h - 2);
    const door = { x: x + Math.floor(w / 2), y: y + h - 1 };
    fill(door.x, door.y, 1, 1);
    const seats = m.agents.map(agent => {
      const index = seatSlots[d.id][agent.id];
      const sx = x + 2.5 + (index % m.deskColumns) * 3;
      const sy = y + 3 + Math.floor(index / m.deskColumns) * 4;
      fill(Math.floor(sx) - 1, sy - 2, 3, 2, false);
      fill(Math.floor(sx), sy, 1, 1, false);
      return { agent, index, x: sx, y: sy, walkPoint: { x: Math.floor(sx), y: sy + 1 } };
    });
    rooms.push({ department: d, slot: row * columns + col, x, y, width: w, height: h, door, seats });
  }
  const entrance = { x: Math.floor(width / 2), y: foyerY + 4 };
  const outside = { x: entrance.x, y: foyerY + 6 };
  const revision = String(officeStableHash(JSON.stringify([width, height, rooms.map(r => [r.department.id, r.x, r.y, r.width, r.height, r.seats.map(s => [s.agent.id, s.x, s.y])])])));
  return { width, height, revision, rooms, walkable, entrance, outside, foyerY, outsideColumns, corridors, slots: { rooms: roomSlots, seats: seatSlots, deskColumns: deskColumnsById, layoutColumns: columns, columnWidths, rowHeights } };
}

export function officeOutsidePoint(layout: OfficeLayout, index: number): OfficePoint {
  return { x: Math.max(2, Math.floor((layout.width - layout.outsideColumns) / 2)) + index % layout.outsideColumns, y: layout.foyerY + 6 + Math.floor(index / layout.outsideColumns) };
}

export function officeEventNeedsRefresh(event: { type: string; payload?: Record<string, unknown> }): boolean {
  if (["agent.status", "heartbeat.run.status", "heartbeat.run.queued"].includes(event.type)) return true;
  if (event.type !== "activity.logged") return false;
  const action = String(event.payload?.action ?? "");
  return action.startsWith("agent.") || action.startsWith("issue.") || action.includes("interaction");
}

export function findOfficePath(layout: OfficeLayout, start: OfficePoint, end: OfficePoint): OfficePoint[] {
  const sx = Math.floor(start.x), sy = Math.floor(start.y), ex = Math.floor(end.x), ey = Math.floor(end.y);
  if (!layout.walkable[sy]?.[sx] || !layout.walkable[ey]?.[ex]) return [];
  const key = (x: number, y: number) => y * layout.width + x;
  const queue: OfficePoint[] = [{ x: sx, y: sy }];
  const previous = new Map<number, number | null>([[key(sx, sy), null]]);
  for (let index = 0; index < queue.length; index++) {
    const p = queue[index];
    if (p.x === ex && p.y === ey) {
      const path: OfficePoint[] = [];
      let k: number | null = key(ex, ey);
      while (k !== null) { path.push({ x: k % layout.width, y: Math.floor(k / layout.width) }); k = previous.get(k) ?? null; }
      return path.reverse();
    }
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const x = p.x + dx, y = p.y + dy, k = key(x, y);
      if (layout.walkable[y]?.[x] && !previous.has(k)) { previous.set(k, key(p.x, p.y)); queue.push({ x, y }); }
    }
  }
  return [];
}

export function officeStableHash(value: string): number { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
