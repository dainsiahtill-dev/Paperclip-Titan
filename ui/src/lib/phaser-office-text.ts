import type { OfficeFrame } from "../components/pixel-office/types";

export interface OfficeWorldText {
  id: string; text: string; x: number; y: number;
  anchor: "top" | "bottom" | "center";
  kind: "department" | "sign" | "name" | "status" | "activity";
  small?: boolean; visible?: boolean;
  title?: string; agentId?: string; tone?: string;
  /** Typography and offsets use CSS units at the reference camera zoom. */
  maxWidth?: number; maxWorldWidth?: number; referenceOffsetY?: number;
  scale?: number;
}
export interface OfficeTextViewport { width: number; height: number }
export interface OfficeTextBox { id: string; x: number; y: number; width: number; height: number; anchor: OfficeWorldText["anchor"]; kind: OfficeWorldText["kind"] }

/** Use the visible artwork's head, including transparent padding and mirroring. */
export function officeActorTextAnchor(center: { x: number; y: number }, frame: OfficeFrame, scale: number, transition?: { center: { x: number; y: number }; frame: OfficeFrame; scale: number; blend: number }): { x: number; y: number } {
  const bounds = frame.rig?.bounds ?? [0, 0, frame.size[0], frame.size[1]];
  const head = { x: center.x + (bounds[0] + bounds[2] / 2 - frame.size[0] / 2) * scale * (frame.mirror ? -1 : 1), y: center.y + (bounds[1] - frame.size[1] / 2) * scale };
  if (!transition) return head;
  const other = officeActorTextAnchor(transition.center, transition.frame, transition.scale);
  return { x: head.x + (other.x - head.x) * transition.blend, y: head.y + (other.y - head.y) * transition.blend };
}

/** Invert the public screen-to-world mapping once per frame. This respects the
 * rendered camera transform without relying on Phaser's private matrix field. */
export function officeTextProjection(camera: { getWorldPoint(x: number, y: number): { x: number; y: number } }) {
  const origin = camera.getWorldPoint(0, 0), unitX = camera.getWorldPoint(1, 0), unitY = camera.getWorldPoint(0, 1);
  const a = unitX.x - origin.x, b = unitY.x - origin.x, c = unitX.y - origin.y, d = unitY.y - origin.y;
  const determinant = a * d - b * c;
  return (x: number, y: number) => ({ x: ((x - origin.x) * d - (y - origin.y) * b) / determinant, y: ((y - origin.y) * a - (x - origin.x) * c) / determinant });
}

/** Positions the current measured browser text box on its scene anchor. */
export function layoutOfficeText(items: OfficeTextBox[], _viewport: OfficeTextViewport, _gap: number) {
  const placed: Array<{ id: string; left: number; top: number; width: number; height: number }> = [];
  for (const item of items) {
    const height = Math.max(1, item.height);
    const width = Math.max(1, item.width);
    placed.push({ id: item.id, left: item.x - width / 2, top: item.y - (item.anchor === "bottom" ? height : item.anchor === "center" ? height / 2 : 0), width, height });
  }
  return placed;
}
