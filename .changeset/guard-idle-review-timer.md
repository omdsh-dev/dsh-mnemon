---
"dsh-mnemon": patch
---

Guard `idleReviewBlockReason` and the idle review timer callback so `UNAUTHORIZED` or unexpected errors during background review checks fail closed cleanly without crashing the DSH Host.
