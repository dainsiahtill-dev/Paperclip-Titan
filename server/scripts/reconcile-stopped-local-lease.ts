import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { resolveDatabaseTarget } from "@paperclipai/db/runtime-config";
import {
  LocalLeaseReconciliationError,
  reconcileStoppedLegacyLocalLease,
  stoppedLegacyLocalLeaseSelectorSchema,
} from "../src/services/legacy-process-capacity.js";

// This is an explicitly local operator command, not an Agent tool or an HTTP
// bypass. It connects to the existing configured database; it never boots or
// migrates a database, signals processes, loads a model, or enqueues work.
async function main(): Promise<void> {
  let connectionString: string | null = null;
  try {
    const { values } = parseArgs({ options: {
      selector: { type: "string" },
      config: { type: "string" },
      apply: { type: "boolean", default: false },
    }, strict: true, allowPositionals: false });
    const config = values.config ?? process.env.PAPERCLIP_CONFIG;
    if (!values.selector || !config?.trim()) {
      console.error(JSON.stringify({ outcome: "refused", code: "explicit_selector_and_config_required" }));
      process.exitCode = 1;
      return;
    }
    process.env.PAPERCLIP_CONFIG = resolve(config);
    const selector: unknown = JSON.parse(await readFile(resolve(values.selector), "utf8"));
    const parsed = stoppedLegacyLocalLeaseSelectorSchema.safeParse(selector);
    if (!parsed.success) {
      console.error(JSON.stringify({ outcome: "refused", code: "invalid_selector" }));
      process.exitCode = 1;
      return;
    }
    const target = resolveDatabaseTarget();
    connectionString = target.mode === "postgres" ? target.connectionString
      : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
    const db = createDb(connectionString);
    const result = await reconcileStoppedLegacyLocalLease(db, parsed.data, { apply: values.apply });
    console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry_run", ...result }));
  } catch (error) {
    // Database/config exceptions can contain a credential or connection URL.
    // Only the maintenance service's fixed refusal codes enter output.
    console.error(JSON.stringify({ outcome: "refused",
      code: error instanceof LocalLeaseReconciliationError ? error.code : "maintenance_failed" }));
    process.exitCode = 1;
  } finally {
    if (connectionString) {
      try {
        await closeRegisteredClients(connectionString);
      } catch {
        console.error(JSON.stringify({ outcome: "refused", code: "database_cleanup_failed" }));
        process.exitCode = 1;
      }
    }
  }
}

await main();
