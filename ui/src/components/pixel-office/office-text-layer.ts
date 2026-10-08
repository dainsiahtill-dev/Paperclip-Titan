import { layoutOfficeText, type OfficeWorldText, type OfficeTextViewport } from "../../lib/phaser-office-text";

/** Fonts are reflowed at the current scene scale in native browser typography.
 * Only placement uses a transform; text is never enlarged as a canvas bitmap. */
export function createOfficeTextLayer(root: HTMLElement, gap: number, selectAgent?: (id: string) => void, zoom?: (wheelDelta: number) => void) {
  const entries = new Map<string, { node: HTMLSpanElement; content: HTMLSpanElement | null; signature: string; width: number; height: number }>();
  const select = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".po-scene-label[data-agent-id]") : null;
    if (target?.dataset.agentId && root.contains(target)) { event.stopPropagation(); selectAgent?.(target.dataset.agentId); }
  };
  if (selectAgent) root.addEventListener("click", select);
  const wheel = (event: WheelEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".po-scene-label[data-agent-id]") : null;
    if (target && root.contains(target)) { event.preventDefault(); event.stopPropagation(); zoom?.(event.deltaY); }
  };
  if (zoom) root.addEventListener("wheel", wheel, { passive: false });
  const invalidate = () => { for (const entry of entries.values()) entry.signature = ""; };
  root.ownerDocument.fonts?.addEventListener("loadingdone", invalidate);
  const clear = () => { for (const entry of entries.values()) entry.node.remove(); entries.clear(); };
  return {
    update(labels: OfficeWorldText[], viewport: OfficeTextViewport) {
      const active = new Set(labels.map(label => label.id));
      for (const [id, entry] of entries) if (!active.has(id)) { entry.node.remove(); entries.delete(id); }
      const boxes = labels.map(label => {
        let entry = entries.get(label.id);
        if (!entry) {
          const node = root.ownerDocument.createElement("span"); root.append(node);
          entry = { node, content: null, signature: "", width: 0, height: 0 }; entries.set(label.id, entry);
        }
        const maxWidth = label.maxWidth === undefined ? undefined : Math.max(1, label.maxWidth);
        const scale = label.scale ?? 1;
        const signature = JSON.stringify([label.text, label.kind, label.small, maxWidth, scale, label.title, label.agentId, label.tone]);
        const changed = entry.signature !== signature;
        if (changed) {
          entry.node.className = "po-scene-label" + (label.small ? " po-scene-label-small" : "");
          entry.node.dataset.kind = label.kind;
          if (label.kind === "activity") {
            if (!entry.content) { entry.content = root.ownerDocument.createElement("span"); entry.content.className = "po-activity-text"; entry.node.replaceChildren(entry.content); }
            entry.content.textContent = label.text;
          } else { entry.content = null; entry.node.textContent = label.text; }
          entry.node.title = label.title ?? label.text;
          if (label.agentId) entry.node.dataset.agentId = label.agentId; else delete entry.node.dataset.agentId;
          if (label.tone) entry.node.dataset.tone = label.tone; else delete entry.node.dataset.tone;
          if (maxWidth === undefined) entry.node.style.removeProperty("--po-label-max-width");
          else entry.node.style.setProperty("--po-label-max-width", String(maxWidth));
          entry.node.style.setProperty("--po-label-scale", String(scale));
          entry.signature = signature;
        }
        // CSS updates can change dimensions without changing text or font files.
        // Measure the current box before applying its bottom/center anchor.
        const bounds = entry.node.getBoundingClientRect();
        entry.width = bounds.width || entry.node.offsetWidth; entry.height = bounds.height || entry.node.offsetHeight;
        return { id: label.id, x: label.x, y: label.y, anchor: label.anchor, kind: label.kind, width: entry.width, height: entry.height };
      });
      for (const box of layoutOfficeText(boxes, viewport, gap)) {
        const node = entries.get(box.id)!.node;
        const x = String(box.left), y = String(box.top);
        if (node.style.getPropertyValue("--po-label-x") !== x) node.style.setProperty("--po-label-x", x);
        if (node.style.getPropertyValue("--po-label-y") !== y) node.style.setProperty("--po-label-y", y);
      }
    },
    clear,
    destroy() { clear(); root.removeEventListener("click", select); root.removeEventListener("wheel", wheel); root.ownerDocument.fonts?.removeEventListener("loadingdone", invalidate); },
  };
}
