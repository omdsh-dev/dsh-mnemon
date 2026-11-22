---
"dsh-mnemon-source-skills": patch
---

Skip ephemeral dependency and bytecode cache directories (`node_modules`, `__pycache__`, `venv`) during skill supporting-file traversal, preview, editing, backup, and restore, and include the triggering limit and largest top-level directory when a supporting-file backup exceeds 16 MiB or 1,024 files.

在技能附带文件的遍历、预览、编辑、备份与恢复中自动跳过运行时依赖和缓存目录（`node_modules`、`__pycache__`、`venv`），避免这些目录触发 16 MiB / 1,024 文件备份上限或被版本恢复误删；同时在确实超限时输出具体超限维度与占用最大的顶层目录以便排查。
