---
"dsh-mnemon": patch
---

Give skill drafts configurable 32k initial and 64k retry output budgets. Regenerate once under a fresh task after truncation only when the explicit retry budget is larger, discard partial output, and report attempted budgets and source file size with provider-limit guidance. Keep other skill operations and adoption unchanged.

技能草案新增可配置的首次 32k 与重试 64k 输出预算。仅在截断且显式重试预算更大时使用新任务重新生成一次，丢弃不完整输出，并报告尝试预算、原文件大小和模型提供方上限建议。其他技能操作与采纳流程保持不变。
