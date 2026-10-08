// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createOfficeTextLayer } from "./office-text-layer";

describe("native office text layer", () => {
  it("renders native text, updates positions without replacing nodes, and removes stale labels", () => {
    const root = document.createElement("div"); document.body.append(root);
    const layer = createOfficeTextLayer(root, 4);
    layer.update([{ id: "department", text: "质量与审计主管", x: 80, y: 30, anchor: "top", kind: "department" }], { width: 390, height: 450 });
    const title = root.firstElementChild as HTMLElement;
    expect(title.textContent).toBe("质量与审计主管");
    expect(title.tagName).toBe("SPAN");
    layer.update([{ id: "department", text: "质量与审计主管", x: 180, y: 80, anchor: "top", kind: "department" }], { width: 390, height: 450 });
    expect(root.firstElementChild).toBe(title);
    expect(title.style.getPropertyValue("--po-label-y")).toBe("80");
    layer.update([], { width: 390, height: 450 });
    expect(root.childElementCount).toBe(0);
    layer.clear(); root.remove();
  });
  it("treats employee-provided names as text rather than markup", () => {
    const root = document.createElement("div"), layer = createOfficeTextLayer(root, 4);
    layer.update([{ id: "employee", text: '<img src="x" onerror="alert(1)">', x: 80, y: 80, anchor: "bottom", kind: "name" }], { width: 390, height: 450 });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img");
    layer.clear();
  });
  it("remeasures a bottom-anchored label after styles change without changing its text", () => {
    const root = document.createElement("div"), layer = createOfficeTextLayer(root, 4);
    const labels = [{ id: "status", text: "!", x: 80, y: 100, anchor: "bottom" as const, kind: "status" as const }];
    layer.update(labels, { width: 390, height: 450 });
    const node = root.firstElementChild as HTMLElement;
    let height = 22;
    Object.defineProperty(node, "offsetWidth", { get: () => 18 });
    Object.defineProperty(node, "offsetHeight", { get: () => height });
    layer.update(labels, { width: 390, height: 450 });
    expect(node.style.getPropertyValue("--po-label-y")).toBe("78");
    height = 18;
    layer.update(labels, { width: 390, height: 450 });
    expect(node.style.getPropertyValue("--po-label-y")).toBe("82");
    layer.destroy();
  });
  it("updates native font sizing with the scene scale without replacing the text node", () => {
    const root = document.createElement("div"), layer = createOfficeTextLayer(root, 4);
    const label = { id: "department", text: "质量与审计主管", x: 80, y: 100, anchor: "center" as const, kind: "department" as const, scale: .5 };
    layer.update([label], { width: 390, height: 450 });
    const node = root.firstElementChild as HTMLElement;
    expect(node.tagName).toBe("SPAN");
    expect(node.style.getPropertyValue("--po-label-scale")).toBe("0.5");
    layer.update([{ ...label, scale: 2 }], { width: 390, height: 450 });
    expect(root.firstElementChild).toBe(node);
    expect(node.style.getPropertyValue("--po-label-scale")).toBe("2");
    layer.destroy();
  });
  it("centers wall text using its fractional rendered dimensions", () => {
    const root = document.createElement("div"), layer = createOfficeTextLayer(root, 4);
    const label = { id: "department", text: "质量与审计主管", x: 80, y: 100, anchor: "center" as const, kind: "department" as const };
    layer.update([label], { width: 390, height: 450 });
    const node = root.firstElementChild as HTMLElement;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100.5, 21.5));
    layer.update([label], { width: 390, height: 450 });
    expect(node.style.getPropertyValue("--po-label-x")).toBe("29.75");
    expect(node.style.getPropertyValue("--po-label-y")).toBe("89.25");
    layer.destroy();
  });
  it("selects the bubble's employee, preserves plain text, and removes click handling on teardown", () => {
    const selected: string[] = [], root = document.createElement("div");
    const layer = createOfficeTextLayer(root, 4, id => selected.push(id));
    const text = '<img src="x" onerror="alert(1)">';
    layer.update([{ id: "activity", text, title: "员工 A · 工作中", agentId: "agent-a", tone: "working", x: 80, y: 100, anchor: "bottom", kind: "activity", scale: 1 }], { width: 390, height: 450 });
    const node = root.firstElementChild as HTMLElement;
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe(text);
    expect(node.title).toBe("员工 A · 工作中");
    expect(node.dataset.tone).toBe("working");
    node.querySelector(".po-activity-text")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected).toEqual(["agent-a"]);
    layer.destroy(); root.append(node);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected).toEqual(["agent-a"]);
  });
  it("forwards wheel input over a bubble to office zoom and removes the forwarding on teardown", () => {
    const deltas: number[] = [], root = document.createElement("div");
    const layer = createOfficeTextLayer(root, 4, undefined, delta => deltas.push(delta));
    layer.update([{ id: "activity", agentId: "agent-a", text: "工作中", x: 80, y: 100, anchor: "bottom", kind: "activity" }], { width: 390, height: 450 });
    const node = root.firstElementChild as HTMLElement;
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 90 });
    node.querySelector(".po-activity-text")!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(deltas).toEqual([90]);
    layer.destroy(); root.append(node);
    const after = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -90 });
    node.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(deltas).toEqual([90]);
  });
});
