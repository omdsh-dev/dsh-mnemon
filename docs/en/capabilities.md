# Capability Map: Three Tiers, Nine Providers, and Independent Task Agents

[简体中文](../zh-CN/capabilities.md) | **English** | [Documentation hub](./README.md)

`dsh-mnemon` is the memory-system control plane for DeepSeek Harness (DSH). It does not force every kind of knowledge into one database. It organizes frequent context, complete project narratives, and retrievable long-term memory into three tiers, then brings nine long-term-memory providers into one workflow for creation, activation, recall, distillation, and observation.

Since v0.3.0, those tiers are the default topology of a composable kernel. Ordinary users decide only whether each Layer is on; `MemoryBoot` assembles extension Layers, Adapters, Strategies, Guards, and MemorySources in the control plane. A lightweight per-turn `TurnView` keeps exact Runtime context eager and durable sources routed, without changing the default user workflow.

The short decision rule is: **keep every-turn context in Runtime, complete narratives in Documents, and cross-task evidence in Memory Spaces.**

## The 30-second scope

| User goal | Where to click | Execution path | Changes data? |
|---|---|---|---|
| Keep preferences, conventions, and environment facts in every turn | **Runtime** | The Host deterministically maintains `USER.md` / `MEMORY.md` projections | Yes, immediately after confirmation |
| Preserve complete designs, investigations, procedures, and handoffs | **Documents** | The Host manages Markdown, indexing, capacity, and revisions | Create/edit does; read/search does not |
| Create a durable space on one of nine engines | **Memory Spaces → Overview → Create Memory Space** | A human explicitly chooses an enabled Provider | Yes |
| Let policy choose an eligible engine | **Memory Spaces → Distillation strategy → Smart selection** | Host hard rules run first; ambiguity starts an independent task Agent | Saving policy does; selection only returns a receipt |
| Retrieve raw durable evidence | **Memory Spaces → Recall → Search** | Active spaces use their fastest native recall paths concurrently | No |
| Turn evidence into an answer | **Memory Spaces → Recall → Agent query** | A clean top-level task Agent receives only bounded evidence | No |
| Qualify, deduplicate, distill, and write a candidate | **Remember** or **Save to memory** beside a response | A clean top-level task Agent works behind Host-enforced tools, paths, locks, capacity, and receipts | Only when the Agent decides to write |
| Generate titles and descriptions for several spaces | **Memory Spaces → Overview → AI metadata** | Each space gets an isolated asynchronous task: fast sample first, generation second | Yes, local catalog metadata only |
| Move a Document out of hot capacity without losing provenance | **Documents → Archive** | A task Agent creates a searchable cold reference before the Host moves the original | Yes |
| See what memory a completed turn used | **Turn memory** below the response | Summarizes recalls, writes, and Document searches with exact navigation | No |

## The tiers are not copies

| Tier | Best for | How it reaches context | Source of truth |
|---|---|---|---|
| **Runtime Memory** | Frequent preferences, collaboration rules, and project facts | Compact injection on every turn | `runtime/memories.json`; Markdown files are projections |
| **Project Documents** | Long-form knowledge that must keep structure and provenance | Deterministic search, then full text on demand | `documents/index.json` plus managed Markdown |
| **Memory Spaces** | Cross-session facts, decisions, entities, and relations | Bounded evidence recalled from active spaces | A Mnemon Native Store or the selected external Provider |

Runtime and Documents are managed by dsh-mnemon. Only the third tier swaps engines, so adding a Provider does not change the first two tiers' injection, search, capacity, or workspace semantics.

## Nine long-term-memory providers

| Provider | Form | Best fit | Scope behavior |
|---|---|---|---|
| **Mnemon** | Official native local CLI + SQLite | Full graph, exact writes, local-first default | Global, workspace, or custom root |
| **OpenViking** | HTTP + `viking://` | Existing resource trees and asynchronous extraction | Target URI and user identity |
| **Honcho** | HTTP workspace / peers | Team and Agent-peer conclusions | Provider workspace |
| **Mem0** | Platform or self-hosted HTTP | Existing Mem0 user/Agent memories | User / agent identity |
| **Hindsight** | HTTP memory bank | Banks, entities, and provider-native graph | Bank ID |
| **Holographic** | Local structured fact files | Auditable local entity and semantic facts | Follows workspace by default; path override allowed |
| **RetainDB** | HTTP project / user | Project and user scoped memory | Project / user identity |
| **ByteRover** | Local `brv` CLI | Code knowledge and curate workflows | Follows workspace by default; directory override allowed |
| **Supermemory** | HTTP container | Document ingestion and container sharing | Container tag |

Settings owns reusable **service configuration** and enable switches. Memory Spaces owns **instance configuration**, activation, and local metadata. Providers are off by default and participate in discovery and routing only after being enabled and saved. See [Long-term memory providers](./memory-providers.md) for the complete capability and field matrix.

## Who works after a click

### Deterministic Host operations

Status checks, raw search, content/entity browsing, activation, ordinary Runtime edits, Document reading, and ordinary Document edits require no model. They pass directly through Host-enforced schema, path, permission, lock, revision, capacity, timeout, and cancellation boundaries.

### Independent top-level task Agents

These user-visible capabilities do not reuse the main conversation history or consume its context window:

- **Remember** qualifies, routes, deduplicates, distills, and writes;
- **Agent query** answers from bounded recalled evidence;
- **AI metadata** gives every selected Memory Space its own asynchronous title/description task;
- **Document archive** creates a cold reference before the Host may move the original;
- **Smart Provider selection** calls a model only when hard rules leave multiple candidates.

Tasks follow the DSH new-session model route by default. **Settings → Memory System → Background task Agent** can select a separate Provider and model. On DSH 0.1.1-rc.2, image-capable catalog entries are labeled **Image input**, including `deepseek-official/deepseek-v4-flash-vision-exp`; current Mnemon task prompts remain text-only. Tasks are isolated: one failure is reported on its own Memory Space or operation surface instead of blocking the page.

Bounded workers may still perform structured judgment internally, but that is an implementation detail. The UI and product documentation consistently call the user-visible unit an **independent task Agent**.

## Global, workspace, and custom scope

- **Global** uses `~/.mnemon`, suitable for a control plane shared by local workspaces and Agents.
- **Workspace** uses `<workspace>/.mnemon`; local data planes such as Mnemon, Holographic, and ByteRover can follow it automatically.
- **Custom** is effectively a global scope at an explicit path, useful for team conventions and isolated demo roots.

Remote Provider workspaces, users, banks, projects, containers, and URIs are their own namespaces. Switching the DSH workspace never silently rewrites them. The workbench may inspect a chosen directory; an independent task Agent always writes according to its effective workspace and saved scope rules.

## Web, conversation, and Headless share one system

| Surface | Capabilities |
|---|---|
| **Sidebar WebUI** | Status, Runtime, Documents, Memory Spaces, Provider configuration, visualization, and every user-confirmation surface |
| **In-conversation UI** | Turn memory, Save to memory, and exact navigation into Recall, Content, or Entities |
| **Headless** | The same Runtime injection, Document search, Memory Space tools, workspace routing, and supervised writes without a WebUI |
| **Commands and tools** | `/mnemon` commands and the least-privilege tool surface used by Agents |

## Explicit non-goals

- Historical memory never outranks current instructions, live tool results, or repository facts.
- Provider capabilities are not flattened into fiction. Missing graph, delete, or exact-write semantics remain explicit.
- External credentials never reach the browser, smart-selection Agent, or Mnemon Pack.
- Disabling a Provider does not delete remote data. It clears the local catalog metadata; reconnecting rebuilds it from the Provider.
- Changing storage scope never migrates, merges, or deletes an old root automatically.
- The project does not claim a distributed transaction across local files and remote Providers.

## Continue exploring

1. [Complete first-run verification in five minutes](./getting-started.md)
2. [Follow real click paths through the WebUI and Agent behavior](./ui-guide.md)
3. [Compare all nine Providers](./memory-providers.md)
4. [Understand lifecycle, concurrency, and failure boundaries](./workflows.md)
5. [Read the v0.4.0 release notes](./releases/v0.4.0.md)
