# 原目录写入保护升级：证据、治理与收口设计

日期：2026-10-06。责任项目：Paperclip。Polaris 的 planner 路由修复由 Polaris 团队在本治理验收后继续。

**当前结论：正式迁移入口与准入修补已实现，隔离核心和公共 HTTP 场景通过；真实 WSL epoch 收口尚未执行，POL-6 尚未恢复。** 实验室模拟的是旧 boot 观测，实际写入、Stop、再次派工和 namespace 退出使用真实进程。现场仍需批准宿主维护窗口，不能把实验室通过当作生产迁移已经完成。

## 约束与现场

Polaris 的唯一代码落点保持 `/home/dains/Documents/polaris`。不创建分支、worktree 或代码副本；仅使用隔离进程、临时测试目录和输出。不得删除锁、历史运行或停止事件，不得强改运行状态，不得把旧进程组停止事件解释为 namespace 排空。

调查时主线为 `4e710a6047ea00d0091d5736ce0dbcced923a52e`，默认服务加载 `909e9ac55`。POL-6 的首次派工 `c6695cb2-4fcd-4d47-984c-841722b93e6b` 和 POL-2 的后续尝试 `8039c601-8736-42c0-988a-bfd5ce38f57a` 都在 provider 启动前被拒绝，进程 PID 为 null。

数据库没有未释放的新版物理 owner，也没有 local runtime service。阻塞来自同一原目录的两条历史 local lease：

| 旧运行 | 历史结果 | 旧租约结果 | 原始停止证据 |
| --- | --- | --- | --- |
| `8f72065e-8722-469f-9b6b-d21174c73a68` | succeeded | released | `legacy.local_process_stopped`，seq 7 |
| `3f459cc2-6c16-42e9-9c9a-5aae7ab259a9` | timed_out | failed，已有 releasedAt | `legacy.local_process_stopped`，seq 9 |

两条旧身份均与当前 OS/PID namespace 指纹一致；旧父 PID 已不存在。这不足以证明退出：未受 namespace 约束的后代可以建立新 session/process group，继续写同一目录。现有 `reconcileStoppedLegacyLocalLease` 只能整理 local bookkeeping，不提供完整写入生命周期的退出证明；当前两条租约已经有 releasedAt，调用它也不能解决物理准入。

## 本轮实际验证

使用独立临时 PostgreSQL 数据库及空的测试输出目录，没有复制 Polaris 代码或修改默认实例。

| 场景 | 更新后首次派工 | 受保护写入 | 新运行 Stop | 未收口再次派工 |
| --- | --- | --- | --- | --- |
| 旧成功运行，仅有旧停止证明 | 启动前阻塞 | 未准入 | 无新进程，未执行 | 仍阻塞 |
| 旧超时运行，仅有旧停止证明 | 启动前阻塞 | 未准入 | 无新进程，未执行 | 仍阻塞 |
| 旧父进程及原进程组消失，仍有脱离子进程 | 启动前阻塞 | 未准入 | 无新进程，未执行 | 仍阻塞 |

第三行的子进程实际产生了延迟写入。这是旧停止证明不充分的动态反例，不是仅凭模拟状态得出的判断。

另外，一条没有历史占用的新版受保护生命周期作为独立控制：同一个测试目录首次准入、真实写入、Stop 后 namespace 实际排空、阻止延迟写入、正式释放、第二次准入及写入均通过。公共 HTTP cancellation 路由的 single、duplicate、startup、proof_failure、forced、late_result 六个实际 guarded fake-CLI 用例也通过；其余 309 个测试因名称筛选未执行。这些通过项**不能代替三类历史迁移后的完整验收**。

随后已将三类历史场景接入公共 HTTP 生命周期测试：正式收口后通过真实 heartbeat 调度、受保护 fake CLI 写入、公共 HTTP Stop、实际 namespace 排空及释放，再由正式 comment/wakeup 调度在同一目录启动第二次执行，并再次通过公共 HTTP Stop 排空。三个新增场景及六个原有公共 Stop 场景全部通过，309 个其他用例在此定向运行中因名称筛选未执行。真实宿主 boot 变化仍未发生，当前不得宣称生产兼容迁移已经收口。

## 已实现的有限修补

扩展现有本机维护及物理准入流程，增加与 namespace 退出不同的、可审计的 **host boot epoch 结束证明**。不改变正常受保护进程的 Stop 语义，不增加强制解锁接口。

1. **准备记录。** 本机维护入口在同一物理 realm 的事务锁内采集原目录 realpath/device/inode、同一实例和操作主体、实际 machine/OS boot/PID namespace，以及精确历史 run/company/agent/lease/launch 身份和原事件序号。只接受现有记录能证明属于此宿主、此 epoch 的 legacy 运行。客户端不得提供 boot 或 namespace 证明；准备记录本身不授权派工。
2. **维护占用。** 对选定原目录保留持久的迁移 hold，覆盖别名与父子路径。准备后身份、占用或执行证据发生变化必须重新准备。Hold 通过正式状态机收口，保留完整历史；不删除任何 owner。原模型、预算、调度开关、历史运行状态和已验证诊断不随维护改变。
3. **独立证明类别。** 只有本机重新观察到同一宿主的内核 boot ID 确实变化，且准备记录、原目录身份、实例及精确执行选择器仍匹配，才允许追加 host-epoch closure 记录。仅重启 Paperclip、PID 消失、旧 group-stop 记录、租约过期、PID namespace 变化或操作者声明都不成立。绝不写成 `namespace_drained`，也不伪造旧 namespace 身份。
4. **正式准入。** 在事务及物理 realm 锁内再次核对闭合记录，只排除这些已证明旧 epoch 结束的精确 legacy 执行。未选择的历史执行、新执行、identity 漂移、foreign host/company、unknown/native/service 占用仍保留阻塞。准入不能仅凭 run ID 曾出现在 owner 表中就跳过历史检查。
5. **无 replay。** 收口仅恢复物理准入，不自动重试 POL-2/POL-6、不改变历史失败、不重放 provider 动作。恢复业务需要当前授权及检查点，由 Polaris 团队接续。

实现位于 `server/src/services/workspace-write-ownership.ts`、`legacy-workspace-closure.ts`、`legacy-workspace-host.ts`、`workspace-owner-provenance.ts` 与 `scripts/workspace-legacy-closure.ts`。物理身份算法迁至 `workspace-physical-identity.ts`，原导出和算法保持一致。旧 `legacy-process-capacity.ts` 的 group-stop 证据仍保持原强度。

普通 tracked owner 也要求真实进程关联和精确源目录身份，不能仅凭表中出现过 run ID 放行。已经正式记录的精确 namespace 排空/释放证明是持久事实，跨重启仍可使用；不会用当前 boot 的探测结果否定它。旧版 guarded owner 缺少新 `run_process_bound` 记录时，只读核对最新可信 system process-identity 事件、当前 controller/PID/group/start、原观察 namespace 指纹及真实 launch-to-sealed 时间窗口，不修改旧记录，也不生成新 namespace 证明。新的冲突身份事件或源路径漂移会拒绝复用。

宿主见证由当前事务连接的 PostgreSQL 读取真实 `/proc/self/stat`、boot ID 和 postmaster 身份，再与调用者可见的 PID/start ticks、namespace、UID、cwd、可执行文件及 dataDir 相互核对。独立的 cluster/database/dataDir device/inode 绑定防止误用其他实例。Caller 无法提供 boot/namespace 值。

核心迁移/CLI/原写入保护定向验证 28/28 通过，公共 HTTP Stop 与迁移再派工 9/9 通过。采用失败测试后实现；全覆盖与最终审查状态由最终验收记录另行记录。

## 正式入口

以下 inspect 是只读操作，不启动服务或模型。配置必须为当前用户拥有的私有现有 embedded 实例配置；拒绝外部 DATABASE_URL 覆盖及 agent 执行上下文。

```sh
rtk proxy /home/dains/.paperclip/runtime/node-v24.21.0/bin/node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-closure.ts inspect --config /home/dains/.paperclip/instances/default/config.json --company-id 6cd06d96-4e84-4247-9f0a-3858c284ea65 --cwd /home/dains/Documents/polaris
```

`prepare` 使用同样的 config/company/cwd，另传本次 inspect 的 `--expected-digest`；追加迁移 hold，不改变旧 run/lease/事件，也不启动任务。`close` 使用同样的作用域及该 hold 的 `--hold-id`、`--generation`；同一 kernel boot 时明确返回 `host_epoch_unchanged` 并保留 hold。没有 `--force`、`--boot-id` 或 namespace 证明参数。

当前只读 inspect 已识别恰好两条现场旧执行及原目录物理身份，原记录和默认服务未变化。尚未向默认实例应用 prepare/close。

## 维护操作顺序与影响

**这些现场维护步骤尚未执行；须先完成最终全覆盖与审查，提交可审阅的最新 dry-run，再单独批准宿主维护窗口。**

1. 导出精确影响清单、待恢复业务及退出前检查点。最新现场观测选出了 132 个 Paperclip/Polaris/Starwave/相关运行进程，其中 34 个 cwd 位于 Polaris；该计数不表示这些进程都是旧运行后代，不能用于批量结束它们。维护窗口前必须重新核对身份和范围。
2. 为目标 source root 设置正式维护准入 hold，停止新派工；不通过修改保存的 wake/model/budget 配置制造空队列。各项目分别保存其有效工作和恢复入口。不得直接取消、删除或重放有效 PM/CE 任务。
3. 按现有 runbook 停止有明确身份的 Paperclip supervisor/API/embedded PostgreSQL，并在停稳后保存新冷备份、密钥、认证作用域和日志。旧备份不能充当本次维护的新快照。备份属于回退材料，不是新的代码执行落点。
4. 保留包含旧 boot ID 与精确选择器的未授权 closure 准备记录，然后由已批准的宿主维护操作终止旧 WSL 内核。Windows 上 `wsl --shutdown` 会终止所有运行中的发行版及 WSL2 虚拟机；它可能同时中断其他服务、CLI、后台任务、数据库、VS Code 远程会话和当前 agent 会话。[Microsoft WSL shutdown 文档](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#shutdown)
5. 重新进入同一发行版/用户、同一默认实例，先核对 boot ID、machine/realm、原目录 inode 和数据库绑定。Boot 未改变或者实例/身份不符时，继续保留 hold，拒绝闭合。
6. 使用已实现的入口追加独立 epoch closure 审计记录，再正式结束该迁移 hold。保持旧 run、lease、group-stop 及失败事件原样。仅重启宿主而没有这一步，当前版本仍会因历史记录返回 busy。
7. 在同一原目录完成三类迁移验收，再验证现有组织、员工、模型/预算、调度偏好、服务和业务恢复清单。对未恢复项逐一报告，不能用 health 200 代替恢复证明。
8. Paperclip 验收报告通过后，向 Polaris 交接 POL-6 的现存检查点、未完成 planner 路由范围和验收证据。沿用已有诊断修复；不要重做已完成工作或擅自重启有效 PM/CE。

只重启 Paperclip 的影响较小，但不能形成旧 WSL 内核 epoch 已结束的证明。若不能安排上述维护窗口且没有别的受认证完整生命周期证明，保留原目录阻塞，明确报告“未安全收口”，不以换目录代替兼容修复。

## 证据注册

原始现场数据、临时 probe 源、结果、HTTP Stop 日志和进程影响清单保存在 `/home/dains/.paperclip/diagnostics/workspace-busy-20261006`（同用户保护目录）。通过 `project-library/resources/workspace-busy-20261006/manifest.json` 注册原路径与内容哈希，不复制包含业务提示、配置及潜在敏感信息的原始现场数据。

本次探针和实验室迁移验证通过，现场治理待维护窗口。未执行宿主重启、服务重启、清锁、历史运行状态改写、业务模型重试或 Polaris 源码修改。
