import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Read only known CLI profile files; never persist file contents or credentials. */
export async function quotaNativeConfigIdentity(adapterType: string, env: Record<string, unknown>, cwd?: unknown) {
  const homeKey = adapterType === "codex_local" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const configuredHome = env[homeKey] ?? process.env[homeKey];
  if (configuredHome !== undefined && typeof configuredHome !== "string") throw new Error("quota_probe_native_home_unsupported");
  const home = configuredHome || path.join(os.homedir(), adapterType === "codex_local" ? ".codex" : ".claude");
  const paths = adapterType === "codex_local"
    ? [path.join(home, "auth.json"), path.join(home, "config.toml")]
    : [path.join(home, ".credentials.json"), path.join(home, "settings.json"), ...(typeof cwd === "string" ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : [])];
  return await Promise.all(paths.map(async file => {
    let digest = "missing";
    try {
      if ((await stat(file)).size > 1_048_576) throw new Error("quota_probe_native_config_too_large");
      digest = createHash("sha256").update(await readFile(file)).digest("hex");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("quota_probe_native_config_unreadable"); }
    return { pathHash: createHash("sha256").update(path.resolve(file)).digest("hex"), digest };
  }));
}
