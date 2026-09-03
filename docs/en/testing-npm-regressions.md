# npm Release Web UI Regressions

[简体中文](../zh-CN/testing-npm-regressions.md) | **English** | [Development and Verification](./development.md)

The latest [issue #139 Builtin verification record](../pr-assets/builtin-139/README.md) covers the unmodified npm 0.4.1 control, canonical `builtin` migration, all three storage scopes, and real Web screenshots. The baseline description and 2026-08-30 record below remain historical evidence for the earlier npm 0.3.5 regressions.

This regression uses the `v0.3.5` source corresponding to npm `dsh-mnemon@0.3.5` as its baseline, not the view-based development branch (then labeled 0.4.0, now planned for v0.5). The Host is pinned to the latest non-alpha npm release at the time of testing, `@deepseek-ai/dsh@0.1.1-rc.2`. The Web UI is `@linxin666/dsh-web-all@0.3.6`, with additional coverage of its original package name, `@linxin666/dsh-web-ui-all@0.3.6`.

The fixes were first completed against that npm baseline, then synchronized with `main`, still at 0.3.5, and verified again for the PR. Keep separate records of the original and patched packages; current `main` is not an unmodified npm control.

## Isolated startup

Install dependencies and build in a separate worktree:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --workspace-concurrency=1 -r build
node scripts/serve-web-regression.mjs --cli /absolute/path/to/test-owned/mnemon
```

The composable release installs the Starter and sixteen version-locked plugins together, with three enhancement Entries disabled by default. Published control packages resolve their own Registry dependencies. Unpublished prerelease tarballs use the local-registry artifact harness described in [Development](./development.md), never an assumption that those versions exist on npm. The historical results below remain records of their named builds.

Each run creates an independent DSH_HOME, memory directory, workspace, random loopback port, and local model response service. It does not change global dsh, user profiles, personal memories, or existing workspaces. The session model returns fixed test text without calling a paid model. Shell tools and optional SSH/PTY/tunnel installation scripts are outside this regression. `fixture.json` records versions, directories, test switches, and owned processes; `dsh.log` stores this instance's service log. Ctrl-C stops only this instance and retains its directory for audit.

`--package dsh-mnemon@0.3.5` starts the unmodified npm control; `--package /absolute/path/to/local-pack.tgz` installs a locally built patch. By default, the profile uses `cliPath: mnemon` and a child-process-only PATH to test command-name resolution instead of bypassing the issue with an absolute cliPath. Use `--cli-name` to select a different configured value.

## Panel navigation

### Entry placement and storage scope

The harness also accepts `--display-mode sidebar|builtin` (default `sidebar`, with legacy `buildin` input accepted) and `--storage-scope global|workspace|custom` (default `custom`). Global mode uses the fixture-owned `MNEMON_DATA_DIR`, workspace mode uses the test session's `.mnemon`, and custom mode uses the fixture's explicit directory. No personal root is used.

```sh
node scripts/serve-web-regression.mjs --cli /absolute/path/to/test-owned/mnemon --display-mode buildin --storage-scope workspace
node scripts/serve-web-regression.mjs --cli /absolute/path/to/test-owned/mnemon --package dsh-mnemon@0.4.1 --display-mode buildin --storage-scope workspace
```

Both commands intentionally start with the old spelling; the second is the unmodified issue #139 control. The patched Host must save `mnemon.displayMode: builtin` automatically. Verify that the conversation tab shares Sidebar pages and dialogs, has no scope selector, and follows the owning session for reads and writes. Switch entry placement live and reload to check persistence; switch conversations across two workspaces to check isolation. Record the linked commit or packed artifact separately from the displayed package version.

`pnpm verify:headless` also starts with a legacy YAML user setting, checks its canonical writeback and preservation of unrelated fields/comments, then restarts Headless to verify idempotence. No Web connection or real model is needed for migration.

### Sidebar panel round trips

1. Click Memory System → Task Board → Memory System, checking the genuinely visible main page after each step.
2. Repeat multiple rounds, including session and task data, SSH, returning to the conversation, collapsing and reopening the sidebar, and reloading.
3. Confirm that session content, task data, and the selected memory page remain intact instead of checking only sidebar highlights.
4. Use `--mnemon-first` to cover installing Mnemon before the Web UI.

The reported stuck navigation did not reproduce directly with the ordinary npm combination in this run. Do not describe it as an inevitable failure of the default original environment. Code-level tests demonstrate desynchronization when an activation announcement is missing: Mnemon's private state still says open, so clicking its entry incorrectly closes it.

For a repeatable browser before/after comparison, add `--panel-event-loss`. This installs a **test-only plugin excluded from the published package** that drops the active Task Board's `dsh-panel-activate` announcement. It does not replace Task Board, modify npm plugin code, or rewrite the displayed result. This explicitly labeled, controlled compatibility fault does not establish that the user's environment lost that announcement.

The control still displays Task Board after the third click; the patched package restores Memory System. Unit tests also cover SSH, programmatic DOM activation, navigation before synchronization, and subsequent refreshes under the legacy Web UI protocol so a hidden panel cannot reclaim the foreground.

## CLI checks

1. Confirm that the test CLI is executable and on the harness child processes' PATH.
2. With `cliPath: mnemon`, the original status page incorrectly reports that Mnemon CLI was not found, while the version dialog displays its version.
3. The patched package agrees in both places. With no active Memory Space, it reports service readiness rather than pretending to have a healthy active space.
4. Temporarily move the CLI within its test-owned directory and click Recheck: it should report missing. Restore the file and recheck again: availability should recover without restarting DSH.
5. Create and activate a test native Memory Space to verify actual CLI status execution and health. Never use personal memory directories.

## Automated verification

```sh
pnpm typecheck
pnpm exec vitest run --reporter=json --outputFile=/absolute/path/to/test-results.json
pnpm verify:build
pnpm verify:headless
pnpm verify:package
```

Save screenshots, browser-visible state records, and before/after JSON test results alongside the run's `fixture.json`. Label screenshots as ordinary-environment or controlled-fault evidence.

## Public verification record: 2026-08-30

The original control is the unmodified npm 0.3.5 release. PR code commit `5907523` incorporates `main` at `05c128b`; the patched screenshots below use a local tarball built from that commit, not a newly published version. The CLI is official Mnemon 0.2.5 for macOS arm64.

| Scenario | Screenshot | Visible result |
|---|---|---|
| Original, ordinary environment | [Incorrect CLI status](../pr-assets/npm-sidebar-cli/before-cli.jpg) | The installed CLI is reported missing |
| PR code, ordinary environment | [After ten round trips](../pr-assets/npm-sidebar-cli/after-normal.jpg) | Memory System is visible; the CLI reports readiness with no active Memory Space |
| Original, controlled announcement loss | [Failed return](../pr-assets/npm-sidebar-cli/before-controlled.jpg) | Task Board remains visible after the third click on Memory System |
| PR code, controlled announcement loss | [Successful return](../pr-assets/npm-sidebar-cli/after-controlled.jpg) | Memory System is visible after the third click |

After synchronization, `pnpm run verify` passed 541 tests and skipped one Windows-only test on macOS. Determinism for 106 build files, 35 Headless tools, 10 Node-compatible public entries, publint, and attw all passed. The upstream rc.2 missing-source-map warning remains and does not fail verification. The ordinary environment completed another ten real panel round trips, the CLI version check showed 0.2.5, and the browser console had no errors. The controlled run confirmed that the test plugin actually dropped an announcement and still returned successfully.

Patch tarball SHA-256: `0d3757f30a7f1dd79a31bec5d988bbdcdf20a9802f5b75d0e8aa9072b74b68f9`. Raw logs, version dialogs showing machine paths, and fixtures remain local; the public screenshots contain no credentials or personal memory.
