---
"dsh-mnemon": patch
---

Reject workspace paths below a regular file on Windows before computing their storage identity, while preserving existing file identities, symlink aliases, Unicode names and missing directory descendants.
