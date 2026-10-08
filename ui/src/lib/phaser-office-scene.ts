import type Phaser from "phaser";
import { i18n, v3t } from "@/i18n";
import { officeStableHash, type OfficeAgent, type OfficePoint, type OfficePresence } from "./pixel-office";
import { findPhaserPath, nearestPhaserWalk, phaserPointIsSafe, phaserSegmentIsSafe, joinPhaserRoute, type PhaserOfficeModel, type PhaserSeat } from "./phaser-office-model";
import { phaserAnimationFrame, phaserWalkFrame, officeHasMotion, selectPhaserAnimation } from "./phaser-office-animation";
import { holdOfficePose, selectOfficeIdleBreaks } from "./phaser-office-idle";
import { cropOfficePart, maskOfficeRegions, placeOfficeFrame, renderOfficeGait } from "./phaser-office-rig";
import type { PhaserOfficeTheme } from "./phaser-office-theme";
import { officeParkLayout, constrainOfficeCamera, type OfficeCameraView } from "./phaser-office-camera";
import { officeTextProjection, officeActorTextAnchor, type OfficeWorldText, type OfficeTextViewport } from "./phaser-office-text";
import { officeNpcAction, type OfficeAssets, type OfficeDirection, type OfficeFrame } from "../components/pixel-office/types";
import { visibleOfficeWorkOutput, type OfficeWorkOutput } from "./phaser-office-progress";

export interface PhaserOfficeState { model: PhaserOfficeModel; presences: Map<string, OfficePresence>; workOutputs?: ReadonlyMap<string, OfficeWorkOutput>; workRunIds?: ReadonlyMap<string, string>; showActivities?: boolean; selectedId: string | null; department: string; paused: boolean }
export interface PhaserOfficeController { update(state: PhaserOfficeState): void; resize(width: number, height: number): void; zoomBy(delta: number): void; fit(): void }
export function phaserDepartmentName(d: PhaserOfficeModel["rooms"][number]["department"]): string {
  return d.id === "management" ? v3t("office.management") : d.id === "unassigned" ? v3t("office.unassigned") : d.manager?.name ?? v3t("office.department");
}
const texture = (src: string) => "office:" + src;
interface Actor {
  speech?: { output: OfficeWorkOutput; locale: string; text: string };
  agent: OfficeAgent; presence: OfficePresence; seat?: PhaserSeat; target: OfficePoint; goal: OfficePoint; point: OfficePoint; path: OfficePoint[]; cursor: number; seated: boolean; patrol: boolean; signature: string; direction: OfficeDirection; breakKind?: "coffee" | "stretch"; breakUntil: number; restReadyAt: number; returning: boolean; walkDistance: number; movingNow: boolean; blockedMs: number; chairBlend: number; chairSeat?: PhaserSeat; poseKey: string; poseStarted: number; posture: string; motionMode: string;
  legGraphics: Phaser.GameObjects.Graphics; shins: Phaser.GameObjects.Image[]; shoes: Phaser.GameObjects.Image[]; mug: Phaser.GameObjects.Image; ghost: Phaser.GameObjects.Image; maskGraphics: Phaser.GameObjects.Graphics; bodyMask: Phaser.Display.Masks.GeometryMask; body: Phaser.GameObjects.Image; head: Phaser.GameObjects.Image; hands: Phaser.GameObjects.Image[]; hit: Phaser.GameObjects.Zone; label: OfficeWorldText; bubble: OfficeWorldText; ring: Phaser.GameObjects.Ellipse;
}

export function createPhaserOfficeScene(P: typeof Phaser, assets: OfficeAssets, theme: PhaserOfficeTheme, initial: PhaserOfficeState, callbacks: { ready(controller: PhaserOfficeController): void; select(id: string): void; zoom(value: number): void; error(message: string): void; text?(labels: OfficeWorldText[], viewport: OfficeTextViewport): void }) {
  return class OfficeScene extends P.Scene {
    state = initial;
    actors = new Map<string, Actor>();
    worldTexts = new Map<string, OfficeWorldText>();
    furniture: Phaser.GameObjects.GameObject[] = [];
    parkFurniture: Phaser.GameObjects.GameObject[] = [];
    parkLayout: ReturnType<typeof officeParkLayout> | null = null;
    stations = new Map<string, { screen: Phaser.GameObjects.Image; front: Phaser.GameObjects.Image; back: Phaser.GameObjects.Image; arms: Phaser.GameObjects.Image[] }>();
    clock = 0;
    idleBucket = -1;
    revision = "";
    fitted = false;
    dragging = false;
    dragStart = { x: 0, y: 0, scrollX: 0, scrollY: 0 };
    failed: string[] = [];

    constructor() { super("paperclip-office"); }
    preload() {
      const urls = new Set([...Object.values(assets.sprites).map(a => a.src), ...Object.values(assets.animations).flatMap(a => a.frames.map(f => f.src))]);
      for (const src of urls) this.load.image(texture(src), src);
      this.load.on("loaderror", (file: { src: string }) => this.failed.push(file.src));
    }
    create() {
      if (this.failed.length) { callbacks.error(v3t("office.loadError") + " (" + this.failed.length + ")"); return; }
      this.cameras.main.setRoundPixels(true);
      this.input.on("pointerdown", (p: Phaser.Input.Pointer) => { this.dragging = false; this.dragStart = { x: p.x, y: p.y, scrollX: this.cameras.main.scrollX, scrollY: this.cameras.main.scrollY }; });
      this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (!p.isDown) return;
        const dx = p.x - this.dragStart.x, dy = p.y - this.dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > theme.n("scene-padding") / 2) this.dragging = true;
        if (this.dragging) this.panTo(this.dragStart.scrollX - dx / this.cameras.main.zoom, this.dragStart.scrollY - dy / this.cameras.main.zoom);
      });
      this.input.on("wheel", (_p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => this.zoomBy(-Math.sign(dy) * theme.n("zoom-step")));
      this.applyState(initial);
      callbacks.ready({ update: s => this.applyState(s), resize: (w, h) => this.resizeView(w, h), zoomBy: d => this.zoomBy(d), fit: () => { this.fitted = false; this.focusDepartment(); } });
      if (import.meta.env.DEV) Object.assign(window, { __pixelOfficePhaser: this });
      const clearDebugScene = () => { if ((window as unknown as { __pixelOfficePhaser?: unknown }).__pixelOfficePhaser === this) delete (window as unknown as { __pixelOfficePhaser?: unknown }).__pixelOfficePhaser; };
      this.events.once("shutdown", clearDebugScene);
      this.events.once("destroy", clearDebugScene);
      const publishText = () => this.publishText();
      const clearText = () => { this.events.off(P.Scenes.Events.RENDER, publishText); callbacks.text?.([], { width: 0, height: 0 }); };
      this.events.on(P.Scenes.Events.RENDER, publishText);
      this.events.once("shutdown", clearText);
      this.events.once("destroy", clearText);
    }
    applyState(state: PhaserOfficeState) {
      const geometryChanged = this.revision !== state.model.revision;
      const focusChanged = this.state.department !== state.department;
      this.state = state;
      if (geometryChanged) {
        this.revision = state.model.revision;
        for (const item of this.furniture) item.destroy();
        this.furniture = []; this.stations.clear(); this.worldTexts.clear();
        this.drawOffice();
        this.updatePark();
      }
      this.refreshTexts();
      this.syncActors();
      if (geometryChanged && !this.fitted || focusChanged) { this.fitted = false; this.focusDepartment(); }
      else if (geometryChanged) this.applyCamera(this.cameraView());
      this.paintActors();
    }
    refreshTexts() {
      for (const room of this.state.model.rooms) {
        const label = this.worldTexts.get("department:" + room.id);
        if (label) label.text = phaserDepartmentName(room.department) + (room.id.endsWith("#0") ? "" : " · " + v3t("office.annex"));
      }
      const outside = this.worldTexts.get("outside");
      if (outside) outside.text = v3t("office.outside");
    }
    focusDepartment() {
      const rooms = this.state.model.rooms.filter(r => r.department.id === this.state.department);
      if (!rooms.length) { this.fit(); return; }
      const left = Math.min(...rooms.map(r => r.x)), top = Math.min(...rooms.map(r => r.y)), right = Math.max(...rooms.map(r => r.x + r.width)), bottom = Math.max(...rooms.map(r => r.y + r.height));
      const pad = theme.n("scene-padding") * 4;
      const zoom = Math.min(theme.n("zoom-fit"), this.scale.width / (right - left + pad), this.scale.height / (bottom - top + pad));
      this.applyCamera({ x: (left + right) / 2, y: (top + bottom) / 2, zoom });
    }
    fit() {
      this.updatePark();
      this.applyCamera(this.parkLayout!.overview);
      this.fitted = false;
    }
    zoomBy(delta: number) {
      const view = this.cameraView();
      this.applyCamera({ ...view, zoom: view.zoom + delta }); this.fitted = true;
    }
    cameraView(): OfficeCameraView {
      const camera = this.cameras.main;
      // midPoint is refreshed during preRender; current scroll also works for
      // several input events arriving before the next rendered frame.
      return { x: camera.scrollX + camera.width / 2, y: camera.scrollY + camera.height / 2, zoom: camera.zoom };
    }
    publishText() {
      if (!callbacks.text) return;
      const camera = this.cameras.main;
      const viewport = { width: this.scale.width, height: this.scale.height };
      const project = officeTextProjection(camera);
      const referenceZoom = theme.n("text-reference-zoom"), textScale = camera.zoom / referenceZoom;
      const labels: OfficeWorldText[] = [];
      const source = [...this.worldTexts.values()];
      for (const a of this.actors.values()) {
        const room = this.state.model.rooms.find(r => r.id === a.seat?.module);
        const repeatsRoomName = room && a.label.text === phaserDepartmentName(room.department) && a.point.x >= room.x && a.point.x <= room.x + room.width && a.point.y >= room.y && a.point.y <= room.y + room.height;
        if (!repeatsRoomName) source.push(a.label);
        source.push(a.bubble);
      }
      for (const label of source) {
        if (label.visible === false || !label.text) continue;
        // RENDER follows camera.preRender, so this matrix includes this frame's
        // zoom, bounds clamping and pixel rounding rather than a stale midpoint.
        const point = project(label.x, label.y);
        if (label.kind !== "department" && label.kind !== "sign" && (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)) continue;
        const maxWidth = Math.min(label.maxWidth ?? theme.n("text-max-width"), (label.maxWorldWidth ?? Infinity) * referenceZoom);
        labels.push({ ...label, x: point.x, y: point.y + (label.referenceOffsetY ?? 0) * textScale, maxWidth, scale: textScale });
      }
      callbacks.text(labels, viewport);
    }
    applyCamera(view: OfficeCameraView) {
      if (!this.parkLayout) this.updatePark();
      const camera = this.cameras.main, layout = this.parkLayout!;
      const constrained = constrainOfficeCamera(layout.bounds, camera, view, Math.min(theme.n("zoom-min"), layout.overview.zoom), theme.n("zoom-max"));
      camera.setZoom(constrained.zoom).centerOn(constrained.x, constrained.y);
      // Phaser otherwise waits until preRender to clamp a zoom/scroll change.
      camera.setScroll(camera.clampX(camera.scrollX), camera.clampY(camera.scrollY));
      callbacks.zoom(constrained.zoom);
    }
    panTo(scrollX: number, scrollY: number) {
      const camera = this.cameras.main;
      this.applyCamera({ x: scrollX + camera.width / 2, y: scrollY + camera.height / 2, zoom: camera.zoom });
      this.fitted = true;
    }
    resizeView(width: number, height: number) {
      if (!(width > 0 && height > 0)) return;
      const view = this.cameraView();
      this.scale.resize(width, height);
      this.cameras.main.setSize(width, height);
      this.updatePark();
      if (this.fitted) this.applyCamera(view);
      else this.focusDepartment();
    }
    updatePark() {
      const next = officeParkLayout(this.state.model, this.cameras.main, theme.n("park-margin"), theme.n("park-overview-margin"), theme.n("zoom-fit"));
      const changed = !this.parkLayout || JSON.stringify(next.bounds) !== JSON.stringify(this.parkLayout.bounds);
      this.parkLayout = next;
      if (changed) {
        for (const item of this.parkFurniture) item.destroy();
        this.parkFurniture = [];
        this.drawPark();
      }
      const b = next.bounds;
      this.cameras.main.setBounds(b.x, b.y, b.width, b.height);
    }
    drawPark() {
      const m = this.state.model, b = this.parkLayout!.bounds;
      const inset = theme.n("scene-padding"), pixel = theme.n("park-pixel");
      const g = this.add.graphics().setDepth(-2); this.parkFurniture.push(g);
      g.fillStyle(theme.color("grass")).fillRect(b.x, b.y, b.width, b.height);
      const step = theme.n("park-grass-step") * Math.max(1, Math.ceil(Math.max(b.width / m.width, b.height / m.height) / 2));
      for (let y = b.y + inset; y < b.y + b.height - inset; y += step) for (let x = b.x + inset; x < b.x + b.width - inset; x += step) {
        if (x >= 0 && x <= m.width && y >= 0 && y <= m.height) continue;
        const seed = officeStableHash(Math.round(x) + ":" + Math.round(y));
        g.fillStyle(theme.color(seed % 2 ? "grass-light" : "grass-dark"));
        const px = x + seed % (step / 2), py = y + (seed % (step / 2));
        g.fillRect(px, py, pixel, pixel * 2).fillRect(px + pixel * 2, py + pixel, pixel, pixel);
      }
      // Only scattered flowers near the office. Camera bounds stay invisible.
      const garden = theme.n("park-margin") / 3;
      const patches = [
        { x: -garden, y: m.height / 4 }, { x: -garden, y: m.height * 3 / 4 },
        { x: m.width + garden, y: m.height / 3 }, { x: m.width + garden, y: m.height * 3 / 4 },
        { x: m.width / 4, y: -garden }, { x: m.width * 3 / 4, y: -garden },
        { x: m.width / 4, y: m.height + garden }, { x: m.width * 3 / 4, y: m.height + garden },
      ];
      for (const [index, patch] of patches.entries()) for (const bloom of [-1, 0, 1]) {
        const x = patch.x + bloom * pixel * 5, y = patch.y + (bloom === 0 ? -pixel * 2 : pixel);
        g.fillStyle(theme.color("grass-dark")).fillRect(x, y, pixel, pixel * 4);
        g.fillRect(x - pixel * 2, y + pixel * 2, pixel * 2, pixel).fillRect(x + pixel, y + pixel * 3, pixel * 2, pixel);
        g.fillStyle(theme.color((index + bloom) % 2 ? "flower-pink" : "flower-gold"));
        g.fillRect(x - pixel, y - pixel * 3, pixel * 3, pixel);
        g.fillRect(x - pixel * 2, y - pixel * 2, pixel * 5, pixel);
        g.fillRect(x - pixel, y - pixel, pixel * 3, pixel);
        g.fillStyle(theme.color("paper")).fillRect(x, y - pixel * 2, pixel, pixel);
      }
    }
    keep<T extends Phaser.GameObjects.GameObject>(item: T): T { this.furniture.push(item); return item; }
    prop(id: string, x: number, y: number, width: number, depth: number) {
      const art = assets.sprites[id];
      return this.keep(this.add.image(x, y, texture(art.src)).setOrigin(0).setDisplaySize(width, width * art.physicalSize[1] / art.physicalSize[0]).setDepth(depth));
    }
    text(label: string, x: number, y: number, _depth: number, small = false, id = "sign:" + this.worldTexts.size, kind: OfficeWorldText["kind"] = "sign", maxWidth = theme.n("text-max-width")) {
      const item: OfficeWorldText = { id, text: label, x, y, anchor: "top", kind, small, maxWidth };
      this.worldTexts.set(id, item);
      return item;
    }
    floor(g: Phaser.GameObjects.Graphics, r: { x: number; y: number; width: number; height: number }, color: string, tiled = false) {
      const tile = theme.n("tile");
      g.fillStyle(theme.color(color)).fillRect(r.x, r.y, r.width, r.height);
      g.lineStyle(theme.n("scene-line"), theme.color(tiled ? "stone-line" : "floor-line"), .55);
      for (let y = r.y; y < r.y + r.height; y += tile / 2) { g.lineBetween(r.x, y, r.x + r.width, y); for (let x = r.x + (Math.floor(y / tile) % 2 ? tile : 0); x < r.x + r.width; x += tile * (tiled ? 1 : 3)) g.lineBetween(x, y, x, Math.min(y + tile / 2, r.y + r.height)); }
    }
    wall(x: number, y: number, width: number, height: number, depth: number, north = false) {
      const g = this.keep(this.add.graphics().setDepth(depth)), wall = theme.n("wall"), rise = north ? theme.n("wall-rise") : 0;
      if (rise) g.fillStyle(theme.color("plaster")).fillRect(x, y, width, rise + height);
      g.fillStyle(theme.color("wall-edge")).fillRect(x, y, width, height);
      g.fillStyle(theme.color("wall-cap")).fillRect(x + theme.n("scene-line"), y + theme.n("scene-line"), Math.max(0, width - theme.n("scene-line") * 2), Math.max(0, height - theme.n("scene-line") * 2));
      if (width > wall * 2) { g.lineStyle(theme.n("scene-line"), theme.color("stone-line"), .35); for (let a = x + theme.n("tile"); a < x + width; a += theme.n("tile")) g.lineBetween(a, y, a, y + height); }
    }
    drawOffice() {
      const m = this.state.model, wall = theme.n("wall"), pad = theme.n("scene-padding");
      const ground = this.keep(this.add.graphics().setDepth(-1));
      ground.fillStyle(theme.color("grass")).fillRect(0, 0, m.width, m.height);
      this.floor(ground, { x: wall, y: wall, width: m.width - wall * 2, height: m.outsideY - wall }, "floor");
      this.floor(ground, { x: wall, y: m.foyerY, width: m.width - wall * 2, height: m.height - m.foyerY }, "stone", true);
      for (const room of m.rooms) {
        const muted = this.state.department !== "all" && this.state.department !== room.department.id;
        this.floor(ground, room, ["sand", "sage", "rose", "floor"][officeStableHash(room.department.id) % 4]);
        if (muted) ground.fillStyle(theme.color("paper"), .35).fillRect(room.x, room.y, room.width, room.height);
        this.wall(room.x, room.y, room.width, wall, room.y + wall, true);
        this.wall(room.x, room.y, wall, room.height, room.y + room.height - wall);
        this.wall(room.x + room.width - wall, room.y, wall, room.height, room.y + room.height - wall);
        const gap = theme.n("door-w"), south = room.y + room.height - wall;
        this.wall(room.x, south, room.width / 2 - gap / 2, wall, room.door.y);
        this.wall(room.door.x + gap / 2, south, room.width / 2 - gap / 2, wall, room.door.y);
        this.prop("door_south_open", room.door.x - gap / 2, south - wall, gap, room.door.y + 1);
        const plaque = this.text(phaserDepartmentName(room.department) + (room.id.endsWith("#0") ? "" : " · " + v3t("office.annex")), room.x + room.width / 2, room.y + wall + theme.n("wall-rise") / 2, room.y + theme.n("wall-rise"), false, "department:" + room.id, "department");
        plaque.anchor = "center";
        plaque.maxWorldWidth = room.width - wall * 2;
        for (const seat of room.seats) this.drawStation(seat);
      }
      for (const prop of m.props) this.prop(prop.id, prop.x, prop.y, prop.width, prop.ground.y + prop.ground.height);
      const reception = m.props.find(p => p.id === "reception_desk")!;
      this.text("Paperclip", reception.x + reception.width / 2, reception.y, reception.ground.y + reception.ground.height + 1, false, "reception");
      this.prop("entrance_open", m.entrance.x - theme.n("door-w") / 2, m.outsideY - theme.n("door-w") / 2, theme.n("door-w"), m.outsideY);
      this.wall(wall, m.outsideY - wall, m.entrance.x - theme.n("door-w") / 2 - wall, wall, m.outsideY);
      this.wall(m.entrance.x + theme.n("door-w") / 2, m.outsideY - wall, m.width - m.entrance.x - theme.n("door-w") / 2 - wall, wall, m.outsideY);
      this.text(v3t("office.outside"), m.entrance.x, m.height - pad * 2, m.height, true, "outside");
    }
    crop(image: Phaser.GameObjects.Image, x: number, y: number, w: number, h: number) {
      const source = image.frame; image.setCrop(source.realWidth * x, source.realHeight * y, source.realWidth * w, source.realHeight * h); return image;
    }
    drawStation(s: PhaserSeat) {
      const desk = theme.n("desk-w"), chair = theme.n("chair-w"), monitor = theme.n("monitor-width"), base = s.y + 20;
      this.prop("chair_north", s.x - chair / 2, s.y - chair / 4, chair, base - .5);
      this.prop("desk_oak", s.x - desk / 2, s.y - desk / 2, desk, base - .4);
      const display = this.prop("monitor_body", s.x - monitor / 2, s.y - desk / 2 - monitor / 2, monitor, base - .3);
      const screen = this.prop("screen_off", display.x + monitor * .055, display.y + display.displayHeight * .095, monitor * .88, base - .2);
      screen.setDisplaySize(monitor * .88, display.displayHeight * .57);
      this.prop("keyboard", s.x - desk * .14, s.y - desk * .36, desk * .28, base - .2);
      this.prop("mouse", s.x + desk * .18, s.y - desk * .35, desk * .08, base - .2);
      this.prop("pc_tower", s.x - desk * .43, s.y - desk * .09, desk / 6, base - .2);
      const front = this.crop(this.prop("desk_oak", s.x - desk / 2, s.y - desk / 2, desk, base + .2), 0, theme.n("mask-desk-start"), 1, 1 - theme.n("mask-desk-start"));
      const back = this.crop(this.prop("chair_north", s.x - chair / 2, s.y - chair / 4, chair, base + .3), .12, 0, .76, theme.n("mask-back-end"));
      const arms = [0, 1 - theme.n("mask-arm-side")].map(x => this.crop(this.prop("chair_north", s.x - chair / 2, s.y - chair / 4, chair, base + .5), x, theme.n("mask-arm-start"), theme.n("mask-arm-side"), theme.n("mask-arm-end") - theme.n("mask-arm-start")));
      this.stations.set(s.agent.id, { screen, front, back, arms });
      const hit = this.keep(this.add.zone(s.x, s.y, desk, desk).setDepth(base + 1).setInteractive());
      hit.on("pointerup", () => { if (!this.dragging) callbacks.select(s.agent.id); });
    }
    destroyActor(a: Actor) { a.bodyMask.destroy(); for (const item of [a.body, a.head, ...a.hands, ...a.shins, ...a.shoes, a.legGraphics, a.mug, a.ghost, a.maskGraphics, a.hit, a.ring]) item.destroy(); }
    syncActors() {
      const m = this.state.model, visible = new Set<string>(), unique = new Map(m.rooms.flatMap(r => r.department.agents.map(a => [a.id, a] as const)));
      const departments = new Map(m.rooms.map(r => [r.id, r.department.id]));
      const breaks = selectOfficeIdleBreaks(m.seats.filter(s => this.state.presences.get(s.agent.id)?.action === "resting").map(s => ({ id: s.agent.id, department: departments.get(s.module)! })), this.clock, theme.n("idle-slot-ms"), theme.n("idle-visitors"));
      this.idleBucket = Math.floor(this.clock / theme.n("idle-slot-ms"));
      let outside = 0;
      for (const agent of unique.values()) {
        visible.add(agent.id);
        const presence = this.state.presences.get(agent.id); if (!presence) continue;
        const seat = m.seats.find(s => s.agent.id === agent.id), seed = officeStableHash(agent.id);
        const old = this.actors.get(agent.id);
        const resting = presence.action === "resting";
        let breakKind = resting && old && !old.returning ? old.breakKind : undefined;
        if (!breakKind && resting && !old?.returning && (!old || old.restReadyAt <= this.clock)) {
          const proposed = breaks.get(agent.id);
          const otherBreaks = [...this.actors.values()].filter(a => a.agent.id !== agent.id && a.presence.action === "resting" && a.breakKind);
          if (proposed && otherBreaks.length < theme.n("idle-visitors") && !(proposed === "coffee" && otherBreaks.some(a => a.breakKind === "coffee"))) breakKind = proposed;
        }
        const room = seat ? m.rooms.find(r => r.id === seat.module) : undefined;
        const away = ["away", "departed"].includes(presence.action);
        const seated = !!seat && (presence.action === "working" || presence.action === "waiting" || presence.action === "resting" && !breakKind);
        const restPoint = breakKind === "coffee" ? m.lounge : room ? { x: room.door.x + (seed % 2 ? 1 : -1) * theme.n("tile"), y: room.door.y + theme.n("idle-corridor-offset") } : m.lounge;
        const target = presence.action === "applicant" ? m.applicantSlots[agent.id] ?? m.entrance : away ? m.outsideSlots[agent.id] ?? m.entrance : seated ? seat!.walk : resting ? nearestPhaserWalk(m, restPoint) : seat?.walk ?? m.entrance;
        const signature = m.revision + ":" + presence.action + ":" + target.x + ":" + target.y;
        let actor = this.actors.get(agent.id);
        if (!actor) {
          const src = assets.animations[Object.keys(assets.animations)[0]].frames[0].src;
          const maskGraphics = this.add.graphics().setVisible(false);
          const images = Array.from({ length: 10 }, () => this.add.image(0, 0, texture(src)));
          actor = { agent, presence, seat, target, goal: target, point: { ...(presence.action === "resting" && seat ? seat.walk : target) }, path: [], cursor: 0, seated, patrol: false, signature: "", direction: "south", breakUntil: Infinity, restReadyAt: 0, returning: false, walkDistance: 0, movingNow: false, blockedMs: 0, chairBlend: seat && ["working", "waiting", "resting"].includes(presence.action) ? 1 : 0, chairSeat: seat, poseKey: "", poseStarted: this.clock, posture: "standing", motionMode: "keypose", legGraphics: this.add.graphics().setVisible(false), shins: images.slice(4, 6), shoes: images.slice(6, 8), ghost: images[8], mug: images[9], maskGraphics, bodyMask: maskGraphics.createGeometryMask(), body: images[0], head: images[1], hands: images.slice(2, 4), hit: this.add.zone(0, 0, theme.n("actor-scale") * theme.n("plant-w"), theme.n("actor-scale") * theme.n("plant-w") * 2).setOrigin(.5, 1).setInteractive(), label: { id: "employee:" + agent.id, text: "", x: 0, y: 0, anchor: "bottom", kind: "name", small: true, visible: false }, bubble: { id: "status:" + agent.id, text: "", x: 0, y: 0, anchor: "bottom", kind: "status", visible: false }, ring: this.add.ellipse(0, 0, theme.n("plant-w"), theme.n("plant-w") / 3, theme.color("floor-line"), .3) };
          actor.hit.on("pointerup", () => { if (!this.dragging) callbacks.select(agent.id); }); this.actors.set(agent.id, actor);
        }
        actor.agent = agent; actor.presence = presence; actor.seat = seat; actor.target = target; actor.seated = seated;
        if (breakKind && !actor.breakKind) actor.breakUntil = Infinity;
        actor.breakKind = breakKind;
        if (!resting) { actor.returning = false; actor.breakUntil = Infinity; }
        if (!actor.chairBlend && seat) actor.chairSeat = seat;
        if (actor.signature !== signature) {
          if (!phaserPointIsSafe(m, actor.point)) actor.point = nearestPhaserWalk(m, actor.point);
          actor.signature = signature; actor.cursor = 0; actor.patrol = presence.action === "walking";
          const end = actor.patrol ? nearestPhaserWalk(m, { x: m.entrance.x, y: m.foyerY + theme.n("scene-padding") }) : target;
          actor.goal = end;
          actor.path = findPhaserPath(m, geometryPoint(actor.point, m), end);
          if (!actor.patrol && actor.path.length === 1) actor.path = [];
        }
        const station = this.stations.get(agent.id);
        if (station) station.screen.setTexture(texture(assets.sprites["screen_" + presence.screen].src));
      }
      for (const [id, a] of this.actors) if (!visible.has(id)) { this.destroyActor(a); this.actors.delete(id); }
    }
    update(_time: number, delta: number) {
      if (this.failed.length || !this.revision) return;
      if (!this.state.paused) {
        const dt = Math.min(Math.max(0, delta), 100);
        this.clock += dt;
        if (Math.floor(this.clock / theme.n("idle-slot-ms")) !== this.idleBucket) this.syncActors();
        let resync = false;
        const ordered = [...this.actors.values()].sort((a, b) => a.agent.id.localeCompare(b.agent.id));
        for (const a of ordered) {
          a.movingNow = false;
          const arrived = a.cursor >= a.path.length && Math.hypot(a.point.x - a.target.x, a.point.y - a.target.y) < this.state.model.grid / 2;
          const wantsChair = a.seated && arrived;
          if (wantsChair) a.chairBlend = Math.min(1, a.chairBlend + dt / theme.n("seat-transition-ms"));
          else a.chairBlend = Math.max(0, a.chairBlend - dt / theme.n("seat-transition-ms"));
          if (a.chairBlend > 0) continue;
          let remaining = dt * theme.n("walk-speed") / 1000;
          while (remaining > 0 && a.cursor < a.path.length) {
            const next = a.path[a.cursor], dx = next.x - a.point.x, dy = next.y - a.point.y, distance = Math.hypot(dx, dy);
            if (distance < .001) { a.point = { ...next }; a.cursor++; continue; }
            const amount = Math.min(distance, remaining);
            const proposed = { x: a.point.x + dx / distance * amount, y: a.point.y + dy / distance * amount };
            if (!phaserSegmentIsSafe(this.state.model, a.point, proposed)) {
              const reroute = findPhaserPath(this.state.model, a.point, a.goal);
              a.path = joinPhaserRoute(this.state.model, a.point, reroute); a.cursor = 0; a.blockedMs = 0; break;
            }
            const blocker = ordered.find(other => other !== a && other.chairBlend < .5 && Math.hypot(proposed.x - other.point.x, proposed.y - other.point.y) < this.state.model.radius * 2 - .001);
            if (blocker) {
              a.blockedMs += dt;
              if (a.blockedMs >= theme.n("traffic-wait-ms")) {
                const avoids = ordered.filter(other => other !== a && other.chairBlend < .5).map(other => other.point);
                const reroute = findPhaserPath(this.state.model, a.point, a.goal, avoids, a.agent.id.localeCompare(blocker.agent.id) < 0 ? -1 : 1);
                if (reroute.length > 1) { a.path = joinPhaserRoute(this.state.model, a.point, reroute); a.cursor = 0; }
                a.blockedMs = 0;
              }
              break;
            }
            a.blockedMs = 0; a.movingNow = true; a.walkDistance += amount;
            a.direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "east" : "west" : dy > 0 ? "south" : "north";
            a.point = distance <= remaining ? { ...next } : proposed;
            remaining -= amount;
            if (distance <= amount) a.cursor++;
          }
          if (a.patrol && a.cursor >= a.path.length && a.path.length > 1) {
            a.goal = Math.hypot(a.goal.x - a.target.x, a.goal.y - a.target.y) < this.state.model.grid ? nearestPhaserWalk(this.state.model, { x: this.state.model.entrance.x, y: this.state.model.foyerY + theme.n("scene-padding") }) : a.target;
            a.path = findPhaserPath(this.state.model, a.point, a.goal); a.cursor = 0;
          }
          const atTarget = a.cursor >= a.path.length && Math.hypot(a.point.x - a.target.x, a.point.y - a.target.y) < this.state.model.grid / 2;
          if (a.breakKind && atTarget) {
            if (!Number.isFinite(a.breakUntil)) a.breakUntil = this.clock + theme.n("idle-dwell-ms");
            if (this.clock >= a.breakUntil) { a.breakKind = undefined; a.returning = true; a.restReadyAt = this.clock + theme.n("idle-slot-ms"); resync = true; }
          }
        }
        for (const a of ordered) if (a.returning && a.chairBlend === 1) { a.returning = false; resync = true; }
        if (resync) this.syncActors();
      }
      this.paintActors();
    }
    paintActors() {
      const now = Date.now();
      for (const a of this.actors.values()) {
        const moving = a.movingNow && a.chairBlend === 0;
        const seated = a.chairBlend === 1;
        const transitioning = a.chairBlend > 0 && a.chairBlend < 1;
        const pendingPath = a.cursor < a.path.length;
        a.posture = transitioning ? a.seated && !pendingPath ? "sitting" : "rising" : seated ? "seated" : "standing";
        const atTarget = Math.hypot(a.point.x - a.target.x, a.point.y - a.target.y) < this.state.model.grid / 2;
        const action = transitioning ? a.posture === "sitting" ? "sit_down" : "stand_up" : seated ? "typing_seated" : moving ? "walk" : pendingPath || a.breakKind && !atTarget ? "waiting" : a.seated ? "idle" : a.presence.action === "resting" && a.breakKind ? a.breakKind === "coffee" ? "loaf_coffee" : "loaf_stretch" : officeNpcAction(a.presence.action, officeStableHash(a.agent.id));
        const direction: OfficeDirection = a.chairBlend > 0 || a.presence.action === "resting" && a.breakKind === "coffee" && atTarget ? "north" : a.direction;
        let animation = selectPhaserAnimation(assets, a.agent.id, action, direction);
        const native = officeHasMotion(animation) && animation?.action === action;
        const poseKey = action + ":" + direction + ":" + (animation?.character ?? "");
        if (a.poseKey !== poseKey) { a.poseKey = poseKey; a.poseStarted = this.clock; }
        const elapsed = this.clock - a.poseStarted;
        let frame = moving ? phaserWalkFrame(animation, a.walkDistance, theme.n("gait-distance")) : phaserAnimationFrame(animation, elapsed, transitioning && native ? false : holdOfficePose(a.presence.action, moving, seated, action, animation));
        if (moving && !native && animation?.frames.length && animation.frames.length > 1) frame = animation.frames[Math.floor(a.walkDistance / theme.n("gait-distance") * 2) % animation.frames.length];
        if (transitioning && !native) {
          animation = selectPhaserAnimation(assets, a.agent.id, "idle", "north");
          frame = animation?.frames[0];
        }
        if (!frame) continue;
        const scale = frame.scale * theme.n("actor-scale");
        const seatedFrame = selectPhaserAnimation(assets, a.agent.id, "typing_seated", "north")?.frames[0];
        const chairSeat = a.chairSeat ?? a.seat;
        const seatedFoot = chairSeat && seatedFrame ? { x: chairSeat.x, y: chairSeat.y + theme.n("chair-w") * .45 + (seatedFrame.foot[1] - (seatedFrame.hip ?? seatedFrame.foot)[1]) * seatedFrame.scale * theme.n("actor-scale") } : a.point;
        const foot = { x: a.point.x + (seatedFoot.x - a.point.x) * a.chairBlend, y: a.point.y + (seatedFoot.y - a.point.y) * a.chairBlend };
        const anchor = seated && chairSeat ? { x: chairSeat.x, y: chairSeat.y + theme.n("chair-w") * .45 } : foot;
        const sourceAnchor = seated ? frame.hip ?? frame.foot : frame.foot;
        const depth = a.chairBlend > 0 && chairSeat ? chairSeat.y + 20 : a.point.y;
        const center = { x: anchor.x + (frame.size[0] / 2 - sourceAnchor[0]) * scale, y: anchor.y + (frame.size[1] / 2 - sourceAnchor[1]) * scale };
        a.legGraphics.setVisible(false); a.body.clearMask(); a.ghost.setVisible(false); a.mug.setVisible(false); [...a.shins, ...a.shoes].forEach(p => p.setVisible(false));
        placeOfficeFrame(a.body, frame, anchor, sourceAnchor, scale, depth + .1);
        a.motionMode = native ? "native" : "keypose";
        if (moving && !native) {
          if (renderOfficeGait(a.body, a.shins, a.shoes, frame, foot, scale, direction, a.walkDistance, depth, theme, { graphics: a.maskGraphics, mask: a.bodyMask, legs: a.legGraphics })) a.motionMode = "procedural_walk";
        }
        if (transitioning && !native && seatedFrame) {
          a.body.setAlpha(1 - a.chairBlend);
          const ghostScale = seatedFrame.scale * theme.n("actor-scale");
          placeOfficeFrame(a.ghost, seatedFrame, foot, seatedFrame.foot, ghostScale, depth + .15);
          a.ghost.setAlpha(a.chairBlend); a.motionMode = "procedural_transition";
        }
        if (seated) {
          placeOfficeFrame(a.head, frame, anchor, sourceAnchor, scale, depth + .6); this.crop(a.head, 0, 0, 1, theme.n("mask-head-end"));
          const proceduralTyping = a.presence.action === "working" && !native && !!frame.rig;
          if (proceduralTyping) { maskOfficeRegions(a.maskGraphics, frame, center, scale, frame.rig!.hands); a.body.setMask(a.bodyMask); a.motionMode = "procedural_typing"; }
          a.hands.forEach((hand, i) => {
            placeOfficeFrame(hand, frame, anchor, sourceAnchor, scale, depth + .4);
            if (proceduralTyping) {
              cropOfficePart(hand, frame, frame.rig!.hands[i]);
              hand.y -= (Math.floor(elapsed / (theme.n("typing-period-ms") / 2)) + i) % 2 * theme.n("typing-lift");
            } else this.crop(hand, i ? 1 - theme.n("mask-hand-side") : 0, theme.n("mask-hand-start"), theme.n("mask-hand-side"), theme.n("mask-hand-end") - theme.n("mask-hand-start"));
          });
        } else { a.head.setVisible(false); a.hands.forEach(h => h.setVisible(false)); }
        if (!moving && !seated && !transitioning && !native && !pendingPath && a.presence.action === "resting" && frame.rig) {
          const bob = Math.floor(elapsed / (theme.n("rest-period-ms") / 2)) % 2 * theme.n("rest-lift");
          a.body.y -= bob; a.motionMode = "procedural_rest";
          if (a.breakKind === "coffee") {
            const art = assets.sprites.coffee_machine;
            const rect: [number, number, number, number] = [theme.n("mug-source-x"), theme.n("mug-source-y"), theme.n("mug-source-w"), theme.n("mug-source-h")];
            const hand = frame.rig.hands[1];
            const handPoint = { x: center.x + (hand[0] + hand[2] / 2 - frame.size[0] / 2) * scale, y: center.y + (hand[1] + hand[3] / 2 - frame.size[1] / 2) * scale - bob };
            const mugFrame: OfficeFrame = { src: art.src, size: art.physicalSize, foot: [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2], scale: 1 };
            placeOfficeFrame(a.mug, mugFrame, handPoint, mugFrame.foot, theme.n("mug-size") / rect[2], depth + .4); cropOfficePart(a.mug, mugFrame, rect);
          }
        }
        if (!moving && !seated && !transitioning && !native && !pendingPath && a.presence.action === "error") {
          a.body.x += (Math.floor(elapsed / (theme.n("rest-period-ms") / 2)) % 2 ? 1 : -1) * theme.n("attention-shift"); a.motionMode = "procedural_attention";
        }
        const station = this.stations.get(a.agent.id);
        if (station) { const pulse = a.presence.screen === "working" || a.presence.screen === "waiting" ? theme.n("monitor-pulse-min") + (1 - theme.n("monitor-pulse-min")) * (Math.sin(this.clock / theme.n("monitor-pulse-ms") * Math.PI * 2) + 1) / 2 : 1; station.screen.setAlpha(pulse); station.front.setVisible(a.chairBlend > .2); station.back.setVisible(a.chairBlend > .2); station.arms.forEach(arm => arm.setVisible(a.chairBlend > .2)); }
        const selected = this.state.selectedId === a.agent.id;
        a.hit.setPosition(foot.x, foot.y + theme.n("scene-padding")).setDepth(depth + .8);
        a.ring.setPosition(foot.x, foot.y).setDepth(depth).setStrokeStyle(selected ? theme.n("scene-line") * 2 : 0, theme.color("ink"));
        const output = this.state.showActivities !== false ? visibleOfficeWorkOutput(this.state.workOutputs?.get(a.agent.id), a.agent.companyId, this.state.workRunIds?.get(a.agent.id), a.presence.action, now) : undefined;
        if (output) {
          const locale = i18n.resolvedLanguage ?? i18n.language;
          if (!a.speech || a.speech.output !== output || a.speech.locale !== locale) a.speech = { output, locale, text: output.text ?? v3t(output.toolKey!) };
        }
        const bubble = output ? a.speech!.text : "";
        const head = officeActorTextAnchor(seated ? a.head : a.body, frame, scale, transitioning && !native && seatedFrame ? { center: a.ghost, frame: seatedFrame, scale: seatedFrame.scale * theme.n("actor-scale"), blend: a.chairBlend } : undefined);
        const gap = theme.n("label-gap");
        Object.assign(a.label, { text: a.agent.name, x: head.x, y: head.y, referenceOffsetY: -gap, visible: selected && !bubble });
        Object.assign(a.bubble, { text: bubble, kind: "activity", title: a.agent.name + "\n" + bubble, tone: "working", agentId: a.agent.id, maxWidth: theme.n(selected ? "activity-detail-width" : "activity-max-width"), x: head.x, y: head.y, referenceOffsetY: -gap, visible: !!bubble });
      }
    }
  };
}
function geometryPoint(point: OfficePoint, model: PhaserOfficeModel) { return nearestPhaserWalk(model, point); }
