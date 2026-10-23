# Long-term memory providers

[简体中文](../../zh-CN/guides/memory-providers.md) | **English** | [Documentation](../README.md)

Memory Spaces hold dsh-mnemon's long-term memory, and their backend is a Provider you can swap. The Memory Space contract stays stable while the Provider supplies the data plane. **Mnemon Native is the official, prioritized default**; external Providers are opt-in integrations for teams that already use another memory engine or need a different sharing, extraction or retrieval model.

Only Mnemon Native needs the Mnemon CLI. When the CLI is missing, another ready Provider can serve Memory Spaces, and a saved Provider choice is still honored.

![Memory Spaces' page under Plugins with Mnemon Native and the third-party Providers](../../assets/webui-v0.5.32/en/plugin-spaces.jpg)

Each adapter is an independently published `dsh-mnemon-provider-*` package, installed as a child of the Memory Spaces Source. The Starter includes all nine packages, but external services remain disabled until configured. No external backend server or CLI is bundled. See the [official package list](../../../README.md#official-plugins) and [Provider author contract](../development/extensions.md).

## Provider matrix

| Provider | Data plane | Recall / browse | Graph / related | Write | Forget |
|---|---|---|---|---|---|
| **Mnemon Native** | Local `mnemon.db` through the official CLI | Yes / yes | Full typed graph / yes | Exact | Soft delete |
| **OpenViking** | Existing HTTP service and `viking://` memory root | Yes / yes | Projected nodes / no | Verified exact content | Guarded hard delete for exact user `.md` resources |
| **Honcho** | v3 workspace conclusions | Yes / yes | No / no | Exact peer conclusion | Hard delete |
| **Mem0** | Platform v3 or self-hosted HTTP API | Yes / yes | No / no | Async extraction | Hard delete |
| **Hindsight** | Memory bank API and knowledge graph | Yes / yes | Provider graph / yes | Async retain | Invalidate (soft) |
| **Holographic** | Local atomic structured-fact file | Yes / yes | Entity/semantic graph / yes | Exact fact | Hard delete |
| **RetainDB** | Project/user-scoped HTTP API | Yes / yes | No / no | Exact memory | Hard delete |
| **ByteRover** | Local `brv` CLI and knowledge directory | Yes / no | No / no | Async curate | Unsupported |
| **Supermemory** | Container-scoped HTTP API | Yes / yes | Projected nodes / no | Async document ingest | Provider forget |

The Host exposes only capabilities an adapter can honor. UI actions and Agent tools do not fabricate missing graph, related, link, browse, or deletion behavior.

## Service and Memory Space fields

| Provider | Workspace behavior | Service configuration on Memory Spaces' page | Instance configuration in Memory Spaces |
|---|---|---|---|
| OpenViking | Keeps the provider-global scope | `endpoint`, `apiKey`, `account`, optional `discoveryUser` | `targetUri`, `user`, `actorPeerId` |
| Honcho | Keeps the provider-global scope | `endpoint`, `apiKey` | `workspace`, `userId`, `agentId` |
| Mem0 | Keeps the provider-global scope | `endpoint`, `apiKey`, `mode` | `userId`, `agentId`, `rerank` |
| Hindsight | Keeps the provider-global scope | `endpoint`, `apiKey` | `bankId`, `budget` |
| Holographic | Follows by default; path can override | `dataPath` | `defaultTrust`, `minTrust` |
| RetainDB | Keeps the provider-global scope | `endpoint`, `apiKey` | `project`, `userId` |
| ByteRover | Follows by default; directory can override | `cliPath`, `apiKey`, `defaultDirectory` | `workingDirectory` |
| Supermemory | Keeps the provider-global scope | `endpoint`, `apiKey` | `containerTag`, `searchMode` |

**Memory providers**, on Memory Spaces' page (open **Plugins → dsh-mnemon** and select Memory Spaces), owns reusable provider service configuration. Enabling or saving a provider performs authoritative discovery and synchronizes every visible provider-native namespace into the Memory Space directory—for example banks, projects, workspaces, users, or container tags. Provider titles and descriptions become the local routing metadata. **Memory Spaces → Overview** controls DSH activation and shows the synchronized instance scope. The Host merges both layers immediately before calling an adapter. Secrets stay in `<storageRoot>/state/memory-providers.json` with mode `0600`; the WebUI represents configured secrets only as a mask, and entering a new value replaces the saved secret.

**Namespaces created later.** A namespace created on the Provider side after its settings were saved is found without saving them again. A little after the Host starts serving a data directory, it asks every enabled Provider once more; **Rediscover** on **Memory Spaces → Overview** asks again on demand. Rediscovery only adds:

- A namespace seen for the first time is mounted inactive, so recall reads it only once you switch it on.
- Every mounted space keeps its activation, title, description and settings, and a namespace a mounted space already reads is not added again. A space made by hand counts when it names the same bank, workspace, user, tag, memory URI or folder, whatever its other settings, such as a recall budget or a single peer.
- A namespace you disconnected, discovered or made by hand, stays disconnected; saving the Provider's settings brings every reported namespace back, as before.
- A Provider that fails, or does not answer within 30 seconds, keeps its spaces, and the page says why.

The start-up pass runs once per data directory per Host process. It does not run for a read-only deployment, or while the Memory Spaces layer is off or its `maintenance` participation is not `automatic`. Honcho and OpenViking list their first 100 namespaces.

DSH workspace mode does not rewrite every provider namespace. Mnemon Native follows the workspace automatically. Holographic and ByteRover default to workspace-local paths but allow explicit path overrides. Remote providers continue to use the URI, workspace, user, bank, project, or container configured on the Memory Space; switching DSH workspaces never rewrites those identities implicitly.

## Read-only spaces

A Memory Space can be **Read only**. DSH still recalls it as before, through Recall, Related, Content, Entities and Direct search, but writes nothing to it. This keeps an existing namespace readable, such as a Hindsight bank that another tool also writes, while new memories go to a space of their own. To set it, open the space's **Edit** dialog and choose **Read only** under **Writes**. The space's card then shows **Read only**.

- **No write reaches its Provider.** Remember (single or batch), forget, link, the task Agent's writes, archiving MEMORY.md or a Document's index, and merging into the space are all refused before the Provider is called. The error names the space. A read-only Mnemon Native space also keeps its Store, which cannot be deleted while the space is read only, and **Fill in** adds no vectors to it.
- **Writes that name no space.** Such a write goes to the one active writable space. If there is none, or more than one, the write asks for a space; it never falls back to a read-only one. If every space is read only, a full MEMORY.md archives to the local archive file.
- **The choice follows the namespace, not the card.** A space made by hand for the same bank, workspace, user, tag, URI or folder is read only too, and so is the namespace after a reconnect, a rediscovery, or switching a space on. Making any of these spaces writable makes the whole namespace writable. A space whose settings are changed to point at another namespace takes that namespace's choice.
- **Each write is checked when it is made.** A turn that began before the change cannot write to the space.
- **Where the choice is kept.** It is kept for this data directory in `<storageRoot>/state/memory-provider-write-policy.json`, next to the Provider connections. Packs and Git sync do not carry the file, and restoring a Pack or syncing leaves it in place. The choice governs DSH's own writes; it does not govern the stores that a Pack or Git sync copies.
- **If the file cannot be read**, every space is read only until the file is fixed or removed; recall still works. dsh-mnemon versions before this one ignore the file.

## Provider views and vendor plugins

A space whose Provider keeps more than memories gets **Browse** on its card. It opens the Provider's views as tabs, read through the space's own connection; nothing in them writes. OpenViking shows three:

- **viking:// hierarchy**: the space user's directory and the account's `resources` and `agent` directories, with the abstracts the server keeps. A file opens with a preview: text, or an image up to 2.5 MB.
- **Resources**: what the server or OpenViking's own plugin stored under `viking://resources`, such as images and attachments (#453), with the abstract the server generated for each.
- **Server changes**: what OpenViking's memory extraction added, updated or deleted, one entry per committed session, newest first, each opening to its before and after. It reads the `memory_diff.json` the server keeps beside each session archive, for the newest 20 sessions.

**OpenViking's official plugin.** When `@openviking/dsh-memory-plugin` runs in the same DSH profile, the OpenViking space's card names it with its version and whether it captures automatically, and **Browse** shows it in full: automatic recall, automatic capture, whether it skips task Agent sessions, where it connects (without credentials), and whether that is the space's own namespace (the same server, account and user). dsh-mnemon only reads what the plugin reports about itself. It never changes the plugin: its tools stay visible to the model, its skills, recall and capture run as OpenViking designed them, and its configuration is left as it is.

**Making the space read only beside it.** When the plugin captures into the space's own namespace on its own, the same memory can be stored twice: once by the plugin's capture and once by dsh-mnemon. The card and **Browse** then suggest making the space read only for dsh-mnemon, so that the plugin's capture is the only writer there while dsh-mnemon still recalls the space. Nothing changes until you press **Make read only**, which sets the space's write policy described above; **Edit** turns it back. The suggestion does not appear when the plugin's automatic capture is off, when it connects to another namespace or does not say which, or when the space is already read only.

## Manual and smart placement

Manual placement preserves the existing workflow: create a Memory Space, choose one engine, configure it, and continue to use the same Recall, Content, Entities, and Remember surfaces.

Smart placement builds an allowlist from the candidates selected by the user:

1. The Host enforces data boundary and required-capability rules.
2. If one eligible provider remains, rules select it deterministically.
3. If several remain, an independent task Agent considers the routing description, soft preference, and user-authored strategy prompt.
4. The Host validates the returned provider against the eligible set and persists the decision, reason, confidence, and candidate IDs.

Connection secrets never enter the selector prompt. `local-only` excludes every remote provider before model selection. Mnemon Native stays a local candidate while its CLI is available.

## Operational boundaries

- OpenViking writes a new `.md` file with `content/write`, `mode: "create"` and `wait: true`, sending only the four fields every release from 0.4.16 to 0.5.2 declares (each refuses any other field, and 0.5.1 removed `timeout`), then sets the source, category and importance tags with `content/set_tags`; a server that cannot tag, or does not confirm the tags within 5 seconds, still keeps the verified memory, and the receipt says `tagsApplied: false`. Categories map to `preferences`, `experiences` (insight/decision), `events` (context), or `entities` (fact/general), and the file name ends in `_<category>-<uuid>.md`, so a memory reads back with the category it was written with. Files without it, written by an earlier version or by OpenViking itself, read back by their folder: `preferences` as preference, `experiences` as insight, `events` as context and `entities` as fact. An unknown category is stored as `general`. A write the server refuses (HTTP 4xx other than 408 and 409) is reported as not stored. A stored receipt requires matching URI, byte count, completed vector indexing and exact public full-content readback; semantic processing may be `skipped` for memory files. Recall and browse read full content rather than treating summaries as the stored original. Session extraction and LLM curation are no longer used for these writes.
- In **Direct search** with the strategy **Keyword search**, and in `mnemon_recall` with `mode: "keyword"`, OpenViking is searched through its exact-text endpoint `search/grep` (#452). Each whitespace-separated term, or a double-quoted phrase, is matched literally, in any case and as a whole word, so `29.8.5` does not match `29.8.50`. A memory holding more of the terms comes first, the full memories are read back, and the results carry no score. Smart recall and Basic match stay semantic. A server without `search/grep` answers a keyword search semantically and says so.
- OpenViking requires a server supporting that content API; the optional integration test passes against the published 0.4.16, 0.4.20, 0.4.21, 0.5.0 and 0.5.1.1 backends. From 0.5.1 the server appends a reserved `MEMORY_FIELDS` trailer to each memory file and counts it in `written_bytes`; the exact readback still has to return the requested text. By default, discovery uses the Admin API; configure `account` and a key allowed to enumerate its users. For a user key without admin access, set **User key owner (skip admin)** (`discoveryUser`) alongside `endpoint`, `apiKey`, and `account`. This explicitly selects `viking://user/<discoveryUser>/memories`, validates it with read-only `GET /api/v1/fs/ls`, and synchronizes one space. It omits account/user identity headers because the server resolves them from the key; `account` names the local projection and cannot override the key's tenant. Obtain these identifiers from the service administrator. Missing roots, denied access and invalid responses reject the save without replacing existing configuration. No health-only or automatic admin-error fallback is used. Cloud service availability and write permission require separate validation; no live cloud account is certified by the deterministic tests. See upstream [authentication](https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/04-authentication.md) and [managed-service quick start](https://github.com/volcengine/OpenViking/blob/main/docs/en/getting-started/02-quickstart.md).
- Existing explicit `viking://user/<user>/memories` roots remain valid. Legacy `viking://user/memories` resolves using the configured `user`, or the authenticated system-status identity when omitted. User-key discovery uses its explicit owner and rejects mismatched memory owners. Unsafe path components and deletion outside the selected user root are rejected. The registry format is unchanged; before downgrading, clear `discoveryUser` with the current version and use an admin-capable setup, or disable the service and restore a compatible configuration. Remote memories remain untouched.
- OpenViking errors, incomplete indexing and timeouts never produce a committed receipt. A write may already exist remotely; its error includes the requested URI for inspection before retrying. There is no automatic extraction fallback or retry. A verified receipt carries the exact file `id`, allowing the Host to compensate a later failed local archive by deleting only its new index. Unknown remote write outcomes remain for inspection. Upgrading or rolling back the adapter does not delete existing remote files; a downgrade restores the older write, which sends the tags inside the write request and so needs OpenViking 0.4.18 or later.
- The WebUI never calls external services or local CLIs directly. Provider I/O stays in the Host with cancellation, timeouts, bounded process output, and shell-disabled argument arrays.
- Disabling a provider removes all of its local Memory Space mappings, activation state, and mapped title/description metadata. Re-enabling discovers them again from the provider. Reconciliation never deletes provider-owned data; per-memory Forget remains a separate capability-controlled action.
- Holographic is a TypeScript adaptation of local structured-fact semantics, using an atomic JSON store and an independent data format and lifecycle implementation.
- Hindsight uses a lightweight liveness probe and reads real statistics, entities, and relationships from the provider's bank stats, entity catalog, and graph responses. Recall and graph remain usable against older deployments that lack the newer statistics surfaces.
- ByteRover exposes focused `status`, `query`, and `curate` operations. Broad knowledge-tree browsing and deletion are intentionally not invented.
- Supermemory browse results merge extracted memory entries with still-browseable ingested documents and deduplicate by provider ID, so documents do not disappear from Content while extraction is incomplete.
- Mnemon Native records use. A recall by an Agent, by `/mnemon recall` or by **Ask Agent** adds a row with its query to the store's operation log (`mnemon log`, which keeps the latest 5,000 operations) and counts the memories it returns as accessed, which Mnemon's retention takes into account (`mnemon gc` never suggests a memory accessed three times). The Memory System's own searches (**Direct search** on Memory Spaces and **Find related memories** on the Entities page) read a snapshot instead, with `mnemon --readonly`, as its lists and graph already do, and change nothing. The Host's checks of its own writes while archiving read the live store, since a snapshot need not match a store another process is writing.
- Mnemon Packs include Mnemon Native Memory Spaces, Runtime, and Documents. External connections, credentials, local third-party stores, and remote provider data are excluded.
- Availability, pricing, privacy, retention, and licensing of external products are governed by their respective operators. Review those boundaries before sending private memory to a remote provider.

See [Third-party notices](../../../THIRD_PARTY_NOTICES.md) for source attribution and licensing boundaries.
