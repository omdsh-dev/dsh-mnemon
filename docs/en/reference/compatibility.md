# Compatibility and upgrades

[简体中文](../../zh-CN/reference/compatibility.md) | **English** | [Documentation](../README.md)

The Starter pins a tested combination of official plugins. The table records verification scope, not a promise that every upstream release or account configuration works.

| Component | Baseline | What is verified |
|---|---|---|
| DSH current RC | `0.2.1-rc.5` | Pinned development baseline and an installed-host CI target. The npm `latest` and `next` tags pointed here on 2026-11-02; this is still a prerelease. |
| DSH earlier supported hosts | `0.2.0-rc.2`, `0.2.1-rc.3` | CI runs every root test against these installed packages. See [DSH 0.2.0 and 0.2.1](#dsh-020-and-021) for version differences; the supported range still admits 0.2.1-rc.1 and rc.2. |
| DSH alpha track | `0.2.2-alpha.3` | Separate installed-host CI target on the verified Node 24.22.2 toolchain; the published alpha Host itself requires Node 24.9.0 or later. This is the npm `alpha` tag checked on 2026-11-04, not the default development host or a guarantee for later alphas. |
| Node.js | `22.19` and `24` | Source CI and packed-artifact CI respectively; development requires `^22.19.0 \|\| >=24.11.0` |
| Node.js 20 | Public package imports only | Does not establish that the DSH Host runs on Node 20 |
| Mnemon Native CLI | `0.2.9`; embedding model checks require `0.2.13+` | Opt-in tests against a real CLI and disposable data; install the CLI separately. Older versions retain their other commands, but Test status asks for an upgrade because their availability fields only establish provider reachability |
| Third-party Providers | Adapter contracts and fixtures | Does not establish live cloud-account conformance or upstream availability |

The earlier alpha.2 acceptance used Cordis `4.0.6-alpha.1` and Loader `1.0.7-alpha.1`. Fresh alpha.2 installations now resolve their newer alpha.2 dependencies, which are incompatible with that Host's fixed app-boot package: settings updates fail even without Mnemon. Use alpha.3 for the current alpha validation target; changing the CI target does not repair existing alpha.2 installations. [Isolated Host evidence](../../pr-assets/issue-554-alpha-host/README.md) separates this upstream failure from the test fixture's Loader selection and legacy-reader adaptation.

DSH 0.2.1-rc.3 and the current RC/alpha targets fetch the official API-key model directory over the network. The task Agent model selector allows that Provider up to six seconds, covering DSH's default five-second request budget; other Providers retain their three-second bound. This changes directory loading only, not model selection, inference timeouts or saved configuration.

dsh-mnemon supports `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`: DSH 0.2.0 from 0.2.0-rc.2, and DSH 0.2.1 and the later 0.2 releases from 0.2.1-rc.1, final releases included. DSH 0.2.1 reads the range from the Starter's `engines.dsh`; DSH 0.2.0 reads it from the Starter's DSH peers (`dsh-app-boot`, which is optional, and `dsh-typert-protocol`), which state the same range. Before DSH installs a plugin, and each time a profile starts, it checks the range against its own version, prereleases included, and refuses a release that excludes it or turns it off. `tests/dsh-host-compatibility.spec.ts` runs DSH's own check over all 19 package manifests, for the supported releases and for those no longer supported. The five Strategy packages require `dsh-mnemon ^0.5.17`, whose extension SDK they use; the Documents, Memory Spaces and Runtime Sources require `^0.5.19`, while the Skills Source requires `^0.5.37`. The Providers depend on the Memory Spaces Source instead.

DSH 0.2.2-alpha.2 moves tool execution into separate native/PTC executor plugins and changes `tools.execute()` to a batch API. Mnemon detects the published `setExecutor()` capability, submits one correlated call, and accepts only its matching final outcome. The Host still owns guards, pre/post policy and PTC dispatch. Automatic admission also needs the in-turn audit fix from [#541](https://github.com/omdsh-dev/dsh-mnemon/issues/541); the missing-View case in [#542](https://github.com/omdsh-dev/dsh-mnemon/issues/542) is a separate fix. This compatibility change uses published npm packages and isolated synthetic profiles; it does not change DSH source, storage formats, or the supported version range. Verification scope and upstream references are recorded in [current DSH evidence](../../pr-assets/current-dsh-compat/README.md).

Source tool activation uses the published DSH `tools.register()` disposer and scoped `tools.get()` contracts on supported 0.2.0/0.2.1 Hosts. Child allowlists omit unregistered optional tools before DSH applies `restrict()`. Initial Loader-managed startup publishes named families in historical registry order after `Loader.await()`; later reactivation appends them without restarting surviving tools. DSH independently sorts wire schemas by default. Source configuration transactions retain the prior inventory until their final committed state. [Synthetic Host evidence](../../pr-assets/issue-522-source-tool-lifecycle/README.md) records local schema updates, surviving Documents/Runtime writes, and spawn/fork review coverage; remote compatibility CI remains required for the PR head. Storage formats, Provider contracts and existing View authority checks are unchanged.

<a id="host-behavior-on-a-first-install"></a>

Git sync keeps its existing settings and payload formats. The saved default author pair now follows the mirror's Git identity before using the placeholder; other custom pairs retain precedence. Retrying an author-rejected sync rebuilds only the unpublished mirror commit from current memory and preserves published history. On rollback to 0.5.38 or earlier, select **This computer's Git** (blank author fields) or **Custom** to retain the real identity; those releases interpret the default pair literally. See [Git repository sync](../guides/operations.md#git-repository-sync).

Installing for the first time? How DSH chooses the registry, and why its result card shows the package's English description, is in [Install and start](../guides/installation.md#3-install-and-enable-dsh-mnemon); why a release younger than 24 hours can install an earlier one is under [Common problems](../guides/installation.md#common-problems).

<a id="older-dsh-releases"></a>

**Older DSH releases.** Keep the dsh-mnemon release that supports your DSH until you upgrade the host:

| DSH | dsh-mnemon |
|---|---|
| `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.1-alpha.2` | `0.5.30` |
| `0.2.1-alpha.3` and later alphas | None works in full: memory subagents and **Check versions → Update** fail in 0.5.30. Upgrade DSH to `0.2.1-rc.2` or later |
| `0.1.5-rc.1` to `0.1.7-alpha.1` | `0.5.16` |

What those hosts needed is kept under [Older DSH hosts](#older-dsh-hosts). How each release was verified, and the earlier Headless and WebUI records that remain historical evidence, are under [Verification and evidence](#verification-and-evidence).

### Source DSH 0.2.2 ownership compatibility (#554)

The source build at `8bd073392eef6f54e921a093b95076248eb08cbb` differs from npm `0.2.2-alpha.3`: the published package still exposes `agents.roots()` and `agents.isOwnedBy()`. The source build instead exposes `subagents.rootOf()`, flattens `startActivation()` arguments and removes provider enumeration. Mnemon uses exact live Host ownership for root adoption and guarded spawn/fork delegation. It does not infer authority from Session headers. Hosts exposing `lineageOf()` use their publication-time binding; the earlier `rootOf()` contract uses `subagent/start` before prompt admission and cancels Mnemon-started activations if composition or guard installation fails. Native Host starts can continue without memory after a child-memory installation failure; Mnemon reads and Actions reject without that child's View pin. Without provider enumeration, only the official `spawn` and `fork` names are probed.

**This is a scoped startup and conversation-delegation fix, not full compatibility with every source DSH 0.2.2 feature.** This source Host has no public equivalent of Mnemon's hidden standalone task Agent: it rejects a standalone Agent marked as a subagent, while an ordinary root can leave an unwanted conversation in history. Mnemon therefore refuses standalone management before creating any Session. Affected operations are standalone Skills tasks, the Memory page's evidence answers and Save to memory, Runtime maintenance, Document creation/archive, Provider placement, and Memory Space metadata maintenance. Conversation-bound memory and guarded spawn/fork delegation remain available. Use the verified published `@deepseek-ai/dsh@0.2.1-rc.5` when these standalone operations are required; existing published Hosts keep their task behavior and stored data.

The source build, synthetic-model checks, npm alpha.3 checks and the remaining source-profile limitation are recorded in [issue #554 evidence](../../pr-assets/issue-554-agent-ownership/README.md). No DSH source, development dependency baseline, configuration format or stored Session is rewritten.

## Upgrade the default installation

1. Export a Mnemon Pack and protect any required Provider connection backup as described in [Operations](../guides/operations.md#backup-and-recovery).
2. Upgrade `dsh-mnemon` in each DSH profile that uses it, with **Check versions → Update** or the [commands in Install and start](../guides/installation.md#update-and-uninstall). The Starter installs its exact plugin versions; do not update its child packages independently and assume the resulting mixture is tested. Moving to another DSH release as well? Follow the [upgrade order](#upgrade-order).
3. Restart DSH after installing new package code. Check **Memory System → Status**, then read an existing Runtime entry, Document and active Memory Space.
4. Verify the selected storage scope before writing. Changing the scope selects a different authority; it does not migrate data.

### Upgrade order

Update dsh-mnemon on your current DSH first, then upgrade DSH. On DSH 0.1.7-rc.2 that means dsh-mnemon 0.5.30 first (`dsh plugin --profile web add dsh-mnemon@0.5.30`); then install DSH 0.2.0-rc.2 or 0.2.1-rc.2 and update dsh-mnemon again. If DSH was upgraded first, DSH 0.2 turns a release before 0.5.19 off, with memory data untouched, and updating the plugin brings it back; on DSH 0.2.1, releases up to 0.5.30 keep running, but their memory subagents and **Check versions → Update** fail until you update. Do not use `allow-version` to let an unsupported release through.

On DSH 0.2.1, **Check versions → Update** in dsh-mnemon 0.5.30 and earlier stops with `already-installed`. Quit DSH, run `dsh plugin --profile web add dsh-mnemon@<version>`, then start DSH again. The command line does not manage the desktop app's `desktop` profile: there, uninstall dsh-mnemon on the Plugins page and add it again with **Add plugin** as `dsh-mnemon@<version>`, then quit the app completely and open it again. Your memory data and settings stay. Later updates go through **Check versions** as usual.

### Upgrading from v0.4

v0.5 preserves the default v0.4 storage, configuration and sidebar workflow. The optional conversation-tab placement (`builtin`) uses the same Source pages, and the retained `buildin` spelling is normalized. The General strategy and the three memory enhancements ship disabled. Memory composition on the Plugins page lists, switches and configures the installed components; there is no separate View tab.

### Independent plugins

Independent plugin authors use declared peer ranges and public exports. Old private controller imports are not a supported upgrade surface. Custom compositions must be verified separately from the Starter. See [Extensions](../development/extensions.md) and the [v0.5.0 release boundary](../releases/v0.5.0.md).

<a id="dsh-02"></a>

## DSH 0.2.0 and 0.2.1

dsh-mnemon runs the same on both releases, with the same memory data.

Turn memory registers with a stable ID in DSH's `conversation.chat.turnTail` list slot and checks that the turn is complete before reading or showing activity. The sidebar placement and the `dsh-mnemon` page under Plugins follow DSH's public default/main session binding; the conversation-tab placement and Better Sidebar keep their explicit owning session. DSH keeps live settings in profile Config and edits a plugin's configuration on its page under Plugins; Mnemon's configuration page writes through it. Memory data and Provider formats do not change.

Where the two differ, dsh-mnemon takes the path each one offers:

- **Memory subagents.** DSH 0.2.0 starts a child with the one-shot `subagents.start`, and its spawn and fork providers take the child's instructions and tool filter in the start request. DSH 0.2.1 starts every child as a managed activation (`startActivation`, [#356](https://github.com/omdsh-dev/dsh-mnemon/issues/356)) and takes neither: a child runs with its parent's tools and instructions, or with an Agent Preset named for it. On DSH 0.2.1 dsh-mnemon starts each memory subagent with caller delivery, so the result returns to Mnemon and the conversation gets no completion notice, and it registers the child's instructions and tool list in the child's own scope while DSH publishes it, before its first step and before other plugins see it. Either way the child sees only its memory tools and its result tool. This covers Save to memory, Memory Space writes such as `mnemon_remember`, USER.md compaction, working-memory archiving, idle review, Document archive and Git sync's reconciliation review. On DSH 0.2.1 only a provider whose children DSH creates in this process, such as its spawn and fork, is used this way; any other is refused before it starts, so a memory task never runs with the conversation's tools.
- **Continuable memory tasks on DSH 0.2.1.** Every local child is continuable there:
  - a child started under the conversation, such as a delegated write or an idle review, is listed among its subagents as continuable. A later message from the model, or one you send it from that list, resumes it outside Mnemon's delegation, with the conversation's own tools and instructions. Once its task has finished, Mnemon refuses it every memory tool, so it can only reply ([#387](https://github.com/omdsh-dev/dsh-mnemon/issues/387)). Mnemon cannot remove these entries, so leave them and ask in the conversation instead;
  - while it runs, it takes one of the conversation's subagent slots (`maxActiveSubagents`, 8 by default). With all of them taken, a memory task fails with `subagent limit reached`.

  On DSH 0.2.0 a memory task cannot be resumed.
- **Working directory.** Before each step DSH 0.2.1 returns an Agent to its session's original directory when the current one is gone, and stops it when that is gone too. A background memory task for a workspace whose folder was deleted or moved therefore keeps that workspace, whose memory it works on, and runs from the first existing workspace or where DSH started. DSH 0.2.0 keeps no working directory per session.
- **Check versions → Update.** DSH 0.2.0 installs the new version through its own installer. With hot reload, DSH 0.2.1 no longer installs over a plugin the profile has: another version replaces it only after it is removed, which would stop dsh-mnemon halfway through its own update, and a failed install would leave the profile without it. There dsh-mnemon runs DSH's own `dsh plugin add` for the new version ([how updates work](../guides/operations.md#version-checks-and-updates)). It holds the profile's lock, uses the package manager DSH was started with, and refuses a release incompatible with the running DSH before it installs anything. Where DSH offers no such command, the error names the `dsh plugin` command to run with DSH stopped. On both releases a restart applies the update. dsh-mnemon 0.5.30 and earlier stop on DSH 0.2.1 with `DSH could not install dsh-mnemon@<version>: already-installed`; update those once as [Upgrade order](#upgrade-order) describes.
- **Incompatible releases.** When DSH refuses an update as incompatible, the error names what the release needs: `requires DSH ^0.3.0` where DSH 0.2.1 reports the release's requirements, `requires @deepseek-ai/dsh ^0.3.0` where DSH 0.2.0 reports its peers.
- **Plugins page.** DSH 0.2.0 lists the Starter's grouping row as an off component; see [the bundle component list on DSH 0.2.0](#the-bundle-component-list-on-dsh-020). DSH 0.2.1 lists only the components.

Where each of these paths lives in the code, and what retires the DSH 0.2.0 half, is in the [compatibility register](../development/compatibility-register.md) with the rest of the compatibility code.

## Desktop windows

DSH desktop windows load from the app's own `dsh-app://app/` address instead of a loopback URL. A page the application serves itself (an address other than `http:` or `https:`) uses Mnemon's local channels; it counts as remote only when DSH declares a transport for it that does not own the Host. The DSH desktop app declares `ownsHost: true`. Pages opened from another device keep the API Gateway and its read-only default, and the Memory System and the plugin settings say that `remoteAccess: trusted-host` and a DSH restart are needed. The local channels and `/api` share DSH's Host/Origin checks and browser-session authentication. [Desktop windows on DSH 0.1.7](#desktop-windows-on-dsh-017) describes the read-only state 0.5.18 and earlier showed there.

## Installing and enabling the Starter without a restart

Desktop generation directories and pnpm installs can expose only the `dsh-mnemon` root in the profile, as first seen on DSH `0.1.7-rc.2`. The component packages exist in its dependency tree, but a host started without the bundle selected may still use its startup package-resolution table. First activation then reports `ERR_MODULE_NOT_FOUND` for Runtime, Documents, Memory Spaces and the default Strategy.

The Starter's component group `mnemon-bundle` (the module `dsh-mnemon/bundle`) prepares dependency resolution and then mounts its children with DSH's own `cordis:group`. It uses the host's public package-resolution service, preserves startup routes for other bundles, and lets the host reject incompatible module rebinding. It does not flatten packages, rewrite profile links or patch DSH. Existing Entry IDs, the core disable gate, independent component choices and memory data stay intact. In 0.5.18 and 0.5.19 a separate readiness entry, `dsh-mnemon/starter` (`mnemon-starter`), did this, and the group waited for its `mnemonStarterReady`. From 0.5.20 they are one entry: the Plugins page no longer shows a separate readiness row, and the group cannot be left waiting because that row was turned off.

Mnemon also registers Web RPC routes in its own injected transport scope, so an already-running official Connection does not need to restart. Use the bundle or core switch to control the composition. In 0.5.18 and 0.5.19, turning `dsh-mnemon/starter` off leaves `mnemon-bundle` waiting for `mnemonStarterReady`: `dsh web` starts without the Memory System, and the desktop app treats it as a failed start; see [Install and start](../guides/installation.md#dsh-says-waiting-for-service-mnemonstarterready). After an update to 0.5.20 or later, a leftover `- id: mnemon-starter` row in a profile patch matches no entry and the host ignores it (the desktop app logs `patch: entry "mnemon-starter" not found`); you can delete those two lines.

The cost is in DSH's config schema export: `dsh web --dump-config-schema` walks only native `cordis:group` and `cordis:include` carriers, so it reports `mnemon-bundle` as an unrecognized tree carrier and leaves out its components' schemas, as it does for DSH's own agent presets. Runtime configuration, the Plugins page and profile patches are unaffected.

A fresh installation through the official WebUI can use **Enable now** in the same host process. A previously installed, disabled bundle can also start directly. Updating or removing packages that Node has already loaded remains subject to DSH's normal restart requirements; this does not replace loaded modules. For example, enabling components after an in-place update without a restart reports that an entry point the new version added is not exported (`ERR_PACKAGE_PATH_NOT_EXPORTED`): `./starter` after an update from 0.5.17 or earlier, `./bundle` after an update from 0.5.18 or 0.5.19. The Loader does not swap the module of a running entry, so an update from 0.5.18 or 0.5.19 can instead leave the old group waiting for the removed `mnemonStarterReady` (`mnemon-bundle (dsh-mnemon/bundle): pending …`). Both clear on restart; see the [upgrade evidence](../../pr-assets/starter-group-upgrade/README.md). See the [installation and activation evidence](../../pr-assets/desktop-live-activation/README.md) and the [component group evidence](../../pr-assets/starter-group-readiness/README.md).

<a id="dsh-017-bundle-component-list"></a>

## The bundle component list on DSH 0.2.0

On DSH 0.2.0, as on 0.1.7, the **Plugins → dsh-mnemon** detail page lists the internal `mnemon-bundle` container as an off component (shown as `dsh-mnemon/bundle` from 0.5.20, `cordis:group` before). With all nine real components running the list reads “10 total · 9 running · 1 off”. Clicking the container switch returns `unknown-plugin`; the Chinese UI reports “组件启用失败：找不到该插件”. See the [original screenshot](../../pr-assets/sidebar-native-20260926/before-bundle-toggle-error.jpg) and [upstream issue #649](https://github.com/dsh-external/issues/issues/649). DSH 0.2.1 no longer lists the container.

The host's display and management inventories disagree: its bundle declaration list includes native groups, but its manageable plugin inventory deliberately excludes them. This container's off state does not mean the Mnemon core or its children are disabled, and does not establish whether memory reads and writes work.

When this happens:

1. Inspect **Memory System → Status** and the actual Source and Strategy components. If only the container is incorrectly shown as off, while the required components and reads/writes work, you can continue using Mnemon. Actual component errors or failed operations still need separate investigation.
2. Use the top-level `dsh-mnemon` bundle switch or the core component with entry ID `mnemon` to stop and restore the composition. Do not use the `mnemon-bundle` container row's switch. Where DSH lists that row, the `dsh-mnemon` configuration page says this right above the component list.
3. Keep existing configuration and memory. This display issue requires neither a data reset nor configuration or memory migration.

The Starter retains the stable group ID and the existing `mnemon` configuration target. Disabling the core stops its Sources, Strategies and private Provider children; re-enabling it restores their independent choices. Removing the group leaves enabled dependents waiting for the missing core, while making the group anonymous can leave old instances alive after a profile reload. Do not remove the container, its stable ID or alter the group declaration to hide the row. The [published lifecycle regression](../development/README.md#test-ownership-and-coverage) checks manager persistence, restarts and literal or expression-based legacy disable flags without changing the installed host.

<a id="dsh-017-settings-recovery"></a>

## Settings from older hosts

DSH 0.1.7 replaced `settings.register()` and `settings-file` with Config-backed forms, which later releases keep. Mnemon exposes live Config fields and persists its existing UI operations through the host's revision-checked profile writer. Changes to transport authority still require a normal plugin reload.

Mnemon messages use the producer-owned `dsh-mnemon` source kind accepted by both Session V3 and V4. Historical wrappers and DSH's migrated `plugin:dsh-mnemon` messages remain recognizable for filtering and deduplication; no existing Session files are rewritten by this change. The task a delegated child receives is a user message instead, marked by its first line; see [Delegated child sessions](./workflows.md#delegated-child-sessions).

DSH imports a `settings.yaml` left by an older host into the profile once and keeps it as `<profile home>/settings.yaml.imported`. On startup, Mnemon can recover that backup into the editable root `mnemon` entry. It restores the canonical root settings, `mnemon-ui` conversation toggles, and only the current profile's exact `mnemon-view-*` / `mnemon-plugins-*` namespaces. Explicit current profile values win, including an explicitly empty plugin selection; existing Source and Strategy rows are preserved. A Strategy row using a dynamic expression keeps that expression and skips its legacy overlay rather than freezing the current value. Recovery records `legacySettingsImported: true` in the root Config and leaves the backup unchanged.

If the original `settings.yaml` still exists when Mnemon starts, DSH owns that import. Restart the profile once more after it finishes to recover Mnemon-specific preferences. DSH exposes no completion signal for its importer, so Mnemon deliberately waits for a new host process instead of racing it. A read-only or ambiguous root cannot be edited; malformed relevant sections are not partially imported or marked complete. Retain the backup and review the startup diagnostic before repairing it. Custom root IDs and another profile's hashed namespaces are not guessed.

When rolling back to such an older host, keep a copy of the profile patch and retained settings backup, and reinstall the dsh-mnemon release that supports it (see [Older DSH releases](#older-dsh-releases)). Settings edited since are not automatically exported back to the older settings file; restore the matching backup or reapply those preferences in the older host. Runtime, Documents, Memory Spaces, and Provider data are unaffected. See the [DSH 0.1.7 settings verification](../../pr-assets/issue-267-settings-migration/README.md).

<a id="ptc-idle-review-history-recovery"></a>

## PTC idle review history recovery

In v0.5.38, automatic review could execute its PTC availability probe after `turn/end`. DSH's v4 reader then rejects the whole session with `tool/ptc-dispatch-start is outside an open turn`. The fix performs and drains that check inside the awaited stopping hook; upgrading prevents new occurrences but does not rewrite already damaged history.

For an affected **unseeded root v4 session**, the bundled recovery CLI can produce a separate copy. Stop DSH, back up the entire session directory, and use a new output path in an existing backup directory:

```bash
dsh-mnemon-repair-session --input /backup/session.v4.jsonl.zstd
dsh-mnemon-repair-session --input /backup/session.v4.jsonl.zstd --output /recovered/session.v4.jsonl.zstd
```

The first command only previews. The copy step recognizes paired out-of-turn `mnemon_subagent_result` probes with the original UUID correlation and empty result payload; it retains their complete audit data as ignorable Mnemon recovery records. It preserves every event offset, timestamp, conversation message and unrelated row. It neither truncates history nor changes memory storage. Plain JSONL and checksummed Zstandard are supported; existing input/output files are never overwritten. Seeded/child sessions, orphan probes, write-tool calls, nonempty results, ambiguous fields and referenced probe records are refused.

`migrationValidated: false` means the CLI does not certify the rest of the session. Load the recovered copy through the same DSH version in an isolated session store before replacing that one generation file with DSH stopped; retain the original offline. If DSH still refuses it or the CLI reports an unsupported shape, keep the original and request diagnosis rather than deleting records. [Synthetic reproduction and validation](../../pr-assets/issue-541-idle-probe-history/README.md) cover the published reader, unchanged messages and recovery refusal cases.

## Older DSH hosts

These notes describe hosts that only the older dsh-mnemon releases in the [table above](#older-dsh-releases) support.

### Desktop windows on DSH 0.1.7

The DSH 0.1.7 desktop app declares no transport for its `dsh-app://app/` page. dsh-mnemon 0.5.18 and earlier therefore treated desktop windows as remote pages: every call went through the API Gateway, and the default `remoteAccess: read-only` made runtime memory, Memory Spaces and the plugin settings read only in the interface while agent tools could still write ([#310](https://github.com/omdsh-dev/dsh-mnemon/issues/310)). From 0.5.19 such a page uses the local channels, as [Desktop windows](#desktop-windows) describes.

How it was verified: an Electron window standing in for the desktop shell registers the same standard, secure `dsh-app` scheme as the official app and proxies to a Host that listens only on 127.0.0.1. The published 0.5.18 reproduced the read-only state on DSH 0.1.7-rc.2 (all 13 Mnemon calls through the API Gateway); with the fix, both DSH 0.1.7-rc.2 and 0.2.0-rc.1 (`ownsHost: true`) add runtime memory through the local `/dsh-mnemon-write` channel, and Memory Spaces and the plugin settings are editable, while a remote page opened through a trusted authority stays read only and says why.

### Desktop profile generations

Desktop may remove private `@deepseek-ai/*` packages from a plugin generation and use its own framework versions. Mnemon builds its live settings schema from the host's public Volatile APIs, which DSH `0.1.7-rc.2` provides through Cosmokit `1.8.5`. A generation whose host carries an older Cosmokit without them, such as `1.8.3`, is an unsupported host; keep dsh-mnemon `v0.5.16` there.

In the affected `0.5.13` install, Desktop's fallback hides a missing `createVolatile` export behind `Cannot find package 'dsh-mnemon'`. Flattening `mnemon-bundle` does not fix that import failure. The Starter retains its group, root disable gate, independent Source/Strategy choices, private Provider children and existing settings namespaces. Update Mnemon in the owning profile and restart; no memory or configuration migration is required for this fix. See the [original Desktop reproduction and verification](../../pr-assets/issue-274-profile-generation/README.md).

## Verification and evidence

### The supported hosts

The root tests run on the pinned 0.2.1-rc.2 and, in CI, against DSH 0.2.0-rc.2 installed from npm (`pnpm run test:installed-dsh`; see [Development](../development/README.md#environment-and-commands)); the real-host specs compose whichever DSH they run on. On both releases Headless passes with and without the optional Strategies, as do the Starter's activation contracts and Git sync's checks; only `--check-declared-rows` fails on 0.2.0-rc.2, on its grouping-row listing. The [DSH 0.2.1-rc.2 record](../../pr-assets/dsh-021-rc2/README.md) has the checks on 0.2.1-rc.2, and the [DSH 0.2.1-rc.1 record](../../pr-assets/dsh-021-rc1/README.md) the WebUI checks on 0.2.1-rc.1 and 0.2.0-rc.2. Earlier records: the [0.2.0-rc.2 release acceptance](../../pr-assets/release-v0.5.22/README.md), [activations (#356)](../../pr-assets/issue-356-subagent-activation/README.md), [0.2.1-alpha.2](../../pr-assets/dsh-021-alpha2/README.md) and [0.2.1-alpha.3](../../pr-assets/dsh-021-alpha3/README.md).

See also the [upgrade evidence](../../pr-assets/main-rebase-20260904/README.md) and the [current development checks](../development/README.md). A passing mechanism test is not an LLM quality benchmark. OS-specific and real-CLI checks may be skipped unless their environment is explicitly available.

### Product media

The [v0.5.32 Light gallery](../../assets/webui-v0.5.32/README.md), captured on DSH 0.2.1-rc.2, covers the bilingual desktop pages, DSH's Plugins page and dsh-mnemon's page, and a conversation, Memory Spaces and the composition board at 390 × 844, where long names truncate and, in English, the active Memory System tab can sit off-screen. It does not retest every Host settings surface, DSH 0.2.0 or physical phones, so phone support is not declared complete; the historical v0.5.2 layout failure at 390 px keeps its [versioned evidence](../../pr-assets/documentation-refresh/README.md).

<a id="other-records"></a>

### Older hosts

The [DSH 0.1.5 verification](../../pr-assets/issue-223-dsh-015/README.md), [RC/alpha verification and before/after screenshots](../../pr-assets/issue-261-dsh-slots/README.md), [Host compatibility evidence](../../pr-assets/dsh-rc1-compat/README.md) and the [DSH 0.2.0-rc.1 installation gallery](../../assets/install-v0.5.19/README.md) record those hosts. An [upstream candidate patch](../../pr-assets/sidebar-native-20260926/upstream-fix.patch) for the bundle component list, verified in an isolated environment, omits containers from the display while retaining their actual plugin children; it was never part of a published DSH 0.1.7.
