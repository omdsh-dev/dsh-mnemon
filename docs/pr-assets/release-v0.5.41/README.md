# v0.5.41 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-05 (Asia/Shanghai)** with isolated profiles and synthetic data. **Twelve scenarios passed:** fresh installation and real npm **0.5.40 → 0.5.41** upgrade on five official Hosts, plus the exact unmodified source commit reported in #554. No paid model calls or personal Desktop data were used.

## Official Host results

| DSH | Fresh | Before upgrade | Offered update | Installed, restart needed | After restart | Preserved memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Status](./020-fresh-status.jpg) | [Memory](./020-upgrade-memory-before.jpg) | [Offer](./020-upgrade-offered.jpg) | [Updated](./020-upgrade-updated.jpg) | [Status](./020-upgrade-restarted-status.jpg) | [Memory](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Status](./rc2-fresh-status.jpg) | [Memory](./rc2-upgrade-memory-before.jpg) | [Offer](./rc2-upgrade-offered.jpg) | [Updated](./rc2-upgrade-updated.jpg) | [Status](./rc2-upgrade-restarted-status.jpg) | [Memory](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Status](./rc3-fresh-status.jpg) | [Memory](./rc3-upgrade-memory-before.jpg) | [Offer](./rc3-upgrade-offered.jpg) | [Updated](./rc3-upgrade-updated.jpg) | [Status](./rc3-upgrade-restarted-status.jpg) | [Memory](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Status](./rc5-fresh-status.jpg) | [Memory](./rc5-upgrade-memory-before.jpg) | [Offer](./rc5-upgrade-offered.jpg) | [Updated](./rc5-upgrade-updated.jpg) | [Status](./rc5-upgrade-restarted-status.jpg) | [Memory](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [Status](./rc1-fresh-status.jpg) | [Memory](./rc1-upgrade-memory-before.jpg) | [Offer](./rc1-upgrade-offered.jpg) | [Updated](./rc1-upgrade-updated.jpg) | [Status](./rc1-upgrade-restarted-status.jpg) | [Memory](./rc1-upgrade-memory-preserved.jpg) |

Fresh installs used **Plugins → Add plugin → Enable now**. Upgrades started from the real npm package, created synthetic Runtime canaries through the UI, used **Status → Check versions → Update**, then restarted the Host. Every final profile matched **19 pinned package versions and 98 files plus executable bits** in the two changed packages. All three Runtime file hashes (`memories.json`, `MEMORY.md`, `USER.md`) matched before installation, after installation and after restart for each upgrade.

## Exact source-build recovery

Additional Host: **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**, package version 0.2.2-rc.1, UI version 0.2.2-rc.1-fcc0ad4. Its source working tree remained clean.

| Step | Evidence |
| --- | --- |
| Fresh Add plugin installation of 0.5.41, enabled and running | [Status](./master-fresh-status.jpg) |
| Real npm 0.5.40 startup reproduces `agents.roots` failure and unavailable HTTP 405 routes | [Broken page](./master-upgrade-before-failure.jpg) |
| Synthetic work memory and user profile created in the fresh UI for the retention fixture | [Fixture data](./master-canary-fixture.jpg) |
| Exact-version CLI update and full restart recover the running 0.5.41 page | [Recovered status](./master-upgrade-restarted-status.jpg) |
| Both records readable after restart, with all three file hashes unchanged | [Retained memory](./master-upgrade-memory-preserved.jpg) |

The old page cannot create or read memories. The two UI-generated synthetic records' three v1 Runtime files were therefore copied into the disposable broken profile before its baseline hash audit. Recovery used the public **`dsh plugin --profile web add dsh-mnemon@0.5.41`** path with the fixture registry, followed by a full restart. The command exited zero, both records became readable, and all package/file/hash checks passed. This is a recovery acceptance on the reporter-identified commit, not a reproduction on their original Windows machine. [Detailed source record](./master-validation.json).

## Verification and artifacts

- Node **24.22.2**, macOS arm64: complete `pnpm run verify` passed, with **2,550 root tests passed / 8 conditional skips** and **759 workspace tests passed / 3 conditional skips**. Documentation, types, deterministic builds, Headless activation and package checks passed.
- Independent artifacts: **18 plugin repositories and 19 packed artifacts** passed standalone type/test/build and actual Host activation, including the optional Strategies.
- Final integrated code on the fixed master: **2,550 root tests passed / 8 conditional skips**, 170 files passed / 2 skipped. PR CI also retains the official-Host and Windows workspace checks.
- All **35 screenshots** were visually inspected and their SHA-256 values checked. Final per-profile audits cover **228 package versions and 1,176 candidate files with executable bits**; all six upgrades preserve Runtime hashes. Reopened application consoles had zero errors.
- Starter: **68 files, 539,290 packed bytes, 2,262,379 unpacked bytes**, **75.4%** of the 3,000,000-byte ceiling. No ceiling adjustment was needed.

The frozen UI candidates come from **`444473f839759961573a922474c9398c1bb42663`**: Starter **0.5.41** and Skills **0.5.8**. The other seventeen components retain immutable npm versions. The Starter pins all eighteen components exactly. [validation.json](./validation.json) records composition, digests and aggregate results; per-Host records: [020](./020-validation.json), [rc2](./rc2-validation.json), [rc3](./rc3-validation.json), [rc5](./rc5-validation.json), [rc1](./rc1-validation.json).

The reusable fixture is [`scripts/serve-release-acceptance.mjs`](../../../scripts/serve-release-acceptance.mjs). With paths bound to isolated resources:

```sh
pnpm run verify
MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build
DSH_HOST_ROOT="$DSH_SOURCE/apps/cli" pnpm run test:installed-dsh
pnpm release:check
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$FRESH_STATE"
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$UPGRADE_STATE" --previous dsh-mnemon@0.5.40
```

## Observations and limits

After some restarts, the in-app browser failed to navigate to a new `127.0.0.1` port although independent normal authentication returned HTTP 303 then 200. The same Host and token worked through its supported `localhost` authority. The exact browser cause is unconfirmed; no authentication settings or user cookies were changed. All fixture/Host processes stopped, and normal test tabs were closed. The browser tool rejected even closing four generated error-page tabs under its URL policy; those unmarked tabs rely on normal turn-end cleanup.

This covers official Web profiles and the exact extra source commit on macOS. Native Desktop OS integration, the reporter's Windows machine, arbitrary master/alpha versions and live cloud-model quality are outside this release acceptance. Earlier real-model evidence and its explicit limitations remain in the [task compatibility record](../dsh-master-agents/README.md).

Only the selected candidate versions are aged inside the fixture registry, so npm minimum-release-age behavior is not tested here. These are pre-publication candidates: the publish workflow separately freezes the final merged revision, publishes dependency layers, verifies real npm installation/upgrade and only then creates the GitHub Release.
