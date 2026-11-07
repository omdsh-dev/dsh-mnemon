# Runtime subagent inheritance / 子 Agent Runtime 记忆继承

Verified on macOS arm64 with Node 24.22.2 and the official DSH 0.2.2-rc.1 Web profile, using this PR's built package in an isolated temporary installation. No model account, private memory, or existing user profile was used.

在 macOS arm64、Node 24.22.2 与官方 DSH 0.2.2-rc.1 的独立 Web 配置中验证，加载本 PR 的构建产物。未使用模型账号、私有记忆或现有用户配置。

- [Default off / 默认关闭](default-off.jpg): a fresh configuration omits `runtimeMemory.inheritToSubagents`; the Runtime settings page shows the switch off.
- [Enabled / 开启后](enabled.jpg): the switch is enabled and remains enabled after refreshing and reopening the Runtime settings page.

Both screenshots show the Runtime page and existing capacity controls. The switch was also turned off successfully. Reading the persisted profile confirmed that `inheritToSubagents` changed while `memoryLimitBytes`, `userLimitBytes`, and `maintenanceMaxTokens` stayed intact.

截图同时保留 Runtime 页面与既有容量配置。另验证了再次关闭开关；持久化配置回读确认，仅继承选择改变，容量与维护 token 预算保留。

Behavior evidence uses real published DSH lifecycle hooks with a scripted local model adapter: native/PTC tools, normal/bypassed assembly, omitted/false/true settings, multiple turns, captured parent Views, all Runtime Source instances, unchanged tool authority, existing child preferences across live settings changes, and retained request prefixes. Background delegation and strict-template review regressions also passed. See `tests/turn-view-host.spec.ts`, `tests/memory-view-projection.spec.ts`, `tests/async-subagent-memory.spec.ts`, and `tests/review-user-turn-host.spec.ts`.

行为验证使用真实 DSH 生命周期与本地脚本模型，覆盖原生/PTC、正常/绕过组装、默认/关闭/开启、多轮、父快照隔离、多 Runtime 实例、工具权限、实时配置切换和请求前缀保持；后台委托与严格模板复盘回归也通过。此处不宣称真实模型的回答质量。
