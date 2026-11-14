# v0.5.46 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-15 (Asia/Shanghai)** with isolated macOS arm64 / Node 24.22.2 Web profiles and synthetic data. **All 14 scenarios pass:** fresh installation and real npm **0.5.45 → 0.5.46** upgrade on seven published DSH versions, including **0.2.2-rc.3**. No paid-model calls or personal Desktop data were used.

| DSH | Fresh installation | Upgrade | After full restart |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.jpg) / [Ready](./020-fresh-status.jpg) | [Before](./020-upgrade-memory-before.jpg) / [Offer](./020-upgrade-offered.jpg) / [Updated](./020-upgrade-updated.jpg) | [Version](./020-upgrade-restarted.jpg) / [Retained](./020-upgrade-retained.jpg) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.jpg) / [Ready](./rc2-fresh-status.jpg) | [Before](./rc2-upgrade-memory-before.jpg) / [Offer](./rc2-upgrade-offered.jpg) / [Updated](./rc2-upgrade-updated.jpg) | [Version](./rc2-upgrade-restarted.jpg) / [Retained](./rc2-upgrade-retained.jpg) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.jpg) / [Ready](./rc3-fresh-status.jpg) | [Before](./rc3-upgrade-memory-before.jpg) / [Offer](./rc3-upgrade-offered.jpg) / [Updated](./rc3-upgrade-updated.jpg) | [Version](./rc3-upgrade-restarted.jpg) / [Retained](./rc3-upgrade-retained.jpg) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.jpg) / [Ready](./rc5-fresh-status.jpg) | [Before](./rc5-upgrade-memory-before.jpg) / [Offer](./rc5-upgrade-offered.jpg) / [Updated](./rc5-upgrade-updated.jpg) | [Version](./rc5-upgrade-restarted.jpg) / [Retained](./rc5-upgrade-retained.jpg) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.jpg) / [Ready](./rc1-fresh-status.jpg) | [Before](./rc1-upgrade-memory-before.jpg) / [Offer](./rc1-upgrade-offered.jpg) / [Updated](./rc1-upgrade-updated.jpg) | [Version](./rc1-upgrade-restarted.jpg) / [Retained](./rc1-upgrade-retained.jpg) |
| 0.2.2-rc.2 | [Add](./022rc2-fresh-add.jpg) / [Ready](./022rc2-fresh-status.jpg) | [Before](./022rc2-upgrade-memory-before.jpg) / [Offer](./022rc2-upgrade-offered.jpg) / [Updated](./022rc2-upgrade-updated.jpg) | [Version](./022rc2-upgrade-restarted.jpg) / [Retained](./022rc2-upgrade-retained.jpg) |
| 0.2.2-rc.3 | [Add](./022rc3-fresh-add.jpg) / [Ready](./022rc3-fresh-status.jpg) | [Before](./022rc3-upgrade-memory-before.jpg) / [Offer](./022rc3-upgrade-offered.jpg) / [Updated](./022rc3-upgrade-updated.jpg) | [Version](./022rc3-upgrade-restarted.jpg) / [Retained](./022rc3-upgrade-retained.jpg) |

Fresh profiles use **Plugins → Add plugin → Enable now**. Upgrade profiles first install real npm 0.5.45, then create a working-memory record and a user-profile record and pin the working memory through the UI. **Status → Check versions → Update** offers 0.5.46 and three component updates. Every full Host restart shows version 0.5.46, both records and the pin.

Each final installation matches **19 exact package versions and 169 candidate file contents/executable modes**: **266 version checks and 2,366 file/mode checks** across 14 profiles. All seven upgrades retain exact hashes of `memories.json`, `MEMORY.md` and `USER.md` before installation, after installation and after restart. See [validation.json](./validation.json), its per-Host records, [candidate manifest](./candidate-manifest.json) and [candidate files](./candidate-files.json).

## Verification

- Full `pnpm run verify`: **2,801 root tests passed / 9 conditional skips**; workspace plugins **899 passed / 4 skips**. Documentation, types, deterministic builds, Headless activation and package validation pass.
- The final versioned code against published **DSH 0.2.2-rc.3**: **2,802 passed / 8 conditional skips**.
- **18 independent plugin repositories and 19 packed artifacts** pass, including standalone builds/tests, public SDK-only composition, Client tests, Starter activation and optional Strategies.
- **49 real UI screenshots** document the matrix. Representative newest-Host retention and oldest-Host status screenshots were visually inspected; browser assertions verify version, health, records and pin state for all seven Hosts.
- Starter: **71 files, 564,675 packed bytes, 2,361,512 unpacked bytes**, 78.7% of the existing 3,000,000-byte ceiling. No ceiling increase is needed.

The frozen candidate is `b523b603a4ee3756c23478d2629255ae8f7800d2`. Aligning with merged main at `242ddd0fe58334edc433250b95a4a2e072a5e6f3` and repeating the build produced **four byte-identical tarballs**. Later changes are release documentation, evidence and acceptance-harness isolation only. Publication freezes final main; its artifact digests must match this tested candidate.

## Scope and reproduction

This is Web-profile acceptance, not native Desktop OS integration or cloud-model quality. Alpha and arbitrary master compatibility are not claimed. The loopback registry serves frozen candidates alongside real npm packages; only candidate metadata is aged. Real npm release-age behavior is outside these UI checks. Optional API-key onboarding is dismissed through **Configure later** or **Close**.

The fixture isolates Documents and agents-home in addition to HOME and Mnemon data. An initial upgrade setup failed when a patch was appended after a commented empty YAML list; the harness was corrected and the failed fixtures recreated before acceptance. All final fixtures are stopped after verification.

```sh
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-state>
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-upgrade-state> --previous dsh-mnemon@0.5.45
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state <state> --artifacts <frozen-candidates> --baseline <before.json> --output <after.json>
```
