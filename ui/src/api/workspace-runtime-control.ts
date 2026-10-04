import type { WorkspaceRuntimeControlTarget } from "@paperclipai/shared";

export function sanitizeWorkspaceRuntimeControlTarget(
  target: WorkspaceRuntimeControlTarget = {},
): WorkspaceRuntimeControlTarget {
  return {
    ...(target.issueId !== undefined ? { issueId: target.issueId } : {}),
    workspaceCommandId: target.workspaceCommandId ?? null,
    runtimeServiceId: target.runtimeServiceId ?? null,
    serviceIndex: target.serviceIndex ?? null,
  };
}
