# Exact-text keyword search in OpenViking spaces — issue #452

[简体中文](./README.zh-CN.md) | [Issue #452](https://github.com/omdsh-dev/dsh-mnemon/issues/452) | [Verification record](./verification.json)

Issue #452 reports that an OpenViking space can only be searched by meaning. An exact ID, a version, a path or an error code is then found unreliably or ranked below near neighbours, although OpenViking has an exact-text endpoint, `POST /api/v1/search/grep`.

Baseline: main `a7e3bc54`. The first runs took place on 2026-10-23 and the reruns after the review on 2026-10-24 (Asia/Shanghai), with this environment:

- macOS arm64, Node 24.19.0 and pnpm 10.13.1.
- OpenViking v0.4.21 from its Docker image, with API-key authentication.
- OpenViking 0.5.1.1 from PyPI on Python 3.12.13, in dev auth mode.

Both servers ran on loopback with `text-embedding-ada-002` embeddings (1,536 dimensions). Each held the same 64 synthetic notes under `viking://user/wp452/memories`:

- a PostgreSQL install path and service name;
- a Redis note and a laptop Docker note;
- a Document archive index that carries a SHA-256;
- 60 hosts, `fleet-000` to `fleet-059`, that differ only in their numbers (`Docker Engine 29.8.<n>`).

The review added a second set, which v0.4.21 holds under `viking://user/rv460/memories` and 0.5.1.1 under `viking://user/wp452atlas/memories`:

- six "Atlas sprint log" notes of 50 lines each, more lines saying "Atlas" than one grep returns;
- the newest note, "Atlas rollout: fleet-777 was upgraded to Docker Engine 29.9.1";
- notes holding `v5.2.2` and `Python3.12`, Chinese and Russian sentences, and a document with a SHA-256.

A third space on 0.5.1.1, `viking://user/wp452big/memories`, holds 512 one-line notes for the cost measurement. The provider's own write is refused by 0.5.1.1, which does not take its `timeout` field (#455), so the 0.5.1.1 sets were written through `content/write` directly, with the file names the provider gives.

## Cause

The provider sent every search, whatever its `mode`, to the semantic `search/find`. Direct search's **Keyword search** and `mnemon_recall` with `mode: "keyword"` therefore searched by meaning as well. Among notes that differ only in a number, the embedding cannot tell `29.8.37` from `29.8.36`.

## Fix

Keyword search in an OpenViking space now goes through `search/grep`:

- **The requests.** One `search/grep` asks for all the terms, at most 8, as alternatives. A grep returns at most 256 matching lines, walking files in name order, so when that one fills up, each term gets a grep of its own, and a common term cannot use up the lines a rare one needs. Each request sends `uri` (the space's memory root), `pattern` (the terms with their regular-expression characters escaped), `case_insensitive` and `node_limit: 256`. Every release from 0.4.16 to 0.5.2 declares all four.
- **Terms.** The query is split at whitespace. A phrase in straight or curly double quotes is one term, and grep finds it only on one line. A word loses the punctuation that ends a sentence, so `fleet-777?` looks for `fleet-777`. A one-character word such as `a` or `5` counts only when nothing else is asked for; a Chinese or Japanese character always counts.
- **Matching.** Terms match literally and in any case, but not from inside a number or a word: a digit may not touch a digit, nor a letter a letter of a script written with spaces.
  - `29.8.5` does not match `29.8.50`, `fleet-04` does not match `fleet-042`, and `кот` does not match `который`.
  - `5.2.2` matches `v5.2.2`, and `3.12` matches `Python3.12`.
  - Text in scripts written without spaces, such as Chinese, matches anywhere, and `API` matches inside `调用API接口`.
  - A hexadecimal ID of 7 or more characters, with both digits and letters, matches by its start: a short commit hash or image digest finds the full one, but not from the middle of a longer ID.

  The check runs in the provider, on every line any grep returned, against every term. The server gets the plain terms, because its keyword recall on remote vector backends reads the pattern as words.
- **Order.** Memories holding rarer terms, and more of them, come first: each term weighs by how few of the matched memories hold it, as BM25's inverse document frequency does. Among memories holding the same terms, the one Mnemon wrote last comes first, by the time in its file name, so an update ranks above what it replaced. Files without that time, such as OpenViking's own, follow in grep's order. Files outside the root and OpenViking's system files (`.abstract.md`, `.overview.md`) are left out.
- **Results.** The full memories are read back, as semantic search does, and they carry no score.
- **Hints.** The result says when terms past the eighth were not looked up, when a term filled its own grep (memories past that point may be missing), and when a matched file could not be read.
- **Edge cases.** An empty space, whose root does not exist yet, returns no results. A server without `search/grep`, which answers 404 without naming a resource or 405, gets a semantic keyword search, and the hint says so. Any other grep error is reported.
- **What does not change.** Smart recall, Basic match and searches without a mode take the semantic route exactly as before.

**Ask Agent** with **Keyword search** runs the same search and gives its results to the task Agent, so it now answers from exact-text matches.

The Document archive also looks a space up by content hash in keyword mode, to reuse an index an earlier attempt left. On OpenViking that lookup is now exact: the hash is found by its text, and the archive still checks the content before it reuses anything. The protocol fixture behind the host tests and the e2e harness now answers `search/grep` the way OpenViking does, files in name order and up to `node_limit` lines.

## Results

### Every version, one search each

Each search asks for `29.8.<n>` in keyword mode, with a limit of 10, for all 60 hosts:

| Server | main: exact host first | main: in the top 10 | main: missing | main: results per search | fix: exact host first | fix: results per search |
|---|---:|---:|---:|---:|---:|---:|
| v0.4.21 | 34 of 60 | 56 | 4 | 10 | 60 of 60 | 1.02 |
| 0.5.1.1 | 34 of 60 | 56 | 4 | 9.03 | 60 of 60 | 1.02 |

The fix's extra 0.02 is `29.8.0`, which the laptop note also holds. Mean time per search was 942 ms and 901 ms on main, against 13 ms and 12 ms with the fix.

### Five lookups

The same five lookups gave the same ranks on both servers:

| Query | main (rank, results) | Fix (rank, results) |
|---|---|---|
| `postgresql-x64-18` | 1, 10 | 1, 1 |
| `29.8.37` | 3, 8–10 (`fleet-031`, `fleet-036` first) | 1, 1 |
| `fleet-042` | 1, 2–10 | 1, 1 |
| the archive's SHA-256 | 1, 2–9 | 1, 1 |
| `"D:\Program Files (x86)\PostgreSQL\18"` | 1, 9 | 1, 1 |

### The review's cases: several terms, a common term, word edges

The second set, with a limit of 10. "Before" is this PR's first head, `0dc3fe63`, which sent all terms in one grep and stopped there. Each cell gives the rank of the memory sought and the number of results; both servers gave the same ranks unless the cell shows two.

| Query | Memory sought | main | Before | Fix |
|---|---|---|---|---|
| `Atlas fleet-777` | the rollout | 1 of 8 | missing, 6 sprint logs | 1 of 7, hint names "Atlas" |
| `Atlas` | the rollout | missing, 8 results | missing, 6 sprint logs | missing, the 6 sprint logs it reached, newest first; hint names "Atlas" |
| `the fleet-777` | the rollout | 1 of 7–8 | missing, 6 sprint logs | 1 of 7, hint names "the" |
| `Which Docker version runs on fleet-777?` | the rollout | 1 of 9 | 2 of 2 | 1 of 2 |
| `5.2.2` | the `v5.2.2` note | 4 of 6 / 1 of 8 | no results | 1 of 1 |
| `3.12` | the `Python3.12` note | 3 of 9 / 2 of 8 | no results | 1 of 1 |
| `猫 狗` | the Chinese note | 1 of 6 / 1 of 8 | no results | 1 of 1 |
| a 12-character SHA-256 prefix | the document | 1 of 8 | no results | 1 of 1 |
| a 7-character SHA-256 prefix | the document | 1 of 8 | no results | 1 of 1 |

`Atlas` alone shows the limit that remains: its grep stops at 256 lines, in the sixth sprint log, before it reaches the rollout. The result now says so, and adding `fleet-777` finds it. The fix took 7–66 ms per search, against 733–1,389 ms on main.

### Direct search through the Memory Spaces Source

Through the Source, Keyword search for `29.8.37` gives these results:

- **main:** 10 results, all ranked `high`, with the exact host third.
- **fix:** the exact host alone.

Smart recall gives the same 10 results before and after the fix.

### Cost against space size

The terms match nothing, so a grep reads every file, except `shard`, which all 512 notes hold. The times are medians of 7 keyword searches through the provider:

| Server | Memories | One term | Eight terms | `shard q-0137` | `shard` and seven terms |
|---|---:|---:|---:|---:|---:|
| 0.5.1.1 | 11 | 4 ms | 4 ms | | |
| 0.5.1.1 | 64 | 9 ms | 9 ms | | |
| 0.5.1.1 | 512 | 47 ms | 47 ms | 113 ms | 402 ms |
| v0.4.21 | 16 | 6 ms | 5 ms | | |
| v0.4.21 | 64 | 9 ms | 9 ms | | |

A grep that matches nothing reads every file under the root: `files_scanned` equals the number of memories on both servers. One grep costs about 0.09 ms per memory on 0.5.1.1, which reads each file in Python to remove its `MEMORY_FIELDS` metadata before matching. Eight terms cost what one does while their grep does not fill up. A common term fills it, and each term then gets a grep of its own: one for `shard`, which stops after 256 notes, and one that reads everything for each rare term. That is the 402 ms for eight terms. The times add up as if the server ran the greps of one search one after another, although the provider sends them together.

## Automated checks

```text
pnpm --filter dsh-mnemon-provider-openviking exec vitest run     # 116 passed, 1 skipped; on main 32 of the 33 keyword tests fail, on 0dc3fe63 13 do
pnpm --filter dsh-mnemon-provider-openviking run typecheck
pnpm --filter dsh-mnemon-provider-openviking run build
pnpm exec vitest run tests/openviking-host.spec.mjs tests/openviking-user-host.spec.mjs   # 4 passed; the archive test makes 3 grep calls
pnpm exec vitest run                                              # 2,836 passed, 10 skipped; one Documents test timed out at 5 s under load and passed alone
node scripts/verify-docs.mjs
```

The new tests run against fixture servers that grep the way OpenViking does: files in name order, at most `node_limit` lines, with the request models of 0.4.16 and 0.5.1.1. They cover:

- exact identifiers, literal versions, and quoted Windows paths in straight and curly quotes;
- word edges: numbers, letters, Cyrillic, Chinese, Latin inside Chinese, and hexadecimal ID prefixes;
- a phrase broken across lines;
- one grep while it holds every match, one per term once it fills up, more than 256 matching lines, and the hint;
- rarer terms first, the latest first among equals, files without a time last;
- question punctuation, one-character words, Chinese characters, and the 8-term cap;
- the root and system-file filters, the limit, and unreadable files;
- an empty space, a server without the route or refusing the method, and other errors;
- the unchanged semantic modes.

## Limits

- **How many results reach the model.** Unscored results count as `unknown` relevance in the recall quality policy: under the default `strict-v1`, a search of OpenViking alone keeps at most two of them, and model recall admits one per attempt. When the search also covers another Provider and both thresholds are at their defaults (#454), OpenViking's results keep OpenViking's own order instead: scored and unscored together, at most `maxRankedResults` per search (two by default), after the high-relevance results, and model recall admits them like high-relevance results. A unique ID or version needs only one; a keyword that matches many memories is still cut at two.
- **A common term.** Each grep returns at most 256 lines, walking files oldest first for Mnemon's files, so newer memories holding only a common term can be missing. The result names the term, and a rarer one finds them.
- **Cost.** A grep reads every memory file until it fills up, and 0.5.1.1 reads them in Python to remove its metadata first, so a keyword search takes longer as a space grows: about 0.09 ms per memory and grep on 0.5.1.1, and up to nine greps when a common term sits among eight.
- **No WebUI recording.** The Direct search page itself is unchanged; the Source-level run above uses the same `search` operation the page calls.
