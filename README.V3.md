# 项目管理后台 v3

## 2026-10-01 普通目录整合

当前项目根为 `/Volumes/固态硬盘/02_代码项目/项目管理后台v3`，使用普通 Git checkout。`main` 追踪 `titan/main`，已合入 Titan `a22c63e` 与本地中文化和部署改动。原实例与35员工配置保留，调度器继续关闭，服务在 `http://127.0.0.1:3133` 运行。办公室和 NPC 工作继续暂停，办公室源码保留为未提交草稿。构建、类型检查、token门禁与浏览器检查通过，全量测试尚未通过。详见[整合报告](project-library/resources/integration-20261001/README.md)。下方日期记录是历史部署状态。

## 2026-09-30 当前版本

已替换运行 Paperclip-Titan `08571c1`，地址 http://127.0.0.1:3133。源码在 `.worktrees/titan-local`，原实例数据与本资料库继续作为权威入口；原checkout保留用于回退。员工已按用户要求统一为10名GPT-6.1 Sol、25名MiniMax-M3.1-Flash-Preview，岗位/汇报/暂停不变，两种真实连接测试通过。原启动入口已指向Titan。部署、验收与回退见资料库 `resources/paperclip-titan/deployment-report.txt`。

以下旧记录保留为历史。

采用 [Paperclip](https://github.com/paperclipai/paperclip) 作为独立开源底座，与旧版项目管理后台隔离。

## 当前状态（2026-09-27）

**原版已启动并通过本地页面与接口检查。** 访问：<http://127.0.0.1:3133>。

- 基线：`v2026.916.1` / `d554c4789ed3930f8a53ac9fdf6503b3187097da`，MIT。
- 分支：`codex/v3-paperclip-foundation`；保留上游源码、README、LICENSE 和锁文件。
- 独立 Git 仓库，不是旧项目的 worktree；未迁移旧数据库、任务、员工、配置或密钥。
- Node 24.14.0、pnpm 9.15.4 按锁文件安装成功；上游原生执行组件已用其指定 Rust 1.97.1 构建。
- 健康接口、实际数据库目录、监听地址与真实浏览器页面均已核验。
- 初次 API 检查公司列表为空；浏览器验收期间界面已进入模型连接页，并出现 `Fireman` 公司。Codex未点击创建或连接模型，保留现有配置。检查时员工、任务与执行记录均为0。
- **OpenAI订阅登录检查已通过，Hermes接入与员工执行未验收。** 后台代理兼容问题已修复，实际连接检查返回ready；原始启动截图中的登录错误属于历史状态。见[修复记录](project-library/resources/paperclip/2026-09-27-login-proxy-fix.md)。

## 启动、查看和停止

双击本目录的 `启动项目管理后台v3.command`，或在项目根目录执行：

```bash
./scripts/v3-local.sh start
./scripts/v3-local.sh status
./scripts/v3-local.sh stop
```

`start` 在前台运行；直接调用上游运行脚本，并确保运行进程具有自己的进程组。已有同实例服务时由上游检查后复用（已实测）。当前服务通过后台进程运行，关闭此聊天不停止服务；未安装系统开机启动项。

## 本地位置与隔离

- 桌面入口：`/Users/siah/Desktop/项目管理后台v3`（符号链接）。
- 实际源码：`/Volumes/固态硬盘/02_代码项目/系统盘迁入/Desktop/项目管理后台v3`。
- 实例目录：`.paperclip/instances/project-management-v3/`。
- 网页：`127.0.0.1:3133`；嵌入式 PostgreSQL：回环端口 `54333`。
- DB、备份、日志、存储、加密密钥路径均显式限定在实例内。启动脚本使用干净环境，显式指定 HOME/CONFIG/CONTEXT/实例 ID；不继承旧数据库变量，不加载工作目录 `.env`。
- 固定调用已安装 Node 24；保留系统默认 Node 22。启动脚本额外暴露已有 Cargo 工具路径。
- 启动入口自动读取本机已有macOS网络代理，也可接收HTTP_PROXY/HTTPS_PROXY；启用Node环境代理，并预加载jsdom同版Undici的EnvHttpProxyAgent，防止依赖覆盖代理。回环请求始终排除代理。
- 遥测与 heartbeat scheduler 关闭；关闭调度器不是全局禁用手动 Agent 执行。
- Agent JWT 尚未配置；初始健康信息有“尚无首次备份”的提示，自动备份周期为60分钟。后续接入员工时再处理身份与执行配置。

## 证据与历史

- [运行验收记录](project-library/resources/paperclip/runtime-verification.json)
- [浏览器截图](project-library/resources/paperclip/startup-page.png)
- 安装日志：`.paperclip/bootstrap/install.log`；退出码：`.paperclip/bootstrap/install-result.json`。
- 启动日志：`.paperclip/bootstrap/server.log`；后台启动记录：`.paperclip/bootstrap/launch.json`。
- 包管理器多层启动会使上游记录PID与实际进程组不一致；本地入口直接用Node加载上游脚本，独立进程组后重复启动已正确识别原进程。
- [来源清单](project-library/resources/paperclip/source-manifest.json)
- [初始计划与后续执行记录](doc/plans/2026-09-27-v3-paperclip-foundation.md)

旧 V2 派单 `550c0f3b-87e2-48a2-9965-fc8068217b0d` 仍保留暂停、无会话绑定的历史状态。用户随后明确要求先直接运行 Paperclip，本轮由 Codex完成启动；不要为已完成的安装重复恢复该工单。没有声称 Hermes 项目经理评估或模型调用通过。

停止注意：上游停止入口在本机曾残留子进程；如返回失败，先核对本v3监听PID与专属进程组，不能认为服务已停止，也不能直接重复启动或批量结束其他项目进程。

## 简体中文界面（第一批）

刷新网页即可加载中文。已覆盖导航、仪表盘、任务/员工常用操作、模型连接、项目与基础设置；高级实验页、部分详情页和外部内容仍可能显示英文。用户名、任务内容和模型标识保持原样。

- [中文化来源、范围与验证](project-library/resources/i18n/README.md)
- [真实页面与验证清单](project-library/resources/i18n/localization-manifest.json)
- [仪表盘截图](project-library/resources/i18n/dashboard-zh-CN.png)

上游版本与许可继续保留；本地UI源码现已接入显式翻译调用，不能再称整个源码与上游完全无差异。
