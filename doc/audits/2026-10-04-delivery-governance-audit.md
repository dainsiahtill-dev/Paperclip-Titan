# Paperclip 任务交付与管理治理审计及完善计划

> **给接手 Agent：** 本文是交付治理领域的审计和实施输入。执行时使用 `superpowers:executing-plans`；只有独立任务、独占写入范围和当前授权同时成立时才并行委派。本文不授权生产数据库变更、服务重启、业务任务派发、真实模型调用或 GPU 工作。

**目标：** Paperclip 能让主管持续推进一个有明确边界的工程项目，保留真实产物、阻塞责任和验收证据，最后通过一个隔离样例项目证明受监督交付。

**架构：** 复用现有 issues、goal/parent、blockers、work products、reviews、monitors、watchdogs、recovery 和预算机制。补齐恢复判定、证据权威、实质进度和上下文成本的衔接；工程目标与业务验收标准由项目负责人制定，平台只执行通用契约。

**技术栈：** TypeScript、Express、Drizzle/PostgreSQL、React、Vitest、Playwright；本次只读源码、纯函数复现和文档写入。

**依据：** 当前 `AGENTS.md`；`doc/GOAL.md`、`doc/PRODUCT.md`、`doc/SPEC-implementation.md`、`doc/DEVELOPING.md`、`doc/DATABASE.md`；`doc/execution-semantics.md`；下述源码证据。

## 1. 范围、证据等级与当前结论

- 仓库：`/home/dains/Documents/paperclip`。源码检查基线 `ce97b8e8f`；主线程告知运行服务为 `e7761ba11`，本文没有独立核验运行进程的源码身份。
- 只写本文；没有修改运行代码、其他审计文件、配置、数据库、服务、业务 Agent 或模型。
- `.codegraph/` 不存在，按仓库规则使用 RTK 导航；没有声称取得 CodeGraph 审查结果。
- 所有文件按 UTF-8 读取。测试只运行 CPU 纯函数及已有相关 Vitest；真实模型调用、远程模型调用和 GPU 调用均为 0。
- 没有读取或输出用户 prompt、凭据、环境变量值和业务对话。没有把先前业务问题解释成 Paperclip 已确认的平台根因。

本文使用四类结论：

| 等级 | 意义 | 本文示例 |
|---|---|---|
| 现有机制 | 当前源码已经具备；需要复用 | blockers、状态版本、原子 checkout、工作产物、review、monitor、task watchdog |
| 已修或明确现状 | 当前提交已有修复/策略；不能作为尚未实现的功能再做 | 依赖 wake 使用状态键；普通低风险 native 完成接受结构化 claim；自动 productivity review 已退役 |
| 确认缺陷/契约缺口 | 源码路径与所需语义不符；标明复现强度 | watchdog 恢复验证缺失；活动计数冒充进度；产物可写状态被当作权威证据 |
| 待验证 | 需要隔离运行、数据或浏览器证据才能下结论 | 实际 CEO 跑偏比例、费用浪费比例、特定大仓库慢的主因、父任务早关闭发生率 |

**当前结论：** 平台已经具备协调和恢复的主要零件，不能以“再加任务层级、监控、验收、预算”概括改造。关键缺口在已有状态、证据和监督之间：有活动不等于项目推进，恢复任务完成不等于恢复成功，产物状态不等于有权验收，run succeeded 不等于工程项目被验收。本次没有证明复杂项目已经稳定无人值守交付。

## 2. 现有能力地图：必须复用的部分

| 能力 | 当前所有者/证据 | 应如何使用 |
|---|---|---|
| 目标与结构 | `packages/db/src/schema/issues.ts`；`packages/shared/src/types/issue.ts`；SPEC §7.6 | 用 `goalId`、`projectId`、`parentId` 追溯任务，不新造项目目标关系 |
| 执行前提 | `server/src/services/issues.ts:2540` 一带的依赖 readiness；`:10705` 进入执行检查；`:11350` checkout readiness | 真正前提写 `blockedByIssueIds`；父子关系只表示归属，不能代替依赖 |
| 依赖变更唤醒 | `server/src/services/issue-dependency-wakeups.ts:137`、`:154`；`issues.ts:8989`、`:9085`；native `status-decision-committer.ts:1884` | blocker-ready 和 child-ready 状态键包含状态/版本/blocked cycle；路由、finalize、周期回补共享幂等规则 |
| 主动恢复 | `server/src/services/recovery/issue-graph-liveness.ts:477`；`issue-recovery-actions.ts`；SPEC §8.2 | 追到阻塞叶节点及 owner；恢复 action 与源任务 ownership 分开，不让任何“主管”自动接管 |
| 成功 run 补交接 | `recovery/successful-run-handoff.ts:21`、`:464`；`successful-run-handoff-state.ts:75` | 一次 corrective handoff；已有 blocker、review、monitor、pause、native finalization 的有效路径优先 |
| 工作产物 | `packages/db/src/schema/issue_work_products.ts`；`work-products.ts:254`、`:279`；`skills/paperclip/SKILL.md:159` | 文件、报告、PR、preview、runtime、commit、branch 均有可见访问路径；产物归到任务和 run |
| 文档/版本 | `task-plan-context.ts:12`；SPEC §7.15；`skills/paperclip/SKILL.md:613` | 用版本化 `plan` 和 `baseRevisionId`；同一计划修订，不衍生多份“最终协议” |
| Review/审批 | `issue-review-policy.ts:100`；`issue-execution-policy.ts`；`stalled-review-decisions.ts:33` | 复用 `anyone`、`not_creator`、`human_only` 与 typed participants；正式 governed approval 不降级为普通确认 |
| 外部等待 | `heartbeat.ts:11460` 一带的 monitor dispatch；`issue-execution-policy.ts`；`skills/paperclip/SKILL.md:219` | 持久 `nextCheckAt`、timeout/maxAttempts、owner；禁止用退出后的 shell watcher/PID 冒充等待路径 |
| 子树 watchdog | `task-watchdogs.ts:371`；`task-watchdog-scope.ts:51`、`:151` | 显式配置，限定一个子树；已有活跃 run/wake/retry 时不重复干预；不继承 board 权限 |
| 避免重复唤醒 | `issue-rewake-throttle.ts:28`、`:148`；`heartbeat.ts:27764` | 已有连续无进度 cooldown、人工新输入例外；完善“进度”的信息增量语义，不再增加重复定时器 |
| 金额预算 | `budgets.ts:213`、`:652`；`shared/constants.ts:875` | company/agent/project 的 monthly/lifetime billed cents 硬停；不因新监督机制绕过 |
| Token/费用数据 | `cost_events.ts:18`、`:23`、`:25`；`costs.ts:52` | 已有 run、issue、project 归因、cached input、billingType、unpriced；不新造重复费用账本 |
| Git 扫描保护 | `workspace-git-operation-scheduler.ts:170`、`:481`、`:525`、`:649` | 已有并发2、队列32、8秒超时、10秒缓存、single-flight、公平选择和输出限制 |
| 上下文减量 | `heartbeat.ts:737`；`issue-continuation-summary.ts:9`；`plan-review-context.ts:21`；`adapter-utils/server-utils.ts:2199` | 已有8条评论、单条4000字、总12000字，continuation 8000字，review 限额，resume compact 与 comment cursor |

### 2.1 已修部分与不能倒退的产品选择

1. `doc/plans/2026-10-03-dependency-test-ready-state.md` 记载旧测试输入缺少实际 child/blocker 状态键，修正的是测试，不是放松依赖 admission。其 33 tests 是历史验证记录；本文另外重跑相关纯测试，不能把历史结果扩成今天全仓库通过。
2. `doc/plans/2026-10-03-active-primary-monitoring.md`、`e7761ba11` 已处理活跃主模型可用性检查。本领域不重复建立另一套 provider 监控；不将普通工程等待解释为主模型不可用。
3. SPEC `:1687` 的 native task completion 明确允许普通低风险任务接受当前 Agent 的结构化 `done` claim。`completion-contracts.ts:38-45` 返回 `completionAuthority: "agent_claim_policy"`；`status-arbiter.ts:262` 执行这个策略。这不是意外遗留 bug，也不应偷偷改成“每个小任务必须外部人工验收”。
4. `doc/execution-semantics.md:660` 明确退役 automatic productivity review：run 数、缺评论和任务时长不能自动生成审批/监督任务。本计划不恢复这个机制。
5. `successful-run-handoff.ts:69` 排除 plugin 管理的生命周期；`:341` 排除 recovery action 驱动 run，防止恢复/交接反复互相制造新 run；`:347` 排除 monitor maintenance。继续保持这些退出条件。

## 3. 确认缺陷和契约缺口

### DG-01：watchdog 将恢复完成与“合法停止已审查”混在一起

**等级：确认契约缺陷；纯 classifier 已复现，完整恢复 API 尚未执行。优先级 P0。**

- 产品契约：SPEC §9.9（`:783` 一带）以及 `execution-semantics.md:771-783` 要求区分 `stopped state is legitimate` 与 `live path restored`；恢复后同指纹再次停滞应重试，持久 attempt lineage，2–3 次后人工升级。
- 实现：`task-watchdogs.ts:304-329` 的指纹只包括叶节点 status、owner、blocker、pending interactions/approvals；`:521` 命中 reviewed fingerprint 就抑制。
- `markTerminalWatchdogIssueReviewed`（`:1269`）从 watchdog 任务的有效处置得出 reviewed fingerprint（`:1281`），写 `lastReviewedFingerprint`（`:1294`），没有读取“恢复”或“合法停止”的结构化判定。
- `issue_watchdogs.ts:18-24` 只有 observed/reviewed fingerprint、snapshot、完成时间、triggerCount；triggerCount 不是同一恢复 lineage 的 attempt count，没有持久 restored disposition、verification due 或 actions lineage。

**最小复现：** 两层子树，父任务 `in_progress`、叶任务 `blocked`，没有 live path。第一次 classifier 为 `stopped`。将该指纹记录为已审查，仅给父节点新增 comment/updatedAt，第二次为 `already_reviewed`，指纹完全相同。模拟的是“中间主管恢复尝试没改变叶子”的关键输入，不是生产数据库故障复现。

**用户影响：** 主管被唤醒但未建立有效路径，watchdog 任务 `done` 后原树可能永久沉默。反向简单删除指纹抑制又会产生无界唤醒。

**修复方向：** 在现有 watchdog 行/ledger 增加明确 disposition 与恢复 lineage；合法停止才写 reviewed；恢复写 bounded verification。停止状态相同但恢复 attempt 未成功时增加 attempt，耗尽后一次升级，保留源 owner。不要把任意评论塞进指纹造成持续重触发。

### DG-02：文档要求的 watchdog 原子恢复 batch 尚无实现契约

**等级：确认文档/源码接口缺口；并发行为需隔离集成复现。优先级 P0，与 DG-01 同一任务交付。**

- SPEC §9.9 要求同一 watchdog run 最多3项允许 mutation，single-shot、all-or-nothing、按所见 stop fingerprint 判新鲜度；`execution-semantics.md:740` 有相同契约。
- 当前 `routes/issues.ts:5416` 对每次源子树 mutation 独立调用 `revalidateMutationScope`；没有 batch payload、一次提交的原子事务或已使用的 batch claim。
- 在对应 `task-watchdogs.ts`、`routes/issues.ts`、shared issue validators 与 watchdog tests 中未找到 recovery batch、恢复 attempts/disposition 的类型或路由。

**用户影响：** 需要“改状态/补 blocker/说明”共同建立路径的恢复可能只应用一部分；第一次改变树后后续请求会按旧指纹被拒绝。不能靠提示词要求“换写入顺序”证明解决。

**修复方向：** 一个限定 watchdog 子树的 batch API，复用普通更新/依赖/指派授权；锁住 config/root 与待写 issue，revalidate 一次，全部验证后一起写。任何 stale/concurrent live、越界、治理拒绝使整批回滚，留下失败证据；禁止借 batch 扩展可操作对象。

### DG-03：活动数量被当作实质进度，可通过重复记录逃过无进度抑制

**等级：确认监督语义缺口；当前纯函数已复现。优先级 P1。**

- `run-liveness.ts:198-209` 的 `hasConcreteActionEvidence` 只判断 comment、document、work product、activity、tool/action 的数量之和大于0；`:348` 直接给 `advanced`。
- `issue-rewake-throttle.ts:62-85` 将 `issue.comment_added`、`issue.updated`、document/work-product update 等活动列作进度；`:165` 有活动的 run 直接结束 no-progress streak。
- 本次输入“读了未变化源码、tool/action count=1”得到 `advanced`。两次成功 run，最新 run 被标记有普通评论活动，节流结果 `blocked:false, noProgressStreak:0`。

**边界：** 活动计数可证明模型/工具在工作，不能单独证明目标推进。本次没有证明当前公司实际通过这种方式浪费了多少 token。文档、计划、研究或部署产物本身可以有价值，不能反向改成“无 Git diff 就无进度”。

**修复方向：** 保留 activity/liveness 诊断；新增一份通用“物质变化”投影供监督/节流消费。以当前任务契约的 criterion、产物版本/内容摘要、验证结果、依赖解锁或未知项解决为依据；普通 status narration 和同内容重写不重置 lineage。平台检查客观版本和因果关系，是否有用由任务 owner/验收者判断。

### DG-04：resume compact 仍无上限重带完整 plan

**等级：确认构造层重复与大小无界；真实费用/缓存影响待量测。优先级 P1。**

- `task-plan-context.ts:25` 读取完整 `documentRevisions.body`。
- `heartbeat.ts:8710-8715` 将完整 plan body 放进 task markdown，没有大小限制。
- compact 版本在 `:20901-20904` 只设置 `includeDescription:false`；计划仍完整保留。
- `adapter-utils/server-utils.ts:2199-2215` 的 `selectPaperclipTaskMarkdown` 在普通 resumed wake 选择 compact；Codex `execute.ts:1127` 选择、`:1215` 实际拼入 prompt。
- 已有 promptMetrics（Codex `execute.ts:1218-1227`）记录 taskContextChars 等长度。不能再添加一个同名观测功能或假定字符等于 token。

**用户影响：** 长计划和多轮 supervisor 对话可反复注入同份内容。完整计划有时必要，尤其 fresh/recovery/批准版本切换；不能随意截尾导致漏掉范围、验收和约束。

**修复方向：** fresh session 按契约供完整必要上下文；同一真实 provider session 已收到且确认的同一 revision，用 revision/hash 和当前步骤做 delta。变更、丢 session、provider 切换或无法证明已收到时重新发必要内容；授权约束、最新 steering、pending comments 不可被摘要覆盖。用按需分页读取完整文档处理超限。

### DG-05：可由执行者写入的产物状态被升级为“权威验收证据”

**等级：确认源码证据权威缺口；尚未执行隔离 HTTP/数据库链路复现。优先级 P0。**

- `validators/work-product.ts:90-103` 的 create/update 允许 `status:"approved"`、`reviewState:"approved"`。
- `routes/issues.ts:10660` 的 create 与 `:11085` 的 patch 检查公司/任务 mutation、status-only recovery 和 source trust；`:11135` 把允许 patch 送入 service。该路径没有独立验收 actor/criterion/version receipt 的校验。
- `work-products.ts:254-277` create 直接写输入；`:279-313` update 直接写 patch。
- `native-runtime/evidence-classifier.ts:146-169` 把同任务 work product 的上述状态直接判为 `work_product_authoritatively_accepted`；没有核对独立 reviewer 身份、内容版本、测试判定或该 evidence 对当前 criterion 的适用性。
- `evidence-classifier.ts:209` 一带将“attachment 记录存在”判为 accepted。这能证明文件保存，不能证明附件内容实现任意工程需求。

**边界：** 普通低风险 agent claim 的允许策略是另一条有意设计的完成路径；本问题是“独立证据”的身份被普通可写字段冒充。不声称当前生产已被利用。

**修复方向：** 产物展示状态保留；verified delivery 所消费的 acceptance 必须来自有权 server-derived reviewer/verifier 的不可变记录，绑定 criterion、合同版本、产物内容版本和 run。上传存在仅满足“文件已交付/可访问”类 criterion，不自动满足“功能正确”。当前 Agent 正常登记产物不需要额外 board 审批。

## 4. 待验证问题：不能直接命名为根因

| 问题 | 当前能证实什么 | 最小下一证据 |
|---|---|---|
| CEO/主管主线跑偏 | 模板强调 delegation/follow-up，但没有平台对目标完成比例的客观判定 | 一个隔离项目，逐 wake 列目标、实质新增、接收人、费用；人工按同一rubric 判定 |
| 父任务早 `done` | `parentId` 本来不等于执行前提；child-ready wake 对已 done/cancelled 父任务不再唤醒（`issues.ts:9102`） | 构造父任务明确要求整项目交付、child仍缺必需结果；分别测试有/无 blockers及 native/legacy finish |
| 父任务一直 `blocked` | blocker cycle/state keys、周期回补、root owner候选已存在 | 检查 exact edge、当前 owner、ready-state key、pause/review/approval/monitor及workspace finalize，不能仅看状态颜色 |
| 文档/协议/互审占比过高 | 有 task graph最小化技能，但 CEO模板“所有任务都委派”与QA模版处置存在冲突 | 同输入、同预算比较模板，记录有效产物和重复文档的hash；不把新文档数量当成成果 |
| 默认权限妨碍推进 | 普通技能开放默认与 run/subtree/低信任边界是不同层 | 模板给真实持久 capability、禁止探测；隔离正例+越界反例；不要批量放开权限 |
| 大repo扫描慢 | scheduler/cache/fairness/timeout保护已存在 | 固定真实repo规模的 CPU benchmark，分 queueWait、scan、workspace sync、context preparation、provider time |
| Token预算不够可见 | cost events有tokens，BudgetMetric只有billed_cents（`shared/constants.ts:878`，`budgets.ts:148`） | 订阅/不定价输入的匿名usage聚合及未知率；再设计token/attempt/time限额 |
| 当前团队模板是否生效 | catalog模板存在，不代表已有Agent instructions已自动升级 | 接手时检查模板来源和当前有效instructions版本；只输出版本/哈希、配置类别，不输出prompt内容 |

## 5. 有限、可执行的交付契约

### 5.1 一个任务只维护一份可版本化契约

先在现有任务 `plan`/description 工作流表达；只有平台需要执行字段时才新增 shared 类型。拟将 `completion_contracts.contractJson` 扩成支持普通任务的通用schema，保留当前 native协议，避免新造第二套goal/task关系。

```ts
// 建议新增契约；不是当前已存在的 API。
interface IssueDeliveryContractV1 {
  schema: "paperclip.issue-delivery-contract.v1";
  objective: string;
  scope: readonly string[];
  nonGoals: readonly string[];
  acceptance: readonly {
    id: string;
    requirement: string;
    evidenceKind: "artifact_access" | "document" | "test" | "user_flow" | "external_effect";
    authority: "agent_claim" | "configured_verifier" | "independent_agent" | "human";
    required: boolean;
  }[];
  requiredIssueIds: readonly string[];
  stopConditions: readonly string[];
  automaticAttemptLimit: number;
  deadline: string | null;
  completionMode: "ordinary" | "verified_delivery";
}
```

使用原则：

1. `ordinary` 是当前默认，不强制每个任务双层review或人工审批。
2. `verified_delivery` 由用户/项目 policy 显式选择，优先复用当前 `reviewPolicy` 和 execution stages 表达阶段权威，用于整项目验收、跨系统效果或需要独立证明的阶段。根任务只绑定必需 child result，不要求所有历史/可选 child 关闭。
3. `requiredIssueIds` 用既有 `blockedByIssueIds` 表达真正执行依赖；两者不能出现互相矛盾的路径。平台校验公司、循环、目标当前性；不替业务决定哪个结果必需。
4. 计划/研究/报告任务的产物可以是document，验收是其内容覆盖与可用性。代码任务可能要求test+user flow；部署任务要求实际effect 和受控访问。Git diff只是某类证据。
5. 阶段任务完成仅表示自己合同完成；根任务需要整体验收。管理总结不能覆盖缺失criterion；QA任务“报告完成”也不等于被测产物通过。
6. 停止条件包括显式取消/暂停、硬预算、治理审批、达到安全尝试上限、明确外部等待。每个条件指定下一 owner 和解除事件，不能留下无限重复 wake。
7. 每个阶段产物只做一次所需验收；根负责人消费该 verdict，不再增加重复批准卡。普通小任务保持直接完成，正式 governed approval 继续由其原权威判定。
8. 工作开始前允许简短自检契约；只在范围/风险/验收发生实质改变时修订，不每个 heartbeat 重写蓝图。

### 5.2 进度需要信息增量与因果证据

保留三种不同投影，不用一个 `advanced` 承担所有结论：

| 投影 | 回答 | 可作为监督结论吗 |
|---|---|---|
| Runtime activity | 进程/模型/工具是否在活动 | 只能辅助liveness，不表示criterion推进 |
| Material progress | 自上一有效检查点，哪些产物/判定/依赖/未知项有新增 | 是；按任务类型和当前合同解释 |
| Delivery acceptance | 必需criterion是否由有权主体、当前版本证据满足 | 是；根任务完成依据 |

对同一 `(company, issue, contract revision, causal input fingerprint)`：

- 同内容评论、同状态来回更新、相同测试结果、相同文件hash不重置无进度attempt lineage。
- 新document内容可以形成真实增量，但是否覆盖目标需要criterion映射；不能因“文档”类型一律否定。
- 新错误可形成诊断进度：须明确新识别的原因、对应复现和下一owner；同一错误换措辞不算。
- 外部长任务的心跳只证明仍在等待；进度是checkpoint/remote job状态/验证结果，不能要求长运行每几分钟Git变更。
- 新用户指令和新有权事件保留各自独立因果，不受旧自动retry去重误吞。
- 主管可以看到输入digest与新增项；只在真实变更/到期/失败事件唤醒，不能让同组主管互相评论制造活动。

先以只读投影上线并对样例人工校准，不直接启用自动阻止业务工作。验证错误率后，仅在显式合同的自动wake路径执行有限抑制；不得恢复按run数自动生成productivity review。

### 5.3 阻塞推进：跟到根owner，继续未阻塞分支

1. 主管检查当前必需结果与真实blocker edges，复用 `issue-graph-liveness` 的blocked leaf和owner候选。遇到chain时沿边追到可操作owner；不要把父任务反复叫醒再报告“仍被阻塞”。
2. 已分离且不共享写入/权限/资源的分支可并行，按现有agent/group/instance/workspace容量 admission。相同GPU、生产service或同一文件写入不因Agent数量多而并行。
3. 一个外部等待只登记一个durable路径：已有monitor、typed pending interaction、governed approval、blocker或恢复action。到期再查；不要同时登记monitor、常规timer和主管poll。
4. blocker resolved、artifact验收变化、plan revision accepted采用稳定因果键和当前版本revalidate；周期sweep只补交付窗口，不能无限mint新原因。
5. 正常CI/外部job等待不作为“怠工”。无人owner、截止已过、同一失败无新增、恢复路径消失才生成一次有限升级。
6. root blocker由其owner解除后，原任务owner继续；平台不擅自为另一高层“接管”。越权需求返回现有typed denial和可执行owner action。

## 6. 职责与模板：可配置改善，不把业务判断写进平台

### 6.1 当前模板的可见问题

- Core CEO `packages/teams-catalog/catalog/bundled/company-defaults/core-exec-team/agents/ceo/AGENTS.md:21` 一带要求所有工程任务委派，甚至small/quick。它不要求无限多级下放，但若每层复制该习惯，管理层次会压过实际交付。
- `skills/paperclip-converting-plans-to-tasks/SKILL.md:18-31` 已明确最小issue图、自身最适合时亲自负责、下一步清晰就执行。模板应与其一致，不能再发明“每层必须分解和写协议”。
- Core CTO/Engineering pod CTO已有主动执行和工程blocker责任规则，QA也已有e2e和证据职责，不应声称模板完全没有职责。
- 旧QA招聘模板 `skills/paperclip-create-agent/references/agents/qa.md:68-74` 倾向失败后reassign review task给coder、仅pass才done；当前operational skill `skills/paperclip/SKILL.md:234` 与任务拆分skill `:30` 指定“review verdict是产物，发现失败仍done，修复由parent owner负责”。这是需要统一的处置冲突。
- `skills/paperclip/SKILL.md:624` 对plan默认in_review，任务转换skill `:39` 又讨论验证graph后source planning issue done。应区分“后续实现仍属于源任务”与“独立交付计划/任务图已经完成”，不以一个固定句子支配全部planning任务。

### 6.2 建议管理模板片段

```text
CEO：你负责目标、优先级、跨团队决策和整体验收可见性。
收到工程项目时，保留一个根目标和一个技术交付owner；委派给CTO后不复制其工程计划。
普通任务无需再建立CEO批准层。仅范围/预算/治理权限/跨团队冲突需要你的决定。
每次wake先处理触发事件，写出新增criterion/产物/阻塞owner和下一动作。
没有新增证据或到期事件时，不重复评论、不唤醒原等待者、不重写计划。
不得因worker run成功或子任务数量下降就关闭整项目。

CTO/主管：你负责拆分最小必要任务图、集成、工程blocker和验收安排。
下一个步骤小且清晰时直接推进或交给已确定worker，不增加新的协调层。
独立分支依据真实资源/写入边界并行；阻塞分支追到root blocker owner。
QA verdict 落地后读取结论，失败则安排有范围的修复，避免把已完成QA报告改成blocked。
只有合同必需结果、集成和验证满足后，提交根任务验收。

执行者：完成当前合同。允许代码、文件、计划、部署或外部效果等任务类型。
给产物可访问路径和当前版本证据；说明已运行与未运行检查。
不为留下“活动”重复读全仓库、重写文档、重跑没有新风险的全套测试。
遇真实blocker登记持久owner/action；控制平面相同写入失败两次就停止该写入。

QA：你交付可复验verdict。PASS 或 FAIL报告完整时QA任务都可done。
报告绑定被测版本、环境、criterion和证据；FAIL描述最短复现，修复归工程owner。
测试套件通过不能代替UI/用户流程验收；业务标准由项目合同给出。
不尝试写入被授权范围以外的parent/sibling，不把越权403当作需要反复探测的问题。
```

这些片段需要在隔离团队比较后修订catalog和招聘模板；已有Agent的instructions升级是另外一个显式部署动作。本次没有更新任何业务Agent。

## 7. 最小平台接口/数据契约改造

所有以下名称是实施建议，不是声称已上线。

### 7.1 Watchdog补齐现有契约

- 扩现有 `issue_watchdogs`：`lastDisposition`（legitimate_stop/restored/waiting/escalated）、`restorationLineageFingerprint`、`restorationAttemptCount`、`restorationMaxAttempts`（仅2或3）、`restorationVerificationAt`。
- 为不可变attempt/action历史新增 `issue_watchdog_restoration_attempts`；每行绑定company/watchdog/root/run/fingerprint、attempt ordinal、recovery action refs、observed result。唯一键 `(watchdog_id, lineage_fingerprint, attempt_ordinal)`；company/owner composite FK、keyset索引。triggerCount保留原含义。
- `POST /api/issues/:id/watchdog/recovery-batch`：body `{ expectedStopFingerprint, idempotencyKey, mutations }`；mutations为既有允许操作的typed union，长度1–3；server从run/config导出authority，不信caller的company/actor/allowedOperations。
- `POST /api/issues/:id/watchdog/disposition`：提交typed判定及本run actions/evidence refs，server核对batch/effect是否真实落地；只有合法停止写reviewed，restored进入verification。不能靠`done`文字猜判定。
- shared validators/types、routes/service、db export/generated migration、UI/watchdog状态同步。当前活跃run/wake/retry、pause、budget、approval、low-trust、范围排除仍有效。

### 7.2 可验证交付与不可变验收

- 复用 `completion_contracts` 保存issue级版本契约，使用新schema/policy version；保留native原合同兼容层。reviewPolicy、workMode、用户新指令、current contract version仍是authority gate。
- 新增最小通用 `issue_delivery_assessments` append ledger：company/issue/sourceRun、contractId/hash、criterionId、workProductId或documentRevision/verificationRef、contentDigest、outcome（accepted/rejected/unknown）、server-derived actor/verifier、inputDigest、supersedesId、createdAt。
- 不能直接把legacy assessment塞进 `work_assessments`：当前表 `work_assessments.ts:55-77` 绑定 `heartbeatRuns.nativeIssueId` 与 `native_run_results`。native可引用同一通用验收记录，legacy则保留自身run context的所有权验证；禁止制造native result来骗FK。
- `POST /api/issues/:id/delivery-assessments` 仅允许该criterion配置的有权验收者/受控verifier，不允许执行者通过普通work-product PATCH造accepted；`GET /api/issues/:id/delivery` 返回只读criterion/evidence/owner projection。
- 普通产物create/update API继续工作；状态仍用于展示和工作流。verified finish只认当前contract与当前contentDigest的真实assessment；过期证据读作stale并可解释，不删除历史。
- attachment existence用于artifact_access criterion；具体功能正确要test/user_flow/external_effect证据。review完成记录与产物pass判定分别表达。
- `Issue.delivery`/shared type与UI产物面板显示：需求、产物、未通过项、最后验收者、下一owner、未运行检查。run badge只显示run执行结果。

### 7.3 进度和去重

- 新增 `server/src/services/issue-material-progress.ts` 作为纯归一化/变化分类owner；不要把所有逻辑加进大型heartbeat facade。
- 复用activity、document revisions、work products、delivery assessments、dependency changes构建stable material fingerprint；恢复 lineage key不得包含随机run id、comment id、纯timestamp等会每次变化的字段。
- `issue-rewake-throttle` 消费实质变化与真正新输入；agent换措辞、自我评论不重置。人的新输入按原现有授权路径继续。
- source-scoped recovery与wake queue仍负责等待/幂等；新模块不生成自动审批任务，不持有任何board authority。
- 活跃run“有输出”与无输出告警继续使用现有规则；不要把物质进度检查变成无证据强杀进程。

### 7.4 上下文与资源预算

- 将current provider/session/config identity下“已交付plan revision/hash”作为受证据保护的投影；只在确认prompt发送/turn被接受后写，不在拼接时提前记已收到。
- context构造输出各component的bytes/chars、revision、cache/ref/delta decision和omitted counts；复用当前promptMetrics和run-log timing，不记录prompt文本、路径、环境值。
- 以显式配置的context token budget构造prompt；token数能获得时标记exact，估算必须标记estimate。预算小于mandatory授权/最新输入时明确拒绝/按需分页，不能静默省略安全和请求内容。
- 新token/automatic-attempt/time policy复用budget admission入口；当前BudgetMetric只有billed_cents，新增metric/issue scope需要shared/db/server/UI与治理review，不能伪称已有功能。
- 上线顺序：先按已有company/agent/project money budget和本任务automatic attempt/time bound运行；再建立观测usage、unknown coverage、订阅usage限额。未知价格写unpriced，订阅成本与按量估价分别呈现。
- Cached tokens保留provider定义；不能简单用prompt少了多少字符就宣称费用节省。多个run/恢复链合计必须保持provider usage归一化的真实delta，不将resume累计snapshot重复当新消费。

## 8. 实施任务及依赖

每项结束都交付一个可独立拒绝/接受的结果。文档、配置和测试包含在该结果内，不另建“写协议→审协议→批准协议”的任务树。

| 任务 | 依赖 | 改动范围 | 可验收结果 |
|---|---|---|---|
| G0：冻结合同与隔离验收说明 | 无 | 本领域architecture/plan、sample fixture定义 | 当前普通完成策略与verified delivery边界清楚，现有机制可追溯 |
| G1：watchdog restored/legitimate stop与原子batch | G0 | watchdog schema/service/scope/routes/shared/UI与focused tests | failed restoration同lineage最多3次，升级一次；≤3mutation全成或全回滚 |
| G2：产物验收authority与criterion/content绑定 | G0 | work-products/native evidence/delivery ledger/routes/shared/UI | 执行者可登记产物，不能自造独立验收；当前版本可复验 |
| G3：物质进度与自动wake信息去重 | G1、G2 | 新纯progress leaf、throttle/recovery/queue消费 | no-op/重复 prose不刷新progress；有用document/新诊断/真实效果仍算 |
| G4：plan delta与context成本观测 | G0 | task-plan-context/heartbeat构造/adapter-utils/具体adapters/shared | 同session同revision不重复正文；fresh/recovery/变更不漏合同 |
| G5：模板和operational skill一致性 | G0，可与G1/G2/G4独立 | catalog CEO/CTO/QA、招聘QA、planning段落；tests | 最小图、唯一owner、QA verdict和阶段/根完成语义一致 |
| G6：token/attempt/time预算 | G3、G4；money机制保持 | budgets/constants/validators/schema/admission/costs/UI | 有限自动尝试和成本可归因；预算硬停不能被watchdog bypass |
| G7：隔离样例端到端交付 | G1–G6 | 独立company/instance/project/workspace及验收证据 | 用户真实操作通过，产物与契约一致；主管推进与失败边界可见 |

### G1实施步骤

- [ ] 在 `task-watchdogs-classifier.test.ts` 加入本文两层子树复现，断言restored后同fingerprint不能变legitimate reviewed，attempt递增；独立合法停止继续抑制。
- [ ] schema/generated migration加入typed disposition与attempt ledger；不从历史`done`自动反推restored或legitimate，历史状态标记unknown并保留人工可检查。
- [ ] 实现recovery batch及single-shot claim 事务；断言第二次提交相同key返回原结果，另key同run拒绝；任意mutation越界/失败整批回滚。
- [ ] 实现verification tick，复用既有reconcile调度和预算gate；2或3次后一次human escalation，服务重启不重置计数。
- [ ] 最小UI显示恢复中/验证/耗尽与具体owner，完成创建/复用/恢复失败/升级的浏览器验收。

### G2实施步骤

- [ ] 写隔离route regression：同任务执行者create/PATCH work product为approved不能满足independent criterion；原字段展示仍兼容。
- [ ] 新ledger绑定criterion与当前内容摘要，验证不同company、issue、run、revision、digest均被拒绝；缺证据保持unknown。
- [ ] native classifier消费权威assessment；只读展示状态不升authority；低风险ordinary claim不被新模块强制审批。
- [ ] 根taskverifiedfinish对required criteria缺失拒绝done，给准确owner/action；new comment/version修订使旧finish不能覆盖新需求。
- [ ] 人工点击真实产物、复验准则；有用plan/document项目允许完成而无需Gitdiff。

### G3/G4/G5/G6实施步骤

- [ ] G3先shadow 对比：重复comment/hash和真实document revision样例；人工判定false positive/false negative，再启用仅自动wake有限抑制。
- [ ] G4加入100KB plan 构造/发送测试：同revisionresume发pointer/delta，fresh/changed/lost-session发所需正文；latest user steering和批准版本完整覆盖。
- [ ] G4用现有promptMetrics对比，保留exact/estimated/unknown tokens；只读报告cache eligible/hit，不填假节省百分比。
- [ ] G5统一QA negative verdict为完成报告，修复回工程owner；加入任务图审阅fixture，禁止按每个文件/步骤机械拆任务。
- [ ] G6从现有money admission加入optionalusage/attempt/timegate；paused/company/project/governed approval还有效；新Agent/换run/重启不能重置同一自动lineage。
- [ ] 完成contract sync和最小相关tests后做一次全仓typecheck/test/build；发现无关失败单列，不扩成被修复声明。

## 9. 自动检查与真人最少验收矩阵

| 场景 | 自动检查 | 真人验收 | 成功边界 |
|---|---|---|---|
| Ordinary小任务 | 现有structured claim、ownership、pause/budget/governance regression | 可抽看产物 | 不新增双层审批，功能本身满足小任务范围 |
| 隔离样例根交付 | required criteria、artifact/version、integration、dependency/successful handoff | 必须操作真实用户流程并复验截图/产物 | run succeeded或平台200不能替代 |
| QA发现失败 | verdict task done，acceptance failed，工程 owner woken once | 阅读复现并重试被测操作 | 报告完成与产物pass分别显示 |
| 父任务提前关闭 | root required result未通过；native/legacy 状态写不覆盖合同 | root面板能说明未交付项 | 可选child不成为永久阻塞 |
| childdone但effect未落地 | readiness/finalize/currentversion与实际effect | 打开/运行实际产物 | 状态变化不伪造效果 |
| 被阻塞分支与独立分支 | real edges、capacity/workspace isolation、事件 wake idempotency | 查看独立分支产物仍推进 | root blocked不等于全公司停摆 |
| 外部CI/job正常等候 | monitor到期、上限、有效owner；无主动poll重复run | 查看下一检查时间与等待目标 | PID/日志/评论不能假装持续watcher |
| 无效主管恢复 | 本文同fingerprint再停；2–3attempt durable与一次escalation | 看到历史动作、root owner、解除方式 | 不永久沉默、不无限wake |
| 重复活动 | 相同内容/digest不计进度、没有新event不重复wake | 核对一段真实trace的新增信息 | 命令数/日志数/评论数不是进度 |
| 文档/部署/训练类无diff任务 | document/effect/checkpoint有版本/访问/结果 | 项目负责人判断其实际价值 | 禁止用Gitdiff=0否定所有任务 |
| 权限负例 | same company/subtree/low trust、review policy、governed approval | 只对隔离testactors执行 | 默认技能开放不扩展host/secret/productionscope |
| money/usage/attempt边界 | hardstop、unknownusage、lineage不重置、缓存归因 | UI清楚显示实际/估计/未知与费用责任 | 订阅token不是自动按API价格收费 |
| 大repo与长plan | fixedfixture、scanqueue/time/cache、context长度/准备时间 | 第一次和重复操作的实际响应 | 无测量不调高timeout/扫全机 |

## 10. 一个隔离工程样例如何证明交付

### 10.1 样例选择与团队规模

选择一个CPU-only、无生产账户的“本地文本清单小应用”：用户在网页添加、编辑、删除条目，刷新后仍保存，可导出JSON再导入恢复；窄屏可操作。仅测试数据，不需要远程业务、模型训练或真实GPU。首个版本明确不含登录、多租户、支付、第三方消息和生产部署。

队伍只需主管、执行者、QA；CEO作为根目标沟通/范围决定owner，不再制造一层实现方案。并行只在确有独立交付时使用，例如应用实现与可独立验收的使用说明；不要为每个按钮/文件建任务。

### 10.2 最小真实执行图

1. 根任务：交付并验收应用，`verified_delivery`，保留一个负责人。
2. 实现任务：独立workspace完成应用和最小automated tests，登记preview/artifact；具体steps留在任务内部。
3. QA任务：依赖实现，独立运行真实浏览器flow，在自身任务提交PASS/FAIL、版本、视口和截图；即使FAIL也报告done。
4. 必要时一个有范围的修复任务，复用实现owner和既有revision；QA对新版本重新验收，不无限新建“复核复核”。

根任务对必需结果连接blocker/acceptance证据；完成QA只是“结果已到”，根owner仍需读取verdict。任意FAIL不能因QA任务done变根项目done。

### 10.3 本轮验收包含的故障注入

在隔离company/instance执行，不动原公司：

- 实现run成功但未登记required artifact，根交付仍不通过。
- QA报告刷新丢数据，主管收到一次事件，修复owner推进；测试通过后真人重试。
- 一个外部可控fixture等待，已有monitor正常等待，其他独立分支仍推进。
- 主管恢复只添加解释评论，没有真实路径；watchdog重新验证，次数耗尽升级一次。
- 执行者自填work product approved，不能伪造independent acceptance。
- 新用户改变导入约束，旧版本证据不关闭新合同。
- budget/pause 触发后主管/watchdog也不得绕过；恢复需要原规定authority。

真实模型执行属于G7另外的受控阶段，本次未执行。先完成mock/fixture验证再做一次fresh 模型项目，不把fixture、unit suite或API 200报告成模型交付证明。

### 10.4 最少交付证据包

保存：source commit/配置版本、匿名 team roles与limits、contract revision、task/edge graph、run/wake/recovery lineage、token/cost status汇总、产物访问路径与hash、automated test输出、真人浏览器步骤/截图/结论、故障注入与一次恢复结果、未完成项。对外报告不给secret/prompt/transcript全文。

允许结论：`隔离样例受监督交付通过`。不能扩大成“所有复杂项目无人值守已可靠”，也不能只发布漂亮模板图或unit 绿结果。

## 11. 其他 Agent 第一小时和第一天

### 第一小时：先恢复事实与选一条最窄修复

| 时间 | 动作 | 交接物 |
|---|---|---|
| 0–10分钟 | 确认repoHEAD/dirty范围、AGENTS五docs、有效服务源码身份，read-only | 当前snapshot与禁止改动范围 |
| 10–25分钟 | 重跑本文纯函数复现；读DG-01/DG-02owner与current tests | 可重复反例；不把历史测试当现验 |
| 25–40分钟 | 确认只修G1或G2的文件范围和contract，不混入provider/UI大改 | 有输入/输出/状态转移/测试的实现切片 |
| 40–60分钟 | 写failing regression、验证fail原因，形成generatedmigration/接口review草案 | 可审查diff或可执行测试；不派业务任务 |

如果环境缺依赖，报告具体binary/package/version和可继续部分；不要下载未知CLI、暴露env或拿模型试探权限。本文首次尝试tsx时该binary不存在；随后使用现有esbuild在内存转译，不安装依赖、不写tmp源码。

### 第一天：完成一个机制闭环，再扩下一块

1. 上午完成G1最小实现和focused tests，包括恢复失败/原子rollback/重启不重置/一次升级；下午通过隔离浏览器验证。若G1未通过，继续处理真实失败，不同时启动五套协议。
2. 独立团队允许并行G2/G4/G5，但每人独占文件owner；root 主管承担接口合并与最终验收，worker DONE不是交付。
3. 每次里程碑报告只含：当前合同、新增产物/criterion、剩余blocker及owner、实际验证、已花usage与未知、下一动作；同信息不再报告。
4. 当天至少交一个运行可验收的机制和一份证据包。只有plan文档交付是本日合同目标时，文档本身才是本日complete；不能将尚未实现的平台修复标成done。
5. G7前冻结source/合同/limits/验收方案，再执行fresh隔离工程项目；任何平台源码修补使该次项目证据标明版本变化，不能继续沿用旧完成声明。

### 每个heartbeat的反跑偏检查

- [ ] 当前动作能对应一个criterion、artifact、rootblocker或安全gate；不能对应则停止该动作。
- [ ] 最新用户steering已进入当前context；没有重放旧标题覆盖新要求。
- [ ] 有一个负责交付owner，所有等待有实际持久path与解除事件。
- [ ] 新子任务说明了专业/并行/权限/生命周期边界；否则合回当前任务内部步骤。
- [ ] 本轮新增证据与上轮digest不同；没有只是增评论/日志/协议数量。
- [ ] 声明完成对应当前版本/实际effect/验收authority；未运行检查明示。
- [ ] 自动尝试没有因换run、换角色或重启重置；耗尽有一次明确升级。
- [ ] 普通小任务没有无依据加多层审批；真正governed动作没有被普通interaction替代。
- [ ] 文件、文档和外部效果均按任务类型验收，未把Gitdiff作为唯一产物标准。
- [ ] 当前使用已知workspace和窄查询；扫描/上下文成本有测量，未用扩大timeout掩盖根因。

## 12. 本次验证与剩余边界

实际执行：

```text
纯函数最小复现（当前TypeScript由现有esbuild内存转译，无DB/模型调用）：
noOpLiveness.state = advanced
commentActivityResetsThrottle = { blocked: false, noProgressStreak: 0 }
watchdogBefore = stopped
watchdogAfterIntermediateActivity = already_reviewed
unchangedFingerprint = true

rtk proxy pnpm exec vitest run \
  server/src/__tests__/run-liveness.test.ts \
  server/src/__tests__/task-watchdogs-classifier.test.ts \
  server/src/services/issue-dependency-wakeups.test.ts \
  --reporter=dot

3 files passed; 45 tests passed; 10.69 seconds.
```

相关45项现有测试通过，说明当前被测试行为没有在本次审计中坏掉；同时三个最小反例证明这些测试没有覆盖新的治理契约缺口。两者不矛盾。

未执行：完整repo typecheck/build/test、隔离API/DB注入、watchdog新机制、UI/browser验收、任何真实模型项目。此次只有审计和计划，没有实现修复；DG-01/02/03/04/05仍需按任务逐项验证和交付。未来费用改善、大repo性能和主管可靠推进比例，必须用真实受控运行再测，本文不填估算成收益。
