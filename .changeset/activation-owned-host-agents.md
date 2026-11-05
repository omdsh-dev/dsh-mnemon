---
"dsh-mnemon": patch
---

Preserve memory and Skills agents on the inspected DSH master snapshot after ownership, activation and provider-enumeration APIs changed. Keep first-step guards, model routing, isolated contexts, cancellation and completed-task protection. Official 0.2.2-rc.1 retains hidden tasks; the newer Host exposes titled Mnemon task records through ACP, while its standard WebUI currently hides task roots without conversation turns. Standard configured providers are discovered automatically; opaque custom providers can be named with `subagentProviderNames`.

适配已检查的 DSH master 快照中归属、activation 与 Provider 枚举契约的变化，保留记忆和 Skills Agent、首步守卫、模型路由、上下文隔离、取消及已完成任务保护。官方 0.2.2-rc.1 继续隐藏内部任务；新版 Host 的 ACP 可列出带名称的 Mnemon 任务记录，标准 WebUI 当前仍隐藏未开始对话轮次的任务根。标准配置的 Provider 自动发现，名称未公开在配置中的自定义 Provider 可通过 `subagentProviderNames` 指定。
