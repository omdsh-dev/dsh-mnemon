---
"dsh-mnemon": patch
---

Allow idle-review preflight admission to complete when DSH native Auto Review (`auto` permission preset) is active on a host with batch tool execution and scoped guard checks by checking agent-scoped tool visibility and guards (`tools.executable` / `tools.get` and `tools.checkGuards`) alongside a standalone unattached host probe, avoiding orphan `tool/ptc-dispatch-start` records and `AUTO_REVIEW_FAILED` missing-root-call rejections while keeping Auto Review active on the background review Agent's actual tool calls.

修复支持批量执行和作用域守卫的 DSH 宿主启用原生 Auto Review（`auto` 权限预设）时闲时审查启动前检查因缺少外层 `tool/call` 记录而失败的问题：先校验 Agent 作用域的工具可见性与守卫（`tools.executable` / `tools.get` 及 `tools.checkGuards`），再以不绑定会话的独立宿主探测验证执行链路，避免产生孤儿 `tool/ptc-dispatch-start` 记录和 `AUTO_REVIEW_FAILED` 报错，同时保持后台审查子 Agent 的实际工具调用继续受 Auto Review 与工具限制约束。
