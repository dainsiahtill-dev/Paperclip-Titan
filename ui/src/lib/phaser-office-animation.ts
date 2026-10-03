import { officeStableHash } from "./pixel-office";
import type { OfficeAnimation, OfficeAssets, OfficeDirection, OfficeFrame } from "../components/pixel-office/types";

export function selectPhaserAnimation(assets: OfficeAssets, id: string, action: string, direction: OfficeDirection): OfficeAnimation | undefined {
  const character = assets.characters[officeStableHash(id) % assets.characters.length];
  const actions = action === "typing_seated" ? [action] : [action, "idle", "loaf_coffee", "walk"];
  return actions.map(a => assets.animations[character + ":" + direction + ":" + a]).find(Boolean)
    ?? Object.values(assets.animations).find(a => a.character === character && a.direction === direction);
}

export function phaserAnimationFrame(animation: OfficeAnimation | undefined, elapsed: number, hold: boolean): OfficeFrame | undefined {
  if (!animation?.frames.length) return;
  const index = hold || animation.playback === "static" || animation.fps <= 0 ? 0 : Math.floor(Math.max(0, elapsed) * animation.fps / 1000);
  return animation.frames[animation.playback === "once" ? Math.min(index, animation.frames.length - 1) : index % animation.frames.length];
}

export function phaserWalkFrame(animation: OfficeAnimation | undefined, distance: number, stride: number): OfficeFrame | undefined {
  if (!animation?.frames.length) return;
  if (animation.action !== "walk" || animation.frames.length < 2) return animation.frames[0];
  return animation.frames[Math.floor(Math.max(0, distance) / stride * animation.frames.length) % animation.frames.length];
}

export function officeHasMotion(animation: OfficeAnimation | undefined): boolean { return !!animation && animation.frames.length > 1 && animation.fps > 0 && animation.playback !== "static"; }
