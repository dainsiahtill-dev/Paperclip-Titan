import { describe, expect, it } from "vitest";
import { buildOfficeDepartments, type OfficeAgent } from "./pixel-office";
import { buildPhaserOffice, findPhaserPath, phaserPointIsSafe, phaserSegmentIsSafe, joinPhaserRoute, type PhaserOfficeConfig } from "./phaser-office-model";

const config: PhaserOfficeConfig = { grid: 8, margin: 32, aisle: 64, corridor: 96, roomHeight: 232, smallWidth: 272, mediumWidth: 304, largeWidth: 336, foyer: 112, outside: 96, tableWidth: 90, tableDepth: 24, chairWidth: 24, chairDepth: 16, radius: 8, wall: 12, doorWidth: 64 };
const agent = (id: string, reportsTo: string | null): OfficeAgent => ({ id, reportsTo, companyId: "a", name: id, title: null, role: "general", status: "idle" });
const staff = (n: number) => [agent("root", null), agent("manager", "root"), ...Array.from({ length: n - 1 }, (_, i) => agent("worker" + i, "manager"))];

describe("Phaser office compact modules", () => {
  it("keeps the axis connection when dropping a route's first cell would cut a furniture corner", () => {
    const original = buildPhaserOffice(buildOfficeDepartments(staff(4), "a"), {}, config);
    const model = { ...original, radius: 0, blocked: [{ x: 0, y: 0, width: 36, height: 24, kind: "furniture" }], walkable: Array.from({ length: 64 }, () => Array<boolean>(64).fill(true)) };
    const from = { x: 35, y: 28 }, route = [{ x: 36, y: 28 }, { x: 36, y: 20 }];
    expect(phaserPointIsSafe(model, route[1])).toBe(true);
    expect(phaserSegmentIsSafe(model, from, route[1])).toBe(false);
    expect(joinPhaserRoute(model, from, route)).toEqual(route);
    expect(phaserSegmentIsSafe(model, from, route[0])).toBe(true);
  });
  it("checks the continuous foot point when new furniture occupies part of an old grid cell", () => {
    const model = buildPhaserOffice(buildOfficeDepartments(staff(4), "a"), {}, config);
    const changed = { ...model, blocked: [{ x: 204, y: 200, width: 32, height: 16, kind: "chair" }], walkable: Array.from({ length: 64 }, () => Array<boolean>(64).fill(true)) };
    expect(phaserPointIsSafe(changed, { x: 196, y: 204 })).toBe(true);
    expect(phaserPointIsSafe(changed, { x: 199, y: 204 })).toBe(false);
  });
  it("uses shallow rooms and a connected corridor below every module row", () => {
    const people = [agent("root", null), ...Array.from({ length: 8 }, (_, i) => [agent("m" + i, "root"), ...Array.from({ length: i % 7 }, (_, k) => agent("w" + i + "-" + k, "m" + i))]).flat()];
    const model = buildPhaserOffice(buildOfficeDepartments(people, "a"), {}, config);
    for (const r of model.rooms) {
      expect(r.height).toBe(232);
      expect(r.door.y).toBe(r.y + r.height);
      expect(findPhaserPath(model, model.entrance, r.door).length, r.id + " " + JSON.stringify(r.door)).toBeGreaterThan(0);
      for (const s of r.seats) expect(findPhaserPath(model, model.entrance, s.walk).length, JSON.stringify({ id: s.agent.id, room: r.id, walk: s.walk })).toBeGreaterThan(0);
    }
  });
  it("adds an annex instead of moving old local workstations on growth", () => {
    const before = buildPhaserOffice(buildOfficeDepartments(staff(4), "a"), {}, config);
    const after = buildPhaserOffice(buildOfficeDepartments(staff(5), "a"), before.slots, config);
    for (const s of before.seats) {
      const next = after.seats.find(x => x.agent.id === s.agent.id)!;
      expect([next.x, next.y]).toEqual([s.x, s.y]);
    }
    expect(after.rooms.length).toBe(before.rooms.length + 1);
  });
  it("keeps existing modules in place when a large new department joins", () => {
    const before = buildPhaserOffice(buildOfficeDepartments(staff(4), "a"), {}, config);
    const newcomers = [agent("new-manager", "root"), ...Array.from({ length: 8 }, (_, i) => agent("new-worker" + i, "new-manager"))];
    const after = buildPhaserOffice(buildOfficeDepartments([...staff(4), ...newcomers], "a"), before.slots, config);
    for (const s of before.seats) expect([after.seats.find(a => a.agent.id === s.agent.id)!.x, after.seats.find(a => a.agent.id === s.agent.id)!.y]).toEqual([s.x, s.y]);
  });
  it("keeps scenery clear of the entrance and checks ground occupancy instead of sprite height", () => {
    const model = buildPhaserOffice(buildOfficeDepartments(staff(8), "a"), {}, config);
    expect(findPhaserPath(model, model.entrance, model.lounge).length).toBeGreaterThan(0);
    const seat = model.seats[0];
    expect(model.blocked.some(r => r.kind === "desk" && r.height === 24)).toBe(true);
    expect(findPhaserPath(model, model.entrance, seat.walk).every(p => model.walkable[Math.floor(p.y / 8)]?.[Math.floor(p.x / 8)])).toBe(true);
    const walls = model.blocked.filter(r => r.kind === "wall");
    for (let y = 0; y < model.walkable.length; y++) for (let x = 0; x < model.walkable[y].length; x++) if (model.walkable[y][x]) {
      const px = (x + .5) * config.grid, py = (y + .5) * config.grid;
      expect(walls.some(r => px + config.radius > r.x && px - config.radius < r.x + r.width && py + config.radius > r.y && py - config.radius < r.y + r.height)).toBe(false);
    }
  });
  it("registers every rendered solid decoration and keeps outside employees clear of hedges", () => {
    const people = [...staff(4), ...Array.from({ length: 6 }, (_, i) => ({ ...agent("away" + i, "root"), status: "paused" as const }))];
    const model = buildPhaserOffice(buildOfficeDepartments(people, "a"), {}, config);
    expect(model.props.some(p => p.id === "bookcase")).toBe(true);
    expect(model.props.some(p => p.id === "hedge")).toBe(true);
    expect(model.props.filter(p => p.blocks).every(p => model.blocked.includes(p.ground))).toBe(true);
    for (const point of Object.values(model.outsideSlots)) {
      expect(point.y).toBeGreaterThan(model.outsideY);
      expect(phaserPointIsSafe(model, point)).toBe(true);
      expect(findPhaserPath(model, model.entrance, point).length).toBeGreaterThan(0);
    }
  });
  it("assigns applicants separate reachable waiting positions inside the foyer", () => {
    const people = [...staff(4), ...Array.from({ length: 16 }, (_, i) => ({ ...agent("candidate" + i, "root"), status: "pending_approval" as const }))];
    const model = buildPhaserOffice(buildOfficeDepartments(people, "a"), {}, config);
    const points = Object.values(model.applicantSlots);
    expect(points).toHaveLength(16);
    expect(new Set(points.map(p => p.x + ":" + p.y)).size).toBe(16);
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(model.foyerY);
      expect(point.y).toBeLessThan(model.outsideY);
      expect(phaserPointIsSafe(model, point)).toBe(true);
      expect(findPhaserPath(model, model.entrance, point).length).toBeGreaterThan(0);
    }
  });
});
