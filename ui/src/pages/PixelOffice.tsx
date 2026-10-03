import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Maximize2, Pause, Play, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { AGENT_STATUSES } from "@paperclipai/shared";
import { v3t } from "@/i18n";
import { Link } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompanyLiveEvent } from "../context/LiveUpdatesProvider";
import { usePageVisibility } from "../lib/page-visibility";
import { agentUrl } from "../lib/utils";
import { buildOfficeDepartments, deriveOfficePresence, officeEventNeedsRefresh } from "../lib/pixel-office";
import { fetchOfficeSnapshot, selectOfficeTask } from "../lib/pixel-office-snapshot";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import { AgentStatusBadge } from "../components/StatusBadge";
import { PhaserOffice, type PhaserOfficeHandle } from "../components/pixel-office/PhaserOffice";
import { buildPhaserOffice, type PhaserOfficeSlots } from "../lib/phaser-office-model";
import { officeNumber, readPhaserOfficeConfig } from "../lib/phaser-office-theme";
import { phaserDepartmentName } from "../lib/phaser-office-scene";
import { OfficeNpc } from "../components/pixel-office/Sprite";
import { fetchOfficeAssets } from "../components/pixel-office/types";

const readOfficeSnapshot = (companyId: string) => fetchOfficeSnapshot(companyId, {
  agents: agentsApi.list,
  runs: heartbeatsApi.liveRunsForCompany,
  issues: id => issuesApi.listAll(id, { status: "backlog,todo,in_progress,in_review,blocked" }),
  execution: heartbeatsApi.executionForIssue,
});

function loadSlots(companyId: string): PhaserOfficeSlots {
  try { const parsed = JSON.parse(localStorage.getItem("paperclip.office.phaser.slots." + companyId) ?? "{}"); return { ...parsed, rooms: parsed.rooms ?? {}, seats: parsed.seats ?? {} }; }
  catch { return { rooms: {}, seats: {} }; }
}

export function PixelOffice() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const visibility = usePageVisibility();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [department, setDepartment] = useState("all");
  const [paused, setPaused] = useState(false);
  const [reduce, setReduce] = useState(false);
  const [motionOverride, setMotionOverride] = useState(false);
  const [zoom, setZoom] = useState(1);
  const renderer = useRef<PhaserOfficeHandle>(null);
  const config = useMemo(readPhaserOfficeConfig, []);
  const slots = useRef<{ companyId: string | null; value: PhaserOfficeSlots }>({ companyId: null, value: { rooms: {}, seats: {} } });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryKey = useMemo(() => ["pixel-office", selectedCompanyId, "snapshot"] as const, [selectedCompanyId]);
  const assets = useQuery({ queryKey: ["pixel-office", "assets"], queryFn: fetchOfficeAssets, staleTime: 60_000 });
  const data = useQuery({ queryKey, queryFn: () => readOfficeSnapshot(selectedCompanyId!), enabled: !!selectedCompanyId, refetchInterval: visibility.visible ? 10_000 : false, refetchIntervalInBackground: false });
  useCompanyLiveEvent(useCallback(event => {
    if (!officeEventNeedsRefresh(event) || timer.current || !selectedCompanyId) return;
    const delay = Number(getComputedStyle(document.documentElement).getPropertyValue("--po-event-batch-ms"));
    timer.current = setTimeout(() => { timer.current = null; void client.invalidateQueries({ queryKey }, { cancelRefetch: false }); }, delay);
  }, [client, queryKey, selectedCompanyId]));
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    setBreadcrumbs([{ label: v3t("office.title") }]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    setSelectedId(null); setDepartment("all"); setMotionOverride(false);
    slots.current = { companyId: selectedCompanyId, value: selectedCompanyId ? loadSlots(selectedCompanyId) : { rooms: {}, seats: {} } };
  }, [selectedCompanyId]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(media.matches); update();
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  const staff = data.data?.agents ?? [];
  const departments = useMemo(() => buildOfficeDepartments(staff, selectedCompanyId ?? ""), [staff, selectedCompanyId]);
  const layout = useMemo(() => {
    if (slots.current.companyId !== selectedCompanyId) slots.current = { companyId: selectedCompanyId, value: selectedCompanyId ? loadSlots(selectedCompanyId) : { rooms: {}, seats: {} } };
    const next = buildPhaserOffice(departments, slots.current.value, config, assets.data?.sprites);
    if (departments.length) slots.current.value = next.slots;
    return next;
  }, [departments, selectedCompanyId, config, assets.data?.sprites]);
  useEffect(() => {
    if (!selectedCompanyId || !data.data) return;
    try { localStorage.setItem("paperclip.office.phaser.slots." + selectedCompanyId, JSON.stringify(layout.slots)); } catch { /* Private browsing can disable storage. */ }
  }, [layout.slots, selectedCompanyId, data.data]);
  const presences = useMemo(() => new Map(staff.map(a => [a.id, deriveOfficePresence(a, data.data?.runs ?? [], data.data?.executions ?? [])])), [staff, data.data]);
  const broken = !!data.error || !!assets.error;
  const selected = staff.find(a => a.id === selectedId) ?? null;
  const presence = selected ? presences.get(selected.id) : null;
  const selectedRoom = selected ? layout.rooms.find(r => r.department.agents.some(a => a.id === selected.id)) : null;
  const currentIssue = selected ? selectOfficeTask(data.data?.issues ?? [], selected.id, presence?.issueId) : undefined;
  const refresh = () => { renderer.current?.retry(); void data.refetch(); void assets.refetch(); };
  const animationPaused = paused || reduce && !motionOverride;
  const toggleAnimation = () => { if (reduce && !motionOverride) { setMotionOverride(true); setPaused(false); } else setPaused(p => !p); };
  const sceneState = useMemo(() => ({ model: layout, presences, selectedId, department, paused: animationPaused || !visibility.visible || broken }), [layout, presences, selectedId, department, animationPaused, visibility.visible, broken]);
  if (!selectedCompanyId) return <EmptyState icon={Building2} message={v3t("office.selectCompany")} />;
  if (data.isPending || assets.isPending) return <PageSkeleton variant="list" />;
  if (!data.data || !assets.data) return <div className="po-error-state"><p>{v3t("office.loadError")}</p><p>{data.error?.message ?? assets.error?.message}</p><Button onClick={refresh}>{v3t("office.retry")}</Button></div>;
  return <div className="pixel-office" data-testid="pixel-office">
    <header className="po-toolbar">
      <div><div className="po-eyebrow">PAPERCLIP / OFFICE</div><h1>{selectedCompany?.name} · {v3t("office.title")}</h1><p>{v3t("office.subtitle", { employees: staff.length, departments: departments.length })}</p></div>
      <div className="po-controls">
        <select aria-label={v3t("office.filterDepartments")} value={department} onChange={e => setDepartment(e.target.value)}><option value="all">{v3t("office.allDepartments")}</option>{departments.map(d => <option key={d.id} value={d.id}>{phaserDepartmentName(d)}</option>)}</select>
        <Button variant="outline" size="icon" onClick={() => renderer.current?.zoomBy(officeNumber("zoom-step"))} aria-label={v3t("office.zoomIn")}><ZoomIn /></Button>
        <Button variant="outline" size="icon" onClick={() => renderer.current?.zoomBy(-officeNumber("zoom-step"))} aria-label={v3t("office.zoomOut")}><ZoomOut /></Button>
        <Button variant="outline" size="icon" onClick={() => renderer.current?.fit()} aria-label={v3t("office.fit")}><Maximize2 /></Button>
        <Button variant="outline" size="icon" onClick={toggleAnimation} aria-label={animationPaused ? v3t("office.playAnimations") : v3t("office.pauseAnimations")} aria-pressed={animationPaused}>{animationPaused ? <Play /> : <Pause />}</Button>
        <Button variant="outline" size="icon" onClick={refresh} aria-label={v3t("office.refresh")} disabled={data.isFetching}><RefreshCw /></Button>
      </div>
    </header>
    {broken && <div className="po-inline-error" role="alert">{v3t("office.stale")} <button onClick={refresh}>{v3t("office.retry")}</button></div>}
    {reduce && !motionOverride && <div className="po-inline-notice" role="status">{v3t("office.motionReduced")} <button onClick={toggleAnimation}>{v3t("office.enableMotion")}</button></div>}
    {!!data.data.projectionFailures && <div className="po-inline-error" role="status">{v3t("office.partialExecution")}</div>}
    {!staff.length ? <EmptyState icon={Building2} message={v3t("office.noStaff")} /> : <div className="po-content">
      <div className="po-view-shell">
        <div className="po-view-caption"><span><span className="po-live-dot" />{v3t("office.live")}</span><span>{Math.round(zoom * 100)}% · {v3t("office.southDoors")}</span></div>
        <PhaserOffice key={selectedCompanyId} ref={renderer} assets={assets.data} state={sceneState} onSelect={setSelectedId} onZoom={setZoom} />
        <div className="po-legend">{AGENT_STATUSES.map(status => <div key={status}><AgentStatusBadge status={status} label={v3t("office.status." + status)} /><strong>{staff.filter(a => a.status === status).length}</strong></div>)}</div>
      </div>
      <aside className="po-inspector">
        <h2>{v3t("office.employeeDetails")}</h2>
        <select className="po-employee-select" aria-label={v3t("office.selectEmployee")} value={selectedId ?? ""} onChange={e => setSelectedId(e.target.value || null)}><option value="">{v3t("office.selectEmployee")}</option>{staff.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        {selected && presence ? <>
          <div className="po-profile-picture"><OfficeNpc assets={assets.data} agentId={selected.id} action={presence.action === "working" ? "typing_seated" : "loaf_coffee"} elapsed={0} hold direction="south" /></div>
          <h3>{selected.name}</h3><AgentStatusBadge status={selected.status} label={v3t("office.status." + selected.status)} />
          <p className="po-activity">{v3t("office.action." + presence.action)}</p>
          <dl><dt>{v3t("office.department")}</dt><dd>{selectedRoom ? phaserDepartmentName(selectedRoom.department) : "—"}</dd><dt>{v3t("office.role")}</dt><dd>{selected.title ?? selected.role}</dd><dt>{v3t("office.currentTask")}</dt><dd>{currentIssue ? <Link to={"/issues/" + currentIssue.id}>{currentIssue.identifier} · {currentIssue.title}</Link> : v3t("office.noCurrentTask")}</dd>{presence.phase && <><dt>{v3t("office.executionPhase")}</dt><dd>{v3t("office.phase." + presence.phase)}</dd></>}</dl>
          <Button asChild variant="outline"><Link to={agentUrl(selected)}>{v3t("office.openEmployee")}</Link></Button>
        </> : <div className="po-inspector-empty"><Building2 /><p>{v3t("office.clickEmployee")}</p></div>}
        <div className="po-inspector-note"><h3>{v3t("office.dynamicLayout")}</h3><p>{v3t("office.layoutNote")}</p><p>{v3t("office.statusNote")}</p></div>
      </aside>
    </div>}
  </div>;
}
