---
"dsh-mnemon": patch
---

Make the legacy `mnemon` entry an atomic Starter lifecycle switch so disabling
it also disables every bundled Source and Strategy instead of blocking DSH on
pending `mnemonMemory` consumers.
