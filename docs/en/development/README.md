# Development and Verification

[简体中文](../../zh-CN/development/README.md) | **English** | [Documentation Center](../README.md)

## Environment and commands

The plugin's Node engine floor is 20. The pinned complete DSH development profile is the stable 0.1.2-rc.1 release and needs Node `^22.19.0 || >=24.0.0`; use Node 24 for development. Root, Source Client tests and the external artifact consumer use that rc.1 cohort. `dsh-invariants` closes its peer graph, while `dsh-client-store` owns the public selector type used by the subagent projection adapter. Public Node entries are also smoke-tested on Node 20 in CI; an explicit source-overlay workflow remains available for the immediately preceding 0.1.2-alpha.5 tag.

The reviewed rc.1 cohort is enumerated with exact versions under `minimumReleaseAgeExclude` because pnpm 11 may encounter the packages while they are inside its release-age quarantine. A composition test requires that list to equal the rc.1 packages in the lockfile and rejects a scope wildcard, so later `@deepseek-ai` publications remain quarantined.

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` checks types, deterministic Root builds, independent plugin builds, the full test suite, a real isolated DSH Headless profile and package exports/contents. Independent plugin checks run as separate type/test phases after building all public artifacts. Do not mix `pnpm -r verify` clean builds with tests reading sibling artifacts; use `pnpm verify` for the whole workspace. `verify:plugins` repeats verification **outside** the workspace against semver-installed tarballs and an external Source/Strategy/Provider/Client consumer. It also installs only the packed Root into real DSH, resolving all sixteen official plugins from a loopback registry without workspace links or manifest rewrites, then separately verifies the three shipped enhancements moving from disabled defaults to simultaneous activation. The external consumer compiles its own Strategy extension against the owning Strategy's packed SDK.

## Repository ownership

```text
src/
  core/       contracts, View compilation, generations, turn leases
  sdk/        installMemory, validation, test fixtures
  host/       DSH lifecycle, settings, tools, RPC, worker coordination
  client/     shared workspace, settings, Source-page SDK
plugins/
  dsh-mnemon-source-runtime/
  dsh-mnemon-source-documents/
  dsh-mnemon-source-memory-spaces/
  dsh-mnemon-strategy-default-three-tier/
  dsh-mnemon-strategy-scoped/         # shipped, disabled selection contribution
  dsh-mnemon-strategy-light-context/  # shipped, disabled projection contribution
  dsh-mnemon-strategy-auto-capture/   # shipped, disabled in-turn capture contribution
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

Root owns Core/SDK and the DSH Host/default Starter, not Source storage implementations. Each directory under `plugins/` is a publishable standalone project. The default distribution depends on all sixteen official plugins by public semver; the three enhancement packages are installed by the Starter but their Entries are disabled by default. Source/Strategy peers depend on Core's public SDK, Strategy extensions on their owner's public SDK, and Providers on the Memory Spaces SDK. Peer/development relationships can produce a package-manager cycle warning; production import boundaries are independently checked.

No private workspace packages, forwarding controller modules, business bindings or compatibility directory remain. Compatibility means retained user configuration, data and workflows, not retention of historical internal symbols.

Build Root before plugin clients that need its public browser artifact:

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm --filter dsh-mnemon-source-runtime verify
```

A plugin can be copied to a new repository and use its own `pnpm install && pnpm verify` once its declared peer versions are available. During unreleased development, use packed artifacts and the local-registry verification harness; do not substitute repository source paths.

## Test ownership and coverage

| Boundary | Tests |
|---|---|
| Core/SDK | Immutable Views, budgets, Strategy validation, concurrent turns, grants, leases, generation replacement, cleanup and performance |
| Strategy extension | Independent slots, combination/order, unload, conflict, read-only scope, shared quotas and actual Host activation |
| Source | Its controller/storage, revisions, snapshots, JSON operations, own Client clicks and instance isolation |
| Provider | Driver behavior, credentials, capability truth and fault responses |
| Memory Spaces | Provider child lifecycle, cross-provider conformance, merge/routing/quality and Native process serialization |
| Host | Default composition, settings/data scope, tools, supervised workflows, RPC authority, receipts and UX |
| Artifact | Every public entry, standalone install/build/test, external composition and browser artifacts |

Remote Provider suites use controlled HTTP responses; Native process suites use controlled command runners plus an optional Windows binary smoke. A separate opt-in test uses an official checksum-verified Native binary to create a disposable space, write through a View, recall and forget:

```sh
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run tests/native-integration.spec.ts
```

The test never discovers a personal data root or installs a binary. These checks do not certify every live external service or every account configuration. Provider Lab is an explicit separate integration environment.

The performance regression composes 100 three-Source Views under wall/CPU budgets. Deterministic builds compare all generated hashes. Neither check promises production network latency or LLM quality.

Both the default and three-extension profiles run that performance fence. The
[2026-09-01 Strategy contribution verification](../../pr-assets/strategy-extensions-20260901/README.md)
records coexistence, independent artifacts, real Headless activation and limits.

## Real WebUI

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

The fixture prints a temporary workspace and loopback URL. It isolates `DSH_HOME`, `MNEMON_DATA_DIR`, browser workspace and model endpoint. Select **Mnemon E2E** for a conversation; this test-owned preset omits Shell requirements while retaining Host memory tools. The model returns a fixed answer, so this fixture checks UI and transport, not real-model distillation quality. Stop with Ctrl-C to remove its synthetic data.

Check Sidebar without a session, all primary/secondary tabs, Runtime add/edit/remove and branch clear, Documents create/search/read, Provider settings/discovery, activation, error states, dialog cancellation, Save-to-memory, layout switching, locale and restoration of chat interaction. Use a disposable real Provider or controlled fixture for write/read/forget; never test against personal memory.

Also switch `displayMode` live: Sidebar and Builtin must never mount together. Both use the same Source pages; Builtin follows its owning session for global/workspace/custom reads, writes and tasks, hides scope controls, and clears stale data and editors when the session changes. Check legacy `buildin` normalization and the collapsed icon under the native Sidebar skin as well as supported layout plugins.

The [2026-09-04 main-rebase verification](../../pr-assets/main-rebase-20260904/README.md) records the exact v0.4.7/DSH rc.1 revisions, full registry and source-overlay suites, independent artifacts, plugin composition persistence and real shared-placement checks, including their limits.

The [2026-08-30 npm regression record](../../pr-assets/npm-sidebar-cli/README.md#english) preserves the old Taskboard/SSH and CLI investigation. Its removed legacy harness is not a current checkout command; use `pnpm e2e:serve` for current WebUI work.

The previous DSH 0.1.1-rc.2 line does not fully unload every Client module on bundle changes. Refresh after Client package/locale registration changes when exercising that rollback target; ordinary Mnemon settings still apply live. Separate upstream profile/transport warnings from Mnemon failures rather than hiding the console.

## Manual DSH 0.1.2-alpha.5 source compatibility

To run the optional source-only `dsh-v0.1.2-alpha.5` compatibility check with a built Harness checkout:

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness pnpm dsh:link-source
pnpm_config_verify_deps_before_run=false pnpm verify
pnpm dsh:restore-registry
```

Build Harness with its own `pnpm install --frozen-lockfile && pnpm build:lib` first. Linking changes generated `node_modules` only, not committed dependency versions. It overlays the Starter's complete DSH graph, including Store, Invariants and the additional Layout dependency, plus every installed plugin workspace's Cordis identity; every original pnpm link is recorded and restored. Plugin Client test dependencies remain workspace-local on rc.1 while the built Starter exercises alpha.5 Client APIs. Disable pnpm's pre-run dependency verification for this invocation so nested scripts do not restore the registry links. This overlay is an explicit maintainer compatibility check rather than part of the minimal per-PR CI graph. The [isolated rc.1/rc.2 WebUI evidence](../../pr-assets/dsh-rc1-compat/README.md) records the released Host behavior.

## Releasing

Official packages use independent versions; the Starter pins a tested combination. See [Release process](./releasing.md) for changesets, frozen artifacts, Registry checks and recovery.

## Documentation, storage and historical evidence

Keep English/Chinese pages aligned and public examples executable. Code-native Mermaid diagrams describe ownership and flow; real screenshots remain under `docs/assets`. Do not retain dead directory stubs or historical wrapper files.

Retain persisted formats and existing config keys unless an explicit migration is designed and tested. Verify locking, atomic rename, revisions, corrupt inputs and copied-root upgrade/rollback before changing storage.

The v0.3 release benchmark is a frozen historical result, not a test of this architecture. Its obsolete executable harness was removed from the working tree; [release notes](../releases/v0.3.0.md) link to the versioned historical source. Current gates are the scripts above.
