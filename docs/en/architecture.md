# Composable View Memory Architecture

[简体中文](../zh-CN/architecture.md) | **English** | [Documentation Center](./README.md)

The system has three domain concepts: a **Source** owns memory and its operations; a **Strategy** proposes how available Sources participate; a **View** is the bounded context and interaction shape presented to the LLM for one scope and scenario. Runtime, Documents and Memory Spaces are the default composition, not Core's universal memory taxonomy.

## Ownership and assembly

```mermaid
flowchart TB
  Starter["dsh-mnemon Starter · cordis.patch.yml"] --> Host["Host · ctx.mnemonMemory"]
  Starter --> Runtime["dsh-mnemon-source-runtime"]
  Starter --> Docs["dsh-mnemon-source-documents"]
  Starter --> Spaces["dsh-mnemon-source-memory-spaces"]
  Starter --> Strategy["dsh-mnemon-strategy-default-three-tier"]
  Spaces --> Providers["dsh-mnemon-provider-* · private child Fibers"]
```

This diagram shows installation ownership, not business calls. DSH creates the top-level Entries/Fibers. Each Source or Strategy uses the same `installMemory(ctx, ...)` SDK and Cordis-owned disposer. Core provides only `ctx.mnemonMemory`; it does not implement a Memory Spaces Fiber or publish `ctx.mnemonMemorySpace`.

Memory Spaces authors its **own** child Fibers and Provider protocol. Each configured Provider is an explicitly installed module; two Source instances can use the same child id without sharing their registry or credentials. No dependency scan or global Provider registry selects implementations.

Like a Spring Boot starter, the default distribution chooses dependencies and explicit defaults. It does not turn Source business code into Core. Users still install `dsh-mnemon`; contributors can independently build, test, publish and install any of the 13 plugin packages. Alternative compositions explicitly choose Source instances and a Strategy.

| Owner | Owns | Does not own |
|---|---|---|
| Core/SDK | Registration, contract validation, immutable Views, budgets, generations and leases | Provider drivers, Source data formats/storage decisions, pages, DSH lifecycle policy |
| Source | Storage/remote authority, facts, projections, grants, query/mutation and optional management/Client | Other Sources' controllers or global strategy selection |
| Strategy | Pure deterministic `request + facts → ViewSpec` | Raw data, credentials, drivers, side effects or new authority |
| Host | Scope, phase hooks, tool/RPC adapters, authentication, settings and supervised tasks | Source implementations or private registries |
| Starter | Package set, Entry ids and default configuration | A second loader or runtime |

## Default plugin combination

| Plugin | Memory authority | Default View contribution |
|---|---|---|
| `dsh-mnemon-source-runtime` | Runtime JSON, USER/MEMORY projections, branch filtering, capacity | Exact working context, eager |
| `dsh-mnemon-source-documents` | Managed Markdown, index, search, revision and archive | Bounded narrative cover and search route |
| `dsh-mnemon-source-memory-spaces` | Space directory, private Providers, capability/quality policy | Bounded durable-evidence cover and recall/related routes |
| `dsh-mnemon-strategy-default-three-tier` | No memory storage | Selects the three roles and allocates projection/routes/actions |

The nine independent Provider plugin packages are `dsh-mnemon-provider-{mnemon-native,openviking,honcho,mem0,hindsight,holographic,retaindb,byterover,supermemory}`. A Provider runs *inside* Memory Spaces as its storage/retrieval driver, not as a new Core contribution. A Git/Notion/health plugin should normally be a Source; an alternate way to combine them is a Strategy.

Default Strategy selection rejects multiple instances with the same default role as ambiguous. A multi-Notion or multi-space deployment selects explicit instance keys in its own Strategy; it must not rely on import order.

## View data flow

```mermaid
flowchart LR
  Facts["Source facts"] --> Strategy["Strategy → ViewSpec"]
  Strategy --> Core["Core validation"]
  Core --> Project["Source projection + ReadGrant"]
  Project --> View["Immutable View"]
  View --> Wake["Wake → LLM"]
  View --> Route["Route / Action → owning Source"]
  Route --> Result["Evidence / Receipt"]
```

A View holds projection fragments, routes, action offers and Host-only ReadGrants. Only its bounded model-facing representation enters Wake; private grant payloads, controller handles and credentials do not. Route/action schemas accompany the offers. Evidence records provenance and consistency; it is not a new persistent memory store.

Strategy output is only a proposal. Core validates instance identity, manifest capabilities, allowed routes/actions and budgets. The Host checks current authority on execution. Source consistency is explicit: `exact-snapshot` for a captured document/runtime snapshot, or `namespace-pinned-live-read` for a Provider whose namespace can be pinned but remote contents remain live. The latter never promises historical database snapshots.

```mermaid
sequenceDiagram
  participant DSH
  participant Host
  participant Core
  participant Source
  participant LLM
  DSH->>Host: turn begins (scope, scenario)
  Host->>Core: acquire Serving generation; compose
  Core->>Source: facts; project after Strategy selection
  Source-->>Core: fragments + opaque ReadGrant
  Core-->>Host: immutable View
  Host->>LLM: bounded Wake + routes/actions
  LLM->>Host: selected route/action + input
  Host->>Core: scope, authority and budget checks
  Core->>Source: query / mutate
  Source-->>LLM: bounded Evidence / committed Receipt via Host
  DSH->>Host: turn ends
  Host->>Core: release lease; drain retired generation
```

## Lifecycle and failures

Candidate composition is validated before publication. A rejected additional candidate does not silently replace the Serving generation. Explicit removal of a required contribution retires that generation and prevents new turns from acquiring it. Existing turns and in-flight operations retain leases until they finish; then the old Source runtime and private resources drain.

Each turn pins one immutable View. Writes yield receipts; later turns see new revisions. Concurrent root/child work cannot substitute another turn's grant. A Source/Provider failure remains scoped and observable; partial, failed, cancelled and committed results are not conflated. Disabling participation does not delete data.

## WebUI and management

Each Source owns its optional `./client` DSH module, pages, management operations and tests. It registers through the public Source-page SDK into the workspace's `mnemon.source.page` Slot. DSH still owns Client lifecycle and React rendering.

The Host supplies a scoped management client and sanitized instance metadata, not raw RPC/Host Context or an LLM grant. Reads and confirmed revision-fenced mutations address one Source. Default workflow assistance (such as Document-to-Space archival) lives in Host coordination and uses those same public operations.

Sidebar uses the DSH `shell.overlay` slot so it opens without a conversation; Buildin uses `conversation.view`. They mount mutually exclusively and share the same workspace and Source pages. No separate React root, fallback page registry or cloned business page exists.

## Compatibility and future evolution

The default Starter retains configuration keys, storage selection, persisted formats, named tools and user workflows. This does **not** preserve private controllers, old `kernel/layers/provider-sdk` root exports or historical wrapper packages. The current public entry list is in [Extension development](./extensions.md).

The RSI seam is deliberately small: create a candidate Source/Strategy artifact, test/replay it with fixed facts and requests, review its requested authority, then install/select it normally. Generations support verified replacement and drain; they are not an autonomous code-execution or promotion service. Cordis ownership/isolation is not a security sandbox. High-risk external actions require a separate authority boundary and are not authorized merely by being called “memory”.
