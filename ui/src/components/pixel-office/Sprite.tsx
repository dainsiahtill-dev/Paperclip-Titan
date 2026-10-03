import { memo, type CSSProperties } from "react";
import { selectPhaserAnimation, phaserAnimationFrame } from "../../lib/phaser-office-animation";
import type { OfficeAssets, OfficeDirection, OfficeFrame } from "./types";

export type OfficeStyle = CSSProperties & Record<"--po-" | string, string | number | undefined>;

export function selectOfficeFrame(assets: OfficeAssets, agentId: string, action: string, direction: OfficeDirection, elapsed: number, hold: boolean): OfficeFrame | null {
  return phaserAnimationFrame(selectPhaserAnimation(assets, agentId, action, direction), elapsed, hold) ?? null;
}

export const OfficeNpc = memo(function OfficeNpc({ assets, agentId, action, direction = "south", elapsed, hold = false, head = false, hands = false }: { assets: OfficeAssets; agentId: string; action: string; direction?: OfficeDirection; elapsed: number; hold?: boolean; head?: boolean; hands?: boolean }) {
  const frame = selectOfficeFrame(assets, agentId, action, direction, elapsed, hold);
  if (!frame) return null;
  const style = { "--po-npc-w": frame.size[0] * frame.scale, "--po-npc-h": frame.size[1] * frame.scale, "--po-npc-x": 24 - frame.foot[0] * frame.scale, "--po-npc-y": 56 - frame.foot[1] * frame.scale, "--po-npc-mirror": frame.mirror ? -1 : 1 } as OfficeStyle;
  return <span className={"po-npc-frame" + (head ? " po-npc-head" : "") + (hands ? " po-npc-hands" : "")} data-action={action} data-direction={direction}>
    <img src={frame.src} alt="" draggable={false} className="po-npc-image" style={style} />
  </span>;
});
