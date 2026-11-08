# v0.5.43 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-09 (Asia/Shanghai)** using isolated profiles and synthetic data. **Twelve scenarios passed:** fresh installation and real npm **0.5.42 → 0.5.43** upgrade on five official Hosts and the exact source commit identified in #554. No paid model calls or personal Desktop data were used.

| DSH | Fresh install | Memory baseline | Offered update | Installed, restart needed | After restart | Preserved memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add-plugin.jpg) / [Status](./020-fresh-status.jpg) | [Before](./020-upgrade-memory-before.jpg) | [Offer](./020-upgrade-offered.jpg) | [Updated](./020-upgrade-updated.jpg) | [Restarted](./020-upgrade-restarted-status.jpg) | [Retained](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add-plugin.jpg) / [Status](./rc2-fresh-status.jpg) | [Before](./rc2-upgrade-memory-before.jpg) | [Offer](./rc2-upgrade-offered.jpg) | [Updated](./rc2-upgrade-updated.jpg) | [Restarted](./rc2-upgrade-restarted-status.jpg) | [Retained](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add-plugin.jpg) / [Status](./rc3-fresh-status.jpg) | [Before](./rc3-upgrade-memory-before.jpg) | [Offer](./rc3-upgrade-offered.jpg) | [Updated](./rc3-upgrade-updated.jpg) | [Restarted](./rc3-upgrade-restarted-status.jpg) | [Retained](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add-plugin.jpg) / [Status](./rc5-fresh-status.jpg) | [Before](./rc5-upgrade-memory-before.jpg) | [Offer](./rc5-upgrade-offered.jpg) | [Updated](./rc5-upgrade-updated.jpg) | [Restarted](./rc5-upgrade-restarted-status.jpg) | [Retained](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add-plugin.jpg) / [Status](./rc1-fresh-status.jpg) | [Before](./rc1-upgrade-memory-before.jpg) | [Offer](./rc1-upgrade-offered.jpg) | [Updated](./rc1-upgrade-updated.jpg) | [Restarted](./rc1-upgrade-restarted-status.jpg) | [Retained](./rc1-upgrade-memory-preserved.jpg) |
| `fcc0ad4` (source) | [Add](./master-fresh-add-plugin.jpg) / [Status](./master-fresh-status.jpg) | [Before](./master-upgrade-memory-before.jpg) | [Offer](./master-upgrade-offered.jpg) | [Updated](./master-upgrade-updated.jpg) | [Restarted](./master-upgrade-restarted-status.jpg) | [Retained](./master-upgrade-memory-preserved.jpg) |

Fresh installations used **Plugins → Add plugin → Enable now**. Upgrade profiles first installed the actual npm 0.5.42 package, then created one working-memory and one user-profile record through the Runtime UI. **Status → Check versions → Update** offered 0.5.43 and seven changed components. Every full Host restart then ran 0.5.43 and displayed both records.

Each final installation matched **19 pinned versions and all 199 candidate files plus executable bits**. The twelve final profiles therefore matched **228 versions and 2,388 file/mode checks**. All three Runtime files (`memories.json`, `MEMORY.md`, `USER.md`) retained identical hashes before update, after installation and after restart in each of the six upgrade profiles. The [machine-readable record](./validation.json), six per-host records, [candidate file inventory](./candidate-files.json) and [read-only installed-data auditor](./audit-installed.py) record the checks.

## Verification and package size

- Complete `pnpm run verify`: **2,671 root tests passed / 8 conditional skips**, **869 workspace tests passed / 4 conditional skips**. Documentation, types, deterministic builds, Headless activation, public entries and package checks passed.
- `MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build`: **18 independent plugin repositories / 19 packed artifacts** passed standalone verification and real Host activation, including optional Strategies.
- The root suite against unmodified source commit **fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159** also passed **2,671 tests / 8 conditional skips**. Its working tree remained clean.
- Starter: **69 files; 550,305 packed bytes; 2,303,047 unpacked bytes**, 76.8% of the 3,000,000-byte ceiling. No ceiling change was needed.
- **43 screenshots** capture the UI steps. All milestones were checked in live DOM; all six fresh status images and the RC1 retained-memory image were visually reviewed. The latter crops the page to focus on the retained records.

The candidate package revision is `601e4cb7f941dc102f6cf58d7f1a8ef8d6ee1691`, selected against `ee080a7371759928c97c581621713819f31507d4`. Later integration only aligns merge ancestry and adds release documentation/evidence; the published package sources remain identical. The release workflow freezes the final merged main revision, repeats the required checks, and publishes the Starter after its selected components.

## Scope and reproduction

This covers Web profiles on macOS arm64 / Node 24.22.2. It does not remeasure cloud-model quality, provider cache hit rates, native Desktop OS integration or arbitrary master/alpha revisions. The loopback fixture only ages candidate metadata; it does not test real npm minimum-release-age behavior. No user Desktop or existing preview was changed. Owned fixtures and browser tabs were closed.

```sh
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$FRESH_STATE"
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$UPGRADE_STATE" --previous dsh-mnemon@0.5.42
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state "$UPGRADE_STATE" --artifacts "$ARTIFACTS" --baseline "$BEFORE_JSON" --output "$AUDIT_JSON"
```
