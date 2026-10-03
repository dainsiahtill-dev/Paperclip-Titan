import { createHash } from "node:crypto";

export interface TaskPlanProjection {
  mode: "full" | "sections";
  body: string;
  sourceChars: number;
  projectedChars: number;
  omittedChars: number;
  contentDigest: string;
  sourceRef: string;
}

const mandatoryHeading = /goal|objective|scope|constraint|acceptance|permission|authority|budget|stop|safety|boundary|目标|范围|约束|验收|权限|授权|预算|停止|安全|边界/i;
const mandatoryLine = /\b(?:must|never|prohibited|forbidden|do not|only|shall|required)\b|必须|禁止|不得|仅限|不可|只能/iu;
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A projection is a reading aid, never evidence that a provider read a revision. */
export function projectTaskPlan(input: {
  issueId: string;
  title: string;
  revisionId: string;
  body: string;
  compact: boolean;
}): TaskPlanProjection {
  const sourceRef = `/api/issues/${encodeURIComponent(input.issueId)}/documents/plan/revisions/${encodeURIComponent(input.revisionId)}`;
  const contentDigest = createHash("sha256").update(input.body).digest("hex");
  let body = input.body;
  let mode: TaskPlanProjection["mode"] = "full";
  if (input.compact && input.body.length > 4000) {
    const lines = input.body.split("\n");
    const headings: Array<{ line: number; level: number; title: string }> = [];
    let fence: string | null = null;
    lines.forEach((line, index) => {
      const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) { if (!fence) fence = delimiter[0]; else if (delimiter[0] === fence) fence = null; return; }
      if (fence) return;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) headings.push({ line: index, level: heading[1].length, title: heading[2] });
    });
    const keep = new Set<number>();
    const taskTitle = normalize(input.title);
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const title = normalize(heading.title);
      if (!mandatoryHeading.test(heading.title) && !(taskTitle && title.includes(taskTitle))) continue;
      let end = lines.length;
      for (const next of headings.slice(index + 1)) if (next.level <= heading.level) { end = next.line; break; }
      for (let line = heading.line; line < end; line += 1) keep.add(line);
    }
    // Preserve standalone mandatory statements, including constraints near the
    // end of an unstructured plan. No tail truncation can remove these lines.
    lines.forEach((line, index) => { if (mandatoryLine.test(line)) keep.add(index); });
    body = lines.filter((_line, index) => keep.has(index)).join("\n");
    mode = "sections";
  }
  return { mode, body, sourceChars: input.body.length, projectedChars: body.length,
    omittedChars: Math.max(0, input.body.length - body.length), contentDigest, sourceRef };
}
