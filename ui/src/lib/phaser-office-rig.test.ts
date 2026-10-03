import { describe, expect, it } from "vitest";
import { officeGaitTargets } from "./phaser-office-rig";
import { phaserWalkFrame } from "./phaser-office-animation";
import type { OfficeAnimation } from "../components/pixel-office/types";

describe("distance driven walking", () => {
  it("exchanges the front foot on both side views and raises only one passing foot", () => {
    for (const direction of ["east", "west"] as const) {
      const first = officeGaitTargets(direction, 0, 40, 6, 3, 2);
      const opposite = officeGaitTargets(direction, 20, 40, 6, 3, 2);
      expect(first[0].x - first[1].x).toBe(-(opposite[0].x - opposite[1].x));
      const passing = officeGaitTargets(direction, 10, 40, 6, 3, 2);
      expect(passing.filter(p => p.y < 0)).toHaveLength(1);
    }
  });
  it("alternates depth while keeping both front/back shoes in their own lateral lane", () => {
    for (const direction of ["north", "south"] as const) {
      const first = officeGaitTargets(direction, 0, 40, 6, 3, 2);
      const opposite = officeGaitTargets(direction, 20, 40, 6, 3, 2);
      expect(first[0].x).toBe(0);
      expect(first[0].y - first[1].y).toBe(-(opposite[0].y - opposite[1].y));
    }
  });
  it("native walk frames advance with movement, not a running scene clock", () => {
    const a: OfficeAnimation = { character: "one", direction: "east", action: "walk", fps: 6, playback: "loop", reviewStatus: "accepted", frames: Array.from({ length: 4 }, (_, i) => ({ src: String(i), size: [100, 100], foot: [50, 98], scale: 1 })) };
    expect(phaserWalkFrame(a, 0, 40)?.src).toBe("0");
    expect(phaserWalkFrame(a, 20, 40)?.src).toBe("2");
    expect(phaserWalkFrame(a, 40, 40)?.src).toBe("0");
    expect(phaserWalkFrame({ ...a, action: "idle" }, 20, 40)?.src).toBe("0");
  });
  it("holds the supporting shoe in place as the body travels through a side step", () => {
    for (const direction of ["east", "west"] as const) {
      const positions = [0, 4, 8, 12, 16].map(distance => {
        const target = officeGaitTargets(direction, distance, 40, 6, 3, 2)[0];
        expect(target.planted).toBe(true);
        return distance * (direction === "east" ? 1 : -1) + target.x;
      });
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(.001);
    }
  });
});
