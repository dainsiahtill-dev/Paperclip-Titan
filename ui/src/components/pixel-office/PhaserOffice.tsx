import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type Phaser from "phaser";
import { v3t } from "@/i18n";
import { createPhaserOfficeScene, type PhaserOfficeController, type PhaserOfficeState } from "../../lib/phaser-office-scene";
import { readPhaserOfficeTheme } from "../../lib/phaser-office-theme";
import type { OfficeAssets } from "./types";
import type { OfficeStyle } from "./Sprite";

export interface PhaserOfficeHandle { zoomBy(delta: number): void; fit(): void; retry(): void }
export const PhaserOffice = forwardRef<PhaserOfficeHandle, { assets: OfficeAssets; state: PhaserOfficeState; onSelect(id: string): void; onZoom(zoom: number): void }>(function PhaserOffice({ assets, state, onSelect, onZoom }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<Phaser.Game | null>(null);
  const controller = useRef<PhaserOfficeController | null>(null);
  const latest = useRef({ state, onSelect, onZoom }); latest.current = { state, onSelect, onZoom };
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useImperativeHandle(ref, () => ({ zoomBy: d => controller.current?.zoomBy(d), fit: () => controller.current?.fit(), retry: () => { if (error) setAttempt(a => a + 1); } }), [error]);
  useEffect(() => { controller.current?.update(state); }, [state]);
  useEffect(() => {
    const parent = host.current; if (!parent) return;
    let disposed = false;
    setLoading(true); setError("");
    const observer = new ResizeObserver(([entry]) => controller.current?.resize(entry.contentRect.width, entry.contentRect.height));
    observer.observe(parent);
    void import("phaser").then(({ default: P }) => {
      if (disposed) return;
      const theme = readPhaserOfficeTheme();
      const scene = createPhaserOfficeScene(P, assets, theme, latest.current.state, {
        ready: c => { if (disposed) return; controller.current = c; c.update(latest.current.state); setLoading(false); },
        select: id => latest.current.onSelect(id), zoom: z => latest.current.onZoom(z), error: message => { if (!disposed) { setError(message); setLoading(false); } },
      });
      game.current = new P.Game({ type: P.CANVAS, parent, width: parent.clientWidth, height: parent.clientHeight, backgroundColor: theme.css("paper"), pixelArt: true, roundPixels: true, antialias: false, banner: false, audio: { noAudio: true }, scene: [scene], input: { mouse: { preventDefaultWheel: true } } });
    }).catch(reason => { if (!disposed) { setError(String(reason)); setLoading(false); } });
    return () => { disposed = true; observer.disconnect(); controller.current = null; game.current?.canvas.remove(); game.current?.destroy(true); game.current = null; };
  }, [assets, attempt]);
  return <div ref={host} className="po-phaser-host" style={{ "--po-world-w": state.model.width, "--po-world-h": state.model.height } as OfficeStyle} data-testid="pixel-office-world" data-layout-revision={state.model.revision} role="img" aria-label={v3t("office.sceneDescription")}>
    {loading && <div className="po-phaser-loading" role="status">{v3t("office.sceneLoading")}</div>}
    {error && <div className="po-phaser-loading" role="alert"><p>{error}</p><button onClick={() => setAttempt(a => a + 1)}>{v3t("office.retry")}</button></div>}
  </div>;
});
