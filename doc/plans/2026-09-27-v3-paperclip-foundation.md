# 项目管理后台 v3：Paperclip 独立底座

日期：2026-09-27。用户要求：采用 Paperclip 作为底座，命名 v3，与之前的项目隔离。

## 决策与范围

直接复用已发布上游 `v2026.916.1`，保留 MIT 来源；采用同级独立仓库，不在旧 Vue 仓库上替换或合并。首阶段只准备原版运行底座。UI 改造、中文化、旧数据迁移、像素办公室、自动运行员工、模型配置及业务工作流均不在本次范围。

1. 来源与目录 → 验证 remote/tag/commit、LICENSE、独立 .git 和桌面入口。
2. 运行隔离 → 验证独立 Node 调用、依赖、PAPERCLIP_HOME、实例名、回环 HTTP 端口和数据库实际路径；避免读取旧库或默认全局实例。
3. 原版烟测 → HTTP 健康接口正常、公司列表为空、真实浏览器页面截图；未派发任何 Agent 工作。

## 初次准备时已执行

- 源码浅克隆、固定 tag/commit、本地分支和桌面入口。
- 本地 project-library、来源清单、许可证哈希、工单证据与本说明。
- 本机已存在 Node 24.14.0；默认 Node 22.23.2 不满足该上游版本要求。
- 仓库实际包含 `packages/adapters/hermes`、`packages/adapters/hermes-gateway`。存在源码不是现有 Hermes 会话接入通过的证明。

## 初次准备时未执行与阻塞（历史快照）

- 安装、启动脚本、服务启动、HTTP 和浏览器烟测均未执行。
- V2 工单 `550c0f3b-87e2-48a2-9965-fc8068217b0d`，requestId `paperclip-v3-isolated-foundation-20260927-01`。
- 提交报 `WebSocket connection failed`；回读为 `paused`、命令 `queued`、`bindings=[]`。工单存在不代表已派发，不重复提交或自动恢复。
- 独立项目经理旧小样 `c4369251-875d-4ec6-b1cd-f53546d22e95` 仍 paused/queued、无绑定会话。没有 PM 通过结论，不恢复或重投该旧小样。

## 执行契约

常规实现仍优先用户指定 Hermes Agnes 3.0 Flash；不要更改模型、供应商或使用付费回退。单 checkout 单写入者。复用原生能力，不另造监督链。安装阶段目标 20 分钟内、有依据返修最多一次，同因两次失败或环境缺失即报告阻塞；这不是已强制执行的 Token 硬预算。PM 与 Codex 后续审查应分别记录实际结果。

## 后续验收证据

准确的命令及退出码、锁文件安装结果、实际监听及数据库目录、`/api/health` 和空 `/api/companies` 响应、真实浏览器截图、差异与有无 Agent 运行。仅构建成功不能替代浏览器验收。

证据入口：`project-library/resources/paperclip/`。本次状态是源码底座就绪、运行验证阻塞，不是可用产品已验收。

## 独立源码检查

Codex 只读子代理已核验固定 tag：`scripts/dev-runner-options.ts` 保留已有 PAPERCLIP_CONFIG/CONTEXT；`server/src/config.ts` 优先采用 DATABASE_URL。因此启动时必须显式限定新 CONFIG/CONTEXT 并清除 DATABASE_URL/DATABASE_MIGRATION_URL。`server/src/adapters/registry.ts` 已注册 Hermes 本地与远程适配器；此检查不包括实际模型调用。HEARTBEAT_SCHEDULER_ENABLED 仅关闭调度器，不能宣称全局禁止手动执行；初始空实例是本次不运行员工的边界。

## 后续执行完成：直接启动原版

用户随后明确要求“我们先把paperclip先跑起来”，不再以旧V2入口作为本次启动前置。Codex直接完成依赖安装与原版启动；原工单未恢复、未重投。

- pnpm 9.15.4 frozen-lockfile 安装退出码0；保留上游源码和锁文件。
- 独立启动包装器 `scripts/v3-local.sh` 及双击入口落盘；Node24、Rust1.97.1，使用上游 dev:once/dev:list/dev:stop。
- 首次失败是干净PATH缺少已有Cargo，补充用户现有Cargo路径；后续工具链下载较慢，使用macOS已配置网络代理后完成。未改上游产品逻辑、模型或供应商。
- 上游迁移、原生执行组件和插件SDK完成构建；服务监听回环3133，PostgreSQL实际监听54333。
- 数据库实际data_directory经SQL回读确认位于v3专属实例；HTTP健康状态ok；初次公司接口为空，随后用户界面状态发生变化，保留Fireman公司。记录时无员工、任务或执行记录。
- 真实Chrome页面标题Paperclip，显示模型连接步骤，截图和证据已登记。模型登录提示和首次备份提示保留，未宣称接入Agent成功。
- 验证范围为本地启动烟测与隔离，不是完整上游测试套件或项目经理审批。未运行全仓库单测，未调用模型，不冒充PM流程通过。

当前运行证据：`project-library/resources/paperclip/runtime-verification.json`。原始源码准备和旧派单证据保留作历史。

### 启动入口最终修正与复验

重复启动实测发现，上游注册 dev runner 的 processGroupId 为 null，校验时回退到其PID；经pnpm/tsx多层启动，实际进程组首进程不同，导致已有进程不被复用。未改上游源码，在本地包装器中以独立进程组直接执行Node + tsx loader + 官方dev-runner/dev-service脚本。只终止本次重复验证进程，再确认无活动运行后优雅重启v3；数据库和用户公司数据保留。

复验：第二次start明确输出already running，复用PID73768及原服务；status正常，健康接口ok；包装器shell语法、git diff --check通过，上游package/lock/server/ui/packages均无差异。
