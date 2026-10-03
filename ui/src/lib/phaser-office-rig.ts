import type Phaser from "phaser";
import type { OfficeArtRect, OfficeDirection, OfficeFrame } from "../components/pixel-office/types";
import type { OfficePoint } from "./pixel-office";
import type { PhaserOfficeTheme } from "./phaser-office-theme";

export function officeGaitTargets(direction: OfficeDirection, distance: number, stride: number, lateral: number, depth: number, lift: number) {
  const position = ((Math.max(0, distance) % stride) + stride) % stride;
  const fraction = position / stride;
  const phase = Math.floor(fraction * 4);
  const amplitude = stride / 4;
  const side = direction === "east" || direction === "west";
  const forward = direction === "west" || direction === "north" ? -1 : 1;
  return [0, 1].map(i => {
    const planted = i === 0 ? fraction < .5 : fraction >= .5;
    const part = i === 0 ? fraction < .5 ? fraction * 2 : (fraction - .5) * 2 : fraction >= .5 ? (fraction - .5) * 2 : fraction * 2;
    const strideX = planted ? amplitude * (1 - part * 2) : amplitude * (-1 + part * 2);
    return { x: side ? strideX * forward : 0, y: (side ? 0 : strideX / amplitude * depth * forward) - (planted ? 0 : Math.sin(part * Math.PI) * lift), phase, planted };
  });
}

const rotate = (x: number, y: number, angle: number) => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
const effectiveX = (frame: OfficeFrame, x: number) => frame.mirror ? frame.size[0] - x : x;
const key = (frame: OfficeFrame) => "office:" + frame.src;

export function cropOfficePart(image: Phaser.GameObjects.Image, frame: OfficeFrame, rect: OfficeArtRect) {
  image.setTexture(key(frame)).setOrigin(.5).setFlipX(!!frame.mirror).setRotation(0).setAlpha(1).setVisible(true);
  image.setCrop(frame.mirror ? frame.size[0] - rect[0] - rect[2] : rect[0], rect[1], rect[2], rect[3]);
}

export function placeOfficeFrame(image: Phaser.GameObjects.Image, frame: OfficeFrame, anchor: OfficePoint, sourceAnchor: [number, number], scale: number, depth: number) {
  image.setTexture(key(frame)).setOrigin(.5).setPosition(anchor.x + (frame.size[0] / 2 - sourceAnchor[0]) * scale, anchor.y + (frame.size[1] / 2 - sourceAnchor[1]) * scale).setScale(scale).setRotation(0).setFlipX(!!frame.mirror).setDepth(depth).setAlpha(1).setVisible(true).setCrop();
}

export function renderOfficeGait(body: Phaser.GameObjects.Image, shins: Phaser.GameObjects.Image[], shoes: Phaser.GameObjects.Image[], frame: OfficeFrame, anchor: OfficePoint, scale: number, direction: OfficeDirection, distance: number, depth: number, theme: PhaserOfficeTheme, bodyClip?: { graphics: Phaser.GameObjects.Graphics; mask: Phaser.Display.Masks.GeometryMask; legs?: Phaser.GameObjects.Graphics }) {
  const rig = frame.rig;
  if (!rig) return false;
  const targets = officeGaitTargets(direction, distance, theme.n("gait-distance"), theme.n("gait-side-step"), theme.n("gait-depth-step"), theme.n("gait-lift"));
  const bob = targets[0].phase % 2 ? theme.n("gait-bob") : 0;
  const side = direction === "east" || direction === "west";
  const far = direction === "west" ? 0 : 1;
  const slices = 16;
  while (shins.length < slices * 2) shins.push(body.scene.add.image(0, 0, key(frame)).setVisible(false));
  placeOfficeFrame(body, frame, { x: anchor.x, y: anchor.y - bob }, frame.foot, scale, depth + .1);
  if (bodyClip) {
    const holes: OfficeArtRect[] = rig.legs.map(leg => [leg.shin[0], leg.shin[1] + (theme.n("gait-hip-keep") + bob) / scale, leg.shin[2], frame.size[1] - leg.shin[1]]);
    maskOfficeRegions(bodyClip.graphics, frame, { x: body.x, y: body.y }, scale, holes); body.setMask(bodyClip.mask);
  } else cropOfficePart(body, frame, [0, 0, frame.size[0], rig.bodyEnd]);
  bodyClip?.legs?.clear().setVisible(true).setDepth(depth + .05);
  if (bodyClip?.legs) {
    const hips = rig.legs.map(leg => ({ x: anchor.x + (effectiveX(frame, leg.joint[0]) - frame.foot[0]) * scale, y: anchor.y + (leg.joint[1] - frame.foot[1]) * scale - bob }));
    const size = scale / frame.scale / theme.n("actor-scale");
    const left = Math.min(...hips.map(p => p.x)) - theme.n("gait-leg-width") * size / 2, right = Math.max(...hips.map(p => p.x)) + theme.n("gait-leg-width") * size / 2;
    const y = Math.min(...hips.map(p => p.y)), height = theme.n("gait-pelvis-height") * size;
    bodyClip.legs.fillStyle(rig.legs[0].outline ?? theme.color("ink")).fillRect(Math.floor(left) - 1, Math.floor(y), Math.ceil(right - left) + 2, Math.ceil(height));
    bodyClip.legs.fillStyle(rig.legs[0].fill ?? theme.color("ink")).fillRect(Math.floor(left), Math.floor(y) + 1, Math.ceil(right - left), Math.ceil(height) - 1);
  }
  rig.legs.forEach((leg, i) => {
    const originalSole = { x: anchor.x + (effectiveX(frame, leg.sole[0]) - frame.foot[0]) * scale, y: anchor.y + (leg.sole[1] - frame.foot[1]) * scale };
    const sole = { x: side ? anchor.x + targets[i].x : originalSole.x, y: anchor.y + targets[i].y };
    const deltaX = sole.x - originalSole.x, deltaY = sole.y - originalSole.y;
    let sourceKey = key(frame);
    if (side && i === far) {
      sourceKey = "office-back:" + i + ":" + frame.src;
      if (!body.scene.textures.exists(sourceKey)) {
        const texture = body.scene.textures.createCanvas(sourceKey, frame.size[0], frame.size[1])!;
        const context = texture.getContext();
        context.drawImage(body.scene.textures.get(key(frame)).getSourceImage() as CanvasImageSource, 0, 0);
        context.globalCompositeOperation = "source-atop"; context.globalAlpha = theme.n("gait-back-shade"); context.fillStyle = theme.css("ink");
        context.fillRect(leg.shin[0], leg.shin[1], leg.shin[2], frame.size[1] - leg.shin[1]);
        texture.refresh();
      }
    }
    const start = leg.shin[1], end = leg.shoe[1], height = (end - start) / slices;
    const join = start;
    if (bodyClip?.legs) {
      const graphics = bodyClip.legs;
      const hip = { x: anchor.x + (effectiveX(frame, leg.joint[0]) - frame.foot[0]) * scale, y: anchor.y + (leg.joint[1] - frame.foot[1]) * scale - bob };
      const ankle = { x: sole.x + (effectiveX(frame, leg.ankle[0]) - effectiveX(frame, leg.sole[0])) * scale, y: sole.y - (leg.sole[1] - leg.ankle[1]) * scale };
      const width = theme.n("gait-leg-width") * scale / frame.scale / theme.n("actor-scale");
      const bend = targets[i].phase % 2 && targets[i].y < 0 ? theme.n("gait-knee-bend") : 0;
      const knee = { x: (hip.x + ankle.x) / 2 + (direction === "west" ? -bend : bend), y: (hip.y + ankle.y) / 2 };
      const shade = side && i === far ? theme.n("gait-back-shade") : 0;
      const original = leg.fill ?? theme.color("ink"), ink = theme.color("ink");
      const channels = [16, 8, 0].map(shift => Math.round(((original >> shift) & 255) * (1 - shade) + ((ink >> shift) & 255) * shade));
      const fill = channels[0] * 65536 + channels[1] * 256 + channels[2];
      const draw = (color: number, w: number, inset: number) => {
        graphics.fillStyle(color);
        for (let y = Math.floor(hip.y) + inset; y <= Math.ceil(ankle.y) - inset; y++) {
          const from = y <= knee.y ? hip : knee, to = y <= knee.y ? knee : ankle;
          const t = Math.max(0, Math.min(1, (y - from.y) / Math.max(.001, to.y - from.y)));
          graphics.fillRect(Math.round(from.x + (to.x - from.x) * t - w / 2), y, Math.round(w), 1);
        }
      };
      draw(leg.outline ?? theme.color("ink"), width + theme.n("scene-line") * 2, 0); draw(fill, width, 1);
    }
    for (let row = 0; row < slices; row++) {
      const part = shins[i * slices + row]; part.setVisible(false);
      if (bodyClip?.legs) continue;
      const y = start + row * height, middle = y + height / 2;
      const fraction = Math.max(0, Math.min(1, (middle - join) / Math.max(1, end - join)));
      cropOfficePart(part, frame, [leg.shin[0], y, leg.shin[2], height + theme.n("gait-overlap") / scale]);
      part.setTexture(sourceKey).setOrigin(.5).setFlipX(!!frame.mirror).setRotation(0).setPosition(anchor.x + (frame.size[0] / 2 - frame.foot[0]) * scale + deltaX * fraction, anchor.y + (frame.size[1] / 2 - frame.foot[1]) * scale + deltaY * fraction).setScale(scale).setDepth(depth + .04).setVisible(true);
    }
    cropOfficePart(shoes[i], frame, leg.shoe); shoes[i].setTexture(sourceKey).setOrigin(.5).setFlipX(!!frame.mirror).setRotation(0);
    shoes[i].setPosition(sole.x + (frame.size[0] / 2 - effectiveX(frame, leg.sole[0])) * scale, sole.y + (frame.size[1] / 2 - leg.sole[1]) * scale).setScale(scale).setDepth(depth + .06 + (i === far ? 0 : .01));
  });
  return true;
}

/** Masks only moved regions out of the original, so duplicate hands never remain. */
export function maskOfficeRegions(graphics: Phaser.GameObjects.Graphics, frame: OfficeFrame, center: OfficePoint, scale: number, holes: OfficeArtRect[]) {
  graphics.clear().fillStyle(0xffffff);
  const visible = holes.map(r => [frame.mirror ? frame.size[0] - r[0] - r[2] : r[0], r[1], r[2], r[3]]);
  const xs = [...new Set([0, frame.size[0], ...visible.flatMap(r => [r[0], r[0] + r[2]])])].sort((a, b) => a - b);
  const ys = [...new Set([0, frame.size[1], ...visible.flatMap(r => [r[1], r[1] + r[3]])])].sort((a, b) => a - b);
  for (let y = 0; y < ys.length - 1; y++) for (let x = 0; x < xs.length - 1; x++) {
    const mx = (xs[x] + xs[x + 1]) / 2, my = (ys[y] + ys[y + 1]) / 2;
    if (visible.some(r => mx > r[0] && mx < r[0] + r[2] && my > r[1] && my < r[1] + r[3])) continue;
    graphics.fillRect(center.x + (xs[x] - frame.size[0] / 2) * scale, center.y + (ys[y] - frame.size[1] / 2) * scale, (xs[x + 1] - xs[x]) * scale, (ys[y + 1] - ys[y]) * scale);
  }
}
