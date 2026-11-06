# v0.5.42 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-06 (Asia/Shanghai)** with isolated profiles and synthetic data. **Twelve scenarios passed:** fresh installation and real npm **0.5.41 → 0.5.42** upgrade on five official Hosts and the exact unmodified source commit reported in #554. No paid model calls or personal Desktop data were used.

## Installation and upgrade results

| DSH | Fresh | Before upgrade | Offered update | Installed, restart needed | After restart | Preserved memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Status](./020-fresh-status.jpg) | [Memory](./020-upgrade-memory-before.jpg) | [Offer](./020-upgrade-offered.jpg) | [Updated](./020-upgrade-updated.jpg) | [Status](./020-upgrade-restarted-status.jpg) | [Memory](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Status](./rc2-fresh-status.jpg) | [Memory](./rc2-upgrade-memory-before.jpg) | [Offer](./rc2-upgrade-offered.jpg) | [Updated](./rc2-upgrade-updated.jpg) | [Status](./rc2-upgrade-restarted-status.jpg) | [Memory](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Status](./rc3-fresh-status.jpg) | [Memory](./rc3-upgrade-memory-before.jpg) | [Offer](./rc3-upgrade-offered.jpg) | [Updated](./rc3-upgrade-updated.jpg) | [Status](./rc3-upgrade-restarted-status.jpg) | [Memory](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Status](./rc5-fresh-status.jpg) | [Memory](./rc5-upgrade-memory-before.jpg) | [Offer](./rc5-upgrade-offered.jpg) | [Updated](./rc5-upgrade-updated.jpg) | [Status](./rc5-upgrade-restarted-status.jpg) | [Memory](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [Status](./rc1-fresh-status.jpg) | [Memory](./rc1-upgrade-memory-before.jpg) | [Offer](./rc1-upgrade-offered.jpg) | [Updated](./rc1-upgrade-updated.jpg) | [Status](./rc1-upgrade-restarted-status.jpg) | [Memory](./rc1-upgrade-memory-preserved.jpg) |
| `fcc0ad4` (source) | [Status](./master-fresh-status.jpg) | [Memory](./master-upgrade-memory-before.jpg) | [Offer](./master-upgrade-offered.jpg) | [Updated](./master-upgrade-updated.jpg) | [Status](./master-upgrade-restarted-status.jpg) | [Memory](./master-upgrade-memory-preserved.jpg) |

Fresh installs used **Plugins → Add plugin → Enable now**. Upgrades began with the real npm package and two synthetic records created through the Runtime UI: one working memory and one user profile. **Status → Check versions → Update** offered the Starter and three changed components. Each full Host restart then ran **0.5.42** and retained both records. The master case used the same UI update path; no copying of canary files or CLI recovery was needed.

Every final profile matched **19 pinned package versions and 138 files plus executable bits** in the four selected candidates. All three Runtime files (`memories.json`, `MEMORY.md`, `USER.md`) existed and had identical hashes before update, after install and after restart. A separate read-only audit of all twelve retained profiles again matched **228 versions and 1,656 candidate files and executable bits**, including all six memory-retention baselines.

## Verification and frozen artifacts

- Node **24.22.2**, macOS arm64: complete `pnpm run verify` passed, with **2,625 root tests passed / 8 conditional skips** and **792 workspace tests passed / 3 conditional skips**. Documentation, types, deterministic builds, Headless activation and package checks passed.
- **18 independent plugin repositories and 19 packed artifacts** passed standalone type/test/build and actual Host activation, including optional Strategies.
- **40 screenshots** were visually reviewed by their capture agents, checked against their recorded SHA-256 and dimensions, and sampled again during integration. Application-origin browser errors were zero; third-party extension error counts are recorded separately without extension identities.
- Starter: **68 files, 543,227 packed bytes, 2,276,189 unpacked bytes**, **75.9%** of the 3,000,000-byte ceiling. No ceiling adjustment was needed.

Candidates were frozen at **`22357a693264ad88e50476e99af9c7ee60233bc3`**: Starter **0.5.42**, Documents **0.6.0**, Runtime **0.5.18**, Skills **0.5.9**. The other fifteen components retain immutable npm versions; all eighteen Starter components are pinned exactly. [validation.json](./validation.json) contains composition, package digests, screenshot digests and aggregate results. Per-Host records: [020](./020-validation.json), [rc2](./rc2-validation.json), [rc3](./rc3-validation.json), [rc5](./rc5-validation.json), [rc1](./rc1-validation.json), [master](./master-validation.json).

The exact extra source is **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`** (UI `0.2.2-rc.1-fcc0ad4`); its tree remained unmodified. Runtime prefix/checkpoint behavior is covered by the separate [#573 record](../issue-573-runtime-snapshots/README.md), including native/PTC requests and five Host snapshot suites. This release acceptance does not measure cloud KV-cache hits.

The reusable fixture is [`scripts/serve-release-acceptance.mjs`](../../../scripts/serve-release-acceptance.mjs), with variables bound to isolated resources:

```sh
pnpm run verify
MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build
pnpm release:check
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$FRESH_STATE"
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$UPGRADE_STATE" --previous dsh-mnemon@0.5.41
```

## Observations and limits

Some initial screenshots clip a status label or memory row at Chrome's native viewport. The complete rendered accessibility text and actual files were checked. RC3/RC5 final version-dialog and two-record screenshots were additionally captured by reopening the same upgraded profiles with the same verified candidates; their records describe this extra read-only step. All owned fixtures, Hosts and browser tabs were closed. The user's existing preview was not used.

The #579 feature CI required one rerun of the original RC3 job after an existing subagent test's cleanup hook reached ten seconds. The fixture does not start the snapshot lifecycle. Its 159 tests passed locally; the original Linux/Node 22.19 job then passed at the unchanged head. The cleanup sub-step responsible was not established, and no timeout or product code was changed for the rerun.

These are Web-profile checks on macOS, not native Desktop OS integration or the reporter's Windows environment. The extra source coverage applies only to the named commit, not arbitrary master/alpha versions. Live cloud-model quality and provider cache persistence were not retested. Candidate metadata is aged only inside the fixture, so npm minimum-release-age behavior is outside this test. Publication separately freezes the final merged revision, publishes the dependency layers, verifies real Registry installation and upgrade, and creates the GitHub Release only after those gates pass.
