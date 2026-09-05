# Compatibility and upgrades

**English** | [简体中文](../zh-CN/compatibility.md) | [Documentation](./README.md)

The Starter pins a tested combination of official plugins. The table records verification scope, not a promise that every upstream release or account configuration works.

| Component | Baseline | What is verified |
|---|---|---|
| DSH | `0.1.2-rc.1` | Published contracts, WebUI and isolated Headless activation |
| Previous DSH line | `0.1.1-rc.2` | Targeted rollback and Sidebar/Builtin regression evidence; not the default development dependency |
| Node.js | `22.19` and `24` | Source CI and packed-artifact CI respectively; development requires `^22.19.0 || >=24.0.0` |
| Node.js 20 | Public package imports only | Does not establish that the DSH Host runs on Node 20 |
| Mnemon Native CLI | `0.2.5` | Opt-in tests against a real CLI and disposable data; install the CLI separately |
| Third-party Providers | Adapter contracts and fixtures | Does not establish live cloud-account conformance or upstream availability |

See [Host compatibility evidence](../pr-assets/dsh-rc1-compat/README.md), [upgrade evidence](../pr-assets/main-rebase-20260904/README.md), and [current development checks](./development.md). A passing mechanism test is not an LLM quality benchmark. OS-specific and real-CLI checks may be skipped unless their environment is explicitly available.

## Upgrade the default installation

1. Export a Mnemon Pack and protect any required Provider connection backup as described in [Operations](./operations.md#backup-and-restore).
2. Upgrade `dsh-mnemon` in each DSH profile that uses it. The Starter installs its exact plugin versions; do not update its child packages independently and assume the resulting mixture is tested.
3. Restart DSH after installing new package code. Check **Memory System → Status**, then read an existing Runtime entry, Document and active Memory Space.
4. Verify the selected storage scope before writing. Changing the scope selects a different authority; it does not migrate data.

v0.5 preserves the default v0.4 storage/configuration and Sidebar workflow. Optional `builtin` uses the same Source pages; the retained `buildin` spelling is normalized. Three memory enhancements are supplied disabled. There is no View tab or generic memory-plugin manager in this release.

Independent plugin authors use declared peer ranges and public exports. Old private controller imports are not a supported upgrade surface. Custom compositions must be verified separately from the Starter. See [Extensions](./extensions.md) and the [v0.5.0 release boundary](./releases/v0.5.0.md).
