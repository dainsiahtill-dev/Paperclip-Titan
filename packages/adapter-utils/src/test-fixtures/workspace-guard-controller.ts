import fs from "node:fs/promises";
import { withWorkspaceProcessGuard, runChildProcess } from "../server-utils.js";
const [root, launchId, script] = process.argv.slice(2);
if (!root || !launchId || !process.send) throw new Error("Private controller fixture requires root, launch and IPC");
const stat = await fs.stat(root);
await withWorkspaceProcessGuard({ root, device: String(stat.dev), inode: String(stat.ino),
  beforeLaunch: async () => launchId,
  bindLaunch: async identity => {
    const ack = new Promise<void>(resolve => process.once("message", () => resolve()));
    process.send!({ type: "identity", identity }); await ack;
  },
  recordDrain: async identity => { process.send!({ type: "drained", identity }); },
  markUnknown: async () => { process.send!({ type: "unknown" }); },
}, () => runChildProcess("private-controller", "/bin/sh", ["-c", script ?? "setsid /bin/sh -c 'printf ready; sleep 0.4; printf unsafe > late' & wait"], {
  cwd: root, env: {}, timeoutSec: 2, graceSec: 1,
  onLog: async (_stream, text) => { if (text.includes("ready")) process.send!({ type: "ready" }); },
}));
