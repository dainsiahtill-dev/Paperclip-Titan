// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readPhaserOfficeConfig } from "./phaser-office-theme";
import { buildPhaserOffice, findPhaserPath } from "./phaser-office-model";
import { buildOfficeDepartments, type OfficeAgent } from "./pixel-office";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.css"), "utf8");
beforeEach(() => {
  document.documentElement.removeAttribute("style");
  for (const match of css.matchAll(/--po-([a-z-]+):\s*([^;]+);/g)) document.documentElement.style.setProperty("--po-" + match[1], match[2].trim());
});
const staff: OfficeAgent[] = Array.from({ length: 4 }, (_, i) => ({ id: "person" + i, reportsTo: i ? "person0" : null, companyId: "company", name: "person" + i, title: null, role: "general", status: "idle" }));

describe("office wall header clearance", () => {
  it("expands a short configured room to keep monitors below a taller wall and leaves desks reachable", () => {
    document.documentElement.style.setProperty("--po-room-height", "256");
    document.documentElement.style.setProperty("--po-wall-rise", "96");
    const config = readPhaserOfficeConfig();
    const model = buildPhaserOffice(buildOfficeDepartments(staff, "company"), {}, config);
    for (const room of model.rooms) for (const seat of room.seats) {
      // 12 cap + 96 plaster + 16 clear floor before the monitor.
      expect(seat.y - room.y - 48 - 20).toBeGreaterThanOrEqual(124);
      expect(findPhaserPath(model, model.entrance, seat.walk).length).toBeGreaterThan(0);
    }
  });
  it("keeps larger user-configured rooms rather than squeezing them back to the header minimum", () => {
    document.documentElement.style.setProperty("--po-room-height", "432");
    expect(readPhaserOfficeConfig().roomHeight).toBe(432);
  });
});
