---
"dsh-mnemon": patch
"dsh-mnemon-strategy-default-three-tier": patch
---

Explain an installed Source whose role the Layered strategy does not admit: the strategy returns `unsupported-source-role` entries in the ViewSpec, and the Host merges them into `view.diagnostics` (#504). Default composition, admission rules and budgets are unchanged.
