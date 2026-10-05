import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export function legacyClosureError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function processStat(raw: string) {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  const pid = Number(raw.slice(0, raw.indexOf(" "))), parent = Number(fields[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(parent) || !/^\d+$/.test(fields[19] ?? ""))
    throw legacyClosureError("host_database_unverified");
  return { pid, parent, startTicks: fields[19]! };
}

/** Operator authority comes from kernel facts witnessed by the actual connected
 * local PostgreSQL transaction. No boot/namespace/actor values are caller inputs. */
export async function readLegacyWorkspaceHost(db: Pick<Db, "execute">) {
  if (process.platform !== "linux" || process.getuid === undefined) throw legacyClosureError("host_operator_required");
  if (process.env.PAPERCLIP_RUN_ID || process.env.PAPERCLIP_AGENT_ID || process.env.PAPERCLIP_API_KEY)
    throw legacyClosureError("host_operator_required");
  try {
    const rows = await db.execute<{
      pid: number; database: string; cluster: string; directory: string;
      process_stat: string; boot_id: string; postmaster_file: string; backend_start: string;
    }>(sql`select pg_backend_pid() as pid, current_database() as database,
      (pg_control_system()).system_identifier::text as cluster,
      current_setting('data_directory') as directory,
      pg_read_file('/proc/self/stat') as process_stat,
      pg_read_file('/proc/sys/kernel/random/boot_id') as boot_id,
      pg_read_file('postmaster.pid', 0, 1024) as postmaster_file,
      (select backend_start::text from pg_stat_activity where pid = pg_backend_pid()) as backend_start`);
    const row = rows[0]; if (!row) throw legacyClosureError("host_database_unverified");
    const backend = processStat(row.process_stat);
    const postmasterPid = Number(row.postmaster_file.split("\n")[0]);
    if (backend.pid !== row.pid || backend.parent !== postmasterPid || postmasterPid <= 1)
      throw legacyClosureError("host_database_unverified");
    const masterRows = await db.execute<{ process_stat: string }>(sql`select pg_read_file(${`/proc/${postmasterPid}/stat`}) as process_stat`);
    const master = processStat(masterRows[0]?.process_stat ?? "");
    if (master.pid !== postmasterPid) throw legacyClosureError("host_database_unverified");
    const [boot, pidNamespace, mountNamespace, directory] = await Promise.all([
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"), fs.readlink("/proc/self/ns/pid"),
      fs.readlink("/proc/self/ns/mnt"), fs.realpath(row.directory),
    ]);
    const uid = process.getuid();
    if (boot.trim() !== row.boot_id.trim() || !/^[a-f0-9-]{36}$/.test(boot.trim()))
      throw legacyClosureError("host_database_unverified");
    for (const expected of [backend, master]) {
      const observed = processStat(await fs.readFile(`/proc/${expected.pid}/stat`, "utf8"));
      const [stat, ns, mount, cwd, executable] = await Promise.all([
        fs.stat(`/proc/${expected.pid}`), fs.readlink(`/proc/${expected.pid}/ns/pid`),
        fs.readlink(`/proc/${expected.pid}/ns/mnt`), fs.realpath(`/proc/${expected.pid}/cwd`),
        fs.readlink(`/proc/${expected.pid}/exe`),
      ]);
      if (observed.pid !== expected.pid || observed.parent !== expected.parent || observed.startTicks !== expected.startTicks
        || stat.uid !== uid || ns !== pidNamespace || mount !== mountNamespace || cwd !== directory
        || path.basename(executable.replace(/ \(deleted\)$/, "")) !== "postgres")
        throw legacyClosureError("host_database_unverified");
    }
    const directoryStat = await fs.stat(directory);
    if (directoryStat.uid !== uid || !directoryStat.isDirectory()) throw legacyClosureError("host_database_unverified");
    return {
      uid, bootId: boot.trim(), pidNamespace, mountNamespace,
      database: { cluster: row.cluster, name: row.database, directory, device: String(directoryStat.dev), inode: String(directoryStat.ino) },
      witness: { backendPid: backend.pid, backendStartTicks: backend.startTicks, backendStartedAt: row.backend_start,
        postmasterPid: master.pid, postmasterStartTicks: master.startTicks },
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "host_operator_required") throw error;
    throw legacyClosureError("host_database_unverified");
  }
}

export type LegacyWorkspaceHost = Awaited<ReturnType<typeof readLegacyWorkspaceHost>>;
