# v0.5.39 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-02 (Asia/Shanghai)** against frozen candidate `9dd950228e34fb08467d0ec1f3ae591f04ee3c79`, prepared from main `75d9ab175250376b2bdbd12316da55c90cf8486b`. The artifacts were packed before this evidence-only addition. Environment: macOS arm64, **Node 24.22.2**, pnpm 10.13.1 and Google Chrome 156.0.8078.74. Every scenario used its own disposable home, workspace, DSH profile, package store, memory directory and browser user-data directory. No model credentials or private user data were used; the user's Desktop profile and existing browser were untouched.

The [frozen manifest](candidate-manifest.json) selects only Starter **0.5.39** and Skills **0.5.6**. The unchanged seventeen components came from their immutable npm versions. The acceptance registry did not overlay rebuilt versions of unchanged packages. Every installation matched all **nineteen pinned versions** and all **98 files** from the two selected tarballs byte for byte, including executable bits. [validation.json](validation.json) records package digests, installation results, Runtime hashes and screenshot hashes; [installed-file-digests.json](installed-file-digests.json) records the shared selected-file digests verified on every installation.

The Starter is **531,612 packed bytes / 2,233,414 unpacked bytes**. The release raises the size ceiling from 2,500,000 to 3,000,000 bytes, as documented in the separate [verification record](verification.json).

## Real WebUI installation and upgrade

The [acceptance server](../../../scripts/serve-release-acceptance.mjs) runs official published DSH in isolated homes. Its loopback registry overlays only the two selected candidates on real npm metadata. The selected-package version-check preload and old publication timestamps expose unpublished candidates to the existing UI; production release-age behavior is unchanged.

For each of **0.2.0-rc.2**, **0.2.1-rc.2**, **0.2.1-rc.3**, **0.2.1-rc.5** and **0.2.2-alpha.2**:

1. On a fresh host, used **Plugins → Add plugin** with `dsh-mnemon@0.5.39`, confirmed the installed version, selected **Enable now**, and opened Memory System. Status showed **dsh-mnemon 0.5.39 / System nominal**.
2. In another isolated profile, installed actual npm **0.5.38** through DSH's plugin installer. Added a synthetic fact through Runtime's **Add memory** dialog, waited for the saved entry, then captured the retention baseline.
3. Opened **Check versions** and confirmed **0.5.38 → 0.5.39**, with one component update. Clicked **Update**, confirmed **0.5.39 / Restart needed**, audited the installed composition and files, and confirmed all three Runtime hashes still matched the baseline.
4. Restarted the host once and reconnected. Status showed running **0.5.39 / System nominal**. The synthetic fact remained visible, and SHA-256 hashes of `memories.json`, `MEMORY.md` and `USER.md` were unchanged. The installed nineteen versions and selected files still matched.

All ten final browser scenarios reported no page errors. All fixture and test-browser processes were stopped.

| DSH | Fresh install | Fresh status | Update offered | Update installed | After restart | Retained memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Install](fresh020-install.jpg) | [Status](fresh020-status.jpg) | [Offered](upgrade020-offered.jpg) | [Updated](upgrade020-updated.jpg) | [Running](upgrade020-status.jpg) | [Canary](upgrade020-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Install](fresh021-install.jpg) | [Status](fresh021-status.jpg) | [Offered](upgrade021-offered.jpg) | [Updated](upgrade021-updated.jpg) | [Running](upgrade021-status.jpg) | [Canary](upgrade021-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Install](freshrc3-install.jpg) | [Status](freshrc3-status.jpg) | [Offered](upgraderc3-offered.jpg) | [Updated](upgraderc3-updated.jpg) | [Running](upgraderc3-status.jpg) | [Canary](upgraderc3-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Install](freshrc5-install.jpg) | [Status](freshrc5-status.jpg) | [Offered](upgraderc5-offered.jpg) | [Updated](upgraderc5-updated.jpg) | [Running](upgraderc5-status.jpg) | [Canary](upgraderc5-memory-preserved.jpg) |
| 0.2.2-alpha.2 | [Install](freshalpha2-install.jpg) | [Status](freshalpha2-status.jpg) | [Offered](upgradealpha2-offered.jpg) | [Updated](upgradealpha2-updated.jpg) | [Running](upgradealpha2-status.jpg) | [Canary](upgradealpha2-memory-preserved.jpg) |

Browser automation used local Playwright with a separate disposable Chrome user-data directory per scenario because the CUA in-app browser became unavailable. Visual review rejected the first alpha.2 update image, which captured a host client-refresh transition. That isolated upgrade scenario was repeated with a post-capture **Restart needed** check; the rerun passed the same installation, restart and retention checks and supplies the four alpha.2 upgrade images above. The candidate code did not change. All thirty included JPEGs were visually reviewed and contain only the page viewport and synthetic fixture data.

## Separate verification

The release coordinator's [verification record](verification.json) covers the workspace suite (**2,463 root tests / 7 skipped**, **749 component tests / 3 skipped**), **18 independent plugin repositories / 19 packed development artifacts**, the canonical installed **0.2.1-rc.2** suite (**2,463 / 7 skipped**), package checks and release intent. These development checks are separate from the two-artifact acceptance above.

The public Web profile checks for [rc.5](packed-web-rc5.json) and [alpha.2](packed-web-alpha2.json) used the same two frozen candidates plus the real npm composition. Both shipped **standard** and **PTC** presets received the guide and memory snapshot, read status and documents without tool errors, and completed their synthetic turns. Each preset made three synthetic model requests; **no external model calls** were made.

## Reproduction and limits

With the exact official DSH binary, Node 24.22.2, the selected release tarballs and a new empty directory:

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <selected-release-tarballs> \
  --state <empty-disposable-state>
```

Add `--previous dsh-mnemon@0.5.38` for upgrades. Read the private connection metadata without adding it to evidence. After **Restart needed**, send SIGUSR2 to the fixture parent and reconnect using its new private metadata. Stop the fixture with SIGTERM. Compare all nineteen installed versions, every selected tarball file and its executable bits; compare the Runtime baseline after both installation and restart.

These scenarios cover installation, update, restart and one synthetic Runtime canary per upgrade. They do not exhaust historical-data migration cases or evaluate live model quality. No external Provider account was used. Interactive Windows and Linux Desktop installation was not manually tested, and reported Windows latency was not remeasured. Publication separately verifies the frozen revision and Registry composition before creating the GitHub Release.
