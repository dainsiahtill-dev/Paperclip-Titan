// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBasicPreflight } from "./AgentBasicPreflight";
const basic = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { basicPreflight: basic } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root?.unmount()); container.innerHTML = ""; vi.clearAllMocks(); });
it("shows detailed unverified results and never turns configured metadata into connected tools", async () => {
  basic.mockResolvedValue({ status: "unverified", testedAt: "2026-10-05T00:00:00Z", profileDigest: "abc", profile: { source: "saved_agent", cwd: "/workspace", target: "local", model: "test", effort: "high", sandbox: "read-only", projectId: null }, checks: [{ code: "mcp:1", status: "unverified", message: "MCP initialize failed; advertised tools are not proof." }], modelInvoked: false });
  root = createRoot(container);
  await act(async () => root.render(<AgentBasicPreflight agentId="agent" companyId="company" requirements={{}} onRequirementsChange={() => {}} disabled={false} />));
  await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Run basic check")!).click());
  expect(container.textContent).toContain("MCP initialize failed"); expect(container.textContent).toContain("unverified"); expect(container.textContent).toContain("No model request");
});
it("requires saved settings before running and reports request errors accessibly", async () => {
  root = createRoot(container);
  await act(async () => root.render(<AgentBasicPreflight agentId="agent" companyId="company" requirements={{}} onRequirementsChange={() => {}} disabled />));
  expect((Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Run basic check")!).disabled).toBe(true);
  basic.mockRejectedValue(new Error("Employee access denied"));
  await act(async () => root.render(<AgentBasicPreflight agentId="agent" companyId="company" requirements={{}} onRequirementsChange={() => {}} disabled={false} />));
  await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Run basic check")!).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Employee access denied");
});
it("does not display a completed old check after the employee has changed", async () => {
  let resolve!: (value: unknown) => void;
  basic.mockReturnValue(new Promise(done => { resolve = done; }));
  root = createRoot(container);
  await act(async () => root.render(<AgentBasicPreflight agentId="old" companyId="company" requirements={{}} onRequirementsChange={() => {}} disabled={false} />));
  await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Run basic check")!).click());
  await act(async () => root.render(<AgentBasicPreflight agentId="new" companyId="company" requirements={{}} onRequirementsChange={() => {}} disabled={false} />));
  await act(async () => resolve({ status: "pass", testedAt: "old-check", profileDigest: "old", profile: { source: "saved_agent", cwd: "/old", target: "local" }, checks: [] }));
  expect(container.textContent).not.toContain("old-check");
});
