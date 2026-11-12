---
"dsh-mnemon": patch
---

Raise the default idle-review output budget from 4096 to 16384 tokens so a review of a full bounded checkpoint can finish and record its result instead of stopping at max-tokens. The configured idleReview.maxTokens remains honored, and the default is now the same comfortable budget a skill draft gets.

将空闲审查的默认输出预算从 4096 提升到 16384 token，使完整有界检查点的审查能够完成并记录结果，而不会在 max-tokens 处停止。仍遵循配置的 idleReview.maxTokens，默认值现与技能草稿使用相同的宽裕预算。
