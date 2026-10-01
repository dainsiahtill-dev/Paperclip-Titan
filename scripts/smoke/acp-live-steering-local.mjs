import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(new URL('../../packages/adapter-utils/package.json', import.meta.url));
const { createAcpRuntime, createAgentRegistry, createFileSessionStore } = await import(pathToFileURL(require.resolve('acpx/runtime')).href);
const provider = process.argv[2];
if (!['codex', 'claude'].includes(provider)) throw new Error('Expected codex or claude');
if (provider === 'claude') {
  const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
  for (const [name, value] of Object.entries(settings.env ?? {})) {
    if ((name.startsWith('ANTHROPIC_') || name === 'API_TIMEOUT_MS' || name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') && typeof value === 'string') process.env[name] = value;
  }
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-live-${provider}-`));
spawnSync('rtk', ['proxy', 'git', 'init', '-q', root], { stdio: 'ignore' });
const packageName = provider === 'codex' ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp';
const providerRequire = createRequire(new URL(`../../packages/adapters/${provider}-local/package.json`, import.meta.url));
const entry = provider === 'claude'
  ? fileURLToPath(new URL('../../packages/adapters/claude-local/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', import.meta.url))
  : providerRequire.resolve(packageName);
const runtime = createAcpRuntime({ cwd: root, sessionStore: createFileSessionStore({ stateDir: path.join(root, 'state') }), agentRegistry: createAgentRegistry({ overrides: { custom: `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}` } }), permissionMode: 'approve-all', nonInteractivePermissions: 'approve-all', timeoutMs: 120000, onAgentStderr: (chunk) => { void fs.appendFile(path.join(root, 'agent-stderr.log'), chunk, { mode: 0o600 }); } });
let handle, turn;
let steering, toolCompleted = false, toolObserved = false;
const output = [];
try {
  const configuredCodexDirectory = process.env.PAPERCLIP_STEERING_SMOKE_CODEX_CONFIG_DIR;
  const configuredCodexBinary = process.env.PAPERCLIP_STEERING_SMOKE_CODEX_BINARY;
  handle = await runtime.ensureSession({ sessionKey: `live-smoke-${provider}`, agent: 'custom', mode: 'persistent', cwd: root, sessionOptions: { model: provider === 'codex' ? 'gpt-6.1-sol' : 'MiniMax-M3.1-Flash-Preview', env: { CUDA_VISIBLE_DEVICES: '', ...(provider === 'codex' && configuredCodexDirectory ? { CODEX_HOME: configuredCodexDirectory } : {}), ...(provider === 'codex' && configuredCodexBinary ? { CODEX_PATH: configuredCodexBinary } : {}) } } });
  if (provider === 'claude') await runtime.setMode({ handle, mode: 'bypassPermissions' });
  turn = runtime.startTurn({ handle, text: 'Only work inside the current scratch directory. First run one CPU shell command beginning with rtk: use Python to wait 2 seconds and write original.txt with content ORIGINAL. Then in a separate shell command write finish.txt with content FINISHED. Do not access project files or use a GPU. Finally briefly report done.', mode: 'prompt', requestId: `live-smoke-${provider}`, timeoutMs: 120000 });
  for await (const event of turn.events) {
    if (event.type === 'text_delta') output.push(event.text);
    if (event.type === 'tool_call') {
      if (event.status === 'in_progress' || event.status === 'pending') toolObserved = true;
      if (event.status === 'completed' && toolObserved && !steering) {
        toolCompleted = true;
        steering = await turn.steer({ text: 'Additional task handoff: preserve the original work and finish.txt, and also write handoff.txt containing RECEIVED_IN_SAME_TURN before your final answer. Use CPU only and commands beginning with rtk. Mention SAME_TURN_HANDOFF in the final answer.', correlationId: `smoke-handoff-${provider}` });
        console.log(JSON.stringify({ provider, acknowledgement: steering, sameRequestId: turn.requestId }));
      }
    }
  }
  const result = await turn.result;
  const files = {};
  for (const name of ['original.txt', 'finish.txt', 'handoff.txt']) { try { files[name] = await fs.readFile(path.join(root, name), 'utf8'); } catch { files[name] = null; } }
  const receipt = { provider, root, result, toolObserved, toolCompleted, steering, files, finalMarker: output.join('').includes('SAME_TURN_HANDOFF'), sameTurnReceived: steering?.outcome === 'injected' && files['handoff.txt'] === 'RECEIVED_IN_SAME_TURN', originalPreserved: files['original.txt'] === 'ORIGINAL' && files['finish.txt'] === 'FINISHED' };
  await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
  console.log(JSON.stringify(receipt));
  if (!receipt.sameTurnReceived || !receipt.originalPreserved) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally {
  if (turn) await turn.cancel().catch(() => {});
  if (handle) await runtime.close({ handle, reason: 'live smoke ended', discardPersistentState: false }).catch(() => {});
}
