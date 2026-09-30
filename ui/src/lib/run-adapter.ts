import type { HeartbeatRun } from "@paperclipai/shared";

/** A historical run keeps its admitted adapter after Agent settings change. */
export function runAdapterType(run: Pick<HeartbeatRun, "runnerProfileJson">, primary: string): string {
  const dispatch = run.runnerProfileJson?.adapterDispatch;
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return primary;
  const type = (dispatch as Record<string, unknown>).adapterType;
  return typeof type === "string" && type.trim() ? type : primary;
}
