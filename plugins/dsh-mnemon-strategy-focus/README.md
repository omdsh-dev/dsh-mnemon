# Focused context / 专注上下文

An optional enhancement for `dsh-mnemon-strategy-workspace`. It selects existing Source instance keys in priority order, optionally limits writable Sources, and caps projected context. It owns no storage, reads no files, and grants no external authority.

Configure it in Settings → Memory → Composition settings. Unset `sourceKeys` selects the installed Sources; an explicit empty list selects none. Unset `writableSourceKeys` preserves existing permissions; an empty list creates a read-only View. Writable keys must be a subset of selected keys. `maxProjectionCharacters` defaults to 8192, bounded to 1–65536 and further limited by the Host budget. Removing this enhancement restores the workspace Strategy's normal selection.

With many Sources, configure the Host's generic `memoryTopology.viewBudget.maxRoutes` and `maxActions` as appropriate (defaults 16; supported range 1–128). Increasing this budget makes more existing operations available; Source permissions, per-route call limits and external approval remain in force. The isolated development profile uses 96 for each.

## 中文

这是 `dsh-mnemon-strategy-workspace` 的可选增强插件，用已有 Source 实例键定义优先顺序、写入子集和上下文长度。插件没有存储、文件读取或外部操作权限。

在「设置 → 记忆系统 → 组合策略配置」中设置。`sourceKeys` 未设置时选择已安装的 Source，明确留空则不选择任何 Source。`writableSourceKeys` 未设置时保留原有权限，明确留空使 View 只读；写入集合必须属于参与集合。`maxProjectionCharacters` 默认 8192，范围 1–65536，仍受 Host 总预算限制。卸载该增强插件后恢复工作区策略的常规选择。

Source 较多时，可调整 Host 通用配置 `memoryTopology.viewBudget.maxRoutes` 和 `maxActions`（默认 16，范围 1–128）。扩展预算会提供更多已有操作，但不改变 Source 权限、单路由调用次数或外部操作审批。独立开发配置中两项均为 96。
