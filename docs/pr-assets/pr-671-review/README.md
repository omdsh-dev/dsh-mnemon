# PR #671: continued task title / 任务续聊标题

The completed task started with `Mnemon · Skills`. After restoring it and submitting the synthetic human topic “帮我梳理结账性能与事件摄取方案。”, the real Host title service changed it to “结账性能与事件摄取”. The screenshot crops the title, human prompt and completion state; it does not assess the scripted answer. / 任务原名为 `Mnemon · Skills`，人工续聊后由真实 Host 标题服务按话题更新；截图只展示标题、输入和完成状态。

The isolated fixture registered the task with public `workspace.attachSession`, restored it with `workspaceRegistry.unarchiveSession`, and resumed it using the configured `deepseek-official` loopback route and test preset. The initial human message was submitted through the public Host API. A restart retained the conversation and title. / 测试夹具通过官方 API 登记、恢复任务并提交合成用户输入；重启后会话与标题保留。

The screenshot includes #667's archival revision. Title generation is the Host's responsibility; production wording depends on its configured provider. Existing tests separately verify manual renames (including the same text), concurrent rename, fallback and automatic-message exclusion on rc.2 and rc.3. / 自动标题具体文案取决于用户配置；手动/并发改名、回退与自动消息排除由真实 Host 回归验证。

No product code changed in this screenshot commit. The combined rc.3 task/idle/archive/Hindsight suites passed **102 tests / 1 legacy-only skip**. See [`task-agent-session-host.spec.ts`](../../../tests/task-agent-session-host.spec.ts) (issue 670 cases).

Date / 日期: 2026-11-17. Published DSH 0.2.2-rc.3, Node 24, isolated Chrome WebUI, fictional Lumen data and a loopback scripted model; no live API or personal data.

WebUI screenshots use a local combined preview of #667 `95c6c263`, #668 `2b04bdab`, #669 `5133e704`, #671 `f89a7727` and #672 `6428a694`. They do not imply these PRs are merged. Each code revision was also verified independently. / WebUI 截图来自上述五个候选的本地组合，不表示 PR 已合并；三个修订分支均另行通过完整验证。

Harness / 验证入口: [`serve-e2e.mjs`](../../../scripts/serve-e2e.mjs), `--docs-demo`, `MNEMON_E2E_DSH=<published DSH>/lib/bin.js`. The model is scripted: screenshots verify UI/state, not answer quality. / 模型为脚本夹具，截图验证界面与状态，不作为回答质量证明。

## Screenshots / 截图

![PR 671 preview](671-task-title-continuation.jpg)
