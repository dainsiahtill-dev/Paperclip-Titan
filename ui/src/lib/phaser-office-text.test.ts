import { describe, expect, it } from "vitest";
import { layoutOfficeText, officeActorTextAnchor } from "./phaser-office-text";

describe("readable screen-space office text", () => {
  it("keeps employee text sizes and anchor positions even when zoom brings labels together", () => {
    const placed = layoutOfficeText([
      { id: "a", x: 80, y: 30, width: 120, height: 22, anchor: "top", kind: "name" },
      { id: "b", x: 120, y: 30, width: 120, height: 22, anchor: "top", kind: "name" },
    ], { width: 390, height: 450 }, 4);
    expect(placed[0]).toEqual({ id: "a", left: 20, top: 30, width: 120, height: 22 });
    expect(placed[1].top).toBe(30);
    expect(placed[1].left).toBe(60);
    expect(placed[1].width).toBe(120);
    expect(placed[1].height).toBe(22);
  });
  it("keeps employee names attached at the viewport edge instead of pinning or repositioning them", () => {
    const placed = layoutOfficeText([
      { id: "name", x: 180, y: 100, width: 100, height: 20, anchor: "bottom", kind: "name" },
      { id: "edge", x: 2, y: 448, width: 100, height: 20, anchor: "top", kind: "name" },
    ], { width: 390, height: 450 }, 4);
    expect(placed[0].top).toBe(80);
    expect(placed[1].left).toBe(-48);
    expect(placed[1].top).toBe(448);
  });
  it("keeps department plaques on their projected anchors even when neighboring text overlaps", () => {
    const placed = layoutOfficeText([
      { id: "a", x: 80, y: 30, width: 120, height: 22, anchor: "top", kind: "department" },
      { id: "b", x: 120, y: 30, width: 140, height: 22, anchor: "top", kind: "department" },
    ], { width: 390, height: 450 }, 4);
    expect(placed[0].left + placed[0].width / 2).toBe(80);
    expect(placed[1].left + placed[1].width / 2).toBe(120);
    expect(placed.map(p => p.top)).toEqual([30, 30]);
  });
  it("does not pin a room sign to the screen edge when its room moves offscreen", () => {
    const [placed] = layoutOfficeText([{ id: "edge", x: 2, y: 448, width: 120, height: 22, anchor: "top", kind: "sign" }], { width: 390, height: 450 }, 4);
    expect(placed.left).toBe(-58);
    expect(placed.top).toBe(448);
  });
  it("uses a fixed plaque's real measured width even when it exceeds the viewport", () => {
    const [placed] = layoutOfficeText([{ id: "wide", x: 195, y: 30, width: 500, height: 22, anchor: "top", kind: "department" }], { width: 390, height: 450 }, 4);
    expect(placed.left).toBe(-55);
    expect(placed.left + placed.width / 2).toBe(195);
  });
  it("keeps status bubbles attached to their employee despite overlapping plaques and viewport edges", () => {
    const placed = layoutOfficeText([
      { id: "plaque", x: 100, y: 80, width: 180, height: 22, anchor: "top", kind: "department" },
      { id: "status", x: 100, y: 100, width: 18, height: 18, anchor: "bottom", kind: "status" },
      { id: "edge", x: 2, y: 8, width: 18, height: 18, anchor: "bottom", kind: "status" },
    ], { width: 390, height: 450 }, 4);
    expect(placed[1]).toEqual({ id: "status", left: 91, top: 82, width: 18, height: 18 });
    expect(placed[2]).toEqual({ id: "edge", left: -7, top: -10, width: 18, height: 18 });
  });
  it("anchors actor text to visible sprite bounds rather than a fixed distance from the feet", () => {
    const frame = { src: "npc.png", size: [100, 120] as [number, number], foot: [50, 110] as [number, number], scale: 1 };
    expect(officeActorTextAnchor({ x: 200, y: 240 }, frame, .5)).toEqual({ x: 200, y: 210 });
    const padded = { ...frame, rig: { bounds: [10, 20, 60, 80] as [number, number, number, number], bodyEnd: 80, hands: [], legs: [] } };
    expect(officeActorTextAnchor({ x: 200, y: 240 }, padded, .5)).toEqual({ x: 195, y: 220 });
    expect(officeActorTextAnchor({ x: 200, y: 240 }, { ...padded, mirror: true }, .5)).toEqual({ x: 205, y: 220 });
  });
  it("follows the blended head during sitting and rising instead of jumping at the final pose", () => {
    const frame = { src: "standing.png", size: [100, 120] as [number, number], foot: [50, 110] as [number, number], scale: 1 };
    const seated = { ...frame, src: "seated.png", size: [80, 80] as [number, number] };
    const transition = { center: { x: 190, y: 240 }, frame: seated, scale: .5, blend: .5 };
    expect(officeActorTextAnchor({ x: 200, y: 240 }, frame, .5, transition)).toEqual({ x: 195, y: 215 });
    expect(officeActorTextAnchor({ x: 200, y: 240 }, frame, .5, { ...transition, blend: 0 })).toEqual({ x: 200, y: 210 });
    expect(officeActorTextAnchor({ x: 200, y: 240 }, frame, .5, { ...transition, blend: 1 })).toEqual({ x: 190, y: 220 });
  });
});
