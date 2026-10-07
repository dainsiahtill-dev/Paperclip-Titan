import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createDb, legacyWorkspaceEpochClosures, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { workspaceWriteOwnershipService, physicalWorkspaceIdentity } from "../services/workspace-write-ownership.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
let root: string;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("pc-epoch-fence-");
  db = createDb(temporary.connectionString);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-epoch-fence-"));
}, 20_000);
afterEach(async () => {
  await db.delete(workspaceWriteOwners);
  await db.delete(legacyWorkspaceEpochClosures);
});
afterAll(async () => { await temporary?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function fence(state = "prepared") {
  const source = await physicalWorkspaceIdentity(root);
  await db.insert(legacyWorkspaceEpochClosures).values({ realm: source.realm, state, digest: "a".repeat(64), manifest: {} });
}

it.each([false, true])("a prepared instance closure fences new physical claims across companies (unprotected=%s)", async observeUnprotected => {
  await fence();
  const result = await workspaceWriteOwnershipService(db).claim({ cwd: root, companyId: randomUUID(), runId: randomUUID(), observeUnprotected });
  expect(result).toEqual({ outcome: "busy" });
  expect(await db.select().from(workspaceWriteOwners)).toEqual([]);
});

it("the same fence prevents local service observations from starting a new writer lane", async () => {
  await fence();
  const observed = await workspaceWriteOwnershipService(db).observeService({ cwd: root, workspaceCwd: root,
    companyId: randomUUID(), serviceId: randomUUID(), serviceKey: "epoch-fixture" });
  expect(observed).toBe(false);
  expect(await db.select().from(workspaceWriteOwners)).toEqual([]);
});

it("an open malformed closure state cannot silently lift the dispatch fence", async () => {
  await fence("unknown");
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: root, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("a governance record from another physical realm does not fence this host", async () => {
  await db.insert(legacyWorkspaceEpochClosures).values({ realm: "f".repeat(64), digest: "a".repeat(64), manifest: {} });
  expect((await workspaceWriteOwnershipService(db).claim({ cwd: root, companyId: randomUUID(), runId: randomUUID() })).outcome).toBe("claimed");
});
