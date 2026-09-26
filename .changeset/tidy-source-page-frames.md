---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
---

Align Runtime, Documents and Memory Spaces with the Status page frame: apply content insets and viewport height once, keep the Memory Spaces title and tabs visible during page scrolling, and reset only the owning canvas when its local tab changes. Preserve Source-owned rendering and bounded reader/dialog scroll regions.

将运行时、档案和记忆空间与状态页框架对齐：内容边距与视口高度只应用一次，页面滚动时保留记忆空间标题与 Tab，内部 Tab 切换时只重置所属 canvas。保留 Source 自有渲染以及阅读区、弹窗的有界滚动。
