# Paperclip Titan 本地替换计划

用户要求部署运行 Paperclip-Titan，并替换本地 Paperclip；已明确授权本次 Codex 直接备份、替换和验收。Hermes V2 连接失败，原小样仍暂停无绑定，本次不恢复旧任务、不宣称 Hermes 评估通过。

目标来源：https://github.com/dainsiahtill-dev/Paperclip-Titan.git
冻结版本：08571c1733ee292edaed71028baa7c1ac2128913
原版本：d554c4789ed3930f8a53ac9fdf6503b3187097da

## 约束

- 原实例 .paperclip/instances/project-management-v3、端口3133/54333、员工模型身份、密钥及调度关闭保持。
- 原checkout现有修改不覆盖，Titan在本地隔离worktree运行；原project-library继续作为唯一资料库入口。
- 保留现有中文界面和两行适配器连接修复；合并不得覆盖Titan模型、容量、恢复功能。
- 不创建员工/业务任务，不调用模型，不更换供应商，不操作旧V2任务，不提交推送。
- 数据迁移仅0280/0281/0282向前增量，切换前冷备份实例，保留完整回退说明。

## 执行与验收

- [x] 下载固定版本到 .worktrees/titan-local，按现有锁文件安装依赖；复用已安装官方Node24与native工具。
- [x] 合并本地中文/代理修复，执行针对性测试、类型检查及UI构建；保留完整日志与退出码。
- [x] 保持旧服务直到目标安装完成；确认无活动run后停止旧服务、冷备份db/config/secrets/storage/日志（历史自动备份保留原处）。
- [x] 使用原数据目录启动Titan，保留回环监听和scheduler=false。启动失败先停止目标、还原冷备份并启动原版，不无限重试。
- [x] 核验health目标commit、35员工/20项目/69任务原ID包含关系与员工配置摘要、数据库迁移、真实浏览器主页/员工/模型设置/并发设置。
- [x] 重复启动识别同实例，不产生重复服务；记录实际PID、数据路径、部署与回退入口。
- [x] 更新原资料库索引与部署报告。

同一原因连续失败两次或需要改变范围时报告具体证据；此计划不声称硬Token预算。


追加员工模型已完成：10GPT-6.1Sol、25MiniMax-M3.1-Flash-Preview。复用已验证的官方CLI0.159.2，原思考深度/岗位/汇报/暂停保留。两种hello与SQL/API/浏览器回读通过。
