# 待确认的真实维护窗口 — 2026-10-06

代码与服务已经交付，当前原目录 hold 已正式准备，尚未实际结束旧内核 epoch。此文件是可审阅的操作包，**不是已经执行宿主重启的记录**。

- 实现提交：5503b61fa；当前 main/远程：3379bec89（后续仅文档提交）。
- 默认服务：3100，加载 2026.916.1+146.git.5503b61fa，原数据库/公司/38员工和模型配置保留。
- 原目录：/home/dains/Documents/polaris，device=2096、inode=244796。
- hold：1afe989c-2798-4b2b-ae50-92f9287224a3；generation：6fae6a43-b1c1-47ca-9fb5-ef91ce2ed645。
- 捕获 boot：cc2434dc-c800-4670-83aa-7e9c96ddc764。
- 最新现场：Ubuntu 正在 WSL2 运行；筛选观测 145 个相关进程，其中 40 个 cwd 位于 Polaris。它们不等于旧后代，不能批量 PID 清理。

## 窗口操作与影响

1. 确认维护窗口。由 Polaris/Starwave 等项目负责人先保存有效任务的持久 checkpoint、未提交工作、当前会话和恢复入口；不删除或重放已验证工作，不擅自重启有效 PM/CE。本 agent 会话也可能中断。
2. 重新核对本机进程与业务运行清单，确认各项目允许退出。Paperclip 已无自动恢复权限的 POL-6 保持 blocked；维护 hold 阻止新托管写入，不改变既有外部进程。
3. 对有明确身份的默认 Paperclip supervisor/API/PostgreSQL做有序停止；制作包含**当前 prepared hold**的最新冷数据库/运行状态备份。之前服务更新冷备份是 pre-hold 数据，不应被当作这一步的新快照；prepared JSON/拒绝证明另存同一保护备份目录。任何回滚不得自动覆盖维护后新有效业务写入。
4. 由已批准的 Windows 宿主操作终止旧 WSL2 内核。Microsoft 的 `wsl --shutdown` 会中断所有运行中的发行版及 WSL2 VM；只重启 Paperclip 不构成旧 epoch 结束证明。此命令在本轮尚未执行。
5. 重新进入 Ubuntu，同一用户与实例，恢复同一数据库数据目录。先保持业务不重试；正常启动 Paperclip后核对真实 boot ID确实不同、实例/dataDir/source inode一致。未变化或不一致则保留hold并停止收口。
6. 使用下方已实现入口执行close；它自行读取内核和连接数据库见证，不接受传入boot/namespace值。核对独立host_boot_epoch_closed审计和hold正式释放，旧run/lease/event保持原样。
7. 检查同一原目录真实派工、受保护写入、公共Stop实际退出和第二派工；逐一恢复各项目此前保存的有效工作，不能用health200代替业务恢复。Paperclip通过后，Polaris按[POL-6交接](2026-10-06-pol6-after-workspace-closure-handoff.md)仅继续尚未完成planner路由。

## 真正boot变化后才执行的命令

在原Paperclip checkout中执行（不改代码落点，不建分支/worktree/副本）：

```sh
rtk proxy /home/dains/.paperclip/runtime/node-v24.21.0/bin/node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-closure.ts close --config /home/dains/.paperclip/instances/default/config.json --company-id 6cd06d96-4e84-4247-9f0a-3858c284ea65 --cwd /home/dains/Documents/polaris --hold-id 1afe989c-2798-4b2b-ae50-92f9287224a3 --generation 6fae6a43-b1c1-47ca-9fb5-ef91ce2ed645
```

同一boot会返回host_epoch_unchanged；输入/记录漂移或实例不符会拒绝，不会强制解锁。没有自动kernel重启、自动POL-6唤醒或旧事件改写。

保护材料：/home/dains/.paperclip/backups/legacy-workspace-closure-20261005T230108Z；完整新验证原件注册在project-library/resources/workspace-busy-20261006/manifest.json。
