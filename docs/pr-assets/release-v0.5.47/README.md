# v0.5.47 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-16–17 (Asia/Shanghai)** using isolated macOS arm64 / Node 24.22.2 Web profiles and synthetic data. All seven published DSH versions finish with a healthy fresh installation and a data-preserving **0.5.46 → 0.5.47** upgrade, followed by a full Host restart. No paid-model requests or personal Desktop data were used.

| DSH | Fresh / 全新安装 | Upgrade / 升级 | Restart / 重启后 |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |
| 0.2.2-rc.2 | [Add](./022rc2-fresh-add.png) / [Ready](./022rc2-fresh-status.png) | [Before](./022rc2-upgrade-before.png) / [Offer](./022rc2-upgrade-offered.png) / [Updated](./022rc2-upgrade-updated.png) | [Version](./022rc2-upgrade-restarted.png) / [Retained](./022rc2-upgrade-retained.png) |
| 0.2.2-rc.3 | [Add](./022rc3-fresh-add.png) / [Ready](./022rc3-fresh-status.png) | [Before](./022rc3-upgrade-before.png) / [Reinstall](./022rc3-upgrade-reinstall.png) / [Installed](./022rc3-upgrade-installed.png) | [Version](./022rc3-upgrade-restarted.png) / [Retained](./022rc3-upgrade-retained.png) |

Fresh installations use DSH **Plugins → Add plugin**, then enable the installed Starter. Six upgrades use **Status → Check versions → Update**. On RC3, the old 0.5.46 status page stayed loading during native Safari automation; the documented **Plugins → Uninstall → Add plugin** path installed the candidate while preserving the existing data directory. This is recorded as a successful reinstall upgrade, not a successful in-place update.

The Runtime fact and its pin were created through the old UI on 0.2.1-rc.5, then copied as a synthetic fixture to the other six upgrade profiles. Every final UI shows that same fact and pin. Exact `memories.json`, `MEMORY.md` and `USER.md` hashes match before upgrade, after installation and after restart. `USER.md` is empty in this fixture.

Each final profile matches **19 exact versions and 274 candidate file contents/executable modes**: **266 version checks and 3,836 file/mode checks** across 14 profiles. See [validation.json](./validation.json), its per-Host records and the [frozen manifest](./candidate-manifest.json). **54 screenshots** record actual UI states; representative oldest-Host status and newest-cohort retained-memory screenshots were visually inspected, and accessibility assertions checked versions, health and pinned memory.

## Verification

- Full `pnpm run verify`: **2,835 root tests passed / 10 conditional skips**, plus **966 plugin tests passed / 4 skips**. Documentation, types, deterministic builds, Headless activation and package checks pass.
- Published DSH **0.2.2-rc.3** installed-Host suite: **2,836 passed / 9 skips**.
- **18 independent plugin repositories and 19 packed artifacts** pass, including standalone compilation/tests, public SDK composition, Client tests, Starter activation and optional Strategies.
- Starter: **74 files, 599,347 packed bytes and 2,524,347 unpacked bytes**, 84.1% of the existing 3 MB ceiling. No ceiling increase is needed.

One RC2 candidate restart also stayed loading during background native-UI automation. Temporary read-channel and HTTP timing diagnostics showed successful requests on subsequent restarts. All diagnostics were then removed; the unchanged candidate passed a full foreground restart with its memory intact. Both the previous release and this candidate intentionally pause reads for hidden pages. The initial observation does not establish a product regression or prove a fixed cause; the final successful verification and recovery steps are retained without omitting it.

The candidate is `a257a77c20077858288a2d5c56662be53db435a2`. Subsequent changes are release documentation and evidence only; publication artifacts must match these candidate integrity values. Web-profile acceptance does not certify native Desktop integration, real cloud-account behavior, arbitrary master builds or alpha releases. The loopback registry serves frozen candidate packages alongside immutable npm versions, with aged candidate metadata; actual npm release-age policy is outside these UI checks. All temporary fixtures are stopped after acceptance.

Reproduce with `scripts/serve-release-acceptance.mjs` and `docs/pr-assets/release-v0.5.43/audit-installed.py`, using `--previous dsh-mnemon@0.5.46` for upgrades. Keep native browser windows in the foreground during UI assertions.
