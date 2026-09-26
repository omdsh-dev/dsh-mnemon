---
"dsh-mnemon": patch
---

Accept an empty `branches: []` placeholder for USER add, replace, and remove calls through `mnemon_runtime_memory`. Keep non-empty USER branches rejected and preserve MEMORY branch scoping and clearing.

允许 `mnemon_runtime_memory` 在新增、替换和移除 USER 条目时携带空占位参数 `branches: []`，仍拒绝 USER 的非空分支，并保留 MEMORY 的分支范围与清空语义。
