# v0.5.40 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-04 (Asia/Shanghai)** using official published DSH packages, isolated Web profiles, synthetic memories and frozen candidates. All **ten scenarios** passed: fresh Add plugin installation and real npm **0.5.39 → 0.5.40** upgrade on each of five Hosts.

## Results

| DSH | Fresh | Before upgrade | Offered update | Installed, restart needed | After restart | Preserved memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Status](./020-fresh-status.jpg) | [Memory](./020-upgrade-memory-before.jpg) | [Offer](./020-upgrade-offered.jpg) | [Updated](./020-upgrade-updated.jpg) | [Status](./020-upgrade-restarted-status.jpg) | [Memory](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Status](./rc2-fresh-status.jpg) | [Memory](./rc2-upgrade-memory-before.jpg) | [Offer](./rc2-upgrade-offered.jpg) | [Updated](./rc2-upgrade-updated.jpg) | [Status](./rc2-upgrade-restarted-status.jpg) | [Memory](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Status](./rc3-fresh-status.jpg) | [Memory](./rc3-upgrade-memory-before.jpg) | [Offer](./rc3-upgrade-offered.jpg) | [Updated](./rc3-upgrade-updated.jpg) | [Status](./rc3-upgrade-restarted-status.jpg) | [Memory](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Status](./rc5-fresh-status.jpg) | [Memory](./rc5-upgrade-memory-before.jpg) | [Offer](./rc5-upgrade-offered.jpg) | [Updated](./rc5-upgrade-updated.jpg) | [Status](./rc5-upgrade-restarted-status.jpg) | [Memory](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [Status](./rc1-fresh-status.jpg) | [Memory](./rc1-upgrade-memory-before.jpg) | [Offer](./rc1-upgrade-offered.jpg) | [Updated](./rc1-upgrade-updated.jpg) | [Status](./rc1-upgrade-status.jpg) | [Memory](./rc1-upgrade-memory-preserved.jpg) |

All UI scenarios used **Node 24.22.2**. Source verification used **Node 22.22.0**; CI retains Node 22.19 coverage for earlier Hosts. DSH 0.2.2 support now targets published **RC1**, not alpha builds. Its Host requires Node >=24.9.0. See [compatibility policy](../../en/reference/compatibility.md).

- Workspace verification: **2498 root tests passed / 7 opt-in skips**, **753 component tests passed / 3 opt-in skips**; build, type checks, documentation, package contents and public entries passed.
- Independent artifacts: **18 plugin repositories and 19 artifacts** passed standalone test/build and actual Host install/activation checks, including all optional Strategies.
- After narrowing the support policy, all **20 manifest-admission tests** passed.
- Each UI installation matched **all 19 pinned versions** and all **126 files plus executable bits** in the four changed candidates. A separate final read-only audit repeated these comparisons across all ten profiles: 190 package versions and 1260 candidate files matched.
- Each upgrade preserved the exact SHA-256 of `memories.json`, `MEMORY.md` and `USER.md` before installation, after installation and after restart. The UI showed the synthetic memory after restart and actually ran 0.5.40. The 0.2.0-rc.2 and 0.2.1-rc.2 scenarios also retained a nonempty user profile.
- The Starter contains **68 files**, **533,063 packed bytes**, **2,239,100 unpacked bytes**: **74.6%** of its 3,000,000-byte ceiling. The ceiling needs no increase.

## Candidate and procedure

The frozen set contains Starter **0.5.40**, Documents **0.5.13**, Skills **0.5.7** and Layered Strategy **0.5.12**. The other fifteen components come from their immutable published npm versions. Documents requires Root **^0.5.40**; the Starter's eighteen component pins are exact. [validation.json](./validation.json) records the full composition, SHA-256/SHA-512 candidate digests, file digests and aggregate results. Detailed records: [0.2.0-rc.2](./020-validation.json), [0.2.1-rc.2](./rc2-validation.json), [0.2.1-rc.3](./rc3-validation.json), [0.2.1-rc.5](./rc5-validation.json), [0.2.2-rc.1](./rc1-validation.json).

1. Build and freeze the four changed packages. Serve them with `scripts/serve-release-acceptance.mjs`, which overlays only those packages beside real npm metadata in a disposable registry. Every scenario has its own workspace, data directory and DSH profile.
2. Fresh profile: use **Plugins → Add plugin → dsh-mnemon → Enable now**, then verify **Memory System → Status** runs 0.5.40.
3. Upgrade profile: install the real npm `dsh-mnemon@0.5.39`, create a synthetic Runtime canary through the UI and record data hashes. Use **Check versions → Update**, verify the restart-needed state and installed files, restart the fixture, then verify running version, retained memory and data hashes.
4. Drive the actual UI through CUA, inspect the thirty screenshots, then close the test tabs and stop every fixture. No personal Desktop profile or paid model account is used.

Commands, with `NODE24_BIN`, `DSH_BIN`, `ARTIFACTS` and `STATE` pointing to isolated test resources:

```sh
pnpm install --offline --frozen-lockfile
pnpm run verify
env -u NODE_PATH PATH="$NODE24_BIN:$PATH" MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 node scripts/verify-plugin-artifacts.mjs --skip-build --keep
pnpm exec vitest run tests/dsh-host-compatibility.spec.ts
pnpm release:check
node scripts/verify-docs.mjs
env -u NODE_PATH "$NODE24_BIN/node" scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$STATE"
# Separate empty state for the upgrade scenario:
env -u NODE_PATH "$NODE24_BIN/node" scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$STATE" --previous dsh-mnemon@0.5.39
```

## Observations and limits

The first RC1 version check returned a transient metadata fetch error. Connectivity probes then succeeded and **Recheck** offered the correct update; the retry completed without a product change. Restart disconnect warnings were expected, and final browser console error counts were zero.

This verifies official published Hosts and the Web UI in disposable profiles. Native Desktop OS integration, arbitrary unpublished source builds and live cloud Provider quality are outside scope. Ten opt-in tests require additional external CLI/model/Provider setup and were skipped. Alpha evidence from earlier releases remains historical; alpha is no longer a compatibility or CI target.

Candidate metadata is aged only inside the test registry so minimum-release-age policy does not hide the candidate. That npm policy is not covered by these scenarios. These digests describe pre-publication UI candidates; the publish workflow separately freezes the final merged revision, verifies its artifacts, publishes changed packages in dependency order and checks real npm installation and upgrade before creating the Release.
