---
"dsh-mnemon": patch
---

Add opt-in `runtimeMemory.snapshotRefresh` (`on-change` default, `session-start` opt-in) to freeze an open conversation's initial runtime memory snapshot across routine storage updates for prompt-cache stability, while keeping new sessions, live tools, and authority/branch/exclusion/compaction boundaries up to date.
