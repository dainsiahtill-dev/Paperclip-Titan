# 自动重试承接待投递交接

## 实际问题

Starwave SOU-171 的 legacy 重试 7c843d97 已启动，但同任务六条评论仍在 deferred 队列。普通 enqueueWakeup 会合并待投递评论，scheduleBoundedRetryForRun 直接创建重试，绕过该合并。当前 continuation 含更新不等于队列已正式承接；旧 wakeCommentIds 仍只绑定两条较早评论。

## 最窄修改

在 legacy 任务重试正式 claim 时，利用已有 issue→wake→run 锁，承接同公司、同任务、同 Agent 的普通 deferred comment wakes。重用现有 comment ID 上下文构建、投递门和容量规则。零旧 comment ID 的重试也进入该 claim 路径。原评论/作者不改；旧 wake 合并到实际重试，不再额外触发回合。

独立 helper 负责挑选、按原评论时间排序及持久合并；heartbeat 只接入 claim。conversation、native、chat-inbound 和 interaction 续接继续自身路径。不将自动交接变成人类授权，不自动打断正在执行的工具或 GPU 作业，不对消息正文做猜测式摘要/删改。

## 数据流与边界

暂停、预算、依赖和恢复门检查仍先执行。claim 事务中重新核对所有权和 live comments，更新重试 wake、重试 context、被承接 wakes。复用现有上下文函数清除旧缓存，让 adapter 实际收到新评论正文。事务失败整体回滚，未投递内容仍保留。

旧协议运行中不能直接 steering；新代码解决回合边界/重试边界的积压，不虚称支持模型中途注入。当前正在运行的 Starwave 工程继续，部署在安全边界进行。

## 验证

真实临时 PostgreSQL：失败任务排队评论，自动重试创建/晋级/执行；分别验证旧评论集合为空和非空，自动 Agent 评论到达 adapter 输入且历史作者不变，独立 interaction wake 未被承接。先观察原代码失败，再实现、跑相关队列和重试回归及类型检查。部署后读取实际队列状态和真实消息投递，报告未验证部分。

## 已执行结果

- 原代码两种重试都未承接新交接，回归先红；修复后两种均通过，实际 adapter 边界含交接正文、wake归属正确、评论作者保留。
- 三个队列/恢复文件合计335测试通过；随后收紧公司/Agent/原生父运行边界，最终相关10测试再次通过。server直接 `tsc --noEmit` 通过。标准typecheck脚本在其未改动的Rust准备阶段因本次PATH没有cargo而停止，不报完整构建通过。
- 实际截图队列7184331c于08:10Z由既有普通投递路径启动c1266e4e，08:14Z succeeded/completed；六条原ID在该实际run输入中，未被删除或跳过。新修复避免下次重试继续绕过此合并而多等一个回合，不把旧协议说成支持回合中steering。
