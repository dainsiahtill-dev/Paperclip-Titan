import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type Phaser from "phaser";
import { describe, expect, it, vi } from "vitest";
import { createPhaserOfficeScene } from "./phaser-office-scene";
import { buildPhaserOffice, type PhaserOfficeConfig } from "./phaser-office-model";
import { buildOfficeDepartments, type OfficeAgent } from "./pixel-office";
import { layoutOfficeText, officeTextProjection } from "./phaser-office-text";

// Only browser hardware detection is replaced; camera zoom, centerOn and clamp
// execute the installed Phaser implementation without opening a browser.
const require = createRequire(import.meta.url), device = require.resolve("phaser/src/device");
const previousDevice = require.cache[device];
require.cache[device] = { id: device, filename: device, loaded: true, exports: {} } as NodeModule;
const BaseCamera = require("phaser/src/cameras/2d/Camera");
if (previousDevice) require.cache[device] = previousDevice;
else delete require.cache[device];

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const n = (key: string) => {
  const value = parseFloat(css.match(new RegExp("--po-" + key + ":\\s*([^;]+)"))?.[1] ?? "");
  if (!Number.isFinite(value)) throw new Error("Missing theme number " + key);
  return value;
};
const config: PhaserOfficeConfig = { grid: 8, margin: 32, aisle: 64, corridor: 96, roomHeight: 256, smallWidth: 272, mediumWidth: 352, largeWidth: 448, foyer: 112, outside: 96, tableWidth: 90, tableDepth: 24, chairWidth: 24, chairDepth: 16, radius: 8, wall: 12, doorWidth: 64 };
const setup = (width: number, height: number, roomHeight = config.roomHeight) => {
  const people: OfficeAgent[] = [{ id: "root", reportsTo: null, companyId: "company", name: "root", title: null, role: "general", status: "idle" }, { id: "manager", reportsTo: "root", companyId: "company", name: "manager", title: null, role: "general", status: "idle" }, { id: "worker", reportsTo: "manager", companyId: "company", name: "worker", title: null, role: "general", status: "idle" }];
  const model = { ...buildPhaserOffice(buildOfficeDepartments(people, "company"), {}, { ...config, roomHeight }), width: 1280, height: 1040, revision: "initial" };
  const state = { model, presences: new Map(), selectedId: null, department: "all", paused: false };
  const zoom = vi.fn(), text = vi.fn();
  const Scene = createPhaserOfficeScene({ Scene: class {} } as unknown as typeof Phaser, { schemaVersion: 1, sprites: {}, animations: {}, characters: [] }, { n, color: () => 0, css: () => "", font: "" }, state, { ready: vi.fn(), select: vi.fn(), zoom, error: vi.fn(), text });
  const scene = new Scene(), camera = new BaseCamera(0, 0, width, height);
  Object.assign(scene, { cameras: { main: camera }, scale: { width, height, resize(w: number, h: number) { this.width = w; this.height = h; } } });
  // Rendering alone is omitted; all scene camera and state handlers stay real.
  scene.drawPark = () => {};
  scene.drawOffice = () => {};
  scene.fit();
  return { scene, camera, zoom, text };
};
const expectContained = (scene: ReturnType<typeof setup>["scene"], camera: InstanceType<typeof BaseCamera>) => {
  const b = scene.parkLayout!.bounds;
  const left = camera.scrollX + camera.width / 2 - camera.displayWidth / 2;
  const top = camera.scrollY + camera.height / 2 - camera.displayHeight / 2;
  expect(camera.useBounds).toBe(true);
  expect(left).toBeGreaterThanOrEqual(b.x - 1e-8);
  expect(top).toBeGreaterThanOrEqual(b.y - 1e-8);
  expect(left + camera.displayWidth).toBeLessThanOrEqual(b.x + b.width + 1e-8);
  expect(top + camera.displayHeight).toBeLessThanOrEqual(b.y + b.height + 1e-8);
};

describe("office scene with the real Phaser camera", () => {
  it.each([[1000, 650], [390, 450], [4000, 300], [300, 4000], [1000.5, 650.25]])("contains the view during repeated zoom and all-edge dragging at %s x %s", (width, height) => {
    const { scene, camera, zoom } = setup(width, height);
    for (let i = 0; i < 20; i++) scene.zoomBy(-.15);
    for (const x of [-1e6, 1e6]) for (const y of [-1e6, 1e6]) { scene.panTo(x, y); expectContained(scene, camera); }
    expect(zoom.mock.lastCall?.[0]).toBe(camera.zoom);
  });
  it("uses current scroll instead of the previous rendered midpoint during zoom", () => {
    const { scene, camera } = setup(1000, 650);
    camera.setZoom(1).setScroll(200, 150);
    scene.zoomBy(.15);
    expect(scene.cameraView().x).toBeCloseTo(700);
    expect(scene.cameraView().y).toBeCloseTo(475);
    expectContained(scene, camera);
  });
  it("preserves manual center and zoom when resizing and growing departments", () => {
    const { scene, camera } = setup(1000, 650);
    scene.applyCamera({ x: 640, y: 520, zoom: 1.5 }); scene.fitted = true;
    scene.resizeView(1400, 700);
    expect(scene.cameraView()).toEqual({ x: 640, y: 520, zoom: 1.5 });
    scene.applyState({ ...scene.state, model: { ...scene.state.model, height: 2000, revision: "growth" } });
    expect(scene.cameraView()).toEqual({ x: 640, y: 520, zoom: 1.5 });
    expectContained(scene, camera);
  });
  it("refits automatic views and ignores zero-sized observations", () => {
    const { scene, camera } = setup(1000, 650);
    scene.resizeView(390, 450);
    expect(scene.cameraView().zoom).toBeLessThan(1);
    expectContained(scene, camera);
    const before = scene.cameraView();
    scene.resizeView(0, 0);
    expect(scene.cameraView()).toEqual(before);
  });
  it("keeps an edge department visible without exposing outside the park", () => {
    const { scene, camera } = setup(1000, 650);
    const room = scene.state.model.rooms[0];
    scene.state = { ...scene.state, department: room.department.id };
    scene.focusDepartment();
    expectContained(scene, camera);
    const left = camera.scrollX + camera.width / 2 - camera.displayWidth / 2;
    const top = camera.scrollY + camera.height / 2 - camera.displayHeight / 2;
    expect(left).toBeLessThanOrEqual(room.x);
    expect(top).toBeLessThanOrEqual(room.y);
    expect(left + camera.displayWidth).toBeGreaterThanOrEqual(room.x + room.width);
    expect(top + camera.displayHeight).toBeGreaterThanOrEqual(room.y + room.height);
  });
  it.each([.5, 1, 2])("projects native text with the actual rendered camera matrix at zoom %s", zoom => {
    const { scene, camera, text } = setup(1000.5, 650.25);
    scene.text("部门标题", 640, 520, 0, false, "title", "department");
    scene.applyCamera({ x: 640, y: 520, zoom });
    camera.setRoundPixels(true); camera.preRender(); scene.publishText();
    const label = text.mock.lastCall?.[0][0];
    expect(label.text).toBe("部门标题");
    const world = camera.getWorldPoint(label.x, label.y);
    expect(world.x).toBeCloseTo(640, 6);
    expect(world.y).toBeCloseTo(520, 6);
    scene.panTo(1e6, 1e6); camera.preRender(); scene.publishText();
    const moved = text.mock.lastCall?.[0].find((item: { id: string }) => item.id === "title");
    if (moved) {
      const back = camera.getWorldPoint(moved.x, moved.y);
      expect(back.x).toBeCloseTo(640, 6);
      expect(back.y).toBeCloseTo(520, 6);
    }
  });
  it("updates a renamed department title even when the floor layout revision stays unchanged", () => {
    const { scene } = setup(1000, 650);
    const room = scene.state.model.rooms.find(r => r.department.manager)!;
    const id = "department:" + room.id;
    scene.text("old manager", room.x, room.y, 0, false, id, "department");
    scene.revision = scene.state.model.revision;
    const rooms = scene.state.model.rooms.map(r => r.department.id === room.department.id ? { ...r, department: { ...r.department, manager: { ...r.department.manager!, name: "新部门主管" } } } : r);
    scene.applyState({ ...scene.state, model: { ...scene.state.model, rooms } });
    expect(scene.worldTexts.get(id)?.text).toBe("新部门主管");
  });
  it("keeps partially visible department plaques for DOM clipping at the viewport edge", () => {
    const { scene, camera, text } = setup(1000, 650);
    camera.preRender();
    const point = camera.getWorldPoint(-2, 50);
    scene.text("部门牌", point.x, point.y, 0, false, "edge", "department");
    scene.publishText();
    expect(text.mock.lastCall?.[0].some((label: { id: string }) => label.id === "edge")).toBe(true);
  });
  it.each([232, 256])("centers department signs on the north wall face in %s-high rooms at every zoom", roomHeight => {
    const { scene, camera, text } = setup(1000, 650, roomHeight);
    const graphics: Record<string, unknown> = {};
    for (const method of ["setDepth", "fillStyle", "fillRect", "lineStyle", "lineBetween"]) graphics[method] = () => graphics;
    Object.assign(scene, { add: { graphics: () => graphics } });
    scene.prop = (() => ({})) as unknown as typeof scene.prop;
    scene.drawStation = () => {};
    Object.getPrototypeOf(scene).drawOffice.call(scene);
    const room = scene.state.model.rooms.find(r => r.seats.length)!;
    const widths: number[] = [];
    for (const zoom of [.5, 1, 2]) {
      scene.applyCamera({ x: room.x + room.width / 2, y: room.y + room.height / 2, zoom });
      camera.preRender(); scene.publishText();
      const label = text.mock.lastCall?.[0].find((l: { id: string }) => l.id === "department:" + room.id);
      expect(label.maxWidth).toBeGreaterThan(0);
      widths.push(label.maxWidth);
      const [box] = layoutOfficeText([{ ...label, width: 180, height: 22 }], { width: 1000, height: 650 }, 4);
      // Compare with the visible plaster face rather than the caption bottom.
      const center = camera.getWorldPoint(box.left + box.width / 2, box.top + box.height / 2);
      expect(center.x).toBeCloseTo(room.x + room.width / 2, 6);
      expect(center.y).toBeCloseTo(room.y + n("wall") + n("wall-rise") / 2, 6);
      expect(box.height).toBe(22);
    }
    expect(new Set(widths).size).toBe(1);
  });
  it.each([.2, .45, .47, .5, 1, 2])("scales the plaque with its wall and keeps monitors clear at zoom %s", zoom => {
    const { scene, camera, text } = setup(1000, 650, n("room-height"));
    const graphics: Record<string, unknown> = {};
    for (const method of ["setDepth", "fillStyle", "fillRect", "lineStyle", "lineBetween"]) graphics[method] = () => graphics;
    Object.assign(scene, { add: { graphics: () => graphics } });
    scene.prop = (() => ({})) as unknown as typeof scene.prop;
    scene.drawStation = () => {};
    Object.getPrototypeOf(scene).drawOffice.call(scene);
    const room = scene.state.model.rooms.find(r => r.seats.length)!;
    camera.setZoom(zoom).centerOn(room.x + room.width / 2, room.y + room.height / 2);
    camera.preRender(); scene.publishText();
    const label = text.mock.lastCall?.[0].find((l: { id: string }) => l.id === "department:" + room.id);
    expect(label.scale).toBeGreaterThan(0);
    const [box] = layoutOfficeText([{ ...label, width: 100 * label.scale, height: 22.2 * label.scale }], { width: 1000, height: 650 }, 4);
    const project = officeTextProjection(camera);
    const wallTop = project(room.x, room.y + n("wall")).y;
    const wallBottom = project(room.x, room.y + n("wall") + n("wall-rise")).y;
    const monitorTop = project(room.x, Math.min(...room.seats.map(s => s.y - 48 - 20))).y;
    expect(box.top).toBeGreaterThanOrEqual(wallTop);
    expect(box.top + box.height).toBeLessThanOrEqual(wallBottom);
    expect(box.top + box.height).toBeLessThan(monitorTop);
    const worldTop = camera.getWorldPoint(label.x, box.top), worldBottom = camera.getWorldPoint(label.x, box.top + box.height);
    // 22.2 CSS pixels at the 0.5 reference zoom occupy 44.4 world units.
    expect(worldBottom.y - worldTop.y).toBeCloseTo(44.4, 5);
  });
  it("does not repeat a manager's nameplate inside the identically named department, but restores it outside", () => {
    const { scene, camera, text } = setup(1000, 650);
    const room = scene.state.model.rooms.find(r => r.department.manager)!;
    const manager = room.department.manager!;
    scene.text(manager.name, room.x + room.width / 2, room.y, 0, false, "department:" + room.id, "department");
    const actor = { agent: manager, seat: room.seats.find(s => s.agent.id === manager.id), point: { x: room.x + 100, y: room.y + 100 }, label: { id: "name", text: manager.name, x: room.x + 100, y: room.y + 64, anchor: "bottom", kind: "name", visible: true }, bubble: { id: "status", text: "!", x: room.x + 116, y: room.y + 64, anchor: "bottom", kind: "status", visible: true } };
    scene.actors.set(manager.id, actor as never);
    camera.preRender(); scene.publishText();
    expect(text.mock.lastCall?.[0].filter((label: { text: string }) => label.text === manager.name)).toHaveLength(1);
    expect(text.mock.lastCall?.[0].some((label: { kind: string }) => label.kind === "status")).toBe(true);
    actor.point.y = room.door.y + 40;
    actor.label.y = actor.point.y - 64;
    scene.publishText();
    expect(text.mock.lastCall?.[0].some((label: { kind: string }) => label.kind === "name")).toBe(true);
  });
});
