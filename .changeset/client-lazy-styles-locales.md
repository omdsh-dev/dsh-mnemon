---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-source-skills": patch
"dsh-mnemon-source-documents": patch
"dsh-mnemon-source-runtime": patch
---

Compact multi-locale translation tables into deduplicated key arrays with lazy per-locale materialization and defer client CSS `<style>` injection to first class access with deterministic cascade ordering across `dsh-mnemon` and its four shipped Source plugins.

将 `dsh-mnemon` 及四个内置 Source 插件的客户端多语言表压缩为去重键表并按需惰性构建当前语言字典，同时将客户端 CSS `<style>` 注入延迟至首次访问样式类时按确定级联顺序执行。
