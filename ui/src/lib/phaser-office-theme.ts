import type { PhaserOfficeConfig } from "./phaser-office-model";

export function officeToken(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue("--po-" + name).trim(); }
export function officeNumber(name: string): number {
  const value = parseFloat(officeToken(name));
  if (!Number.isFinite(value)) throw new Error("Missing office token: " + name);
  return value;
}
export function readPhaserOfficeConfig(): PhaserOfficeConfig {
  const grid = officeNumber("grid"), wall = officeNumber("wall"), corridor = officeNumber("corridor"), padding = officeNumber("scene-padding");
  // The first monitor must start below the plaster face and its clear floor.
  // Seats are positioned relative to the room's south edge by the model.
  const minimumRoomHeight = wall + officeNumber("wall-rise") + padding + officeNumber("desk-w") / 2 + officeNumber("monitor-width") / 2 + corridor + grid * 6;
  const roomHeight = Math.max(officeNumber("room-height"), Math.ceil(minimumRoomHeight / grid) * grid);
  return { grid, margin: officeNumber("margin"), aisle: officeNumber("aisle"), corridor, roomHeight, smallWidth: officeNumber("room-small"), mediumWidth: officeNumber("room-medium"), largeWidth: officeNumber("room-large"), foyer: officeNumber("foyer"), outside: officeNumber("outside"), tableWidth: officeNumber("table-ground-w"), tableDepth: officeNumber("table-ground-d"), chairWidth: officeNumber("chair-ground-w"), chairDepth: officeNumber("chair-ground-d"), radius: officeNumber("foot-radius"), wall, doorWidth: officeNumber("door-w"), decor: { shelf: officeNumber("shelf-w"), board: officeNumber("board-w"), plant: officeNumber("plant-w"), sofa: officeNumber("sofa-w"), coffee: officeNumber("coffee-w"), reception: officeNumber("foyer-desk-w"), padding } };
}

export function readPhaserOfficeTheme() {
  const numbers = ["margin", "wall", "wall-rise", "tile", "desk-w", "chair-w", "monitor-width", "actor-scale", "walk-speed", "scene-font", "scene-small", "scene-line", "door-w", "scene-padding", "zoom-min", "zoom-max", "zoom-step", "zoom-fit", "sofa-w", "coffee-w", "plant-w", "shelf-w", "board-w", "foyer-desk-w", "mask-head-end", "mask-hand-start", "mask-hand-end", "mask-hand-side", "mask-back-end", "mask-arm-start", "mask-arm-end", "mask-arm-side", "mask-desk-start"];
  numbers.push("idle-slot-ms", "idle-visitors", "idle-corridor-offset");
  numbers.push("gait-distance", "gait-side-step", "gait-depth-step", "gait-lift", "gait-bob", "seat-transition-ms", "typing-period-ms", "typing-lift", "rest-period-ms", "rest-lift", "idle-dwell-ms", "traffic-wait-ms");
  numbers.push("mug-size", "mug-source-x", "mug-source-y", "mug-source-w", "mug-source-h", "attention-shift", "monitor-pulse-ms", "monitor-pulse-min");
  numbers.push("gait-overlap", "gait-back-shade", "gait-arm-swing");
  numbers.push("gait-leg-width", "gait-knee-bend");
  numbers.push("gait-hip-keep");
  numbers.push("gait-pelvis-height");
  numbers.push("park-margin", "park-overview-margin", "park-grass-step", "park-pixel", "label-gap", "text-max-width", "text-reference-zoom", "status-size");
  numbers.push("activity-height", "activity-max-width", "activity-detail-width");
  const values = Object.fromEntries(numbers.map(k => [k, officeNumber(k)]));
  const palette = ["paper", "ink", "muted", "floor", "floor-line", "sage", "rose", "sand", "stone", "stone-line", "plaster", "wall-cap", "wall-edge", "grass", "grass-light", "grass-dark", "flower-pink", "flower-gold"];
  const colors = Object.fromEntries(palette.map(k => [k, parseInt(officeToken(k).replace("#", ""), 16)]));
  return { n: (key: string) => values[key], color: (key: string) => colors[key], css: (key: string) => officeToken(key), font: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() };
}
export type PhaserOfficeTheme = ReturnType<typeof readPhaserOfficeTheme>;
