import type { OfficeAction } from "../../lib/pixel-office";

export type OfficeDirection = "north" | "east" | "south" | "west";
export interface OfficeArt { src: string; size: [number, number]; physicalSize: [number, number]; blocksMovement?: boolean; ground?: [number, number, number, number] }
export type OfficeArtRect = [number, number, number, number];
export interface OfficeRig { bounds: OfficeArtRect; bodyEnd: number; legs: Array<{ shin: OfficeArtRect; shoe: OfficeArtRect; joint: [number, number]; ankle: [number, number]; sole: [number, number]; fill?: number; outline?: number }>; hands: OfficeArtRect[] }
export interface OfficeFrame { src: string; size: [number, number]; foot: [number, number]; hip?: [number, number] | null; scale: number; mirror?: boolean; rig?: OfficeRig | null }
export interface OfficeAnimation { character: string; direction: OfficeDirection; action: string; fps: number; playback?: "loop" | "once" | "static"; frames: OfficeFrame[]; reviewStatus: string; browserVerified?: boolean }
export interface OfficeAssets { schemaVersion: number; sprites: Record<string, OfficeArt>; animations: Record<string, OfficeAnimation>; characters: string[] }

export async function fetchOfficeAssets(): Promise<OfficeAssets> {
  const response = await fetch("/pixel-office/manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Office assets HTTP " + response.status);
  const data = await response.json() as OfficeAssets;
  if (!data.sprites?.monitor_body || !data.characters?.length || !data.animations) throw new Error("Office sprite manifest is incomplete");
  const animations = Object.fromEntries(Object.entries(data.animations).filter(([, a]) => ["accepted", "accepted_keypose"].includes(a.reviewStatus) && a.browserVerified === true));
  const characters = data.characters.filter(c => Object.values(animations).some(a => a.character === c));
  if (!characters.length) throw new Error("No accepted office NPC assets are available");
  return { ...data, animations, characters };
}

export function officeNpcAction(action: OfficeAction, seed: number): string {
  if (action === "working") return "typing_seated";
  if (action === "resting") return seed % 3 === 0 ? "loaf_stretch" : "loaf_coffee";
  if (action === "walking") return "walk";
  if (action === "error") return "error";
  if (action === "waiting") return "waiting";
  return "idle";
}
