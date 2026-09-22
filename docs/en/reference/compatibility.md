# Compatibility and upgrades

**English** | [简体中文](../../zh-CN/reference/compatibility.md) | [Documentation](../README.md)

The Starter pins a tested combination of official plugins. The table records verification scope, not a promise that every upstream release or account configuration works.

| Component | Baseline | What is verified |
|---|---|---|
| DSH development baseline | `0.1.5-rc.1` | Published contracts, WebUI and isolated Headless activation |
| DSH Client compatibility | `0.1.5-rc.2`, `0.1.6-alpha.2` | Full production public types, normal packed npm installs, real WebUI turn-tail peers/toggles/reload and Sidebar/Builtin navigation, packed Headless persistence and Root disable |
| Historical DSH Headless evidence | `0.1.2-rc.1` | Earlier revision: isolated Headless activation and restart; synthetic Session logs migrate through the 0.1.5 public loader after copy repair |
| Historical DSH evidence | `0.1.1-rc.2` | Prior Sidebar/Builtin reports retain their own revisions; not rerun for this change |
| Node.js | `22.19` and `24` | Source CI and packed-artifact CI respectively; development requires `^22.19.0 || >=24.0.0` |
| Node.js 20 | Public package imports only | Does not establish that the DSH Host runs on Node 20 |
| Mnemon Native CLI | `0.2.8` | Opt-in tests against a real CLI and disposable data; install the CLI separately |
| Third-party Providers | Adapter contracts and fixtures | Does not establish live cloud-account conformance or upstream availability |

The development lockfile remains on `0.1.5-rc.1`. Turn memory registers with a stable ID for the alpha list slot and retains the RC chain selector. The component also checks that the turn is complete before reading or showing activity. Sidebar and Settings follow DSH's public default/main session binding; Builtin and Better Sidebar keep their explicit owning session.

The current Client requires the public UI Session service. Both root DSH peer ranges are `^0.1.5-rc.1 || ^0.1.6-alpha.2`; no official plugin peer or version changes. Older Headless and WebUI records remain historical evidence. Roll back an older DSH together with the Mnemon release previously verified for that host. This compatibility fix requires no configuration or stored-data migration.

See [RC/alpha verification and before/after screenshots](../../pr-assets/issue-261-dsh-slots/README.md), [DSH 0.1.5 verification](../../pr-assets/issue-223-dsh-015/README.md), [Host compatibility evidence](../../pr-assets/dsh-rc1-compat/README.md), [upgrade evidence](../../pr-assets/main-rebase-20260904/README.md), and [current development checks](../development/README.md). A passing mechanism test is not an LLM quality benchmark. OS-specific and real-CLI checks may be skipped unless their environment is explicitly available.

The historical v0.5.2 capture found unusable settings layout at 390px; [that failure evidence](../../pr-assets/documentation-refresh/README.md) remains versioned. The [v0.5.4 Light capture](../../assets/webui-v0.5.4/README.md) covers bilingual desktop browsing plus Memory Space navigation, creation and version maintenance at 390 × 844. Long card names and some metrics truncate. It does not retest every Host settings surface or physical phones, so the earlier settings limitation is not declared resolved.

## Upgrade the default installation

1. Export a Mnemon Pack and protect any required Provider connection backup as described in [Operations](../guides/operations.md#backup-and-recovery).
2. Upgrade `dsh-mnemon` in each DSH profile that uses it. The Starter installs its exact plugin versions; do not update its child packages independently and assume the resulting mixture is tested.
3. Restart DSH after installing new package code. Check **Memory System → Status**, then read an existing Runtime entry, Document and active Memory Space.
4. Verify the selected storage scope before writing. Changing the scope selects a different authority; it does not migrate data.

v0.5 preserves the default v0.4 storage/configuration and Sidebar workflow. Optional `builtin` uses the same Source pages; the retained `buildin` spelling is normalized. Three memory enhancements are supplied disabled. There is no View tab or generic memory-plugin manager in this release.

Independent plugin authors use declared peer ranges and public exports. Old private controller imports are not a supported upgrade surface. Custom compositions must be verified separately from the Starter. See [Extensions](../development/extensions.md) and the [v0.5.0 release boundary](../releases/v0.5.0.md).
