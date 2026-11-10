---
"dsh-mnemon": patch
---

Recover Windows Git sync mirrors containing read-only pack files by making only the disposable mirror tree writable before bounded cleanup retries. Keep linked targets, local memory and repository-origin isolation intact.
