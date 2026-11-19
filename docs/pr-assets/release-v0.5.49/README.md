# v0.5.49 release acceptance

[简体中文](./README.zh-CN.md) | **English**

On November 20, 2026, 9 published DSH hosts installed the candidate through **Plugins → Add plugin** and upgraded a separate v0.5.48 profile through **Memory System → Status → Versions → Update**.

`0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.5`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5`

All 18 profiles matched the 19 pinned packages. Each profile matched the candidate tarballs across 126 files, including their executable bits. After a full Host restart, each upgraded profile showed its synthetic pinned Runtime entry. The three Runtime files matched their pre-upgrade SHA-256 digests.

The complete installed-Host suite on DSH 0.2.2-rc.5 passed 2,888 tests with 9 conditional skips. The [validation record](./validation.json) contains candidate package hashes, sizes and the tested environments.
