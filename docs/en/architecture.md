# Architecture

[简体中文](../zh-CN/architecture.md) | **English** | [Documentation Center](./README.md)

## Positioning

`dsh-mnemon` is an integration and supervision layer between DSH and replaceable long-term-memory providers, not a new database engine:

- DSH provides the root Agent, lifecycle events, subagent providers, tools, commands, settings, and Web extension points;
- the plugin provides the control plane for three knowledge layers, routing policies, transactional barriers, and UI;
- Mnemon Native uses the local `mnemon` CLI for named Stores, SQLite, four graph types, relationships, and soft deletion and remains the official prioritized implementation; eight third-party adapters provide Host-controlled HTTP, local-file, or CLI data planes.

The three tiers are now the default topology rather than the only topology hard-coded into every surface. The runtime model intentionally has four primary concepts: `MemoryBoot` assembles trusted contributions, `MemorySource` snapshots one kind of memory, `TurnView` pins one Source generation for a turn, and `MemoryReceipt` advances the next turn after a committed mutation. Layer, Adapter, Strategy, and Guard remain control-plane extension boundaries rather than extra concepts exposed to the model or ordinary user.

Read only the layer that matches your role:

| Reader | Concepts that matter |
|---|---|
| Ordinary user | Runtime, Documents, and Memory Spaces; the default UI and workflows are unchanged |
| Operator | Topology plus each Layer's recall, write, projection, and maintenance participation |
| Extension author | MemoryBoot, MemorySource, TurnView, Receipt, and the Kernel extension boundaries below |

## Composable Memory Kernel

```text
Cordis lifecycle
      |
      v
 MemoryBoot ---- trusted extensions
      |
      +---- Catalog / Topology / Kernel
      |
      +---- MemorySources (eager | routed)
                       |
turn begins -------- snapshot --------> TurnView
                       |                   |
                       |                   +--> bounded Wake --> System Prompt
                       |                   +--> Host-only Source state
                       |                                      |
model recall(query, optional source ids) ---------------------+
                                                              v
                                                    MnemonService / Provider

committed mutation --> MemoryReceipt --> next turn snapshots a new TurnView
```

`TurnView` is a lightweight generation snapshot, not a knowledge tree. Eager Source text enters Wake exactly; routed Sources contribute one JSON-quoted cover under a shared budget, while their complete ID authority stays Host-side and digest-bound. Recall never needs a model-facing View ID, node ID, Zoom operation, capability token, or a second LLM worker. The Host derives the executing Agent's own turn pin, validates any requested IDs as a subset, then calls the data plane directly. A child inherits a captured View, not permission to look up its parent's latest turn.

Plans remain an internal transaction mechanism for guarded or multi-Layer operations:

```text
request -> Guard -> Strategy proposal -> Kernel validation -> MemoryPlan
                                                    |
                                                    v
                                      one atomic claim + executor(s)
                                                    |
                                                    v
                                             MemoryReceipt
```

- `MemoryBoot` is the minimal Host assembler. It applies one trusted extension set to every independently owned runtime graph; Cordis still owns scope, unloading, and isolate lifetimes.
- `MemoryCatalog` is the runtime contribution directory. Registration and disposal are lifecycle-owned and monotonically advance its generation.
- `MemoryTopologyManager` atomically stores one composition generation and follows the live Catalog by adding new Layers as disabled candidates and removing unloaded Layers from the candidate set. An operation pins Catalog/Topology/Guard generations; a Plan must be rebuilt after any of them changes.
- `MemoryKernel` revalidates Layers, capabilities, Adapter bindings, participation, budgets, and non-bypassable Guards after Strategy planning. A Strategy receives no data-plane handle and cannot read or write memory directly.
- An operation fails closed when a Strategy produces no executable steps. A Plan is claim-once authority: sequential or concurrent replay is rejected before any second data-plane step. Execution receipts distinguish `succeeded`, `partial`, `failed`, and `cancelled` instead of presenting partial failure as success.
- Disabling a Layer stops participation; it never deletes, migrates, or hides control-plane metadata. Re-enabling it uses the existing storage.

Every Layer has independent `recall`, `write`, `projection`, and `maintenance` participation channels. `off` denies the channel, `manual` accepts only explicit user/control-plane operations, and `automatic` accepts both explicit and model/lifecycle/system operations. A model tool is an `automatic` trigger and cannot bypass `manual` merely because the model explicitly called a tool.

Runtime, Documents, and Memory Spaces are three Layer workspace packages. The `default-three-tier` Strategy is only the default composition. A newly discovered extension Layer enters the candidate topology disabled. The descriptor-driven Settings UI exposes only its enabled switch; four-channel policy remains in the Kernel/SDK control plane.

## Workspace with One Published Package

Source is split by responsibility while users continue to install only `dsh-mnemon`. This keeps DSH profile install, upgrade, and rollback atomic and avoids imposing a multi-package version matrix on plugin authors prematurely.

| Workspace | Published subpath | Responsibility |
|---|---|---|
| `packages/contracts` | `dsh-mnemon/contracts` | Pure JSON/wire contracts with no DSH, Cordis, React, or Provider SDK dependency |
| `packages/kernel` | `dsh-mnemon/kernel` | Catalog, Topology, Plan, Receipt, Guard, and Kernel |
| `packages/layer-*` | `dsh-mnemon/layers/*` | Three default Layer descriptors and lifecycle registration helpers |
| `packages/strategy-sdk` | `dsh-mnemon/strategy-sdk` | Strategy definitions, permission manifests, and replay primitives |
| `packages/strategy-default-three-tier` | `dsh-mnemon/strategy-default-three-tier` | Default topology and compatibility Strategy |
| `packages/provider-sdk` | `dsh-mnemon/provider-sdk` | Adapter Factory Registry and third-tier Provider extension interfaces |
| `packages/extension-sdk` | `dsh-mnemon/extension-sdk` | `MemoryBoot`, Host-global extension registration, and per-runtime attachment |
| root `src/` | `dsh-mnemon` / `dsh-mnemon/client` | DSH Host, existing controllers, Provider implementations, RPC, and WebUI composition roots |

Internal workspaces remain `private`; the compatibility commitment applies to the `dsh-mnemon/*` exports. Separate npm artifacts should appear only if the ecosystem later needs genuinely independent release cadences.

## MemoryBoot on Cordis Space-Time Composition

Cordis provides scope, ownership, dependency injection, and unloading. `MemoryBoot` adds only the memory-specific assembly convention on top: collect trusted contributions, attach them to each runtime graph, validate Source readiness, and release them in reverse order. The Host publishes that Boot as the `mnemonMemory` Cordis service, while `dsh-mnemon/extension-sdk` also supports process-level pre-registration.

Extensions may register before Host mount or register/unload while it is live. Every global/workspace runtime owns an independent Catalog, Topology, Kernel, and TurnView manager but receives the same Boot contribution set. Live Catalog changes advance Topology generations; a settings update fully builds and validates the next runtime generation before stable proxies swap atomically.

A Cordis isolate provides ownership, unloading, and scope composition; it is not a security sandbox. Layer executors, Provider Adapters, and ordinary JavaScript Strategies run in the Host process and therefore come only from trusted installed plugins. A model-generated Strategy must first pass an immutable `MemoryStrategyPlugin` manifest, Layer/Adapter/Capability/maxSteps permissions, and replay. The Kernel still performs authoritative validation afterward. This release does not execute arbitrary code immediately after a model writes it; future shadow, canary, signed-artifact, and rollback workflows build on these boundaries.

## Component Diagram

[![dsh-mnemon runtime architecture](../assets/diagrams/en/project-architecture.svg)](../assets/diagrams/en/project-architecture.svg)

Solid lines show deterministic data or control paths; purple dashed lines show independent task-Agent paths. Runtime Memory and Documents use managed files directly. Memory Spaces first pass through `MemoryProviderAdapter`, then enter the selected provider data plane. The third tier represents Mnemon Native and all eight external implementations rather than describing the whole system as Native-only local data. Click the image to open the original 1600×900 SVG.

Cross-agent interoperability therefore applies only to the third tier: Mnemon Native shares by aligning a local root and Store, while external engines share through their own provider scope. None automatically shares DSH conversation context, Runtime projections, or Documents.

### Third-tier provider contract

`MemoryProviderAdapter` keeps catalog, lifecycle, and user operations in dsh-mnemon's control plane while delegating provider discovery plus `status / search / graph projection / browse / remember / related / link / forget` to data-plane adapters. Discovery is authoritative: a successful provider save atomically replaces that provider's local namespace mappings and maps upstream titles/descriptions; a failed discovery leaves the prior configuration untouched. Capability declarations are a shared hard boundary for UI, agents, and Host: unsupported actions are hidden and rejected. The complete current matrix is maintained in [Long-term memory providers](./memory-providers.md).

Cross-provider search runs concurrently, with one failure reduced to a Memory-Space-scoped hint. Each adapter declares whether its score is normalized relevance; the registered pure quality policy expands candidates, filters them before serialization, and emits structured counts. Heterogeneous raw scores are never compared directly; retained results use reciprocal-rank fusion over each provider's returned order. New adapters and quality policies reuse these contracts without changing the upper-layer Memory Space semantics.

Creation-time provider placement is separate from recall routing. The Host first narrows candidates by configured state, allowlist, data boundary, and required capabilities. One candidate resolves deterministically; multiple candidates send only a redacted capability brief, the Memory Space purpose, and the user's strategy to a tool-free `spawn` worker. The Host validates the structured selection against the eligible set before instantiating the provider, then persists rules, reason, confidence, and worker audit metadata. Endpoints, API keys, and identity headers remain Host-only.

## Host Composition Root

`src/index.ts::apply()` assembles the plugin in this order:

```text
settings.register("mnemon")
  -> resolveConfig
  -> MemoryCatalog + default contributions
  -> attach MemoryBoot contributions
  -> MemoryTopology / MemoryKernel
  -> createRunner / MnemonService
  -> RuntimeMemoryController / DocumentManager / StorageScopeInspector
  -> create default MemorySources / TurnView manager
  -> bind Boot MemorySources / validate readiness
  -> MnemonSubagentCoordinator
  -> MnemonLifecycle
  -> tools / commands / prompt sections
  -> register RPC when a Web connection exists
```

The Host declares dependencies on `tools`, `settings`, `commands`, `agents`, and `subagents`. `workspaceRegistry` is discovered optionally through the Host service registry and is used only for authorized Web inspection. The Web client additionally depends on slots, connection, and DSH locale services.

## Web and Headless Boundaries

The core Host composition is profile-neutral. Both Web and Headless mount settings, Runtime context, Documents, Memory Space tools, lifecycle hooks, and supervised workers. Agent operations always derive `workspace` storage from the session cwd.

Web additionally provides `workspaceRegistry`, client slots, and `connection`. Those services enable cross-workspace inspection, RPC, Sidebar, settings UI, Turn memory, and Save to memory. Headless provides none of those browser services; its one-shot runner submits an ordinary user message, waits for Agent idle, flushes the session, prints the final answer, and exits. Plugin disposal cancels a pending delayed review, so Headless relies on explicit or model-guided writes completed inside the task rather than post-idle maintenance.

## Direct Recall and Supervised Mutations

Recall is a deterministic Host read under the Source authority pinned before System Prompt assembly. Every executing Agent turn owns its pin. At `agent/created`, before the child driver runs, the Host resolves the live parent through `parentSession`, retains its pinned View, and binds the child to that runtime generation. The child keeps this delegation until its activation is disposed, independently of the parent's turn ending, later turns, View collection, or settings swaps. Nested children capture the same authority. Each child turn pins the retained View under its own identity; it does not receive root-only reminder or idle-review hooks.

An explicitly Host-created background child with no active parent model turn snapshots its own View in the captured runtime/workspace scope. A cold-resumed child is a new activation and receives a new delegation from its live parent. A lineage string without a live parent grants nothing. Missing executing-turn authority fails closed; neither an active later parent turn nor `lastViewForAgent()` is a fallback.

Recall/Related caches and the Documents search slot belong to the immutable turn-context object, not a reusable session ID or turn number. Siblings, later turns, and resumed activations have independent budgets, while parallel calls within one turn share a budget. Cache keys include the selected Memory Space subset, and replay never returns evidence outside that subset. Queued queries retain the admitted data-plane generation and check cancellation before Provider dispatch.

```text
Agent calls mnemon_recall(query, optional memoryBodyIds)
  -> resolve the executing Agent's turn pin and retained runtime
  -> read Host-only Memory Space Source state
  -> reject requested IDs outside the pinned set
  -> MnemonService searches authorized Providers concurrently
  -> normalize quality and reciprocal-rank fusion
  -> if surviving evidence loses exact anchors or sufficient lexical coverage, run one bounded Native keyword recovery
  -> admit at most 4 initial results while reserving recovery capacity
  -> LLM either answers or explicitly submits one different refinement query
  -> deduplicate both attempts inside one 6-result / 4,800-character envelope
```

The model decides whether Recall happens at all; ordinary turns therefore perform zero Provider Recall. Inside an already-authorized smart search, the Host first checks whether selected evidence preserves high-information dates, percentages, times, versions, identifiers, and numbers from the query. When at least two such anchors exist but no selected row covers the bounded required set, Mnemon Native alone runs one local keyword fallback over those anchors. Otherwise, a focused query with at least four bounded lexical tokens can use the same one-shot local fallback when no selected row has sufficient token coverage. Recovered rows must satisfy the corresponding anchor or token threshold, are deduplicated, and still pass through the original quality and output limits. Query-covering rows are ordered before the smaller model envelope, preventing a generic medium-score row from consuming the only initial slot ahead of more precise evidence. Remote Providers are never queried twice by this fallback, and it creates neither a Recall trigger nor a model call. After an initial call, the model may explicitly make one materially different query only when the returned evidence is insufficient. Same-query calls join or replay, a third distinct query cannot reach a Provider, and both attempts together admit at most six results, 1,200 characters per result, and 4,800 content characters. The initial attempt is capped at four results and 3,600 content characters so the recovery path always has capacity; each attempt admits at most one medium-confidence and one unknown-scale row, so a valid refinement can contribute evidence without opening an unbounded low-confidence stream. The model-facing result omits the complete Source catalog, selected-ID echo, and routing diagnostics; tags and entities are limited to eight each. `mnemon_related` uses the same pinned-source check and a separate bounded envelope. Long-term semantic writes, relationships, deletion, and Memory Space creation or updates remain supervised where semantic judgment is useful, while the deterministic service first checks the target provider's capabilities. Mnemon Native remains the complete reference implementation; external adapters expose only their exact, async, graph, browse, related, and deletion semantics. Ordinary Runtime Memory and Document mutations remain deterministic. Document search tokenizes contiguous Han text into a bounded set of bigrams so a natural Chinese query can match the relevant passage without sending a catalog or an extra model request. Focused queries must also meet a bounded minimum token-coverage threshold, preventing one common bigram from serializing several unrelated Documents into conversation history.

Memory Space removal is a separate dangerous action. Mnemon Native invokes `store remove` after confirmation and removes registration only after success. Every third-party provider uses **Disconnect** semantics: it removes local connection metadata and never deletes provider memory.

## Independent Task Agents and Internal Workers

AI metadata, Agent Query, memory distillation, and document archiving initiated by the Web workbench first create a new top-level task Agent. It borrows no conversation history, binds its cwd explicitly to the selected workbench workspace, composes the default DSH preset, and is disposed after completion. Its model route follows the DSH new-session default unless `taskAgentModel` pins a complete Provider + Model. The same `taskAgentModel` route also applies to every Mnemon subagent delegation issued by the coordinator (idle checkpoint review, write, answer, provider placement, migration, compaction, document archive, and metadata maintenance), so a fixed route covers both the top-level task Agent and all of its internal workers.

The top-level task Agent is the user-visible execution unit. The `spawn` / `fork` providers below are bounded internal workers. When semantic judgment is needed, the task Agent may still dispatch a worker, which inherits its parent task Agent's model route. UI copy therefore says **independent task Agent**, while diagnostics and architecture retain worker / subagent terminology.

### `spawn` worker

`spawn` uses a new isolated context. For each task type, the plugin supplies:

- a fixed persona;
- a minimal tool allowlist;
- a schema-validated, randomly named result tool scoped to that one run and included in the same allowlist;
- `maxDepth: 1`;
- a cancellable signal and bounded token budget.

It is used for long-term semantic writes, evidence-bound answers, hot-memory maintenance, and Document archiving. Recall and related reads no longer spend a second model call.

### `fork` worker

Scored background review requires a provider named `fork` with `inheritsParentContext=true`. It inherits only a completed parent checkpoint and determines whether to maintain hot memory or at most one Project Document. It is not a continuation of the user's task, and it does not inject review reasoning into the main conversation.

The current review allowlist excludes `mnemon_remember`, `mnemon_forget`, and Memory Space maintenance tools, so background review cannot modify long-term Memory Spaces directly.

## Control Plane and Data Plane

```text
LLM-owned judgment                  Host-owned guarantees
------------------                  ---------------------
what is worth keeping               input validation
which Memory Space fits             path boundary
whether two items are duplicates    process timeout/cancel
how to summarize a Document         file lock + atomic rename
whether a reusable artifact exists  UTF-8 capacity accounting
                                     revision conflict rejection
                                     RPC trust / authentication boundary
```

Persona constraints must be distinguished from hard Host guarantees. For example, the MEMORY archival worker is instructed to cover every committed hot-memory item, but the Host can strictly validate only the structured action, revision, and byte budget; the Host does validate USER compaction source coverage item by item.

## Web RPC Boundary

The WebUI does not start system processes or open SQLite directly:

```text
browser component
  -> typed client wrapper
  -> DSH transport trust / authentication
  -> Host validation
  -> controller / service / bounded worker
  -> local CLI or managed files
```

The same Mnemon build supports both DSH transport generations without detecting a runtime version. On 0.1.1-rc.2, read and activation channels use `trusted-host`, while write, settings, and backup remain `loopback` unless the startup-only `remoteAccess=trusted-host` compatibility setting promotes them together. On 0.1.2-alpha.5, DSH ignores the trailing authority argument and protects every channel with its launch-token-derived browser session. The activation handler still accepts only an exact body ID and Boolean state, and Provider credential values travel only through the private management catalog while the ordinary read catalog stays redacted. Browser components derive product writability from Host settings and disable mutation controls before transport. When `writeEnabled=false`, every mutation handler rejects the request at the Host boundary.

## Internationalization

`src/client/locales.ts` defines `MnemonKey` from the Chinese key set, and the English dictionary must satisfy the same set of keys; `src/client/index.ts` registers both dictionaries with the DSH locale. The main Web pages and settings card switch immediately with the DSH global language and reuse the global light or dark theme.

Command output, tool-card titles, persisted compatibility-default Memory Space names, and some backend errors are still monolingual. This is a known gap on the Roadmap.

## Key Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Host composition and registration |
| `src/config.ts` | Configuration schema, defaults, and resolution |
| `src/process.ts` | Bounded process execution without a shell |
| `src/runner.ts` | CLI discovery, arguments, serialization, and JSON parsing |
| `src/service.ts` | Application facade for long-term memory |
| `src/memory-bodies.ts` | Memory Space catalog metadata |
| `src/providers/*` | Third-tier provider contract, catalog, native routing, and external adapters |
| `src/runtime-memory.ts` | Hot-memory source of truth and projections |
| `src/documents.ts` | Documents control plane |
| `src/subagent.ts` | Worker orchestration and capacity transactions |
| `src/lifecycle.ts` | Per-root-Agent lifecycle |
| `src/review-activity.ts` | Deterministic review scoring |
| `src/tools.ts` | Model tools and root/worker routing |
| `src/rpc.ts` | Web read/write channels |
| `src/storage-scope.ts` | Read-only inventory of the three storage scopes |
| `src/client/*` | Web workspace, settings, and locale |
