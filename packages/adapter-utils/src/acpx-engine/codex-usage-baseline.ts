import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCodexCumulativeUsage, type AcpUsageScope, type CodexCumulativeUsage } from "./usage-accounting.js";

export interface CodexRolloutEvidence {
  usage: CodexCumulativeUsage;
  sessionId: string;
  scopeHash: string;
  fileSha256: string;
  fileIdentity: { device: number; inode: number; uid: number; birthtimeMs: number };
  observedAt: string;
  counterTimestamp: string;
  witness?: CodexRolloutWitness;
}

export interface CodexRolloutWitness {
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

/** Read only an explicit managed home and exact provider session, never a default home. */
export async function readScopedCodexRollout(input: {
  codexHome: string;
  sessionId: string;
  scope: AcpUsageScope;
  requireCurrentRun?: boolean;
  expectedFileIdentity?: CodexRolloutEvidence["fileIdentity"];
  expectedWitness?: CodexRolloutWitness;
  holdOpen?: boolean;
  before?: number;
}): Promise<CodexRolloutEvidence | null> {
  // A closed stat tuple is not a generation witness: the filesystem can reuse
  // inode and birthtime together. Only a still-open original inode is usable.
  if (input.expectedFileIdentity && !input.expectedWitness) return null;
  if (input.expectedWitness && !await input.expectedWitness.verify()) return null;
  if (!path.isAbsolute(input.codexHome) || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(input.sessionId)) return null;
  const expectedUid = process.getuid?.();
  const candidates: string[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number) {
    if (depth > 4 || visited > 2048) return;
    let stat;
    try { stat = await fs.lstat(directory); } catch { return; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || expectedUid !== undefined && stat.uid !== expectedUid) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++visited > 2048) return;
      if (entry.isSymbolicLink()) continue;
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`-${input.sessionId}.jsonl`)) candidates.push(name);
    }
  }
  let descriptor: Awaited<ReturnType<typeof fs.open>> | null = null;
  let transferred = false;
  try {
    const home = await fs.lstat(input.codexHome);
    if (!home.isDirectory() || home.isSymbolicLink() || expectedUid !== undefined && home.uid !== expectedUid) return null;
    await walk(path.join(input.codexHome, "sessions"), 0);
    await walk(path.join(input.codexHome, "archived_sessions"), 0);
    if (candidates.length !== 1) return null;
    const name = candidates[0];
    const before = await fs.lstat(name);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16_000_000 || expectedUid !== undefined && before.uid !== expectedUid) return null;
    const identity = { device: before.dev, inode: before.ino, uid: before.uid, birthtimeMs: before.birthtimeMs };
    if (input.expectedFileIdentity && Object.entries(identity).some(([key, value]) => value !== input.expectedFileIdentity![key as keyof typeof identity])) return null;
    descriptor = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await descriptor.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid) return null;
    const bytes = await descriptor.readFile();
    const after = await fs.lstat(name);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    const lines = bytes.toString("utf8").split("\n").filter(Boolean);
    const records = lines.map((line) => JSON.parse(line) as Record<string, any>);
    const meta = records[0];
    if (meta?.type !== "session_meta" || meta.payload?.id !== input.sessionId || meta.payload?.originator !== "acpx" || typeof meta.payload.cwd !== "string" || path.resolve(meta.payload.cwd) !== path.resolve(input.scope.cwd)) return null;
    const text = bytes.toString("utf8");
    if (![input.scope.companyId, input.scope.agentId, input.scope.issueId].filter(Boolean).every((id) => text.includes(String(id)))) return null;
    if (input.requireCurrentRun && !text.includes(input.scope.runId)) return null;
    const contexts = records.filter((item) => item.type === "turn_context");
    if (contexts.some((item) => typeof item.payload?.cwd === "string" && path.resolve(item.payload.cwd) !== path.resolve(input.scope.cwd))) return null;
    if (input.scope.model && contexts.some((item) => item.payload?.model && item.payload.model !== input.scope.model)) return null;
    let latest: CodexCumulativeUsage | null = null;
    let timestamp = "";
    for (const item of records) {
      if (item.type !== "event_msg" || item.payload?.type !== "token_count") continue;
      const raw = item.payload.info?.total_token_usage;
      const usage = readCodexCumulativeUsage({ inputTokens: raw?.input_tokens, cachedInputTokens: raw?.cached_input_tokens, outputTokens: raw?.output_tokens, totalTokens: raw?.total_tokens });
      const at = Date.parse(item.timestamp);
      if (!usage || !Number.isFinite(at) || input.before !== undefined && at > input.before) return null;
      if (latest && Object.keys(latest).some((key) => usage[key as keyof typeof usage] < latest![key as keyof typeof usage])) return null;
      latest = usage; timestamp = new Date(at).toISOString();
    }
    if (!latest) return null;
    const held = descriptor;
    let closed = false;
    const witness: CodexRolloutWitness = {
      async verify() {
        if (closed) return false;
        try {
          const [current, original] = await Promise.all([fs.lstat(name), held.stat()]);
          return !current.isSymbolicLink() && current.isFile() && current.dev === original.dev && current.ino === original.ino && current.uid === original.uid && original.nlink > 0;
        } catch { return false; }
      },
      async close() { if (!closed) { closed = true; await held.close(); } },
    };
    transferred = input.holdOpen === true;
    return { usage: latest, sessionId: input.sessionId, scopeHash: createHash("sha256").update(JSON.stringify([input.scope.companyId, input.scope.agentId, input.scope.issueId, input.scope.cwd, input.scope.model, input.sessionId])).digest("hex"), fileSha256: createHash("sha256").update(bytes).digest("hex"), fileIdentity: identity, observedAt: new Date().toISOString(), counterTimestamp: timestamp, ...(transferred ? { witness } : {}) };
  } catch { return null; }
  finally { if (descriptor && !transferred) await descriptor.close().catch(() => {}); }
}
