# 一次真实 Steer 只发布一次完成事件

## 问题与证据边界

当前 legacy 手动 Steer 通过真实 `deliverLegacySteering` 确認 injected 后，在服务事务中写入 `issue.queued_comment_steered`，路由成功返回前又写同名事件。UI 用该事件确定消息在回合中的位置；第二条事件会变成第二个完成时间。相同已确认请求重试还会再写路由事件。

使用隔离 PostgreSQL、Express issue route 和真实 steering service 复现，只有外部 provider send 用 injected fixture。检查持久化完成事件数、live publication 数、提交后 queue 状态，以及操作人和原消息作者。不能通过 mock 掉 service 再计数来证明修复。

## 最小架构变化

- 服务继续拥有 injected 后的事务、queue/result 更新和完成事件；只在 commit 后发布。
- 手动 route 把已授权的 actor 以类型明确的内部参数交给服务，原作者仍放在原 author 字段及 completion details。该参数不从 request body 接受，不改变权限或运行控制。
- 自动 steering 保留 system actor；幂等 replay 返回既有成功，不产生第二条完成事件。
- native route 保留现有单条完成事件及身份 broker 行为。

## 验证和边界

先观察 RED：第一次请求实际产生两条完成事件。修复后 GREEN：一次 send、一次 durable completion、一次 live publication，发布时准确 comment ID 已从 pending queue 移出；同请求 replay 不新增事件；手动 board actor 和不同原作者均保留。运行现有 queued-comments 路由、queue 和 ACP/UI 专项回归。

本任务不调整 ACK timeout、durable delivery 协议、provider engine、生产服务或业务任务；isolated commit 交 Root 复核和集成。既有 129 项回归是修前证据，不能算作此修复新验收。

## 本次结果

- RED：未 mock 服务的真实路由与临时数据库，一次手动 Steer 实际写入两条完成事件，`expected length 1, got 2`。
- GREEN：5 个测试文件、88 项全部通过，76.08 秒；包含新完成事件、提交后 publication、board actor、不同原作者、幂等 replay、原自动交接、native 完成次数和既有 queue/ACP/UI 回归。
- `pnpm --filter @paperclipai/server exec tsc --noEmit` 通过；`git diff --check` 通过。使用 Node 24.21.0 和 literal PATH，不重建生产依赖。
- 原作者从 canonical comment row 与实际 handoff text 核验；activity 的 `originalAuthor*` 继续服从已有 redaction，不放宽日志清理。
- 没有运行真实模型、真实浏览器或 full suite；没有部署、生产数据库写入、业务 Agent 消息或服务重启。
