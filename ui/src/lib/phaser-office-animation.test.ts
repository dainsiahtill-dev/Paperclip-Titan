import { describe, expect, it } from "vitest";
import { phaserAnimationFrame, selectPhaserAnimation } from "./phaser-office-animation";
import type { OfficeAnimation, OfficeAssets } from "../components/pixel-office/types";

const frame = { src: "a", size: [100, 120] as [number, number], foot: [50, 110] as [number, number], scale: .5 };
const clip: OfficeAnimation = { character: "one", action: "walk", direction: "west", fps: 4, playback: "loop", reviewStatus: "accepted", frames: [frame, { ...frame, src: "b", mirror: true, foot: [60, 110] }] };
describe("approved Phaser clips", () => {
  it("loops, holds and completes a one-shot without reversing the exported frames", () => {
    expect(phaserAnimationFrame(clip, 300, false)?.src).toBe("b");
    expect(phaserAnimationFrame(clip, 500, false)?.src).toBe("a");
    expect(phaserAnimationFrame({ ...clip, playback: "once" }, 9000, false)?.src).toBe("b");
    expect(phaserAnimationFrame(clip, 300, true)?.src).toBe("a");
    expect(phaserAnimationFrame({ ...clip, playback: "static", fps: 0 }, 9000, false)?.src).toBe("a");
    expect(phaserAnimationFrame(clip, 300, false)?.foot).toEqual([60, 110]);
  });
  it("retains an employee's appearance when that appearance has no walk animation", () => {
    const idle = { ...clip, character: "two", action: "idle" };
    const assets: OfficeAssets = { schemaVersion: 1, sprites: {}, characters: ["two"], animations: { "two:west:idle": idle, "one:west:walk": clip } };
    expect(selectPhaserAnimation(assets, "employee", "walk", "west")?.character).toBe("two");
    expect(selectPhaserAnimation(assets, "employee", "typing_seated", "west")?.character).toBe("two");
  });
});
