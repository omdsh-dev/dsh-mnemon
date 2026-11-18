---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
---

Add an opt-in Basic compaction backend that keeps normal Runtime corrections and deletions append-only until DSH compacts the session. Filter Runtime snapshot text from compaction summaries and keep immediate retirement on authority changes.

提供默认关闭的压缩后端。普通运行时记忆更正和删除只追加，旧快照在 DSH 压缩会话时清理。压缩生成摘要前过滤 Runtime 快照，权限变化时仍即时清理。
