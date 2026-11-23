---
"dsh-mnemon": patch
---

Surface the redacted last failed tool call detail when a delegated memory subagent or standalone idle review completes without recording its structured result, redact stopped diagnostics on standalone reviews, preserve managed review turn-end error details when `diagnostic` is omitted, and map `blocked` isolated review endings to `refusal`.

当委派记忆子 Agent 或独立空闲复盘在未记录结构化结果的情况下结束时，附加脱敏后的最后一次失败工具调用详情；对独立复盘的停止诊断信息统一脱敏，在托管独立复盘省略 `diagnostic` 时保留 `turn/end` 错误详情，并将 `blocked` 结束原因映射为 `refusal`。
