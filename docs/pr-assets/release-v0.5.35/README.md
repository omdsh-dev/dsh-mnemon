# v0.5.35 release acceptance

[中文](README.zh-CN.md) | [Validation record](validation.json)

Verified on **2026-10-26 (Asia/Shanghai)**, from `main` revision `36f3105e0d2a9c87316898328cdcf940360f957c` plus the release version and metadata changes. Node 22.22.0, pnpm 10.13.1, macOS arm64 and headless Google Chrome were used. All projects, homes, skills and memories were disposable fixtures; no real model credentials were supplied and no user's Desktop profile was changed.

The selected nine candidate tarballs are the Starter 0.5.35 and eight changed components listed in the [release notes](../../en/releases/v0.5.35.md). The other ten components install from npm at their existing pinned versions. [validation.json](validation.json) records candidate digests and the full composition. All four installations matched all nineteen package versions; all 202 files from the nine candidates matched the tarball bytes exactly in each installation.

## Fresh installation and update

The reusable [release acceptance server](../../../scripts/serve-release-acceptance.mjs) starts unmodified, published DSH with a fresh home and profile. Its loopback registry combines real npm metadata with only the selected candidates. A test-only fetch preload directs candidate version checks to that registry; it does not modify DSH or the installed Mnemon packages. Candidate metadata has an old fixture timestamp so pnpm's minimum-release-age rule does not hide an unpublished test version; production release-age behavior is unchanged.

For **both DSH 0.2.1-rc.2 and 0.2.0-rc.2**:

1. Dismissed the first-start model-configuration prompt without supplying a key. Opened **Plugins → Add plugin**, entered `dsh-mnemon@0.5.35`, and installed from the loopback registry shown in the dialog. The result reported version 0.5.35: [0.2.1](fresh021-install.png), [0.2.0](fresh020-install.png).
2. Clicked **Enable now**. **Memory System → Status** reported **dsh-mnemon 0.5.35 / System nominal**, with all five tabs and the Skills card: [0.2.1](fresh021-status.png), [0.2.0](fresh020-status.png).
3. In another isolated profile, installed real npm `dsh-mnemon@0.5.34`. **Check versions** offered 0.5.35 and eight newer components: [0.2.1](upgrade021-offered.png), [0.2.0](upgrade020-offered.png).
4. Clicked **Update**. Both hosts reported **dsh-mnemon updated** and requested a restart: [0.2.1](upgrade021-updated.png), [0.2.0](upgrade020-updated.png).
5. Restarted each host, reconnected the WebUI and read back **dsh-mnemon 0.5.35 / System nominal**: [0.2.1](upgrade021-status.png), [0.2.0](upgrade020-status.png). The installed package versions and bytes matched the accepted composition.

Reproduce a fresh host after building and packing the selected candidate artifacts:

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <candidate-tarballs> \
  --state <empty-disposable-directory> --port 19351
```

Add `--previous dsh-mnemon@0.5.34` for an update profile. Read its connection URL from the private `private.json`; send SIGUSR2 to the fixture PID to restart DSH after an update. The fixture keeps logs and connection tokens outside Git.

## Skills and image-dependent evals

On DSH 0.2.1-rc.2, created the synthetic user skill `release-check` from the Skills page. Added an eval case with **Requires image input** checked: [case](vision-case.png). Ran its backtest with no model account configured. It completed as **1 not measured**, with the case shown as **Not measured** and no score or pass rate: [result](vision-unmeasured.png). The existing Host regression tests separately verify zero executor/judge calls for these cases.

Removed that skill through its menu and confirmation dialog. It appeared in [Trash](skills-trash.png) with its original path, then **Restore** returned it to the [Skills page](skills-restored.png) and removed the Trash entry. No permanent purge or live-provider benchmark was performed in this release acceptance.

## Verification

- `pnpm run verify`: passed documentation, types, deterministic builds, every plugin suite, **2,192 root tests** (7 conditional skips), real Headless activation and package checks.
- `pnpm run verify:plugins --skip-build`: passed **18 independent plugin repositories and 19 packed artifacts**, the external SDK consumer, optional Strategy composition and the v0.5.29 Headless upgrade with Runtime bytes preserved.
- `pnpm run test:installed-dsh` with the documented global-prefix DSH 0.2.0-rc.2 installation: **2,189 passed, 10 conditional skips**. An initial flat npm installation did not provide the test resolver's expected dependency layout; using the documented global-prefix layout resolved the missing client-module imports without a product change.
- `pnpm run release:check`: stable `latest` composition with nine selected package version advances and no pending changesets. No changed component imports the newly exported workspace identity helpers, so existing runtime peer floors remain valid.
- Starter: **67 files, 2,163,228 unpacked bytes**, 86.5% of the 2,500,000-byte ceiling; the ceiling remains unchanged.

Screenshots prove the stated candidate WebUI flows. They do not establish paid-model quality or exhaustive external-provider compatibility. Publication independently verifies the frozen revision, registry bytes, clean installation and registry upgrade before creating the GitHub Release.
