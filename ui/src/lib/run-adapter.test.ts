import { expect, it } from "vitest";
import { runAdapterType } from "./run-adapter";

it("reads a claimed backup for labels and transcript parsing after primary recovery", () => {
  expect(runAdapterType({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }, "claude_local")).toBe("codex_local");
});

it("keeps legacy display for runs without valid dispatch evidence", () => {
  expect(runAdapterType({ runnerProfileJson: null }, "claude_local")).toBe("claude_local");
  expect(runAdapterType({ runnerProfileJson: { adapterDispatch: { adapterType: 5 } } }, "codex_local")).toBe("codex_local");
});
