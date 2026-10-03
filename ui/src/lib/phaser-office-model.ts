import { allocateOfficeSlots, officeStableHash, type OfficeAgent, type OfficeDepartment, type OfficePoint } from "./pixel-office";
import type { OfficeArt } from "../components/pixel-office/types";

export interface PhaserOfficeConfig { grid: number; margin: number; aisle: number; corridor: number; roomHeight: number; smallWidth: number; mediumWidth: number; largeWidth: number; foyer: number; outside: number; tableWidth: number; tableDepth: number; chairWidth: number; chairDepth: number; radius: number; wall: number; doorWidth: number; decor?: { shelf: number; board: number; plant: number; sofa: number; coffee: number; reception: number; padding: number } }
export interface PhaserOfficeSlots { rooms?: Record<string, number>; seats?: Record<string, Record<string, number>>; configs?: Record<string, number>; columns?: number; widths?: number[] }
export interface PhaserSeat extends OfficePoint { agent: OfficeAgent; walk: OfficePoint; module: string; local: number }
export interface PhaserRoom extends OfficePoint { id: string; department: OfficeDepartment; slot: number; width: number; height: number; columns: number; door: OfficePoint; seats: PhaserSeat[] }
export interface OfficeGroundRect extends OfficePoint { width: number; height: number; kind: string }
export interface PhaserOfficeProp extends OfficePoint { id: string; width: number; height: number; ground: OfficeGroundRect; blocks: boolean }
export interface PhaserOfficeModel { width: number; height: number; grid: number; radius: number; rooms: PhaserRoom[]; seats: PhaserSeat[]; walkable: boolean[][]; blocked: OfficeGroundRect[]; props: PhaserOfficeProp[]; applicantSlots: Record<string, OfficePoint>; outsideSlots: Record<string, OfficePoint>; entrance: OfficePoint; lounge: OfficePoint; corridors: OfficeGroundRect[]; foyerY: number; outsideY: number; revision: string; slots: PhaserOfficeSlots }

export function buildPhaserOffice(departments: OfficeDepartment[], previous: PhaserOfficeSlots, c: PhaserOfficeConfig, art: Record<string, OfficeArt> = {}): PhaserOfficeModel {
  const configs: Record<string, number> = {};
  const seats: Record<string, Record<string, number>> = {};
  const modules: Array<{ id: string; department: OfficeDepartment; columns: number; number: number; agents: OfficeAgent[] }> = [];
  for (const d of departments) {
    const assigned = d.agents.filter(a => !["pending_approval", "terminated"].includes(a.status));
    seats[d.id] = allocateOfficeSlots(assigned.map(a => a.id), previous.seats?.[d.id] ?? {});
    const saved = previous.configs?.[d.id];
    const cols = saved && saved >= 2 && saved <= 4 ? saved : previous.columns ? 2 : assigned.length > 6 ? 4 : assigned.length > 4 ? 3 : 2;
    configs[d.id] = cols;
    const count = Math.max(1, Math.ceil((Math.max(-1, ...Object.values(seats[d.id])) + 1) / (cols * 2)));
    for (let i = 0; i < count; i++) modules.push({ id: d.id + "#" + i, department: d, columns: cols, number: i, agents: assigned.filter(a => Math.floor(seats[d.id][a.id] / (cols * 2)) === i) });
  }
  const slots = allocateOfficeSlots(modules.map(m => m.id), previous.rooms ?? {});
  const columns = previous.columns && previous.columns > 0 && previous.columns <= 4 ? previous.columns : Math.max(1, Math.min(4, modules.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(c.smallWidth, previous.widths?.[i] ?? 0));
  // Leave side aisles around each full row of desk footprints. Dense 3/4
  // column rows otherwise form an impassable wall across the room.
  for (const m of modules) widths[slots[m.id] % columns] = Math.max(widths[slots[m.id] % columns], m.columns === 4 ? c.largeWidth : m.columns === 3 ? c.mediumWidth : c.smallWidth, Math.ceil(((m.columns - 1) * (c.tableWidth + 6) + c.tableWidth + c.radius * 8) / c.grid) * c.grid);
  const xs: number[] = [];
  const middle = Math.ceil(columns / 2);
  let x = c.margin;
  for (let col = 0; col < columns; col++) { if (col === middle) x += c.aisle; xs.push(x); x += widths[col]; }
  const width = x + c.margin;
  const rowCount = Math.max(1, Math.ceil((Math.max(-1, ...Object.values(slots)) + 1) / columns));
  const corridors = Array.from({ length: rowCount }, (_, row) => ({ x: c.margin / 2, y: c.margin + row * (c.roomHeight + c.corridor) + c.roomHeight, width: width - c.margin, height: c.corridor, kind: "corridor" }));
  const foyerY = c.margin + rowCount * (c.roomHeight + c.corridor);
  const applicants = departments.flatMap(d => d.agents).filter(a => a.status === "pending_approval").sort((a, b) => a.id.localeCompare(b.id));
  const outside = departments.flatMap(d => d.agents).filter(a => ["paused", "terminated"].includes(a.status)).sort((a, b) => a.id.localeCompare(b.id));
  const queueColumns = Math.max(1, Math.floor((width - c.margin * 2) / (c.radius * 5)) - 2);
  const foyerHeight = Math.max(c.foyer, Math.ceil(applicants.length / queueColumns) * c.grid * 5 + c.margin * 2);
  const outsideY = foyerY + foyerHeight;
  const outsideColumns = Math.max(1, Math.floor((width - c.margin * 2) / (c.radius * 6)));
  const height = outsideY + Math.max(c.outside, Math.ceil(outside.length / outsideColumns) * c.grid * 5 + c.margin * 2);
  const rooms: PhaserRoom[] = [];
  for (const m of modules) {
    const slot = slots[m.id], col = slot % columns, row = Math.floor(slot / columns);
    const rw = widths[col], rx = xs[col], ry = c.margin + row * (c.roomHeight + c.corridor);
    const stride = c.tableWidth + 6;
    const room: PhaserRoom = { id: m.id, department: m.department, slot, x: rx, y: ry, width: rw, height: c.roomHeight, columns: m.columns, door: { x: rx + rw / 2, y: ry + c.roomHeight }, seats: [] };
    room.seats = m.agents.map(agent => {
      const local = seats[m.department.id][agent.id] % (m.columns * 2);
      const sx = rx + rw / 2 - (m.columns - 1) * stride / 2 + (local % m.columns) * stride;
      const sy = ry + c.roomHeight - c.corridor - c.grid * 6 + Math.floor(local / m.columns) * 80;
      return { agent, x: sx, y: sy, local, module: m.id, walk: { x: sx + 28, y: sy + 38 } };
    });
    rooms.push(room);
  }
  const walkable = Array.from({ length: Math.ceil(height / c.grid) }, () => Array<boolean>(Math.ceil(width / c.grid)).fill(false));
  const fill = (r: OfficeGroundRect, value: boolean) => {
    const x0 = Math.max(0, Math.floor(r.x / c.grid)), y0 = Math.max(0, Math.floor(r.y / c.grid));
    const x1 = Math.min(walkable[0].length, Math.ceil((r.x + r.width) / c.grid)), y1 = Math.min(walkable.length, Math.ceil((r.y + r.height) / c.grid));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const cx = (x + .5) * c.grid, cy = (y + .5) * c.grid;
      const inside = value ? cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height : cx > r.x && cx < r.x + r.width && cy > r.y && cy < r.y + r.height;
      if (inside) walkable[y][x] = value;
    }
  };
  const rect = (x: number, y: number, w: number, h: number, kind = "floor"): OfficeGroundRect => ({ x, y, width: w, height: h, kind });
  fill(rect(c.radius, c.margin / 2, c.margin - c.radius, height - c.margin / 2), true);
  fill(rect(width - c.margin, c.margin / 2, c.margin - c.radius, height - c.margin / 2), true);
  if (columns > 1) fill(rect(xs[middle] - c.aisle, c.margin / 2, c.aisle, height - c.margin / 2), true);
  for (const r of corridors) fill(r, true);
  fill(rect(c.radius, foyerY, width - c.radius * 2, height - foyerY), true);
  for (const r of rooms) {
    fill(rect(r.x + c.radius * 2, r.y + c.radius * 2, r.width - c.radius * 4, r.height - c.radius * 4), true);
    fill(rect(r.door.x - 20 + c.radius, r.door.y - 24, 40 - c.radius * 2, 48), true);
  }
  const entrance = { x: columns > 1 ? xs[middle] - c.aisle / 2 : width / 2, y: outsideY };
  const lounge = { x: entrance.x, y: corridors[0].y + c.corridor - 16 };
  // Keep a full grid-cell aisle behind each chair. The previous +28 anchor
  // left only four pixels between its inflated footprint and the next desk.
  const blocked: OfficeGroundRect[] = rooms.flatMap(r => r.seats.flatMap(s => [rect(s.x - c.tableWidth / 2, s.y - c.tableDepth, c.tableWidth, c.tableDepth, "desk"), rect(s.x - c.chairWidth / 2, s.y + 20 - c.chairDepth / 2, c.chairWidth, c.chairDepth, "chair")]));
  const decor = c.decor ?? { shelf: c.grid * 5, board: c.grid * 8, plant: c.grid * 4, sofa: c.grid * 16, coffee: c.grid * 5, reception: c.grid * 16, padding: c.margin / 2 };
  const props: PhaserOfficeProp[] = [];
  const defaults: Record<string, [number, number]> = { bookcase: [64, 72], whiteboard: [80, 56], noticeboard: [64, 48], art_easel: [48, 64], server_rack: [48, 72], plant_small: [32, 40], plant_large: [48, 64], sofa: [96, 56], coffee_table: [48, 32], coffee_machine: [48, 64], water_cooler: [32, 56], reception_desk: [128, 64], hedge: [96, 48] };
  const addProp = (id: string, x: number, y: number, w: number, kind = id) => {
    const sprite = art[id], size = sprite?.physicalSize ?? defaults[id], scale = w / size[0], h = size[1] * scale;
    const g = sprite?.ground ?? [0, size[1] * .84, size[0], size[1] * .16];
    const ground = rect(x + g[0] * scale, y + g[1] * scale, g[2] * scale, g[3] * scale, kind);
    const blocks = sprite?.blocksMovement ?? !["whiteboard", "noticeboard"].includes(id);
    props.push({ id, x, y, width: w, height: h, ground, blocks });
    if (blocks) blocked.push(ground);
  };
  for (const r of rooms) {
    addProp("bookcase", r.x + c.wall + decor.padding / 2, r.y + c.wall * 2 + decor.padding, decor.shelf);
    addProp(["whiteboard", "noticeboard", "art_easel", "server_rack"][officeStableHash(r.id) % 4], r.x + r.width - decor.board - c.wall - decor.padding / 2, r.y + c.wall * 2 + decor.padding, decor.board);
    for (const px of [r.x + c.wall + decor.padding / 2, r.x + r.width - decor.plant - c.wall - decor.padding / 2]) addProp("plant_small", px, r.y + r.height - decor.plant - c.wall, decor.plant);
  }
  addProp("sofa", lounge.x - decor.sofa / 2, corridors[0].y + c.margin / 2 - c.wall * 2, decor.sofa, "sofa");
  addProp("coffee_table", lounge.x - decor.coffee / 2, corridors[0].y + c.margin + c.wall, decor.coffee, "coffee-table");
  addProp("coffee_machine", lounge.x - decor.sofa / 2 - decor.plant - decor.padding, corridors[0].y + c.margin / 2 - c.wall * 2, decor.plant, "coffee-machine");
  addProp("water_cooler", lounge.x + decor.sofa / 2 + decor.padding, corridors[0].y + c.margin / 2 - c.wall * 2, decor.plant, "water-cooler");
  addProp("reception_desk", entrance.x + c.grid * 5, foyerY + c.grid * 3, decor.reception, "reception");
  for (const px of [c.wall + decor.padding, width - c.wall - decor.padding - decor.plant]) for (const corridor of corridors) addProp("plant_large", px, corridor.y + decor.padding, decor.plant);
  for (let px = c.wall + decor.padding; px < width - c.grid * 12; px += c.grid * 12) {
    if (Math.abs(px - entrance.x) < c.grid * 16 || px > entrance.x && px < entrance.x + decor.reception + c.grid * 10) continue;
    addProp("hedge", px, outsideY + c.wall, c.grid * 12);
  }
  const opening = c.doorWidth - c.wall * 2;
  for (const r of rooms) {
    blocked.push(rect(r.x, r.y, r.width, c.wall, "wall"), rect(r.x, r.y, c.wall, r.height, "wall"), rect(r.x + r.width - c.wall, r.y, c.wall, r.height, "wall"));
    blocked.push(rect(r.x, r.door.y - c.wall, r.width / 2 - opening / 2, c.wall, "wall"), rect(r.door.x + opening / 2, r.door.y - c.wall, r.width / 2 - opening / 2, c.wall, "wall"));
  }
  blocked.push(rect(c.wall, outsideY - c.wall, entrance.x - opening / 2 - c.wall, c.wall, "wall"), rect(entrance.x + opening / 2, outsideY - c.wall, width - entrance.x - opening / 2 - c.wall, c.wall, "wall"));
  for (const r of blocked) fill(rect(r.x - c.radius, r.y - c.radius, r.width + c.radius * 2, r.height + c.radius * 2), false);
  const allSeats = rooms.flatMap(r => r.seats);
  const model: PhaserOfficeModel = { width, height, grid: c.grid, radius: c.radius, rooms, seats: allSeats, walkable, blocked, props, applicantSlots: {}, outsideSlots: {}, entrance, lounge, corridors, foyerY, outsideY, revision: "", slots: { rooms: slots, seats, configs, columns, widths } };
  model.entrance = nearestPhaserWalk(model, entrance);
  // A narrow pocket behind furniture can be geometrically empty but unreachable.
  // Actor targets must belong to the entrance's connected floor component.
  const queue = [[Math.floor(model.entrance.x / c.grid), Math.floor(model.entrance.y / c.grid)]], reachable = new Set<string>([queue[0].join(",")]);
  for (let i = 0; i < queue.length; i++) {
    const [px, py] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = [px + dx, py + dy].join(",");
      if (walkable[py + dy]?.[px + dx] && !reachable.has(key)) { reachable.add(key); queue.push([px + dx, py + dy]); }
    }
  }
  for (let py = 0; py < walkable.length; py++) for (let px = 0; px < walkable[py].length; px++) if (!reachable.has([px, py].join(","))) walkable[py][px] = false;
  for (const s of allSeats) s.walk = nearestPhaserWalk(model, s.walk);
  model.lounge = nearestPhaserWalk(model, lounge);
  const reception = blocked.find(r => r.kind === "reception")!;
  const waiting: OfficePoint[] = [];
  for (let py = foyerY + c.grid * 3; py < outsideY - c.margin / 2; py += c.radius * 5) for (let px = c.margin; px < width - c.margin; px += c.radius * 5) {
    const p = nearestPhaserWalk(model, { x: px, y: py });
    if (p.y >= foyerY && p.y < outsideY - c.wall - c.radius && phaserPointIsSafe(model, p) && waiting.every(q => Math.hypot(p.x - q.x, p.y - q.y) >= c.radius * 5)) waiting.push(p);
  }
  waiting.sort((a, b) => Math.hypot(a.x - reception.x, a.y - reception.y) - Math.hypot(b.x - reception.x, b.y - reception.y));
  applicants.forEach((a, i) => { model.applicantSlots[a.id] = waiting[i] ?? model.entrance; });
  outside.forEach((a, i) => { model.outsideSlots[a.id] = nearestPhaserWalk(model, { x: c.margin + (i % outsideColumns) * c.radius * 6, y: outsideY + c.grid * 10 + Math.floor(i / outsideColumns) * c.grid * 5 }); });
  model.revision = String(officeStableHash(JSON.stringify([width, height, blocked, model.applicantSlots, model.outsideSlots, rooms.map(r => [r.id, r.x, r.y, r.width, r.seats.map(s => [s.agent.id, s.x, s.y])]) ])));
  return model;
}

export function nearestPhaserWalk(m: PhaserOfficeModel, p: OfficePoint): OfficePoint {
  const sx = Math.floor(p.x / m.grid), sy = Math.floor(p.y / m.grid);
  for (let radius = 0; radius < Math.max(m.walkable.length, m.walkable[0].length); radius++) {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      if (m.walkable[sy + dy]?.[sx + dx]) return { x: (sx + dx + .5) * m.grid, y: (sy + dy + .5) * m.grid };
    }
  }
  return p;
}

export function phaserPointIsSafe(m: PhaserOfficeModel, p: OfficePoint): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !m.walkable[Math.floor(p.y / m.grid)]?.[Math.floor(p.x / m.grid)]) return false;
  return !m.blocked.some(r => p.x > r.x - m.radius && p.x < r.x + r.width + m.radius && p.y > r.y - m.radius && p.y < r.y + r.height + m.radius);
}

export function phaserSegmentIsSafe(m: PhaserOfficeModel, from: OfficePoint, to: OfficePoint): boolean {
  if (!phaserPointIsSafe(m, to)) return false;
  return !m.blocked.some(r => {
    let enter = 0, leave = 1;
    for (const [a, b, low, high] of [[from.x, to.x, r.x - m.radius, r.x + r.width + m.radius], [from.y, to.y, r.y - m.radius, r.y + r.height + m.radius]]) {
      const delta = b - a;
      if (Math.abs(delta) < .000001) { if (a <= low || a >= high) return false; }
      else { const one = (low - a) / delta, two = (high - a) / delta; enter = Math.max(enter, Math.min(one, two)); leave = Math.min(leave, Math.max(one, two)); }
      if (enter >= leave) return false;
    }
    return enter < leave && leave > 0 && enter < 1;
  });
}

export function joinPhaserRoute(m: PhaserOfficeModel, from: OfficePoint, route: OfficePoint[]): OfficePoint[] {
  return route.length > 1 && phaserSegmentIsSafe(m, from, route[1]) ? route.slice(1) : route;
}

export function findPhaserPath(m: PhaserOfficeModel, from: OfficePoint, to: OfficePoint, avoid: OfficePoint[] = [], verticalPreference = 1): OfficePoint[] {
  const start = nearestPhaserWalk(m, from), end = nearestPhaserWalk(m, to);
  const cols = m.walkable[0].length, sx = Math.floor(start.x / m.grid), sy = Math.floor(start.y / m.grid), ex = Math.floor(end.x / m.grid), ey = Math.floor(end.y / m.grid);
  const key = (x: number, y: number) => y * cols + x;
  const occupied = new Set<number>();
  for (const p of avoid) for (let y = Math.floor((p.y - m.radius * 2) / m.grid); y <= Math.ceil((p.y + m.radius * 2) / m.grid); y++) for (let x = Math.floor((p.x - m.radius * 2) / m.grid); x <= Math.ceil((p.x + m.radius * 2) / m.grid); x++) if (Math.abs((x + .5) * m.grid - p.x) < m.radius * 2 && Math.abs((y + .5) * m.grid - p.y) < m.radius * 2) occupied.add(key(x, y));
  const canWalk = (x: number, y: number) => m.walkable[y]?.[x] && ((x === sx && y === sy || x === ex && y === ey) || !occupied.has(key(x, y)));
  const queue = [[sx, sy]], previous = new Map<number, number | null>([[key(sx, sy), null]]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (x === ex && y === ey) {
      const result: OfficePoint[] = [];
      let k: number | null = key(x, y);
      while (k !== null) { result.push({ x: (k % cols + .5) * m.grid, y: (Math.floor(k / cols) + .5) * m.grid }); k = previous.get(k) ?? null; }
      return result.reverse();
    }
    for (const [dx, dy] of [[0, verticalPreference], [1, 0], [0, -verticalPreference], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (canWalk(nx, ny) && !previous.has(k)) { previous.set(k, key(x, y)); queue.push([nx, ny]); }
    }
  }
  return [];
}
