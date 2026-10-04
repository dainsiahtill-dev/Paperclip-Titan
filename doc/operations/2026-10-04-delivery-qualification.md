# Paperclip 全量落地资格记录 — 2026-10-04

本记录跟随 `doc/plans/2026-10-04-paperclip-delivery-reliability-plan.md`。
当前仍在实施和资格验证中，尚未声明全计划完成或部署。实际源提交、已加载运行、
专项检查、真实模型调用和应用交付分别记录，不用健康检查或 worker 的完成声明替代验收。

## 当前集成

- 集成工作树：`.claude/worktrees/delivery-full-20261004`，分支 `fix/delivery-full-20261004`。
- 保留并合并最新中文/Phaser UI 与 Local lease maintenance 的外部源码及主分支历史。
- `4c845a9eb`：物理 single-flight 恢复协调器、独立阶段及安全前置条件。
- `a0e7c17ea`、`454e2d19a`、`3d1233c96`：探测取消/drain、有效 profile 身份、
  匹配前驱恢复、锁内公平性，以及重型 Git 操作接入现有调度器。
- `ab2a8badf`、`ee824eaf8`：计划投影、实质进度、订阅 token 计量与可选资源限制；
  兄弟任务的资源准入在原容量锁中串行。
- `36aef0422`、`b1b1fa5eb`：持久交接、真实运行投影、评论版本和原始内容摘要匹配。
- `44e4ff250`：看门狗有限恢复 lineage、实际复核、原子 1–3 操作及持久 outbox。
- `97d4c565f`：生成并集成 0284/0285 迁移及公开契约；复合 UNIQUE 在引用 FK 前创建。
- `80a0efc8e`：多预算/人工暂停保留、真实子进程时限验证、运行和进度分开展示，
  原子合并 presentation 元数据，管理模板及中英文文案。
- `76d2122f8`：真实适配器执行入口按物理尝试重建首轮/续轮上下文。
- `cf249e444`、`abea1e88c`：真实 HTTP 暴露的资源策略丢弃问题修复；
  监控结束只移除监控，保留资源、评审及权限策略。
- `44ee373ff`：普通评论和现有未准入 wake 一起提交，修复保存后崩溃窗口；
  准入复用原收据，目标运行、暂停、预算、Stop、删除、重分配和 FIFO 继续受原控制。

各领域细节在同日的 runtime、steering、watchdog、context-resource 实施文档中。
独立验收权威与显式 `verified_delivery`、真实 ACP Shell 身份注入、native token
边界停止仍在工作分支收口；最终完整检查要针对合并后的源码再执行。

## 已有新证据

Root 合并后六个相关文件 **105/105** 通过，包括实际子进程、预算、任务计划执行入口、
原有 Local lease 维护和看门狗恢复。资源策略实际 HTTP/服务/归一化 **99** 项通过；
监控结束的策略保留与监控调度 **82** 项通过。消息保存/唤醒分支专项 **346/346**
通过，Root UI 收据与邻接组件 **61** 项通过。上述集合有重叠，不相加为整体覆盖量。
相关 server/UI typecheck 与 token gates 已绿；完整 monorepo gate 尚待最终源冻结。

长计划量测使用实际适配器入口和受控 Codex/Claude 子进程 stdin：原计划 105,662
字节，首次输入 112,860/112,625 字节，后续十轮输入约 3,095–3,145 字节；
保留当前任务、核心约束、最新交接及精确修订引用。费用节省不从字节数推算。

## 隔离模型与完整页面

隔离实例端口 **3311 / PG 55431**，独立 HOME/config/DB；未克隆生产 DB 或任务，
通过现有 managed-home 登录流程复用已配置账号。
新的公司、CEO/CTO/Engineer/QA、目标和项目已建立。目标 Git 只有初始化空提交；
MCP 启动生成的 `.serena` 元数据保留，维护线程没有编写应用代码。工程应用尚未派发。

环境检查最初只证明 executable/auth-file/scaffold。首轮隔离配置漏了现有
`CODEX_PATH`，实际使用捆绑 0.153.4，模型明确返回 unsupported-model 400。
三次失败和一次排队取消保留。修正后仍使用原 `gpt-6.1-sol / ACP / xhigh / approve-all`，
实际 CLI **0.160.0** 能响应，Shell 工具和 `Paperclip_projects.list_projects` 调用成功。
但 Shell 缺少任务身份变量，任务 HTTP 读写未通过。两分钟配置时限真实停止执行，
保存资源原因、原负责人及 stopped/unchanged 观察，并在物理 drain 后释放容量。
该源任务保持明确的维护阻塞和原有限次数；修好环境路径前不继续模型尝试。

环境修复并入后，受控同任务重试 `d7f8a862-0af3-43a1-b41c-b9a6a279308c`
在 2026-10-04 02:17:38–02:19:29 UTC 成功，保留原 120 秒时限和全部失败记录。
实际使用该 Agent 的独立 managed home。六个作用域变量均到位，认证 GET 返回200并
匹配当前公司/任务/运行；Agent 写入检查结果并通过任务 API 将同一预检标为 done。
容量在物理结束后释放。计量为 1,887 uncached +36,224 cached +67 output =38,178，
订阅且未定价；不把环境检查完成冒充工程应用交付。

独立 Root F HTTP/PG 审查还复现并修复预算操作重新激活归档公司/终止 Agent、
以及手动运行误计自动次数的问题。原四个失败观察与控制组复跑13/13通过。
技能指令的五个初始盲测和五个新控制试验见同日 skill-workflow-pressure 记录。
独立 Runtime 审查仍要求修复旧配额失败的原 profile 证明，以及 ACP 持续目标的
逐轮计量/未知用量保留；这些是进入最终资格前的必修项。

实际 ACP 数字为 input 4,013、cached 39,936、output 640；这种输入口径不能直接套用
CLI 的 cache-inclusive input + output。新的归一化必须基于该 transport 的已验证语义；
未知计量和未定价继续如实显示。

Root 使用独占临时 Windows Edge profile 检查真实 API-backed 页面：桌面 1280×800、
移动 390×844，页面错误为零、无水平溢出，亲自查看截图。资源输入 0 被阻止；恢复 4 后
经实际 PATCH 保存，保留 120 秒、blocked 状态和原约束。浏览器全部按 profile/PID
归属关闭；每次 teardown `remaining=[]`。最终包含验收权威和真实 provider 的完整流仍待收口。

## 旧数据恢复和迁移

读取现有受保护备份 `paperclip-20261004-065251.sql.gz`，用官方恢复 helper 写入独立
PG **55432**，没有启动 API 或业务 Agent。在 `abea1e88c` 源码上升级 0283–0285 后，
原 **210 表 / 58,248 行**及每个原有列的值完全一致；前后摘要相同：

`80c5e59a0ce8aeb1a89325f94b5ec7cf8b5bebb8a74e53ae96850df61cd86aa5`

恢复目录为 0700，私有证据为 0600，PG 已停。私有 SQL、密钥、数据和日志不作为公开附件。
最终验收迁移、配置/storage/key 备份，以及旧源码读兼容和回滚仍需单独验证。

## 剩余验收

1. 收口并独立审查验收 ledger、ACP 身份环境、native/ACP 计量和停止边界；修复所有必修问题。
2. 冻结最终源，跑全量 typecheck/test/build、token gates、迁移 drift 和最终旧数据升级。
3. 由真实 CEO/CTO/Engineer/QA 交付 TypeScript CRUD API、错误输入、重启持久化、
   测试、README、Git 产物及一次有证据的故障恢复；维护线程不代写应用。
4. 按当前默认实例的实际 controller/config/active runs 做受控部署，保存新加载版本和
   每个原运行的处理结果；完成回滚兼容演练及可通过 Paperclip 查看的报告产物。

## 最终验收 schema 的旧库升级核验

`0286_curved_johnny_storm` 由 Drizzle 生成，SQL 中先创建 work-product 的
company/id UNIQUE 再建立对应复合外键；snapshot/journal 未手工修改。
第二次生成报告无 schema 变更。新库验收 API、页面评审和进展观察共36项通过。
页面显示当前判定的真实评审者和时间；已删除的产物不参与当前进展观察。

以最新 `paperclip-20261004-105251.sql.gz` 在受保护临时目录
`/tmp/paperclip-restore-final-20261004` 恢复并升级0283–0286。210张原表、
59,086行的全部原字段值保持一致；升级前后逐表行摘要总 SHA256 均为
`c28807199e7ec53c6767ff75a29d8995903bba758bd0986611320830b1f2ba22`。
实际结果记录在该目录 `result.json`，PG已停，没有启动Agent或写生产库。
这是最终schema的数据保留证据，仍不代表旧binary写兼容、实际项目完成或默认部署。
