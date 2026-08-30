# Building Memory Plugins

[简体中文](../zh-CN/extensions.md) | **English** | [Documentation Center](./README.md)

Choose the ownership boundary before writing code. The complete external examples under [plugin-consumer](../../scripts/fixtures/plugin-consumer/) are compiled and tested against packed artifacts outside this repository.

## Distinguish contribution responsibilities

| Plugin | Owns | Public dependency |
|---|---|---|
| `dsh-mnemon-source-*` | A memory authority, projection, retrieval/mutation and optional pages | Core contracts and extension SDK |
| `dsh-mnemon-strategy-*` | Which Source instances participate, when requested by the Host, with which context mode/budget/routes/actions | Core contracts and extension SDK |
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
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { notesSource } from './source.js'

export const name = 'dsh-mnemon-source-notes'
export const inject = ['mnemonMemory']
export function apply(ctx: Context): void {
  installMemory(ctx, { sources: [notesSource] })
}
```

The example assumes `source.js` exports the definition. [external-source.ts](../../scripts/fixtures/plugin-consumer/src/external-source.ts) implements the complete file-backed example. Source and Strategy are roles, not mandatory package/repository boundaries. One OptMem-style package can call `installMemory(ctx, { sources: [source], strategies: [strategy] })`: both contributions install and unload together under the same Fiber, retaining distinct instance keys. Split packages only for independent reuse or replacement. Strategy selection remains explicit; bundling one does not override the user's selected Strategy.

An Entry id identifies an instance; type id identifies its implementation. Never strip Loader include prefixes. Direct `ctx.plugin()` mounts without Loader identity must supply `installMemory(..., { instanceId })`. Paths/credentials remain instance-owned. Do not use a module-global database or service registry.

## Strategy

Use `defineMemoryStrategy` and install with `{ strategies: [definition] }`. Declare deterministic composition, supported roles and maxima. Return a `MemoryViewSpec` selecting exact Source keys, eager/routed projection budgets and Source-local route/action ids. No network, storage or secret access belongs here.

Selected Sources are required by default. Set `required: false` to explicitly permit omission when that instance is unavailable or its projection fails. Required failures reject the turn without silently switching strategies. The default three-tier Strategy selects available Sources as optional so an external read failure does not remove healthy layers. A Strategy must explicitly reject a missing required instance rather than return an empty selection.

[external-strategy.ts](../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) is a working explicit-selector example. Select its type id with the existing `mnemon.memoryTopology.strategyId` setting in the default Host. More than one applicable Strategy is an error, not “last imported wins”. A profile replaces default Entries explicitly; installing a package alone is not authority to replace them.

Host guidance describes the current View's generic route/action protocol, not the default three-tier Sources' business rules. Existing product tools and explicit management remain available; tool presence does not mean that a Source participates in this turn's View. Automatic three-tier background review runs only with `default-three-tier`, never implicitly under a custom Strategy.

## Compose by properties, not operation names

`manifest.projection` and each route/action's `semantics` describe an operation. Native ids and algorithms remain Source-owned; these properties do not add Runtime methods or a primitive registry:

```ts
semantics: {
  actions: ['read'],
  targets: ['records'],
  effects: [],
  representations: ['raw', 'excerpt'],
  overflow: 'truncate',
  retry: 'safe',
}
```

Actions are `record`, `wake`, `read`, `compress`, and `forget`. Targets distinguish records, representations, relations, catalogs, visibility, usage, and candidates. A multi-mode operation declares the **union of possible effects**, not a sequence for Core to execute. Split it into separate offered operations if callers must authorize the modes independently. An invalidated summary is not a deleted record; recording an RSI candidate is not activating a policy.

These five actions are descriptive vocabulary, not five required interfaces or a universal memory lifecycle. A read-only Source needs no mutation/compaction/tree implementation. Existing `capabilities` are Host permission categories; semantic `actions` support composition across differently named operations (e.g. `search` and `related` can both describe `read`). Core derives available descriptors; authors do not duplicate them in Facts. Private watchers, indexes, summarizers and Provider upkeep may run in the plugin's own Cordis Fibers using Host capabilities. Pure `compose` and the View operation envelope do not establish a universal maintenance scheduler. Put a field in the public protocol only when it serves cross-plugin selection, execution constraints or interpretation of View results.

Sources still return only availability/revision/capability ids in `facts`. Core constructs `MemoryAvailableSource` for `compose`: its `projection`, `routes`, and `actions` come from the manifest, filtered by live availability and Host permissions. For example, a Strategy can select `source.routes.filter(route => route.semantics?.actions.includes('read') && route.semantics.effects.length === 0)` without knowing ids like `search` or `recall`. Missing semantics mean **unspecified**, not inferred support.

Selections retain `routeIds`/`actionIds`. Optional `routeOptions[id]`, `actionOptions[id]`, and projection options select a declared `representation` and `budgets`. Every budget specifies `resource` (`output`, `input`, `cost`), `unit`, `measurement` (`exact`, `estimated`), and `amount: 'auto' | { max, min? }`. Token metrics additionally name a tokenizer/estimator `basis`. `min` is a preference: a tighter ceiling may make it unattainable; Core never pads output. `auto` inherits a finite Host ceiling or a Source-declared default/maximum, never infinity. Unsupported units/bases/guarantees reject composition rather than silently using a token heuristic.

Core measures returned text (UTF-16 characters or declared UTF-8 bytes), result counts, and dispatched route calls. Character ceilings bound **payload text**, not the whole serialized prompt including tool schemas/metadata. Source-owned token, input-work and cost limits are passed as resolved budgets and require `usage` reports; plugins must enforce them during execution. This is not a sandbox or a proof of upstream cost. Source storage capacity and algorithms remain private. Failed dispatched reads consume a call; Core does not automatically retry, even for operations declaring retry safety.

Described operations return `result` on every projection fragment/evidence item: `representation`, `coverage`, optional omissions/state, and optional expansion. Core only clips text when `overflow: 'truncate'` explicitly permits excerpts; it marks them partial and preserves an inferred/summary origin. `omit` drops whole items. `summarize` and `page` require Source implementations; Core cannot synthesize either. It returns unavailable instead of fabricating a required raw/structured result. A citation is not an expansion: `{ routeId, input }` is bound to the same Source and an actually offered, schema-valid route; an unoffered expansion becomes unavailable. Scores carry a Source-local interpretation, not automatic cross-Source calibration.

`facts`/`project` never perform persistent usage writes. A query may explicitly declare retrieval bookkeeping (`{ target: 'usage', mode: 'write', stage: 'retrieved' }`), which additionally requires write capability. Injection/useful-feedback accounting must happen in a separate explicitly invoked operation at the real Host event, not during speculative composition. Delete/invalidate effects additionally require `forget`. These permissions only narrow existing capability grants; an ActionOffer still needs call-time authorization.

Every mutation receipt declares `completion`: `accepted`, `candidate`, `committed`, `partial`, `failed`, or `unknown`. Only a confirmed full commit can include `committedAt`; Core never invents that timestamp. `createMemoryMutationReceipt(..., completion)` defaults to `unknown`; pass `'committed'` only after the requested durable effect completes. Cancellation or a transport exception does not prove that no write occurred, and a cross-Source workflow is not atomic. Generic and named product tools preserve this distinction for the model.

The public-runner [semantic conformance tests](../../tests/composable-semantics.spec.ts) exercise renamed operations, independent instances, budgets, retrieval bookkeeping, unavailable expansion, inference/excerpt fidelity, and uncommitted RSI candidates.

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

Run each plugin's `pnpm verify`. At repository level, `pnpm verify:plugins` packs all 14 artifacts, installs every plugin outside the workspace through ordinary semver manifests, then type-checks/tests/builds each and compiles the external consumer. No source aliases, manifest overrides or workspace links are permitted in that gate.

For RSI, keep candidate inputs/artifacts reproducible, compare against a known composition, and promote only through an explicit installation/selection decision. Passing a Strategy replay does not sandbox arbitrary JavaScript or grant permission to trade, send messages or delete external data.
