# v0.5.38 release acceptance

[简体中文](./README.zh-CN.md) | **English**

Verified on **2026-11-02 (Asia/Shanghai)** against candidate `53c00f6963bfc46738aa523e968c58a90f351805`, prepared from main `5a5c5f8909d68f520110d271d566b77bbcf94b70`. The artifacts were packed before this evidence-only addition. Environment: macOS arm64, Node 22.22.0, pnpm 10.13.1, and independent headless Chrome contexts. Each host used its own disposable home, workspace, profile, package store and memory directory. No model credentials or private user data were used; the user's Desktop profile and existing browser were untouched.

The six candidates are Starter **0.5.38**, Documents **0.5.12**, Memory Spaces **0.5.25**, Runtime **0.5.17**, Skills **0.5.5** and ByteRover **0.5.6**. Thirteen components retain their pinned npm versions. The [structured record](validation.json) contains all nineteen versions, candidate SHA-256 and SHA-512 digests, package sizes, screenshot hashes and results. Every installation matched all nineteen versions and all **191 files** from the six tarballs byte for byte, including executable bits. The Starter is **528,306 packed bytes / 2,220,816 unpacked bytes**, 88.8% of the unchanged 2,500,000-byte ceiling.

## Real WebUI installation and upgrade

The existing [acceptance server](../../../scripts/serve-release-acceptance.mjs) runs published DSH in isolated homes. A loopback registry overlays the six candidates on real npm metadata. Its selected-package version-check preload and old publication timestamps expose the unpublished candidates to the existing UI; production release-age behavior is unchanged.

For DSH **0.2.0-rc.2**, **0.2.1-rc.2** and **0.2.1-rc.3**:

1. On a fresh host, used **Plugins → Add plugin** with `dsh-mnemon@0.5.38`, confirmed the installed version, selected **Enable now**, and opened Memory System. Status showed **dsh-mnemon 0.5.38 / System nominal**.
2. In a second isolated profile, initialized actual npm **0.5.37** through DSH's plugin installer. Added a synthetic fact through Runtime's **Add memory** dialog and saved the retention baseline after the write completed.
3. Opened **Check versions** and confirmed **0.5.37 → 0.5.38**, with five component updates. Clicked **Update**, confirmed **0.5.38 / Restart needed**, then restarted the host once and reconnected.
4. Status showed running **0.5.38 / System nominal**. The synthetic fact remained visible, and SHA-256 hashes of `memories.json`, `MEMORY.md` and `USER.md` were unchanged on all three hosts. All nineteen versions and candidate file bytes matched. The six final browser runs reported no page errors, and all fixture processes were stopped.

| DSH | Fresh install | Fresh status | Update offered | Update installed | After restart | Retained memory |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Install](fresh020-install.png) | [Status](fresh020-status.png) | [Offered](upgrade020-offered.png) | [Updated](upgrade020-updated.png) | [Running](upgrade020-status.png) | [Canary](upgrade020-memory-preserved.png) |
| 0.2.1-rc.2 | [Install](fresh021-install.png) | [Status](fresh021-status.png) | [Offered](upgrade021-offered.png) | [Updated](upgrade021-updated.png) | [Running](upgrade021-status.png) | [Canary](upgrade021-memory-preserved.png) |
| 0.2.1-rc.3 | [Install](freshrc3-install.png) | [Status](freshrc3-status.png) | [Offered](upgraderc3-offered.png) | [Updated](upgraderc3-updated.png) | [Running](upgraderc3-status.png) | [Canary](upgraderc3-memory-preserved.png) |

## Reproduction and verification

Build and pack the six selected candidates, then run the following for each official DSH binary and a new empty state directory:

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <candidate-tarballs> \
  --state <empty-disposable-state>
```

Add `--previous dsh-mnemon@0.5.37` for upgrade scenarios. Read the connection URL from the fixture's private metadata without adding it to evidence. After **Restart needed**, send SIGUSR2 to the fixture parent and reconnect with its new private metadata. Stop the fixture with SIGTERM. Compare the installed Starter and its pinned dependencies against the manifest, then compare every selected tarball file with its installed bytes and executable bits.

Release-root checks were executed separately; their completion messages and totals were read from the logs when synthesizing [validation.json](validation.json), which records log digests:

- `pnpm run verify`: passed documentation, type checking, deterministic builds, **2,387 root tests** (7 conditional skips), **745 component tests** (3 conditional skips), Headless activation, legacy-settings retention/recovery and idempotent restart, package contents and public entries.
- `pnpm run verify:plugins --skip-build`: passed **18 independent plugin repositories / 19 packed artifacts**, the external SDK-only consumer, optional Strategy composition, and packed Starter activation/upgrade. Four outer workers and one Vitest worker per standalone package were used.
- `pnpm run release:check`: passed the complete pinned composition, stable `latest` channel and six selected package advances.

These UI scenarios cover installation, update, restart and one synthetic Runtime canary per upgrade. They do not exhaust historical-data migration cases or evaluate live model behavior. No live model API or external Provider service calls were used. Interactive Windows and Linux Desktop installation was not manually tested, and reported Windows latency was not remeasured.

Publication separately freezes the merged main revision, repeats workspace and independent-plugin verification, compares frozen artifacts, verifies the Registry composition and a real upgrade, and creates the GitHub Release last.
