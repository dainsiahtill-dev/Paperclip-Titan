import { useState } from "react";
import type { DeliveryPolicy, EngineeringEvidencePolicy } from "@paperclipai/shared/types/delivery";
import { deliveryPolicySchema } from "@paperclipai/shared/validators/delivery";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const roles = ["implementation", "test", "harness", "manifest"] as const;
const labels = { implementation: "实现文件", test: "测试文件", harness: "验证工具与配置文件", manifest: "依赖清单文件" };
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
export function ProjectEngineeringPreset({ projectId, policy, onSave }: {
  projectId: string;
  policy: DeliveryPolicy | null;
  onSave: (policy: DeliveryPolicy) => Promise<unknown>;
}) {
  const configured = policy?.engineeringEvidence;
  const [workspace, setWorkspace] = useState(configured?.sourceScope.executionWorkspaceId ?? "");
  const [files, setFiles] = useState(Object.fromEntries(roles.map(role => [role, configured?.sourceScope.files.filter(file => file.role === role).map(file => file.path).join("\n") ?? ""])) as Record<typeof roles[number], string>);
  const [tests, setTests] = useState(configured?.requiredJobs.filter(job => job.role === "test").map(job => job.id).join("\n") ?? "");
  const [verifiers, setVerifiers] = useState(configured?.requiredJobs.filter(job => job.role === "verifier").map(job => job.id).join("\n") ?? "");
  const [builds, setBuilds] = useState(configured?.requiredJobs.filter(job => job.role === "build").map(job => job.id).join("\n") ?? "");
  const [reviewers, setReviewers] = useState(policy?.reviewerAgentIds?.join("\n") ?? "");
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  async function save() {
    setError(null); setSaved(false);
    const engineeringEvidence: EngineeringEvidencePolicy = { version: 1,
      sourceScope: { projectId, executionWorkspaceId: workspace.trim(), files: roles.flatMap(role => lines(files[role]).map(path => ({ path, role }))) },
      requiredJobs: [...lines(tests).map(id => ({ id, role: "test" as const })), ...lines(verifiers).map(id => ({ id, role: "verifier" as const })), ...lines(builds).map(id => ({ id, role: "build" as const }))],
    };
    const result = deliveryPolicySchema.safeParse({ ...policy, version: 1, mode: "verified_delivery", engineeringEvidence, reviewerAgentIds: lines(reviewers), managerAgentIds: policy?.managerAgentIds ?? [],
      criteria: policy?.mode === "verified_delivery" && policy.criteria?.length ? policy.criteria : [{ id: "engineering", requirement: "实现符合任务要求；测试与验证工具有有效断言；独立评审检查实际行为和未解决限制。", scope: "issue", artifactType: "document" }],
    });
    if (!result.success) { setError(`检查工作区、文件范围与作业配置：${result.error.issues.map(issue => issue.message).join("；")}`); return; }
    setPending(true);
    try { await onSave(result.data); setSaved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请检查权限与配置后重试。"); } finally { setPending(false); }
  }
  return <section aria-label="工程交付预设" className="flex flex-col gap-3">
    <h3 className="text-sm font-medium">工程交付预设</h3>
    <p className="text-sm text-muted-foreground">Board 配置源文件与已批准作业。任务提交一个主 JSON 文档，引用实际作业记录；退出成功仍需独立评审确认需求、断言和实际行为。</p>
    <p className="text-xs text-muted-foreground">支持：写入者退出后的本地 Linux 工作区，只读执行与临时输出。活动写入者、远程工作区、原生工具日志、缺失或过期记录不能证明工程交付。所选文件范围不是整个仓库证明。</p>
    <label className="flex flex-col gap-1 text-sm">执行工作区 ID<Input aria-label="执行工作区 ID" value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
    {roles.map(role => <label key={role} className="flex flex-col gap-1 text-sm">{labels[role]}<Textarea aria-label={labels[role]} rows={3} value={files[role]} onChange={event => setFiles(current => ({ ...current, [role]: event.target.value }))} /></label>)}
    <p className="text-xs text-muted-foreground">每行一个工作区相对文件路径，覆盖实现、测试、工具配置和依赖清单；不支持目录、通配符或秘密文件。</p>
    <label className="flex flex-col gap-1 text-sm">测试作业 ID<Textarea aria-label="测试作业 ID" rows={2} value={tests} onChange={event => setTests(event.target.value)} /></label>
    <label className="flex flex-col gap-1 text-sm">验证作业 ID<Textarea aria-label="验证作业 ID" rows={2} value={verifiers} onChange={event => setVerifiers(event.target.value)} /></label>
    <label className="flex flex-col gap-1 text-sm">构建作业 ID（可选）<Textarea aria-label="构建作业 ID" rows={2} value={builds} onChange={event => setBuilds(event.target.value)} /></label>
    <label className="flex flex-col gap-1 text-sm">独立评审代理 ID（每行一个；Board 也可评审）<Textarea aria-label="独立评审代理 ID" rows={2} value={reviewers} onChange={event => setReviewers(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">作业必须先在工作区配置中由 Board 批准。测试可使用 /tmp 输出；需要写入源目录的构建须先改为独立输出路径。</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {saved ? <p role="status" className="text-sm text-muted-foreground">工程预设已保存。请运行已批准作业，再提交主文档接受独立评审。</p> : null}
    <div><Button disabled={pending} onClick={() => void save()}>{pending ? "正在保存…" : "保存工程交付预设"}</Button></div>
  </section>;
}
