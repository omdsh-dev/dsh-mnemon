# Exact-text keyword search in OpenViking spaces — issue #452

[简体中文](./README.zh-CN.md) | [Issue #452](https://github.com/omdsh-dev/dsh-mnemon/issues/452) | [Verification record](./verification.json)

Issue #452 reports that an OpenViking space can only be searched by meaning. An exact ID, a version, a path or an error code is then found unreliably or ranked below near neighbours, although OpenViking has an exact-text endpoint, `POST /api/v1/search/grep`.

Baseline: main `a7e3bc54`. The runs took place on 2026-10-23 (Asia/Shanghai) with this environment:

- macOS arm64, Node 24.19.0 and pnpm 10.13.1.
- OpenViking v0.4.21 from its Docker image, with API-key authentication.
- OpenViking 0.5.1.1 from PyPI on Python 3.12.13, in dev auth mode.

Both servers ran on loopback with `text-embedding-ada-002` embeddings (1,536 dimensions). Each held the same 64 synthetic notes under `viking://user/wp452/memories`:

- a PostgreSQL install path and service name;
- a Redis note and a laptop Docker note;
- a Document archive index that carries a SHA-256;
- 60 hosts, `fleet-000` to `fleet-059`, that differ only in their numbers (`Docker Engine 29.8.<n>`).

## Cause

The provider sent every search, whatever its `mode`, to the semantic `search/find`. Direct search's **Keyword search** and `mnemon_recall` with `mode: "keyword"` therefore searched by meaning as well. Among notes that differ only in a number, the embedding cannot tell `29.8.37` from `29.8.36`.

## Fix

Keyword search in an OpenViking space now goes through `search/grep`:

- **The request.** It sends `uri` (the space's memory root), `pattern`, `case_insensitive` and `node_limit`. Every release from 0.4.16 to 0.5.2 declares all four.
- **Terms.** The query is split on whitespace, and a double-quoted phrase is kept whole. Each term is sent as a literal, with its regular-expression characters escaped, and is matched in any case.
- **Whole words.** A match counts only as a whole word. Where a term starts or ends with an ASCII letter or digit, the character beside it may not be one, so `29.8.5` does not match `29.8.50`. Text in scripts without spaces, such as Chinese, matches anywhere. The server is asked for the plain terms, because its keyword recall on remote vector backends reads the pattern as words; the word check runs in the provider.
- **Order.** A memory holding more of the terms comes first; otherwise grep's order is kept. Files outside the root and OpenViking's system files (`.abstract.md`, `.overview.md`) are left out.
- **Results.** The full memories are read back, as semantic search does, and they carry no score.
- **Edge cases.** An empty space, whose root does not exist yet, returns no results. A server without `search/grep` answers semantically and says so in the result's hint.
- **What does not change.** Smart recall, Basic match and searches without a mode take the semantic route exactly as before.

The Document archive also looks a space up by content hash in keyword mode, to reuse an index an earlier attempt left. On OpenViking that lookup is now exact: the hash is found by its text, and the archive still checks the content before it reuses anything. The protocol fixture behind the host tests and the e2e harness now answers `search/grep` the way OpenViking does.

## Results

### Every version, one search each

Each search asks for `29.8.<n>` in keyword mode, with a limit of 10, for all 60 hosts:

| Server | main: exact host first | main: in the top 10 | main: missing | main: results per search | fix: exact host first | fix: results per search |
|---|---:|---:|---:|---:|---:|---:|
| v0.4.21 | 34 of 60 | 56 | 4 | 10 | 60 of 60 | 1.02 |
| 0.5.1.1 | 34 of 60 | 56 | 4 | 9.03 | 60 of 60 | 1.02 |

The fix's extra 0.02 is `29.8.0`, which the laptop note also holds. Mean time per search was 942 ms and 901 ms on main, against 17 ms and 12 ms with the fix.

### Five lookups

The same five lookups gave the same ranks on both servers:

| Query | main (rank, results) | Fix (rank, results) |
|---|---|---|
| `postgresql-x64-18` | 1, 10 | 1, 1 |
| `29.8.37` | 3, 8–10 (`fleet-031`, `fleet-036` first) | 1, 1 |
| `fleet-042` | 1, 2–10 | 1, 1 |
| the archive's SHA-256 | 1, 2–9 | 1, 1 |
| `"D:\Program Files (x86)\PostgreSQL\18"` | 1, 9 | 1, 1 |

### Direct search through the Memory Spaces Source

Through the Source, Keyword search for `29.8.37` gives these results:

- **main:** 10 results, all ranked `high`, with the exact host third.
- **fix:** the exact host alone.

Smart recall gives the same 10 results before and after the fix.

## Automated checks

```text
pnpm --filter dsh-mnemon-provider-openviking exec vitest run     # 97 passed, 1 skipped; on main 13 of the 14 new tests fail
pnpm --filter dsh-mnemon-provider-openviking run typecheck
pnpm --filter dsh-mnemon-provider-openviking run build
pnpm exec vitest run tests/openviking-host.spec.mjs tests/openviking-user-host.spec.mjs   # 4 passed; the archive test makes 3 grep calls
pnpm exec vitest run                                              # 2,818 passed, 10 skipped
node scripts/verify-docs.mjs
```

The new tests run against fixture servers that grep the way OpenViking does, with the request models of 0.4.16 and 0.5.1.1. They cover:

- exact identifiers;
- literal versions;
- quoted Windows paths;
- whole words;
- Chinese text;
- ordering by terms matched;
- the root and system-file filters;
- the limit;
- an empty space;
- a server without `search/grep`;
- the unchanged semantic modes.

## Limits

- **How many results reach the model.** Unscored results count as `unknown` relevance in the recall quality policy. Under the default `strict-v1`, a search keeps at most two of them, and model recall admits one per attempt. A unique ID or version needs only one; a keyword that matches many memories is cut by that policy, which #454 is about.
- **No WebUI recording.** The Direct search page itself is unchanged; the Source-level run above uses the same `search` operation the page calls.
