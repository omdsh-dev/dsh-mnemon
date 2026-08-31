# Development and Verification

[简体中文](../zh-CN/development.md) | **English** | [Documentation Center](./README.md)

## Environment

The published plugin retains its Node.js 20 engine floor for older compatible DSH hosts. The registry-backed development baseline remains DSH 0.1.1-rc.2, whose complete profiles require Node.js `^22.19.0 || >=24.0.0`. CI also checks the source-only DSH 0.1.2-alpha.1 tag on Node 24 by building Harness from source, linking its build-time packages, and running the complete Mnemon verification chain. The regular matrix runs Linux on Node.js 22.19 and 24 plus Windows on Node.js 24. After the Node 24 build, CI switches to Node 20 and imports every Node-compatible published subpath as a plugin-runtime compatibility smoke.

Install dependencies:

```sh
pnpm install
```

## Session projection compatibility

Mnemon's child-local token-usage projection supports both DSH projection contracts: `schema` / `view` in 0.1.0 and `stateSchema` / `wire` in 0.1.1 and the supported alpha. Both entry points share the same wire schema and view function. The internal state and `stateVersion: 1` remain unchanged, so cached state survives upgrades and rollbacks between these hosts.

```sh
pnpm exec vitest run tests/subagent-token-usage-host.spec.ts tests/subagent-token-usage.spec.ts tests/client-subagent-token-usage.spec.tsx
```

The Host tests execute the published 0.1.0-rc.8 registry and the active registry against real DSH sessions, covering live snapshots, detached replay, checkpoint restoration, cross-version state, and change notifications. The legacy npm alias is a test-only development dependency; it does not replace the active Host. Source verification links the active registry to the alpha alongside the other DSH packages.

## DSH 0.1.2-alpha.1 source verification

The alpha is intentionally not published to npm. Keep the registry dependencies and lockfile on the latest published DSH baseline, then overlay only generated `node_modules` links from a built Harness checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout dsh-v0.1.2-alpha.1
pnpm --dir deepseek-harness install --frozen-lockfile
pnpm --dir deepseek-harness run build:lib

pnpm install --frozen-lockfile
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness pnpm run dsh:link-source
pnpm_config_verify_deps_before_run=false pnpm run verify
```

The link command validates every package name and alpha version, records the existing direct registry links under generated `node_modules`, and only then replaces them. It does not edit `package.json` or `pnpm-lock.yaml`. Disable pnpm 11's automatic pre-run dependency installation for this intentional overlay, as shown above; otherwise it can silently restore registry packages before verification. Run `pnpm_config_verify_deps_before_run=false pnpm run dsh:restore-registry` afterward to restore exactly the recorded links. The compatibility work covers the removed client runtime, controller/renderer-owned client services, extensible locale IDs, the Workspace snapshot change, and the branch-free dual-generation Host RPC registration.

### Compatibility findings

The [upstream alpha release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) covers far more than the plugin seam; the [full comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-alpha.1) includes the Client, Host, SDK, profiles, persistence, UI, and generated references. The Mnemon-relevant findings are:

- `@deepseek-ai/dsh-client-runtime` is removed. Session and Workspace state now belong to API controllers, observable contracts belong to `dsh-client-store`, and `ctx.slots` belongs to the UI renderer.
- Chat-specific slot contracts, including `conversation.chat.turnTail`, moved out of the target-neutral conversation package. Mnemon now types its minimum selector boundary without importing the old owner.
- The Workspace list no longer publishes `recentWorkspaceId`; Mnemon selects the current session's canonical cwd match, then the first available workspace.
- Locale IDs are extensible by third-party language packs, so Mnemon passes unknown active locale IDs through for date formatting while its own dictionary still falls back through DSH locale resolution.
- `HostConnectionRpc.handle()` no longer accepts per-method authority options. Every alpha RPC and stream requires the same launch-token-derived browser session. Mnemon nevertheless retains the rc.2 `remoteAccess` configuration and always passes rc.2's trailing authority object: rc.2 consumes it, while alpha's two-argument JavaScript implementation ignores it. This preserves both security models without version parsing, function-arity inspection, or a capability branch.
- The legacy ApiProxy transport is removed in favor of Remote/gateway APIs. Mnemon's generic Connection channels remain supported; Headless progress moving to stderr does not affect its stdout result assertion.
- DSH adds subagent model configuration and revises token accounting, but the official lineage row still consumes the generic complete-log projection. Mnemon therefore retains its child-local projection wrapper and verifies it against the alpha slot ledger.

Because the alpha is source-only, no nonexistent `0.1.2-alpha.1` registry dependency is committed. The dedicated CI job is the reproducible compatibility authority until DSH publishes a registry build.

## Standard Commands

```sh
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest run
pnpm run build      # declarations + host/client bundles
pnpm run verify     # typecheck + tests + reproducible build + package validation
```

## Directory Structure

```text
packages/
+-- contracts/                 # pure JSON/wire memory contracts
+-- kernel/                    # Catalog, Topology, Plan/Receipt, Guards
+-- layer-runtime/             # default Runtime Layer
+-- layer-documents/           # default Documents Layer
+-- layer-memory-spaces/       # default Memory Spaces Layer
+-- strategy-default-three-tier/ # default compatibility Strategy and topology
+-- strategy-sdk/              # Strategy manifests and replay
+-- provider-sdk/              # Adapter Factory Registry
+-- extension-sdk/             # Host extension lifecycle
src/
+-- index.ts                  # Host composition root
+-- config.ts                 # settings schema
+-- process.ts / runner.ts    # local CLI execution
+-- service.ts                # durable-memory facade
+-- memory-bodies.ts          # Memory Space registry
+-- runtime-memory.ts         # hot-memory authority
+-- documents.ts              # managed Documents
+-- subagent.ts               # bounded workers
+-- lifecycle.ts              # root hooks and child authority ownership
+-- agent-memory-turn.ts      # turn pins and retained child delegation
+-- review-activity.ts        # activity score
+-- tools.ts / commands.ts    # model and human interfaces
+-- rpc.ts / settings.ts      # Web bridges
+-- storage-scope.ts          # storage inventory
+-- shared/contracts.ts       # canonical Host/Client wire contracts
+-- client/                   # React workspace and locales
tests/                        # Vitest suites
scripts/                      # deterministic build and package checks
lib/                          # generated, ignored publish artifacts
docs/zh-CN/                   # Chinese documentation
docs/en/                      # English mirror
cordis.patch.yml              # DSH profile bundle patch
```

## Build Artifacts

```text
tsdown (from src/ and packages/)
  -> lib/index.js             Node ES2024 ESM Host
  -> lib/client.js            DSH browser module wrapper
  -> lib/contracts.js         wire-safe contracts
  -> lib/kernel.js            composable memory kernel
  -> lib/{extension,provider,strategy}-sdk.js
  -> lib/layers/*.js          default Layer entries
  -> lib/strategy-default-three-tier.js

tsc -p tsconfig.types.json
  -> lib/types/src/**/*.d.ts
  -> lib/types/packages/**/*.d.ts

lightningcss plugin
  -> CSS Modules compiled and injected as scoped <style>
```

The Host keeps all package dependencies external. The client keeps React, ReactDOM, the JSX runtime, Cordis, and DSH UI primitives external; only `markdown-to-jsx` is allowed to be bundled from `node_modules`.

`lib/` is a publishing input but is ignored by Git. Never edit it manually. `pnpm run verify:build` builds twice and compares every output hash, so unstable CSS export ordering or other generated churn fails verification.

`packages/contracts` is the pure-JSON source of truth at the composable-memory plugin boundary. It must not depend on Cordis, DSH, React, Node-only data planes, or Provider SDKs. `src/shared/contracts.ts` remains canonical for configuration shapes, RPC channels, settings protocol, and Client-visible DTOs and may reference the pure memory contracts. Files under `src/client/` may import parent modules only through these contracts. Host modules may re-export types for compatibility but must not redefine wire DTOs.

## Workspace and publishing policy

Every internal workspace stays `private` and is not published independently. Versioning, builds, and rollback are atomic at the root `dsh-mnemon` package. Compatibility applies to the `dsh-mnemon/*` subpaths in `package.json#exports`. A new public entry requires matching tsdown entries, declaration includes, package exports, package-content allowlists, publint / attw coverage, and bilingual extension documentation.

Default Layers and Strategies must not depend on the root Host composition. Existing Runtime, Documents, and Memory Spaces controllers remain under `src/` as compatibility data planes assembled by the Host. New extensions register through Catalog and must not add hard-coded frontend enums. Every registration returns a disposer and needs tests for duplicate IDs, live registration, unloading, and stale-Plan rejection.

## Test Layers

The existing Vitest suites cover:

- configuration parsing, CLI discovery, and process serialization;
- Catalog/Topology generations, participation, Strategy escape attempts, Guard changes, Plan/Receipt behavior, and stale Plans;
- Extension Host pre-registration, live registration, unloading, Cordis lifecycle, and Strategy replay;
- Memory Space discovery, activation, routing, and merge;
- recall-payload compatibility and graph parsing;
- Runtime JSON/Markdown consistency, locks, capacity, UTF-8, and revisions;
- Document paths, frontmatter, search, LRU, archiving, and conflicts;
- worker tool isolation, the schema subset, and structured receipts;
- lifecycle cues, scoring, idle debounce, cancellation, and watermark retention;
- asynchronous child View/runtime retention, per-turn budgets, cache isolation, nested delegation, cancellation, collection, and disposal;
- real rc.2 / alpha Connection registration, RPC authority or authentication, read-only behavior, and settings revisions;
- the Web workspace, bilingual copy, and key interactions;
- core activation without Web-only services and Agent-cwd routing for Headless;
- Client/Host source boundaries, deterministic build hashes, package contents, exports, and TypeScript resolution.

These are primarily integration tests using temporary directories, fake runners, and a mock Host. `async-subagent-host.spec.ts` additionally runs the actual DSH Agent loop, scoped events, tool pipeline, continuable subagent manager, and JSONL persistence against a scripted model and fake memory Provider. It verifies delayed Recall after parent completion and a runtime swap, plus cold resume with fresh authority and budgets. Its direct DSH test dependencies remain on the existing published baseline and are included in the alpha source-link overlay. `verify:headless` builds the package, installs it into an isolated real DSH Headless profile, serves a local mock model, and asserts that representative Mnemon tools reach the model request. Automated end-to-end testing of the real DSH + Mnemon WebUI remains separate.

## v0.3 Release Benchmark

`scripts/evaluation/v0.3` provides an isolated mock/real Provider harness, cross-version data compatibility checks, direct retrieval measurement, and a resumable release suite. See the [evaluation harness guide](../../scripts/evaluation/v0.3/README.md) for the full parameters, evidence layout, and safety boundaries. A formal A/B run must pin the baseline and current commits, DSH version, model, scenario configuration, and output directory. Token and wall-time results from a real Provider are observations for that environment, not universal performance guarantees.

```sh
node scripts/evaluation/v0.3/release-suite.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-release

node scripts/evaluation/v0.3/release-suite.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-recall-gates \
  --only recall-gate-natural,recall-gate-fault \
  --versions current

node scripts/evaluation/v0.3/compatibility.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-compatibility.json

node scripts/evaluation/v0.3/retrieval-benchmark.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --repetitions 5 \
  --output /private/tmp/dsh-mnemon-v03-retrieval.json
```

The benchmark tables in the [v0.3.0 release notes](./releases/v0.3.0.md#benchmark-and-behavioral-verification) are the public frozen release record for 2026-08-24. The public [evaluation harness guide](../../scripts/evaluation/v0.3/README.md) documents the scenarios, methodology, safety boundaries, and rerun commands; each run writes machine-readable metrics and run evidence into the caller's chosen output directory. Raw request/session traces containing synthetic conversations and machine-specific paths are intentionally not committed. Public release claims therefore remain self-contained without linking to a private working archive.

## Real WebUI Verification

For the npm panel-navigation and CLI-status regression harness, see [npm Release Web UI Regressions](./testing-npm-regressions.md).

Use an isolated environment before release to avoid contaminating personal memory:

```text
temporary DSH_HOME
temporary MNEMON_DATA_DIR or custom storageScope
temporary workspace
independent Web port
local link installation
```

Recommended scenarios:

1. Empty root: the UI reports no errors and can create the first Memory Space.
2. Regular conversation: only a short cue appears; recall and writes are not forced.
3. Historical question: the Agent independently recalls and returns the correct space provenance.
4. Explicit distillation: the worker deduplicates, selects a scope, and writes content that can be recalled again.
5. Multiple spaces: reads cover only active spaces; writing to an inactive space activates it automatically afterward.
6. Runtime: USER / MEMORY add, replace, remove, and projection consistency.
7. Documents: create, retrieve, update, manually archive, and leave original project files unchanged.
8. Score-based review: light tasks do not trigger it; after reaching the threshold it waits for idle; a new turn can cancel it while preserving the watermark.
9. Read-only: write tools, write commands, and write RPC are rejected while reads remain available.
10. Sidebar: all four primary tabs, four Memory Space secondary tabs, stable headings, filters, and progressive loading work.
11. Conversation UI: Turn memory appears only for completed turns with activity; links land correctly; canceling Save to memory performs no write.
12. Settings: storage scopes, `displayMode`, and both conversation switches apply live; `tabEnabled` controls the selected entry. Sidebar and Builtin never mount together. Builtin shares all pages and dialogs, hides scope controls, follows the owning session for global/workspace/custom reads and writes, and clears stale data and editors on session changes.
13. ZIP: export can be previewed and merged into an isolated custom root; damaged checksums are rejected.
14. Versions: checking never installs; link/manual sources offer no unsafe update; successful updates trigger a fresh status check.
15. Status and browser console: no unhandled errors or warnings.

Capacity limits, CLI timeouts, revision conflicts, and Host restarts should be verified in a dedicated fault-injection environment.

## Maintaining Documentation Visuals

Public UI screenshots live under `docs/assets/screenshots/`, shared by both language editions. Language-specific architecture diagrams live under `docs/assets/diagrams/zh-CN/` and `docs/assets/diagrams/en/`. When layout, primary copy, or defaults change:

1. Use a real DSH Web profile, but first check that the frame contains no token, credential, or private personal data.
2. Use 1600×900 standard widescreen for primary screenshots and video; narrow viewports are no longer release hero assets.
3. Record complete downward and upward page scrolling, plus filter, repeated-click, toggle, expand, dialog, and exact-navigation button states.
4. Stop writes, component updates, and settings changes before final confirmation. A read-only Agent Query over public test data may run for real, including its wait and result states.
5. Replace screenshots with the same responsibility instead of accumulating versioned filenames. Add an asset only for a new user task.
6. Refresh the README poster, GIF / MP4 demo, and both `ui-guide.md` files.
7. Confirm PNG / JPEG extensions match actual encoding and that text is readable at original resolution.
8. Remove unreferenced assets, stale layouts, and obsolete terminology.
9. Run link/image checks, then open both READMEs and UI guides manually.

README demo assets are `docs/assets/media/dsh-mnemon-memory-system-demo.*`. The demo should cover Status, Runtime, Documents, Memory Spaces, Provider and dialog interactions with full vertical scrolling and key button-state changes. Automation must not submit memory, update components, or save settings, but it may complete a safe read-only Agent Query.

## Modifying Subagent Schemas

Mnemon's one-run result tools use the compact JSON Schema subset accepted by DSH tool parameters:

```text
type, oneOf, properties, required, additionalProperties,
items, enum, const, and annotation keywords
```

Do not add unsupported keywords such as `maxItems`. `assertDshOutputSchema()` recursively rejects unknown schema keys before registering the result tool; result-count and similar limits are enforced by both the persona and the Host parser.

## Modifying Storage Formats

Runtime, Documents, and the Memory Space registry each have a version field or fixed structure. Changes require:

1. Define how the old format is parsed;
2. add a migration or rejection path;
3. preserve temporary-file and atomic-rename behavior;
4. add tests for concurrency and damaged inputs;
5. update the Chinese and English storage, operations, and Roadmap documents;
6. verify upgrade and rollback against a copied data root.

There is currently no formal schema-migration framework, so persistent formats must not change silently.

## Maintaining Documentation Internationalization

`docs/zh-CN` and `docs/en` should contain matching filenames with the same section responsibilities. When changing defaults, workflows, or limitations:

- update both languages;
- keep commands, configuration keys, paths, and code symbols exactly the same;
- cross-link corresponding language pages with relative paths;
- prefer accessible SVGs with no scripts or external resources for architecture overviews; keep directory trees, commands, formulas, and short protocols as copyable `text` / ASCII;
- keep only summaries in the root READMEs and place details on one authoritative docs page;
- for every user-visible interface change, also inspect `ui-guide.md`, `getting-started.md`, `configuration.md`, and `operations.md`.

When the Web locale changes, the Chinese key set remains the type source of truth. The English dictionary must satisfy `Record<MnemonKey, string>` and preserve the same placeholders.

## Release Checklist

```text
[ ] pnpm run verify
[ ] confirm the worktree contains no generated lib changes
[ ] confirm package validation reports only runtime files, declarations, root documents, and cordis.patch.yml
[ ] import every public `dsh-mnemon/*` subpath from the packed artifact
[ ] verify live extension registration/unloading advances generations and rejects stale Plans
[ ] install the built/local bundle into an isolated Web profile
[ ] confirm `verify:headless` activates the built bundle in an isolated Headless profile
[ ] run real Mnemon CLI and WebUI smoke tests
[ ] verify Chinese and English workspaces
[ ] verify global/workspace/custom paths as applicable
[ ] record tested DSH and Mnemon versions
[ ] record the evaluated product/baseline commits, model, scenario matrix, and release-gate result
[ ] distinguish behavioral gates from environment-specific token and latency observations
[ ] back up any data root used for upgrade testing
```

`package.json.files` publishes `lib`, the patch, both root READMEs, `SECURITY.md`, and the License. The documentation site and media stay in GitHub and are intentionally excluded from npm.

## Publishing to npm

After publication, `dsh plugin --profile web add dsh-mnemon` resolves by registry name — the same path as dsh-better-sidebar. Steps:

```sh
pnpm run verify
npm pack --ignore-scripts
npm publish dsh-mnemon-<version>.tgz --access public --ignore-scripts
```

Publishing the already-packed tarball ensures npm receives the same artifact that was inspected. The GitHub release workflow follows this sequence after checking that the tag matches `package.json`.

Credential convention: write NPM_TOKEN only to the user-level `~/.npmrc` (`npm config set "//registry.npmjs.org/:_authToken" "${NPM_TOKEN}" --userconfig ~/.npmrc`) and remove it after publishing. Do **not** commit the credential line to the repository `.npmrc`: pnpm 11 deliberately ignores unexpanded environment-variable credentials in project-level `.npmrc` (with a warning), and that file travels with the repo.

2FA note: when the npm account has publish-level two-factor authentication, an interactive `pnpm publish --access public` prompts for the OTP; scripted/CI publishing needs a Classic **Automation** token or a Granular token allowed to bypass 2FA (a plain token from `npm login` cannot publish and fails with 403 Two-factor authentication required).

Before publishing, check that `package.json` `repository`/`homepage`/`bugs` point at `omdsh-dev/dsh-mnemon` (npm page consistent with GitHub) and that the version has been bumped.
