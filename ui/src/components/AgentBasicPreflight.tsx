import { useEffect, useId, useRef, useState } from "react";
import { agentReadinessRequirementsSchema, type AgentPreflightResult, type AgentReadinessRequirements } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { Button } from "./ui/button";

export function AgentBasicPreflight({ agentId, companyId, requirements, onRequirementsChange, disabled }: {
  agentId: string; companyId: string; requirements: unknown;
  onRequirementsChange: (value: AgentReadinessRequirements) => void; disabled: boolean;
}) {
  const id = useId();
  const savedJson = JSON.stringify(requirements ?? {}, null, 2);
  const [draft, setDraft] = useState(savedJson);
  const [validation, setValidation] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AgentPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => { setDraft(savedJson); setResult(null); setError(null); }, [savedJson, agentId]);
  useEffect(() => { requestVersion.current++; setPending(false); setResult(null); }, [disabled, savedJson, agentId]);
  const apply = () => {
    try {
      const parsed = agentReadinessRequirementsSchema.safeParse(JSON.parse(draft));
      if (!parsed.success) { setValidation(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
      setValidation(null); onRequirementsChange(parsed.data); setResult(null);
    } catch { setValidation("Enter a JSON object with interpreter, skill and governed connection requirements."); }
  };
  const run = async () => {
    const version = ++requestVersion.current;
    setPending(true); setError(null); setResult(null);
    try { const report = await agentsApi.basicPreflight(agentId, companyId); if (version === requestVersion.current) setResult(report); }
    catch (cause) { if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : "Basic check failed."); }
    finally { if (version === requestVersion.current) setPending(false); }
  };
  return <section className="space-y-3 border-t border-border pt-3" aria-labelledby={`${id}-title`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 id={`${id}-title`} className="text-sm font-medium">Basic toolchain check</h4>
      <Button type="button" variant="outline" size="sm" disabled={disabled || pending || draft !== savedJson} onClick={run}>{pending ? "Checking…" : "Run basic check"}</Button>
    </div>
    <p className="text-xs text-muted-foreground">No model request or package install. Checks saved settings and approved local tools in a disposable, source-read-only environment. Remote targets and credential-dependent probes remain unverified. Save edits before checking.</p>
    <details className="text-sm">
      <summary className="cursor-pointer">Required tools and expected settings</summary>
      <div className="space-y-2 pt-2">
        <label htmlFor={`${id}-requirements`} className="block text-xs font-medium">Readiness requirements (JSON)</label>
        <textarea id={`${id}-requirements`} aria-describedby={`${id}-help`} aria-invalid={Boolean(validation)} value={draft} onChange={event => { setDraft(event.target.value); setValidation(null); }} rows={8} className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs" />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">Use interpreters (python, python3, node, git), skills (workspacePath ending in SKILL.md, or a managed skill key), mcp (installed connectionId and requiredTools), and expected cwd/projectId/target/sandbox/model/effort. Connection references retain existing grants and tool permissions.</p>
        <Button type="button" variant="outline" size="sm" onClick={apply} disabled={pending || draft === savedJson}>Apply requirements to draft</Button>
        {validation && <p role="alert" className="text-xs text-destructive">{validation}</p>}
      </div>
    </details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div className="space-y-2" aria-live="polite">
      <p className="text-sm font-medium">Basic check: {result.status}</p>
      <dl className="grid grid-cols-1 gap-1 text-xs text-muted-foreground">
        <div><dt className="inline font-medium">Target: </dt><dd className="inline break-all">{result.profile.target} · {result.profile.cwd ?? "cwd unresolved"}</dd></div>
        <div><dt className="inline font-medium">Saved profile: </dt><dd className="inline break-all">{result.profile.model ?? "model default unresolved"} · {result.profile.effort ?? "effort default unresolved"} · {result.profile.sandbox ?? "sandbox unresolved"}</dd></div>
        <div><dt className="inline font-medium">Checked: </dt><dd className="inline">{result.testedAt}</dd></div>
      </dl>
      <ul className="space-y-2">{result.checks.map((check, index) => <li key={`${check.code}-${index}`} className="text-sm">
        <span className="font-medium">{check.status}: </span>{check.message}
        {check.detail && <p className="break-all text-xs text-muted-foreground">{check.detail}</p>}
      </li>)}</ul>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Evidence fingerprint</summary><p className="break-all">{result.profileDigest}</p><p>Source: saved employee configuration. Runtime-home delivery and model entitlement require separate verification.</p></details>
    </div>}
  </section>;
}
