export async function reconcileQuotaContinuations<T extends { id: string }>(dependencies: {
  page: (cursor: string | null, limit: number) => Promise<T[]>;
  matches: (source: T) => Promise<boolean>;
  eligible: (source: T) => Promise<boolean>;
  continue: (source: T) => Promise<"scheduled" | "alreadyCovered" | "gateHeld" | "deferred">;
}) {
  const result = { examined: 0, scheduled: 0, alreadyCovered: 0, gateHeld: 0, deferred: 0, nextCursor: null as string | null };
  let cursor: string | null = null;
  for (;;) {
    const page = await dependencies.page(cursor, 50);
    if (!page.length) return result;
    for (const source of page) {
      result.examined++;
      if (!await dependencies.matches(source)) continue;
      if (!await dependencies.eligible(source)) { result.gateHeld++; continue; }
      result[await dependencies.continue(source)]++;
    }
    const next = page.at(-1)!.id;
    if (next === cursor) throw new Error("quota_recovery_cursor_stalled");
    cursor = next;
  }
}
