# Web, Headless, Tools, Commands, and RPC

[简体中文](../../zh-CN/reference/interfaces.md) | **English** | [Documentation hub](../README.md)

This page is an integration reference. For daily use, start with the [Sidebar and conversation UI guide](../guides/ui-guide.md).

## Memory space naming and compatibility

The product term is **memory space** (Chinese: **记忆空间**). The Source exports `MemorySpace`, `MemorySpaceView`, `MemorySpaceCatalog`, and corresponding request and metadata types. Previously published `MemoryBody*` types remain deprecated aliases with the same shapes.

Existing v0.5.x identifiers such as `mnemon_memory_bodies`, `mnemon_memory_body_create`, `body-directory`, and `memoryBodyId` / `memoryBodyIds` still refer to memory spaces. They remain stable for installed tools, Source pages, Provider adapters, and persisted Document/Pack lineage. The `.dsh-memory-bodies.json` filename and its `bodies` field are also retained. Renaming the product does not rename user-created spaces, change their IDs, move databases, or alter access grants.

## User-facing entry points

| Entry | Default | Description |
|---|---:|---|
| Sidebar | Yes | The Memory System workbench: Status, Runtime, Documents and Memory Spaces |
| Conversation tab | No | The same workbench inside a conversation, scoped to that session |
| Turn memory | Yes | Memory-tool summary under a completed turn, with links to the matching page |
| Save to memory | Yes | Action beside finalized assistant replies; confirmation invokes supervised writing |
| dsh-mnemon's page under Plugins | Yes | Memory composition, component pages, storage, interface and backup |
| `/mnemon` | — | Conversation command entry |
| Model tools | — | Structured Root Agent read/write entry |

`displayMode` selects `sidebar` (default) or `builtin`, the conversation tab; `tabEnabled` controls whether the selected entry appears. The conversation tab does not show the Sidebar's scope controls. The two conversation shortcuts are switched independently under **Interface**, stored through the `mnemon-ui` settings scope.

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
| `mnemon_document_manage` | Create, update, or archive a Document | Create/update deterministic; archive uses a worker, or archives locally without one when no Memory Space can take the index |
| `mnemon_document_create` | Create a separate Document without updating or archiving existing ones | Deterministic Source `create` Action; available to idle review |
| `mnemon_remember` | Retain one insight under Provider semantics; distinguish acceptance from durable completion | `spawn` write worker |
| `mnemon_link` | Create a typed relationship where the provider supports it | `spawn` write worker |
| `mnemon_forget` | Delete an exact ID where the provider supports it | `spawn` write worker for explicit operations only; excluded from autonomous distillation |
| `mnemon_memory_body_create` | Let an Agent create a Mnemon Native space; third-party connections remain user-managed in WebUI | `spawn` write worker |
| `mnemon_memory_body_update` | Update name, description, or active state | `spawn` write worker |
| `mnemon_memory_body_merge` | Non-destructively merge Mnemon Native spaces | `spawn` write worker |

When a worker invokes the same tool name, it reaches the service directly and is not delegated recursively.

Autonomous write workers — distillation and supervised writeback runs — decide content on their own, so the host excludes `mnemon_forget` from their hard tool allowlist: a duplicate or conflict is resolved by skipping or storing a corrected entry, never by deleting the existing one. Operations whose request names an exact target supplied by the user or a user-facing flow (`/mnemon forget`, `mnemon_link`, and Memory Space management) keep the full write toolset.

Idle review can search Documents and call `mnemon_document_create`, but cannot call `mnemon_document_manage` or `mnemon_view_action`. It skips covered candidates or creates one separate document referencing existing document ids. The Source's `create` Action accepts `title`, `content`, optional `description`, `sourcePaths`, and `sessionIds`; it rejects `action`, `id`, and other unknown fields. Capacity exhaustion rejects creation without archiving an existing document. This protection applies to existing user- and Agent-created documents. Explicit editing continues through the existing management paths.

`mnemon_runtime_memory` accepts an optional `branches` array (git branch names) for `target=memory` writes. Branch-scoped entries are projected into the per-turn Runtime snapshot only when the session's workspace is checked out on a listed branch; untagged entries are always projected. On `replace`, providing `branches` changes the scope, an empty array clears it, and omitting it keeps the current scope. The parameter is rejected for `target=user`.

## Tool admission

- **Runtime**: explicit preferences, stable project conventions, environment facts, and high-frequency lessons.
- **Documents**: designs, investigations, procedures, postmortems, or handoffs with complete structure and rationale.
- **Memory Spaces**: stable facts, decisions, and insights that must survive across tasks or benefit from graph relationships.
- **Skip**: questions, guesses, temporary progress, completion logs, raw output, secrets, and ordinary repository facts that are easy to rediscover.

`mnemon_forget` is a destructive semantic action. Use it only on explicit request or after confirming that content is wrong or obsolete. The host enforces this for autonomous workers by excluding the tool from their allowlist; the main agent can still call it when the user explicitly asks.

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
- `recall` and `related` read through the live Agent's scoped Source route without spawning a worker. `remember` and `forget` use that Agent as the write worker's parent.
- Command recall returns at most 10 results.
- `forget` requires one exact ID without spaces.
- `forget` reports deletion only for a `forgotten` receipt; skipped, failed, or unconfirmed results are reported as errors with the worker summary.

## UI contributions

Everything Mnemon shows inside DSH is registered into DSH's own UI regions. The conversation contributions are additive and replace no official DSH rendering.

| DSH region | Registration | Behavior |
|---|---|---|
| `conversation.chat.turnTail` | list, `id=dsh-mnemon/turn-tail` | `turn-activity` summarizes `mnemon_*` calls from completed turns, with the items each call read or wrote from the tools' activity metadata; open turns and turns without activity render nothing |
| `conversation.chat.assistant-actions` | list, `id=mnemon-save` | `assistant-message` reads finalized text; `supervise` runs only after confirmation |
| `conversation.session.header.lineage` | lower-priority copy of DSH's own entry | A task Agent's session header counts that Agent's own tokens, not the log it was forked from |
| `plugins.bundle.config` | keyed, `dsh-mnemon` | The whole configuration on dsh-mnemon's page under Plugins |
| `plugins.row.config` | keyed, `dsh-mnemon#<row>` | The page each shipped component's row opens, with the settings that component contributed |
| `plugins.detail.actions` | list, `id=dsh-mnemon/open-workspace` | Opens the Memory System from the plugin's detail page |

Mnemon declares two keyed regions of its own, both keyed by a component's package name: `mnemon.component.settings`, rendered on that component's page, and `mnemon.component.status`, its card on the Status page. Official and third-party components contribute through the same regions; see [Plugin development](../development/extensions.md).

The assistant-message candidate is editable and long replies are bounded by the UI preview limit. Confirmation starts an independent task Agent, and persistence is complete only after its settled receipt.

## Workspace routing

Web workbench requests carry `sessionId` and an optional `workspaceId`. The Host accepts only IDs registered in `workspaceRegistry`:

- deterministic reads and manual maintenance may route to the inspected root selected by `workspaceId`;
- Agents, tools, commands, and lifecycle hooks still route by the Agent cwd associated with `sessionId`;
- `status.workspaceContext` returns selected / effective roots and `aligned`;
- independent task Agents started from the workbench use the inspected workspace; they do not require the main conversation to match. Conversation tools continue to use their own session cwd and pinned View, not the workbench inspection scope.

Profiles without a Web workspace registry, including Headless, have no arbitrary inspection target. Agent execution still routes `workspace` scope directly from the session cwd.

## RPC channels

RPC is an internal Host-to-client bridge, not a stable external HTTP API. Pages and component plugins should use the scoped clients from `dsh-mnemon/client`; see [Plugin development](../development/extensions.md).

| Channel | Carries | Remote pages |
|---|---|---|
| `/dsh-mnemon-read` | Status, directories, search and conversation reads | Allowed |
| `/dsh-mnemon-activation` | Turning one Memory Space on or off | Allowed |
| `/dsh-mnemon-write` | Every other mutation | Needs `remoteAccess: trusted-host` |
| `/dsh-mnemon-pack` | Backup export and import | Needs `remoteAccess: trusted-host` |
| `/dsh-mnemon-sync` | Git repository sync: configuration, push, preview and pull | Needs `remoteAccess: trusted-host` |
| `/dsh-mnemon-review` | Reconciliation proposals, review opinions and applying an accepted plan | Reads allowed; `reconcile` and `apply` need `remoteAccess: trusted-host` |
| `/dsh-mnemon-settings` | Host and interface settings | `get` allowed; `mutate` needs `remoteAccess: trusted-host` |
| `/dsh-mnemon-view` | Memory composition reads | Allowed |
| `/dsh-mnemon-view-settings` | Saving memory composition, installing a component | Needs `remoteAccess: trusted-host` |

Loopback pages call these channels directly, authenticated by the DSH browser session. Remote pages reach the same handlers through DSH's API Gateway: channel `/api`, endpoints `dshMnemon/read`, `dshMnemon/activation`, `dshMnemon/write`, `dshMnemon/pack`, `dshMnemon/settings`, `dshMnemon/view`, `dshMnemon/viewWrite`, `dshMnemon/sync` and `dshMnemon/review`. The Gateway owns Host/Origin validation, browser pairing and the response envelope; Mnemon adds only the `remoteAccess` grant shown above, captured at startup. See [Remote management](../guides/operations.md#remote-management).

The Gateway reaches these handlers through Mnemon's `mnemonRemote` Typert service in the `dshMnemon` namespace; its named remote methods are `read`, `activation`, `write`, `pack`, `settings`, `view`, `viewWrite`, `sync` and `review`. `write`, `pack`, `sync`, `review`, `viewWrite` and the `settings` `mutate` endpoint answer `remote Mnemon management requires remoteAccess: trusted-host` without the grant; `read`, `activation`, `view` and the `settings` `get` endpoint do not need it.

### Read channel

| Endpoint | Behavior |
|---|---|
| `status` / `status-summary` | Service, version, lifecycle, Documents, storage and workspace context, and the current Memory System descriptor; `status-summary` answers without waiting for any Provider I/O |
| `memory-system` | Serving/candidate evaluation, sanitized Source instance descriptors and current participation configuration |
| `versions` | Installed and latest Mnemon CLI and dsh-mnemon versions and their installation sources |
| `task-agent-models` | Models available to independent task Agents |
| `runtime-memory` | Runtime snapshot |
| `documents` / `document` / `document-search` | Directory, body, and deterministic search |
| `graph` / `bodies` / `body-directory` | Active multi-space graph projection, provider-capability catalog, and fast directory projection |
| `body-reconnect` | Invalidate transient health state and refresh one Memory Space without changing persistent data |
| `provider-services` | Redacted Provider service catalog; configured-secret names may be present, secret values never are |
| `embedding-status` | Mnemon's embedding model, availability and default-store coverage |
| `list` / `entities` | Durable content list and entity aggregation |
| `search` / `agent-search` / `related` | Direct retrieval, evidence answer, and relation traversal |
| `turn-activities` / `turn-activity` | Session-wide or single-turn memory-tool activity |
| `assistant-message` | Finalized assistant text by messageId |
| `source-management-catalog` / `source-management-read` / `source-assistance` | Generic Source management: instance catalog, declared read operations, and a read-only assisted search |

### Activation channel

`/dsh-mnemon-activation` has a narrower request schema than the write channel. Its `body` endpoint accepts only `memoryBodyId`, a Boolean `active`, and the normal session/workspace routing fields; `source-assistance` accepts the same two fields as a confirmed `activation` operation on a Memory Spaces instance. Both control participation in DSH reads and routing without accepting metadata, Provider connection, credential, deletion, or durable-memory mutations. Read-only mode rejects them at the Host boundary.

### Write channel

| Endpoint | Behavior |
|---|---|
| `runtime-memory` | Hot-memory mutation |
| `document` | create / update / archive |
| `supervise` | Process a candidate under an independent task Agent and return a settled receipt |
| `remember` / `link` / `forget` | Durable semantic write, relation, and soft deletion |
| `body-create` / `body-update` / `body-delete` / `body-merge` | Create or connect, edit, confirm Native deletion or remote disconnection, and merge Memory Spaces |
| `body-metadata-maintain` | Let a task Agent refresh names and descriptions of 1 to 20 active Memory Spaces |
| `provider-service-update` | Update one Provider service; credentials remain on the Host and the response is redacted |
| `source-management-mutate` / `source-assistance` | Generic Source management mutation, and Host-assisted operations confirmed against the Source's current revision |
| `version-update` | Update a named component with Host-fixed commands and arguments |

`provider-services` returns a redacted catalog through the read channel. The settings editor knows which credential fields are configured; it can replace or explicitly clear them without reading saved values back.

With `writeEnabled=false`, the activation and write channels stay registered but mutations are rejected at the Host boundary. The browser also disables mutation controls from the Host's settings snapshot before transport.

### Backup channel

| Endpoint | Behavior |
|---|---|
| `target` | Effective root, scope, and the default root a Default location resolves to |
| `export` | Export a complete ZIP with manifest and SHA-256 checksums |
| `inspect` | Parse and verify an import ZIP, returning component and occupancy preview |
| `import` | Safely merge into the effective root; rejected in read-only mode. Its `runtime` answer reports how many entries the merge added and how many stayed out because this installation had deleted them, and an optional `revive: true` overrules those deletions for this import |
| `storage-plan` | Inspect a proposed data directory: what it holds, how many files and bytes would move, and why the move is impossible; read-only, and it never requires `writeEnabled` |
| `storage-migrate` | Copy the whole data directory to the proposed path, verify every file by SHA-256, and only then delete the original; on success the Host records the new path as the `custom` data directory and rebuilds its runtime on it, so later calls never read the removed one; requires `confirmed: true`, `writeEnabled`, and a writable settings profile, which is checked before anything is copied |

Backups contain private memory, so callers must treat the authenticated DSH browser session as a full Host authority and protect exported archives separately.

### Sync channel

| Endpoint | Behavior |
|---|---|
| `status` | Mirror path, configured repository, branch, remote directory, `hasToken`, `credentialSource`, `credentialLogin`, remote reachability and the last commit; read-only |
| `configure` | Save repository URL, branch, remote directory, token and commit identity; the response replaces the token with `hasToken` and `credentialSource`. An empty `branch` or `subdir` restores that field's default, and an empty author falls back to the Git identity of the machine |
| `push` | Export the full Mnemon Pack payload into the mirror, commit it and push the branch; requires `confirmed: true` |
| `preview` | Read the remote manifest and its SHA-256 inventory and report which components differ from local; read-only |
| `backups` | Walk the branch history newest first and name each commit by the Pack manifest it carries: commit, message, time, the machine that published it, the push time and the component summary. An optional `limit` bounds the page and `truncated` says the branch holds more; a commit whose manifest cannot be read is skipped; read-only |
| `diff` | Compare the local payload with the branch payload entry by entry: both sides' export time, entry count and machine, the entries only here, the entries only there, how many they share, `heldBack` for the entries the branch holds that this installation's own tombstones keep out, and the removals the branch recorded that this installation has not carried out yet; read-only |
| `pull` | Merge the remote payload through the same validation and importer Import ZIP uses; requires `confirmed: true` and accepts optional one-off `components` and `revive` parameters, the latter overruling this installation's recorded deletions so the entries they hid are written this time |
| `github-status` | Whether this Host mounts a credentials store, whether an account is signed in, whether that store is writable, the account login and scopes, and the pending device-flow code; read-only |
| `github-start` | Ask GitHub for a device code and return the code, the verification URL and the poll interval; requires `writeEnabled: true` |
| `github-poll` | Ask once whether the browser step finished, at the cadence GitHub asked for; on success it stores the grant; requires `writeEnabled: true` |
| `github-cancel` | Forget a pending device flow without touching the stored grant; requires `writeEnabled: true` |
| `github-signout` | Forget the stored grant; requires `writeEnabled: true` |
| `github-repositories` | List the repositories the signed-in account may push to, most recently updated first; read-only |
| `github-create` | Create one public or private repository under the signed-in account and read it back; requires `writeEnabled: true` |

The sync payload is always a full Mnemon Pack: a pack manifest's `scope` is either `full` or exactly one component, so a persistent component selection cannot be represented. Component filtering exists only as the optional `pull` parameter. A repository URL is the only configuration value without a default: a blank `branch`, `subdir`, `authorName` or `authorEmail` is answered with the default branch, the default directory, or the commit identity this machine's Git already carries. `configure`, `push`, `pull` and every `github-` endpoint that changes something require `writeEnabled: true` and otherwise answer the same read-only refusal pack import uses.

Tokens never appear in a response or an error message. The channel resolves one credential per network operation, in this order: `MNEMON_SYNC_GIT_TOKEN`, the token stored in `state/sync-git.json` (mode `0600`), then the grant GitHub sign-in wrote into DSH's credentials store under the key `dsh-mnemon/github`. `credentialSource` names the winner — `environment`, `token`, `github` or `none` — and `hasToken` is `true` for the first three, so a signed-in account needs no token field at all. GitHub calls go through the ambient `fetch` first, the same seam the version check uses, so a launcher's proxy policy applies to them. When that request cannot connect at all, the channel retries it once through a proxy discovered from `HTTPS_PROXY`, `http_proxy` or `all_proxy` and, on Windows, from the system proxy settings, over a CONNECT tunnel built from Node's own modules; the proxy that answered is reused and a proxy that stops answering is dropped, so a machine that changes networks recovers without a restart. A failure reports GitHub's error code and the HTTP status only, never a response body; a request that never reached GitHub reports the transport reason and, when no proxy was found, names `HTTPS_PROXY` as what to set.

Configuration, credentials and the failure semantics are described under [Backup and recovery](../guides/operations.md#git-repository-sync).

### Review channel

| Endpoint | Behavior |
|---|---|
| `view` | The review ledger: its path, every proposal and the pending count; read-only |
| `opinion` | Append one opinion to a proposal; the author is `user` unless the caller asks for `agent` |
| `decide` | Accept or reject a pending proposal |
| `reopen` | Return a decided proposal to `pending` and clear the record of what ran, so the whole plan is a fresh decision |
| `reconcile` | Run one reconciliation over the merged local memory and stage the plan as a new pending entry. An optional `guidance` string states what the plan should accomplish, and the evidence then also carries what the sync branch holds and this installation does not, plus the opinions already recorded on pending proposals; requires `writeEnabled` |
| `apply` | Apply the operations of an accepted proposal, stopping at the first failure. An optional `operations` array of plan positions applies only those, so a reviewer can take part of a plan. Positions the entry already ran are skipped, and an entry with nothing left to run is refused rather than replayed; requires `writeEnabled` |

A reconciliation never writes memory by itself: the model returns a plan, the plan is recorded as a proposal, and only `apply` on an accepted proposal touches a Source. An entry records which plan positions ran in `appliedOperations`, so applying part of a plan is repeatable and the remainder is what a caller still sees offered. `view`, `opinion`, `decide` and `reopen` work on a read-only Host as well, because they only edit the ledger under `state/`. The ledger is not a Pack component, so no proposal ever syncs to another machine.

### Settings channel

`/dsh-mnemon-settings` offers `get` and `mutate` for two namespaces: `mnemon` owns Host and storage settings, and `mnemon-ui` owns `turnBar` and `saveAction`, saved as `conversationInteraction`. Mutations carry settings revisions so concurrent edits are not overwritten. dsh-mnemon's page under Plugins (`plugins.bundle.config`) reads and writes through this channel on loopback and remote pages alike. On loopback pages it also follows DSH's `ctx.configForms` revision of the `mnemon` entry and re-reads the channel when another page or a profile reload changes it.

### Memory composition channels

| Channel | Endpoint | Behavior |
|---|---|---|
| `/dsh-mnemon-view` | `dashboard` | Installed components, the selected main strategy, the current conversation's View and turn activity, and whether components can be installed here |
| `/dsh-mnemon-view` | `preview` | Validate a proposed composition against the current revision without saving it |
| `/dsh-mnemon-view` | `inspect-plugin` | Read a component package's registry manifest: version, `dsh-mnemon` peer range and whether this Profile has it |
| `/dsh-mnemon-view-settings` | `apply` | Save a confirmed composition: main strategy, component switches and options |
| `/dsh-mnemon-view-settings` | `install-plugin` | Install a confirmed package version into the current Profile with the DSH CLI |

`apply` stores the strategy and each component's options in the `mnemon-view` scope, saved as `memoryView`; DSH's plugin manager records the component switches in the profile patch. See [Configuration](./configuration.md).

## npm exports and extension service

Core publishes `ctx.mnemonMemory: MnemonMemoryService`; the actual service exposes only `installContributions`. Source/Strategy authors use `inject = ['mnemonMemory']` and `installMemory`, without receiving an engine, controller or registry. Public subpaths are defined by each package's `package.json#exports`; Sources may provide their own `./contracts` and optional `./client`.

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

Generic model tools `mnemon_view_route` and `mnemon_view_action` execute only routes/offers present in the current View. Existing named tools preserve the default workflow. Browser management uses `source-management-catalog`, `source-management-read`, `source-management-mutate` and optional `source-assistance`; instance identity, confirmation, revision and current authority are checked by the Host/Source. Internal RPC names are not the plugin SDK: use the scoped page client. See [Plugin development](../development/extensions.md).

## Internationalization

The main Sidebar workbench, the configuration page under Plugins, and conversation entries support Chinese and English and follow DSH locale live. Brand names, tool names, and configuration keys are not translated. `/mnemon` commands, model-tool cards, some Host errors, and compatibility metadata remain partially untranslated.
