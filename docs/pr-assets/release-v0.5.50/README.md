# v0.5.50 release acceptance

[简体中文](./README.zh-CN.md) | **English**

On November 20, 2026, 9 published DSH hosts installed the candidate through **Plugins → Add plugin** and upgraded a separate v0.5.49 profile through **Memory System → Status → Versions → Update**.

`0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.5`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5`

All 18 profiles matched the 19 pinned package versions and verified 197 files in the five candidate tarballs, including executable permissions. Each upgraded profile retained a pinned synthetic Runtime entry after fully restarting DSH. Its `memories.json`, `MEMORY.md` and `USER.md` SHA-256 digests matched their pre-upgrade values.

The installed-Host suite on DSH `0.2.2-rc.5` passed 2,891 tests with 9 conditional skips. The [validation record](./validation.json) identifies the tested candidate, test environments and tarball digests.
