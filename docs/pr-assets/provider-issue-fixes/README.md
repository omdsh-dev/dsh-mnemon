# Provider issue fixes, 2026-10-24

[简体中文](./README.zh-CN.md) · [Evidence index](../README.md)

Tested code: `868148eba31c78b2897cafb0333d490bee83eb1c`, based on main `a7e3bc549c777ada56ca703099eb61a7340b1da3`. Environment: macOS arm64, Node 24.22.1 and pnpm 10.13.1. Tests use synthetic memories, temporary local storage and controlled HTTP responses; no personal credentials or private memories are used.

## Scope and results

| Problem | Reproduced behavior | Fixed behavior and regression coverage |
|---|---|---|
| [#455](https://github.com/omdsh-dev/dsh-mnemon/issues/455), OpenViking writes | Removed `timeout` request field is rejected; metadata bytes invalidate an otherwise complete write | Send the common four fields, retain the client deadline, accept metadata-inclusive byte counts only with exact public readback and completed indexing. [Write tests](../../../plugins/dsh-mnemon-provider-openviking/tests/write-regression.spec.ts) cover old/new schemas, short writes, altered readback and timeouts. |
| Existing keyword channel in [#452](https://github.com/omdsh-dev/dsh-mnemon/issues/452) | Keyword mode invokes semantic search | Escape the complete query as a case-insensitive literal in `search/grep`; deduplicate scoped memory files and read their full text. [Keyword tests](../../../plugins/dsh-mnemon-provider-openviking/tests/keyword-search.spec.ts) cover versions, Windows paths, punctuation, Chinese, scope, the 256-line cap, unavailable endpoints and cancellation. |
| [#454](https://github.com/omdsh-dev/dsh-mnemon/issues/454), incompatible scores | Hindsight's boosted answer becomes unknown behind OpenViking score bands; unscored keyword results are capped as unknown | OpenViking, Hindsight and RetainDB declare native ordering. [Source tests](../../../plugins/dsh-mnemon-source-memory-spaces/tests/service.spec.ts) retain Hindsight scores 1.038/1.02 alongside OpenViking results, preserve non-monotonic provider order and keep five keyword hits. [Policy tests](../../../plugins/dsh-mnemon-source-memory-spaces/tests/recall-quality.spec.ts) retain normalized-provider limits and reject nonfinite scores. [Strategy tests](../../../plugins/dsh-mnemon-strategy-default-three-tier/tests/retrieval.spec.ts) enforce the existing six-result turn budget. |
| [#447](https://github.com/omdsh-dev/dsh-mnemon/issues/447), Holographic units | Source importance 3 becomes trust 1, ignoring defaultTrust | Importance 3 uses defaultTrust; each step adjusts trust by 0.1. [Driver tests](../../../plugins/dsh-mnemon-provider-holographic/tests/driver.spec.ts) verify units, minTrust on related reads, hidden receipts and legacy trust retention. Source coverage verifies the omitted-importance path. |
| RetainDB write and response compatibility | 1..5 importance and unsupported categories are rejected; nested hits disappear; queued or missing confirmation appears stored | Map importance to 0.5..0.9, use accepted memory types, request synchronous legacy writes, parse nested results and classify receipts. [Driver tests](../../../plugins/dsh-mnemon-provider-retaindb/tests/driver.spec.ts) cover Local/current/legacy responses, rejected writes and no fallback on authentication errors. |

[Composed Host tests](../../../tests/openviking-host.spec.mjs) use the [loopback OpenViking protocol fixture](../../../scripts/fixtures/openviking-protocol.mjs) for write/search/readback and account/Source isolation. Keyword searches return the stored full body and cannot retrieve the other account's memory.

## Verification

With the new/updated Provider and Source tests retained but production sources restored to main, the regression run produced **42 failed, 178 passed and one live-service test skipped**. Restoring the fixes passed the targeted checks. The final complete gate passed **681 plugin tests and 2,168 root tests**, with **10 opt-in tests skipped**.

```sh
# Run with Node 24.22.1 and pnpm 10.13.1.
pnpm run verify
pnpm run verify:plugins --skip-build
pnpm run release:intent
pnpm run verify:docs
git diff --check
```

- `verify`: passed documentation, all typechecks, deterministic double build, all workspace builds/tests, root Client/Host tests, real DSH Headless activation and package contents/public entries/lint.
- `verify:plugins --skip-build`: passed 18 independent plugin repositories and 19 packed artifacts, including an external SDK consumer, Starter upgrade and optional Strategy composition in real DSH.
- Release-intent coverage and final documentation/diff checks: passed.
- Environment diagnostics: the first run with pnpm 11 rejected the existing workspace dependency cycle. Node 25 then failed an unrelated Runtime symlink cleanup test. Using the CI toolchain resolved both without changing Runtime or build code. Upstream missing sourcemap warnings remain non-fatal.

## Compatibility and limits

The UI components, interactions and configuration keys are unchanged. Existing total result, content and turn budgets still apply. Native scores remain raw inspection values, not confidence estimates; no cross-provider reranker or new ranking setting is introduced. Upgrade Memory Spaces Source together with the changed Providers.

Holographic's version-1 store accepts an optional importance field for new facts; existing facts and trust are not migrated. The earlier version also loads the store; rolling back restores its prior trust mapping and read behavior. Provider upgrades do not delete remote memories. Unknown write outcomes must be inspected before retrying.

This record does not certify a live cloud account or LLM recall quality. Existing opt-in remote/CLI/model tests stay skipped. Grep may stop at 256 matching lines; the result reports that boundary. Keyword mode treats the whole query literally and does not introduce regex syntax, multi-term parsing or automatic semantic fallback. Official-plugin migration, Hermes mode, UI adapter plugins, per-space write policies and multimodal ingestion are deferred.
