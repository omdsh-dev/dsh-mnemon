# Web, Headless, Tools, Commands, and RPC

[简体中文](../zh-CN/interfaces.md) | **English** | [Documentation hub](./README.md)

This page is an integration reference. For daily use, start with the [Sidebar and conversation UI guide](./ui-guide.md).

## User-facing entry points

| Entry | Default | Description |
|---|---:|---|
| Sidebar | Yes | Dedicated Memory System workbench with Status, Runtime, Documents, and Memory Spaces |
| Builtin | No | Optional conversation tab for the same workbench, automatically scoped to its session |
| Turn memory | Yes | Memory-tool summary for a completed turn, with exact page links |
| Save to memory | Yes | Action beside finalized assistant replies; confirmation invokes supervised writing |
| `/mnemon` | — | Conversation command entry |
| Model tools | — | Structured Root Agent read/write entry |

`displayMode` selects Sidebar (default) or Builtin; `tabEnabled` controls the selected entry's visibility. Builtin does not show the Sidebar scope controls. The two conversation shortcuts can be disabled independently through `mnemon-ui` settings.

## Profile surfaces

| Capability | Web | Headless |
|---|---:|---:|
| Runtime context and lifecycle guidance | Yes | Yes |
| Model tools and independent task Agents | Yes | Yes |
| Agent-cwd routing for `workspace` scope | Yes | Yes |
| Sidebar / conversation actions | Yes | No |
| Host-to-client RPC | Yes | No |
| Delayed score-based review after Agent idle | While the Host remains alive | Cancelled when the one-shot process exits |

Headless receives the full model-tool surface. Its task argument is submitted as an ordinary user message, so it does not provide an interactive slash-command dispatcher. Explicit and model-guided writes that finish before the Agent becomes idle are durable.

Model tools, lifecycle hooks, and system scheduling use an `automatic` trigger. User-initiated data-plane operations over Web/RPC use `manual`. Setting a Source to `manual` therefore preserves direct management while denying model tools and automatic projection. `memory-system` and `status` are control-plane observations and remain readable even when a Source is disabled.

## Model tools

### Read-only tools

| Tool | Purpose | Root Agent path |
|---|---|---|
| `mnemon_status` | Aggregated CLI, configuration, storage, and directory status | Direct service |
| `mnemon_memory_bodies` | Read catalog, provider capabilities, health, and available statistics | Direct service |
| `mnemon_recall` | Recall from active providers with heterogeneous rank fusion | Direct Host service under pinned Source authority |
| `mnemon_related` | Traverse only when `capabilities.related=true` | Direct Host service under pinned Source authority; Root defaults to two hops |
| `mnemon_document_search` | Deterministically search managed Documents | Documents control layer |

“Read only” means managed bodies and durable semantics do not change. `mnemon_document_search` still updates `lastAccessedAt` for LRU ordering, so feature read-only is not disk read-only.

### Tools available with `writeEnabled=true`

| Tool | Purpose | Root Agent path |
|---|---|---|
| `mnemon_runtime_memory` | `add` / `replace` / `remove` hot memory | Deterministic control; add overflow may start a worker |
| `mnemon_document_manage` | Create, update, or archive a Document | Create/update deterministic; archive uses a worker |
| `mnemon_remember` | Retain one insight under provider semantics and wait for a settled receipt | `spawn` write worker |
| `mnemon_link` | Create a typed relationship where the provider supports it | `spawn` write worker |
| `mnemon_forget` | Delete an exact ID where the provider supports it | `spawn` write worker |
| `mnemon_memory_body_create` | Let an Agent create a Mnemon Native space; third-party connections remain user-managed in WebUI | `spawn` write worker |
| `mnemon_memory_body_update` | Update name, description, or active state | `spawn` write worker |
| `mnemon_memory_body_merge` | Non-destructively merge Mnemon Native spaces | `spawn` write worker |

When a worker invokes the same tool name, it reaches the service directly and is not delegated recursively.

`mnemon_runtime_memory` accepts an optional `branches` array (git branch names) for `target=memory` writes. Branch-scoped entries are projected into the per-turn Runtime snapshot only when the session's workspace is checked out on a listed branch; untagged entries are always projected. On `replace`, providing `branches` changes the scope, an empty array clears it, and omitting it keeps the current scope. The parameter is rejected for `target=user`.

## Tool admission

- **Runtime**: explicit preferences, stable project conventions, environment facts, and high-frequency lessons.
- **Documents**: designs, investigations, procedures, postmortems, or handoffs with complete structure and rationale.
- **Memory Spaces**: stable facts, decisions, and insights that must survive across tasks or benefit from graph relationships.
- **Skip**: questions, guesses, temporary progress, completion logs, raw output, secrets, and ordinary repository facts that are easy to rediscover.

`mnemon_forget` is a destructive semantic action. Use it only on explicit request or after confirming that content is wrong or obsolete.

## `/mnemon` commands

```text
/mnemon
/mnemon status
/mnemon recall <query>
/mnemon related <full memory ID>
/mnemon remember <content>
/mnemon forget <exact ID>
```

- Empty `/mnemon` equals `status`.
- `status` is deterministic and starts no model.
- `recall`, `related`, `remember`, and `forget` use the live Agent containing the command as worker parent.
- Command recall returns at most 10 results.
- `forget` requires one exact ID without spaces.

## In-conversation contracts

| DSH slot | Registration | Behavior |
|---|---|---|
| `conversation.chat.turnTail` | chain | `turn-activity` summarizes `mnemon_*` calls from completed turns; open turns and turns without activity render nothing |
| `conversation.chat.assistant-actions` | list, `id=mnemon-save` | `assistant-message` reads finalized text; `supervise` runs only after confirmation |

Both are additive and replace no official DSH rendering. The assistant-message candidate is editable and long replies are bounded by the UI preview limit. Confirmation starts an independent task Agent, and persistence is complete only after its settled receipt.

## Workspace routing

Web workbench requests carry `sessionId` and an optional `workspaceId`. The Host accepts only IDs registered in `workspaceRegistry`:

- deterministic reads and manual maintenance may route to the inspected root selected by `workspaceId`;
- Agents, tools, commands, and lifecycle hooks still route by the Agent cwd associated with `sessionId`;
- `status.workspaceContext` returns selected / effective roots and `aligned`;
- Agent-backed operations are rejected while misaligned.

Profiles without a Web workspace registry, including Headless, have no arbitrary inspection target. Agent execution still routes `workspace` scope directly from the session cwd.

## RPC channels

RPC is an internal Host-to-client bridge, not a stable external HTTP API.

### Read channel

```text
channel:   /dsh-mnemon-read
rc.2 rollback authority: trusted-host
0.1.2 authentication: DSH browser session
```

| Endpoint | Behavior |
|---|---|
| `status` | Aggregated service, version, lifecycle, Documents, workspace/storage context, and current Memory System descriptor |
| `memory-system` | Serving/candidate evaluation, sanitized Source instance descriptors and current participation configuration |
| `versions` | Check installed/latest Mnemon and dsh-mnemon versions and installation sources |
| `runtime-memory` | Runtime snapshot |
| `documents` / `document` / `document-search` | Directory, body, and deterministic search |
| `graph` / `bodies` / `body-directory` | Active multi-space graph projection, provider-capability catalog, and fast directory projection |
| `body-reconnect` | Invalidate transient health state and refresh one Memory Space without changing persistent data |
| `provider-services` | Redacted Provider service catalog; configured-secret names may be present, secret values never are |
| `list` / `entities` | Durable content list and entity aggregation |
| `search` / `agent-search` / `related` | Direct retrieval, evidence answer, and relation traversal |
| `turn-activities` / `turn-activity` | Session-wide or single-turn memory-tool activity |
| `assistant-message` | Finalized assistant text by messageId |

### Write channel

Memory Space activation has a narrower request schema on its own control channel:

```text
channel:   /dsh-mnemon-activation
rc.2 rollback authority: trusted-host
0.1.2 authentication: DSH browser session
endpoint:  body
```

`body` accepts only `memoryBodyId`, a Boolean `active`, and the normal session/workspace routing fields. It controls participation in DSH reads and routing without accepting metadata, Provider connection, credential, deletion, or durable-memory mutations. Read-only mode rejects it at the Host boundary.

All broader mutations remain on the write channel:

```text
channel:   /dsh-mnemon-write
rc.2 rollback authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
0.1.2 authentication: DSH browser session
```

| Endpoint | Behavior |
|---|---|
| `runtime-memory` | Hot-memory mutation |
| `supervise` | Process a candidate under an independent task Agent and return a settled receipt |
| `document` | create / update / archive |
| `remember` / `link` / `forget` | Durable semantic write, relation, and soft deletion |
| `body-create` / `body-update` / `body-delete` | Create/connect, edit, or confirm Native deletion / remote disconnection |
| `body-reconnect` | Legacy compatibility route for clients released before reconnect moved to the read channel |
| `provider-services` / `provider-service-update` | Read private Provider settings for the local settings UI, or update one service |
| `version-update` | Update a named component with Host-fixed commands and arguments |

The private `provider-services` response, including saved credential values needed by the settings editor, is available only over this management channel. The ordinary read endpoint always returns a redacted catalog.

With `writeEnabled=false`, both activation control and the write channel remain registered but mutations are rejected at the Host boundary. The browser also disables mutation controls from the Host's settings snapshot before transport.

### Backup channel

```text
channel:   /dsh-mnemon-pack
rc.2 rollback authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
0.1.2 authentication: DSH browser session
```

| Endpoint | Behavior |
|---|---|
| `target` | Effective root and scope |
| `export` | Export a complete ZIP with manifest and SHA-256 checksums |
| `inspect` | Parse and verify an import ZIP, returning component and occupancy preview |
| `import` | Safely merge into the effective root; rejected in read-only mode |

Backups contain private memory, so callers must treat the authenticated DSH browser session as a full Host authority and protect exported archives separately.

### Settings channel

```text
channel:   /dsh-mnemon-settings
rc.2 rollback authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
0.1.2 authentication: DSH browser session
namespaces: mnemon, mnemon-ui
endpoints: get, mutate
```

Mutations use settings revisions to prevent overwriting concurrent edits. `mnemon` owns Host/storage settings; `mnemon-ui` owns `turnBar` and `saveAction`.

Mnemon uses one registration call shape for both transport generations: it always supplies the rc.2 authority object, which DSH 0.1.2 ignores as an extra JavaScript argument. Thus stable DSH 0.1.2-rc.1 and its alpha.5 predecessor authenticate the complete Host API with one browser session, while the rc.2 rollback retains method-specific trust tiers. No runtime version or function-arity branch is used.

## npm exports and extension service

Core publishes `ctx.mnemonMemory: MemoryRuntime`. Source/Strategy plugins use `inject = ['mnemonMemory']` and `installMemory`. Source controllers and Provider registries are not Root exports. Each plugin owns its own public `./contracts` and optional `./client` entry.

| Entry | Responsibility |
|---|---|
| `dsh-mnemon` | DSH Host and default Starter |
| `dsh-mnemon/core` | Source-neutral `ctx.mnemonMemory` service, without Host/UI |
| `dsh-mnemon/contracts` | JSON-safe manifests, facts, ViewSpec, View, Evidence and Receipt |
| `dsh-mnemon/extension-sdk` | Source/Strategy definitions, lifecycle installation and validators |
| `dsh-mnemon/testing` | Real Cordis composition fixture and built Client artifact loader |
| `dsh-mnemon/client` | DSH workspace and Source-page SDK |
| `dsh-mnemon-source-memory-spaces/provider-sdk` | Memory Spaces' own Provider child-module contract |
| `dsh-mnemon-source-memory-spaces/testing` | Provider driver fixture |

Generic model tools `mnemon_view_route` and `mnemon_view_action` execute only routes/offers present in the current View. Existing named tools preserve the default workflow. Browser management uses `source-management-catalog`, `source-management-read`, `source-management-mutate` and optional `source-assistance`; instance identity, confirmation, revision and current authority are checked by the Host/Source. Internal RPC names are not the plugin SDK: use the scoped page client. See [Plugin development](./extensions.md).

## Internationalization

The main Sidebar workbench, settings, and conversation entries support Chinese and English and follow DSH locale live. Brand names, tool names, and configuration keys are not translated. `/mnemon` commands, model-tool cards, some Host errors, and compatibility metadata remain partially untranslated.
