# Installed alpha Host verification

[简体中文](./README.zh-CN.md) | **English**

Checked on 2026-11-04 with Node 24.22.2, canonical physical DSH package roots and `NODE_PATH` removed. All installations, profiles and data were disposable. No upstream package source was edited. The investigation started from Mnemon `54cca5fc2e552483ae13e68565564149fd03a1df`; these changes affect tests, CI and documentation only.

## Two different failures

Fresh npm installations of DSH `0.2.2-alpha.2` differ from the installation accepted on November 2:

| Dependency | Earlier installation | Fresh installation |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.6-alpha.1` | `4.0.6-alpha.2` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.7-alpha.1` | `1.0.7-alpha.2` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.11-alpha.1` | `1.0.11-alpha.2` |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.8-alpha.1` | `1.1.8-alpha.2` |
| `@deepseek-ai/schemastery` | `3.18.6-alpha.1` | `3.18.6-alpha.2` |

The DSH manifest permits these versions through its `~` ranges. npm published Cordis `4.0.6-alpha.2` at `2026-11-03T07:09:41.288Z` and Loader `1.0.7-alpha.2` at `2026-11-03T07:09:54.311Z`. The installed `dsh-app-boot@0.2.2-alpha.2` and `dsh-config-editor@0.2.2-alpha.2` JavaScript files remain byte-identical between the two installations.

1. **Fixture dependency mismatch:** `tests/fixtures/view-management.ts` loaded Loader from the development installation, while the installed-host resolver supplied Cordis from the tested Host. New Cordis passes the Fiber as the first `internal/config` argument instead of the older receiver binding; the old Loader fails at `this.parent.fiber`. The fixture now uses the same `requireDsh` helper as other real-host tests. New Loader also exposes `commit` instead of `write`; the fixture spies on the actual persistence method, without replacing its implementation or weakening the no-write assertions.
2. **Real upstream Host incompatibility:** new Cordis supplies `(config, next)` to `internal/update`, but the fixed alpha.2 app-boot still registers `(config, noSave, next)`. Its embedded Include also predates Loader's `commit` contract. The official ConfigEditor path fails with `next is not a function`; direct plugin updates can fail with `entry.parent.tree.commit is not a function`. Neither failure requires Mnemon. Plain startup succeeds in the minimal probe; successful startup alone does not verify settings updates.

[PR #552 CI](https://github.com/omdsh-dev/dsh-mnemon/actions/runs/41637532177/job/125922392789) and [PR #555 CI](https://github.com/omdsh-dev/dsh-mnemon/actions/runs/41670139574/job/126035995212) both had 35 failures: 17 View management, 9 profile reconciliation, 5 plugin-manager integration and 4 bundle activation tests. A fixture-only change cannot account for all four bundle failures.

## Isolated checks

The [Host-only probe](./host-update-probe.mjs) boots a synthetic plugin and updates its config without importing Mnemon. The existing `tests/fixtures/bundle-activation.mjs` settings case exercises the official ConfigEditor, persistence and restart path.

| Installation | Host-only update | ConfigEditor save and restart |
|---|---|---|
| Cached alpha.2, earlier dependencies | Pass | Pass |
| Fresh alpha.2, current dependencies | Fail: missing `commit` | Fail: missing `next` |
| Isolated alpha.2 with all five earlier dependency versions pinned | Pass | Pass |
| Official alpha.3, current dependencies | Pass | Pass |

The temporary pin is diagnostic evidence, not a shipped override. CI moves to the official npm `alpha` target `0.2.2-alpha.3`; this does **not** repair existing alpha.2 installations or claim that their fresh dependency combination works.

Reproduce using a physical installation root, with `NODE` naming Node 24.22.2:

```sh
env -u NODE_PATH "$NODE" --expose-internals docs/pr-assets/issue-554-alpha-host/host-update-probe.mjs "$DSH_HOST_ROOT"
env -u NODE_PATH "$NODE" --expose-internals tests/fixtures/bundle-activation.mjs "$DSH_HOST_ROOT" settings
env -u NODE_PATH DSH_HOST_ROOT="$DSH_HOST_ROOT" "$NODE" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
```

## Legacy reader and regression coverage

Alpha.3 can read valid historical v2 subagent descriptors itself. The repair test consults the Host's public payload validator, then verifies either the preserved v2 descriptor or the older Host's specific rejection. The repair CLI still must produce the exact v3 copy, preserve the input bytes and remain idempotent. Unsupported descriptor compositions, duplicate keys and malformed data remain refusal tests.

Before the fixture and reader adaptations, a focused alpha.3 run failed all five selected cases: one View catalog case and four v2 descriptor cases. Afterwards, all 182 tests across View management, profile reconciliation, plugin-manager integration and legacy repair pass separately on DSH `0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.5` and `0.2.2-alpha.3`. The default local installation for this check is rc.2; the rc.5 check explicitly uses the isolated installed Host. Root typecheck and the root plus four public SDK builds also pass.

The complete installed alpha.3 root suite then passed: **166 files passed, 2 skipped; 2,463 tests passed, 7 skipped**. Documentation links and `git diff --check` also passed. This evidence does not substitute for the combined compatibility PR's final CI or packed Source ownership verification.
