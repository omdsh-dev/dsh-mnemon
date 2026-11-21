# v0.5.51 release acceptance

[简体中文](./README.zh-CN.md) | **English**

On November 22, 2026, nine published DSH hosts installed the candidate through **Plugins → Add plugin** and upgraded separate v0.5.50 profiles through **Memory System → Status → Versions → Update**.

`0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.5`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5`

All 18 profiles matched the 19 pinned packages and verified 143 files against the three packed candidates, including executable modes. Every upgraded profile retained a pinned synthetic Runtime entry after restarting DSH. The SHA-256 digests of its source and Markdown projections matched their pre-upgrade values.

The installed-Host suite on DSH `0.2.2-rc.5` passed 2,906 tests with 9 conditional skips. The Starter packed to 627,093 bytes and unpacked to 2,656,160 bytes, under its 3,000,000-byte limit. [Candidate digests and results](./validation.json)

[Fresh install version check](./rc5-fresh-version.png) · [Pinned Runtime entry after upgrade and restart](./rc5-upgraded-runtime.png)
