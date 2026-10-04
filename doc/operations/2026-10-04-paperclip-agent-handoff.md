# Paperclip 维护接手文档

**范围：仅Paperclip。** 本文配合 [详细实施计划](../plans/2026-10-04-paperclip-delivery-reliability-plan.md) 与三份独立审计使用，面向没有本次会话上下文的接手Agent。

**创建时间：** 2026-10-04，Asia/Taipei。时间快照会过期，先核当前状态再动手。

**实施后更新：** A–J 已集成并完成本次限定验收，默认实例已加载验收代码。
先读 [最终落地与验收报告](2026-10-04-delivery-final-report.md)；下方创建时的待办/基线保留为历史，不能当作当前未实施清单。
原预算资格失败、历史未知用量和只读回滚范围仍需按最终报告保留，不据任务 done 推断账务完整或零维护介入。

## 1. 可直接复制给接手Agent的指令

~~~text
你接手维护本地Paperclip fork，仅处理Paperclip的平台短板。
仓库：/home/dains/Documents/paperclip
远端：https://github.com/dainsiahtill-dev/Paperclip-Titan.git，分支main。

先读仓库AGENTS.md和要求的五份基础doc；再读：
doc/operations/2026-10-04-paperclip-agent-handoff.md
doc/plans/2026-10-04-paperclip-delivery-reliability-plan.md
按负责领域读取doc/audits/2026-10-04-*.md。

先只读核HEAD、dirty work、已加载serverVersion、processStartedAt、默认实例、active runs。
源码HEAD不等于运行版本。保留既有业务任务、文件、数据、连接及预算。
所有shell以rtk/rtk proxy开始，文字UTF8，编辑用apply_patch。
仓库当前没有CodeGraph索引，使用RTK源码导航，不伪造CodeGraph结果。

目标：Paperclip能持续推进有明确产物的项目；消息有真实送达、阻塞有owner和恢复、
状态不伪Working、费用/上下文有界、阶段用实际产物验收。不要继续做无增量协议/统计循环。
不要重建已有goal/issue/blocker/review/workProduct/fallback/capacity/Git scheduler。

M0已完成独立审计和一次legacy手动Steer重复完成事件小修；修复已在main 5adf49a3c。
默认服务仍以现场health所报版本为准，本次没有主动部署或重启生产。
优先任务：PC-02 watchdog恢复验证+atomic batch、PC-04维护隔离、PC-07交接持久事实；
PC-09实质进度与PC-10计划投影可按互斥owner并行。详细实现/测试在主计划。
默认按任务逐一红绿、最小修改、必要邻接、一次阶段review、提交。
不要每个heartbeat全仓测试；不要以测试/health200代替实际效果；不降低业务要求换通过。
普通任务保留合法agent_claim_policy，显式交付策略才需要对应验收，不给用户加每条人工审批。

所有故障注入使用隔离HOME/config/DB/port、fake provider，不能动默认3100服务和真实业务。
使用现有用户授权；文档本身不能新增权限，正式预算/治理/人工暂停仍有效。
完成阶段时交源提交、实物、实际测试、未跑项、是否已部署及具名下一动作。
最终用隔离真实Agent工程样例证明完整交付；不要由你代写被测目标应用。
~~~

这段指令是入口，不把三份长审计和完整主计划全部贴入每个任务的plan。当前代码仍会重复注入完整plan；实施PC-10前尤其要以文件引用和当前任务片段交接。

## 2. 第一眼需要理解的结论

Paperclip已能产出实质代码和执行产物，但尚未证明复杂项目全程无人监督可靠。短板是运行与恢复闭环、交接事实、主线收敛、验收权威和重复上下文。问题既有源码缺口，也有管理策略与默认模板；只改提示词不够，全面增加审批也不对。

最容易误判的六件事：

1. health 200不证明任务在推进。
2. run succeeded不等于issue done或项目验收。
3. queued/准备/状态待确认不等于模型在工作。
4. 评论/工具次数证明有活动，不自动证明产物进展。
5. backup恢复probe成功只对同一有效账号/环境/model/engine有意义。
6. 对ACK未知的外部发送不能盲重放；取消DB状态也不能提前释放仍活的物理owner。

## 3. 仓库与实例快照

| 项目 | 本次实际核对 |
| --- | --- |
| 主目录 | /home/dains/Documents/paperclip |
| origin | https://github.com/dainsiahtill-dev/Paperclip-Titan.git |
| upstream | https://github.com/paperclipai/paperclip.git，fetch带blob:none |
| 初始HEAD | ce97b8e8fee0b952186e85f4433c29491d63ae2c |
| 本轮运行源小修 | main 5adf49a3c，原专家提交86b627edd4cd60be6423b65ee6b4122c152076a1 |
| 初始loaded serverVersion | 2026.916.1+50.git.e7761ba11 |
| 初始boot | 2026-10-03T10:49:27.128Z |
| Node | /home/dains/.paperclip/runtime/node-v24.21.0/bin/node |
| package engines | >=24.11.0 |
| pnpm | 项目9.15.4；当前入口/mnt/c/Users/dains/AppData/Roaming/npm/pnpm |
| API/UI | http://127.0.0.1:3100，/api基路径 |
| 默认config | /home/dains/.paperclip/instances/default/config.json |
| DB | embedded-postgres，54329，/home/dains/.paperclip/instances/default/db |
| auth/exposure | local_trusted/private，现场health authReady/bootstrap ready |

初始ce97只增加.serena项目配置，与loaded e776的运行源码相同。5adf是本轮真正运行源码变更，但本轮没有主动部署；接手先读fresh health确认。当前文档提交的SHA从git查询，不把文档更新视为新runtime已加载。

### 3.1 实例文件目录

~~~text
/home/dains/.paperclip/instances/default/
  config.json
  .env
  db/
  data/storage/
  data/backups/
  data/run-logs/<company>/<agent>/<run>.ndjson
  logs/paperclip-starwave-server.log
  logs/paperclip-starwave-supervisor.log
  secrets/master.key
  workspaces/
  projects/
  companies/
~~~

历史脚本名包含starwave，但 scripts/paperclip-starwave-service.sh 在Paperclip仓库，职责是这个Paperclip服务的tmux监督与重启；不是业务模型训练服务。业务仓库和GPU配置不属于本交接。

默认服务使用该脚本与scripts/run-starwave-local.sh。状态是监督器状态加health HTTP；不要直接照通用systemctl模板假设此机有paperclip.service。

## 4. 可复制的只读核查

下面命令在Paperclip仓库执行。不要把配置、.env、auth文件或完整argv/env输出给日志。只读取白名单字段。

~~~sh
rtk proxy git status --short
rtk proxy git log -8 --oneline
rtk proxy git remote -v
rtk proxy curl --noproxy '*' --fail --silent --show-error http://127.0.0.1:3100/api/health
rtk proxy bash scripts/paperclip-starwave-service.sh status
~~~

健康接口的version/serverVersion是loaded身份，git.fullSha是磁盘当前Git状态。/api/health/ready本轮404，不能用这个不存在的路由判服务离线。

~~~sh
rtk proxy python - <<'PY'
from pathlib import Path
import json
config = json.loads(Path('/home/dains/.paperclip/instances/default/config.json').read_text(encoding='utf-8'))
server = config.get('server', {})
database = config.get('database', {})
print(json.dumps({
    'serverPort': server.get('port'),
    'serverHost': server.get('host'),
    'databaseMode': database.get('mode'),
    'embeddedPostgresPort': database.get('embeddedPostgresPort'),
    'embeddedPostgresDataDir': database.get('embeddedPostgresDataDir'),
}, ensure_ascii=False))
PY
~~~

匿名运行汇总，默认仅GET，不打印prompt、env、账号或公司名称：

~~~sh
rtk proxy python - <<'PY'
import json
import urllib.request
from collections import Counter
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
base = 'http://127.0.0.1:3100/api'
companies = json.load(opener.open(base + '/companies', timeout=15))
for index, company in enumerate(companies, 1):
    if company.get('status') != 'active':
        continue
    company_id = company['id']
    agents = json.load(opener.open(base + '/companies/' + company_id + '/agents', timeout=15))
    runs = json.load(opener.open(base + '/companies/' + company_id + '/heartbeat-runs?limit=1000', timeout=15))
    if isinstance(runs, dict):
        runs = runs.get('data', runs.get('runs', []))
    print(json.dumps({
        'companyIndex': index,
        'agentStatuses': dict(Counter(agent.get('status') for agent in agents)),
        'activeRunStatuses': dict(Counter(run.get('status') for run in runs if run.get('status') in ('queued', 'running'))),
        'returnedRows': len(runs),
        'historicalRunStatuses': dict(Counter(run.get('status') for run in runs)),
    }, ensure_ascii=False))
PY
~~~

这是当前local_trusted实例命令。若接手时authenticated，不改回local_trusted绕登录；使用已授权board/API身份，凭据由既有机制供应。列表分页/limit上限变化时先核route，不把1000条当全历史。

## 5. 当前完成项与未完成项

### 5.1 本轮已经做的工作

- 3个独立专家完成运行、交接状态、交付治理审计；原始事实、建议接口和测试步骤均已写repo。
- 主计划统一范围/优先级/依赖/模块边界，避免重复实现已存在机制。
- 确认并修复一次legacy手动Steer两次完成事件：原服务和route重复写同action，不是intent/effect区分。
- 新修把trusted board actor在service原ACK事务记录，删除route第二次完成日志，commit后publish一次；自动system路径与native路径保持。
- 原comment作者与正文不改，replay不重复发送或完成记录；没有通过削弱redaction修测试。
- 源小修已合并main 5adf49a3c；默认运行服务没有主动重启。

### 5.2 新鲜测试结果

| 范围 | 本轮结果 | 不意味着 |
| --- | --- | --- |
| 运行审计 | 8文件149通过，隔离probe差异诊断成立 | 真实ACP账号/额度恢复已正确 |
| 交接审计修前 | 7文件129通过 | 崩溃/late ACK缺口已经实现 |
| 交接小修专家 | RED 2 vs1；GREEN 5文件88通过、server tsc通过 | 真实浏览器/生产已部署 |
| Root主目录复验 | 2文件67通过，68.09秒 | 全monorepo suite全绿 |
| Root server typecheck | prepare runner/vendor/plugin及tsc完成，退出0 | 全项目build/生产重启完成 |
| 治理审计 | 相关45通过；三个pure反例成立 | watchdog新lineage/batch已经实现 |

Root复验具体文件：server/src/__tests__/issue-queued-comments-routes.test.ts、server/src/services/issue-queued-comment-queue.test.ts。小修关键测试名：records one committed legacy steering completion and preserves the board actor。

Root server typecheck产生Rust已有warning，但无typecheck错误。专项有Vite configLoader提醒；不能为了消警告拓展本轮范围。

历史server-wide 37 failed/15050 passed未本轮重跑，也没有全部归因。不要把历史结果当当前全套结果，不要把专项通过冒充所有功能资格。

### 5.3 仍待实施

watchdog恢复verify/atomic batch、可信产物验收、维护single-flight/phase隔离、probe执行上下文和多任务恢复、ACPdurable intent/late ACK、真实Working状态、progress反空转、plan按需投影、token预算与隔离完整项目资格。各项明确任务及证据等级在主计划PC-02–PC-13。

## 6. 本机可执行测试命令

为每次测试创建新的临时root；复制下面固定示例前，把路径后缀换成刚获得的唯一目录，不复用默认实例。

~~~sh
rtk proxy mktemp -d /tmp/paperclip-handoff-check-XXXXXX
~~~

示例中test-session只是示例目录后缀。环境显式unset外部数据库URL，避免继承某个业务实例：

~~~sh
rtk proxy env -u DATABASE_URL -u DATABASE_MIGRATION_URL PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin PAPERCLIP_HOME=/tmp/paperclip-handoff-check-test-session PAPERCLIP_CONFIG=/tmp/paperclip-handoff-check-test-session/config.json PAPERCLIP_INSTANCE_ID=handoff-check NODE_ENV=test CUDA_VISIBLE_DEVICES= /mnt/c/Users/dains/AppData/Roaming/npm/pnpm exec vitest run --project @paperclipai/server --no-file-parallelism --maxWorkers=1 server/src/__tests__/issue-queued-comments-routes.test.ts server/src/services/issue-queued-comment-queue.test.ts
~~~

main server类型检查，可能编译runner/plugin依赖，保留工具路径：

~~~sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/home/dains/.cargo/bin:/usr/local/bin:/usr/bin:/bin /mnt/c/Users/dains/AppData/Roaming/npm/pnpm --filter @paperclipai/server typecheck
~~~

若仅改文档，检查链接、契约、命令和diff即可。源码够广或要交PR-ready时按AGENTS完整门槛，不要删掉它们：

~~~sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/home/dains/.cargo/bin:/usr/local/bin:/usr/bin:/bin /mnt/c/Users/dains/AppData/Roaming/npm/pnpm -r typecheck
rtk proxy env -u DATABASE_URL -u DATABASE_MIGRATION_URL PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/home/dains/.cargo/bin:/usr/local/bin:/usr/bin:/bin PAPERCLIP_HOME=/tmp/paperclip-handoff-check-test-session PAPERCLIP_CONFIG=/tmp/paperclip-handoff-check-test-session/config.json NODE_ENV=test /mnt/c/Users/dains/AppData/Roaming/npm/pnpm test:run
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/home/dains/.cargo/bin:/usr/local/bin:/usr/bin:/bin /mnt/c/Users/dains/AppData/Roaming/npm/pnpm build
~~~

这些广泛门槛未在本轮执行。发现失败先保留准确name/错误/源版本，再判断相关性，不用无界全库清理替代PC主线。

UI变化按AGENTS的DESIGN/token规则：check:token-gates与相关Vitest/Playwright桌面移动流。无UI源变更不为每个后端日志小修重跑整个Storybook。

## 7. 安全隔离工作区与运行实例

### 7.1 工作区

实际代码合并回/home/dains/Documents/paperclip/main，不把新的隔离路径变成长期正式部署。

本轮小修隔离路径为 .claude/worktrees/handoff-steer-once-20261004，Git已忽略.claude/worktrees/。需要新领域分支时可使用同类repo内路径：

~~~sh
rtk proxy git worktree add /home/dains/Documents/paperclip/.claude/worktrees/platform-runtime-20261004 -b fix/platform-runtime-20261004 main
~~~

这是新唯一name示例，存在时先读git worktree list，不用force覆盖。多人处理heartbeat.ts/routes/issues.ts时预约函数/hunk或顺序cherry-pick，避免双方都实现一套队列。

### 7.2 CLI隔离支持

CLI入口通过Node24运行，不默认npx下载另一版本。以下help已在本轮实际读取：

~~~sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin /home/dains/.paperclip/runtime/node-v24.21.0/bin/node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts worktree:make --help
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin /home/dains/.paperclip/runtime/node-v24.21.0/bin/node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts db:backup --help
~~~

worktree:make支持start-point、instance、home、server-port、db-port、seed-mode、no-seed等；默认路径是用户HOME下。要repo内worktree先用Git创建，再在该worktree按worktree init流程初始化隔离实例。新scope的help和注册证据确认后再执行，不凭印象拼不存在的flag。

第一轮fake-provider资格使用空实例，不复制业务DB。需要minimal seed时保持默认quarantine，核复制agent timer/routine/workspace desired state已停、旧issues未自动派发；不要加preserve-live-work。

隔离实例至少满足：独立HOME/config/instance、不同app与PG端口、独立DB、无生产cron/业务控制、可确认scope与版本。例示端口3311/55431需要先检查空闲。不得两个server共享同一个embedded PG目录。

真实provider验证在隔离scope沿现有AI Connection/工作树登录流程采用已授权账号；不要拷贝原始secret或靠新用户身份复用他人连接。先mock控制故障，再进行最少真实hello/Agent执行。

## 8. 主备用、并发与账号注意点

- 主模型availability monitoring、unavailable转备用、周期回切已经有实现；e776/9d8等不是新待建能力。
- 当前quota probe强制CLI，与显式ACP执行的路径能力不同；配额可用不等于执行路径完整就绪。修复必须记录有效scope与结果含义。
- user scope不一定等于账号scope。project.env/routine/secret版本/连接不同需不同身份；回切不能影响不匹配任务。
- General的shared concurrency group可设minimax=6，使用相同订阅的Agent显式加入；per-Agent与instance ceiling也保留。
- 第7个queued不是BUG；最大6也不保证始终6个执行。先查dependencies/workspace serialization/budget/pause/真实owner/外部wait。
- 取消逻辑终态不等于物理执行已停止；保留slot直到owned provider完成drain。
- 模型、thinking effort、账号和权限是有效profile的一部分；自定义Claude/CC-Switch模型ID要实际传到对应CLI，不能只加下拉项。
- GPT-6.1-Sol、其他已配置Codex模型、MiniMax自定义版本继续沿现有可用catalog/custom ID；是否可用以当前账号真实调用为准。
- 该用户已表达Codex danger-full-access、Claude skip-permissions、Luna至少xhigh；接手核已有配置，不扩成所有部署的强制设置，也不绕平台的budget/approval/company隔离。
- 不打印auth.json、密钥、完整env或argv，不自动logout/sign-in制造刷新冲突，不随意共用可写Codex home。
- 后台probe限额只检测控制路径，不应递交真实项目任务或触发外部业务效果。

## 9. 现场排障决策

| 用户看到的现象 | 第一读取 | 正确下一动作 |
| --- | --- | --- |
| 3100不可达 | 管理脚本status、端口、所属controller、监督日志 | 核根因后恢复所属服务；不要启动第二个DB/server |
| 页面Working但无执行 | run projection、lease/process-start、stage、queue reason、最近实际活动 | showing confirming/waiting；不凭静默kill |
| 消息仍queued | comment版本/queue revision、run/turn、capability、tool busy、ACK状态 | 支持则真steer；不支持自然边界；unknown不重发 |
| Couldn't steer | 精确conflict reason、stale run、支持状态、late ACK | 刷新事实/原IDreconcile，不删除消息或无限点Retry |
| 额度没了不换备用 | fallback启用/config、有效scope、probe状态、physical slots | unavailable与busy分清，保留主失败；匹配备用续接 |
| 主模型恢复还在备用 | matching probe identity、配置revision、scheduled recovery token | 正确scope回切并恢复全部eligible predecessors |
| blocked不唤醒 | 根依赖/owner/monitor/recovery、真实未解条件 | 具体owner修阻塞；不要只给等待者发continue |
| watchdog卡片done但主线不动 | restoration disposition/attempt/fingerprint/live path | 复核恢复，有限再试或升级；不是永久reviewed |
| 一直相互检验 | 实际产物版本、当前未验条件、重复内容/决策 | 收口已接受项，只留有用户价值的下一动作 |
| CPU/Git慢 | workspace Git scheduler日志、queue/cache、tracked/ignored数据 | 最早慢owner、合理排除归档/独立worktree，不盲调timeout |
| 计划token重复 | promptMetrics、plan revision、resume/compact payload | 当前片段+引用，核心约束保留，不能只切最后字数 |
| 本机有MCP但Agent缺工具 | 有效home/config、runtime工具绑定、sandbox、advertised能力 | 使用既有连接/config路径修复，不伪造结果或把整个宿主配置乱复制 |
| 任务done但用户没结果 | 原产物与accepted provenance、project delivery contract | 实际可查看/运行的产物验收，不能以自报approved当权威 |

issue documents/plan的404可能仅是该可选文档不存在；不要把它自动当整个页面失败。灰色占位持续不消失需要看实际查询状态与错误UI。Reduced Motion提醒不是调度失败的根因。

## 10. 部署与回滚交接

本轮没有部署小修；生产升级需要在源码/隔离验证完成后按已有授权做具体操作，先保存preflight与备份。不要为刷新版本随意停正在跑的业务任务。

- 开始前保存当前controller boot/PID/start、active run/preflight名单、source版本与实例config路径。
- Node24构建先完成，完整备份DB、storage、workspaces、secrets key与config；密钥只在受保护位置，不放Git/附件/日志。
- 用官方request-hot-restart.ts和同实例config；存在ACP stdio运行需要原selective drain，CLI/native按真实可adopt/同run恢复分类。
- 本机监督方式是tmux脚本，不默认使用systemctl restart。只给已核所属controller发送信号，不用pkill node/codex/claude或kill -9扫全机。
- shutdown snapshot、embedded PG停止和provider真实drain有先后；API短暂不可达不代表部署失败，等待原owner完成，不立刻再起第二个。
- 启动后核loaded version/boot/recovery report；lostRunIds非空必须具名处理，每个preflight run归adopted/finalized/受控retry/明确recovery。
- 新feature关闭不删durable intent/lineage；不重放未确认外部动作。回滚源码前核schema读兼容和实际effect。

在本机受控计划准备时，帮助/脚本存在性先核：

~~~sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin /home/dains/.paperclip/runtime/node-v24.21.0/bin/node cli/node_modules/tsx/dist/cli.mjs scripts/request-hot-restart.ts --help
~~~

这是帮助，不是立即重启命令。需要真实server-pid/PID-start与当前live快照后才能形成具体部署指令。通用DEVELOPING中的reset DB示例不适用于维护默认业务实例。

## 11. 接手第一小时、第一阶段和最终收口

### 第一小时

- [ ] 读AGENTS、主计划第1–5节、对应领域审计。
- [ ] fresh health/status/HEAD/dirty；源码和loaded版本分开记录。
- [ ] 核5adf小修已合并、不重复取原86提交；正常任务与主备用/并发等已有能力保留。
- [ ] 建独立worktree/实例，确认默认实例未被操作。
- [ ] 从PC-02/04/07之一选最早阻断点，写一个有价值的失败测试；把跨文件写入边界告知协作者。

### 第一阶段

- 完成一个可独立验收源码任务；验证根因/邻接/恢复/真实状态，交明确产物。
- 长plan上下文先量测，然后做按需投影；不要把这份详细文档每turn全量塞模型。
- 大量评论空转先分活性/进展，不把所有文字工作一刀切为无价值。
- 治理用显式项目策略，普通低风险任务保持易完成，不重复让用户标注/批准。

### 最终收口

用主计划第10节隔离工程样例：真实Agents拆分、写代码、跑测试、经历必要缺陷反馈/故障恢复、交可运行产物、QA接收、项目目标闭合。维护Agent不能代写目标应用，也不能用mock/health替代真实交付。

每次阶段交接一份短说明：具体任务/源码提交/产物/实际效果/已跑未跑/是否部署/具名下一动作。已接收的项不再重复生产审核，不为日志、哈希、统计再开一串审批卡。

## 12. 文件与证据导航

- [主完善计划](../plans/2026-10-04-paperclip-delivery-reliability-plan.md)：统一任务/架构/接口/验收与部署计划。
- [运行审计](../audits/2026-10-04-runtime-reliability-audit.md)：probe、scope、scheduler、恢复、容量、公平性、物理截止。
- [交接审计](../audits/2026-10-04-handoff-and-state-audit.md)：完整调用链、provider能力、投递状态、H0–H7与本轮小修。
- [治理审计](../audits/2026-10-04-delivery-governance-audit.md)：watchdog、batch、进度、验收、plan与token、G0–G7。
- [小修说明](../plans/2026-10-04-steering-completion-event.md)：4文件改变、红绿、actor和幂等边界。

相关原有权威doc：doc/execution-semantics.md、doc/architecture/native-status-arbitration.md、doc/architecture/durable-continuation-scheduler.md、doc/agent-quota-fallback.md、doc/AGENT-ARTIFACTS.md、doc/connections/AI-CONNECTIONS.md。

本交接足以独立开展Paperclip维护；现阶段成果是审计、可执行计划、单项源码修复与其专项验证。整体“所有短板已彻底解决”仍需上述实施和真实资格测试证明。
