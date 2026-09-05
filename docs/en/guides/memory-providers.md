# Long-term memory providers

**English** | [简体中文](../../zh-CN/guides/memory-providers.md) | [Documentation](../README.md)

Memory Spaces are the replaceable third tier in dsh-mnemon. The Memory Space contract stays stable while its provider supplies the data plane. **Mnemon Native is the official, prioritized default**; external providers are opt-in integrations for teams that already use another memory engine or need a different sharing, extraction, or retrieval model.

Each adapter is an independently published `dsh-mnemon-provider-*` package, installed as a child of the Memory Spaces Source. The Starter includes all nine packages, but external services remain disabled until configured. No external backend server or CLI is bundled. See the [official package list](../../../README.md#official-plugins) and [Provider author contract](../development/extensions.md).

## Provider matrix

| Provider | Data plane | Recall / browse | Graph / related | Write | Forget |
|---|---|---|---|---|---|
| **Mnemon Native** | Local `mnemon.db` through the official CLI | Yes / yes | Full typed graph / yes | Exact | Soft delete |
| **OpenViking** | Existing HTTP service and `viking://` memory root | Yes / yes | Projected nodes / no | Async extraction | Guarded hard delete for exact user `.md` resources |
| **Honcho** | v3 workspace conclusions | Yes / yes | No / no | Exact peer conclusion | Hard delete |
| **Mem0** | Platform v3 or self-hosted HTTP API | Yes / yes | No / no | Async extraction | Hard delete |
| **Hindsight** | Memory bank API and knowledge graph | Yes / yes | Provider graph / yes | Async retain | Invalidate (soft) |
| **Holographic** | Local atomic structured-fact file | Yes / yes | Entity/semantic graph / yes | Exact fact | Hard delete |
| **RetainDB** | Project/user-scoped HTTP API | Yes / yes | No / no | Exact memory | Hard delete |
| **ByteRover** | Local `brv` CLI and knowledge directory | Yes / no | No / no | Async curate | Unsupported |
| **Supermemory** | Container-scoped HTTP API | Yes / yes | Projected nodes / no | Async document ingest | Provider forget |

The Host exposes only capabilities an adapter can honor. UI actions and Agent tools do not fabricate missing graph, related, link, browse, or deletion behavior.

## Service and Memory Space fields

| Provider | Workspace behavior | Service configuration in Settings | Instance configuration in Memory Spaces |
|---|---|---|---|
| OpenViking | Keeps the provider-global scope | `endpoint`, `apiKey`, `account` | `targetUri`, `user`, `actorPeerId` |
| Honcho | Keeps the provider-global scope | `endpoint`, `apiKey` | `workspace`, `userId`, `agentId` |
| Mem0 | Keeps the provider-global scope | `endpoint`, `apiKey`, `mode` | `userId`, `agentId`, `rerank` |
| Hindsight | Keeps the provider-global scope | `endpoint`, `apiKey` | `bankId`, `budget` |
| Holographic | Follows by default; path can override | `dataPath` | `defaultTrust`, `minTrust` |
| RetainDB | Keeps the provider-global scope | `endpoint`, `apiKey` | `project`, `userId` |
| ByteRover | Follows by default; directory can override | `cliPath`, `apiKey`, `defaultDirectory` | `workingDirectory` |
| Supermemory | Keeps the provider-global scope | `endpoint`, `apiKey` | `containerTag`, `searchMode` |

**Settings → Memory System** owns reusable provider service configuration. Enabling or saving a provider performs authoritative discovery and synchronizes every visible provider-native namespace into the Memory Space directory—for example banks, projects, workspaces, users, or container tags. Provider titles and descriptions become the local routing metadata. **Memory Spaces → Overview** controls DSH activation and shows the synchronized instance scope. The Host merges both layers immediately before calling an adapter. Secrets stay in `<storageRoot>/state/memory-providers.json` with mode `0600`; the WebUI represents configured secrets only as a mask, and entering a new value replaces the saved secret.

DSH workspace mode does not rewrite every provider namespace. Mnemon Native follows the workspace automatically. Holographic and ByteRover default to workspace-local paths but allow explicit path overrides. Remote providers continue to use the URI, workspace, user, bank, project, or container configured on the Memory Space; switching DSH workspaces never rewrites those identities implicitly.

## Manual and smart placement

Manual placement preserves the existing workflow: create a Memory Space, choose one engine, configure it, and continue to use the same Recall, Content, Entities, and Remember surfaces.

Smart placement builds an allowlist from the candidates selected by the user:

1. The Host enforces data boundary and required-capability rules.
2. If one eligible provider remains, rules select it deterministically.
3. If several remain, an independent task Agent considers the routing description, soft preference, and user-authored strategy prompt.
4. The Host validates the returned provider against the eligible set and persists the decision, reason, confidence, and candidate IDs.

Connection secrets never enter the selector prompt. `local-only` excludes every remote provider before model selection. Mnemon Native remains present as the official local candidate.

## Operational boundaries

- The WebUI never calls external services or local CLIs directly. Provider I/O stays in the Host with cancellation, timeouts, bounded process output, and shell-disabled argument arrays.
- Disabling a provider removes all of its local Memory Space mappings, activation state, and mapped title/description metadata. Re-enabling discovers them again from the provider. Reconciliation never deletes provider-owned data; per-memory Forget remains a separate capability-controlled action.
- Holographic is a TypeScript adaptation of local structured-fact semantics, using an atomic JSON store and an independent data format and lifecycle implementation.
- Hindsight uses a lightweight liveness probe and reads real statistics, entities, and relationships from the provider's bank stats, entity catalog, and graph responses. Recall and graph remain usable against older deployments that lack the newer statistics surfaces.
- ByteRover exposes focused `status`, `query`, and `curate` operations. Broad knowledge-tree browsing and deletion are intentionally not invented.
- Supermemory browse results merge extracted memory entries with still-browseable ingested documents and deduplicate by provider ID, so documents do not disappear from Content while extraction is incomplete.
- Mnemon Packs include Mnemon Native Memory Spaces, Runtime, and Documents. External connections, credentials, local third-party stores, and remote provider data are excluded.
- Availability, pricing, privacy, retention, and licensing of external products are governed by their respective operators. Review those boundaries before sending private memory to a remote provider.

See [Third-party notices](../../../THIRD_PARTY_NOTICES.md) for source attribution and licensing boundaries.
