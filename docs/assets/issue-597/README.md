# Memory composer acceptance / 记忆标签输入框验收

Captured from this branch in Chrome, using published DSH 0.2.2-rc.1 and 0.2.1-rc.5. `scripts/serve-e2e.mjs --skills-scroll` creates isolated profiles, 24 fictional skills and a loopback model stub. No personal profile, real API key, or cloud model was used. These are WebUI checks; no Desktop installation was modified.

截图来自本分支在 Chrome 中运行的正式 DSH 0.2.2-rc.1 和 0.2.1-rc.5。`scripts/serve-e2e.mjs --skills-scroll` 创建隔离 profile、24 个虚构技能和本地模型桩。未使用个人 profile、真实 API key 或云模型，也未修改 Desktop 安装。

| Evidence / 证据 | Result / 结果 |
|---|---|
| [rc1-collapsed.png](rc1-collapsed.png) | Memory collapses the composer; the 24th skill and its controls remain reachable. / 记忆标签收起输入框，第 24 个技能及其操作仍可访问。 |
| [rc1-expanded-draft.png](rc1-expanded-draft.png) | Expanding restores the multiline draft; a 288 px composer reserves 304 px beneath Memory content. / 展开后多行草稿保留；288 px 高的输入框对应 304 px 底部留白。 |
| [rc1-chat-restored.png](rc1-chat-restored.png) | Chat restores the original editor. Use skill expands it and prepends the slash invocation without dropping the draft. / 切回对话恢复原编辑器；使用技能会展开输入框并添加斜杠指令，原草稿保留。 |
| [rc5-expanded.png](rc5-expanded.png) | DSH 0.2.1-rc.5 preserves the expanded preference and draft across reload. / DSH 0.2.1-rc.5 刷新后保留展开偏好和草稿。 |

Regression coverage also checks pending approvals/questions/plans, another session, split panes, missing or late slot declarations, blocked browser storage, external preference changes, and view cleanup. A wiring regression fails against the original `workspace-mount.tsx` (no composer owner acquired) and passes with the change. Pending interactions and split-pane fallback are automated checks, not screenshots of live approval flows.

回归用例同时覆盖待处理审批、问题与计划，其他会话、分栏、缺失或延迟声明的插槽、浏览器存储不可用、其他窗口偏好变化以及页面卸载。将 `workspace-mount.tsx` 恢复到修改前时，集成回归因未取得输入框归属而失败；修复后通过。待处理交互和分栏回退通过自动化验证，未声称截图覆盖真实审批流程。

The existing input stays available on Hosts without the public composer chain and when multiple conversation panes make session-only ownership ambiguous. Dynamic spacing uses the owning composer seat; if the Host exposes no seat marker, existing spacing remains. No memory, model routing, skill contents, provider configuration or server-side storage is changed.

Host 缺少公开输入框链式插槽，或多个会话分栏使仅靠会话 ID 无法确定归属时，保留现有输入框。动态留白读取所属输入框的高度；Host 不提供座位标记时保留原有留白。记忆内容、模型路由、技能内容、Provider 配置和服务端存储均不变。
