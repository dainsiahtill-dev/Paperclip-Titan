# 正在执行的本地 Agent 自动接收交接

## 已核根因

SOU-231和171的交接仍为legacy/deferred/steering unsupported。此前修复仅承接重试边界。实际已安装Codex ACP 1.6.2、Claude ACP 0.73.0都实现并宣告 `_session/steering`；acpx/runtime 0.12虽声明prompt/steer模式，其startTurn始终调用普通prompt，且没有暴露运行中steering。Paperclip原路由又只接native steering，自动评论未送入legacy活动回合。

## 实施边界

1. 在既有acpx补丁中暴露当前活动客户端的steering及握手能力，调用 `_session/steering` 的promptRequired空闲策略。禁止借startTurn再次开会话、伪造能力或调用cancel代替steer。保留原文、关联ID、运行事件和累计计费。
2. adapter只在活动回合注册可用控制，并在结束/取消时卸载。server复用当前run/company/issue/assignee权限、队列版本和已投递记录；只有真实injected确认才移出队列。空闲或不支持保留后续回合投递；未知结果不盲目重复发送。
3. 自动交接在有能力的现有回合投递，不靠用户点Interrupt。保留用户/Agent原作者，多个评论按时间顺序处理，停止/暂停/预算、独立交互、跨任务边界保持。
4. UI基于实际可用能力显示Steer/等待；不以legacy标签永久拒绝已有能力。运行环境仍使用既有CLI账号和CC-Switch，不改变模型及GPU配置。

## 验证与发布

正式实例启用 ACP 时仍使用已有模型、思考等级、权限和账号。Codex ACP 指向本机已安装的 Codex CLI（配置 env.CODEX_PATH），避免其旧内置 CLI 不识别 gpt-6.1-sol；Claude 继续读取现有 CC-Switch 配置。备用模型继承显式 ACP 选择，不强制退回 CLI。交接确认记录在结束时按数据库当前值原子保留，避免收尾覆盖。部署目标始终为 ~/Documents/paperclip 的 main。

既有 Claude dangerouslySkipPermissions 和 Codex 全访问设置显式映射到对应 ACP session mode（bypassPermissions / agent-full-access），不将这些设置误解为只批准 ACP 权限弹窗。保留现有用户 MCP 设置。

先做能重现当前缺口的临时数据库和真实ACP通道回归，确认同一回合收到标记并继续工作、没有新provider/取消/重复执行；覆盖Codex与Claude、空闲/不支持、失败/超时、结束竞态及作者/作用域。实际模型小试必须显示新消息影响同一run的后续输出，仅队列消失不算成功。现有Starwave代码/工件保留，部署在安全边界并复核真实消息。相关类型、adapter/queue/Stop回归充分后提交并同步用户仓库。

### 已完成验证（2026-10-01）

- 181 项相关回归通过：真实 stdio ACP、完整 adapter 注册/工具边界/卸载、队列版本与原作者、重复发送、忙碌/空闲/不支持/停止/暂停/错误、结束记录保留、备用通道、Stop、启动/收尾故障矩阵及 UI。
- Codex gpt-6.1-sol 与 Claude MiniMax-M3.1-Flash-Preview 的真实 SDK 通道、完整 Paperclip adapter 均收到 injected；原任务文件和交接要求文件在同一回合生成。真实模型 smoke 可用 scripts/smoke/acp-live-steering-adapter.mjs 复验，既有账号凭据从本机读取，不进入仓库。
- adapter-utils 构建与类型检查、server 类型检查、UI 构建通过。锁文件仅更新本次 SDK 补丁哈希；未升级无关依赖。
- 空闲或不支持保留后续回合投递。传输错误或超时保留队列并标记 uncertain，不伪造已送达，也不在当前回合盲目重复；暂停和停止保持有效。
