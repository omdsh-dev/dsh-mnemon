---
"dsh-mnemon": patch
---

Isolate text-only delegated subagents (including skill draft, review, and eval tasks) from coding presets, `run_code`, and own-scope tools: skip mounting the default coding preset on skill task Agents, switch text-only children to native tool presentation when supported, enforce per-call execution-time tool allowlist guards across delegated children, and confine text-only tasks and children to `read-only` sandbox mode with `never` approval policy.

隔离纯文本委派子 Agent（含技能草案、复盘与评测任务）与编码 preset、`run_code` 及子作用域工具：技能任务 Agent 不再挂载默认编码 preset，在宿主支持时为纯文本子 Agent 切回原生工具呈现，对委派子 Agent 统一启用执行期按次工具白名单守卫，并将纯文本任务及子 Agent 的沙箱与审批策略收敛为 `read-only` 与 `never`。
