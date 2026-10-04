# Paperclip 项目交付可靠性完善计划

**2026-10-04 实施状态：** A–J 代码、专项检查、本次隔离工程与默认部署已收口。
当前结论、真实验收、预算例外和回滚范围以 [最终报告](../operations/2026-10-04-delivery-final-report.md) 为准。
本文下方提案、复现步骤与原始未勾选清单保留为设计/执行基线；已实现 API 参照同日 implementation 文档及当前 API，不能继续按创建时“尚未实现”理解。

> For agentic workers: 实施使用 superpowers:executing-plans；用户已明确允许安排专家，可按本文互斥写入边界使用 superpowers:subagent-driven-development。逐任务执行复现、最小修复、验证与提交；不要把整份计划复制进每个 heartbeat。

**Goal：** 让 Paperclip 能持续推进有明确目标的工程项目，正确交接、恢复阻塞、控制资源，并以实际产物与业务验收收口。

**Architecture：** 在现有 issue / goal / review / wake-queue / heartbeat / native runtime / work products 上补齐缺失的恢复验证、投递事实和交付策略。运行活性、实质进度、产物验收分别记录；由同一现有调度器推进，保持身份、停止证据、预算和人工暂停约束。

**Tech Stack：** Node >=24.11.0、当前安装 Node 24.21.0、pnpm 9.15.4、TypeScript、Express、Drizzle/PostgreSQL、React、Vitest、Playwright、ACP/PRP及各 provider driver。

**Spec：** doc/GOAL.md、doc/PRODUCT.md、doc/SPEC-implementation.md、doc/execution-semantics.md；三份本轮独立审计见下面索引。本文的新增接口均是实施提案，不是已存在的可调用 API。

## 0. 阅读方式与交接索引

1. 先读本文第1–5节，了解目标、边界、真实基线与实施顺序。
2. 接手运行问题：读 [运行可靠性审计](../audits/2026-10-04-runtime-reliability-audit.md)。
3. 接手消息/UI问题：读 [交接与状态审计](../audits/2026-10-04-handoff-and-state-audit.md)。
4. 接手管理/交付问题：读 [交付治理审计](../audits/2026-10-04-delivery-governance-audit.md)。
5. 现场操作和可复制接手指令：读 [维护交接手册](../operations/2026-10-04-paperclip-agent-handoff.md)。
6. 本轮已实施的小修：[单次交接完成事件](2026-10-04-steering-completion-event.md)。

三个领域审计提供更细的调用链、代码行号、场景与实现草图。本计划负责统一优先级、任务依赖、跨层契约、责任边界和整体交付验证。不要把三份审计的所有任务再复制成三套重复任务。

## 1. 用户目标与正确的产品定位

### 1.1 本次范围

仅完善 Paperclip 平台及其运行/管理模板，包括调度、消息交接、状态展示、恢复、任务治理、上下文、预算、配置兼容和交付验证。业务项目的模型训练、课程、客户数据、功能开发不属于本计划实施范围。

用户需要的是一个能够真实推进项目的执行团队。CEO 管理负责人，负责人管理执行与验收；问题有负责修复的人，工作有看得见的结果。用户不应为了维持运行不断发送 continue、手动逐条标注、重复授权，或理解内部协议后才能解阻。

### 1.2 当前判断

Paperclip 已有真实代码执行、工作区、远程/本地 adapter、产物和调度能力。它适合有监督地执行明确、可验证的工程任务；当前没有证据证明复杂项目可以完全无人监管地稳定交付。

近期短板分三类：

- **运行可靠性：** 恢复、probe、队列与现场执行上下文需要一致；不能在异常后失去下一动作。
- **交接真实性：** 页面收到消息、队列持久化、provider 接收、任务真正使用该消息是不同事实。
- **交付收敛：** 评论、日志和检查次数不能代替实质进展；成功 run、完成 task、完成阶段、客户接受需要分别表达。

提示词可以改善职责分工，源码负责执行与状态约束；这两部分要同时落实。不能仅改一句“CEO要主动”，也不能把所有业务质量判断硬编码到调度器。

### 1.3 实施后需要达到的结果

1. 有工作就存在可追踪的 live / waiting / recovery / escalation 路径。
2. 真实依赖变化推动相应 owner；未阻塞分支继续执行。
3. 运行中交接按真实能力及时送达，不能送达时说明等待原因与下一合法边界。
4. 额度不足使用用户配置的备用；恢复检测与原任务的账号、模型、engine、环境匹配。
5. 重启、取消、探测超时不会重复 provider 执行或外部效果，不凭逻辑终态释放未停止进程的容量。
6. 项目阶段有真实产物、有效验收和下一负责人；一般任务不被强制增加多层审核。
7. 限制重复上下文与无进展循环，费用未知时如实显示，不把订阅零账单当零资源消耗。
8. 用一个隔离、由 Paperclip Agents 实际完成的小型工程项目证明完整链路。

## 2. Global Constraints

- 仓库为 /home/dains/Documents/paperclip；维护 fork 为 https://github.com/dainsiahtill-dev/Paperclip-Titan.git，默认分支 main。
- 每条 shell 命令以 rtk 或 rtk proxy 开始；文本 UTF-8；源码与文档使用 apply_patch。
- 遵循仓库 AGENTS.md。新计划放 doc/plans/，不重写既有战略文档，不手改 Drizzle migration snapshot。
- 保留 single-assignee、atomic checkout、公司隔离、当前 responsible user、session generation、run/controller身份、正式审批与预算硬停。
- 普通工作不重复请求已给出的授权；显式人工暂停、人工 blocker、预算硬停和受治理动作的审批不能被自动恢复绕过。
- 不用消息正文推断新的凭据或权限，不把 Agent/system 交接伪装成用户命令。
- 不新增第二个任务调度器，不用盲目重启、放宽阈值、加大 timeout 或自动重放工具掩盖问题。
- 测试必须使用独立 PAPERCLIP_HOME / config / DB / port；默认实例和3100上的业务运行不作破坏性测试。
- 不以命令数、日志数、README数量、run succeeded 或 API 200 单独判定项目成功。
- 新模型/CLI/连接配置必须显式、兼容且真实验证；不自动切未配置 provider、改价格、追加支付或取消预算上限。
- 不把未知和历史证据写成已验证当前结果。文档中的源码行号可能随提交漂移，函数和模块归属为主要定位方式。

## 3. 真实基线、已有成果与证据等级

### 3.1 本轮现场基线

| 项目 | 本轮读取结果 | 接手需要复核 |
| --- | --- | --- |
| 初始磁盘 HEAD | ce97b8e8fee0b952186e85f4433c29491d63ae2c | git log/status |
| 本轮小修集成 | main 5adf49a3c；专家原提交86b627edd | 是否为当前HEAD祖先、未部署状态 |
| 已加载服务版本 | 2026.916.1+50.git.e7761ba11 | /api/health 的 serverVersion/version |
| 服务 boot | 2026-10-03T10:49:27.128Z | processStartedAt；不要用当前HEAD替代 |
| API | http://127.0.0.1:3100/api | /health 为200；/health/ready本轮404 |
| 运行模式 | local_trusted / private | 未来部署不能假设仍相同 |
| DB | embedded-postgres，端口54329 | config白名单读取，不能启动第二个同目录PG |
| 状态目录 | /home/dains/.paperclip/instances/default | DB、上传、日志、密钥分开备份 |
| 备份 | health显示enabled、status ok | 还需隔离恢复演练，不能仅看文件存在 |

ce97 相对 e776 只增加 .serena 的项目配置/忽略文件，因此审计基线里的运行源码与已加载e776一致。之后新增的小修与文档在磁盘，不能据此声明运行实例已使用新修。

运行专家在2026-10-03 17:59 UTC只读看到1个active公司、12个Agents（11 idle/1 running）、无queued run。最近1000个run里含525 succeeded、75 failed、394 cancelled、5 interrupted、1 running。这是历史样本，不是故障率：人工取消、受控测试与部署取消不能自动归为平台BUG。不要在交接文档里推导“取消多就不可靠”。

### 3.2 已有机制，保留而不是重做

| 能力 | 当前归属/已有修复 | 后续工作 |
| --- | --- | --- |
| 目标与任务树 | goals / issues.goalId、parentId、project-goal关联 | 加交付项目的明确产物约束，非重新建任务系统 |
| 依赖与等待 | issue blockers、monitors、scheduled wake、liveness recovery | 补失败恢复验证和owner收口 |
| 工作产物与评审 | issue_work_products、reviews、native completion/status arbitration | 验收权威和项目级策略，保留低风险默认完成 |
| 主备用与探测 | 9d8ec5843、e7761ba11；agent-quota-fallback / quota-model-probe | 补实际engine/env scope、多任务恢复、物理截止 |
| 并发上限 | instance ceiling、显式shared concurrency groups、per-Agent limit | 公平性与真实释放，不能再造6槽调度器 |
| 运行中交接 | f5903c385、1306b0ad7、cee703a60 | ACP迟到ACK、持久intent、能力差异与状态 |
| 重试合并 | dd351a5e7、3ef9609c4 | 兼容队列顺序、崩溃窗口，不丢新消息 |
| 取消容量恢复 | f5ec78ed0、8b32a6b7d、legacy/native recovery | 持续保留stop证据与有限重试 |
| Git扫描保护 | 2并发、32队列、8s timeout、10s cache、single-flight | 找真实重扫描/副本问题，不盲增timeout |
| 上下文限制 | 评论8条/单条4k/合计12k，continuation限制 | 完整plan仍反复注入，优先补这一缺口 |
| 费用 | cost_events及已有money budget | token/context能力为新增补充，不是假定预算没做 |

### 3.3 本轮验证与未验证

- 运行审计：8文件149项专项测试通过，隔离CLI/ACP probe差异诊断成立。
- 交接审计：修前7文件129项；单次完成事件修复后5文件88项通过，专家server类型检查通过。
- 交付审计：相关45项测试通过；三个纯函数反例成立。
- Root已审阅单次完成事件补丁；主目录的复验结果在交接手册记录。
- 各测试范围有重叠，不把149+129+88+45相加当一次完整suite成绩。
- 历史server suite曾有37 failed /15050 passed；本轮没有重跑，不能说当前全绿或把所有失败无条件称baseline。
- 本轮没有真实provider故障注入、生产重启、完整浏览器资格测试或真实样例项目完成证据。

## 4. 缺口清单与实施优先级

这里的P0表示阻断“可靠项目交付”资格，未必是当前生产紧急事故。当前没有证据需要立刻停生产服务。

| 编号 | 问题 | 强度 | 优先级 | 当前动作 |
| --- | --- | --- | --- | --- |
| PC-01 | 同次legacy手动Steer两条完成事件 | 真实route+service+PG已红绿复现 | P2，小修 | 本轮已修并集成；未部署 |
| PC-02 | watchdog关闭即reviewed，未区分恢复成功/合法停止、同指纹恢复失败不继续 | 源码与纯函数反例；SPEC要求不同 | P0 | 补有限恢复验证、attempt lineage及atomic batch |
| PC-03 | 用户可写approved产物状态被当成验收权威 | 源码确证，API攻击场景待隔离复现 | P0 | 只对明确验收流程保护server-derived acceptance |
| PC-04 | 恢复then链失败阻断独立后续阶段，interval无明确single-flight | 源码确证，故障注入待补 | P1 | 维护步骤隔离并保留安全前置 |
| PC-05 | probe强制CLI，不能证明实际ACP执行路径就绪 | 隔离实际调用已复现；业务回切错误待验证 | P1 | 区分quota/transport readiness、有效配置匹配 |
| PC-06 | 同user多项目凭据/环境共用scope、只保留最新失败pointer | 源码风险，需要隔离矩阵 | P1 | 恢复正确scope及每个 eligible predecessor |
| PC-07 | ACP timeout后late ACK无完整补偿；发送在长锁事务内；进程Map去重 | 源码能力缺口；崩溃/late ACK场景待验证 | P1 | 短事务+durable delivery intent+精确补偿 |
| PC-08 | PID数值存活/无投影fallback可以显示Working | 源码确证，PID复用/断线UI待验证 | P1 | 用现有ownership/phase evidence显示真实状态 |
| PC-09 | comment/activity/tool count重置无进展、判advanced | 纯函数反例已成立 | P1 | 分离liveness与deliverable progress |
| PC-10 | resume/compact仍重复注入整份plan | 当前callpath源码确证 | P1 | revision引用、当前任务片段、保留核心约束 |
| PC-11 | token/issue/run资源预算缺失，$预算不能限制订阅资源消耗 | 新能力需求，非money budget故障 | P2 | 复用usage/cost记录做可配置上限 |
| PC-12 | 队列公平性、Git慢扫描、模型/权限配置与错误呈现的操作风险 | 当前机制已有；具体场景待验证 | P2 | 实测后最小改动，避免重造 |
| PC-13 | 复杂项目端到端交付资格缺证 | 尚未执行 | 发布门槛 | 隔离样例、真实Agents、恢复与产物验收 |

## 5. 执行组织、依赖与里程碑

### 5.1 最小人员分工

| 角色 | 负责 | 写入边界 |
| --- | --- | --- |
| 项目统筹/Root | 目标、优先级、范围、最终现场验收和合并 | 主计划、交接、最终合并 |
| 运行专家 | PC-04/05/06、容量/恢复边界 | runtime/heartbeat/probe；与其他专家约定共享文件hunk |
| 交接专家 | PC-01/07/08 | steering、相关route、execution projection、对应UI |
| 交付专家 | PC-02/03/09/10/11 | watchdog、completion/evidence、context/budget |
| 验收专家 | 每个里程碑一次独立验收 | 隔离测试、效果读取；不代写目标代码 |

不用为每个几行改动安排CEO、主管、QA、仲裁四次审核。一个模块由一个writer负责，阶段交一份具体产物并审查一次。需要并行时最多按这三条域划分；heartbeat.ts与routes/issues.ts必须预约函数/代码段或顺序集成。

### 5.2 顺序

~~~mermaid
flowchart TD
  A[基线与已修验证] --> B[恢复验证与维护隔离]
  A --> C[交接持久事实与真实状态]
  A --> D[进度和上下文收敛]
  B --> E[有效probe及多任务恢复]
  C --> F[可信验收与阶段收口]
  D --> F
  E --> G[隔离样例完整交付]
  F --> G
  G --> H[受控部署及回滚演练]
~~~

计划不是要求每条线全部结束后其他线才能工作：诊断、测试和独立叶可以并行；共享源码、迁移编号、生产重启必须串行。阶段完成可收口一个子任务，不把阶段评审误提交成整个项目完成。

### 5.3 里程碑

- M0：本轮审计、交接、小修复验、已修/未修台账完整，服务继续运行。
- M1：watchdog有限恢复、维护single-flight、交接持久ACK/自然边界、真实状态通过隔离异常矩阵。
- M2：进度反空转、plan按需投影、可信阶段验收、正确scope主备用恢复具备。
- M3：预算/模板/配置兼容和实测发现的公平性、Git路径问题收口。
- M4：一个隔离工程样例由真实Agents完整交付，恢复场景通过；再做部署与回滚演练。

不要按“已经写了多少文档”判断里程碑；每项要关联下文对应测试与现场结果。

## 6. Review Focus

1. **用户仍在等，但任务链没有owner：** 审核、阻塞、监控结束与恢复动作关闭后，下一真实路径仍存在。
2. **provider已收消息，DB/ACK出错：** 不重复发送同一外部效果，未知结果可追踪，迟到确认不复活已删除/过期输入。
3. **Agent不断发评论：** 仍可记录活性，不能不断重置交付无进展计数或伪造产物验收。
4. **相同用户不同项目/凭据：** B账号probe成功不能把A账号任务回切；pause/budget/显式阻塞仍有效。
5. **详细计划/长日志/大仓库：** 当前核心约束不能被截掉，重复上下文与重复Git扫描有界；等待有原因而不是伪Working。

上述五类分别由PC-02/04、PC-07、PC-03/09、PC-05/06、PC-08/10/12的测试固定。下一节给具体实施任务。

## 7. 具体实施任务

### Task A：watchdog真正验证恢复，补原子恢复batch（PC-02）

**当前源码：** server/src/services/task-watchdogs.ts；packages/db/src/schema/issue_watchdogs.ts；server/src/routes/issues.ts中的watchdog授权/更新路径；packages/shared/src/validators中相应契约。详细行号见治理审计DG-01/02。

**输入：** 原watchdog配置、watched subtree、当前stop fingerprint、合法watchdog run、既有恢复动作与权限。

**产出：** 持久恢复lineage、明确disposition和有限verification；最多3个DB变更的原子batch。

建议新增的内部契约，字段名在实施时统一放shared/DB版本迁移，不能只加JSON并让各层自行猜：

~~~ts
type RestorationDisposition = "legitimate_stop" | "restoration_claimed" | "escalated";
interface RestorationLineage {
  version: 1;
  sourceFingerprint: string;
  attemptCount: number;
  maxAttempts: 2 | 3;
  disposition: RestorationDisposition;
  verificationDueAt: string | null;
  actionIds: readonly string[];
}
type RecoveryMutation =
  | { kind: "set_status"; issueId: string; status: "todo" | "in_progress" | "in_review" | "blocked" }
  | { kind: "comment"; issueId: string; body: string }
  | { kind: "set_blockers"; issueId: string; blockerIssueIds: readonly string[] };
interface RecoveryBatch {
  requestId: string;
  watchdogRunId: string;
  expectedStopFingerprint: string;
  mutations: readonly RecoveryMutation[];
}
~~~

这是第一版最小支持集合；assignment/reopen等现有权限保留，扩batch操作必须使用已有授权，不靠payload自报身份。

- [ ] 在现有watchdog测试里固定：处置声称restored但源subtree仍停，不能仅因watchdog issue done永久already_reviewed。
- [ ] 固定中间节点变更、叶子未变、明确人工pause、人工blocker、审批待定、外部bounded monitor各分支。合法等待可抑制，假恢复应继续有限验证。
- [ ] 持久化attempt/claimed fingerprint/动作与verification时间，服务重建后接同lineage；恢复失败最多2–3次，之后给具名owner/board一个明确升级，不再无界唤醒。
- [ ] 使用原route权限做batch入口；1–3个操作一次事务，先核子树scope与fingerprint，所有变更/审计/outbox全部提交或全部回滚。第三方已推进时拒绝整batch，记录stale；同batch自己的第1个变更不能使第2个被误判陈旧。
- [ ] 拒绝4操作、越界公司/子树、取消active run、改预算/秘密/配置、绕审批等请求。一个watchdog run的batch single-shot，网络重试靠requestId幂等返回。
- [ ] 真实隔离API核一个恢复动作加一个解释comment能原子成功；在并发子树变活时整个batch不执行；重启后attempt不清零。
- [ ] 更新schema/export/Drizzle生成迁移/shared validator/server/UI说明；与doc/SPEC-implementation.md §9.9同步。

**验收：** 真恢复观察到live/wait路径；假恢复有限再试后升级；合法暂停不被自动解除；重复扫描不多出run或重复效果。不能用“watchdog已done”作为唯一成功证据。

### Task B：维护周期有界、步骤隔离与安全前置（PC-04）

**当前源码：** server/src/index.ts恢复周期；heartbeat.ts的reap/promote/resume/stranded方法；现有trackHeartbeatSchedulerWork和hot-restart。建议新叶server/src/services/recovery-scheduler.ts及同目录测试，详细接口见运行审计Task2。

- [ ] 红测试：reap reject后，允许的独立dependency/watchdog/观察维护仍运行；依赖stop/lease证据的promote/resume必须跳过。
- [ ] 红测试：慢phase跨过下一tick，只有一个物理cycle；第二tick复用在途promise；shutdown等待它真正settle。
- [ ] 用纯typed coordinator保留cycle owner，逐phase记录completed/failed/skipped和耗时。不要在逻辑timeout后清owner并启动第二轮。
- [ ] canRunPhase同时核shutdown suppression和每阶段安全前置；不能直接Promise.allSettled并无条件派发任务。
- [ ] 加退避与少量固定错误代码，独立维护恢复后可继续；不要把敏感exception/env写日志。
- [ ] 验证startup native owner classification仍先于普通调度，重启snapshot覆盖claim callback在途窗口。

**验收：** 一个维护步骤出错不导致整个平台静默失去独立维护能力；也不因错误隔离产生第二个provider owner。无需引入Redis或新queue。

### Task C：交接持久intent、late ACK与短事务（PC-07）

**当前源码：** live-adapter-steering.ts、adapter-execution-control.ts、heartbeat.ts steering hook、routes/issues.ts queued-comments；adapter-utils/acpx-engine/live-steering.ts；acpx补丁；native-session-executor.ts及native已存在ACK reconcile。

**数据选择：** 复用agent_wakeup_requests作为排队权威；优先建立content-free投递旁表，参照现有issue_question_response_deliveries。不能复制整份comment，不能另造run调度。

建议最小投递记录：company/issue/comment及版本、内容digest、目标run/turn/session generation/controller、correlationId、mode、pending/dispatching/acknowledged/uncertain/superseded/cancelled、attempt与观察时间。原正文/作者仍在comment。

- [ ] 精确fixture：provider injected后ACK延迟8秒，queue暂uncertain；迟到确认只完成原内容、原turn的一次投递，不再发第二prompt。
- [ ] fixture杀点：intent保存前、dispatch后、ACK后DB提交前、DB提交后广播前，重建service逐一查状态；已保存输入可恢复，未知外部效果不自动重发。
- [ ] 领取短事务：核公司、作者/权限、assignee、run/turn/generation、comment版本、queue revision，保存dispatch intent。
- [ ] 外部send在事务外，保留同一执行owner与abort/stop fencing；不能让锁持续等待provider ACK。
- [ ] 确认短事务：重新核精确目标，保存真实ACK、移除准确pending ID，提交后发布一次完成事件。
- [ ] late ACK以correlationId+digest+原run/turn绑定；edited/deleted/Stop/reassigned/superseded不能被旧ACK复活。
- [ ] 若provider协议尚不支持持久幂等ID，不能宣称exactly-once：保留uncertain，不盲重发；自然合法后继携带原要求与不确定性。
- [ ] native已有迟到ACK路径继续复用；ordinary Agent/system消息不冒用authenticated用户身份，不借插入切凭据。
- [ ] 将普通comment提交到wake通知的杀点窗口复现后，才决定是否补同调度器窄outbox；不要仅因conversation有outbox就给全部对象复制一份。
- [ ] 保留用户reorder，核retry helper采用顺序是否一致；删除消息不能再进下一prompt。

**验收：** 用户消息和自动交接保留原文/作者，真正支持的路径有准确ACK；不支持时显示原因并在自然边界采用；重启、迟到确认与幂等重试不会重复外部效应。

### Task D：真实运行与消息状态（PC-08）

**当前源码：** execution-projection.ts、heartbeat-run-runtime-status.ts、LiveUpdatesProvider.tsx、IssueDetail.tsx、TaskChatRunnerTurn.tsx、TaskChatQueuedMessages.tsx、ui/src/lib/run-execution-status.ts及相关shared types。

| 页面状态 | 必须来自的事实 | 不可推断 |
| --- | --- | --- |
| 等待排队 | durable queued + capacity/dependency等reason | provider正在执行 |
| 正在准备 | lease与provision/install/connection阶段 | 模型已经开始回复 |
| 执行中 | 原run当前执行阶段及owned owner证据 | 每秒都有交付进展 |
| 等待交接边界 | 原run活跃，工具在途/steering unsupported等 | 已经插入 |
| 等待外部结果 | durable monitor/合法wait+下次时间+owner | 卡死或没有任务 |
| 正在恢复 | correlated retry/reconnect/recovery归属 | 已恢复完成 |
| 状态待确认 | 投影失效、owner证据不足、断线重连 | 自动显示Working或自动杀进程 |
| 收尾中 | result/finalization/drain仍在途 | capacity已经释放 |
| 运行已结束 | run terminal | issue/阶段/项目已验收 |

- [ ] 修无projection的running fallback：保留DB running事实，同时说明待确认；不强制Working。
- [ ] PID存活使用已有controller/namespace/PID-start/lease证据，不以kill(pid,0)单独证明owned worker。
- [ ] 区分accepted/saved、queued、dispatched、injected/next-turn采用、可观察后续效果；applied不是必须人工批准的前置。
- [ ] 明确busy/unsupported/uncertain/stale/paused/budget等待原因与合法下一动作；保留编辑、撤销、授权interrupt的用户控制。
- [ ] 断线/TTL过期/重连查询收敛到durable事实，重复activity按delivery identity去重。
- [ ] 桌面与移动浏览器验证queue、tool busy、late ACK、自然边界、manual stop和run结束；无错误时灰色占位结束，有错误时给明确可重试失败。

**验收：** 页面不再把queued/preparing/unknown伪装成实际工作；也不因安静的长任务错误终止它。health可读与provider工作分别展示。

### Task E：有效执行上下文中的probe与多任务恢复（PC-05/06）

**当前源码：** quota-model-probe.ts、agent-quota-fallback.ts、agent-quota-fallback-policy.ts、heartbeat.ts probe/onRecovered、AI connection/secret/config freshness owners。

- [ ] 固定已复现差异：显式ACP配置只被CLI测试，CLI成功不能单独宣布ACP路径可用；不要改显式engine或偷偷失败后换engine。
- [ ] 分开provider额度/账号可用性与实际execution-path readiness。两者的probe必须保留自己的engine/model/source配置与结果含义，busy/error保持inconclusive。
- [ ] 复用实际run环境合成：Agent/project/routine revision、负责用户AI连接、secret版本、CLI/provider配置和模型；fingerprint只用非敏感身份/版本/哈希。
- [ ] 同user不同项目、不同凭据、secret轮换、probe进行中配置变化，正结果只能恢复匹配scope；原run descriptor不原地换模型。
- [ ] 对全部匹配且eligible的failed predecessor恢复，保留暂停/审批/预算/人工blocker。每个predecessor最多一个合法successor，token/通知不是恢复完成。
- [ ] probe reservation保留到真正完成/停止，120秒逻辑过期不能放出第二个物理请求；检查当前真实abort/grace/drain边界。
- [ ] 备用是用户配置的fallback；恢复主模型周期继续执行；primary unavailable不统一叫quota exhausted，避免错误引导登录或购买额度。
- [ ] 测mock quota和账号隔离后，再用已配置连接做最少真实hello/path调用；不重新索取已有凭据，不生成真实业务效果。

**验收：** 主限额时有备用或具名等待，正确主scope恢复后自动回切；不恢复别的账号任务，不绕budget；额度与runtime故障的报告清楚。

### Task F：实质进度、无价值循环与管理职责（PC-09）

**当前源码：** run-liveness.ts、issue-rewake-throttle.ts、task-watchdogs.ts、successful-run-handoff.ts；builtin CEO/CTO/QA和默认onboarding；paperclip operational skills。

建议区分两个事实，原有活动仍可作活性：

~~~ts
interface WorkObservation {
  liveness: "active" | "waiting" | "unknown" | "stopped";
  progress: "advanced" | "unchanged" | "awaiting_verification";
  progressKind: "artifact" | "test_result" | "dependency" | "decision" | "external_job" | "none";
  sourceVersion: string;
  nextOwnerId: string | null;
}
~~~

- [ ] 红测试：重复“已读/继续等”、无状态改变comment、一条tool log不能无限重置no-progress计数；真实新需求/interaction回答仍能推动工作。
- [ ] 实际产物变化、测试结果由失败到成功、有效依赖解阻、真实决策、受管理外部job阶段推进可以算进展；不要求全部都有Git diff。
- [ ] 计划/文档/调查本身是任务产物时允许，不能把零代码任务自动判断无价值；必须满足任务声明的目标和产物。
- [ ] 无改变的定时重复检查复用已保存状态，不再唤醒整个管理链；有bounded monitor的正常等待保留owner/next check。
- [ ] 仅在显式交付策略下，对同一因果指纹的自动continuation配置有限无增量次数；例如两次是可配置soft cap而非全局默认。复用既有source recovery并通知已有负责人，不自动新建主管审核/审批任务，也不恢复已退役的automatic productivity review。正常外部等待、等待用户信息不计入；真实需求/状态变化才可建立新指纹，Agent自报新需求不能洗掉原上限。
- [ ] 管理模板写成行动规则：CEO推进目标和负责人、主管解阻与集成、执行员交产物、QA看实际业务效果。无需逐轮报告哈希、分母或来源复核。
- [ ] parent/child结构与blockers区别保持；未阻塞分支并行，根阻塞只交一个负责修复者。
- [ ] 完成一种阶段成果只关闭该阶段任务；最终交付根任务按明确验收合同收口。不要全局禁止父任务在子任务未done时完成，准备/启动类父任务本来可先完成。

**验收：** 活着但无进展的循环可观察并有界，真实长任务不会误伤；CEO/主管能给出具名下一动作而非转发同一段等待说明。

### Task G：产物验收权威与显式交付项目策略（PC-03）

**当前源码：** native-runtime/evidence-classifier.ts、completion-contracts.ts、status-arbiter.ts；routes/issues.ts work-product mutation；shared validators/work-product.ts；既有review/approval/work_assessments/status_decisions。

- [ ] 隔离API复现：执行者改自身work product approved/reviewState后，不能凭可写字段制造server authoritative acceptance；保留合法board/指定reviewer验收。
- [ ] 追加server-derived acceptance provenance：actor、run、criterionId、completion contract revision/hash、产物版本/contentDigest、对应review/assessment ID、决策时间和scope。客户端自报状态仍可展示，但不升级权限；只有当前准则/合同及当前产物匹配的决定有效。
- [ ] 项目可显式选择verified_delivery模式；复用已有reviewPolicy、typed participant和status arbitration，不能仅用needs_review标签强迫人工approval。
- [ ] 普通低风险任务继续SPEC允许的agent_claim_policy；有明确workflow条件、项目交付合同或新review request时按相应策略处理。
- [ ] 每阶段一次验收，绑定产物与准则/合同版本；无实质要求变化的普通评论不重审。用户变更验收条件时，即使产物版本未变，也使受影响的旧判定失效；只重验受影响条件，保留其他有效结果。
- [ ] 用户允许AI完成的标注/评审默认由对应Agent承担；董事会只处理真正权限/预算/治理或关键发布选择。
- [ ] reject给具体实现问题和owner，不产生“核验核验结果”的新任务链；接受不代表所有业务目标自动achieved。

**验收：** 有明确验收要求的项目不能自写approved绕过；一般任务仍容易完成；scope/权限/旧数据兼容不回退。

### Task H：计划按需读取、上下文与token预算（PC-10/11）

**当前源码：** heartbeat.ts任务plan注入/compact路径、task-plan-context.ts、adapter-utils的compact选择、codex-local execute提示注入；promptMetrics；cost_events、budgets及budget shared types。

- [ ] 先测当前完整plan首次/resume/compact各自字节与token估计。上下文已有评论限制，问题是plan仍完整注入，不重复建评论截断器。
- [ ] 原plan全文保留可读；每次默认只给当前任务执行摘要、目标链、不可丢核心约束、当前必要变化、plan revision与稳定读取引用。
- [ ] full/section按需读取，发生版本变化只送增量；不能把hash相同当成Agent已读，也不能让用户只能看到摘要。
- [ ] 格式不变的长计划不再每turn重发。确保最重要权限/范围/停止条件不是被字符截断丢掉的尾部。
- [ ] 用已有promptMetrics记录长度与来源；统计不含secret/prompt原文。cached和非cached usage定义按adapter归一，不能统一乱相加/相减。
- [ ] 复用cost_events的run/issue/model/billingType/costStatus等字段。订阅或unpriced如实显示，不捏造token价格或把cost=0当资源免费。
- [ ] 可配置issue/run token、最长自动循环/无增量回合限额；新限制是新增能力，与现有billed_cents硬停并存。
- [ ] 资源耗尽保存进度/下一动作，按正常model续接，不自动换低能力模型或取消合法外部job；缓存统计不能成为新的业务验收门槛。

**验收：** 例如一个有长plan的任务连续10个小turn，全文只按需要加载，重复plan注入显著下降；具体bytes/token对照交实测，不预先伪造节省百分比。

### Task I：并发公平性、workspace与模型配置（PC-12）

- [ ] 在现有capacity lock里核多Agent/公司共享pool公平性；resumeQueuedRuns不能长期只让首Agent占满pool。先复现再加one-admission-per-round/aging，守住ready和budget/ownership条件。
- [ ] MiniMax订阅上限6可用现有General shared group配置；第7个保留queued，取消后等真实stop。外部CLI/服务不受这个Paperclip任务上限控制。
- [ ] 记录为什么实际只跑1个：依赖、同workspace串行、agent gate、预算、provider quota、active physical owner、waiting external分别说明；最大6不是保证同时6。
- [ ] 大repo实测区分tracked/untracked/ignored/归档目录、clone/seeding、Git scan排队/执行耗时。复用已有single-flight/cache/隐藏panel不查询，不能仅改timeout。
- [ ] 审计每个真正调用链是否走Git scheduler；未走的接现有owner。避免复制历史runtime工件进新worktree；不直接删除用户文件。
- [ ] CLI/custom model/CC-Switch尊重现有可配置catalog与custom ID，真实execution参数需与保存值一致；接口版本不是模型可用性证明。
- [ ] 账号选择使用当前AI connection契约，不复制失效auth或强迫用户重复登录；“本机同账号”不等于共享一个可写CODEX_HOME。
- [ ] 本用户偏好中的Codex danger-full-access、Claude skip-permissions、Luna至少xhigh属于显式配置测试项，不扩大成全产品强制默认，也不绕公司/运行控制权限。
- [ ] model不支持某effort时明确拒绝/说明，不能暗中降级；备用/provider group跟实际配置一致，外部CC-Switch变更不能伪装已自动检测。
- [ ] 核本机CLI与实际Agent的MCP/工具准备是否一致：隔离home、有效config、runtime tool/connection绑定、sandbox网络与权限、真正advertised工具列表分别记录。安装了MCP不等于当前run可调用，不复制整份宿主配置或凭工具名称伪造工具结果；缺能力给具体修复路径。

**验收：** 正确限制与可解释等待；模型/账号/权限参数真实一致；workspace慢有来源和可复现证据，而不是全局误杀。

### Task J：隔离样例完整交付资格（PC-13）

详细现场流程见下一节及交接手册。先mock异常，后使用用户已有连接做最少真实工程执行；维护Agent不能代替被测执行Agent写目标应用。

## 8. 跨层契约与迁移检查表

| 改进 | DB/迁移 | shared/API | server/runtime | UI |
| --- | --- | --- | --- | --- |
| 单次Steer完成 | 无 | 外部API不变，内部trusted actor可选 | ACK事务一次审计、commit后publish | 使用原activity，未改组件 |
| watchdog恢复 | additive lineage/disposition/next verification，必要索引 | batch validator、typed disposition、version/idempotency | scope/fingerprint事务及复核 | 显示恢复中/合法停/已升级，不强行人工每项批准 |
| durable交接 | content-free投递记录及unique identity，不复制正文 | 投递state/mode/reason/correlation | 三段式事务、late ACK、stop fencing | 真能力/等待/uncertain/reconnect |
| 精确probe | 可先versioned既有metadata；跨boot批处理状态必要时加旁表 | 有效scope/readiness类型 | 相同overlay、原owner、真实release | 不能把一个scope恢复显示为全账号恢复 |
| 实质进度 | 复用run/issue/work产物；必要进度revision | liveness/progress分别typed | 不再评论即advanced | 分开展示正在运行与有产物进展 |
| 验收权威 | server-derived acceptance引用、版本与actor | 客户端字段不授予权威 | 显式policy仲裁、旧模式兼容 | 发布/接受/阶段完成来源可见 |
| plan投影 | 原文/文档revision继续存 | projection/source ref/截断metadata | 按需读取、必要constraints不丢 | 全文可读、使用何版本可见 |
| token预算 | 优先cost_events；policy新metric按迁移规范 | 计数语义/上限/耗尽状态 | 正常hard stop、checkpoint/continuation | 订阅与unpriced诚实显示 |

任何schema更改都需要：导出、Drizzle生成迁移、fresh DB升级、旧DB升级、snapshot drift检查、公司FK/索引、API与UI同步。不能手工把新字段直接UPDATE到生产以代替迁移。

迁移规则：

- 历史run、comment、review与失败证据保留；不给旧“approved”产物伪造新独立验收actor。
- 新模式默认兼容；交付项目策略为显式opt-in。滚动升级时旧receiver不理解新state不能假装acknowledged。
- 多控制器只允许一个具体effect owner。旧服务不具备新合同期间，禁用对应新功能并保留记录可读。
- 新字段允许unknown/legacy provenance，不补“推测成功”；清理需可解释、有记录，不用全表reset。
- 若加入开关，命名与默认写入配置文档；关闭开关停止新控制行为，已有durable intent仍可查询/恢复，不删除数据。

## 9. 平台整体验收矩阵

每个场景至少记录company/issue/run/actor、目标engine/profile、前后状态、真正provider调用/工具effect数、相关source版本、恢复owner和最终产物。匿名数据，不写凭据。

| 场景 | 测试方法 | 通过条件 |
| --- | --- | --- |
| 6上限、7个任务 | 隔离fake worker逐个计物理owner | 6个执行、第7个单一queued；真实stop前不释放 |
| 多公司pool公平 | 可控clock、重复释放slot | 另一eligible Agent有限轮次内获slot；人工hold不因aging绕过 |
| primary限额/backup/回切 | mock provider与有效scope | 换配置后不误恢复旧scope；文件/会话保留；原失败不被抹掉 |
| 多failed任务 | 三predecessor+重复callback+restart | 所有eligible各一个successor，预算/暂停/审批保持 |
| comment工具在途 | 真实stdio fixture+可控tool延迟 | 消息保留；safe boundary后确认；不取消原工具 |
| late ACK | ACK超8秒、编辑/停止/重启交错 | 精确旧ID确认或superseded，不重复外部效果 |
| native/ACP能力差异 | 各driver能力fixture | supported才in_turn；unsupported走next_turn，不伪装支持 |
| queue重排/删除/重试 | 真route+临时PG | canonical顺序/原作者/版本保留，删除不再采用 |
| duplicate完成事件 | 当前新增route/service回归 | 一次ACK/一次完成activity/一次live publish；replay不加事件 |
| 页面truth | 隔离浏览器桌面/移动、断线重连 | queued/preparing/waiting/confirming不显示虚假Working |
| 无进展循环 | 同comment重复与真实变化对照 | 活性可见，progress不虚增；循环有界且下一owner明确 |
| watchdog假恢复 | done但源仍停、跨restart | 不永久already_reviewed，2–3次后明确升级 |
| watchdog原子batch | status+comment、并发subtree变化 | 全成功或全不执行，不把自身第1写误判外部stale |
| 自报approved | 隔离API不同actor/产物revision | 不能制造server acceptance；合法 reviewer/board可验 |
| 长plan连续turn | 同任务10turn，带scope/权限尾部 | 无整份重复注入；关键约束保留；全文始终能读取 |
| 无价格usage | subscription/unpriced fixture | token真实计，$未知不伪造；限额不跳过现有预算 |
| 热重启CLI/native/ACP | 真fake provider进程+隔离controller | adopted/finalized/controlled successor准确、无lost忽略、无第二owner |
| 进程身份冲突 | PID复用/别namespace/旧receipt | 不错误adopt/kill/释放；保留明确恢复动作 |
| 提交后通知丢失 | commit后丢live event再刷新 | durable状态收敛，不丢任务/输入 |
| 人工暂停/取消/审批 | 发comment与positive probe同时发生 | 人工意图与治理仍有效，不自动continue绕过 |

测试只证明自己覆盖的场景。Mock可以验证控制逻辑；真实provider调用验证能力；真实样例交付验证团队执行，两者不能互相替代。

## 10. 隔离工程样例：完整项目交付证明

### 10.1 样例定义

建立新临时Paperclip实例与一个新的临时Git仓库，目标是一个本地TypeScript任务管理API：

1. 创建、列举、更新、删除任务；字段title/status。
2. 非法空title与非法status返回明确400；有效任务完成可更新。
3. 数据在服务重启后保留；使用小型本地存储，不接外部业务数据。
4. npm/pnpm一条命令启动，README提供实际请求例子。
5. 有有意义的成功/异常/持久化测试。
6. 交真实Git提交、测试结果和可运行endpoint；维护Agent不替执行Agent写应用。

这是Paperclip验收夹具，不是新增客户业务项目。第一轮不加登录、支付、云部署或复杂视觉设计。第二轮需要验证前后端并行时，可在该样例上追加最小列表/新增/完成页面，增加浏览器验收；不先做完整新产品。

### 10.2 实际执行路径

- Board/维护者只建立隔离company/project/目标与验收说明，选已有可用连接；核隔离端口、DB、repo和scope。
- CEO把目标分成少量工程任务，安排负责人，不将报告/统计各拆一个任务。
- 负责人给实现与测试owner，并配置真正blockers；能并行的分支并行。
- 实现Agent在独立执行workspace写应用、跑测试、交产物；QA独立读取接口/测试/实际运行结果。
- QA发现具体缺陷时交回原owner；修后只复验相关变化与必要邻接，不循环全仓审阅。
- 故障注入一次quota或执行中断，确认由持久恢复机制续接；另测维护步骤失败与队列消息采用。
- QA接受当前产物；负责人集成；CEO以目标条件全部满足收口项目根任务。

### 10.3 必须观察与记录

不靠“运行过多少命令”打分。至少保存：

- 创建的goal/project/issues与真实责任链、blockers及每一步合法状态变化。
- 真实provider/adapter/模型、配置snapshot与运行身份；未伪造Model/engine支持。
- 代码diff/commit与可启动app、测试实际输出、HTTP请求及持久化前后状态。
- 一次明确交接从保存到provider采用的证据；真实恢复predecessor/successor及效果次数。
- reviewer/产物版本/accepted来源，run结束与project完成之间的因果关系。
- 总wall时间、token/缓存/价格可用性、自动retry数、升级和人为干预次数；数字用于效率分析，不再变成额外分母审核任务。

通过时限定结论：“此隔离样例在这些约束和故障场景下完成”。不宣称所有复杂项目无人监管都可靠。

## 11. 部署、回滚与运行保障

### 11.1 合并前

1. 保存当前source SHA、在盘dirty状态、loaded serverVersion、boot/PID身份及active run快照。
2. 分离每项改动的红绿结果、已跑与未跑。文档+单个小修的验证不冒充全部计划完成。
3. 含UI变化时跑对应桌面/移动browser及token gates。含schema变化时做fresh/旧DB迁移和snapshot drift。
4. PR-ready广泛修改按AGENTS跑typecheck/test/build；历史失败逐名记录与归因，不能压低门槛、全加skip或伪称baseline。

### 11.2 部署

- 构建先完成，备份DB/上传/工作区/密钥/config分别受保护保存，先做隔离恢复演练。
- 只操作Paperclip所属controller。采用当前管理脚本和相关hot-restart协议，不能按进程名字kill全机器。
- native/CLI可adopt与ACP server-stdio需drain不同处理；实际preflight/snapshot/recovery report对照，lostRunIds非空不能忽略。
- source HEAD更新、server typecheck成功、API 200都不是新版本已加载；以new serverVersion/boot和实际行为验证。
- 自动或授权的重启后，源任务归属、queue、leases、预算与凭据scope复核；不自动恢复人工paused公司。

### 11.3 回滚

- 明确最后已接受source与DB兼容范围。增量迁移通常保留读兼容，不能把旧binary直接指向不支持的新schema。
- 关闭新feature只停止新逻辑；pending/uncertain/effect记录保留并可恢复，不删除以制造干净状态。
- 实际副作用先对账；回滚不自动重放历史工具、不取消无关业务job。
- 已知损失逐项具名处理；保留失败run/日志/产物，重新恢复不能抹成原本成功。

## 12. 测试和接手执行命令

全套命令、隔离root、启动/停止区别、调试API在维护交接手册。这里列最小使用原则：

- Node24.21.0：/home/dains/.paperclip/runtime/node-v24.21.0/bin/node。
- 当前pnpm入口：/mnt/c/Users/dains/AppData/Roaming/npm/pnpm；PATH必须把Linux Node24放首位。
- Root本轮小修主目录回归：issue-queued-comments-routes.test.ts与issue-queued-comment-queue.test.ts，2文件67项通过；server typecheck成功。
- typecheck脚本会prepare/build runner与plugin依赖，包含Rust已有warning；它不是完整monorepo build、browser或生产部署。
- 独立临时HOME/config和随机PG fixture；unset外部DATABASE_URL，避免测试误读主实例。
- 先最小可复现测试，再必要邻接。源码修改够广或交PR-ready时执行AGENTS全gate一次；不每个heartbeat重跑两小时suite。

## 13. 任务完成与下一次交接格式

接手Agent每次交付用下面结构，控制为一份说明，不制造多套报告：

~~~text
任务：PC-编号 / 实际目标
源码：base与提交、改动文件、当前是否合并
问题：最早失败owner与真实复现
修复：行为变化及保持的控制边界
验证：实际运行命令/结果、现场效果、未跑范围
状态：代码完成/隔离通过/已部署/业务验收分别说明
下一步：具名owner、必要输入、真正blocker或monitor
资源：token/时间/预算异常；无需写所有日志和哈希
~~~

完成条件：相应红测试能验证根因、必要邻接通过、声明的效果真实发生、接口同步、未验证项说明、具体产物可查看。只有最后M4才做整体项目资格判断。

## 14. 接手第一小时与后续实施建议

第一小时：读AGENTS和本计划基线；取fresh status/health/HEAD；保留已有业务；核本轮单次完成事件已在main、运行未部署；读负责领域审计并选一个最早阻断点；写一个失败复现，禁止先改模型/timeout/全部提示词。

第一工作阶段：PC-02恢复验证与PC-07投递事实先做隔离复现，PC-04维护隔离可独立并行；同时PC-10上下文量测只读。按三域互斥owner处理shared大文件。

第二工作阶段：PC-03可信验收、PC-09进度、PC-05/06正确scope恢复接入，更新最小管理模板；只做被测到的公平性/Git改进。

第三工作阶段：隔离资格样例与回滚演练通过，再受控升级生产。每阶段都可交付，不等所有模块结束才让用户看到实际成果。

接手若发现新的P0：用真实复现和源定位记录，并决定是否阻断当前发布；不得把每个措辞/格式/未知环境都升级成P0。任何新计划必须解释它改善的具体用户效果和为什么不能用现有机制完成。
