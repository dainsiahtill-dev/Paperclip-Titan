# 项目管理后台 v3 中文文案

复用现有 i18next 的 v3 namespace；en 为回退，zh-CN 为本地界面语言。HTML lang 驱动初始语言，不改变上游40种语言基础词典的键约束。所有文案显式接入组件，不扫描或改写DOM、业务内容或命令。

选用文案来自 Paperclip 上游 PR #11373（oooBCKooo/paperclip，commit 0cac809a0cea0e5bc1cf84ee1f9b48505eff2fed，MIT），另补当前版本新增界面文案与动态显示。原始词典、许可证、哈希与来源保存在 project-library/resources/i18n/paperclip-pr-11373。运行词典是原件的选用/修订版，不是上游完整多语言支持。

术语：Agent/Agents 的业务身份统一为“员工”，网络 proxy 仍为“代理”；Organization 为“组织”。品牌、模型ID、命令、路径、员工与组织名称、任务正文保持原样。新增文案须同时修改en/zh-CN，并通过现有assertValidLocaleMessages键和插值校验。
