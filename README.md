<h1 align="center">dsh-mnemon</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-mnemon?label=npm" /></a>
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-mnemon?label=downloads%20total" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/omdsh-dev/dsh-mnemon" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/dsh-mnemon" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?lang=en" /></a>
  <a href="https://dshfind.com/en/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind downloads" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?metric=downloads&amp;lang=en" /></a>
</p>

<p align="center"><strong>The three-tier, pluggable, Agent-driven memory system for DeepSeek Harness.</strong></p>
<p align="center">Three memory tiers · Nine long-term providers · One supervised workflow</p>

<p align="center">
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/9196fd9991676a6bd9a84d615fcd301eb52e872a/docs/assets/media/dsh-mnemon-memory-system-demo-poster.jpg" alt="dsh-mnemon v0.2.0 live multi-memory snapshot and observable provider surfaces" width="1180">
  </a>
</p>

<p align="center">
  <a href="./docs/en/capabilities.md"><strong>Explore the capability map</strong></a> ·
  <a href="./docs/en/getting-started.md">Start in five minutes</a> ·
  <a href="./docs/en/releases/v0.4.1.md">Read the v0.4.1 notes</a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4">Watch the widescreen demo</a>
</p>

`dsh-mnemon` gives DSH one memory control plane without forcing every kind of knowledge into one database. Runtime Memory keeps compact context available every turn. Project Documents preserve complete narratives. Memory Spaces retrieve durable evidence on demand and can use **Mnemon, OpenViking, Honcho, Mem0, Hindsight, Holographic, RetainDB, ByteRover, or Supermemory**.

[Mnemon](https://github.com/mnemon-dev/mnemon) remains the official, prioritized native engine. The third tier is replaceable; the first two keep the same storage, workspace, and interaction model regardless of provider.

Since v0.3.0, the three tiers are the **default topology** of a composable kernel rather than the only shape hard-coded into every entry point. `MemoryBoot` wires trusted Layer, Adapter, Strategy, Guard, and `MemorySource` contributions into one runtime generation. Each user turn pins a lightweight `TurnView`: exact Runtime context enters Wake eagerly, while Documents and Memory Spaces contribute only bounded routing covers and keep complete recall authority Host-side. Users still install one `dsh-mnemon` package and keep the existing settings, tools, RPC, and UI workflow. See the [composable architecture](./docs/en/architecture.md#composable-memory-kernel) and [extension guide](./docs/en/extensions.md).

v0.4.0 makes Sidebar the only Memory System workspace and removes the builtin display mode and its setting. Legacy display preferences are ignored without changing memory data; the complete view-based upgrade is planned for v0.5, not this release. Read the [upgrade and compatibility notes](./docs/en/releases/v0.4.0.md#upgrade-and-compatibility) before updating.

v0.4.1 fixes Memory System and Save to memory rendering with this-dependent DSH settings stores, plus ZIP export failures and archive differences across timezones. It preserves the v0.4.0 workflow and existing memory formats. See the [patch release notes](./docs/en/releases/v0.4.1.md).

Current development restores optional `displayMode: builtin` as a conversation placement for the same Sidebar-first UI. Legacy `buildin` is accepted and automatically saved as `builtin`; memory data is unchanged. See [entry placement and scope mapping](./docs/en/configuration.md#entry-placement-displaymode-and-tabenabled).

## Understand the scope in 30 seconds

| Tier | Keep here | How it reaches the Agent | Managed by |
|---|---|---|---|
| **Runtime** | Preferences, collaboration rules, project conventions, environment facts | Compact `USER.md` / `MEMORY.md` projection on every turn | Deterministic dsh-mnemon Host |
| **Documents** | Designs, investigations, procedures, postmortems, handoffs | Search first, full Markdown on demand | Deterministic dsh-mnemon Host |
| **Memory Spaces** | Cross-session facts, decisions, entities, relations | Bounded recall from active spaces | Mnemon Native or an external Provider |

The tiers are not copies. A useful rule is: **every-turn context goes to Runtime, complete narratives go to Documents, and cross-task evidence goes to Memory Spaces.** Current instructions, repository files, and live tool results always outrank historical memory.

## Clicks that start real work

| User action | What actually runs | Data effect |
|---|---|---|
| **Search** | Concurrent provider-native recall | Read-only |
| **Agent query** | A clean top-level task Agent receives bounded evidence and writes an answer | Read-only |
| **Remember** / **Save to memory** | A clean task Agent qualifies, routes, deduplicates, distills, and writes behind Host controls | Writes only if accepted |
| **Smart selection** | Hard rules filter providers; a task Agent resolves only genuine ambiguity | Saves a routing receipt |
| **AI metadata** | One asynchronous task Agent per selected Memory Space, each using the provider's fastest sample path | Local title/description only |
| **Archive Document** | A task Agent creates a searchable cold reference before the Host moves the original | Supervised move |
| **Turn memory** | Expands exact recall, write, and Document-search activity; each item navigates to its source | Read-only |

Only the rows that explicitly name a task Agent spend a separate model context; **Search** and **Turn memory** are deterministic Host reads.

Task Agents do not reuse or consume the main conversation history. By default they follow DSH's new-session model route; **Settings → Memory System → Background task Agent** can select a dedicated Provider and model. That fixed route also applies to bounded Mnemon workers for idle checkpoint review, writes, evidence-bound answers, provider placement, memory migration, USER compaction, Document archiving, and metadata maintenance. Conversation Recall and Related stay direct Host reads and do not use this background route.

With DSH 0.1.1-rc.2, the first-party `deepseek-official/deepseek-v4-flash-vision-exp` route appears with an **Image input** label. Mnemon background jobs still send text-only prompts; multimodal conversation messages keep their DSH attachment references through lifecycle processing, and raw image bytes are never copied into memory.

## One Memory Space workflow, nine providers

| Provider | Shape | Best fit |
|---|---|---|
| **[Mnemon](https://github.com/mnemon-dev/mnemon)** | Official native local CLI + SQLite | Exact writes, entities, typed relationships, local-first sharing |
| **[OpenViking](https://github.com/volcengine/OpenViking)** | HTTP + `viking://` | Resource trees and asynchronous extraction |
| **[Honcho](https://github.com/plastic-labs/honcho)** | HTTP workspace / peers | Team and Agent-peer conclusions |
| **[Mem0](https://github.com/mem0ai/mem0)** | Platform or self-hosted HTTP | Existing user / Agent memory |
| **[Hindsight](https://github.com/vectorize-io/hindsight)** | HTTP memory bank | Banks, entities, provider-native graph |
| **[Holographic](https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/holographic)** | Local structured fact files | Auditable facts, trust scores, local entities |
| **[RetainDB](https://github.com/RetainDB/RetainDB)** | HTTP project / user | Project- and user-scoped profiles |
| **[ByteRover](https://github.com/campfirein/byterover-cli)** | Local `brv` CLI | Code knowledge trees and curate workflows |
| **[Supermemory](https://github.com/supermemoryai/supermemory)** | HTTP container | Document ingestion and container sharing |

Provider capability differences stay visible. dsh-mnemon never invents graph edges, deletion semantics, or enumerable content for an engine that does not provide them. **Settings owns reusable Provider services; Memory Spaces owns concrete instances, activation, scope, and metadata.** External Providers are off by default.

See the [provider capability and deployment matrix](./docs/en/memory-providers.md).

## Real WebUI walkthrough

The following roughly 55-second capture comes from a live 1600×900 DSH WebUI. It deliberately pauses on full-page scrolling, page transitions, Provider cards, dialogs, button-state changes, and a completed read-only Agent Query. Destructive confirmations are deliberately not submitted.

![Full dsh-mnemon v0.2.0 WebUI walkthrough with scrolling and button interactions](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.gif)

[Watch the 1600×900 MP4](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4) · [Open the page-by-page UI guide](./docs/en/ui-guide.md)

## Start in five minutes

### 1. Install Mnemon Native

Mnemon is the default engine and the simplest local-first starting point:

```sh
# macOS
brew install --cask mnemon-dev/tap/mnemon

# macOS / Linux via Go
go install github.com/mnemon-dev/mnemon@latest

mnemon --version
```

Windows users can install the official v0.2.3-or-newer release ZIP. The expected installation path and checksum procedure are in [Getting Started](./docs/en/getting-started.md#2-install-mnemon).

### 2. Install DSH and the plugin

The registry installation remains verified against DSH 0.1.1-rc.2, whose complete profiles require Node.js `^22.19.0 || >=24.0.0`; Node 20 lacks host primitives used by rc.2. Source compatibility is also verified against the source-only DSH 0.1.2-alpha.1 preview; it is not an npm installation target. The dsh-mnemon package itself retains Node.js 20 compatibility for older compatible DSH hosts. Use the exact published version below for a reproducible installation; plugin authors can follow the [alpha source workflow](./docs/en/development.md#dsh-012-alpha1-source-verification).

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.2
dsh --version
```

```sh
dsh plugin --profile web add dsh-mnemon
dsh --profile web
```

DSH profiles have independent plugin rosters. Install the same package separately for one-shot Headless tasks:

```sh
dsh plugin --profile headless add dsh-mnemon
dsh --profile headless "Check durable project context before answering this task."
```

For a local checkout, use an absolute path:

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-mnemon"
dsh plugin --profile headless add "link:/absolute/path/to/dsh-mnemon"
```

### 3. Verify the first workflow

1. Open **Memory System → Status** and verify dsh-mnemon, Mnemon Native, Runtime, Documents, and enabled Providers.
2. Open **Memory Spaces → Overview → Create Memory Space** and choose an enabled Provider explicitly.
3. Submit one stable, future-useful candidate through **Remember**.
4. Open **Recall**, run a direct search, then run **Agent query** against the same question.
5. Return to the conversation, expand **Turn memory**, and follow one exact tool link.

The primary tab order is intentionally stable: **Status, Runtime, Documents, Memory Spaces**.

## Familiar controls, expanded capability

### Agent-driven memory operations

| Supervised distillation | Bounded Agent query |
|---|---|
| [![Edit a candidate before dispatching an independent task Agent](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/remember-dialog.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/remember-dialog.png) | [![Read-only Agent answer grounded in bounded multi-provider evidence](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/recall-agent-answer.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/recall-agent-answer.png) |

The workbench makes the task boundary explicit before dispatch and keeps the returned answer beside its evidence scope. Conversation-native Turn memory and Save to memory remain enabled by default and can be changed independently under **Settings → Memory System → Conversation interface**.

### Manual or policy-driven placement

| Create explicitly | Route future distillation intelligently |
|---|---|
| [![Choose a Provider while creating a Memory Space](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/memory-space-create-dialog.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/memory-space-create-dialog.png) | [![Choose manual or smart Provider placement](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/distillation-strategy.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/distillation-strategy.png) |

Manual creation always asks the user to choose. Smart selection is a distillation policy: hard rules define the eligible set, then an optional prompt guides the Agent only when several candidates remain.

## Global, workspace, and custom scope

| Scope | Behavior |
|---|---|
| `global` | Uses `~/.mnemon`; ideal for a local control plane shared across workspaces and Agents |
| `workspace` | Uses `<workspace>/.mnemon`; local Providers that support workspace following move with the effective workspace |
| `custom` | An explicit path with global semantics, useful for team conventions or isolated environments |

Set `runtimeUserScope: global` together with `storageScope: workspace` to project the global USER.md profile and workspace MEMORY.md at the same time. User-profile writes stay global; project Runtime, Documents, Memory Spaces, and Provider state remain isolated. No existing entries are copied or deleted when switching.

Remote Provider workspaces, users, banks, projects, containers, and URIs remain their own namespaces; switching the DSH workspace never silently rewrites them. In workspace mode, the workbench may inspect one selected workspace while the current conversation continues to execute in its own cwd. Independent task Agents launched from the workbench use the inspected workspace even when no main session is selected.

## Web, conversation, and Headless share one system

| Surface | What remains available |
|---|---|
| **Sidebar WebUI** | Status, Runtime, Documents, Memory Spaces, Provider services, visualization, and confirmation surfaces |
| **Conversation UI** | Turn memory, Save to memory, exact navigation to the corresponding page |
| **Headless** | Runtime injection, Document search, Memory Space tools, workspace routing, and supervised writes without a WebUI |
| **Commands** | `/mnemon status`, `recall`, `related`, `remember`, and `forget` |

## Data and security boundaries

- Runtime and Documents are local deterministic stores. Mnemon Native is local by default; external Providers are explicit opt-ins.
- Provider credentials are mode `0600` under `<storageRoot>/state/memory-providers.json`. They are never returned to the browser, smart-selection Agent, or Mnemon Pack.
- Host calls use argument arrays with shell disabled, bounded output, timeouts, cancellation, schema validation, path boundaries, locks, and revisions.
- Disabling a Provider clears its local catalog metadata but never deletes remote data. Reconnecting rebuilds metadata from the Provider, using local defaults only when a field cannot be mapped.
- Changing scope never migrates, merges, or deletes an old root automatically.
- There is no deterministic secret scanner yet. Never store keys, tokens, private keys, or raw sensitive logs in any tier.
- Uninstalling the plugin does not remove local or remote memory data.

See [Operations, security, and troubleshooting](./docs/en/operations.md) for backup, recovery, and diagnostics.

## Documentation

| I want to… | Start here |
|---|---|
| See the complete product boundary | [Capability map](./docs/en/capabilities.md) |
| Install and verify the first workflow | [Getting Started](./docs/en/getting-started.md) |
| Follow every visible click and Agent action | [Sidebar and conversation UI guide](./docs/en/ui-guide.md) |
| Compare or deploy all nine Providers | [Long-term memory providers](./docs/en/memory-providers.md) |
| Understand tiering and lifecycle | [Storage model](./docs/en/storage-model.md) · [Workflows](./docs/en/workflows.md) |
| Configure scope, routing, and model selection | [Configuration](./docs/en/configuration.md) |
| Back up, update, or troubleshoot | [Operations](./docs/en/operations.md) |
| Integrate tools, commands, or RPC | [Interface reference](./docs/en/interfaces.md) |
| Build a Layer, Adapter, Strategy, Guard, or MemorySource extension | [Extension guide](./docs/en/extensions.md) |
| Review the release | [v0.4.1 release notes](./docs/en/releases/v0.4.1.md) |

See the [documentation hub](./docs/en/README.md) for the full map.

## Development

```sh
pnpm install
pnpm run verify
```

`verify` runs TypeScript checks, Vitest, a reproducible double build, an isolated real Headless-profile activation check, and published-package validation. `lib/` is generated and intentionally not tracked.

Before opening an Issue or Pull Request, read the [contribution rules](./CONTRIBUTING.md) ([简体中文](./CONTRIBUTING.zh-CN.md)) and use the bilingual repository templates. Incomplete reports and PR descriptions are rejected by bilingual automated policy checks.

## License

MIT. Report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.
