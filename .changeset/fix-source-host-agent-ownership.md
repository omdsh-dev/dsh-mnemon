---
"dsh-mnemon": patch
---

Adapt Agent lifecycle and guarded memory delegation to source DSH 0.2.2 runtime ownership, while preserving the published Host APIs. Verify exact live direct-creator ownership before adopting roots or children, and cancel Mnemon-started admission when a deferred publication hook fails. Refuse unsupported source-only standalone management before Session creation; these operations remain available on published Hosts.
