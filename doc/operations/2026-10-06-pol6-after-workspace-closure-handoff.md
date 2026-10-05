# Paperclip 收口后 POL-6 续接

本交接仅供 Paperclip 的真实宿主治理验收通过后，由 Polaris 团队接续。当前 POL-6 为 blocked，尚未重试。代码唯一落点 `/home/dains/Documents/polaris`；不得分支、worktree、代码副本、安装或隐式服务重启。

原任务：`POL-6` / `9eef4fba-e563-4168-b5e7-99c29255683c`，负责人 `3af6b2dd-e922-447f-a01e-d130e903b122`。只读恢复快照与原始描述注册于本地项目资料库，现场数据保留原路径。

先沿用已有工程 checkpoint，读取 `docs/superpowers/plans/2026-10-06-paperclip-repair-frontier.md`、blueprint、当前 backend 规则、director.runtime cell 与相关 public 契约。既有 `contracts.py`、`diagnostics.py`、`test_diagnostic_identity_frontier.py` 的已验证修复保持不动。

允许源码范围：`repair_kernel/registry/_rules_typescript.py`；`runtime/public/service/_execution.py` 仅在独立动态复现证明必要时修改。唯一新增测试为 `runtime/tests/test_materialization_unique_export_routing.py`。工程 checkpoint/REPORT 留在 `.superpowers/sdd/2026-10-06-paperclip-repair-frontier/repair/`。

已知未完成根因：已注册的 executable binding `unique_export_import` 要求 raw 字面词 `unique export`，真实 `unresolved_relative_import` 诊断没有该词；public materialization 的非空但无可用 patch 候选会阻止探索其他候选。优先修准确 coverage 路由并复用原 planner。使用真实 public coverage、explicit Plan(shadow)、materialization plan-probe 和泛化 authored `base_files` 动态 RED，再做最小修补与 GREEN。

只有动态证据仍证明需要时，才改 fallback。不能把无 matched/unrelated 诊断的 patch 标成 `covered_plannable`；模糊或缺失 export 应拒绝，不发明 stub/alias，也不扩大 owner 授权。

按原计划执行新增测试、91 项诊断基线、Ruff/format/mypy 和广域契约，历史六项失败单列。每完成动态 RED、修复、验证阶段即写 checkpoint，记录命令、退出码和剩余步骤。解释器保持 `/home/dains/.pyenv/versions/3.12.3/bin/python`，所有 shell 使用 RTK，文本显式 UTF-8。

不得修改其他源码、已有测试、Factory/QA/PM/CE 或目标项目，不跑 Bench，不新增语言专用 public facade/source_tool，不删断言或派新员工。提交工程结果进入 `in_review`，由独立验收方判断。Paperclip 的物理退出证明只恢复派工准入，不认证 Polaris 的 planner 语义质量，也不授权重做已完成诊断修复。
