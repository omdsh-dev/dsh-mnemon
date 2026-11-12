# v0.5.45 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-13 (Asia/Shanghai)** using isolated macOS arm64 / Node 24.22.2 Web profiles and synthetic data. **All 12 scenarios pass:** fresh installation and real npm **0.5.44 → 0.5.45** upgrade on six published DSH versions, including **0.2.2-rc.2**. No paid-model calls or personal Desktop data were used.

| DSH | Fresh installation | Upgrade | After full restart |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-memory-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-memory-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-memory-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-memory-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |
| 0.2.2-rc.2 | [Add](./022rc2-fresh-add.png) / [Ready](./022rc2-fresh-status.png) | [Before](./022rc2-upgrade-memory-before.png) / [Offer](./022rc2-upgrade-offered.png) / [Updated](./022rc2-upgrade-updated.png) | [Version](./022rc2-upgrade-restarted.png) / [Retained](./022rc2-upgrade-retained.png) |

Fresh profiles install with **Plugins → Add plugin → Enable now**. Upgrade profiles first install npm 0.5.44, add a working-memory record and a user-profile record, and pin the working memory through the UI. **Status → Check versions → Update** offers 0.5.45 plus the Skills component update. After a full Host restart, every upgrade displays version 0.5.45, both records and the pin.

Each final installation matches **19 exact package versions and 103 candidate file contents/executable modes**. Across 12 profiles, that is **228 version checks and 1,236 file/mode checks**. All six upgrades preserve the exact hashes of `memories.json`, `MEMORY.md` and `USER.md` before installation, after installation and after restart. [validation.json](./validation.json), per-Host records, [candidate manifest](./candidate-manifest.json) and [candidate files](./candidate-files.json) contain the evidence.

## Verification

- Workspace tests: **897 passed / 4 conditional skips**. Root tests: **2,739 passed / 9 conditional skips**. Documentation, types, deterministic builds, Headless activation and package checks pass.
- Published DSH 0.2.2-rc.2 full suite: **2,740 passed / 8 conditional skips**.
- Independent-package verification: **18 plugin repositories and 19 packed artifacts** pass, including public SDK-only composition, Client tests, Starter activation and optional Strategies.
- The initial concurrent root run hit the existing 5-second virtual-clock backtest deadline timeout. The unchanged test file passed **77/77** alone; the complete root suite then passed with two workers. No assertion or timeout was changed.
- **42 actual UI screenshots** show installation, upgrade and retention. rc.2 and oldest-Host status/retention screens were visually checked; browser assertions check all six versions and retained entries.
- Starter: **71 files, 558,454 compressed bytes, 2,336,866 unpacked bytes**; 77.9% of the existing 3,000,000-byte ceiling, so no ceiling increase is needed.

Candidate revision: `dc9e03176632a282c76c7faee0e1518312018ec2`; prior release: `455dd1c017d82c4f75af1b9510d383c059b0690e`. The two tested tarballs are byte-identical after aligning the release branch with merged main. Subsequent commits add documentation/evidence only. Publication freezes final main and compares its artifacts with this tested candidate.

## Scope and reproduction

These are Web-profile checks, not native Desktop OS integration or cloud-model quality measurements. No arbitrary master/alpha compatibility is claimed. The loopback registry serves immutable candidate tarballs and ages only candidate metadata; real npm minimum-release-age behavior is outside this acceptance. The old Host's optional API-key onboarding is dismissed through **Configure later**. Browser and Host fixtures are stopped after use.

The higher idle-review default is configurable, but Hosts do not universally clamp it to model output limits. Smaller-capacity models require an explicit supported `idleReview.maxTokens`; this release does not add automatic adaptation.

```sh
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-state>
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-upgrade-state> --previous dsh-mnemon@0.5.44
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state <state> --artifacts <frozen-candidates> --baseline <before.json> --output <after.json>
```
