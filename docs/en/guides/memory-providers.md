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
| **OpenViking** | Existing HTTP service and `viking://` memory root | Yes / yes | Projected nodes / no | Verified exact text; no image/attachment writes | Guarded hard delete for exact user `.md` resources |
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

## Manual and smart placement

Manual placement preserves the existing workflow: create a Memory Space, choose one engine, configure it, and continue to use the same Recall, Content, Entities, and Remember surfaces.

Smart placement builds an allowlist from the candidates selected by the user:

1. The Host enforces data boundary and required-capability rules.
2. If one eligible provider remains, rules select it deterministically.
3. If several remain, an independent task Agent considers the routing description, soft preference, and user-authored strategy prompt.
4. The Host validates the returned provider against the eligible set and persists the decision, reason, confidence, and candidate IDs.

Connection secrets never enter the selector prompt. `local-only` excludes every remote provider before model selection. Mnemon Native stays a local candidate while its CLI is available.

## Recall score semantics

Mnemon Native `smart` recall requests verbose signals and expands the Source's candidate request to `min(50, max(20, requested * 4))` before applying its result limit. When positive vector similarities are available, those similarities are bounded to 0–1, ranked first, and used by recall quality thresholds. Results without similarity stay unscored unless marked superseded; those retain the CLI demotion and never rise above their existing score. If every similarity is missing or nonpositive, the original CLI order and scores remain available. `keyword` and `basic` keep their original commands and scores. Older CLIs that reject `--verbose` are retried once without that flag, since their default response already contains signals. This is bounded reranking of CLI candidates, not an exhaustive vector search or a calibrated probability. Ordinary recall records access to the larger candidate pool; inspection still uses `--readonly`.

Hindsight final ranking scores include boosts; OpenViking similarity scores are not calibrated query confidence. Both declare `provider-native` in the manifest and driver. Memory Spaces admits their original ranking under `recallQuality.maxRankedResults` without comparing raw scores or clamping them to 1; see [recall quality policies](../reference/configuration.md#recall-quality-policies).

## OpenViking content support

The OpenViking adapter currently accepts text through `RememberRequest.content` and stores it as a Markdown file. It does not upload images or file attachments, or send `content_base64`; a server's multimodal capabilities do not extend this adapter's input contract.

For content written through this adapter, use an embedding configuration that accepts text. A text embedding model is sufficient for this input format; an existing multimodal model can remain in use if it supports text in your OpenViking deployment. This limitation alone does not require changing embedding models or rebuilding an existing index.

Future image and attachment write support is tracked in [issue #453](https://github.com/omdsh-dev/dsh-mnemon/issues/453).

## Operational boundaries

- OpenViking `keyword` search uses `POST /api/v1/search/grep` for case-insensitive literal text, with regex metacharacters escaped. It scopes `uri` to the selected user memory root and bounds `node_limit` to the Source search budget (1–50; direct adapter default 10). Repeated lines in one file count as one result; only safe in-root memory Markdown files are hydrated through `content/read`, and no relevance score is invented. `smart`/`basic` keep `search/find`. A missing grep endpoint or invalid response is reported as an error rather than a semantic fallback; arbitrary regular-expression input is not exposed. The request uses the common fields of OpenViking 0.4.16 and 0.5.1.1.
- OpenViking writes a new `.md` file with `content/write`, `mode: "create"` and `wait: true`, sending only `uri`, `content`, `mode` and `wait`; OpenViking 0.5.1 removed the request-body `timeout` field, while the HTTP client deadline still applies, then sets the source, category and importance tags with `content/set_tags`; a server that cannot tag, or does not confirm the tags within 5 seconds, still keeps the verified memory, and the receipt says `tagsApplied: false`. Categories map to `preferences`, `experiences` (insight/decision), `events` (context), or `entities` (fact/general), and the file name ends in `_<category>-<uuid>.md`, so a memory reads back with the category it was written with. Files without it, written by an earlier version or by OpenViking itself, read back by their folder: `preferences` as preference, `experiences` as insight, `events` as context and `entities` as fact. An unknown category is stored as `general`. A write the server refuses (HTTP 4xx other than 408 and 409) is reported as not stored. A stored receipt requires matching URI, a byte count covering the submitted text (newer servers also count reserved metadata), completed vector indexing and exact public full-content readback; semantic processing may be `skipped` for memory files. Recall and browse read full content rather than treating summaries as the stored original. Session extraction and LLM curation are no longer used for these writes.
- OpenViking requires a server supporting that content API; the optional integration test passes against the published 0.4.16, 0.4.20 and 0.5.0 backends. By default, discovery uses the Admin API; configure `account` and a key allowed to enumerate its users. For a user key without admin access, set **User key owner (skip admin)** (`discoveryUser`) alongside `endpoint`, `apiKey`, and `account`. This explicitly selects `viking://user/<discoveryUser>/memories`, validates it with read-only `GET /api/v1/fs/ls`, and synchronizes one space. It omits account/user identity headers because the server resolves them from the key; `account` names the local projection and cannot override the key's tenant. Obtain these identifiers from the service administrator. Missing roots, denied access and invalid responses reject the save without replacing existing configuration. No health-only or automatic admin-error fallback is used. Cloud service availability and write permission require separate validation; no live cloud account is certified by the deterministic tests. See upstream [authentication](https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/04-authentication.md) and [managed-service quick start](https://github.com/volcengine/OpenViking/blob/main/docs/en/getting-started/02-quickstart.md).
- Existing explicit `viking://user/<user>/memories` roots remain valid. Legacy `viking://user/memories` resolves using the configured `user`, or the authenticated system-status identity when omitted. User-key discovery uses its explicit owner and rejects mismatched memory owners. Unsafe path components and deletion outside the selected user root are rejected. The registry format is unchanged; before downgrading, clear `discoveryUser` with the current version and use an admin-capable setup, or disable the service and restore a compatible configuration. Remote memories remain untouched.
- OpenViking errors, incomplete indexing and timeouts never produce a committed receipt. A write may already exist remotely; its error includes the requested URI for inspection before retrying. There is no automatic extraction fallback or retry. A verified receipt carries the exact file `id`, allowing the Host to compensate a later failed local archive by deleting only its new index. Unknown remote write outcomes remain for inspection. Upgrading or rolling back the adapter does not delete existing remote files; a downgrade restores the older write, which sends the tags inside the write request and so needs OpenViking 0.4.18 or later.
- The WebUI never calls external services or local CLIs directly. Provider I/O stays in the Host with cancellation, timeouts, bounded process output, and shell-disabled argument arrays.
- Disabling a provider removes all of its local Memory Space mappings, activation state, and mapped title/description metadata. Re-enabling discovers them again from the provider. Reconciliation never deletes provider-owned data; per-memory Forget remains a separate capability-controlled action.
- Holographic is a TypeScript adaptation of local structured-fact semantics, using an atomic JSON store and an independent data format and lifecycle implementation.
- Holographic treats explicit write importance as an integer from 1 through 5 and stores trust as `importance / 5`; when importance is omitted, `defaultTrust` applies. Search, browse and related reads exclude facts below `minTrust`. Hidden facts stay stored. Existing facts keep their saved trust: an old trust of 1 cannot reveal the original importance and is not rewritten. New facts retain explicit importance separately; old readers ignore that optional field. Other Providers now receive an omitted importance unchanged and apply their own defaults (Mnemon Native still uses 3).
- Hindsight uses a lightweight liveness probe and reads real statistics, entities, and relationships from the provider's bank stats, entity catalog, and graph responses. Recall and graph remain usable against older deployments that lack the newer statistics surfaces.
- On Windows, ByteRover resolves global or local npm-installed `brv.cmd` shims from `PATH` or an explicit `cliPath` and runs the verified `byterover-cli/bin/run.js` entry with Node. Relative `PATH` entries and explicit relative `cliPath` values resolve from the knowledge working directory; the JavaScript entry is made absolute before launch. Queries and curated content stay literal arguments without a shell. Install the CLI separately with `npm install -g byterover-cli`; custom executables continue to run directly. Unrecognized `.cmd` wrappers are rejected with setup guidance.
- ByteRover exposes focused `status`, `query`, and `curate` operations. Broad knowledge-tree browsing and deletion are intentionally not invented.
- Supermemory browse results merge extracted memory entries with still-browseable ingested documents and deduplicate by provider ID, so documents do not disappear from Content while extraction is incomplete.
- Mnemon Native records use. A recall by an Agent, by `/mnemon recall` or by **Ask Agent** adds a row with its query to the store's operation log (`mnemon log`, which keeps the latest 5,000 operations) and counts the memories it returns as accessed, which Mnemon's retention takes into account (`mnemon gc` never suggests a memory accessed three times). The Memory System's own searches (**Direct search** on Memory Spaces and **Find related memories** on the Entities page) read a snapshot instead, with `mnemon --readonly`, as its lists and graph already do, and change nothing. The Host's checks of its own writes while archiving read the live store, since a snapshot need not match a store another process is writing.
- Mnemon Packs include Mnemon Native Memory Spaces, Runtime, and Documents. External connections, credentials, local third-party stores, and remote provider data are excluded.
- Availability, pricing, privacy, retention, and licensing of external products are governed by their respective operators. Review those boundaries before sending private memory to a remote provider.

See [Third-party notices](../../../THIRD_PARTY_NOTICES.md) for source attribution and licensing boundaries.
