---
"dsh-mnemon-provider-retaindb": patch
---

Only fall back from the current RetainDB endpoint to the legacy one on HTTP 404, so an ambiguous failure of `remember` can no longer send the same memory to the legacy endpoint a second time.
