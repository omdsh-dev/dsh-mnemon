# Building Memory Plugins

[简体中文](../zh-CN/extensions.md) | **English** | [Documentation Center](./README.md)

Choose the ownership boundary before writing code. The complete external examples under [plugin-consumer](../../scripts/fixtures/plugin-consumer/) are compiled and tested against packed artifacts outside this repository.

## Pick one responsibility

| Plugin | Owns | Public dependency |
|---|---|---|
| `dsh-mnemon-source-*` | A memory authority, projection, retrieval/mutation and optional pages | Core contracts and extension SDK |
| `dsh-mnemon-strategy-*` | Which Source instances participate, when requested by the Host, with which context mode/budget/routes/actions | Core contracts and extension SDK |
| `dsh-mnemon-provider-*` | A driver under Memory Spaces, with its descriptor, capabilities, connection schema and icons | Memory Spaces Provider SDK |

A Source need not implement a Provider. A Provider need not know View composition. A Strategy receives facts, not Source objects. Cross-package imports target declared public exports only; never reach into another plugin's `src`, controller, registry or build configuration.

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

## Source lifecycle

Define a `MemorySourceDefinition` with `defineMemorySource`. Its manifest declares API version, type id, package name, role, consistency and supported routes/actions. Its factory receives stable instance provenance and immutable configuration.

- `facts(request)`: bounded, non-sensitive availability, revision and capabilities.
- `project(request)`: bounded text plus a Source-owned ReadGrant consistent with the selected revision. Capture concurrent snapshots per request/scope; do not share one mutable “last snapshot”.
- `query`: consume only the supplied View/grant, enforce the Source's scope, return bounded Evidence with provenance.
- `mutate`: perform only a granted action, honor cancellation and distinguish committed/partial/failed results.
- `manage` (optional): authenticated human operations, separate from model grants; validate confirmation and exact revision again.
- `dispose` (optional): release runtime-owned resources after generation leases drain.

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

The example assumes `source.js` exports the definition. [external-source.ts](../../scripts/fixtures/plugin-consumer/src/external-source.ts) implements the complete file-backed example. One plugin installs Source **or** Strategy contributions, not both.

An Entry id identifies an instance; type id identifies its implementation. Never strip Loader include prefixes. Direct `ctx.plugin()` mounts without Loader identity must supply `installMemory(..., { instanceId })`. Paths/credentials remain instance-owned. Do not use a module-global database or service registry.

## Strategy

Use `defineMemoryStrategy` and install with `{ strategies: [definition] }`. Declare deterministic composition, supported roles and maxima. Return a `MemoryViewSpec` selecting exact Source keys, eager/routed projection budgets and Source-local route/action ids. No network, storage or secret access belongs here.

[external-strategy.ts](../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) is a working explicit-selector example. Select its type id with the existing `mnemon.memoryTopology.strategyId` setting in the default Host. More than one applicable Strategy is an error, not “last imported wins”. A profile replaces default Entries explicitly; installing a package alone is not authority to replace them.

## Provider child and Client page

Provider authors use `defineMemorySpaceProvider` and `createMemorySpaceProviderFixture` from Memory Spaces' public SDK/testing entries. [external-provider.ts](../../scripts/fixtures/plugin-consumer/src/external-provider.ts) is tested in two independent parent Sources with identical child ids.

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
    // Assert projection, exact grants, provenance and allowed actions here.
  } finally { turn.release() }
} finally { await runner.dispose() }
```

Use unique temporary paths in real tests. Release turns before disposing the runner. This is a test harness over real Cordis/Core, not another production Loader.

Test at least: valid composition; missing/ambiguous dependencies; two instances; schema/capability/authority denial; concurrent snapshots; stale revisions; cancellation and partial failure; unload/drain/reload; persistence; management and actual page clicks. Providers additionally test credentials, truthful capabilities, malformed upstream data, timeouts and conformance inside their parent Source.

Run each plugin's `pnpm verify`. At repository level, `pnpm verify:plugins` packs all 14 artifacts, installs every plugin outside the workspace through ordinary semver manifests, then type-checks/tests/builds each and compiles the external consumer. No source aliases, manifest overrides or workspace links are permitted in that gate.

For RSI, keep candidate inputs/artifacts reproducible, compare against a known composition, and promote only through an explicit installation/selection decision. Passing a Strategy replay does not sandbox arbitrary JavaScript or grant permission to trade, send messages or delete external data.
