---
"dsh-mnemon": patch
---

Bound session-log reads and update history projections incrementally to avoid full transcript snapshots during conversation switching, memory activity refreshes, and delegated tasks. Preserve historical receipts, skill use, and completed-turn evidence.

限制会话日志读取范围，并增量更新历史统计，避免切换会话、刷新记忆活动和执行委托任务时生成完整日志快照；保留历史工具凭据、技能使用记录和已完成轮次的证据。
