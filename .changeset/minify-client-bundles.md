---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-source-skills": patch
"dsh-mnemon-source-documents": patch
"dsh-mnemon-source-runtime": patch
---

Tree-shake unused Memory Spaces graph components out of the Starter client bundle and minify browser `lib/client.js` artifacts across `dsh-mnemon` and its four shipped Source plugins to reduce synchronous client parse and evaluation overhead.

从 Starter 客户端产物中移除未使用的记忆空间图谱组件死代码，并对 `dsh-mnemon` 及四个内置 Source 插件的浏览器端 `lib/client.js` 启用压缩，以降低前端同步解析与求值开销。
