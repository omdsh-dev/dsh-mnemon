---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-strategy-default-three-tier": patch
"dsh-mnemon-provider-openviking": patch
"dsh-mnemon-provider-hindsight": patch
"dsh-mnemon-provider-holographic": patch
"dsh-mnemon-provider-retaindb": patch
---

Fix existing Provider writes and search without changing the Memory Spaces UI. OpenViking writes support the 0.5.1 response and keyword searches use literal grep. Holographic preserves default trust and maps importance onto its trust scale. RetainDB sends accepted importance/types, distinguishes queued writes, and reads nested search hits. OpenViking, Hindsight and RetainDB retain their native result order through Source and Strategy budgets instead of applying unrelated score thresholds.
