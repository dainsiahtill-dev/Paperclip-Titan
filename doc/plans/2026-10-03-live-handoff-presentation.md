# 自动交接确认后的即时显示

## 已核根因

SOU-171当前运行274852a7中，评论13f3471e于18:40:39.542Z创建，18:40:39.829Z
获得ACP injected确认。原队列已coalesced、GET queued-comments为空，模型随后回应
已接Root复核；截图03:01仍显示排队。问题发生在确认后的界面投影。

自动路径live-adapter-steering直接写activity表，没有提交后发布activity.logged。
它还缺details.targetRunId；IssueDetail只读取该字段，忽略现有顶层runId，因此即使
重新取得旧活动记录，也会把同一条已接收评论再次推导为排队。手动Steer路径已有
完整目标字段与实时事件，不受这两处遗漏影响。

## 边界与实现

1. 自动投递仍仅在真实injected后原子保存确认、队列和活动。复用logActivity的
   postCommitPublications，事务提交后发布标准实时事件，并写明targetRunId。
   失败/不支持/uncertain/暂停/停止不生成成功通知，不重复模型投递。
2. IssueDetail对旧system/live-adapter-steering、protocol=acp且已确认的活动，兼容
   顶层runId作为投递目标。不能将普通comment_added或未确认队列当成功。
3. 消费者在已有activity.logged链路刷新活动并把消息插入同一运行的对话；保留
   实际确认时间、原作者和正文。旧记录无需数据库批量改写，也不取消当前Agent。

## 验证与发布

先重现缺实时通知和旧活动导致的假队列；再验证自动交接在真实事务提交后可由
公司事件订阅者立即观察，目标和剩余队列一致。UI回归覆盖新格式和原截图旧格式，
无须点击Steer，确认后的评论进入原运行且未确认项仍排队。执行相关队列/活动/UI
测试、server类型检查与必要构建。运行中工程保留，在安全边界部署server；旧记录
兼容可先通过前端静态构建生效，实际浏览器核对SOU-171，提交main并推用户仓库。

## 当前验证结果

- 原代码下自动通知回归失败：订阅者收到0条通知；旧格式UI回归显示queueState=queued，
  缺steeredIntoRunId。新格式字段已有的UI对照通过。
- 修复后58项真实数据库队列路由回归通过，订阅者在通知时实际读到已提交coalesced
  状态。4项UI交接/未确认队列回归通过；server和UI TypeScript检查、UI构建通过。
- 扩展UI三文件183项有181通过、2项旧侧栏自动打开测试失败；撤掉本次UI改动后这两项
  仍失败，名称为reveals the planning-mode task sidebar when its plan document exists及
  reveals the properties sidebar on the first onboarding task once a plan document exists。
  没有修改它们或宣称UI全套通过。
- 3100已读取新前端静态资产。真实浏览器进入SOU-171，原交接处于可见对话气泡，
  queueRows=0、Interrupt按钮=0、页面脚本错误=0。截图保存在本机
  /tmp/paperclip-handoff-fixed-20261003.png。首次浏览器截图尚在加载，不作为验收图；
  最终已等待气泡可见并滚动定位。
- 当前星擎274852a7仍工作，未中断。server新通知逻辑须在安全运行边界加载；不能把
  静态前端已生效说成后端热更新完成。
