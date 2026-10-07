import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export async function localWorkspaceRealm() {
  if (process.platform !== "linux") throw new Error("workspace_write_ownership_unsupported_host");
  const machine = (await fs.readFile("/etc/machine-id", "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(machine)) throw new Error("workspace_write_ownership_unverified_realm");
  return createHash("sha256").update(`linux-local:${machine}`).digest("hex");
}

export async function physicalWorkspaceIdentity(cwd: string) {
  const realm = await localWorkspaceRealm();
  const root = await fs.realpath(cwd);
  const stat = await fs.stat(root);
  if (!stat.isDirectory() || root === "/") throw new Error("workspace_write_ownership_invalid_root");
  const device = String(stat.dev), inode = String(stat.ino);
  const resourceKey = createHash("sha256").update(`${realm}:${device}:${inode}`).digest("hex");
  return { root, device, inode, realm, resourceKey };
}

export type PhysicalWorkspaceIdentity = Awaited<ReturnType<typeof physicalWorkspaceIdentity>>;
