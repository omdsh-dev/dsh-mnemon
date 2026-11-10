# v0.5.44 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-11 (Asia/Shanghai)** with isolated macOS arm64 / Node 24.22.2 Web profiles and synthetic data. **All ten scenarios pass:** fresh installation and real npm **0.5.43 → 0.5.44** upgrade on each of five published DSH Hosts. No paid-model calls or personal Desktop data were used.

| DSH | Fresh installation | Upgrade | After full restart |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-memory-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-memory-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-memory-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-memory-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |

Fresh profiles use **Plugins → Add plugin → Enable now**. Upgrade profiles first install the real npm 0.5.43 release, then create one working memory, pin it, and create one user-profile memory through the UI. **Status → Check versions → Update** offers 0.5.44 and two component updates. Every restarted profile runs 0.5.44 and displays both original records and the pin.

Each final installation matches **19 exact versions and 148 candidate file contents/executable modes**. Across ten profiles, that is **190 version checks and 1,480 file/mode checks**. In all five upgrades, `memories.json`, `MEMORY.md` and `USER.md` have identical hashes before installation, after installation and after restart. See [validation.json](./validation.json), the five per-Host records, [candidate manifest](./candidate-manifest.json), [candidate files](./candidate-files.json) and the existing [read-only audit script](../release-v0.5.43/audit-installed.py).

## Verification and artifacts

- `pnpm run verify`: **2,706 root tests pass / 8 conditional skips**; **895 workspace tests pass / 4 conditional skips**. Documentation, types, deterministic builds, Headless activation, public entry points and package checks pass.
- `MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build`: **18 independent plugin repositories and 19 packed artifacts** pass, including external composition, actual Starter installation and optional Strategy activation.
- One intermediate six-PR run hit the existing 5-second virtual-clock backtest-deadline timeout. The unchanged file passed **77/77** in isolation; the final complete verification passed without raising timeouts. Both integrated PR heads also passed their full CI before merge.
- Starter: **71 files, 557,190 compressed bytes, 2,331,737 unpacked bytes**, 77.7% of the existing 3,000,000-byte limit. No limit increase was needed.
- **35 screenshots** document the actual UI steps. The recorded DOM confirms versions, installation success, both memories and their pin. Status and retained-memory screenshots from 0.2.0-rc.2 and 0.2.2-rc.1 were visually spot-checked.

Candidate revision: `629bf040e1b8c22cde2663e33866c6c1f207f545`; previous release: `e9da7d1d717737defc088ac9afd32c4ca99ff9ef`. Later release commits only align merge ancestry and add documentation/evidence; candidate package sources remain unchanged. Publication freezes final main and compares its CI artifacts with this candidate before approving `npm-release`.

## Scope and reproduction

This covers Web profiles, not native Desktop OS integration or cloud model/provider quality and cache performance. The previous disposable source checkout was no longer available, so this run does not repeat the earlier fixed-source-build acceptance or claim support for arbitrary master/alpha revisions. The loopback fixture ages only candidate metadata and does not test real npm minimum-release-age behavior. It never changes the user's Desktop profile. Owned fixtures and tabs are stopped after acceptance.

```sh
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-state>
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-upgrade-state> --previous dsh-mnemon@0.5.43
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state <state> --artifacts <frozen-candidates> --baseline <before.json> --output <after.json>
```
