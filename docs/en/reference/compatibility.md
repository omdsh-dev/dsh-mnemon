# Compatibility and upgrades

**English** | [简体中文](../../zh-CN/reference/compatibility.md) | [Documentation](../README.md)

The Starter pins a tested combination of official plugins. The table records verification scope, not a promise that every upstream release or account configuration works.

| Component | Baseline | What is verified |
|---|---|---|
| DSH development baseline | `0.1.5-rc.1` | Published contracts, WebUI and isolated Headless activation |
| DSH Client compatibility | `0.1.5-rc.2`, `0.1.6-alpha.2` | Full production public types, normal packed npm installs, real WebUI turn-tail peers/toggles/reload and Sidebar/Builtin navigation, packed Headless persistence and Root disable |
| DSH profile settings | `0.1.7-alpha.1` | Normal packed npm installation; real WebUI activation, combined Core/UI saves, Strategy selection, retained-settings recovery and full Host restart |
| DSH Session messages | `0.1.5-rc.2`, `0.1.6-alpha.2`, `0.1.7-alpha.1` | Same packed Mnemon artifacts complete real Runtime/status tool calls and persist producer-owned messages in Session V3/V4; alpha.7 restores the conversation and Builtin Runtime data after Host restart |
| Historical DSH Headless evidence | `0.1.2-rc.1` | Earlier revision: isolated Headless activation and restart; synthetic Session logs migrate through the 0.1.5 public loader after copy repair |
| Historical DSH evidence | `0.1.1-rc.2` | Prior Sidebar/Builtin reports retain their own revisions; not rerun for this change |
| Node.js | `22.19` and `24` | Source CI and packed-artifact CI respectively; development requires `^22.19.0 || >=24.0.0` |
| Node.js 20 | Public package imports only | Does not establish that the DSH Host runs on Node 20 |
| Mnemon Native CLI | `0.2.8` | Opt-in tests against a real CLI and disposable data; install the CLI separately |
| Third-party Providers | Adapter contracts and fixtures | Does not establish live cloud-account conformance or upstream availability |

The development lockfile remains on `0.1.5-rc.1`. Turn memory registers with a stable ID for the alpha list slot and retains the RC chain selector. The component also checks that the turn is complete before reading or showing activity. Sidebar and Settings follow DSH's public default/main session binding; Builtin and Better Sidebar keep their explicit owning session.

The current Client requires the public UI Session service. Both root DSH peer ranges are `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.1`; no official plugin peer or version changes. Older Headless and WebUI records remain historical evidence. Roll back an older DSH together with the Mnemon release previously verified for that host. DSH 0.1.7 moves live settings into profile Config. Mnemon adapts its existing settings pages to that writer and recovers retained legacy preferences as described below. Memory data and Provider formats do not change.

See [DSH 0.1.7 settings verification](../../pr-assets/issue-267-settings-migration/README.md), [RC/alpha verification and before/after screenshots](../../pr-assets/issue-261-dsh-slots/README.md), [DSH 0.1.5 verification](../../pr-assets/issue-223-dsh-015/README.md), [Host compatibility evidence](../../pr-assets/dsh-rc1-compat/README.md), [upgrade evidence](../../pr-assets/main-rebase-20260904/README.md), and [current development checks](../development/README.md). A passing mechanism test is not an LLM quality benchmark. OS-specific and real-CLI checks may be skipped unless their environment is explicitly available.

The historical v0.5.2 capture found unusable settings layout at 390px; [that failure evidence](../../pr-assets/documentation-refresh/README.md) remains versioned. The [v0.5.4 Light capture](../../assets/webui-v0.5.4/README.md) covers bilingual desktop browsing plus Memory Space navigation, creation and version maintenance at 390 × 844. Long card names and some metrics truncate. It does not retest every Host settings surface or physical phones, so the earlier settings limitation is not declared resolved.

## Desktop profile generations

Desktop may remove private `@deepseek-ai/*` packages from a plugin generation and use its own framework versions. Mnemon checks the host's public Volatile APIs before importing the live settings schema. Hosts carrying Cosmokit `1.8.3` use the existing ordinary Config and Settings path; hosts with the live APIs keep revision-checked profile settings.

In the affected `0.5.13` install, Desktop's fallback hides a missing `createVolatile` export behind `Cannot find package 'dsh-mnemon'`. Flattening `mnemon-bundle` does not fix that import failure. The Starter retains its group, root disable gate, independent Source/Strategy choices, private Provider children and existing settings namespaces. Update Mnemon in the owning profile and restart; no memory or configuration migration is required for this fix.

See the [original Desktop reproduction and verification](../../pr-assets/issue-274-profile-generation/README.md).

## DSH 0.1.7 bundle component list

In DSH `0.1.7-rc.2`, the **Plugins → dsh-mnemon** detail page lists the internal `cordis:group` / `mnemon-bundle` container as an off component. Even with all eight real components running, the count can read “9 total · 8 running · 1 off.” Clicking the container switch returns `unknown-plugin`; the Chinese UI reports “组件启用失败：找不到该插件”. See the [original screenshot](../../pr-assets/sidebar-native-20260926/before-bundle-toggle-error.jpg) and [upstream issue #649](https://github.com/dsh-external/issues/issues/649).

The host's display and management inventories disagree: its bundle declaration list includes native groups, but its manageable plugin inventory deliberately excludes them. This container's off state does not mean the Mnemon core or its children are disabled, and does not establish whether memory reads and writes work.

When this happens:

1. Inspect **Memory System → Status** and the actual Source and Strategy components. If only the container is incorrectly shown as off, while the required components and reads/writes work, you can continue using Mnemon. Actual component errors or failed operations still need separate investigation.
2. Use the top-level `dsh-mnemon` bundle switch or the core component with entry ID `mnemon` to stop and restore the composition. Do not use the `cordis:group` row's switch.
3. Keep existing configuration and memory. This display issue requires neither a data reset nor configuration or memory migration.

The Starter retains the stable group ID and the existing `mnemon` configuration target. Disabling the core stops its Sources, Strategies and private Provider children; re-enabling it restores their independent choices. Removing the group leaves enabled dependents waiting for the missing core, while making the group anonymous can leave old instances alive after a profile reload. Do not remove the container, its stable ID or alter the group declaration to hide the row. The [published lifecycle regression](../development/README.md#test-ownership-and-coverage) checks manager persistence, restarts and literal or expression-based legacy disable flags without changing the installed host.

An [upstream candidate patch](../../pr-assets/sidebar-native-20260926/upstream-fix.patch), verified in an isolated environment, omits containers from the display while retaining their actual plugin children. It is not included in published DSH `0.1.7-rc.2` or Mnemon `v0.5.16`. The local management-adapter approach requires taking over DSH's global plugin-management service; embedding it in Mnemon would compromise independent disabling of Mnemon, so it is not shipped with the plugin. Follow [#649](https://github.com/dsh-external/issues/issues/649) and subsequent DSH release notes for the fix. Screenshots of the candidate environment do not establish that the published host is fixed.

## DSH 0.1.7 settings recovery

DSH `0.1.7-alpha.1` replaces `settings.register()` and `settings-file` with Config-backed forms. Mnemon exposes live Config fields and persists its existing UI operations through the host's revision-checked profile writer. Changes to transport authority still require a normal plugin reload. DSH `0.1.5-rc.2` and `0.1.6-alpha.2` retain their existing settings path.

Mnemon messages use the producer-owned `dsh-mnemon` source kind accepted by both Session V3 and V4. Historical wrappers and DSH's migrated `plugin:dsh-mnemon` messages remain recognizable for filtering and deduplication; no existing Session files are rewritten by this change.

On startup, Mnemon can recover the retained `<profile home>/settings.yaml.imported` backup into the editable root `mnemon` entry. It restores the canonical root settings, `mnemon-ui` conversation toggles, and only the current profile's exact `mnemon-view-*` / `mnemon-plugins-*` namespaces. Explicit current profile values win, including an explicitly empty plugin selection; existing Source and Strategy rows are preserved. A Strategy row using a dynamic expression keeps that expression and skips its legacy overlay rather than freezing the current value. Recovery records `legacySettingsImported: true` in the root Config and leaves the backup unchanged.

If the original `settings.yaml` still exists when Mnemon starts, DSH owns that import. Restart the profile once more after it finishes to recover Mnemon-specific preferences. DSH exposes no completion signal for its importer, so Mnemon deliberately waits for a new host process instead of racing it. A read-only or ambiguous root cannot be edited; malformed relevant sections are not partially imported or marked complete. Retain the backup and review the startup diagnostic before repairing it. Custom root IDs and another profile's hashed namespaces are not guessed.

When rolling back DSH, keep a copy of the profile patch and retained settings backup. Settings subsequently edited on 0.1.7 are not automatically exported back to the older settings file; restore the matching backup or reapply those preferences in the older host. Runtime, Documents, Memory Spaces, and Provider data are unaffected.

## Upgrade the default installation

1. Export a Mnemon Pack and protect any required Provider connection backup as described in [Operations](../guides/operations.md#backup-and-recovery).
2. Upgrade `dsh-mnemon` in each DSH profile that uses it. The Starter installs its exact plugin versions; do not update its child packages independently and assume the resulting mixture is tested.
3. Restart DSH after installing new package code. Check **Memory System → Status**, then read an existing Runtime entry, Document and active Memory Space.
4. Verify the selected storage scope before writing. Changing the scope selects a different authority; it does not migrate data.

v0.5 preserves the default v0.4 storage/configuration and Sidebar workflow. Optional `builtin` uses the same Source pages; the retained `buildin` spelling is normalized. Three memory enhancements are supplied disabled. There is no View tab or generic memory-plugin manager in this release.

Independent plugin authors use declared peer ranges and public exports. Old private controller imports are not a supported upgrade surface. Custom compositions must be verified separately from the Starter. See [Extensions](../development/extensions.md) and the [v0.5.0 release boundary](../releases/v0.5.0.md).
