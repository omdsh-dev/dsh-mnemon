# Development and Verification

[简体中文](../zh-CN/development.md) | **English** | [Documentation Center](./README.md)

## Environment and commands

The plugin's Node engine floor is 20. The pinned complete DSH development profile is 0.1.1-rc.2 and needs Node `^22.19.0 || >=24.0.0`; use Node 24 for development. Public Node entries are also smoke-tested on Node 20 in CI.

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` checks types, deterministic Root builds, independent plugin builds, the full test suite, a real isolated DSH Headless profile and package exports/contents. Independent plugin checks run as separate type/test phases after building all public artifacts. Do not mix `pnpm -r verify` clean builds with tests reading sibling artifacts; use `pnpm verify` for the whole workspace. `verify:plugins` repeats verification **outside** the workspace against semver-installed tarballs and an external Source/Strategy/Provider/Client consumer. It also installs only the packed Root into real DSH, resolving all default plugins from a loopback registry without workspace links or manifest rewrites.

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
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

Root owns Core/SDK and the DSH Host/default Starter, not Source storage implementations. Each directory under `plugins/` is a publishable standalone project. The default distribution depends on them by public semver; Source/Strategy peers depend on Core's public SDK, and Providers depend on the Memory Spaces SDK. Peer/development relationships can produce a package-manager cycle warning; production import boundaries are independently checked.

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

## Real WebUI

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

The fixture prints a temporary workspace and loopback URL. It isolates `DSH_HOME`, `MNEMON_DATA_DIR`, browser workspace and model endpoint. Select **Mnemon E2E** for a conversation; this test-owned preset omits Shell requirements while retaining Host memory tools. The model returns a fixed answer, so this fixture checks UI and transport, not real-model distillation quality. Stop with Ctrl-C to remove its synthetic data.

Check Sidebar without a session, all primary/secondary tabs, Runtime add/edit/remove and branch clear, Documents create/search/read, Provider settings/discovery, activation, error states, dialog cancellation, Save-to-memory, layout switching, locale and restoration of chat interaction. Use a disposable real Provider or controlled fixture for write/read/forget; never test against personal memory.

DSH rc.2 does not fully unload every Client module on bundle changes. Refresh after Client package/locale registration changes; ordinary Mnemon settings still apply live. Separate upstream profile/transport warnings from Mnemon failures rather than hiding the console.

## DSH source verification

CI also builds the source-only `dsh-v0.1.2-alpha.1` tag. To repeat with a built Harness checkout:

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness pnpm dsh:link-source
pnpm verify
pnpm dsh:restore-registry
```

Build Harness with its own `pnpm install --frozen-lockfile && pnpm build:lib` first. Linking changes generated `node_modules` only, not committed dependency versions. The rc.2 and alpha RPC/service contracts have dedicated tests; an alpha CI configuration is not a claim that a current local run used alpha.

## Coordinated beta releases

`pnpm release:check` is read-only. It checks the Root and all thirteen official plugins, exact internal dependency/peer versions, the release tag and `publishConfig.tag`. This coordinated version policy applies to the official distribution, not third-party repositories. Beta dependencies pin the tested prerelease explicitly; `^0.4.0` cannot install a `0.5.0-beta.1` SDK.

`node scripts/release.mjs --pack` packs every built artifact into a printed temporary directory without publishing. The GitHub Release workflow runs `verify` and the external artifact suite, packs everything, then publishes the thirteen plugins before the Starter. Prereleases require GitHub's prerelease flag and an explicit `alpha`, `beta` or `rc` npm tag; stable releases require `latest`. Direct publication also inherits the package's explicit `publishConfig.tag`. Do not publish only the Root.

`--publish` is an explicit registry write and requires `RELEASE_TAG` and `RELEASE_PRERELEASE`. npm publication is not transactional: on any failure the workflow stops and does not publish the remaining packages. Keep the logs/artifacts, inspect which immutable versions were published, then prepare a fresh coordinated version rather than overwriting or unpublishing them. A release is complete only after all packages are present. Development verification never creates a Git tag, GitHub Release or npm publication.

## Documentation, storage and historical evidence

Keep English/Chinese pages aligned and public examples executable. Code-native Mermaid diagrams describe ownership and flow; real screenshots remain under `docs/assets`. Do not retain dead directory stubs or historical wrapper files.

Retain persisted formats and existing config keys unless an explicit migration is designed and tested. Verify locking, atomic rename, revisions, corrupt inputs and copied-root upgrade/rollback before changing storage.

The v0.3 release benchmark is a frozen historical result, not a test of this architecture. Its obsolete executable harness was removed from the working tree; [release notes](./releases/v0.3.0.md) link to the versioned historical source. Current gates are the scripts above.
