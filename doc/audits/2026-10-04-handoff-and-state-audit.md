# Paperclip 交接消息、运行控制与状态真实性审计及实施计划

> **供接手 Agent 使用：** 实施时使用 `superpowers:executing-plans`，按本文任务逐项落地；若 Root 已明确安排并行 Agent，写入职责必须互斥。本文主体是审计和计划；Root 后续授权的最小隔离源码修复单列第13节。生产配置、服务和业务任务没有修改。

**目标：** 用户和 Agent 发出的有效交接及时进入真正有能力接收的执行路径；页面准确说明消息等待、已确认插入、确认未知、运行推进与任务完成，并保留原文、作者、旧执行和失败证据。

**架构：** 继续使用 `agent_wakeup_requests`、现有 wake-queue、heartbeat、ACP/native adapter 和运行事件。补充消息投递事实与观察证据，使用短事务领取、外部发送、短事务确认；这些记录不获得独立调度权，不新增第二个调度器。

**技术栈：** Node.js 24.11+、pnpm 9+、TypeScript、Express、Drizzle/PostgreSQL、acpx 0.12.0 补丁、Paperclip runner/PRP、React/TanStack Query、Vitest、Playwright。

**契约来源：** `AGENTS.md`；`doc/GOAL.md`、`doc/PRODUCT.md`、`doc/SPEC-implementation.md`、`doc/DEVELOPING.md`、`doc/DATABASE.md`；现有 2026-10-01/03 live-handoff、uncertain-handoff 计划及执行语义。接手后保持后者的控制、安全和身份边界。

## 1. 审计版本、范围与证据等级

- 审计磁盘基线：`ce97b8e8fee0b952186e85f4433c29491d63ae2c`。
- 本次只读 `GET http://127.0.0.1:3100/api/health` 返回 HTTP 200、`status: ok`、`version/serverVersion: 2026.916.1+50.git.e7761ba11`。这证明运行服务自报版本和健康接口可读，不能证明所有任务推进、provider 可用或交接应用。
- `git diff e7761ba11 ce97b8e8f --stat` 只有 `.serena/.gitignore` 和 `.serena/project.yml`；本文涉及的源文件在两者间一致。仍须分别记录服务 build 和测试磁盘 HEAD，不能把任意后来的 HEAD 当成已运行版本。
- Root 已核 `/api/health/ready` 返回 404；本文不把它当可用 readiness 探针。
- 仓库没有 `.codegraph/`；按仓库规则使用 RTK 源码导航，没有伪造 CodeGraph 架构结果。
- 初始审计修改仅此文件；后续最小源码补丁位于隔离工作树，不改主树 runtime。没有停止/重启服务，没有写生产 DB，没有投递真实模型消息，没有给业务 Agent 发消息，没有碰 Starwave 模型、训练、推理或 GPU。

证据用语统一：

| 标记 | 含义 |
| --- | --- |
| 源码已核 | 当前基线可定位的行为或缺口；不能直接外推所有生产运行 |
| 本次专项已跑 | 本次执行的测试或只读接口，记录命令、范围、结果 |
| 历史已有验证 | 既有计划记录的结果；本次没有重新跑真实模型，不冒充新验收 |
| 待场景验证 | 合理失败窗口或实际影响尚未复现；不能称已证实 P0 |

本次没有发现并复现需要立即停服务的 P0。接手 Agent 如果复现跨公司投递、已停止 run 继续获得权限、重复外部写操作或任务错误关闭，立即通知 Root 并给出最小修复；不要为理论风险主动取消健康长任务。

## 2. 全局约束与审查重点

1. 所有 shell 命令以 `rtk` 开始；每个管道/串联段都必须遵守。文字 UTF-8，源码和文档使用 `apply_patch`。
2. 仅在 `/home/dains/Documents/paperclip` 范围实施平台工作；保留无关 dirty work、已有业务任务及工件。
3. 保留公司、issue、assignee、run、session generation 和 controller 身份检查；消息文本不能获得停止、重试、配置、身份切换或授权能力。
4. 普通交接自动处理。用户不需要人工标注消息类型、逐条审批、手工声明 ACK 或为低风险 task 的普通 `done` 额外审批。
5. provider 不支持运行中插入时使用真实回合边界继续。不能通过取消、启动第二个 prompt、偷偷换模型/engine 或 HTTP 202 来伪造同回合插入。
6. 无日志时间是观察信息；不等于卡死。训练、构建、远程工具的取消依赖原有授权和真正执行归属，不为插入消息盲目打断。
7. 新投递模块只负责已有 wake 的投递/确认，不扫描业务并创建另一套 run、租约调度或优先级系统。

接手审查须覆盖五类输入：发送后 ACK 丢失/迟到；工具执行中 pause/stop/reassign；多条交接编辑/排序/coalescing；浏览器断线/多标签页/重连；run 成功但 issue 尚有真实未完成工作。每类均在下文有具体测试。

## 3. 已有修复：必须保留，不能重新包装成缺失功能

| 修复 | 当前实现事实 | 接手应做什么 |
| --- | --- | --- |
| `f5903c385` live ACP handoffs | acpx runtime 暴露活动 turn steering；server 注册现有 run 控制；真正 `injected` 后移出队列 | 保留同回合、同会话、原作者、工具边界及停止卸载；补崩溃和迟到 ACK |
| `1306b0ad7` automatic handoff UI | `IssueDetail` 用 system ACP activity 的 `commentId/targetRunId` 放入已插入位置；即时 activity 发布在事务完成后 | 验证重连和重复 activity，不把消息仅显示为已发送 |
| `cee703a60` uncertain ACK recovery | uncertain 消息保持，GET 能力变 temporarily_unavailable，专门冲突码/清理错误摘要，复用边界恢复入口 | 优化迟到确认补偿和等待自然结束策略，不允许盲重发 |
| `3ef9609c4` running retry comments | 当前 wake-queue 的 running 判断基于实际 status；已开始的 retry 不因 comment 被当作 queued retry 合并 | 固定 running/queued/scheduled_retry 并发矩阵 |
| `dd351a5e7` retry queue merge | `adoptDeferredCommentsForLegacyRetry` 在原 claim 事务内采用仍有效的延后评论 | 保留作者、原文、交互独立 continuation、队列顺序和已删除过滤 |
| 既有 Stop/capacity/lease | adapter execution control、provider 停止证据与容量归还已有分离 | 不用 DB terminal 或 HTTP 成功代替 provider 已停止 |
| native late ACK identity | `steerNativeSession.onAcknowledged` + `reconcileSteeredIdentity`，并读取持久化 PRP ACK | 不把 native 的已实现能力说成整个系统均缺失 |

`doc/plans/2026-10-01-live-acp-handoffs.md` 曾记录 181 项回归及 Codex/Claude 真实同回合工件验证；2026-10-03 uncertain 计划曾记录 58 项路由回归。它们是历史证据。本次重新运行的范围为第 12 节的 129 项。

## 4. 当前准确调用链及代码归属

行号对应审计基线。接手首先核 HEAD 和函数名称；行号漂移只更新定位，不假定功能消失。

### 4.1 comment 保存、排队、合并和 retry 领取

1. `server/src/routes/issues.ts:18089` 的 `shouldWakeAssigneeForIssueComment` 调用依据真实作者、self-comment、当前 issue 和 resume intent 决定是否唤醒；`18102` 起 `addWakeup` 保留 `commentId`、`wakeCommentId`、原 actor 与 issue。
2. `server/src/services/heartbeat.ts:26147` `enqueueWakeup` 重核 pause、budget、依赖、ownership、原 execution blocker，取得 issue 锁。
3. `heartbeat.ts:27659` 调用 `wakeQueue.admitWakeBehindIssueExecution`；实现为 `server/src/modules/wake-queue/application/use-cases.ts:777`，纯规则为 `domain/policy.ts:44` `decideWakeAdmission`。
4. use-case `805` 附近以 `activeExecutionRun.status === running` 判断运行中 follow-up；`836` 合并到允许的既有 queued/scheduled 目标，`885` 合并延后 wake；身份/特殊 continuation 不兼容时保持分离。
5. `heartbeat.ts:28063` 的 deferred outcome 调 `scheduleLegacySteeringForAgent`，不创建新 provider 执行。正常后继仍由 `startNextQueuedRunForAgent:19820`、`claimQueuedRun:17340` 领取。
6. `server/src/services/retry-comment-queue.ts:14` `adoptDeferredCommentsForLegacyRetry` 仅对 legacy、automation、准确 retry lineage、生效 assignee 与 queued wake/run 工作；`heartbeat.ts:17659` 附近 claim 调用它。它清除重新生成的 prompt 投影并带入 canonical comment IDs。
7. `heartbeat.ts:27941` 起普通 new run 可采用合法 deferred comment wakes；interaction/chat-inbound 保持独立 source、session、actor、receipt。
8. `server/src/services/agent-conversations.ts:408/458` 对 conversation 的 comment outbox 已实现。普通任务 comment 的通知提交窗口与该窄 outbox 不应混淆。

### 4.2 legacy ACP 的自动、手动同回合插入

```text
existing comment + deferred agent_wakeup_requests
  heartbeat.enqueueWakeup / adapter tool boundary
  scheduleLegacySteeringForAgent / scheduleLegacySteering
  live-adapter-steering.deliverLegacySteering
  adapterExecutionControls[runId].steering.send
  createLiveAcpSteering.control.send
  acpx runtime turn.steer
  active AcpClient.extMethod("_session/steering")
  outcome=injected
  transaction records acknowledged + removes exact pending comment ID
  committed activity publication
  LiveUpdatesProvider / IssueDetail causal placement
```

- `server/src/services/adapter-execution-control.ts:4/15`：当前 run 的 AbortController、settled、steering 所有者。
- `heartbeat.ts:24383` `onSteeringReady`：只接受仍属于本 run 的 execution control，注册有能力的 steering 并计划既有 deferred 消息。
- `packages/adapters/codex-local/src/server/execute.ts:570/584` 和 Claude 对应文件 `405/419`：选 engine 后进入 ACP；CLI 路径不由这套控制伪装支持 steering。
- `packages/adapter-utils/src/acpx-engine/execute.ts:4762` `stepTurnStart`：一个既有 `runtime.startTurn`；`4775` 创建 live steering；`4841` `stepEventRelay` 观察工具和能力，活动且 tool-free 再通知 ready；`5197` 卸载。
- `packages/adapter-utils/src/acpx-engine/live-steering.ts:10`：`tools` Set；`send` 在 tool 在途时 deferred；仅真正 active/supported 时调用同一 turn；终态 tool event 清除 busy。
- `patches/acpx@0.12.0.patch:103/110`：握手 `_meta.steering.supported === true`；调用 `_session/steering`、`idleBehavior: promptRequired`；必须返回 `injected` 或 `promptRequired`。
- 同补丁 `183/187`：进程内 `correlationId` 去重及同 ID 不同文本拒绝；此 ID 当前没有作为协议参数传给 ACP provider，只作用于本 runtime Map。
- `server/src/services/live-adapter-steering.ts:28` `deliverLegacySteering`：issue/run/wake 锁、scope/owner/status 检查、原作者和原文、busy 检查；`81` 外部 send；`91` uncertain；`100` acknowledged；`104` 清 pending IDs；`107` activity；`111` 后才广播。
- `server/src/routes/issues.ts:15518/15538`：手动 Steer 使用同 service；不因 API 接受请求就清队列。

### 4.3 native 同回合插入、ACK 和事件持久化

```text
POST queued-comments/:commentId/steer
  reserveSteeredIdentity (when run already uses identity broker)
  lock/revalidate original queue + run + revision
  storedSteeringAcknowledgement OR steerNativeSession
  active native session.steer
  CodexHarnessSession.transport.request("turn/steer")
  typed steering_acknowledgement item.completed
  PRP transport / NativeRunCoordinatorStore.appendEvent
  heartbeat_run_events committed source identity/cursor
  identity reconcile + queuedSteeringAcknowledgements
  queue update + activity + UI refresh
```

- `server/src/routes/issues.ts:15545/15683`：保留身份与队列事务；`15688` 真正 steer；`15728` durable result ACK；`15753` timeout/未知不 reject pending identity。
- `server/src/services/native-runtime/native-session-executor.ts:6063`：真实 capabilities + activeTurnId；`6091`：同 run/comment promise 去重；`6136`：迟到确认 callback；`6149`：ACK timeout。
- `server/src/services/run-identity.ts:276/325`：`prepare/reserveSteeredIdentity`；broker-enabled run 需要 authenticated message author，保留身份隔离；旧 run 无 broker 时不伪造新的身份记录。
- 同文件 `492/514`：迟到 native ACK settlement、从已持久化 native `item.completed` 查 `steering_acknowledgement`。identity accepted 本身不等于任务成功，也不直接证明 queue UI 已更新。
- `packages/paperclip-runner/src/drivers/codex/codex-harness-session.ts:286/305/323`：`expectedTurnId` + `correlationId`、拒绝 stale turn、typed ACK。
- `server/src/services/native-runtime/runner-prp-coordinator.ts:283`：commit callback 后调 `nativeStore.appendEvent`、runtime request 投影和 terminal reconciliation。
- `native-run-coordinator-store.ts:198`、`paperclip-control-plane-port.ts:181`：source/run/session 绑定、重复事件/游标检查及持久化；不能凭未落盘 event 判断接管成功。

### 4.4 事件、运行投影和页面

- `heartbeat.ts:13665/13718` `appendRunEvent`：持久化后广播 `heartbeat.run.event`。`22872` runtime touch、`22890` live log；日志接收与工具/模型语义进展分开。
- `server/src/services/heartbeat-run-runtime-status.ts:4/22`：runtime status 是进程内 Map，TTL 90 秒；过期返回 null，不表示 run 已停。
- `server/src/services/execution-status-delivery.ts:7/47`：terminal status 的 at-least-once 广播只使 cache 失效，不授予执行权。
- `server/src/services/execution-projection.ts:46/153`：批量 DB facts 生成 execution projection；`223` finishing，`234` subscription/workspace wait，`244` retry/reconnecting，`277` succeeded/pending interaction，`291` running confirmation。
- `ui/src/context/LiveUpdatesProvider.tsx:1265/1362/1666`：activity/run 生命周期更新与 cache invalidation；`1951` 重连后重新获取 active query。WebSocket 连通不等于 provider 已接收消息。
- `ui/src/pages/IssueDetail.tsx:1667`：durable activity 决定 steer causal placement；`1708` 本地已成功响应的 placement；`2129` 手动 steer callback；`2060` conflict 刷新并 rethrow。
- `ui/src/components/task-chat/TaskChatQueuedMessages.tsx:319/325/347`：请求中临时隐藏选中 row；失败恢复并显示 `Couldn’t steer. Message is still queued.`；这条文案仍不能细分 busy、unsupported、uncertain、stale。
- `ui/src/lib/run-execution-status.ts:22/26` 和 `TaskChatRunnerTurn.tsx:86/115`：queued 是等待；无 execution projection 的 running 当前会落入 Working；Waiting to start 来自 queued，不是 provider 的状态报告。

## 5. provider 能力矩阵：必须按真实路径说明

| 路径 | 当前能力来源 | 可以说什么 | 无能力时怎么办 |
| --- | --- | --- | --- |
| `codex_local` / `claude_local`，ACP engine | 现有活动 ACP 握手 `_meta.steering.supported`、turn active、tool boundary、`_session/steering` injected | 原回合已确认插入；只有本次 ACK 才成立 | 留在既有 queue，自然结束后采用；状态说明具体 reason |
| 同 adapters 的 explicit CLI engine | 没有上述 live steering 控制 | 已保存/等待下一回合 | 正常边界继续，不临时切 ACP |
| Paperclip runner，Codex app-server driver | `codex-app-server-driver-impl.ts:142` steering capability；`turn/steer` + expectedTurnId、typed ACK | 已确认插入指定 native turn | unsupported/stale 时回到真实 queue boundary |
| Paperclip runner，acpx driver | `drivers/acpx/driver-profile.ts:43/54` 当前 `steering:false`/unsupported | 该 driver 当前不支持 | 不把 direct ACP adapter 修复外推为此路径支持 |
| OpenCode server driver | `drivers/opencode/opencode-server-driver.ts:145/156` `steering:false` | 不支持同回合插入 | 下回合继续；不叠加 prompt |
| process/HTTP/外部插件 | 必须有准确 adapter contract 和 ACK，不以 transport 2xx 推断 | HTTP 2xx 至多请求 accepted | durable queue + callback/后继 evidence；未实现时如实说明 |
| conversation/chat-inbound、interaction response | 原有顺序/身份/source/session 契约 | 有意保留边界或独立 typed continuation | 不强行并入 ordinary live handoff |

普通 native Agent/system comment 不能自动认定拥有运行中 steering：当前 `enqueueWakeup` 的 deferred 后置只调 legacy steering；native 手动路径还受身份 broker 的 authenticated author 约束。若补自动 native 交接，必须保留原 responsible user，只提供任务上下文，不能把 Agent/system 伪装成用户以激活新凭据。这个能力差异是源码已核；生产是否使用该路径需按准确 run 验证。

## 6. 已确认限制、可直接改善点与待验证风险

### 6.1 源码已核的限制

| 编号 | 问题与证据 | 优先级/最小行动 |
| --- | --- | --- |
| H-01 | legacy 外部 send 在 issue/run/wake 锁事务内，最多等 8 秒；同 issue 的编辑、停止、其他确认会争锁。native 手动路径也持 run/queue 锁等待 ACK | P1；先加入锁争用回归，再分领取/发送/确认，保留原所有权 fence |
| H-02 | ACP Promise.race timeout 后只存 uncertain；迟到 send injected 没有补偿回调。native 已有 late ACK identity callback | P1；同一个 send promise 挂精确 generation/digest 的 settlement，不重发。重启窗口再用 durable receipt处理 |
| H-03 | ACP correlation 去重是进程内 Map，provider `_session/steering` 请求没有相应 ID，DB 在外部发送前没有单独持久化 dispatch intent | P1；进程崩溃后不能保证 exactly-once。先固化 intent，未知结果拒绝自动重发，后继保留结果不确定性 |
| H-04 | `projectExecution` legacy running 用 `process.kill(pid,0)`；不验证 process-start/controller lease/远端归属，lastConfirmedActivityAt 甚至可来自 startedAt | P1 状态真实性；接入已有 lease/process identity。仅证明 owned process 存活时显示“执行中，最近进展未确认” |
| H-05 | `isRunWorking` 对 `running && !execution` 返回 true；旧接口/失效数据可兜底成 Working。runtime status Map 重启丢失、90秒过期 | P1；缺投影返回 confirming/stale，保留 running 事实；重连获取 durable facts |
| H-06 | legacy 手动 Steer 成功时 service 与 route 各写一条 `issue.queued_comment_steered`；route 不标 duplicate。`IssueDetail` 循环 set 同 comment placement，使后出现的 activity 覆盖前者 | P2；第13节已隔离真实复现并提交最小修复，待Root审查/集成；UI历史重复receipt去重仍需另行验收 |
| H-07 | 通用失败文案混合 busy/unsupported/uncertain/stale；无法说明真正采用时间 | P2；复用 narrow reason code，用户看自然语言原因和自动后继路径 |
| H-08 | ordinary comment 没有直接复用 conversation 的 durable commit-to-enqueue outbox；源码 comment 后存在 best-effort wake/re-fetch | P1 待具体窗口验证；先杀点复现通知是否靠现有周期恢复，再补同一 scheduler 对应的窄 outbox |
| H-09 | retry claim helper 按 `createdAt/id` 重排 live comment IDs，而普通 queued-comments 可保存用户 reorder 顺序 | P2 待产品确认；自然边界和 retry 应采用同一 canonical queue order，不无声恢复创建顺序 |

H-01/H-02/H-03/H-04/H-05 是实现能力/证据缺口，不能据此声称每个当前 run 已出错。H-06 的重复 activity 已在隔离真实路由和数据库复现并修复；页面究竟发生多少位移仍需 isolated browser 验证。H-08/H-09 当前未做杀点/重排场景实验，不能报告为已复现消息丢失。

### 6.2 仍需独立场景验证

- 外部 provider 已注入，DB 在 commit 前崩溃：是否在恢复时重复采用、遗漏或留 unknown；需要 fixture 精确输出和请求计数，单看 queue 清空无效。
- 8秒后迟到 ACK 与用户编辑/删除/改 assignee/Stop 交错：迟到 receipt 只属原内容与原 turn；不能复活新内容或回写 stopped issue。
- 接管时进程 PID 被复用，或 controller 服务在另一容器：UI 不应显示虚假 Working；禁止给数值 PID 发停止信号。
- native late ACK 已使 identity accepted，但 queue/result/activity 更新尚未发生：UI 能否自动收敛，是否一直看似 queued。
- 工具 receipt 缺失/终态不规范使 busy 无法解除：状态说明 safe-boundary 未确认，不能抹掉 tools Set 或强制 cancel。
- 多条 queue 中前一条 uncertain 阻挡后一条：是否仍有合法自然回合投递路径；不允许后续 input 默认等待无期限。
- 断线时 missed ACK、activity重复、run terminal 与 issue closed 不同顺序：刷新后单一事实收敛。
- 业务 Agent 发交接给 native task：不进行 authenticated-user elevation，正常边界能完整采用。

## 7. accepted、delivered、applied 的准确含义

不要把这些词混成一个 status；前端只呈现用户需要的四种结果，详细时间放消息详情。

| 事实 | 最低证据 | 不能推出的结论 |
| --- | --- | --- |
| accepted/saved | 原 comment 在同 company/issue durable commit；可找回 ID、原文、作者和 client request receipt | 已入队、已进入 model、已执行要求 |
| queued | 既有 wake/queued run 持有该 canonical comment ID；没有被删/过期/越权 | provider 已收到 |
| dispatched | 固化目标、内容 hash、generation 后外部请求真正发出 | ACK、应用或完成 |
| delivered/injected | 指定 run/turn 的真实 provider ACK，和持久化 delivery fact 绑定；next-turn 则在 prompt 边界确认 context 采用 | Agent 已按要求作出后续动作 |
| applied/observed effect | ACK 之后同 run/合法 successor 有明确相关回复/工具/产物变化，或测试的 nonce 工件真实出现 | 整个 issue 验收完成；自然语言自报不能单独证明外部效果 |
| run succeeded | 此次运行按 adapter/native 终态返回并结算 | issue done、所有子任务完成、产物被用户验收 |
| issue done | 现有 task disposition/status arbitration 接受当前 owner 的合法完成，约束/依赖及显式 workflow 检查通过 | provider 活动进程已排空、外部部署已完成 |

“applied”是可观察的辅助事实，不作为普通交接的审批前置条件，也不要求每条消息让 Agent 写一份 ACK 报告。用户发送“补充这个要求”后，正常接收、继续工作即可；平台自动保存相关事实。

`decideSuccessfulRunHandoff` 位于 `server/src/services/recovery/successful-run-handoff.ts:462`：succeeded 之后若仍 in_progress 且没有真实 live/wait/recovery path，可做有界 disposition repair；native semantic finalization、conversation、review、monitor 等已有 owner 分支不应重复干预。`doc/SPEC-implementation.md:1687` 明确低风险 structured done 不因缺独立证据自动要求人工批准。

## 8. 最小状态机、唯一标识和边界策略

### 8.1 消息事实旁表：一个小记录，不是新调度器

优先采用 content-free `issue_comment_deliveries` sidecar；设计参照已有 `issue_question_response_deliveries`，保留 interaction 自身模型，避免混表破坏既有 source 契约。它只描述一次已保存 comment 版本的投递，wake-queue 仍拥有排队和 next run。

```ts
export type CommentDeliveryState =
  | "pending"
  | "dispatching"
  | "acknowledged"
  | "uncertain"
  | "superseded"
  | "cancelled";

export type CommentDeliveryMode = "in_turn" | "next_turn";
export type CommentDeliveryWaitReason =
  | "tool_in_progress"
  | "provider_unsupported"
  | "no_active_turn"
  | "provider_reconnecting"
  | "paused"
  | "budget_blocked"
  | "ownership_changed"
  | "acknowledgement_unknown";

export interface CommentDeliveryRecord {
  id: string;
  companyId: string;
  issueId: string;
  commentId: string | null;
  commentUpdatedAt: string;
  payloadSha256: string;
  sessionGeneration: number;
  queueId: string | null;
  sourceRunId: string | null;
  targetRunId: string | null;
  targetTurnId: string | null;
  correlationId: string;
  state: CommentDeliveryState;
  mode: CommentDeliveryMode | null;
  claimGeneration: number;
  controllerBootId: string | null;
  claimedAt: string | null;
  providerAcknowledgedAt: string | null;
  observedEffectEventId: string | null;
  waitReason: CommentDeliveryWaitReason | null;
  version: number;
}
```

内容仍只有 comment；旁表不复制 prompt、工具结果或凭据。hash 使用被冻结的原文、原作者引用、issue、session generation；`commentUpdatedAt` 只是对齐辅助，不能仅依靠同毫秒 timestamp 识别内容。SQL unique 至少覆盖 `(company_id,issue_id,comment_id,payload_sha256,session_generation)`，correlation 唯一覆盖真实 delivery；company/issue/run foreign key 不能只各自存在而跨 owner 拼接。

状态转换：

```text
pending -> dispatching -> acknowledged
pending -> superseded / cancelled
dispatching -> uncertain   (失去确认，不能推断未发送)
dispatching -> pending     (有明确未发送/拒绝证据)
uncertain -> acknowledged  (同 hash、generation、目标的迟到/回放 receipt)
uncertain -> pending       (已证实原投递未发生，且目标重新有效)
```

不把 timer 到期自动变 pending；不把 lease 过期当 provider 未收消息。原 run/turn 终止后可给自然 successor 采用同 comment 的新投递事实，保留原 uncertain，沿 successor lineage 对齐，并明确“前次送达未确认，继续处理保存要求，不重放历史工具”。

### 8.2 幂等、过期、合并和优先级

- **唯一交接标识：** delivery UUID 对应一个冻结 comment 版本与 session generation；`commentId`保留原来源，不用 mutable queue revision 充 provider idempotency。provider correlation若协议未支持，只能实现本控制面去重，文档不能宣称 provider exactly-once。
- **编辑：** pending 可编辑，旧版本 superseded、新版本 pending；dispatching/uncertain 不准静默改掉已可能发出的内容，保留原版本诊断，新内容作为明确新补充。已实际采用的评论编辑不反向改 provider 历史。
- **撤回：** 未发出的 pending 在既有 cancel/discard 路径取消；已发出时说明“已送达，撤回不保证取消执行”，不删除 receipt、不伪造 provider 撤回。
- **过期：** 普通用户/Agent要求默认不因时间自动失效。系统状态通知可绑定 issue status_version、source event、assignee/session generation；证明已 superseded 后才不再投递并留下原因，原评论历史保留。
- **coalescing：** 合并 wake，保留有序 comment ID 集合；不覆盖文本、作者和 causal receipt。互动回答、chat-inbound、/new 与身份 continuation 维持既有独立 contract。重复系统通知按同 source identity 合并，禁止凭文字相似删除要求。
- **顺序：** canonical queue order 是真值，用户 reorder 的版本在 retry、自然边界和 live delivery 一致；同 scope的多 writer 在原 issue 锁下更新 revision。
- **优先级：** 使用已有 issue优先级/queue scheduling。Stop、Pause等 trusted control保持已有独立 API；仅服务器结构化 control source可获得优先级，评论“紧急/立即取消训练”不会变控制指令。ordinary handoff不抢占工具；等待有界的可观察 safe boundary，并由真实 owner决定下一步。

### 8.3 不支持运行中插入的真实替代策略

1. 保存原消息、合并现有 deferred wake，显示“已保存，当前工具/回合结束后继续”。
2. 在自然结束、工具安全边界、capability ready、provider reconnect以及已有 scheduler tick重新评估；不额外周期创建付费心跳。
3. 能力支持且安全时自动发入当前 turn；不支持时，由原 queue 正常生成/合并合法 successor，保留完整消息和已有工件。
4. 长工具仍运行时保留 pending，显示正在执行的工具与最后可核进展；不用“等待消息”掩盖仍在工作，也不用“Working”掩盖待控制。
5. uncertain 首选等待迟到 ACK/持久事件收敛与自然回合结束；现有 Interrupt只作为用户明确选择的恢复动作，需 provider stopped/action outcome admission。不得自动 Interrupt 来改善表面延迟。
6. paused、budget、依赖、权限、changed assignee 使用既有 gates和恢复路径。新的业务拥有者可以收到保存要求，但不能重播旧工具或继承未经授权的身份。

## 9. 运行和页面状态必须有来源及不确定性

保留 DB run lifecycle与业务 issue lifecycle，再增加 execution evidence 的展示投影；不要让同一个 `live` boolean表达排队、provider activity、WebSocket连接、业务未结束四件事。

| 展示状态 | 权威来源/最低事实 | 用户所需说明 | 禁止推断 |
| --- | --- | --- | --- |
| waiting/queued | queued run/wake、合法owner；capacity/依赖 wait reason | 为什么等待、谁会继续、已保存消息数 | 算作正在模型推理 |
| preparing | running已claim、execution_stage=provisioning/startup、lease属于当前controller | 准备工作区/连接provider；provider尚未开始 | 显示实际工具执行中 |
| running | controller与provider归属已验证；活动turn/owned tool事实 | 当前工作与最后确认时间，工具有进度则显示 | 每秒转圈等于有进展 |
| awaiting_control | structured runtime request/权限/问答wait有明确owner/action | 正在等待连接、答案或已配置审批；只显示真实既有要求 | 所有交接都要审批 |
| retry | persisted scheduled_retry/recovery lineage，due time和attempt语义一致 | 重试原因、下一检查时刻、保存上下文 | 下一执行已开始；schedule触发等于成功 |
| blocked | durable pause/budget/dependency/recovery gate | 具体阻塞与下一action owner | 为“无日志”自动改blocked |
| stale/confirming | 最近观察过期、ownership uncertain、重连未完成 | 状态待确认、上次可核事实与时间 | 自动cancel/启动第二个run |
| finishing | result持久化、assessment/arbitration/workspace sync尚未结算 | 正在收尾；结果与任务状态分开 | issue已完成 |
| terminal | run终态已commit；provider stopped/unknown单独显示 | 此次成功、失败、取消；issue当前状态与后继单列 | run succeeded自动等于issue done |

建议新增 optional `observation`字段，而非一次改DB status enum：

```ts
export interface ExecutionObservation {
  state: "preparing" | "running" | "awaiting_control" | "stale";
  evidence: "controller_lease" | "provider_turn" | "owned_tool" | "runtime_request" | "none";
  observedAt: string | null;
  lastProgressAt: string | null;
  cause: string | null;
}
```

terminal/wait/retry/block仍使用现有 `ExecutionProjection`；新 observation用于诚实补充细分。legacy/process若只能证实 owned process alive，明确“执行存在，进展待确认”；不让客户端时间计数器刷新 `lastProgressAt`。90秒runtime status过期只降观察可信度，长工具的owned execution继续保留。已经存在的一小时/四小时输出静默UI signal维持 informational规则。

## 10. 可直接实施的阶段任务与接口

每项可单独评审/回滚。先修本次可定位的最小问题，再逐步固化崩溃恢复；不要把所有状态字段先铺满才开始交接。

### H0：冻结证据与复现矩阵（接手当天）

**文件：** 修改本文验收记录；测试新增 `server/src/services/live-adapter-steering.test.ts`（隔离 fixture/DB），其余使用现有 test helpers；不写 live数据库。

**输入：** 本文定位、审计HEAD、running build；**输出：** 每个缺陷的最小 RED、准确run/turn/nonce、匿名化trace，当前已经通过的129项不得漏报。

- [ ] 只读重核 `git status/rev-parse`、health version、queue API合同；不 dump env、config或认证数据。
- [ ] 注入 controllable send Promise，先证明 timeout 后迟到 injected仍留uncertain；不要改 timeout来使测试pass。
- [ ] 故障点分别位于发送前、provider effect后、ACK前、DB commit后和publication前；每个记录send次数和DB事实。
- [ ] 复现 legacy manual重复activity及retry reorder，确认UI实际影响后再定severity。

### H1：小范围状态与文案真实性（无需新调度器）

**修改：** `packages/shared/src/types/execution-projection.ts`、`server/src/services/execution-projection.ts`、`ui/src/lib/run-execution-status.ts`、`TaskChatRunnerTurn.tsx`、`TaskChatQueuedMessages.tsx`、`LiveUpdatesProvider.tsx`；测试在既有对应测试文件新增。

**接口：** 输出 optional `ExecutionObservation`；旧 API客户保留existing phase；`runActivityLabel`缺projection时返回“Confirming execution”。失败文案消费现有ApiError code，不依赖自由文本解析。

- [ ] RED：`running + missing projection`显示confirming；fake/reused numeric PID不生成confirmed-running；queued UI不会显示Thinking。
- [ ] 将preparing/awaiting_control/stale来源接到已有execution stage、lease、runtime request；仅实际facts生成，不从UI文案反推。
- [ ] 按 code区分 tool boundary、unsupported、unknown ACK、stale revision；unknown不提供会重复发送的Steer按钮，保留自然结束入口。
- [ ] 减少重复 causal activity：service拥有delivery事实，route写request diagnostic或`duplicate:true`；UI earliest unique delivery receipt决定一次位置。
- [ ] 跑UI专项和token gates；isolated浏览器证实消息自然出现、失败回队列、重连收敛。

### H2：ACP迟到ACK的最小补偿

**修改：** `server/src/services/live-adapter-steering.ts`、`queued-steering-result.ts`；测试 `live-adapter-steering.test.ts`、`issue-queued-comments-routes.test.ts`。

**接口：** `reconcileLegacySteeringAcknowledgement(db, input: {runId:string; queueId:string; commentId:string; payloadSha256:string; claimGeneration:number}): Promise<"settled"|"stale">`。来源为原发送promise，永远不调用第二次`send`。

- [ ] RED：8秒deadline先返回unknown，原send后来resolve；现有DB状态不能变ACK，证明当前缺口。
- [ ] 同promise附迟到settlement，短事务重核owner/原hash/原generation；保持原run终态，只写其delivery事实。
- [ ] late ACK与编辑、Stop、reassignment交错时返回stale或记录原版本receipt；不变新内容状态、不唤醒旧owner。
- [ ] 只在安全确认后清对应pending IDs并commit活动；未知错误保存现有redaction摘要；测试断线恢复而不是吞掉promise rejection。

H2解决当前进程活着的迟到确认；硬崩溃依赖H3，不能提前宣称全故障exactly-once。

### H3：固化投递intent与短事务领取/确认

**创建：** `packages/db/src/schema/issue_comment_deliveries.ts`、生成的migration、`server/src/services/comment-delivery-records.ts`；修改db schema exports、shared issue types、legacy delivery service、native route；测试同名service/migration和queued route。

**接口：** H3定义下面三个操作，H4使用它们；它们无权创建独立run。

```ts
export interface ClaimedCommentDelivery {
  record: CommentDeliveryRecord;
  text: string;
  expectedQueueRevision: string;
}
export interface ProviderDeliveryReceipt {
  deliveryId: string;
  claimGeneration: number;
  targetRunId: string;
  targetTurnId: string | null;
  payloadSha256: string;
  outcome: "injected" | "context_adopted" | "not_sent" | "unknown";
  providerEventId: string | null;
}
export declare function claimCommentDelivery(
  db: Db, input: {companyId:string; issueId:string; queueId:string; commentId:string; runId:string; expectedRevision:string}
): Promise<ClaimedCommentDelivery | null>;
export declare function sendCommentDelivery(
  claim: ClaimedCommentDelivery, control: AdapterLiveSteeringControl
): Promise<ProviderDeliveryReceipt>;
export declare function settleCommentDelivery(
  db: Db, receipt: ProviderDeliveryReceipt
): Promise<"settled" | "stale">;
```

`Db`来自`@paperclipai/db`；`AdapterLiveSteeringControl`来自`@paperclipai/adapter-utils`。声明展示接口契约，实现时必须给出完整函数，不能提交空函数或仅return success。

- [ ] 领取短事务：遵守原issue/run/wake锁顺序；验证company/owner/pause/session/canonical正文和queue revision；固化dispatching、generation、controller、hash后commit。
- [ ] 锁外send：发送前再核当前control同一owner且未abort；只传冻结text、delivery correlation，不重建正文或增加provider prompt。
- [ ] 短事务settle：用delivery ID+generation+hash+target条件更新；true ACK原子清queue ID并写一次activity；provider unknown保持uncertain；明确not_sent可pending。
- [ ] 普通comment提交与pending delivery intent同事务。由既有heartbeat周期和capability-ready事件补enqueue/确认，不新增后台scheduler。
- [ ] 两个controller抢同delivery：只能一个成功领取。崩溃后dispatching未知不自动变pending，等待既有恢复classifier按停止/receipt事实决定。
- [ ] migration按indexed keyset分批；不从历史coalesced wake或succeeded run补造injected；历史只有ack记录的可回填ACK、无证据保持unknown。
- [ ] RED/GREEN覆盖跨company FK、idempotency conflict、rollback、late generation、删comment tombstone、停run后的receipt回写范围。

### H4：能力统一、自动native交接与自然边界采用

**修改：** existing `heartbeat.ts`窄hook、`live-adapter-steering.ts`、native-session executor、run-identity、wake-queue；adapter trait/types和现有driver profile按实际能力保持准确。创建小的`server/src/services/comment-delivery-projection.ts`投影叶子。

**输入：** H3领取/确认及现有 capability；**输出：** 当前合法turn delivery或既有next-turn queue采用。身份切换继续由既有native identity broker拥有。

- [ ] 只支持特定driver时注册能力；unsupported不会抛到自动cancel，也不通过“legacy/native”分类猜支持。
- [ ] Agent/system交接冻结原作者，但继承run原responsibleUserId，不调用authenticated-user identity激活来伪装human；权限回归必须先过。
- [ ] 自动native使用现有session.steer与durable PRP ACK，避免copy一套新的provider bridge。
- [ ] ordinary、conversation、interaction response、chat inbound、/new分别走已有owner；有意boundary仍明确可见。
- [ ] next-turn context采用记录在原claim/prompt dispatch边界；wake coalesced仅表示归入queued work，尚不能写delivered。
- [ ] busy/native unsupported/paused/budget/blocked/terminal/assignee changed测试各自自动路径，断言没有新engine、未授权identity或额外cancel。

### H5：queue顺序、supersession和retry一致性

**修改：** `issue-queued-comment-queue.ts`、`retry-comment-queue.ts`、wake-queue context/use-cases；共享queued entry新增optional delivery evidence；UI只消费。

**输入：** canonical IDs+revision+delivery record；**输出：** 不丢/不重复的合法未采用列表与单一canonical顺序。

- [ ] RED：重排两条消息后原run失败，legacyretry prompt保持重排顺序；不依createdAt重新洗牌。
- [ ] 确认过/已删/旧版本消息不会被adopted；uncertain保留明确原效果状态。
- [ ] 新assignee接手保留原user/Agent要求与source stopped lineage；独立interaction/chat actor与source不被融合。
- [ ] 系统通知可因真正status_version/source superseded不再发送；普通要求无自动TTL；不要求用户人工标记。
- [ ] 双标签页edit/reorder/discard/steer冲突只接受expectedRevision，错误刷新authoritative queue，消息原文无损。

### H6：隔离真实浏览器及崩溃/reconnect验收

**创建：** `tests/e2e/comment-handoff-state.spec.ts`、`scripts/smoke/handoff-state-audit.mjs`；扩展现有ACP fixture增加controllable ACK/effect gates，保留原fixture默认行为。native重启使用已有restart fixture，不另造runner。

**接口：** `--base-url`、`--expected-server-version`、`--data-dir`、`--artifacts-dir`；script默认拒绝生产3100或非专用audit实例；创建、取消仅属该isolatedcompany/run；输出匿名化UTF-8 JSON trace、截图、request/effect计数与disposition。真实模型小试单列mode，不默认调用。

- [ ] 浏览器桌面1440×900/手机390×844：提交消息、自动steer、tool busy时保持pending、出现真实ACK后同run继续，不发生历史工具重播。
- [ ] reload、WebSocket disconnect/reconnect、多tab、错乱/重复activity和terminal先到：页面按durable facts收敛，nonce只一次应用。
- [ ] provider effect后ACK前断管、server receipt前硬崩溃、receipt后publication前崩溃、受控hot restart；trace指出accepted/dispatch/effect/ACK/commit各时点。
- [ ] native real-process restart suite使用fake Codex app-server、隔离Postgres和PAPERCLIP_HOME，检查same logical runner/checkpoint和source cursor。
- [ ] 若需要真实provider验收，在新的隔离company里使用已有配置和账号，固定nonce任务“先生成原始工件，交接后生成补充工件”；要求同run/turn或明确successor、实际文件、ACK和无重复外部动作；不借用业务Agent/正在运行的工具，不打印凭据。
- [ ] long silent tool继续工作不被cancel；有真实pause/stop时provider stopped证据、容量归还与nextrun admission都要核。

### H7：灰度、迁移、回滚与可接手交付

**修改：** 本文和`doc/execution-semantics.md`相关段；若接口行为变化，同步SPEC-implementation/DEVELOPING/DATABASE，用户文案不泄露内部generation/epoch。

- [ ] migration只加旁表/索引/optionalAPI fields；无破坏性删除。旧server读原wake/result，不依新sidecar才能恢复。
- [ ] 初期shadow投影，禁止shadow writer投递；用同一delivery ID对照原ACK与新fact，确认差异后启用新writer，任何时间只一个writer有send权。
- [ ] 依次启用一台isolatedinstance、单capableACP fixture、nativefixture，再专用真实provider；不大批启用所有业务Agent。
- [ ] 回滚顺序：停止新claim、等待/保留在途结果、把dispatching转uncertain诊断、确认旧writer不会重发已ACK，恢复原boundary路径；保留旁表历史，不drop schema或重置retrybudget。
- [ ] 接手交付记录基线/patchSHA、runningbuild、已跑commands、测试与browser证据路径、knownunknown、哪些仍未做；Root亲自查看关键浏览器流程和trace后才称平台验收。

## 11. 最小测试代码、运行脚本策略与验收标准

以下为H3接口落地后的精确核心断言；DB/queue seed复用`issue-queued-comments-routes.test.ts`的temporaryPostgres helper，fake control复用`createAdapterExecutionControl`。新增helper须在测试文件明确实现并销毁，不连接默认instanceDB。

```ts
it("never sends the same uncertain delivery a second time", async () => {
  const original = await claimCommentDelivery(db, input);
  expect(original).not.toBeNull();
  const outcome = await sendCommentDelivery(original!, {
    state: async () => ({ supported: true, active: true, busy: false }),
    send: async () => { throw new Error("fixture: ACK connection lost"); },
  });
  expect(outcome.outcome).toBe("unknown");
  expect(await settleCommentDelivery(db, outcome)).toBe("settled");
  expect(await claimCommentDelivery(db, input)).toBeNull();
});
```

同文件必须增加：“两个claim竞争只有一个send”；“late ACK generation不匹配返回stale”；“effect已发生的unknown下回合保留历史，不重放tool”；“received nonce ACK后实际工件只有一个”；“stop/reassign先到时receipt不复活owner”。这些测试不能只镜像setter逻辑，要检查独立provider request/effect计数和durablequeue。

现有真实stdio fixture位置：`scripts/mcp-fixtures/servers/acp-live-steering-agent.mjs`。它宣告steering、保持原promptpending、记录requests.jsonl、回injected、输出received并写continued文件；目前ACK即刻，需H6扩展可控`effect gate`与`ack gate`，不通过固定sleep猜竞态。

只读探针策略：script仅读取health、已授权的run/queue/events API，构建事件时间线；字段allowlist含时间、anonymous issue/run aliases、state/reason、counts、noncehash。禁止dumpheaders、配置env、usersecretbindings或完整生产prompt。poll有界并保存未达条件，不延长timeout伪装恢复。

验收同时满足：

1. **有效消息完整：** 原作者/正文/hash/版本保存；无silent drop；edited/deleted/superseded有准确原因。
2. **真正投递：** 同turn providerACK或明确nextturn prompt采用；HTTP202、bubble出现、queueempty均不能单独通过。
3. **真正工作：** nonce要求对后续output/tool/artifact有独立观察证据；原run工件保留，旧工具不重播。
4. **故障收敛：** crash/reconnect/lateACK最终保留准确ACK或unknown、单一合法执行owner；恢复不创建竞争provider。
5. **状态诚实：** waiting/preparing/awaiting_control/retry/stale不显示Working；terminal与issuedone分开；长工具未因无output被停。
6. **低摩擦：**普通交接自动推进；不新增人工审批、逐消息标记或强制ACK写作。

## 12. 本次实际验证、未运行范围和接手第一步

### 已执行

```bash
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/mnt/c/Users/dains/AppData/Roaming/npm:/usr/local/bin:/usr/bin:/bin pnpm exec vitest run packages/adapter-utils/src/acpx-engine/live-steering.test.ts server/src/__tests__/issue-queued-comments-routes.test.ts server/src/services/execution-projection.test.ts server/src/services/issue-queued-comment-queue.test.ts ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx ui/src/lib/issue-queued-comment-queue.test.ts ui/src/lib/interrupt-handoff.test.ts --maxWorkers=1 --no-file-parallelism
```

结果：**7个测试文件、129项测试全部通过，80.87秒**。真实stdioACP fixture、临时PostgreSQL路由、executionprojection和UIqueue/interrupt逻辑得到本次证据；未出现skip。Vite输出一条configLoader/native将来默认值与`__dirname`兼容警告，不影响本次结果。

另外已执行：UTF-8源码/约束文档定向读取；Gitstatus/HEAD/log/version差异；上述health只读JSONallowlist。`e7761ba11`与`ce97b8e8f`的runtime代码差异为零。本次没有再次执行文档记录的181项或58项历史总量。

### 本次未执行

- 新H-01/H-02/H-03杀点和lateACK RED用例：本次只写审计，接手从H0开始。
- isolated真实浏览器与mobile/desktop验收、硬崩溃/重连、native real-processrestartsuite。
- 真实Codex/Claude模型同回合小试；历史smoke不等于本次新验收。
- fullsuite、repo-wide typecheck/build/token gates；没有runtime/UI代码修改，不用这些替代真实流程验收。
- productionqueue恢复、业务消息retry/interrupt、配置更新、热部署；这些动作没有发生。

**接手第一步：** 只读冻结新的磁盘HEAD和healthbuild，保留既有service；使用临时DB与受控sendpromise复现ACP迟到ACK，然后按H2做最小补偿。H1状态真实性可以由独立writer并行，但只有Root已安排并行时才开展；双方不得同时修改`heartbeat.ts`、`issues.ts`或sharedtypes。获得RED/GREEN与隔离browser证据后，再推进H3/H4的统一投递事实，不能凭129项既有回归或一条健康API宣称全部交接完成。

## 13. 本轮经 Root 授权已落地的最小隔离修复

**提交：** `86b627edd`，`fix(chat): emit one legacy steering completion`。

**基线：** `ce97b8e8f`。工作树 `/home/dains/Documents/paperclip/.claude/worktrees/handoff-steer-once-20261004`，分支 `fix/handoff-steer-once-20261004`。本节记录补丁证据，不表示已经进入主树或加载到正式服务；由 Root 审查、测试和集成。

修改四个文件：

- `server/src/services/live-adapter-steering.ts`：增加内部 typed `activityActor`，只在原 injected/queue/result 事务中写一条完成事件；自动交接维持 system actor，手动交接保留已授权 board 操作人，原作者继续保存在 canonical comment 与 handoff text。
- `server/src/routes/issues.ts`：把来自 `getActorInfo` 的 server actor 交给 service，去掉事务后第二次 `issue.queued_comment_steered`；未接受 request body 的 actor，未改变既有 access 判断。
- `server/src/__tests__/issue-queued-comments-routes.test.ts`：新增真实 Express route、真实 `deliverLegacySteering` 与临时 PostgreSQL 回归；只有 provider send 用可控 injected fixture。核一次 durable completion、一次 live publication、发布时 queue 已提交、board actor、不同原作者、相同请求 replay 不增事件；native 原测试增加精确一条完成事件断言。
- `doc/plans/2026-10-04-steering-completion-event.md`：先记录架构和验证，再记录本次结果。

证据时间顺序：

1. 干净隔离基线原 legacy happy path：1项通过，57项按筛选未运行。
2. 新 RED 在真实 route+service+临时DB失败：`expected length 1, got 2`。这证实两条是同名完成事件，没有靠 mock service 制造证据。
3. 最小源码补丁后，新测试的中途失败源于把已被既有 redaction 清理的 `originalAuthor*` activity 字段当作明文预期。随后改为核 canonical comment row 和实际发送文本，未修改任何 redaction policy。中途失败没有隐藏，也没有误计为完成。
4. 最终 GREEN：下面5文件 **88项全部通过，76.08秒**。这是补丁的新验证；与主树修前7文件129项区分。
5. `pnpm --filter @paperclipai/server exec tsc --noEmit`、`git diff --check` 通过。类型检查只做noEmit，不调用会重建共享生产依赖的prepare/build脚本。

最终新回归命令：

```bash
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/mnt/c/Users/dains/AppData/Roaming/npm:/usr/local/bin:/usr/bin:/bin pnpm exec vitest run server/src/__tests__/issue-queued-comments-routes.test.ts server/src/services/issue-queued-comment-queue.test.ts packages/adapter-utils/src/acpx-engine/live-steering.test.ts ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx ui/src/lib/issue-queued-comment-queue.test.ts --maxWorkers=1 --no-file-parallelism
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/mnt/c/Users/dains/AppData/Roaming/npm:/usr/local/bin:/usr/bin:/bin pnpm --filter @paperclipai/server exec tsc --noEmit
```

本小修未跑真实模型、隔离真实浏览器或fullsuite，未部署、未停/重启正式服务、未写生产DB、未给业务Agent发送消息。它解决新产生的重复完成事件，不处理历史重复activity、ACP迟到ACK硬崩溃、native自动Agent交接或整体状态真实性；这些仍按本文H0–H7推进。

**Root 后续集成回执：** 已完整审查上述补丁，cherry-pick 到 main 为 `5adf49a3c`。主目录以独立 PAPERCLIP_HOME/config、临时PG复跑路由和queue helper：2文件67项通过，68.09秒；server typecheck退出0。后者包含prepare runner/vendor/plugin与构建依赖，不是全monorepo build。小修仍未主动部署，loaded版本以新的health为准。此回执补充隔离提交之后的状态，不改写129/88项的原始测试范围。
