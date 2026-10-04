import { describe, expect, it } from "vitest";
import { materialProgressSnapshot, compareMaterialProgress } from "./issue-material-progress.js";

const facts = { documents: [{ key: "design", body: "Decide on JSON storage." }], products: [], blockers: [], decisions: [] };
describe("material progress", () => {
  it("recognizes a newly validated criterion while ignoring duplicate decision narration", () => {
    const decision = { stageId: "delivery:api", outcome: "accepted", criterionDigest: "criterion-1", contentDigest: "artifact-1", materialVersion: "1" };
    const before = materialProgressSnapshot({ ...facts, decisions: [decision] });
    expect(compareMaterialProgress(before, materialProgressSnapshot({ ...facts, decisions: [{ ...decision, reason: "same result", id: "duplicate" }] })).state).toBe("unchanged");
    expect(compareMaterialProgress(before, materialProgressSnapshot({ ...facts, decisions: [{ ...decision, criterionDigest: "criterion-2" }] }))).toMatchObject({ state: "advanced", kind: "decision" });
  });
  it("ignores timestamps, revision ids, narration and duplicate source rows", () => {
    const before = materialProgressSnapshot(facts);
    const after = materialProgressSnapshot({ ...facts, documents: [{ ...facts.documents[0], revisionId: "new", updatedAt: "later" }, facts.documents[0]] });
    expect(compareMaterialProgress(before, after).state).toBe("unchanged");
  });
  it("recognizes changed document goals without requiring source code", () => {
    const before = materialProgressSnapshot(facts);
    const after = materialProgressSnapshot({ ...facts, documents: [{ key: "design", body: "Decide on atomic file replacement." }] });
    expect(compareMaterialProgress(before, after)).toMatchObject({ state: "advanced", kind: "document" });
  });
  it("does not let a mutable approved display status create progress", () => {
    const products = [{ type: "artifact", provider: "paperclip", externalId: "file", metadata: { sha256: "one" }, status: "open" }];
    const before = materialProgressSnapshot({ ...facts, products });
    const after = materialProgressSnapshot({ ...facts, products: [{ ...products[0], status: "approved", reviewState: "approved" }] });
    expect(compareMaterialProgress(before, after).state).toBe("unchanged");
  });
  it("distinguishes artifact versions, dependency unlocks and missing observations", () => {
    const before = materialProgressSnapshot(facts);
    expect(compareMaterialProgress(null, before).state).toBe("unknown");
    const changed = materialProgressSnapshot({ ...facts, products: [{ type: "commit", provider: "git", externalId: "sha-1", metadata: {} }] });
    expect(compareMaterialProgress(before, changed)).toMatchObject({ state: "advanced", kind: "artifact" });
    const blocked = materialProgressSnapshot({ ...facts, blockers: [{ id: "blocker", status: "blocked" }] });
    const ready = materialProgressSnapshot({ ...facts, blockers: [{ id: "blocker", status: "done" }] });
    expect(compareMaterialProgress(blocked, ready)).toMatchObject({ state: "advanced", kind: "dependency" });
  });
});
