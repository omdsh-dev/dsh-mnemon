# Scripts

The repository's own tooling: the checks `pnpm run verify` chains, the release steps, the real-WebUI fixtures and the Provider Lab helpers. [Development and verification](../docs/en/development/README.md) describes how they fit together.

Most scripts run through a `package.json` script; run the rest with `node` from the repository root, after `pnpm build` and `pnpm --workspace-concurrency=1 -r build` when they load built packages. When `MNEMON_E2E_DSH` points at another DSH installation, run the script with `node`, not through pnpm, so that DSH inherits no `NODE_PATH`. None of these files ships in an npm package. `verify-headless-profile.mjs`, `verify-sync-git.mjs` and `serve-e2e.mjs` take the Starter's component lists from `src/host/starter-components.ts`, which Node loads as TypeScript without a build step. Reusable tooling for an evidence record belongs here or in `tests/`, and the record links to it.

## Checks

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `serve-release-acceptance.mjs` | `node` | Disposable official DSH WebUI with selected candidate tarballs beside real npm metadata; fresh Add plugin and previous-release Check versions acceptance, SIGUSR2 to restart | `--dsh <lib/bin.js> --artifacts <directory> --state <empty-directory> [--previous dsh-mnemon@version] [--port number]`; no real model credentials |
| `verify-docs.mjs` | `pnpm run verify:docs` | Checks every local link and anchor in tracked Markdown, `blob/main` links included, a `docs/zh-CN` twin for each `docs/en` page, and that both READMEs name every official plugin | — |
| `verify-deterministic-build.mjs` | `pnpm run verify:build` | Builds the root package twice and compares the SHA-256 of every file under `lib/` | Must run through the package manager (`npm_execpath`) |
| `link-bundle-declarations.mjs` | `pnpm build` | Points the root package's emitted `dsh-mnemon/*` self-references at its bundled declarations | `tsconfig.json` paths |
| `package-locales.mjs` | Imported by the next two | Reads and validates a package's `locale/*.json` metadata | — |
| `verify-package-contents.mjs` | `pnpm run verify:package` | Dry-run pack of the root package: required and unexpected files, Host code in `lib/client.js`, absolute README image URLs and the unpacked-size ceiling | — |
| `verify-public-entries.mjs` | `pnpm run verify:package`; CI on Node 20 | Imports every public Node entry of the root, Memory Spaces and Layered strategy packages, checks that their declarations expose no private type, checks that `dsh-mnemon/client`'s declarations import only React and DSH's primitives and reach neither the Host protocol, the SDK nor a cordis Context augmentation, and runs each executable's `--help` | — |
| `verify-headless-profile.mjs` | `pnpm run verify:headless` | Installs the Starter into an isolated Headless profile of real DSH, runs one-shot tasks against a loopback model, and checks the Mnemon tools, the settings across a restart and the disabled Starter | `--package <spec> --registry <url>`, `--upgrade-from <spec> --upgrade-registry <url>`, `--strategy-extensions true`; `MNEMON_E2E_DSH` |
| `verify-plugin-artifacts.mjs` | `pnpm run verify:plugins` | Packs every package, verifies each plugin as its own repository outside the workspace through a loopback registry, then an external consumer and the packed Starter in real DSH, including an upgrade from an earlier release | `--skip-build`, `--keep`; `MNEMON_PLUGIN_VERIFY_CONCURRENCY` (default 4) |
| `verify-sync-git.mjs` | `pnpm run e2e:sync` | Two real DSH Web hosts over disposable homes publish to a real bare repository through the sync, settings, review and pack channels | `MNEMON_E2E_DSH`; `MNEMON_SYNC_E2E_KEEP=1` keeps the fixture |
| `installed-dsh.config.ts` | `pnpm run test:installed-dsh` | Runs the root tests with every `@deepseek-ai/*` import resolved from an installed DSH | `DSH_HOST_ROOT` (required) |
| `benchmark-algorithms.config.ts` | `pnpm bench:algorithms` | Runs `tests/algorithm-performance.measure.ts` in one worker | `MNEMON_BENCH_OUTPUT`, `MNEMON_BENCH_SIZES` |

## Release

[Releasing independent packages](../docs/en/development/releasing.md) describes the whole process.

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `release.mjs` | `pnpm run release:check`; `.github/workflows/publish.yml` | Computes the release plan. `--check` is read-only; `--pack`, `--publish-plugins`, `--verify-plugins`, `--publish-starter` and `--verify-release` are the publication steps | `--artifacts <dir>`, `--registry <url>`; `RELEASE_REVISION`, `RELEASE_BASE_REVISION`, `RELEASE_TAG`, `RELEASE_PRERELEASE`, `RELEASE_PUBLISH_CONCURRENCY` (default 4), `GITHUB_ACTIONS` (provenance) |
| `check-release-intent.mjs` | `pnpm run release:intent`; CI | Checks that every package whose published inputs changed has a changeset, or that a release pull request consumed them all | `CHANGESET_BASE_REVISION`, `CHANGESET_REVISION`: full SHAs, by default the merge base with `origin/main` and `HEAD` |
| `sync-release-metadata.mjs` | `pnpm run release:version` | Synchronizes the Starter's exact plugin pins, the external consumer's pins and the generated Provider version declarations | — |

## Real WebUI and Provider Lab

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `serve-e2e.mjs` | `pnpm e2e:serve` | Real DSH WebUI with disposable state and a loopback model; Ctrl-C removes the fixture and `SIGUSR2` restarts the WebUI on the same data. Its options are in the [development guide](../docs/en/development/README.md#fixture-options) | `MNEMON_E2E_PORT`, `MNEMON_E2E_DSH`, `MNEMON_E2E_EMBEDDING_DELAY_MS`, `MNEMON_CLI_PATH`; `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` with `--live-model` |
| `serve-sidebar-bundle-reproduction.mjs` | `node` | Published DSH with every packed plugin in disposable storage, for native Sidebar navigation and independent bundle activation | `--profile`, `--artifacts`, `--state` (an empty directory), `--port`, `--skin-center`, `--skin-market`; `MNEMON_CLI_PATH` |
| `seed-provider-lab.mjs` | `node`, as [Provider Lab](../provider-lab/README.md) describes | One active Provider Lab Memory Space per Provider, seeded through the public plugin composition | `MNEMON_DATA_DIR` (disposable roots only), `PROVIDER_LAB_ONLY`, `SUPERMEMORY_API_KEY`, `OPENVIKING_ROOT_API_KEY`, `BRV_PATH`, `MEM0_LLM_MODEL` |
| `probe-provider-lab.mjs` | `node` | Health report for the Provider Lab services; exits 1 when one is down | `OPENVIKING_ROOT_API_KEY` |

## Fixtures

Under `fixtures/`. Each scripted model answers for one `serve-e2e.mjs` option and prints its steps with its own prefix.

| File | Used by |
|---|---|
| `archive-copies.mjs` | `--archive-copies`: the working memory and copies seeded before the Host starts |
| `fake-embeddings.mjs` | `--archive-copies`, as its slow embedding service, and run with `node` for Mnemon CLI probes or as the endpoint in the Mnemon Native embedding settings: a deterministic embedding service that speaks Ollama's API at its root and the OpenAI-compatible one under `/v1`; `--port`, `--port-file`, `--delay-ms`, `--missing-model`, `--model`. `tests/fake-embeddings-fixture.spec.mjs` checks it, against a real Mnemon CLI too with `MNEMON_NATIVE_TEST_CLI` |
| `git-https-remote.mjs` | `tests/git-sync-credentials.spec.mjs`, and run with `node` for a WebUI check of Git sync over HTTPS: a Git remote on loopback, `git http-backend` behind HTTP Basic authentication that takes only the user names and tokens it is given, under a certificate openssl makes when it starts, which Git trusts through `GIT_SSL_CAINFO`; `--account <user>:<token>` (`*` as the user takes the token under any name), `--refuse <user>`, `--name <host>` (the certificate also names that host, which Git 2.37 and later reach here through `http.curloptResolve`), `--repository <path>`, `--port`, `--port-file` |
| `docs-demo.mjs` | `--docs-demo`, `--remember-target` and `--recall-budget`: the fictional Lumen project and its scripted model |
| `docs-demo-skills.mjs` | `--docs-demo`: the Lumen project's skills, seeded through the Skills Source, and the scripted model behind its review, draft and backtest |
| `document-archive-model.mjs`, `document-protection-model.mjs`, `exact-id-model.mjs`, `general-strategy-model.mjs`, `idle-review-model.mjs`, `legacy-session-replay-model.mjs`, `openviking-write-model.mjs`, `profile-compaction-model.mjs`, `recall-budget-model.mjs`, `remember-target-model.mjs`, `result-tool-cache-model.mjs`, `review-evidence-model.mjs`, `review-layers-model.mjs`, `runtime-routing-model.mjs`, `runtime-write-scope-model.mjs`, `save-action-model.mjs`, `strict-template-model.mjs` | The `serve-e2e.mjs` option of the same name |
| `delegated-completion.mjs` | The scripted models: reads the completion instructions a delegated child receives |
| `model-request-log.mjs` | `--log-model-requests`: the model, sender, tool count and reasoning settings that each `Fixture model request:` line adds |
| `openviking-protocol.mjs` | Run with `node` for `--openviking-write`: a deterministic OpenViking protocol server, not a live backend; `MNEMON_OPENVIKING_FIXTURE_PORT` (default 19335) |
| `openviking-user-key.mjs` | `tests/openviking-user-host.spec.mjs`: the user-key protocol of issue #271 |
| `electron-dsh-host.cjs` | `--electron`: runs the DSH CLI in an Electron main process |
| `electron-desktop-window.mjs`, `electron-desktop-preload.cjs` | Opens a running WebUI the way DSH Desktop does, at `dsh-app://app/`, for desktop-only checks such as #310; `DSH_HOST_URL`, `DSH_TRANSPORT`, `DSH_OFFSCREEN`, `DSH_LANG`, `--remote-debugging-port` |
| `packed-web-fixture.mjs` | Published DSH and packed plugins with disposable state, shared by `serve-runtime-metadata.mjs`, `serve-skin-hook.mjs` and `serve-sidebar-bundle-reproduction.mjs`; `--profile`, `--artifacts`, `--state`, `--port`; `MNEMON_CLI_PATH` |
| `serve-runtime-metadata.mjs` | Issue #280 acceptance: the importance and age lines of the runtime snapshot |
| `serve-runtime-user-branches.mjs` | Issue #281 acceptance: a user-profile entry replaced with an empty `branches` list; `--profile`, `--artifacts`, `--state`, `--port`; `MNEMON_CLI_PATH` |
| `serve-skin-hook.mjs` | Issue #273 acceptance: skin overrides of the workspace surface; `--skin-order before\|after\|none` |
| `serve-team-review.mjs` | Issue #275 acceptance: idle review beside the published DSH Agent Teams; `--profile`, `--artifacts`, `--state`, `--policy`, `--provider`; `MNEMON_CLI_PATH` |
| `plugin-consumer/` | `verify-plugin-artifacts.mjs` and the [plugin guide](../docs/en/development/extensions.md): an external Source, Strategy, Provider and Client built only on the packed public SDKs |

Other fixtures live beside the tests that use them, in `tests/fixtures/`; [the pre-extraction storage fixture](../tests/fixtures/upgrade/README.md) explains its own.
