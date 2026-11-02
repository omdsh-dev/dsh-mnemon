# Current DSH compatibility evidence

[简体中文](./README.zh-CN.md) | **English**

Checked on 2026-11-02, on macOS arm64. The compatibility adapter is frozen at `e130786085dfb93d006c8769ccaaff72c6b0764e`, on top of the independent [#541 fix, PR #545](https://github.com/omdsh-dev/dsh-mnemon/pull/545) at `eea8c306c9e7cb5fb2408696b7dc6bfa52a86ef9`. Its base is main `a4ad2d6955172b936ff9328f39cc5873c3ec9c55`. The initial evidence below precedes merge integration; the integration addendum records the combined fixes without changing the compatibility adapter. [validation.json](./validation.json) records exact versions, counts and limits; [artifacts.json](./artifacts.json) freezes the 19 candidate tarball SHA-256 values and sizes. These local candidates retain existing version numbers; they are not a release or Registry publication.

## Upstream and contract

The [npm metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh) reported `latest` and `next` as `0.2.1-rc.5` (published October 29), and `alpha` as `0.2.2-alpha.2` (published October 27). Both are prereleases. Official release notes: [rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5), [alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2). The RC is the new pinned development baseline; alpha is an additional exact-version target.

The published alpha `ToolRuntime` exposes `setExecutor()` and accepts `{ calls: [{ type: 'tool-call', id, name, arguments }], agent, signal }`, where `arguments` is JSON text. Mnemon uses that public capability as the discriminator and requires exactly one `results` entry with the requested `callId` and a boolean `result.isError`. A thrown or malformed response fails admission; it never triggers a second dispatch using the other API shape. Real native/PTC tests also verify authoritative inner and outer outcomes, guards and pre/post policy. Test composition mounts the published native/PTC plugins; the shipped Web profile checks independently verify production composition.

No synthetic model-step log is supplied for the no-op admission probe. PTC still owns audit events, so [PR #545](https://github.com/omdsh-dev/dsh-mnemon/pull/545) is required to keep admission inside a real turn and drain it before `turn/end`. This PR does not fix the separate missing-View case in [#542](https://github.com/omdsh-dev/dsh-mnemon/issues/542).

## Completed checks

| Check | Result |
|---|---|
| Full `pnpm run verify`, rc.5 / Node 22.22.0 | Root: 2,417 passed, 7 skipped. Components: 745 passed, 3 skipped. Docs, type checks, deterministic double build, component builds, Headless, package checks, publint and attw passed. |
| Installed 0.2.0-rc.2 / Node 22.22.0 | 2,414 passed, 10 skipped; existing 0.2.1-only features remain skipped. |
| Installed 0.2.1-rc.3 and rc.5 / Node 22.22.0 | Each: 2,417 passed, 7 skipped. |
| Installed 0.2.2-alpha.2 / Node 24.9.0 and 24.22.2 | Each root suite: 2,417 passed, 7 skipped. The lower runtime does not establish full macOS Source compatibility. |
| Alpha admission and durable turn regression | Before adapter: 16 failed / 4 passed. After: 20 passed, including 14 admission/drain/reload cases from #545. Adapter contract: 11 passed. |
| Independent packed artifacts, rc.5 / Node 22.22.0 and alpha.2 / Node 24.22.2 | Each: all 18 standalone plugin repositories and 19 artifacts passed build, type checks, tests, external-consumer checks, real Headless installation and optional Strategy composition. |
| Public package imports / Node 20.20.0 | 15 Node entries, 37 public type dependencies, 22 browser-side declarations and one executable help entry passed. This is not a Host runtime claim. |
| Delayed official model directory | rc.3, rc.5 and alpha.2 each passed a synthetic 3.6-second first response with zero external model requests. [Receipts](./model-directory-alpha2.json) record the tested path. |

The packed upgrade check seeds a synthetic Runtime entry into an isolated previous installation, proves that the old Host sends it to the model, upgrades, then proves the same entry is still sent and the Runtime file is byte-identical. Existing settings, retained-backup recovery and restart checks also pass. This ran from `0.5.37` on rc.5 / Node 22.22.0 and alpha.2 / Node 24.9.0 and 24.22.2, using the same Node 22-built tarballs in [artifacts.json](./artifacts.json). The full alpha artifact run also covered the seeded `0.5.29` upgrade.

The official Web profile successfully ran both shipped `standard` and `ptc` presets with the linked built Starter on [rc.5](./stock-web-rc5.json) and [alpha.2](./stock-web-alpha2.json). The [packed alpha receipt](./packed-web-alpha2.json) additionally uses the frozen Node 22-built Starter installed on Node 24.22.2. Each preset received the Mnemon guide and memory snapshot, completed real `mnemon_status` and `mnemon_document_search` reads without tool errors, and ended its turn after three scripted model requests. No actual inference service was called.

## Node 24 limitation and resolution

The alpha Host declares Node `>=24.9.0`. That declaration is not the fully verified macOS toolchain floor. On Node 24.9.0, an independent install selected tsdown 0.22.2 and three Source type checks rejected the current `neverBundle` typing; current tsdown needs Node `>=24.11` on the 24 line. On Node 24.11.0, the type checks passed but three Source tests failed when removing or replacing directory symlinks (Runtime archive, Memory Spaces native package, Skills Trash restore).

The minimal [Node reproducer](../../../scripts/observe-node-symlink.mjs) calls `mkdirSync`, `symlinkSync(target, link, 'dir')` and `rmSync(link)` on disposable paths. [Recorded results](./node-symlink.json): Node 22.22.0 and 24.22.2 remove only the link; Node 24.9.0 and 24.11.0 throw `ERR_FS_EISDIR`. The target stays intact in all four cases. No Source workaround was added. The full independent artifacts and Source tests pass on Node 24.22.2, which is the macOS alpha recommendation and the exact alpha CI pin.

## Reproduction and limits

Build first, then use a separate published DSH install for each target:

```sh
pnpm run verify
DSH_HOST_ROOT=<installed-dsh-package> pnpm run test:installed-dsh
MNEMON_E2E_DSH=<installed-dsh-package>/lib/bin.js node scripts/verify-plugin-artifacts.mjs --skip-build --keep
node scripts/verify-web-profile.mjs <installed-dsh-package> <receipt.json>
node scripts/verify-web-profile.mjs <installed-dsh-package> <receipt.json> file:<starter.tgz> <candidate-registry>
node scripts/observe-node-symlink.mjs
```

Use Node 24.22.2 for the alpha commands. The packed Web form expects a disposable candidate registry serving the frozen component tarballs; the Headless pack verifier creates its own loopback registry. All profiles, settings and memories used here are disposable synthetic fixtures. Raw logs stay local because DSH prints temporary loopback authentication URLs; committed receipts contain no tokens, private paths, private data or model credentials. Fixtures are disposed after checks.

This is protocol and package acceptance, not a visual browser/UI walkthrough. The Web fixture disables the unrelated native directory chooser and automatic idle review; real guarded automatic admission and PTC history are covered separately by the full Host tests. The Headless smoke disables unrelated shell/permission/PTC entries and does not substitute for Web PTC coverage. No personal Desktop profile, paid inference or third-party Provider account was used. Remote GitHub Actions must still pass on the submitted PR head; later alpha versions and other untested platforms are not established by this record.

## Merge integration

Before release, #543, #544, #545 and #549 were integrated through preserved merge ancestry. The new #544 real-Host fixture initially failed all seven cases on alpha.2 because it used the removed ToolRuntime mode configuration. Migrating only that fixture to the existing `loadTools()` and `executeTool()` helpers made all seven pass. Its Agent-created listener awaits PTC presentation.

Full rc.5 verification of the combination passed: **2,445 root tests / 7 skipped** and **745 component tests / 3 skipped**, plus all build, type, documentation, Headless and package checks. The focused alpha.2 / Node 24.22.2 combination passed **49 tests across five files**, covering View binding, guarded idle admission, durable PTC history and Unicode activity. This addendum does not supersede the original 19-artifact digests: final release acceptance must use only newly selected release tarballs and real Registry versions for unchanged components.
