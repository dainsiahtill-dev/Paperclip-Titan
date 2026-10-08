import { describe, expect, it } from "vitest";
import { officeParkLayout, constrainOfficeCamera } from "./phaser-office-camera";

const world = { width: 1280, height: 1040 };
const viewports = [{ width: 1000, height: 650 }, { width: 390, height: 450 }, { width: 4000, height: 300 }, { width: 300, height: 4000 }];

describe("finite office park camera", () => {
  it.each(viewports)("keeps the whole office visible with park on all sides at $width x $height", viewport => {
    const layout = officeParkLayout(world, viewport, 192, 64, 1.15);
    expect(layout.bounds.x).toBeLessThanOrEqual(-192);
    expect(layout.bounds.y).toBeLessThanOrEqual(-192);
    expect(layout.bounds.x + layout.bounds.width).toBeGreaterThanOrEqual(1472);
    expect(layout.bounds.y + layout.bounds.height).toBeGreaterThanOrEqual(1232);
    const camera = constrainOfficeCamera(layout.bounds, viewport, layout.overview, .01, 2);
    const left = camera.x - viewport.width / camera.zoom / 2;
    const top = camera.y - viewport.height / camera.zoom / 2;
    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(left + viewport.width / camera.zoom).toBeGreaterThanOrEqual(1280);
    expect(top + viewport.height / camera.zoom).toBeGreaterThanOrEqual(1040);
  });

  it.each(viewports)("never exposes outside the park after extreme dragging and zooming at $width x $height", viewport => {
    const { bounds } = officeParkLayout(world, viewport, 192, 64, 1.15);
    for (const x of [-1e6, 640, 1e6]) for (const y of [-1e6, 520, 1e6]) for (const zoom of [.001, .2, 1, 5]) {
      const view = constrainOfficeCamera(bounds, viewport, { x, y, zoom }, .01, 2);
      const left = view.x - viewport.width / view.zoom / 2, top = view.y - viewport.height / view.zoom / 2;
      expect(left).toBeGreaterThanOrEqual(bounds.x - 1e-8);
      expect(top).toBeGreaterThanOrEqual(bounds.y - 1e-8);
      expect(left + viewport.width / view.zoom).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-8);
      expect(top + viewport.height / view.zoom).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-8);
    }
  });

  it("preserves a valid manual center and zoom after viewport resize and department growth", () => {
    const viewport = { width: 700, height: 600 };
    const layout = officeParkLayout({ width: 2000, height: 2000 }, viewport, 192, 64, 1.15);
    expect(constrainOfficeCamera(layout.bounds, viewport, { x: 600, y: 800, zoom: 1.5 }, .2, 2)).toEqual({ x: 600, y: 800, zoom: 1.5 });
  });

  it("supports a large company overview below the usual zoom floor", () => {
    const viewport = { width: 1000, height: 500 };
    const layout = officeParkLayout({ width: 1600, height: 10000 }, viewport, 192, 64, 1.15);
    const view = constrainOfficeCamera(layout.bounds, viewport, layout.overview, Math.min(.2, layout.overview.zoom), 2);
    expect(view.zoom).toBeLessThan(.2);
    expect(view.y - viewport.height / view.zoom / 2).toBeLessThanOrEqual(0);
    expect(view.y + viewport.height / view.zoom / 2).toBeGreaterThanOrEqual(10000);
  });

  it("keeps hidden or zero-sized resize observations finite", () => {
    const layout = officeParkLayout(world, { width: 0, height: 0 }, 192, 64, 1.15);
    const view = constrainOfficeCamera(layout.bounds, { width: 0, height: 0 }, layout.overview, .01, 2);
    expect([layout.bounds.x, layout.bounds.y, layout.bounds.width, layout.bounds.height, view.x, view.y, view.zoom].every(Number.isFinite)).toBe(true);
    expect(view.zoom).toBeGreaterThan(0);
  });
});
