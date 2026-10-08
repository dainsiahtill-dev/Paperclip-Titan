# 办公室周边绿地与镜头边界

目标：同步 Titan 后，办公室画面四周显示有限的像素草地和公园，拖动、缩放、部门聚焦及窗口变化均不露出场景外空白。

沿用 Phaser 3.90、已批准的绿篱/植物 PNG 和 CSS token。园区是独立于员工寻路的绘制范围，保留现有员工脚点、部门工位和真实状态来源。根据办公室尺寸和视口计算有限园区矩形；极端长宽比只扩展绿地，以便全景仍能容纳公司。所有镜头入口共用覆盖视口的缩放下限和中心约束。

- [x] 在 `ui/src/lib/phaser-office-camera.test.ts` 先验证园区覆盖、四向拖动、低倍缩放、手机/宽屏/窄屏、扩容和零尺寸输入，运行并确认当前功能缺失。
- [x] 在 `phaser-office-camera.ts` 实现有限园区布局及镜头约束；不引入 Phaser/DOM 依赖。
- [x] 在 `phaser-office-scene.ts` 绘制草地、像素草点、公园步道、长椅及既有植物/绿篱，统一 fit/focus/zoom/pan/resize/扩容的相机约束。手动视图保留中心，自动视图重新适配。
- [x] 在 `phaser-office-theme.ts` / `ui/src/index.css` 添加全部视觉参数；`PhaserOffice.tsx` 和画布容器使用草地底色。
- [x] 运行办公室定向测试、UI typecheck/build、token gates 和 diff 检查，尝试实际页面的拖动/缩放/响应式验收；浏览器权限服务不可用时明确记录限制。

不改变数据库、员工连接、调度器或 NPC 源素材。Git 同步范围是 Titan main；此次改动在既有普通 checkout 由 Codex 单写入完成。

验证：8 个文件共 68 项测试通过，含真实 Phaser BaseCamera 的四边拖动、连续缩放、小数视口、手动视图保持、部门聚焦和扩容。仅替换浏览器硬件探测和绘制依赖，相机接口与 Scene 相机处理均执行真实代码。UI typecheck/build、token gates、diff 检查通过。

实际浏览器验收受阻：内置浏览器保存权限校验不可用，两次导航都未获准，未使用其他机制绕过。尚无实际页面截图或视觉验收结论。

Git 已快进同步 `6047c4b2ab103ef1c24f40b7b6fc42ce99eed54a`。该远端更新还包含 0283–0286 后端迁移；当前 health 为 ready，但后端提示需要重启/迁移。此次未执行这些迁移或重启后端，不把源码同步冒充后端部署完成。
