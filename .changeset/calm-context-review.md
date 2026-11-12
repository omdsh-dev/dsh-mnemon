---
"dsh-mnemon": patch
---

Skip idle review and observer installation on disposed Agent contexts, and treat inactive-context review errors without committed writes as cancellation. Preserve partial-write evidence and existing review quota reservations.

跳过已销毁 Agent 上的空闲审查和监听器安装，将没有已提交写入的上下文失效错误视为取消；保留部分写入证据和已有审查配额预留。
