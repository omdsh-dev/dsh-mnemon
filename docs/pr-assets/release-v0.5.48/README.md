# v0.5.48 release acceptance

[简体中文](./README.zh-CN.md) | **English**

On November 18, 2026, eight published DSH versions each installed v0.5.48 through **Plugins → Add plugin** and updated a separate v0.5.47 Web profile through **Memory System → Status → Versions → Update**. Each upgraded Host restarted and displayed its existing pinned Runtime entry. The three Runtime files matched their pre-upgrade SHA-256 digests.

| Host series | Releases tested |
| --- | --- |
| DSH 0.2.0 | rc.2 |
| DSH 0.2.1 | rc.2, rc.3, rc.5 |
| DSH 0.2.2 | rc.1, rc.2, rc.3, rc.4 |

All 16 installations matched the 19 pinned versions. For the three changed packages, all 154 files per profile matched the candidate file list, content and executable bits. The rc.4 installed-Host suite passed 2,858 tests with nine conditional skips.

An initial Headless run on rc.4 used the harness default of v0.5.29. That older Starter failed to initialize its Runtime data before the candidate was installed. Users coming from v0.5.29 should update Mnemon on their existing DSH before changing Hosts. The Web upgrade cases above all started from v0.5.47.

The macOS arm64 Web profiles used Node 24.22.2, pnpm 10.13.1 and synthetic data. A loopback registry served the three candidates and forwarded requests for published packages to npm. Candidate SHA-512 values and package sizes are in the [validation record](./validation.json). The [per-file audits](https://github.com/omdsh-dev/dsh-mnemon/releases/download/v0.5.48/v0.5.48-acceptance.tar.gz) include the package manifest, a file list and SHA-256 checksums.

[Update offered on rc.4](./rc4-upgrade.jpg) · [Pinned memory after restart](./rc4-retained.jpg)
