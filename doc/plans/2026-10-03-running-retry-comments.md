# 普通交接不取消已经启动的恢复任务

## 实际问题

本机重启后SOU-171自动恢复为0a4cab0f，状态running。UTC19:59的普通Board评论
983fadb8明确interrupt=false，却触发issue_comment_scheduled_retry_superseded取消。
原任务又启动762198a6，造成无谓重启和上下文开销。

## 根因与边界

getCurrentScheduledRetry供UI展示scheduled_retry/queued/running三个阶段；POST和
PATCH评论路径只判断该投影是否存在，误把已经启动的重试当作仍在等待计时。
评论恢复只应替换scheduled_retry。已queued/running应走现有评论合并/同会话
交接路径；显式Interrupt和Stop保留原行为，不改预算、所有权、恢复次数或推理服务。

## 验证

真实临时数据库复现POST/PATCH普通评论对queued/running恢复任务的影响：原run
状态和issue执行所有权保持，原评论保存，不创建取消活动。保留原scheduled_retry
替换测试及重试展示/立即重试/取消权限测试。先见失败，再改两处资格判断，跑相关
测试与server类型检查。在安全运行边界加载，不再次中断当前Starwave工程。

## 已验证

原代码下4项真实数据库回归均将running/queued错误变为cancelled。两处加入
scheduled_retry资格后，相关19项通过，server类型检查通过。扩展113项首次
110通过/3失败并有1未处理异常；撤掉本修复的隔离对照仍复现既有reviewer测试
缺hasPendingWakeContinuationForIssue mock的错误，另外两项隔离重跑通过。
不声称扩展或全量套件通过，不为这项修复修改无关mock/侧栏测试。

当前原工程已接续762198a6，8003与18114/18115重启后实际可读，远程七模型在线。
服务端当前加载1306b0ad7；本次重试资格修复待安全边界加载，保留现有任务与工件。
