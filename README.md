# dsh-mnemon

**English** | [简体中文](https://github.com/omdsh-dev/dsh-mnemon/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/dsh-mnemon)](https://www.npmjs.com/package/dsh-mnemon)
[![Downloads](https://img.shields.io/npm/dt/dsh-mnemon)](https://www.npmjs.com/package/dsh-mnemon)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/omdsh-dev/dsh-mnemon/blob/main/LICENSE)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon)](https://dshfind.com/plugins/omdsh-dev/dsh-mnemon)

**Composable memory for DeepSeek Harness. Three tiers by default; your Sources and Strategies, one View per turn.**

Runtime context, searchable documents and long-term evidence share a familiar Sidebar. The default Starter installs a tested plugin combination; contributors can replace or extend its parts without rebuilding the memory system.

[![Real DSH Sidebar with synthetic Runtime memories](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/showcase/en/runtime.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/showcase/demo.mp4)

[Get started](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/getting-started.md) · [Watch the demo](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/showcase/demo.mp4) · [Build a plugin](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [Documentation](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/README.md)

## Use three tiers, not three copies

| Memory | Keep here | How it reaches the Agent |
|---|---|---|
| **Runtime** | Preferences, working agreements, facts needed on the next turn | Compact USER / MEMORY projection |
| **Documents** | Designs, investigations, procedures and handoffs | Search, then read the relevant narrative |
| **Memory Spaces** | Durable facts, decisions, entities and relationships | On-demand evidence from enabled backends |

Use the same data from Sidebar, conversation tools or Headless. Global, workspace and custom storage scopes are explicit. Direct retrieval does not spawn a Mnemon task Agent; Agent Query, semantic writes and maintenance may use the configured model. [Workflows and costs](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/workflows.md).

## Start with the default installation

You need a compatible DSH Host. **Mnemon Native also needs a separately installed `mnemon` CLI**; installing the npm Starter does not install that binary or third-party backend services. Follow the [platform installation guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/getting-started.md) and [verified compatibility baselines](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md).

```sh
mnemon --version
dsh plugin --profile web add dsh-mnemon
dsh web
```

For Headless, add the same package to that profile with `dsh plugin --profile headless add dsh-mnemon`.

Open **Memory System → Status**, then add a Runtime memory. Select a DSH workspace before creating Documents, even with global storage. To retain long-term facts, create a Memory Space with an explicitly selected Provider. Sidebar is the default; optional Builtin placement uses the same pages.

Upgrading from v0.4 retains the familiar configuration, data and workflow. Three optional enhancements are exposed in **Settings → Memory System**; no View tab or generic memory-plugin manager is added. [Upgrade checklist](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md).

## Source + Strategy → View

[![Source facts flow through a Strategy and Core validation into one View for the DSH Host](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/diagrams/composable-memory.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/architecture.md)

- **Source** owns memory, its projection, read/write operations and optional DSH pages.
- **Strategy** chooses how available Sources participate: selection, resident context, retrieval and guidance. Pure composition does not write memory.
- **Core** validates the proposal, asks Sources for bounded projections and compiles an immutable **View**. The **DSH Host** pins it to the executing turn and controls tool access.

A View includes context **and** the scoped routes/actions the LLM can use next. It is not another database or a frontend page. Memory Spaces owns its Provider child Fibers; Core exposes only the small `ctx.mnemonMemory` contribution service.

The same public contracts serve the default plugins and external repositories. Source authors keep their data and backend choices; Strategy authors reuse those capabilities, the turn lifecycle, budgets and test fixtures. [Architecture and sequence diagrams](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/architecture.md).

## Official plugins

The Starter ships **3 Sources, 1 default Strategy, 3 optional Strategy contributions and 9 Providers**. Packages are independently versioned and published; the Starter pins an exact tested combination.

| Package | Responsibility | Default |
|---|---|---|
| [dsh-mnemon-source-runtime](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-runtime/README.md) | USER / MEMORY, revisions and local hot storage | Enabled |
| [dsh-mnemon-source-documents](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-documents/README.md) | Markdown, search, revisions and archiving | Enabled |
| [dsh-mnemon-source-memory-spaces](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-memory-spaces/README.md) | Durable evidence and Source-owned Provider children | Enabled |
| [dsh-mnemon-strategy-default-three-tier](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-default-three-tier/README.md) | The familiar three-tier View and turn retrieval policy | Selected |
| [dsh-mnemon-strategy-auto-capture](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-auto-capture/README.md) | In-turn guidance to retain useful facts | Off |
| [dsh-mnemon-strategy-light-context](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-light-context/README.md) | A shared resident-projection ceiling | Off |
| [dsh-mnemon-strategy-scoped](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-scoped/README.md) | Ordered Source selection and a writable subset | Off |

The three enhancements occupy different slots of the default Strategy and can coexist. They still produce one View. Capture is guidance, not an autonomous recorder; a projection ceiling is not token accounting or delta injection; scoped selection does not create storage.

Memory Spaces can use these Provider plugins:

[Mnemon Native](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mnemon-native/README.md) ·
[OpenViking](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-openviking/README.md) ·
[Honcho](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-honcho/README.md) ·
[Mem0](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mem0/README.md) ·
[Hindsight](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-hindsight/README.md) ·
[Holographic](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-holographic/README.md) ·
[RetainDB](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-retaindb/README.md) ·
[ByteRover](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-byterover/README.md) ·
[Supermemory](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-supermemory/README.md).

Native is the default backend; third-party services are disabled until explicitly configured. Graph, deletion, exact-write and enumeration capabilities remain backend-specific. [Provider capabilities and setup](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/memory-providers.md).

## Build your own composition

Use `dsh-mnemon/extension-sdk` to define and install a Source or Strategy on its Cordis Fiber. Use the owning Strategy's SDK for an additive contribution, or `dsh-mnemon-source-memory-spaces/provider-sdk` for a Memory Spaces driver.

Your repository owns its manifest, public dependencies, implementation, tests and build. DSH's Profile/Loader installs and mounts it; Mnemon does not scan arbitrary installed plugins. Installing code, activating a contribution and choosing the complete Strategy are distinct decisions.

Start with the [plugin author guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) and [external consumer examples](https://github.com/omdsh-dev/dsh-mnemon/tree/main/scripts/fixtures/plugin-consumer/). They cover isolated package consumption, multiple instances, disposal, scoped reads and authorized writes. A Git or Notion integration can be a new Source; it is not implied support for every existing DSH memory plugin.

Independent plugin repositories are welcome. Contributions to this repository follow [CONTRIBUTING](https://github.com/omdsh-dev/dsh-mnemon/blob/main/CONTRIBUTING.md); discuss new capabilities and Providers in an Issue first.

## Data and trust

- Runtime and Documents are local; Native is local by default. External Providers use their configured services and scopes.
- Disabling participation does not erase memory. Switching storage scope does not migrate it. Provider disabling may clear local catalog metadata, not remote data.
- Saved Provider credentials stay on the Host and are excluded from Mnemon Packs. Packs still contain private memory and need protection.
- Source and Strategy plugins are trusted in-process JavaScript, **not sandboxed code**. Historical memory never outranks current instructions. Model-generated plugins are not automatically installed.

[Backup and recovery](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/operations.md) · [Security policy](https://github.com/omdsh-dev/dsh-mnemon/blob/main/SECURITY.md) · [Release history](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/releases/README.md) · [Roadmap](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/roadmap.md)

## Develop and verify

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:plugins
```

Use Node.js `^22.19.0 || >=24.0.0` and pnpm 10.13.1. Package-level checks run independently; WebUI captures use disposable data and a real DSH Host. Tests of mechanics are not claims of LLM accuracy or live cloud-Provider conformance. [Development](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/README.md) · [Media provenance](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/showcase/README.md).
