# Issue #574: skill origins / 技能来源

These screenshots show this PR's built code in the published DSH `0.2.1-rc.5` Web UI on macOS, with Node `24.22.2`. The starting revision is `0db25213d128dfeb420163de20fd41a787366c87` (`0.5.41`). They were captured from Chrome using a disposable `serve-e2e.mjs --docs-demo=en` profile on port `19147`; the user's running profile was not used.

截图来自本 PR 构建后的代码，运行于 macOS、Node `24.22.2` 和正式发布的 DSH `0.2.1-rc.5` Web UI。起始版本为 `0db25213d128dfeb420163de20fd41a787366c87`（`0.5.41`）。通过 `serve-e2e.mjs --docs-demo=en` 启动端口 `19147` 的临时配置，并在 Chrome 中截图；未使用用户正在运行的配置。

## Setup and observed result / 设置与实际结果

1. A temporary origin project, another project and the user skill root each contain a different `workspace-audit/SKILL.md`. The review suggestion is admitted through the production Skills Source management API while scoped to the origin project.
2. With the browser on **Global** storage and a different active workspace, the suggestion opens the origin project's actual path and body; draft generation is enabled. See [global-suggestion.jpg](./global-suggestion.jpg).
3. A synthetic draft is recorded through the production management API with no caller workspace. **Adopt** is then clicked in the real browser. The **Done** view shows **Adopted** and the original file's new third step. See [global-adopted.jpg](./global-adopted.jpg).
4. File hashes prove only the origin file changed; the same-name user and other-project files stayed unchanged. See [validation.json](./validation.json).
5. A separate synthetic manual project draft has its `origin` removed to represent a pre-upgrade record with no linked suggestion. The UI retains its content, disables adoption and gives the original-workspace regeneration instructions. See [legacy-recovery.jpg](./legacy-recovery.jpg).

1. 原项目、另一个项目和用户技能目录各自包含不同的 `workspace-audit/SKILL.md`。使用正式 Skills Source 管理 API，在原项目范围内记录复盘建议。
2. 浏览器选择**全局**存储且当前工作区不同，建议仍展示原项目文件的实际路径与正文，并可生成草案，见 [global-suggestion.jpg](./global-suggestion.jpg)。
3. 通过正式管理 API，在不提供当前工作区的情况下记录合成草案。随后在真实浏览器点击**采纳**，**已处理**视图显示**已采纳**及原文件新增的第三步，见 [global-adopted.jpg](./global-adopted.jpg)。
4. 文件哈希验证仅原文件改变，用户目录和另一个项目的同名技能未变，见 [validation.json](./validation.json)。
5. 另一个合成的手工项目草案移除 `origin`，模拟没有关联建议的升级前记录。页面保留正文、禁用采纳，并提示在原工作区重新生成，见 [legacy-recovery.jpg](./legacy-recovery.jpg)。

## Validation and limits / 验证与限制

`pnpm run verify` passed: root tests **2551 passed / 8 skipped**; standalone plugins **775 passed / 3 skipped**, including all **111** Skills Source tests. It also passed documentation validation, deterministic build comparison, type checks, Headless activation/restart, package entry checks and package lint. Skips are existing opt-in live-model, Native CLI, Windows and OpenViking integrations, plus a Host compatibility case inapplicable to the installed DSH contract. Existing DSH source-map warnings remain. The first verification attempt caught a TypeScript error in a newly added refusal test; it was fixed before the full passing run.

`pnpm run verify` 全部通过：根测试 **2551 通过 / 8 跳过**，独立插件 **775 通过 / 3 跳过**，其中 Skills Source **111 项全部通过**。文档、确定性双构建、类型检查、Headless 激活和重启、包入口与包检查均通过。跳过项是既有的可选真实模型、Native CLI、Windows、OpenViking 集成，以及不适用于已安装 DSH 契约的一项 Host 兼容测试。既有 DSH source-map 警告仍存在。第一次全量验证发现新增拒绝路径测试的一处 TypeScript 错误，修正后重新执行全量验证通过。

Regression tests were observed failing before their fixes. They cover original-file detail/diff/adoption after restart and across scopes, same-name project/root separation, missing files, exact legacy review-trajectory recovery, ambiguous legacy refusal, malformed metadata, confirmed management/revision checks, and Host redraft/baseline forwarding. No model View grants were added.

回归测试在修复前确实失败，覆盖重启及跨范围的原文件详情、差异和采纳，同名项目与目录隔离、文件缺失、精确旧复盘轨迹恢复、来源不明旧记录的拒绝、畸形元信息、管理确认及 revision 校验，以及 Host 重写与基线回测传递。未增加模型 View 授权。

All records and skill contents here are synthetic. Draft generation and baseline/backtest forwarding are covered by deterministic Host tests; this browser run seeded the draft and did not call a paid live model. The reporter's Windows installation was not available. Legacy manual project drafts without origin metadata or a recoverable linked suggestion need one regeneration from the original skill; their existing draft text is retained. No migration or guessed same-name destination is used.

这里的记录和技能内容均为合成数据。草案生成及基线回测传递通过确定性 Host 测试覆盖；浏览器验证预先记录草案，没有调用付费真实模型。未取得报告者的 Windows 环境。缺少来源信息且没有可恢复关联建议的旧手工项目草案，需要从原技能重新生成一次，原草案正文会保留；不会迁移或猜测同名目标。
