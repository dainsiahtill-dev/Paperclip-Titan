import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { quotaNativeConfigIdentity } from "./quota-probe-native-config.js";
it("hashes configured CLI account/config freshness without retaining credentials", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-quota-native-"));
  try {
    await fs.writeFile(path.join(home, "auth.json"), "synthetic account one");
    const first = await quotaNativeConfigIdentity("codex_local", { CODEX_HOME: home });
    await fs.writeFile(path.join(home, "auth.json"), "synthetic account two");
    expect(await quotaNativeConfigIdentity("codex_local", { CODEX_HOME: home })).not.toEqual(first);
    expect(JSON.stringify(first)).not.toContain("synthetic account one");
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
