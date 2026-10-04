import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaperclipSkillsDir } from "./server-utils.js";

describe("required bundled runtime skill resolution", () => {
  it("skips an existing incomplete ancestor and chooses the candidate containing the requested skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-required-skill-"));
    const moduleDir = path.join(root, "fixture", "packages", "adapter", "src", "server");
    const first = path.resolve(moduleDir, "../../../../../skills"), bundled = path.join(root, "bundled");
    try {
      await fs.mkdir(first, { recursive: true });
      await fs.mkdir(path.join(bundled, "agentmail"), { recursive: true });
      await fs.writeFile(path.join(bundled, "agentmail", "SKILL.md"), "Bundled AgentMail instructions");
      expect(await resolvePaperclipSkillsDir(moduleDir, [bundled])).toBe(first);
      expect(await resolvePaperclipSkillsDir(moduleDir, [bundled], "agentmail")).toBe(bundled);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects required skill names containing traversal or path separators", async () => {
    for (const name of ["../agentmail", "a/b", "a\\b", "..", "/absolute"]) {
      await expect(resolvePaperclipSkillsDir("/tmp", [], name)).rejects.toThrow("skill name");
    }
  });
});
