---
'dsh-mnemon': patch
---

perf: reuse one idle-review owner session instead of creating a new one per review, so archived event-free owner sessions no longer accumulate on disk and slow DSH's session list.
