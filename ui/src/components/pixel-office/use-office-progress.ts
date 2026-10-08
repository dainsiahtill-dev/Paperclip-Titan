import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCompanyLiveEvent } from "../../context/LiveUpdatesProvider";
import type { OfficeExecution, OfficePresence, OfficeRun } from "../../lib/pixel-office";
import { officeNumber } from "../../lib/phaser-office-theme";
import { OfficeProgressTracker, officeWorkRunIds, readOfficeProgressEvent, readOfficeRunOutput, type OfficeOutputCandidate, type OfficeWorkOutput } from "../../lib/phaser-office-progress";

export function useOfficeProgress(companyId: string | null, presences: ReadonlyMap<string, OfficePresence>, snapshot: { runs: OfficeRun[]; executions: OfficeExecution[] } | undefined, refreshProjection: () => void) {
  const bindings = useMemo(() => officeWorkRunIds(presences, snapshot?.executions ?? []), [presences, snapshot?.executions]);
  const tracker = useRef(new OfficeProgressTracker());
  const pending = useRef(new Map<string, OfficeOutputCandidate>());
  const probed = useRef(new Set<string>());
  const scope = useRef(companyId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [outputs, setOutputs] = useState<ReadonlyMap<string, OfficeWorkOutput>>(new Map());
  useEffect(() => {
    if (scope.current !== companyId) { pending.current.clear(); probed.current.clear(); scope.current = companyId; }
    tracker.current.reconcile(companyId, bindings);
    const now = Date.now(), duration = officeNumber("output-visible-ms");
    const live = new Set((snapshot?.runs ?? []).filter(r => r.status === "running").map(r => r.id));
    for (const id of probed.current) if (!live.has(id)) probed.current.delete(id);
    for (const [id, value] of pending.current) {
      if (bindings.get(value.agentId) === id) { tracker.current.accept(value, now, duration); pending.current.delete(id); }
      else if (!live.has(id) || value.at + duration <= now) pending.current.delete(id);
    }
    if (companyId) for (const run of snapshot?.runs ?? []) tracker.current.accept(readOfficeRunOutput(companyId, run), now, duration);
    setOutputs(tracker.current.snapshot(now));
  }, [companyId, bindings, snapshot?.runs]);
  useCompanyLiveEvent(useCallback(event => {
    if (!companyId || event.companyId !== companyId) return;
    const value = readOfficeProgressEvent(event); if (!value) return;
    tracker.current.reconcile(companyId, bindings);
    if (bindings.get(value.agentId) !== value.runId) {
      const known = snapshot?.runs.some(r => r.id === value.runId && r.agentId === value.agentId && r.status === "running");
      if (known) {
        const previous = pending.current.get(value.runId);
        if (!previous || previous.at <= value.at) pending.current.set(value.runId, value);
        if (!probed.current.has(value.runId)) { probed.current.add(value.runId); refreshProjection(); }
      }
      return;
    }
    if (!tracker.current.accept(value, Date.now(), officeNumber("output-visible-ms")) || timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; setOutputs(tracker.current.snapshot(Date.now())); }, officeNumber("event-batch-ms"));
  }, [companyId, bindings, snapshot?.runs, refreshProjection]));
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { outputs, bindings };
}
