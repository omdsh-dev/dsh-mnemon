<h1 align="center">dsh-mnemon</h1>

<p align="center"><strong>English</strong> · <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-mnemon?label=npm" /></a>
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-mnemon?label=downloads%20total" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/omdsh-dev/dsh-mnemon" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/dsh-mnemon" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?lang=en" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind downloads" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?metric=downloads&amp;lang=en" /></a>
</p>

<p align="center"><strong>Composable memory for DeepSeek Harness.</strong></p>
<p align="center">Three tiers by default · Your Sources and Strategies · One View per turn</p>

<p align="center">
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/ui-guide.md">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/docs/assets/webui-v0.5.4/en/spaces.jpg" alt="Memory Spaces in the Light DSH Sidebar after importing a Mnemon Pack" width="1180" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/getting-started.md"><strong>Get started</strong></a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/webui-v0.5.4/en/demo.mp4">Watch the v0.5.4 Light demo</a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md">Build a plugin</a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/README.md">Documentation</a>
</p>

Runtime context, searchable documents and long-term evidence share a familiar Sidebar. The default Starter installs a tested plugin combination; contributors can replace or extend its parts without rebuilding the memory system.

Automatic idle review now uses bounded spawn checkpoints, a five-minute minimum interval and a 20-attempt limit per loaded session. It can be disabled independently. Published Agent Teams tool conflicts pause review before any child starts; failed runs retain committed receipt metadata and are never replayed automatically. See [review configuration and compatibility](./docs/en/reference/configuration.md#provider-requirements).

## Use three tiers, not three copies

| Memory | Keep here | How it reaches the Agent |
|---|---|---|
| **Runtime** | Preferences, working agreements, facts needed on the next turn | Compact USER / MEMORY projection |
| **Documents** | Designs, investigations, procedures and handoffs | Search, then read the relevant narrative |
| **Memory Spaces** | Durable facts, decisions, entities and relationships | On-demand evidence from enabled backends |

A **memory space** is one named, Provider-backed scope for long-term evidence. It contains individual memories and can be activated independently. The Chinese product term is **记忆空间**.

Use the same data from Sidebar, conversation tools or Headless. Global, workspace, centralized workspace and custom storage scopes are explicit. Direct retrieval does not spawn a Mnemon task Agent; Agent Query, semantic writes and maintenance may use the configured model. [Workflows and costs](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/workflows.md).

## Start with the default installation

You need a compatible DSH Host. **Mnemon Native also needs a separately installed `mnemon` CLI**; installing the npm Starter does not install that binary or third-party backend services. Follow the [platform installation guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/getting-started.md) and [verified compatibility baselines](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md).

```sh
mnemon --version
dsh plugin --profile web add dsh-mnemon
dsh web
```

The pinned development baseline is DSH `0.1.5-rc.1`; additional verified versions are recorded in the [compatibility matrix](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md). Existing Sessions with `source summary requires notice form` need the explicit `dsh-mnemon-repair-session --input FILE --output NEW_FILE` copy repair; see [legacy Session recovery](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/operations.md#dsh-015-compatibility-and-legacy-session-recovery) before replacing any artifact.

For Headless, add the same package to that profile with `dsh plugin --profile headless add dsh-mnemon`.

Open **Memory System → Status**, then add a Runtime memory. Select a DSH workspace before creating Documents, even with global storage. To retain long-term facts, create a Memory Space with an explicitly selected Provider. Sidebar is the default; optional Builtin placement uses the same pages.

Upgrading from v0.4 retains the familiar configuration, data and workflow. Three optional enhancements are exposed in **Settings → Memory System**; no View tab or generic memory-plugin manager is added. [Upgrade checklist](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md).

## Source + Strategy → View

[![Source facts flow through a Strategy and Core validation into one View for the DSH Host](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/docs/assets/diagrams/en/composable-memory.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/architecture.md)

- **Source** owns memory, its projection, read/write operations and optional DSH pages.
- **Strategy** chooses how available Sources participate: selection, resident context, retrieval and guidance. Pure composition does not write memory.
- **Core** validates the proposal, asks Sources for bounded projections and compiles an immutable **View**. The **DSH Host** pins it to the executing turn and controls tool access.

A View includes context **and** the scoped routes/actions the LLM can use next. It is not another database or a frontend page. Memory Spaces owns its Provider child Fibers; Core exposes only the small `ctx.mnemonMemory` contribution service.

The same public contracts serve the default plugins and external repositories. Source authors keep their data and backend choices; Strategy authors reuse those capabilities, the turn lifecycle, budgets and test fixtures. [Architecture and sequence diagrams](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/architecture.md).

## Official plugins

The default configuration enables three core Sources and the default three-tier Strategy. Optional workspace plugins remain off until explicitly enabled and selected. Packages are independently versioned and published; the Starter pins exact dependency versions.

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

The workspace composition adds these independent plugins:

| Package | Responsibility | Default |
|---|---|---|
| [dsh-mnemon-source-project-context](plugins/dsh-mnemon-source-project-context/README.md) | Project facts, decisions and branch-aware notes | Off |
| [dsh-mnemon-source-journal](plugins/dsh-mnemon-source-journal/README.md) | Project/day journals and exact feedback | Off |
| [dsh-mnemon-source-tasks](plugins/dsh-mnemon-source-tasks/README.md) | Scoped tasks, deadlines and completion history | Off |
| [dsh-mnemon-source-playbooks](plugins/dsh-mnemon-source-playbooks/README.md) | Reviewed skills, file skills and prompt schedules | Off |
| [dsh-mnemon-source-files](plugins/dsh-mnemon-source-files/README.md) | Bounded file discovery and content search | Off |
| [dsh-mnemon-source-sessions](plugins/dsh-mnemon-source-sessions/README.md) | Visible history, bookmarks and completed-turn forks | Off |
| [dsh-mnemon-source-collaboration](plugins/dsh-mnemon-source-collaboration/README.md) | Session rooms, directed messages and file reservations | Off |
| [dsh-mnemon-source-agent-jobs](plugins/dsh-mnemon-source-agent-jobs/README.md) | Reviewed CLI plans, background runs and durable logs | Off |
| [dsh-mnemon-source-review](plugins/dsh-mnemon-source-review/README.md) | Independent conversation reviews and layered constraints | Off |
| [dsh-mnemon-source-notifications](plugins/dsh-mnemon-source-notifications/README.md) | Personal inbox, registered attachments and channel receipts | Off |
| [dsh-mnemon-source-learning](plugins/dsh-mnemon-source-learning/README.md) | Evidence-backed proposals, learning history and outcome feedback | Off |
| [dsh-mnemon-source-canvas](plugins/dsh-mnemon-source-canvas/README.md) | Scoped notes, live file references and a spatial media board | Off |
| [dsh-mnemon-source-sync](plugins/dsh-mnemon-source-sync/README.md) | Reviewed snapshots, cross-device merge and explicit Git push | Off |
| [dsh-mnemon-strategy-focus](plugins/dsh-mnemon-strategy-focus/README.md) | Source selection, writable subsets and a context budget | Off |
| [dsh-mnemon-strategy-learning-cycle](plugins/dsh-mnemon-strategy-learning-cycle/README.md) | Review learning by human turns, feedback and outcome thresholds | Off |
| [dsh-mnemon-strategy-skill-refinement](plugins/dsh-mnemon-strategy-skill-refinement/README.md) | Reviewed native skill creation, resource tests and feedback-driven revisions | Off |
| [dsh-mnemon-strategy-workspace](plugins/dsh-mnemon-strategy-workspace/README.md) | Compose available workspace Sources into one View | Off |
| [dsh-mnemon-strategy-journal-capture](plugins/dsh-mnemon-strategy-journal-capture/README.md) | Guidance for deliberate, attributed capture | Off |
| [dsh-mnemon-strategy-prompt-schedule](plugins/dsh-mnemon-strategy-prompt-schedule/README.md) | Policy for scheduled prompt use | Off |
| [dsh-mnemon-strategy-review-cycle](plugins/dsh-mnemon-strategy-review-cycle/README.md) | Policy for review cadence and explicit completion | Off |
| [dsh-mnemon-strategy-team-coordination](plugins/dsh-mnemon-strategy-team-coordination/README.md) | Policy for scoped session collaboration | Off |

Workspace enhancements use their Strategy’s public extension slots and receive no Source storage or execution authority. See the [workspace validation record](docs/workspace-context-validation.md) for the development instance and actual evidence.

Memory Spaces can use these Provider plugins:

[Mnemon Native](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mnemon-native/README.md) · [OpenViking](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-openviking/README.md) · [Honcho](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-honcho/README.md) · [Mem0](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mem0/README.md) · [Hindsight](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-hindsight/README.md) · [Holographic](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-holographic/README.md) · [RetainDB](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-retaindb/README.md) · [ByteRover](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-byterover/README.md) · [Supermemory](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-supermemory/README.md).

Native is the default backend; third-party services are disabled until explicitly configured. Graph, deletion, exact-write and enumeration capabilities remain backend-specific. [Provider capabilities and setup](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/memory-providers.md).

## Build your own composition

Use `dsh-mnemon/extension-sdk` to define and install a Source or Strategy on its Cordis Fiber. Use the owning Strategy's SDK for an additive contribution, or `dsh-mnemon-source-memory-spaces/provider-sdk` for a Memory Spaces driver.

Your repository owns its manifest, public dependencies, implementation, tests and build. DSH's Profile/Loader installs and mounts it; Mnemon does not scan arbitrary installed plugins. Installing code, activating a contribution and choosing the complete Strategy are distinct decisions.

Start with the [plugin author guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) and [external consumer examples](https://github.com/omdsh-dev/dsh-mnemon/tree/8466e3560a3b9de4e9f4b7302cbf005c84e8e69f/scripts/fixtures/plugin-consumer). They cover isolated package consumption, multiple instances, disposal, scoped reads and authorized writes. A Git or Notion integration can be a new Source; it is not implied support for every existing DSH memory plugin.

Independent plugin repositories are welcome. Contributions to this repository follow [CONTRIBUTING](https://github.com/omdsh-dev/dsh-mnemon/blob/8466e3560a3b9de4e9f4b7302cbf005c84e8e69f/CONTRIBUTING.md); discuss new capabilities and Providers in an Issue first.

## Data and trust

- Runtime and Documents are local; Native is local by default. External Providers use their configured services and scopes.
- Disabling participation does not erase memory. Switching storage scope does not migrate it. Provider disabling may clear local catalog metadata, not remote data.
- Saved Provider credentials stay on the Host and are excluded from Mnemon Packs. Packs still contain private memory and need protection.
- Source and Strategy plugins are trusted in-process JavaScript, **not sandboxed code**. Historical memory never outranks current instructions. Model-generated plugins are not automatically installed.

[Backup and recovery](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/operations.md) · [Security policy](https://github.com/omdsh-dev/dsh-mnemon/blob/8466e3560a3b9de4e9f4b7302cbf005c84e8e69f/SECURITY.md) · [Release history](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/releases/README.md) · [Roadmap](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/roadmap.md)

## Develop and verify

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:plugins
```

Use Node.js `^22.19.0 || >=24.0.0` and pnpm 10.13.1. Package-level checks run independently; WebUI captures use disposable data and a real DSH Host. Tests of mechanics are not claims of LLM accuracy or live cloud-Provider conformance. [Development](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/README.md) · [Media provenance](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/webui-v0.5.4/README.md).

## Optional workspace services

[Composable workspace services](docs/en/guides/workspace-services.md) adds independently installable project context, journals, tasks, playbooks, files, sessions, collaboration, jobs, review, canvas, notifications and synchronization, coordinated through an explicit Workspace Strategy and independent enhancements. These entries are opt-in.
