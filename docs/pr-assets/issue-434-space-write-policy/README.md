# Read-only Memory Spaces: issue #434

**English** | [简体中文](./README.zh-CN.md) | [Issue #434](https://github.com/omdsh-dev/dsh-mnemon/issues/434) | [Verification record](./verification.json)

Issue #434 asks for two things at once. An existing namespace, such as a Hindsight bank another tool still writes, should stay readable. Every new write from DSH should go only to a namespace chosen for it. This is the first step of the Provider strategy in the plan of [PR #457](https://github.com/omdsh-dev/dsh-mnemon/pull/457): any namespace besides the one DSH writes to is read only.

Tested on branch `claude/feat-434-space-write-policy`, written on main `a7e3bc54` (v0.5.34), on 2026-10-23 (Asia/Shanghai), with macOS arm64, Node 24.19.0 and pnpm 10.13.1.

The Provider was the Hindsight of `provider-lab/` (its official GHCR standalone image) at `127.0.0.1:18889`. It was reached through a counting proxy on `127.0.0.1:19660` that logged every request. Two banks were made for this record:

- `wp434-legacy` was seeded with two memories directly through the Hindsight API, as another tool would write them.
- `wp434-dsh` started empty.

Both banks use Hindsight's `chunks` extraction mode, which needs no LLM; the lab's Ollama was not running. Recall uses Hindsight's local embeddings and reranker.

## What changed

- **An explicit choice.** The space's **Edit** dialog has **Writes**: **Writable** ("DSH can save, forget and link memories here.") or **Read only** ("Still recalled; DSH no longer saves, forgets, links or archives memories here."). The card of a read-only space shows **Read only**. The same choice is the Source management operation `body-write-policy`, `{ memoryBodyId, policy: 'writable' | 'read-only' }`, which needs confirmation as every management mutation does. The page client calls it through `setWritePolicy`, and no Agent tool reaches it.
- **Refused before the Provider is called.** The Memory Spaces service checks the policy on disk when a write is dispatched, not when a View was composed. It checks for remember, each destination and each item of a batch, forget, link, merging into a space, deleting a Mnemon Native Store and filling its vectors. Every path the Agent, the page, the task Agent and the Host take ends there. A refusal names the space and makes no Provider call.
- **The namespace, not the card.** A read-only entry names the namespace by its externalId, or by the settings that name it, with defaults filled in. A Mnemon Native Store is named by its id. So a space made by hand for the same bank, a reconnect, a rediscovery, switching a space on and a wildcard read are all read only too. A space whose settings move to another namespace takes that namespace's policy.
- **No fallback.** A write that names no space goes to the one active writable space. With none, or several, it asks for one. The Source's facts offer no link or forget through read-only spaces, and its `archivableCount` leaves them out. The write scope given to Host writers leaves them out, the task Agent's target check refuses them, and its tool guard keeps the writer off them. Save to memory does not list them. With every space read only, Runtime capacity and Document archival take the local-archive path.
- **What the model sees.** The directory a model inspects marks a read-only space `writePolicy: 'read-only'` and gives it `remember`, `link` and `forget` as `false`.
- **Where it is kept.** The policy is kept in `state/memory-provider-write-policy.json`, beside the Provider connections. It is kept in its own file because older builds rewrite the space registry and drop fields they do not know. The file exists only while some space is read only. A file that cannot be read makes every space read only until it is fixed or removed, and recall keeps working.
- **Spaces without the policy are unchanged.** No file is written, no field is added, and the revision encoding is the same. The errors for spaces without a policy are the same as before.

## Result on real Hindsight

The same scenario ran on main and on the branch, against the same two banks, the branch first so that main's writes could not change what the branch saw. Each row is one call into the Memory Spaces service, the call the Source makes for the Agent, the page and the Host.

| Write | main `a7e3bc54` | branch |
|---|---|---|
| Remember, naming the legacy space | Written: `POST /memories` to `wp434-legacy` | Refused, no request |
| A batch, naming the legacy space | Written: `POST /memories` | Refused, no request |
| Forget a legacy memory | Written: `PATCH /memories/<id>` invalidated it | Refused, no request |
| A capture naming no space, with the legacy space the only active one | Written: `POST /memories` | Refused ("no active memory space takes writes"), no request |
| Remember, naming the DSH space | Queued in `wp434-dsh` | Queued in `wp434-dsh` |
| Remember naming no space, both spaces active | Refused: "memoryBodyId is required" | Queued in `wp434-dsh`, the one writable space |
| Recall across both spaces | Both banks | Both banks |

| Count | main | branch |
|---|---|---|
| Hindsight mutations of `wp434-legacy` | 4 (3 `POST`, 1 `PATCH`) | 0 |
| Memories in `wp434-legacy`, before → after | 2 → 4 (three added, one invalidated) | 2 → 2 |
| Hindsight mutations of `wp434-dsh` | 1 | 2 (`POST /memories`) |
| Memories in `wp434-dsh`, before → after | 4 → 5 | 2 → 4 |

On the branch, each receipt from the DSH bank says `queued`, with completion `accepted`, never `committed`. Hindsight extracts in the background, and the policy does not change how such a receipt reads. `wp434-dsh` held two memories before the branch run. They came from an earlier run of the same branch scenario, whose recall ran before Hindsight had stored its writes; that run is not recorded.

## Tests

- `plugins/dsh-mnemon-source-memory-spaces/tests/write-policy.spec.ts` drives the real Source with a counting bank Provider. One test covers each write path: View remember, forget and link, and management remember, a batch, forget and link. Further tests cover these cases: a legacy id named explicitly, while the space is inactive and after it is switched on; a space made by hand for the same bank; a space whose settings move to that bank; a disconnect followed by a new mount; a policy changed after a View was composed; the default destination; no fallback; and the facts and write scope. Over Mnemon Native, the tests cover these cases: no Store-changing command for remember, a batch, forget, link, merge, vector fill or delete; a batch stopped at a destination that turned read only; an unreadable or unsupported file; a restart and another data directory; and no change without a policy.
- `write-policy-page.spec.tsx` renders the real page against the real Source. It covers the choice, the badge and changing back.
- Root tests cover the rest. The layer-combination matrix gains a read-only space for MEMORY.md and Document archival through the Agent tool, the web page and the Host's own path, and for what the View offers. The task Agent's target check and tool guard are tested, the Save to memory place list leaves read-only spaces out, and **Fill in** is not offered for a read-only Native space.

```text
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run   # 307 passed, 2 skipped
pnpm exec vitest run --dir tests                                # 2,176 passed, 7 skipped
pnpm run typecheck && pnpm --filter dsh-mnemon-source-memory-spaces run typecheck
pnpm --filter dsh-mnemon-source-memory-spaces run build && pnpm run build
MNEMON_CLI_PATH=/nonexistent/mnemon pnpm run verify:plugins
node scripts/verify-docs.mjs
```

## Limits

- No WebUI recording. The page test renders the real page against a real Source and real Providers.
- Hindsight is never an archive destination, because its writes are async-extracting. Archival into a read-only Hindsight bank cannot happen on either version, so archival is checked with Mnemon Native in the layer matrix.
- The task Agent writer needs a model. Its target check and tool guard are checked in the Host tests, not live.
- A Pack restore and Git sync copy whole stores. The policy governs DSH's own writes, so it does not stop them. Neither carries the policy file, and neither removes it.
