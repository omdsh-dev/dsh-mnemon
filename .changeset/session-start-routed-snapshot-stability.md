---
"dsh-mnemon": patch
---

Keep `runtimeMemory.snapshotRefresh: "session-start"` frozen snapshots stable across routed Project Document (`dsh-mnemon.documents/v1`) and Memory Space (`dsh-mnemon.memory-spaces/v1`) content/catalog revisions so background idle reviews and cross-session writes do not retire open-session snapshots or invalidate prompt prefix caches, while keeping `on-change` mode and all authority, workspace, route, action, eager-projection, branch-visibility, and compaction boundaries fail-closed.
