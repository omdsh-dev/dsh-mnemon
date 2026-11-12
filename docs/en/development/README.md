# Development and Verification

[简体中文](../../zh-CN/development/README.md) | **English** | [Documentation](../README.md)

## Environment and commands

The plugin's Node engine floor is 20. The pinned complete DSH development profile is the published 0.2.1-rc.5 release candidate; that profile and the build tooling together need Node `^22.19.0 || >=24.11.0`. Use Node 24.22.2 for DSH 0.2.2 RC acceptance. Root, Source Client tests and the external artifact consumer use that cohort, and `dsh-client-store` owns the public selector type used by the subagent projection adapter. Public Node entries are also smoke-tested on Node 20 in CI. DSH 0.2.0-rc.2 is supported as well: `tests/dsh-host-compatibility.spec.ts` runs DSH's own pre-install compatibility check over all 19 package manifests for the supported and unsupported releases, and CI runs the root tests against installed 0.2.0-rc.2, 0.2.1-rc.3 and 0.2.1-rc.5 packages on Node 22.19.0. The published 0.2.2-rc.1 and 0.2.2-rc.2 CI targets use Node 24.22.2; these Hosts require Node 24.9.0 or later. Alpha versions are no longer compatibility or CI targets. Packed Starter acceptance covers the pinned baseline, RC1 and RC2, including installation, data-preserving upgrade, settings save/restart, disabling the Starter and enabling all optional strategies. RC2 packed acceptance sets `MNEMON_PLUGIN_UPGRADE_BASE=0.5.43`, which already supports activation-owned Agents; the baseline, RC1 and publication retain the `0.5.29` upgrade path. The pinned development baseline stays on 0.2.1-rc.5 to retain Node 22 and older-Host coverage. To run them against another installation yourself:

```sh
npm install --global --prefix <directory> @deepseek-ai/dsh@0.2.0-rc.2
DSH_HOST_ROOT=<directory>/lib/node_modules/@deepseek-ai/dsh pnpm run test:installed-dsh
```

Every `@deepseek-ai/*` import, subpaths included, then resolves from that installation (`scripts/installed-dsh.config.ts`), and the real-host specs compose it through `tests/helpers/installed-dsh.ts`. Build first, as for `pnpm run test`. [Compatibility](../reference/compatibility.md#dsh-020-and-021) lists where the two releases differ. A spec of behavior only DSH 0.2.1 has skips on 0.2.0 through the helper's `dsh021`, as `tests/task-agent-cwd-host.spec.ts` does for a task Agent whose workspace folder is gone and `tests/resumed-memory-task-host.spec.ts` for a finished memory task its conversation resumes.

DSH's UI primitives import Markdown/highlighting dependencies that their published manifest lists as development dependencies. Root, the four Source packages and the external consumer declare that complete cohort explicitly for standalone Client tests; Host artifacts still use DSH’s provided UI module. Tests use the public async Agent factory and durable `assistant/message` events.

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` checks types, deterministic Root builds, independent plugin builds, the full test suite, a real isolated DSH Headless profile and package exports/contents. Independent plugin checks run as separate type/test phases after building all public artifacts. Do not mix `pnpm -r verify` clean builds with tests reading sibling artifacts; use `pnpm verify` for the whole workspace. `verify:plugins` repeats verification **outside** the workspace against semver-installed tarballs and an external Source/Strategy/Provider/Client consumer. It also installs only the packed Root into real DSH, resolving all eighteen official plugins from a loopback registry without workspace links or manifest rewrites, then separately verifies the three shipped enhancements moving from disabled defaults to simultaneous activation. The external consumer compiles its own Strategy extension against the owning Strategy's packed SDK.

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
  dsh-mnemon-strategy-default-three-tier/  # the Layered strategy, the default main strategy
  dsh-mnemon-strategy-general/        # shipped, alternative main strategy
  dsh-mnemon-strategy-scoped/         # shipped, disabled selection contribution
  dsh-mnemon-strategy-light-context/  # shipped, disabled projection contribution
  dsh-mnemon-strategy-auto-capture/   # shipped, disabled in-turn capture contribution
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

Root owns Core/SDK and the DSH Host/default Starter, not Source storage implementations: where the Host copies or counts a Source's files, it takes their names, locks and parsers from that Source's `./contracts` (see [Built-in storage scope](./architecture.md#built-in-storage-scope)). Each directory under `plugins/` is a publishable standalone project. The default distribution depends on all eighteen official plugins by public semver. The Starter installs the General strategy and the three enhancements with their Entries disabled; `memoryView.strategyTypeId` records which main strategy composes the View, and DSH's plugin manager records each component switch. Source/Strategy peers depend on Core's public SDK, Strategy extensions on their owner's public SDK, and Providers on the Memory Spaces SDK. Peer/development relationships can produce a package-manager cycle warning; production import boundaries are independently checked.

No private workspace packages, forwarding controller modules, business bindings or compatibility directory remain. Compatibility means retained user configuration, data and workflows, not retention of historical internal symbols. The [compatibility register](./compatibility-register.md) lists the code that keeps them working, why it exists and when each piece can go.

Plans written before larger changes, with their status, are listed in [docs/plans](../../plans/README.md). [scripts/README.md](../../../scripts/README.md) lists every script and fixture with its inputs and environment variables. [Provider Lab](../../../provider-lab/README.md) runs the third-party Providers on loopback, and [tests/fixtures/upgrade](../../../tests/fixtures/upgrade/README.md) holds the pre-extraction storage that `tests/upgrade.spec.ts` upgrades.

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

The workspace identity, Client platform boundary and delegated workspace scope tests also run on Windows with Node 22.19 and 24. They cover real filesystem errors and junction aliases as well as a portable regression for Windows returning `ENOENT` below a file; that simulated error is not a substitute for the Windows run.

`tests/bundle-activation.spec.mjs` boots the published DSH Loader with disposable activation counters for all nineteen packages, the Starter and its eighteen plugins. It checks the legacy `mnemon` configuration/disable target and independent component choices, then drives the published plugin manager: real component and bundle toggles must persist across reloads and restarts, the core gate must stop every active child, and no package may leave duplicate instances. Both cases run on the pinned host; set `MNEMON_BUNDLE_TEST_PROFILE=/absolute/profile` to check another installation instead. The fixture processes do not inherit the `NODE_PATH` that `pnpm exec` sets: DSH 0.2 routes plugin packages through Node's search paths, `NODE_PATH` included, so inheriting it would resolve this repository's real plugins instead of the fixture's packages. The fixture creates its own temporary profile and does not edit the supplied installation. It tests lifecycle contracts; packed Headless and WebUI checks still own real Mnemon behavior. Finally it checks that DSH's config schema collector reports only the Starter's component group, as an unrecognized tree carrier (a known trade-off, see [Compatibility](../reference/compatibility.md#installing-and-enabling-the-starter-without-a-restart)), and no other error. Run `node --expose-internals tests/fixtures/bundle-activation.mjs /absolute/profile manager --check-declared-rows` to additionally require every advertised bundle component to be manageable. That diagnostic fails on DSH 0.2.0's known native-group listing defect, described in [Compatibility](../reference/compatibility.md#the-bundle-component-list-on-dsh-020).

Remote Provider suites use controlled HTTP responses; Native process suites use controlled command runners plus an optional Windows binary smoke. A separate opt-in test uses an official checksum-verified Native binary to create a disposable space, write through a View, recall and forget:

```sh
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run tests/native-integration.spec.ts
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm exec vitest run tests/runtime-capacity-workflow.spec.ts -t 'two same-View Native'
```

The test never discovers a personal data root or installs a binary. These checks do not certify every live external service or every account configuration. [Provider Lab](../../../provider-lab/README.md) is an explicit separate integration environment.

OpenViking has an opt-in loopback integration test: `MNEMON_OPENVIKING_TEST_ENDPOINT=http://127.0.0.1:1933 pnpm --filter dsh-mnemon-provider-openviking exec vitest run tests/integration.spec.ts`. Use only a disposable backend. It verifies a unique bilingual canary through create, exact readback, search, browse and exact deletion; normal CI skips it. A published v0.4.20 server with local deterministic embeddings validates the HTTP/storage/index contracts, not semantic-model quality.

The Runtime case creates and activates two Native spaces through real Host tools after the View is pinned, archives two exact checkpoints and verifies the pending add. Routing decisions are fixed locally; no model API is used.

The Agent Teams matrix loads the published DSH packages through their package exports only and runs with the ordinary test suite on the pinned host; `MNEMON_TEAM_TEST_PROFILE=/absolute/profile pnpm exec vitest run tests/agent-team-review-host.spec.ts` checks another installation of the same DSH/Teams version. It exercises real fork/spawn, native/Code Mode tools, all three Strategy extensions, restricted child execution, actual Runtime commits and parent Team tools. Reproduction profiles, the packed WebUI fixture and reviewed evidence are in the [Issue #275 record](../../pr-assets/issue-275-agent-teams/README.md).

The opt-in Flash pressure suite uses four real DSH sessions, delegated writers, independent maintenance tasks and a disposable Native store. It keeps the default 10 KiB limit and verifies exact committed content across repeated archival, namespace routing and session-free browser management. Supply a DeepSeek credential through `DEEPSEEK_API_KEY` and a verified CLI through `MNEMON_NATIVE_TEST_CLI`, then run:

```sh
MNEMON_RUN_FLASH_STRESS=1 MNEMON_FLASH_STRESS_ROUNDS=8 MNEMON_FLASH_STRESS_REPORT=/tmp/mnemon-flash-stress.json pnpm exec vitest run tests/runtime-capacity-flash-stress.spec.ts
```

Every outgoing request and returned model is checked against `deepseek-v4-flash`; the suite uses non-thinking mode and never selects Pro. It reports model input changes separately from storage changes, uses synthetic project facts, and removes its temporary stores and sessions. Destination authorization is a hard assertion; semantic topic matches are reported separately as model quality. Set `MNEMON_FLASH_STRESS_JSON_PROMPT=1` to repeat the quoted-JSON input diagnostic. It is skipped in ordinary CI and requires explicitly authorized live API usage.

The separate automatic-memory acceptance suite simulates backend, frontend, Android and operations work in four concurrent DSH sessions. Developer prompts contain accepted decisions, corrections and disposable diagnostics; the model chooses its own memory actions. Actual temporary JSON files provide bounded development tasks, while the real default lifecycle performs idle review. Fresh reader sessions have no development transcript or file access. Supply the same credential and CLI environment variables, then run:

```sh
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_WAVES=24 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality-long.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts -t 'four preconfigured'
```

The default is 12 waves per session; the extended workload has 24. Both use Flash with thinking disabled, guided recall/writeback and the default 10,240-byte memory limit. Only the idle debounce is shortened from 30 to 5 seconds; eligibility rules stay unchanged. The suite records retained facts, transient markers, corrected answers, module attribution, no-write turns, tool errors and archival. A successful Vitest run means the experiment completed: inspect `finalEvaluation.automatedVerdict` and manually audit retained prose for stale documents, duplicates and scope errors before declaring quality acceptance. The [2026-09-09 acceptance report](../../pr-assets/runtime-memory-quality-flash-20260909/README.md) records failures as well as successful checks. Ordinary CI skips both live cases. This simulation does not substitute for full application builds, a half-day human workflow or Windows testing.

Keep generated live-run output outside the repository, as the commands above do. Follow the [evidence storage policy](../../pr-assets/README.md): commit summaries, reproduction inputs and minimal examples; attach complete sanitized run data to the PR with its revision and SHA-256.

`tests/legacy-session-repair.spec.ts` runs the real released Session v0 → v3 migration over synthetic historical logs in plain and compressed form, checking explicit copy recovery, cold reopen and timed stream replay. Its audited cases cover all three old Mnemon summaries, compatible v2 descriptors, packed-placeholder expansion, null-to-empty delta names and closed tool chains with a previously recorded provider ID. It checks multi-call provenance, owner-reference refusal and original/plugin preservation. In the WebUI, `--legacy-session-replay` (see [Fixture options](#fixture-options)) adds the continuation check.

The performance regression composes 100 three-Source Views under wall/CPU budgets. Deterministic builds compare all generated hashes. Neither check promises production network latency or LLM quality.

`pnpm bench:algorithms` measures local query, storage, compaction and recall scaling at N=1/10/100/1000 in temporary synthetic stores. It writes `.cache/algorithm-benchmark.json`; use `MNEMON_BENCH_OUTPUT` for another destination or `MNEMON_BENCH_SIZES=1,10,100` for smaller cases. Run it without concurrent tests/builds. The [algorithm audit](../../pr-assets/algorithm-performance-20261003/README.md) records the workload definitions, before/after results, operation counters, complexity bounds and external-Provider limitations. Normal CI uses deterministic equivalence/work-bound tests, not latency assertions from this benchmark.

Both the default and three-extension profiles run that performance fence. The
[2026-09-01 Strategy contribution verification](../../pr-assets/strategy-extensions-20260901/README.md)
records coexistence, independent artifacts, real Headless activation and limits.

## Real WebUI

For stylesheet placement, stable selectors, activation scope, migration from generated classes and acceptance steps, see [Skin development and Mnemon integration](./skin-integration.md).

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

The fixture prints a temporary workspace and loopback URL. It isolates `DSH_HOME`, `MNEMON_DATA_DIR`, browser workspace and model endpoint, and points DSH's Documents folder, where it creates its first-use workspace, inside the fixture. Select **Mnemon E2E** for a conversation; this test-owned preset omits Shell requirements while retaining Host memory tools. The model returns a fixed answer, so this fixture checks UI and transport, not real-model distillation quality. Stop with Ctrl-C to remove its synthetic data; `SIGUSR2` to the printed PID restarts the WebUI on the same data, and `MNEMON_E2E_PORT` keeps one address across restarts.

Check Sidebar without a session, all primary/secondary tabs, Runtime add/edit/remove and branch clear, Documents create/search/read, Provider settings/discovery, activation, error states, dialog cancellation, Save-to-memory, layout switching, locale and restoration of chat interaction. On the `dsh-mnemon` page under Plugins, also check the main strategy selector, each component's switch and page, DSH's component rows and the pages they open, the Default/Custom storage location, and a backup import preview. Use a disposable real Provider or controlled fixture for write/read/forget; never test against personal memory.

Also switch `displayMode` live: the Sidebar and the conversation tab (`builtin`) must never mount together. Both use the same Source pages; the conversation tab follows its owning session for global/workspace/workspaces/custom reads, writes and tasks, hides scope controls, and clears stale data and editors when the session changes. Check legacy `buildin` normalization and the collapsed icon under the native Sidebar skin as well as supported layout plugins.

Separate upstream profile/transport warnings from Mnemon failures rather than hiding the console.

To serve the WebUI on another DSH release, install it with `npm install -g --prefix <directory> @deepseek-ai/dsh@0.2.0-rc.2` and set `MNEMON_E2E_DSH=<directory>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`. The same variable points `node scripts/verify-headless-profile.mjs` and `node scripts/verify-sync-git.mjs` at that release; run them with `node`, not `pnpm`, so they inherit no `NODE_PATH`. To run the root tests against that installation, use `pnpm run test:installed-dsh` as in [Environment and commands](#environment-and-commands).

### Fixture options

`--evolution-scroll` seeds ten synthetic skill suggestions, one with a long detail, to check independent scrolling and selection on wide and narrow screens. It calls no model.

`--skills-scroll` seeds 24 synthetic skills, including two long documents, for the Skills tab's list/detail scrolling regression. Check independent wheel scrolling, scroll containment at each column's boundary, and detail reset on selection at desktop width; at narrow width, check that the list stays bounded and the entire document remains reachable. It calls no model and can be combined with `--evolution-scroll`.

`pnpm e2e:serve` takes the options below, of two kinds:

- **Setup options** change the profile, the model stub or how the WebUI runs: `--strategy-extensions`, `--live-model`, `--log-model-requests`, `--native-directory-picker`, `--plugin`, `--better-sidebar`, `--electron`, `--trusted-host`, `--remote-management`, `--without-mnemon-cli`, `--second-runtime`, `--review-failure`, `--runtime-archive` and `--archive-copies`. The last two also start a stand-in service on loopback, a Hindsight server and a slow embedding service.
- **Scripted models** decide what the model does for one check: `--document-protection`, `--review-evidence`, `--document-archive`, `--openviking-write`, `--runtime-routing`, `--result-tool-cache`, `--runtime-write-scope`, `--legacy-session-replay`, `--idle-review`, `--review-layers`, `--strict-template`, `--general-strategy`, `--exact-id`, `--save-action`, `--profile-compaction`, `--remember-target`, `--recall-budget` and `--docs-demo`. One scripted model runs at a time, so use them one at a time: if several are given, the first in `scripts/serve-e2e.mjs` wins, and `--live-model` turns them all off. Each combines with the setup options.

Apart from those stand-ins and the OpenViking protocol fixture that `--openviking-write` expects, the storage, the tools, the transport and the browser are real, and no personal credentials or memory are used. Each fixture prints its steps as lines with its own prefix, shown in the table. The record holds the complete steps and the results before and after its fix; [scripts/README.md](../../../scripts/README.md) lists the file behind each option.

| Option | What it sets up | Issue | Record |
|---|---|---|---|
| `--strategy-extensions` | Turns on the three shipped enhancements: Scoped composition, Light context and Active capture | — | [Strategy contributions](../../pr-assets/strategy-extensions-20260901/README.md) |
| `--native-directory-picker` | Uses DSH’s published native Host/UI directory-picker packages instead of the default browse-only fixture; opens an OS chooser on the Host display | [PR #355](https://github.com/omdsh-dev/dsh-mnemon/pull/355) | — |
| `--live-model` | The DeepSeek API answers instead of the loopback stub, and the scripted models are off. The key comes from `DEEPSEEK_API_KEY` and the endpoint from `DEEPSEEK_BASE_URL` when set; neither is stored | — | — |
| `--log-model-requests` | Each `Fixture model request:` line also names, as JSON, the model the request asks for, what sent it (`conversation`, `title` for DSH's session title, or `memory task` for a child that carries Mnemon's completion protocol), its tool count, and its thinking mode and reasoning effort when it sets them. Not with `--live-model`, which replaces the stub | — | [Test tooling](../../pr-assets/test-tooling-from-records/README.md) |
| `--docs-demo` (Chinese), `--docs-demo=en` | Seeds the fictional Lumen project of the [documentation gallery](../../assets/webui-v0.5.32/README.md): profile and working memory, six project documents and three Memory Spaces. It also seeds the project's skills for the [Skills gallery](../../assets/skills-v0.5.34/README.md): six skills in the four skill roots, earlier reviews with their evidence, test cases, backtests and a team catalog, with self-evolution on. Ask about checkout (结账), then ask it to remember a new target (记住); or ask for the 2.4 release notes (版本说明), then send `/release-notes` asking to group them by package (按包分组), and the scripted model answers the review, the draft and the backtest too. With `--live-model` the real model answers; recapture the galleries that way whenever the UI changes. `Docs demo:` | — | [Gallery](../../assets/webui-v0.5.32/README.md) · [Skills gallery](../../assets/skills-v0.5.34/README.md) |
| `--plugin=<package directory>` | Links one more test-only plugin into the profile; repeat it for several | [#340](https://github.com/omdsh-dev/dsh-mnemon/issues/340) | [Settings outside slots](../../pr-assets/issue-340-settings-outside-slots/README.md) |
| `--better-sidebar=<package directory>` | Links one layout or skin package into the profile, such as Better Sidebar or the ORCA LINK skin | [#232](https://github.com/omdsh-dev/dsh-mnemon/issues/232) | [ORCA LINK sidebar](../../pr-assets/issue-232-orca-sidebar/README.md) |
| `--electron=<executable>` | Runs the published DSH Web stack in a real Electron main process, without `ELECTRON_RUN_AS_NODE` on the Host and without rebuilding DSH; on macOS pass `Electron.app/Contents/MacOS/Electron`. Give the test Electron an isolated npm prefix through `npm_config_prefix`, and the CLI through `MNEMON_CLI_PATH` | [#201](https://github.com/omdsh-dev/dsh-mnemon/issues/201) | [Electron npm CLI](../../pr-assets/issue-201-electron-cli/README.md) |
| `--trusted-host=<host:port>` | Adds that authority, such as `memory.test:4331`, to DSH's browser-trust fence, so the WebUI can be checked as a remote page. Set `MNEMON_E2E_PORT` to the same port, map the name to 127.0.0.1 in the test browser (for Chrome, `--host-resolver-rules="MAP memory.test 127.0.0.1"` with `--no-proxy-server`), and open the printed launch URL with the authority in place of the loopback address | — | [Plugin configuration](../../pr-assets/plugin-config-20260927/README.md) |
| `--remote-management` | Sets `remoteAccess: trusted-host`, so with `--trusted-host` the `dsh-mnemon` page under Plugins can save | — | [Plugin configuration](../../pr-assets/plugin-config-20260927/README.md) |
| `--without-mnemon-cli` | Points `cliPath` at a missing file, so the Host behaves as if the Mnemon CLI were not installed even when one is on PATH; connect another Provider first, for example a [Provider Lab](../../../provider-lab/README.md) service | — | [Optional Mnemon CLI](../../pr-assets/optional-mnemon-cli-20260927/README.md) |
| `--document-protection` | A 5-second idle-review wait and a review that tries to overwrite an existing document. Send two turns of at least 320 user characters in all. `Document protection:` | [PR #199](https://github.com/omdsh-dev/dsh-mnemon/pull/199) | [Document protection](../../pr-assets/pr199-document-protection/README.md) |
| `--review-failure` | A 5-second idle-review wait, and every delegated child, such as the review, gets HTTP 400 `CONTEXT_WINDOW_EXCEEDED`. Send a durable "Please remember" rationale of more than 150 characters, then confirm it. `Review fixture:` | [#210](https://github.com/omdsh-dev/dsh-mnemon/issues/210) | [Idle-review failure](../../pr-assets/issue-210-review-warning/README.md) |
| `--review-evidence` | With `--strategy-extensions`: a 5-second idle-review wait, a per-Agent synthetic overview tool, and scripted parent and reviewer calls that read it. Send the two turns in the record. `Review evidence:` | [#211](https://github.com/omdsh-dev/dsh-mnemon/issues/211) | [Review evidence](../../pr-assets/issue-211-20260911/README.md) |
| `--document-archive` | Scripted archive decisions; a document whose title contains `REJECT` is given an invalid destination. Send `archive-tool-222 prepare`, `archive-tool-222 update` and `archive-tool-222` in separate turns. `Document archive:` | [#222](https://github.com/omdsh-dev/dsh-mnemon/issues/222) | [Document archive](../../pr-assets/issue-222-document-archive/README.md) |
| `--openviking-write` | A scripted writer for OpenViking. Also run `node scripts/fixtures/openviking-protocol.mjs`, a stand-in server whose `/__fixture` endpoint reports the synthetic requests and files; configure OpenViking at `http://127.0.0.1:19335`, account and user `default`, no API key, and send `openviking-write-233`. The stand-in proves nothing about live extraction: repeat against a disposable real server for backend acceptance. `OpenViking write:` | [#233](https://github.com/omdsh-dev/dsh-mnemon/issues/233), [#353](https://github.com/omdsh-dev/dsh-mnemon/issues/353) | [OpenViking writes](../../pr-assets/issue-233-openviking-20260916/README.md), [#353](../../pr-assets/issue-353-openviking-write/README.md) |
| `--runtime-routing` | A 1,600-byte working-memory limit and a routing model that returns chunk-local indexes. Create and activate two Native Memory Spaces, then add working-memory entries past the limit. `Runtime routing:` | [#235](https://github.com/omdsh-dev/dsh-mnemon/issues/235) | [Routing fallback](../../pr-assets/issue-235-runtime-routing/README.md) |
| `--result-tool-cache` | With `MNEMON_CLI_PATH` and `--strategy-extensions`: a scripted writer for two writes in a row. Send `cache-round-239 first`, then `cache-round-239 second`. `Result tool cache:` | [#239](https://github.com/omdsh-dev/dsh-mnemon/issues/239) | [Stable result tool](../../pr-assets/issue-239-result-tool/README.md) |
| `--runtime-archive` | A loopback Hindsight stand-in that records the writes it accepts, and a 300-byte working-memory limit. Enable Hindsight with the printed endpoint on Memory Spaces' page, then add working-memory entries past the limit. `Runtime archive accepted writes:` | [#240](https://github.com/omdsh-dev/dsh-mnemon/issues/240) | [Archive destinations](../../pr-assets/issue-240-runtime-archive/README.md) |
| `--runtime-write-scope` | With `MNEMON_CLI_PATH` and `--strategy-extensions`, in a fresh fixture: a 512-byte working-memory limit and a scripted model that bounds child calls and needs real create and update receipts. Send `archive-scope-250`; `archive-scope-250 retry` retries in a new turn. `Runtime write scope:` | [#250](https://github.com/omdsh-dev/dsh-mnemon/issues/250) | [Runtime write scope](../../pr-assets/issue-250-runtime-write-scope/README.md) |
| `--legacy-session-replay` | With `--strategy-extensions`: a continuation server that answers only when a repaired legacy Session replays its historical call and result IDs and payload. `Legacy replay:` | [#251](https://github.com/omdsh-dev/dsh-mnemon/issues/251) | [Legacy Session repair](../../pr-assets/issue-251-legacy-repair/README.md) |
| `--idle-review` | With `--strategy-extensions`: a 5-second debounce and minimum interval, one review per session, and a reviewer that fails after it writes. Send two substantive user turns of at least 150 characters each. `Idle review:` | [#100](https://github.com/omdsh-dev/dsh-mnemon/issues/100), [#255](https://github.com/omdsh-dev/dsh-mnemon/issues/255) | [Idle review limits](../../pr-assets/idle-review-agent-team/README.md) |
| `--review-layers` | A 5-second idle window, one review per conversation, and a review that writes one fact as a Document and then to working memory. Send the two turns in the record's verification data. `Review layers:` | [#319](https://github.com/omdsh-dev/dsh-mnemon/issues/319) | [One layer per review](../../pr-assets/issue-319-review-layers/README.md) |
| `--strict-template` | A model that behaves as Ollama 0.33 serving a chat template that requires a user query, and an idle review after 5 seconds, once per session. Send two substantive user turns of at least 150 characters each. `Strict template:` | [#327](https://github.com/omdsh-dev/dsh-mnemon/issues/327) | [User turn for subagents](../../pr-assets/issue-327-subagent-user-turn/README.md) |
| `--general-strategy` | Selects the General strategy and turns the Layered strategy off. Send `general-strategy-check remember`, then `general-strategy-check recall`. `General strategy:` | — | [Main strategy choice](../../pr-assets/main-strategy-choice-20260927/README.md) |
| `--second-runtime` | Only with `--general-strategy`: mounts a second runtime Source, `mnemon-source-runtime-global`, with its own directory, beside the Starter's. Send `general-strategy-check remember`; the `General strategy:` composition line shows `otherRuntimeOffer` | [#397](https://github.com/omdsh-dev/dsh-mnemon/issues/397) | [Default runtime instance](../../pr-assets/issue-397-default-runtime-instance/README.md) |
| `--exact-id` | With `MNEMON_CLI_PATH`: scripted write and forget workers. Run `/mnemon remember <text>`, `/mnemon recall <words>` for its id, then `/mnemon forget <ID>`. `Exact id:` | [#337](https://github.com/omdsh-dev/dsh-mnemon/issues/337) | [Exact-id actions](../../pr-assets/issue-337-exact-id-actions/README.md) |
| `--archive-copies` | With `MNEMON_CLI_PATH`: working memory near a 640-byte limit with an exact copy of each entry in a Native Memory Space, and an embedding stand-in that answers after 12 seconds (`MNEMON_E2E_EMBEDDING_DELAY_MS`). Add the entry the fixture prints on the Runtime Memory page. `Archive copies:` | [#339](https://github.com/omdsh-dev/dsh-mnemon/issues/339) | [Archive receipts](../../pr-assets/issue-339-archive-receipt-evidence/README.md) |
| `--save-action` | With `MNEMON_CLI_PATH`: every turn gets one reply worth saving, and a scripted task Agent writes what it is sent. Save a reply with **Save to memory**, then edit the answered candidate and send it again. `Save action:` | [#342](https://github.com/omdsh-dev/dsh-mnemon/issues/342) | [Edited saves](../../pr-assets/issue-342-edited-save/README.md) |
| `--profile-compaction` | Caps USER.md at 100 bytes and turns idle review off. Send `记住：回答尽量简洁，不要冗长的开场白。`, `记住：回答使用简体中文。` and `记住：汇报时先列出阻塞项。` as three messages. `Profile compaction:` | [#356](https://github.com/omdsh-dev/dsh-mnemon/issues/356) | [Subagent activations](../../pr-assets/issue-356-subagent-activation/README.md) |
| `--remember-target` | Seeds the Chinese Lumen project, whose 调研归档 space is switched off, unless `--docs-demo` seeds it. Send `remember-target-check`, then `remember-archive-check`. `Remember target:` | [#387](https://github.com/omdsh-dev/dsh-mnemon/issues/387) | [Explicit space target](../../pr-assets/issue-387-explicit-space-target/README.md) |
| `--recall-budget` | Seeds the Chinese Lumen project unless `--docs-demo` seeds it, and a model that asks three different Recall questions in one turn. Send `recall-budget-check`. `Recall budget:` | [#389](https://github.com/omdsh-dev/dsh-mnemon/issues/389) | [Recall budget](../../pr-assets/issue-389-recall-budget/README.md) |

The slow embedding service of `--archive-copies` also runs on its own, for Mnemon CLI probes or as the endpoint in the Mnemon Native embedding settings. `node scripts/fixtures/fake-embeddings.mjs` serves Ollama's API at `http://127.0.0.1:<port>` and the OpenAI-compatible one at `http://127.0.0.1:<port>/v1`, with a deterministic vector for each text, and prints a `Fake embeddings:` line for each embedding request:

- `--port <n>` chooses the port (a free one by default) and `--port-file <file>` writes the one it took;
- `--delay-ms <ms>` holds every embedding answer, but not the model list, as a slow service does;
- `--missing-model` keeps the service up without the model: Mnemon finds it available, and every embedding request answers 404;
- `--model <name>` names the model it lists, `nomic-embed-text` by default.

`MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm exec vitest run tests/fake-embeddings-fixture.spec.mjs` also checks it against a real Mnemon CLI over both protocols.

### Earlier records

The [2026-09-04 main-rebase verification](../../pr-assets/main-rebase-20260904/README.md) records the exact v0.4.7/DSH rc.1 revisions, full registry and source-overlay suites, independent artifacts, plugin composition persistence and real shared-placement checks, including their limits.

The [2026-08-30 npm regression record](../../pr-assets/npm-sidebar-cli/README.md#english) preserves the old Taskboard/SSH and CLI investigation. Its removed legacy harness is not a current checkout command; use `pnpm e2e:serve` for current WebUI work.

## Releasing

Official packages use independent versions; the Starter pins a tested combination. See [Release process](./releasing.md) for changesets, frozen artifacts, Registry checks and recovery.

## Documentation, storage and historical evidence

Keep English/Chinese pages aligned and public examples executable. Code-native Mermaid diagrams describe ownership and flow; real screenshots remain under `docs/assets`. Do not retain dead directory stubs or historical wrapper files.

Retain persisted formats and existing config keys unless an explicit migration is designed and tested. Verify locking, atomic rename, revisions, corrupt inputs and copied-root upgrade/rollback before changing storage.

The v0.3 release benchmark is a frozen historical result, not a test of this architecture. Its obsolete executable harness was removed from the working tree; [release notes](../releases/v0.3.0.md) link to the versioned historical source. Current gates are the scripts above.
