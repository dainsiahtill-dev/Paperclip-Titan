// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeferredDialogs } from "./DeferredDialogs";
import { DialogProvider, useDialogActions, useDialogState } from "../context/DialogContext";
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("./NewIssueDialog", () => { loaded.add("issue"); return { NewIssueDialog: () => { const { newIssueOpen } = useDialogState(); return <input aria-label="Task draft" hidden={!newIssueOpen} defaultValue="original" />; } }; });
vi.mock("./NewAgentDialog", () => { loaded.add("agent"); return { NewAgentDialog: () => null }; });
vi.mock("./NewGoalDialog", () => { loaded.add("goal"); return { NewGoalDialog: () => null }; });
vi.mock("./NewProjectDialog", () => { loaded.add("project"); return { NewProjectDialog: () => null }; });
function Harness() { const actions=useDialogActions(); return <><button onClick={() => actions.openNewIssue()}>Open</button><button onClick={actions.closeNewIssue}>Close</button><DeferredDialogs /></>; }
it("imports only the requested dialog and retains its mounted draft after close", async () => {
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  flushSync(() => root.render(<DialogProvider><Harness /></DialogProvider>)); expect([...loaded]).toEqual([]);
  flushSync(() => (container.querySelectorAll("button")[0] as HTMLButtonElement).click());
  await vi.waitFor(() => expect(container.querySelector('input')).not.toBeNull());
  const input=container.querySelector('input')!; input.value="retained";
  flushSync(() => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
  expect(input.isConnected).toBe(true); expect(input.hidden).toBe(true);
  flushSync(() => (container.querySelectorAll("button")[0] as HTMLButtonElement).click());
  expect(container.querySelector('input')?.value).toBe("retained"); expect([...loaded]).toEqual(["issue"]);
 } finally { flushSync(() => root.unmount());container.remove(); }
});
