# Bounded Runtime snapshot history

**English** | [简体中文](./README.zh-CN.md)

Issue: [#573](https://github.com/omdsh-dev/dsh-mnemon/issues/573). Base: `20ab2b57f4c6241165b08c415bfa802354eea11f`, dsh-mnemon 0.5.41. Verified on 2026-11-06 with Node 24.22.2. All memory is synthetic; model choices are scripted without external or paid API calls.

## Behavior and evidence

The original fix retired the previous snapshot on every change. Its regression fails when the next request must retain the complete previous prefix. The revised policy appends Runtime additions and age changes within a group of at most **four complete snapshots or 64 KiB UTF-8 text**. Another snapshot that would exceed either limit checkpoints the group to the complete current snapshot. A current snapshot larger than 64 KiB is retained alone without truncation. These thresholds are initial engineering defaults, not measured cache optima.

The real Host test explicitly uses the default-three-tier Strategy with Runtime, Documents and Memory Spaces ReadGrants, plus extra Runtime/Documents instances. Both native and PTC runs exercise real status/search tools. Across eight turns and 24 model requests, snapshot counts per turn are `1, 2, 3, 3, 3, 4, 1, 1`. JSONL unload/resume occurs both within the group and after checkpoint. Every request except the checkpoint retains the complete preceding model-message prefix and unchanged tool definitions. There is exactly one new request series for the budget checkpoint. Ordinary Runtime writes do not change the authority boundary or surface content generation.

Real requests also verify immediate checkpoint after corrections, deletions, branch changes, copied history in another workspace, withdrawn Documents grants with identical rendered snapshot text, and revoked Runtime projection permission. Disabling lifecycle injection, an own-plugin request or an unavailable View cannot bypass retirement. A rejected, aborted or empty first batch emits no request and writes no premature retirement; the next applicable request removes the stale snapshot. Existing delegated View leases and tool authority tests remain intact.

Five real Host middleware orderings cover global/scoped short-circuiting request hooks. Accepted-step cancellation and disposal write no queued retirement, and simulated append failure stops dispatch, records a hook cancellation and retries safely on the next turn. A real default light-context projection and JSONL reload verify truncated legacy retirement while retaining ordinary recalls and other producers.

Unit tests cover the exact UTF-8 byte boundary, oversized current content, metadata recovery, opaque grant narrowing, Source/mode/Route/Action/guidance changes, unknown provenance, and preservation of interleaved user, ordinary recall, guidance and other-producer messages. No Source content is interpreted as Host instructions. The latest snapshot is the current *projected* state; absence can mean filtering or budgets rather than storage deletion.

## Public Host contracts and persistence

Normal updates append user-role snapshot messages. Checkpoints use published Session `append()`, single-node `surfaceOp: replace`, and `sourceEventSeqs`. Empty `developer/message` content is the public Session representation that derives no model message; it contains no Source text, instructions or tool changes. A microtask queued by the durable `step/start` event commits retirement after synchronous Session publication and before the Host resumes awaited request preparation. It cannot be skipped by a later `agent/request` middleware returning without `next()`. Cancelled/disposed turns drop the pending plan; an append failure cancels the request with a visible hook error and preserves its inbox. Full originals and provenance remain in the append-only audit; interleaved conversation is not rewritten.

Host snapshot metadata contains version 1, an authority-boundary digest and visible-entry digests, not raw ReadGrants, paths or memory content. The boundary conservatively includes generation, scope, Source/mode, routes/actions, opaque grants, guidance and non-Runtime projections. Runtime owns the branch/storage scope and entry digests in fragment provenance. Ages are excluded from entry identity; removed/corrected entries force checkpoint. Truncated or unknown Source provenance is compared in full rather than granted additive-history behavior.

Old unmarked snapshots migrate once. Legacy `recall` rows require this producer's complete built-in Runtime envelope or its strictly recognizable official truncation: a shipped canonical introduction, file structure and the SDK's `…` at a known Wake boundary. This includes the published V3 `plugin` attribution and its `plugin:dsh-mnemon` V4 migration. Very short or unknown cuts, arbitrary recall, prefixed quotations and other producers remain untouched; a closing tag from another fragment cannot complete a partial quote. Stored Runtime JSON/Markdown and the existing projection budget are unchanged. Older Sources remain readable with conservative checkpoint behavior; rolling back the plugin leaves a valid audit but can restore snapshot accumulation. Cleanup requires the plugin to be active; unloading it removes its hooks. Already pinned/delegated View authority keeps its existing lifetime.

## Verification

At the review checkpoint: root typecheck passed; targeted lifecycle, guidance, state, Session and real Host suites passed **181 tests**; Runtime Source provenance suite passed **6 tests**. Complete verification and the installed-Host matrix are being recorded separately before submission.

Installed-Host command (each published release uses its own installation):

```sh
DSH_HOST_ROOT=<installed-dsh-package> pnpm exec vitest run --config scripts/installed-dsh.config.ts tests/memory-snapshot.spec.ts tests/memory-snapshot-state.spec.ts tests/turn-view-host.spec.ts
pnpm run verify
```

No provider hit-rate measurement is claimed. [DeepSeek's cache documentation](https://api-docs.deepseek.com/guides/kv_cache/) requires matching persisted prefixes and describes caching as best-effort. These tests establish request-prefix stability, not remote cache persistence, token savings or model reasoning quality. They reload real JSONL persistence but do not claim a Windows Electron process restart or recreation of the reporter's private 1,206-turn conversation. Audit records and empty surface nodes continue to grow append-only.
