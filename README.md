<h1 align="center">dsh-mnemon</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v0.2.9-5b5bd6" alt="release v0.2.9">
  <img src="https://img.shields.io/badge/memory-3%20tiers-087c5b" alt="three memory tiers">
  <img src="https://img.shields.io/badge/providers-9-c66a09" alt="nine providers">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-43853d" alt="Node.js 20 or newer">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-172033" alt="MIT license"></a>
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
  <a href="./docs/en/releases/v0.2.9.md">Read the v0.2.9 notes</a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4">Watch the widescreen demo</a>
</p>

`dsh-mnemon` gives DSH one memory control plane without forcing every kind of knowledge into one database. Runtime Memory keeps compact context available every turn. Project Documents preserve complete narratives. Memory Spaces retrieve durable evidence on demand and can use **Mnemon, OpenViking, Honcho, Mem0, Hindsight, Holographic, RetainDB, ByteRover, or Supermemory**.

Mnemon remains the official, prioritized native engine. The third tier is replaceable; the first two keep the same storage, workspace, and interaction model regardless of provider.

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

These tasks do not reuse or consume the main conversation history. By default they follow DSH's new-session model route; **Settings → Memory System → Background task Agent** can select a dedicated Provider and model.

## One Memory Space workflow, nine providers

| Provider | Shape | Best fit |
|---|---|---|
| **Mnemon** | Official native local CLI + SQLite | Exact writes, entities, typed relationships, local-first sharing |
| **OpenViking** | HTTP + `viking://` | Resource trees and asynchronous extraction |
| **Honcho** | HTTP workspace / peers | Team and Agent-peer conclusions |
| **Mem0** | Platform or self-hosted HTTP | Existing user / Agent memory |
| **Hindsight** | HTTP memory bank | Banks, entities, provider-native graph |
| **Holographic** | Local structured fact files | Auditable facts, trust scores, local entities |
| **RetainDB** | HTTP project / user | Project- and user-scoped profiles |
| **ByteRover** | Local `brv` CLI | Code knowledge trees and curate workflows |
| **Supermemory** | HTTP container | Document ingestion and container sharing |

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

### 2. Install the DSH plugin

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
| Review the release | [v0.2.9 release notes](./docs/en/releases/v0.2.9.md) |

See the [documentation hub](./docs/en/README.md) for the full map.

## Development

```sh
pnpm install
pnpm run verify
```

`verify` runs TypeScript checks, Vitest, a reproducible double build, an isolated real Headless-profile activation check, and published-package validation. `lib/` is generated and intentionally not tracked.

Before opening an Issue or Pull Request, read the [contribution rules](./CONTRIBUTING.md) and use the repository templates. Incomplete reports and PR descriptions are rejected by automated policy checks.

## License

MIT. Report security issues privately through [SECURITY.md](./SECURITY.md), not a public issue.
