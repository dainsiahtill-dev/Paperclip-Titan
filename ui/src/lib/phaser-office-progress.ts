import type { LiveEvent } from "@paperclipai/shared";
import type { OfficeAction, OfficeExecution, OfficePresence, OfficeRun } from "./pixel-office";

export interface OfficeWorkOutput {
  companyId: string; agentId: string; runId: string; at: number;
  text?: string; toolKey?: string;
  expiresAt: number;
}
export type OfficeOutputCandidate = Omit<OfficeWorkOutput, "expiresAt"> & { fragment?: string; messageId?: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Only public progress summaries are used, never raw provider logs or tool arguments. */
function brief(value: unknown): string | undefined {
  const text = string(value).replace(/\u001b\[[0-9;]*m/g, "");
  let inCode = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("```")) { inCode = !inCode; continue; }
    if (inCode) continue;
    const plain = line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
    if (!plain || /^[{[]/.test(plain) || /^(?:at\s+\S+\s*\(|Traceback|\$\s)/.test(plain)) continue;
    if (/^(?:working|running|waiting|queued|preparing|finishing|started|completed|run[ ._-](?:activity|started)|session[ ._-]started|工作中|运行中|等待中|排队中|准备中|休息中|离岗中)[.!。…]*$/i.test(plain)) return;
    if (/^(?:item|message|assistant|tool|turn|session|run)[ ._-]+(?:started|completed|delta|result|output|event|ready)$/i.test(plain)) return;
    const first = plain.split(/[。！？]|[.!?](?=\s|$)/)[0].trim();
    const clause = first.split(/[，,；;]/)[0].trim();
    const summary = Array.from(clause).length >= 6 ? clause : first;
    const chars = Array.from(summary);
    if (chars.length >= 2) return chars.length > 36 ? chars.slice(0, 35).join("") + "…" : summary;
  }
}

function toolKey(value: unknown): string | undefined {
  const name = string(value).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (!name) return;
  if (/\b(test|pytest|vitest)\b/.test(name)) return "office.output.test";
  if (/\b(build|compile)\b/.test(name)) return "office.output.build";
  if (/\b(search|grep|find|rg)\b/.test(name)) return "office.output.search";
  if (/\b(browser|web|fetch|url|navigate)\b/.test(name)) return "office.output.browse";
  if (/\b(read|readfile|view)\b|open file/.test(name)) return "office.output.read";
  if (/\b(edit|write|patch)\b/.test(name)) return "office.output.edit";
  if (/\b(exec|execute|shell|bash|terminal|command)\b/.test(name)) return "office.output.command";
  return "office.output.tool";
}

function candidate(companyId: string, payload: Record<string, unknown>, timestamp: unknown, eventType = ""): OfficeOutputCandidate | undefined {
  const nested = record(payload.payload);
  const channels = [eventType, payload.channel, nested.channel, record(nested.message).channel, record(nested.item).channel, record(nested.item).type, record(nested.delta).type].map(string).join(" ");
  if (/reasoning|thinking|analysis|lifecycle|adapter\.invoke/i.test(channels) || payload.stream === "stderr") return;
  const agentId = string(payload.agentId), runId = string(payload.runId);
  const at = timestamp instanceof Date ? timestamp.getTime() : Date.parse(string(timestamp));
  if (!agentId || !runId || !Number.isFinite(at)) return;
  if (/delta/i.test(eventType)) {
    if (/tool|command|stdout|stderr/i.test(channels)) return;
    const fragment = [nested.delta, nested.text_delta, record(nested.delta).text, nested.text, payload.lastAssistantSnippet].find(value => typeof value === "string" && value.length > 0);
    if (typeof fragment !== "string" || !fragment) return;
    return { companyId, agentId, runId, at, fragment, messageId: string(nested.itemId ?? nested.messageId ?? nested.message_id ?? record(nested.item).id) };
  }
  const message = string(payload.message);
  const usesTool = /^using\s+/i.test(message) || /tool|command/i.test(eventType);
  const tool = toolKey(payload.currentToolName || message.match(/^using\s+(\S+)/i)?.[1] || (usesTool ? eventType : ""));
  const text = usesTool && tool ? undefined : brief(message || payload.lastAssistantSnippet);
  if (message && !text && !usesTool) return;
  const key = text ? undefined : tool;
  if (!text && !key) return;
  return { companyId, agentId, runId, at, text, toolKey: key };
}

export function readOfficeProgressEvent(event: LiveEvent): OfficeOutputCandidate | undefined {
  if (event.type !== "heartbeat.run.progress" && event.type !== "heartbeat.run.event") return;
  const p = event.payload;
  if (event.type === "heartbeat.run.progress" && p.phase && !["run_activity", "working", "finishing"].includes(string(p.phase))) return;
  return candidate(event.companyId, p, p.updatedAt ?? p.lastEventAt ?? event.createdAt, string(p.eventType));
}

export function readOfficeRunOutput(companyId: string, run: OfficeRun): OfficeOutputCandidate | undefined {
  if (run.status !== "running") return;
  return candidate(companyId, { agentId: run.agentId, runId: run.id, message: run.currentStatusMessage, lastAssistantSnippet: run.lastAssistantSnippet, currentToolName: run.currentToolName }, run.currentStatusUpdatedAt ?? run.lastEventAt);
}

export function officeWorkRunIds(presences: ReadonlyMap<string, OfficePresence>, executions: readonly OfficeExecution[]): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const [agentId, presence] of presences) {
    if (presence.action !== "working") continue;
    if (presence.run) {
      if (presence.run.status === "running" && presence.run.agentId === agentId) bindings.set(agentId, presence.run.id);
    } else {
      const execution = executions.find(e => e.agentId === agentId && e.currentRun && e.issueId === presence.issueId && e.phase === presence.phase && ["working", "finishing"].includes(e.phase));
      if (execution?.runId) bindings.set(agentId, execution.runId);
    }
  }
  return bindings;
}

export function visibleOfficeWorkOutput(output: OfficeWorkOutput | undefined, companyId: string, runId: string | undefined, action: OfficeAction, now: number): OfficeWorkOutput | undefined {
  return action === "working" && output?.companyId === companyId && output.runId === runId && output.expiresAt > now ? output : undefined;
}

/** Content deduplication survives expiry and polling: silence must stay silent. */
export class OfficeProgressTracker {
  private companyId: string | null = null;
  private bindings: ReadonlyMap<string, string> = new Map();
  private entries = new Map<string, { key: string; at: number; output: OfficeWorkOutput }>();
  private chunks = new Map<string, { runId: string; id?: string; raw: string; last: string; at: number }>();
  reconcile(companyId: string | null, bindings: ReadonlyMap<string, string>) {
    if (this.companyId !== companyId) { this.entries.clear(); this.chunks.clear(); }
    this.companyId = companyId; this.bindings = bindings;
    for (const [id, entry] of this.entries) if (bindings.get(id) !== entry.output.runId) this.entries.delete(id);
    for (const [id, chunk] of this.chunks) if (bindings.get(id) !== chunk.runId) this.chunks.delete(id);
  }
  accept(value: OfficeOutputCandidate | undefined, now: number, duration: number): boolean {
    if (!value || value.companyId !== this.companyId || this.bindings.get(value.agentId) !== value.runId || value.at + duration <= now || value.at > now + duration) return false;
    const chunk = this.chunks.get(value.agentId);
    if (value.fragment !== undefined) {
      if (chunk && value.at < chunk.at || chunk && value.at === chunk.at && value.fragment === chunk.last) return false;
      const append = chunk?.runId === value.runId && chunk.id === value.messageId && value.at - chunk.at < duration;
      const raw = ((append ? chunk!.raw : "") + value.fragment).slice(0, 600);
      this.chunks.set(value.agentId, { runId: value.runId, id: value.messageId, raw, last: value.fragment, at: value.at });
      const text = brief(raw); if (!text) return false;
      value = { ...value, text };
    } else if (chunk?.at === value.at && value.text && value.text === brief(chunk.last)) {
      // The same delta is also broadcast as a runtime-status update.
      return false;
    } else if (value.toolKey) {
      this.chunks.delete(value.agentId);
    }
    const previous = this.entries.get(value.agentId), key = value.runId + ":" + (value.text ?? value.toolKey);
    if (previous && value.at < previous.at) return false;
    if (previous?.key === key) { previous.at = value.at; return false; }
    this.entries.set(value.agentId, { key, at: value.at, output: { ...value, expiresAt: Math.min(value.at, now) + duration } });
    return true;
  }
  snapshot(now: number): Map<string, OfficeWorkOutput> {
    return new Map([...this.entries].filter(([, e]) => e.output.expiresAt > now).map(([id, e]) => [id, e.output]));
  }
}
