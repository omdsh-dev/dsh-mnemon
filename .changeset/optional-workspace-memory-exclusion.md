---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
---

Add an optional workspace exclusion list in storage settings. Excluded conversations and their children skip memory injection, tools, automatic review, and writes while existing data remains readable. The default empty list preserves current behavior.

Clarify Runtime's read-only message so it does not imply that excluded workspaces still receive memory context.
