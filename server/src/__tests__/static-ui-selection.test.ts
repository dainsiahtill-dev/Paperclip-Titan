import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStaticUiDist } from "../static-ui-selection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-ui-")); roots.push(root);
  for (const dir of ["server/src", "server/dist", "server/ui-dist", "ui/dist"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const dir of ["server/ui-dist", "ui/dist"]) fs.writeFileSync(path.join(root, dir, "index.html"), "compiled");
  return root;
}
describe("static UI selection", () => {
  it("selects the checkout build for a source server despite an old packaged copy", () => {
    const root = setup();
    expect(resolveStaticUiDist(path.join(root, "server/src"))).toBe(path.join(root, "ui/dist"));
  });
  it("retains the packaged-server location for published code", () => {
    const root = setup();
    expect(resolveStaticUiDist(path.join(root, "server/dist"))).toBe(path.join(root, "server/ui-dist"));
  });
  it("honors explicit selection and fails instead of silently using a different build", () => {
    const root = setup();
    expect(resolveStaticUiDist(path.join(root, "server/src"), path.join(root, "server/ui-dist"))).toBe(path.join(root, "server/ui-dist"));
    expect(() => resolveStaticUiDist(path.join(root, "server/src"), path.join(root, "missing"))).toThrow(/UI build.*missing/i);
  });
});
