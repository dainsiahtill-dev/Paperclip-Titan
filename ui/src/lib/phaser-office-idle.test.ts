import { describe, expect, it } from "vitest";
import { holdOfficePose, selectOfficeIdleBreaks } from "./phaser-office-idle";
import type { OfficeAnimation } from "../components/pixel-office/types";

const employees = Array.from({ length: 16 }, (_, i) => ({ id: "person" + i, department: "department" + Math.floor(i / 4) }));
const clip = (action: string): OfficeAnimation => ({ action, character: "one", direction: "south", fps: 4, playback: "loop", frames: [], reviewStatus: "accepted" });
describe("idle office motion", () => {
  it("starts visible breaks immediately, reserves one coffee visitor, and selects distinct departments", () => {
    const breaks = selectOfficeIdleBreaks(employees, 0, 20_000, 3);
    expect(breaks.size).toBe(3);
    expect([...breaks.values()].filter(x => x === "coffee")).toHaveLength(1);
    expect(new Set([...breaks.keys()].map(id => employees.find(e => e.id === id)!.department)).size).toBe(3);
  });
  it("keeps the same routine during snapshot refresh and changes it only when the scene clock advances", () => {
    expect(selectOfficeIdleBreaks(employees, 500, 20_000, 3)).toEqual(selectOfficeIdleBreaks([...employees].reverse(), 500, 20_000, 3));
    expect(selectOfficeIdleBreaks(employees, 20_500, 20_000, 3)).not.toEqual(selectOfficeIdleBreaks(employees, 500, 20_000, 3));
    expect(selectOfficeIdleBreaks([], 500, 20_000, 3).size).toBe(0);
  });
  it("lets every employee take a turn even when department and team sizes share a divisor", () => {
    const company = Array.from({ length: 64 }, (_, i) => ({ id: "staff" + i, department: "team" + Math.floor(i / 8) }));
    const visited = new Set<string>();
    for (let bucket = 0; bucket < 64; bucket++) for (const id of selectOfficeIdleBreaks(company, bucket * 20_000, 20_000, 3).keys()) visited.add(id);
    expect(visited.size).toBe(company.length);
  });
  it("plays approved rest and error loops while keeping idle/waiting seated typing frozen", () => {
    expect(holdOfficePose("resting", false, false, "loaf_coffee", clip("loaf_coffee"))).toBe(false);
    expect(holdOfficePose("error", false, false, "error", clip("error"))).toBe(false);
    expect(holdOfficePose("resting", false, true, "typing_seated", clip("typing_seated"))).toBe(true);
    expect(holdOfficePose("waiting", false, true, "typing_seated", clip("typing_seated"))).toBe(true);
    expect(holdOfficePose("working", false, true, "typing_seated", clip("typing_seated"))).toBe(false);
    expect(holdOfficePose("resting", true, false, "walk", clip("idle"))).toBe(true);
    expect(holdOfficePose("away", false, false, "idle", clip("idle"))).toBe(true);
  });
});
