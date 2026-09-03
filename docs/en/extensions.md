# Building Memory Plugins

[简体中文](../zh-CN/extensions.md) | **English** | [Documentation Center](./README.md)

Choose the ownership boundary before writing code. The complete external examples under [plugin-consumer](../../scripts/fixtures/plugin-consumer/) are compiled and tested against packed artifacts outside this repository.

## Distinguish contribution responsibilities

| Plugin | Owns | Public dependency |
|---|---|---|
| `dsh-mnemon-source-*` | A memory authority, projection, retrieval/mutation and optional pages | Core contracts and extension SDK |
| `dsh-mnemon-strategy-*` | A complete View Strategy, or an additive contribution supported by its target Strategy | Core contracts and extension SDK; the target Strategy's extension SDK |
| `dsh-mnemon-provider-*` | A driver under Memory Spaces, with its descriptor, capabilities, connection schema and icons | Memory Spaces Provider SDK |

A Source need not implement a Provider. A Provider need not know View composition. A Strategy receives facts, not Source objects. Cross-package imports target declared public exports only; never reach into another plugin's `src`, controller, registry or build configuration.

| Entry | Responsibility |
|---|---|
| `dsh-mnemon` | DSH Host and default Starter |
| `dsh-mnemon/core` | Cordis plugin installing the Source-neutral service; no engine exports or Host/UI |
| `dsh-mnemon/contracts` | Source/Strategy callback contracts and JSON-safe manifests, facts, ViewSpec, View, Evidence and Receipt |
| `dsh-mnemon/extension-sdk` | Source/Strategy definitions, lifecycle installation and validators |
| `dsh-mnemon/testing` | Scoped composition, route/action and management testing; JSON diagnostics; built Client artifact loader |
| `dsh-mnemon/client` | DSH workspace and Source-page SDK |
| `dsh-mnemon-source-memory-spaces/provider-sdk` | Memory Spaces' own Provider child-module contract |
| `dsh-mnemon-source-memory-spaces/testing` | Private-child module fixture and driver authority/connection fixture |

## A contribution service, not an engine

Following the DSH service/Slot pattern, the public extension point is a small contribution contract. `Context.mnemonMemory` is typed as `MnemonMemoryService` and its actual, frozen object exposes only `installContributions`. Authors call `installMemory(ctx, contribution, options?)`: it resolves the calling Entry identity and binds registration cleanup to that Fiber. Do not introduce a parallel registration API.

The engine, installed records, registry, generations and leases stay internal. Neither `extension-sdk`, `contracts` nor the Core plugin exports them. `MemorySourceRuntime` is intentionally public: it describes the callbacks **your Source implements**, not an engine handle. Definitions/factories are Host-side executable contracts; metadata, operation inputs and results are JSON-safe. This service boundary is not a sandbox for arbitrary JavaScript.

## Source lifecycle

Define a `MemorySourceDefinition` with `defineMemorySource`. Its manifest declares API version, type id, package name, role, consistency and supported routes/actions. Its factory receives stable instance provenance and immutable configuration.

- `facts(request)`: bounded, non-sensitive availability, revision and capabilities.
- `project(request)`: bounded text plus a Source-owned ReadGrant consistent with the selected revision. Capture concurrent snapshots per request/scope; do not share one mutable “last snapshot”.
- `query`: receive only a `{ id, scope }` View identity and this instance's own `grant`, enforce the Source's scope, and return bounded Evidence with provenance.
- `mutate`: perform only an authorized action, honor cancellation and distinguish committed/partial/failed results. It receives the same narrow View identity and an optional instance-local `grant`; a read grant is not write authorization.
- `manage` (optional): authenticated human operations, separate from model grants; validate confirmation and exact revision again.
- `dispose` (optional): release runtime-owned resources after generation leases drain.

The complete `ComposableMemoryView` stays in the Host and composition tests, never in Source callbacks. Do not inspect other instances' projections or grants through `request.view`; writes needing their own pinned read scope use `request.grant` directly.

`facts(request, signal)` and `project(request, signal)` receive cancellation separately from the JSON input. Forward it to network reads and never write data in these callbacks. Core reads independent Sources concurrently with a default 10-second deadline per read. The DSH Host uses its existing `timeoutMs`; independent tests can set `MemoryCompositionRunner({ sourceTimeoutMs })`. Timeouts and remote failures produce sanitized `view.diagnostics`; malformed protocols still reject the View. Cancelling a turn is never downgraded to an optional Source outage. Deadlines cannot interrupt synchronous code blocking the event loop: this is not a malicious-plugin sandbox.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory } from 'dsh-mnemon/extension-sdk'
import { notesSource } from './source.js'

export const name = 'dsh-mnemon-source-notes'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Notes', 'zh-CN': '笔记' },
  description: { en: 'Durable personal notes.', 'zh-CN': '长期个人笔记。' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.durable-evidence' }],
})
export function apply(ctx: Context): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [notesSource] })
}
```

The example assumes `source.js` exports the definition. [external-source.ts](../../scripts/fixtures/plugin-consumer/src/external-source.ts) implements the complete file-backed example. Source and Strategy are roles, not mandatory package/repository boundaries. One package can call `installMemory(ctx, { sources: [source], strategies: [strategy] })`: both contributions install and unload together under the same Fiber, retaining distinct instance keys. Split packages only for independent reuse or replacement. Strategy selection remains explicit; bundling one does not override the user's selected Strategy.

Every composable plugin should export one JSON-safe `memoryPlugin` descriptor and pass the same object to `installMemory`. `roles` describe contributions; they do not create separate plugin classes. `provides` and `requires` form the activation graph. Mark a provided capability `exclusive: true` only when two providers cannot participate together. Declare only hard requirements: a plugin that can truthfully degrade or no-op must not force an unrelated dependency. Core validates the active graph before running Source factories, and remains the only component that compiles the graph into one View. Plugins without this prerelease descriptor keep their existing composition behavior, but the Host can infer only limited identity and relationship information.

An Entry id identifies an instance; type id identifies its implementation. Never strip Loader include prefixes. Direct `ctx.plugin()` mounts without Loader identity must supply `installMemory(..., { instanceId })`. Paths/credentials remain instance-owned. Do not use a module-global database or service registry.

## Complete Strategies and additive contributions

Use `defineMemoryStrategy` and install with `{ strategies: [definition] }`. Declare deterministic composition, supported roles and maxima. Pure `compose` returns a `MemoryViewSpec` selecting exact Source keys, eager/routed projection budgets and Source-local route/action ids. It performs no network, storage or secret access.

A Strategy may declare exclusive `extensionSlots`. A small plugin uses `defineMemoryStrategyExtension`, installed through `{ strategyExtensions: [definition] }`. Enabling contributes bounded JSON to one target slot; disabling removes only that contribution. Different slots compose into one View. Duplicate slots for the same target reject registration instead of using installation order. Contributions targeting an unselected Strategy are observable but do not execute. Unsupported slots reject the candidate generation and preserve existing Serving; invalid dynamic results reject the affected turn rather than silently ignoring the plugin.

Core validates identities, JSON and the 64,000-character bound, deterministic replay, lifecycle, and the final View's existing budgets and permissions. It does not interpret business slot names. Callbacks see only the request and permission-filtered Source facts, never Source handles, grants, or write callbacks. The owning Strategy's public SDK defines slot semantics.

### Optional configuration descriptor

A dedicated Strategy Entry can additionally export `memoryStrategyConfiguration`, created with `defineMemoryStrategyConfiguration` from the Core SDK. It declares public fields (`number`, `text`, `textarea`, `string-list`, `source-list`) and a **pure `create(config)` factory shared with `apply()`**. The factory returns exactly one Strategy or extension contribution together with the same `memoryPlugin` descriptor; it performs no I/O, credential access or Fiber mounting. This optional convention is for the Host and future tooling; it does not define plugin identity or activation relations.

v0.5 does not expose generic memory-plugin discovery, a dependency graph, or an installation dialog to ordinary users. This release candidate first stabilizes the Source/Strategy contract and the single-View compiler boundary without adding an unsettled plugin mental model to the v0.4 workflow. The three enhancements shipped with the Starter appear only as behavior switches under **Settings → Memory System → Memory enhancements**; package names, Entries, dependencies, and conflicts stay below that surface.

Third-party packages continue to use DSH's native Profile/Loader workflow. Install an exact package with `dsh plugin --profile <Profile> add <name>@<version> --save-exact`, verify its `peerDependencies` and `dsh.bundle.patch`, then activate it explicitly in Profile composition after restarting. Downloading an npm package is not activation, and Mnemon does not hot-load it into the current process. External standalone repositories following this guide are welcome; generic graphical management may be revisited after the contracts and community cases settle, but is not a v0.5 promise.

### Default three-tier extensions

The default Strategy exposes `defineThreeTierExtension` at `dsh-mnemon-strategy-default-three-tier/extension-sdk`:

| Optional plugin | Slot | Contribution |
|---|---|---|
| `dsh-mnemon-strategy-scoped` | `selection` | Source key order and writable subset; does not create Sources or change physical storage scope |
| `dsh-mnemon-strategy-light-context` | `projection` | One shared projection cap; not incremental injection or summarization |
| `dsh-mnemon-strategy-auto-capture` | `capture` | Current-turn instructions, targets and explicit recording Action ids; no background Agent or direct writes |

The Starter installs all three packages and registers their DSH Entries disabled. The three v0.5 switches are therefore always available, while the default composition, allocation and guidance preserve v0.4 behavior. Enabling one contributes to `default-three-tier` without changing `strategyId`; disabling it removes only that contribution and never deletes Source data. Runtime currently has no expansion route: an aggressively small resident cap can hide hot context and needs workload-level evaluation.

Source keys in `scoped` must retain any Loader include prefix. Omitting its configuration deterministically selects existing instances by role/key and creates no storage. The built-in UI intentionally exposes only the stable switches; advanced fields remain Profile configuration.

`scoped.sourceKeys` expresses priority and `writableSourceKeys` narrows the writable subset. Automatic capacity maintenance also checks the current View's write scope; a denied operation preserves the original data and fails instead of migrating around the restriction. Explicit operator management remains separately authorized.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export const inject = ['mnemonMemory']
export function apply(ctx: Context): void {
  installMemory(ctx, { strategyExtensions: [defineThreeTierExtension({
    typeId: 'my-light-context', packageName: 'dsh-mnemon-strategy-my-light-context',
    slot: 'projection', contribute: () => ({ maxProjectionCharacters: 4096 }),
  })] })
}
```

In-turn writes still use Host tools, authorization and Source receipts. A capture contributor must name actual recording Actions, not infer them from generic write capability. Retrieval limits remain shared across the executing turn; Source-qualified replay and Related admission prevent cross-instance aliasing. If removal cannot produce a replacement generation, new turns fail closed rather than revive the disabled policy. Existing pinned turns retain their leases.

Optional `createTurn(view)` supplies an execution-local `query(request, read)` policy. The only supplied I/O is `read(input, narrowerLimits?)`, bound to the selected Route and its private grant. Core still validates inputs, ceilings, dispatched calls and lifetime. A policy may admit/replay results and supply a compact `Evidence.output` for the model; it does not obtain a Source object, write continuation or authority. Separate executions get separate policy state even when they inherit the same immutable View. Without this hook, reads go directly to the Source through the same Core fences.

The default three-tier plugin uses this hook for the old Documents slot, two-query Recall envelope, deduplication and Related admission. Named tools and generic View routes share that policy. Source implementations retain raw search, storage and maintenance; explicit DSH-assisted writing/archiving remains a Host workflow, not a generic Core background job.

Selected Sources are required by default. Set `required: false` to explicitly permit omission when that instance is unavailable or its projection fails. Required failures reject the turn without silently switching strategies. The default three-tier Strategy selects available Sources as optional so an external read failure does not remove healthy layers. A Strategy must explicitly reject a missing required instance rather than return an empty selection.

[external-strategy.ts](../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) is a working explicit-selector example. Select its type id with the existing `mnemon.memoryTopology.strategyId` setting in the default Host. More than one applicable Strategy is an error, not “last imported wins”. A profile replaces default Entries explicitly; installing a package alone is not authority to replace them.

Optional `ViewSpec.guidance` carries the Strategy's trusted `system`, `routing` and read/write reminders separately from quoted Source data. It is validated and pinned into the View digest. The Host supplies generic routing guidance when none is provided and renders named tool availability without repeating schemas already in DSH's tool catalog; external/unbound operations keep their exact ids and schemas. Existing product tools and explicit management remain available; tool presence does not mean that a Source participates in this turn's View. Automatic three-tier background review runs only with `default-three-tier`, never implicitly under a custom Strategy.

## Open operations, bounded execution

A Source owns its operation names, input schemas, storage, indexes and maintenance. There is no mandatory five-action taxonomy, summary tree, representation vocabulary or multidimensional budget protocol. A Strategy selects public operations it understands, by id, role and/or capability. Core derives `MemoryAvailableSource.routes/actions` from manifests, live facts and Host permissions; plugin authors do not duplicate descriptors in facts.

Core bounds projection characters, evidence characters/items and dispatched calls. These are payload ceilings, not complete LLM-prompt token estimates. Sources receive effective bounds and own excerpts and structured formatting; Core omits oversized evidence rather than manufacturing a summary or splitting JSON. Failed dispatched reads consume a call. There is no automatic retry.

Every mutation receipt declares `completion`: `accepted`, `candidate`, `committed`, `partial`, `failed`, or `unknown`. Only a confirmed full commit can include `committedAt`; Core never invents that timestamp. `createMemoryMutationReceipt(..., completion)` defaults to `unknown`; pass `'committed'` only after the requested durable effect completes. Cancellation or a transport exception does not prove that no write occurred, and a cross-Source workflow is not atomic. Generic and named product tools preserve this distinction for the model.

## Provider child and Client page

Provider authors use `defineMemorySpaceProvider` from Memory Spaces' SDK. A module receives only its bound `host.install(ctx, definition)` capability; the private parent Host, Snapshot and Registry are not SDK exports. `installMemorySpaces` mounts explicit children and returns `Promise<void>`, not a parent handle. [external-provider.ts](../../scripts/fixtures/plugin-consumer/src/external-provider.ts) is tested in two independent parent Sources with identical child ids.

Use `mountMemorySpaceProvider` from the Source's `/testing` entry to test real child registration, aliased adapter creation and cleanup. It returns frozen descriptor/manifest metadata, `registered`, `createAdapter` and `dispose`. `createMemorySpaceProviderFixture` separately supplies validated connection data and a scoped driver authority. The [published API test](../../scripts/fixtures/plugin-consumer/tests/public-api.spec.ts) combines both without private imports.

```yaml
- id: work-spaces
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/work-memory
    providers:
      - use: dsh-mnemon-provider-holographic
        instanceId: local-facts
```

The Source itself authors the Provider Fibers. Core supplies no Provider factory registry and no second Context service. Each module owns truthful capabilities: a query-only backend must not fabricate browse results or graph edges.

An optional `./client` entry calls `installMemorySourceUI` from `dsh-mnemon/client`; DSH loads it as an ordinary Client plugin. It receives `MemorySourcePageProps` with selected instance, locale, writability and scoped `management.read/mutate`. Use `MemorySourcePageFrame` for shared locale/appearance. No Host Context, driver, token, LLM grant or transport is passed to React. Missing pages use generic management; duplicate page ownership and rendering failure have local diagnostics.

## Independent repository checklist

A plugin directory owns `package.json`, exports, `src/`, `tests/`, TypeScript/build/test configuration and README. Declare compatible public peers and development dependencies. Publish built Host/Client artifacts and declarations; never depend on sibling paths, workspace source aliases, root test helpers or implicit hoisting.

The default Starter alone mounts defaults. Source/Strategy packages do not ship self-activating default patches. A user's profile, bundle or explicit parent composition controls activation and replacement.

```ts
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as notes from './index.js'
import * as focus from './strategy.js'

const runner = new MemoryCompositionRunner()
try {
  await runner.mount(notes, { instanceId: 'work', config: { path: '/tmp/test-notes.txt' } })
  await runner.mount(focus, {
    instanceId: 'focus',
    config: { sourceKeys: ['source:work'], mode: 'eager' },
  })
  const turn = await runner.beginTurn()
  try {
    const route = turn.view.routes.find(route => route.sourceRouteId === 'read')!
    const evidence = await turn.executeRoute(route.id, {})
    // Assert projection, evidence and provenance. For writes, use
    // turn.executeAction(offer.id, input, authorize), with explicit test authority.
  } finally { turn.release() }
} finally { await runner.dispose() }
```

Use unique temporary paths in real tests. Release turns before disposing the runner. `runner.inspect()` returns JSON-only evaluation/generation diagnostics; `managementClient(sourceKey)` supplies scoped human operations. No turn exposes a lease, and no runner exposes the engine. Unmount/remount plugins to test replacement instead of editing an internal registry. Disposal also releases retained turns; in-flight operations hold their own leases until completion. This is a test harness over real Cordis/Core, not another production Loader.

Test at least: valid composition; missing/ambiguous dependencies; two instances; schema/capability/authority denial; concurrent snapshots; stale revisions; cancellation and partial failure; unload/drain/reload; persistence; management and actual page clicks. Providers additionally test credentials, truthful capabilities, malformed upstream data, timeouts and conformance inside their parent Source.

Run each plugin's `pnpm verify`. At repository level, `pnpm verify:plugins` packs all 17 artifacts, installs every plugin outside the workspace through ordinary semver manifests, then type-checks/tests/builds each and compiles the external consumer. No source aliases, manifest overrides or workspace links are permitted in that gate.

For RSI, keep candidate inputs/artifacts reproducible, compare against a known composition, and promote only through an explicit installation/selection decision. Passing a Strategy replay does not sandbox arbitrary JavaScript or grant permission to trade, send messages or delete external data.
