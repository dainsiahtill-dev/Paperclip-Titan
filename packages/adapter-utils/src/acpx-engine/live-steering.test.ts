import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAcpRuntime, createAgentRegistry, createFileSessionStore, type AcpRuntimeTurn } from 'acpx/runtime';
import { createLiveAcpSteering } from './live-steering.js';
import { createAcpxEngineExecutor } from './execute.js';
import type { AdapterExecutionContext, AdapterLiveSteeringControl } from '../types.js';

type LiveTurn = AcpRuntimeTurn & {
  steeringState?: () => Promise<{ supported: boolean; active: boolean }>;
  steer?: (input: { text: string; correlationId: string }) => Promise<{ outcome: 'injected' | 'promptRequired'; reason?: string }>;
};

it.each([false, true])('delivers new input through the active ACP channel without a second prompt or cancellation, tool boundary: %s', async (hasTool) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-live-steering-'));
  const fixture = fileURLToPath(new URL('../../../../scripts/mcp-fixtures/servers/acp-live-steering-agent.mjs', import.meta.url));
  const runtime = createAcpRuntime({ cwd: root, sessionStore: createFileSessionStore({ stateDir: path.join(root, 'state') }), agentRegistry: createAgentRegistry({ overrides: { custom: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${JSON.stringify(root)} ${hasTool ? 'tool' : ''}` } }), permissionMode: 'approve-all', timeoutMs: 5000 });
  const handle = await runtime.ensureSession({ sessionKey: 'live-handoff', agent: 'custom', mode: 'persistent', cwd: root });
  const turn = runtime.startTurn({ handle, text: 'original task', mode: 'prompt', requestId: 'original-run', timeoutMs: 5000 }) as LiveTurn;
  const output: string[] = [];
  const live = createLiveAcpSteering(turn);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const consuming = (async () => { for await (const event of turn.events) { live.observe(event); if (event.type === 'text_delta') { output.push(event.text); if (event.text.includes('original-work-in-flight')) ready(); } } })();
  try {
    await started;
    expect(turn.steer).toBeTypeOf('function');
    expect(await turn.steeringState!()).toEqual({ supported: true, active: true });
    if (hasTool) {
      expect(await live.control.send({ text: 'follow the updated handoff', correlationId: 'comment-1' })).toEqual({ outcome: 'deferred', reason: 'tool_in_progress' });
      await expect.poll(async () => (await live.control.state()).busy).toBe(false);
    }
    const acknowledgement = await live.control.send({ text: 'follow the updated handoff', correlationId: 'comment-1' });
    expect(acknowledgement.outcome).toBe('injected');
    expect(await turn.steer!({ text: 'follow the updated handoff', correlationId: 'comment-1' })).toEqual({ outcome: 'injected' });
    expect(await turn.result).toMatchObject({ status: 'completed' });
    await consuming;
    expect(output.join('')).toContain('received:follow the updated handoff');
    expect(await fs.readFile(path.join(root, 'continued'), 'utf8')).toBe('follow the updated handoff');
    const requests = (await fs.readFile(path.join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === 'session/prompt')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'session/new')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'session/cancel')).toHaveLength(0);
    expect(requests.filter((request) => request.method === '_session/steering')).toHaveLength(1);
    expect(requests.find((request) => request.method === '_session/steering').params).toMatchObject({ sessionId: 'same-session', _meta: { steering: { idleBehavior: 'promptRequired' } } });
  } finally {
    await turn.cancel().catch(() => {});
    await turn.result;
    await consuming;
    await runtime.close({ handle, reason: 'test finished', discardPersistentState: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 12000);

it('registers the running adapter channel, injects at its tool boundary and removes it on completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-live-adapter-'));
  const fixture = fileURLToPath(new URL('../../../../scripts/mcp-fixtures/servers/acp-live-steering-agent.mjs', import.meta.url));
  const abort = new AbortController();
  const controls: Array<AdapterLiveSteeringControl | null> = [];
  let received = false;
  const ctx = {
    runId: 'same-adapter-run', agent: { id: 'agent', companyId: 'company' }, runtime: {},
    config: { agent: 'custom', agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${JSON.stringify(root)} tool`,
      mode: 'persistent', stateDir: path.join(root, 'state'), cwd: root, timeoutSec: 8, graceSec: 1 },
    context: { prompt: 'original task' }, signal: abort.signal,
    onLog: async (_stream: string, text: string) => { if (text.includes('received:adapter handoff')) received = true; },
    onSteeringReady: async (control: AdapterLiveSteeringControl | null) => {
      controls.push(control);
      if (control && !(await control.state()).busy) {
        expect(await control.send({ text: 'adapter handoff', correlationId: 'agent-comment' })).toEqual({ outcome: 'injected' });
      }
    },
  } as unknown as AdapterExecutionContext;
  try {
    const result = await createAcpxEngineExecutor()(ctx);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(controls.at(-1)).toBeNull();
    expect(received).toBe(true);
    expect(await fs.readFile(path.join(root, 'continued'), 'utf8')).toBe('adapter handoff');
    const requests = (await fs.readFile(path.join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === 'session/prompt')).toHaveLength(1);
    expect(requests.filter((request) => request.method === '_session/steering')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'session/cancel')).toHaveLength(0);
  } finally {
    abort.abort();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 12000);
