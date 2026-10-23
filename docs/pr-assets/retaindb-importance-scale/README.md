# RetainDB importance on its 0-1 scale

[简体中文](./README.zh-CN.md) | [Verification record](./verification.json)

The Memory Spaces Source gives every memory an integer importance from 1 to 5, and 3 when the writer gives none.
The RetainDB Provider sent that number to RetainDB as is, but RetainDB takes an importance from 0 to 1.

Baseline: main `a7e3bc54`. The runs took place on 2026-10-23 and 2026-10-24 (Asia/Shanghai) on macOS arm64 with
Node 24.19.0 and pnpm 10.13.1. All memories are synthetic.

The evidence:

- RetainDB's own source at `2ad2cc4d`, for RetainDB Server and RetainDB Local;
- request-level checks of the bodies the Provider sends: unit tests, and a probe through the real Memory Spaces
  Source to a loopback recorder;
- a replay of those bodies against RetainDB Server's own request schema;
- a live run against RetainDB Local 0.2.2 from the provider lab, on main and with the fix.

No RetainDB Server and no hosted service was run. RetainDB's README presents Server and Cloud together, as one API
layer around the same memory model; Cloud itself was not observed.

## RetainDB's contract

Links point to [RetainDB/RetainDB](https://github.com/RetainDB/RetainDB) at `2ad2cc4d`.

- **RetainDB Server**, the self-hostable API in `packages/server`, refuses an importance above 1.
  - `POST /v1/memory` and the legacy `POST /v1/memories` both declare
    `importance: z.number().min(0).max(1).optional().default(0.5)`
    ([`api/memory.ts:932`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L932),
    [`api/routes.ts:2588`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2588)).
  - Both parse the body with `@hono/zod-validator` 0.4.3, which answers a failed parse with HTTP 400.
  - The database and the write path default to 0.5
    ([`prisma/schema.prisma:230`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/prisma/schema.prisma#L230),
    [`engine/memory/write.ts:707`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/engine/memory/write.ts#L707)).
  - Its contract registry says "importance must be between 0 and 1 when provided"
    ([`contracts/registry.mjs:351`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/contracts/registry.mjs#L351)).
- **RetainDB Local 0.2.2** defaults to 0.62. It stores
  `clamp((importance ?? 0.62) + quality * 0.28 + typeWeight * 0.12, 0.1, 0.99)` and adds that to every recall score
  ([`local/src/cli.ts:728`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L728),
  [`:904`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L904)).
  Any importance of 1 or more is stored at 0.99.
- **RetainDB's own writers** use about 0.5 to 0.9.
  - Its SDK's extraction sends `max(0.5, min(1, confidence || 0.7))`
    ([`sdk/src/whisper-agent.ts:284`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/sdk/src/whisper-agent.ts#L284)).
  - RetainDB Local's own writes use 0.55 to 0.92
    ([`cli.ts:804`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L804),
    [`:1838`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L1838)).
  - One client, Hermes Agent's RetainDB provider, also sends 0.7 by default
    ([`plugins/memory/retaindb/__init__.py:148`](https://github.com/NousResearch/hermes-agent/blob/419e6627aaeda9c87e0b17bcc013484a2bfdb194/plugins/memory/retaindb/__init__.py#L148)).

## Cause

- The Source sends every Provider an integer importance from 1 to 5, and 3 when the writer gives none:
  `prepareRemember` in `plugins/dsh-mnemon-source-memory-spaces/src/service.ts` calls
  `integer(request.importance, 3, 1, 5)` from `src/sdk/input.ts` for both `remember` and `rememberMany`.
- The Provider sent `importance: request.importance ?? 0.7`. An importance always arrives through the Source, so the
  0.7 fallback never applied, and RetainDB received 1 to 5.
- **On RetainDB Server**, main's writes with importance 2 to 5, the Source's default 3 included, were refused with
  HTTP 400. They were not flattened to the top: they were not stored at all. The replay below shows it.
- **On RetainDB Local**, every memory was stored at 0.99, so importance no longer told memories apart in recall. The
  live run below shows it.

## Fix

- `remember` maps the Source's importance onto 0.5 to 0.9, the band RetainDB's own writers use: 3 is sent as 0.7,
  and each step above or below moves it by 0.1, rounded to two decimals so that 1 is sent as 0.5 and not
  0.49999999999999994.
- The input is read as the Holographic Provider reads it (#459): rounded to a whole step and clamped to 1 to 5, so 9
  is sent as 0.9 and 2.4 as 0.6. A value that is not a finite number counts as none. The Source sends neither.
- A request without an importance is sent as 0.7, as before. It reaches the Provider only when the Provider is called
  without the Source.
- The legacy `POST /v1/memories` fallback sends the same value, since it is the same body without `write_mode`.
- Nothing maps back. The Provider reads search and list results without an importance, only their id, content,
  score, type and creation time, so recall and browse show no RetainDB importance, before or after the fix.
- Memories already in RetainDB are not rewritten.

| Importance at the Provider | main sends | Fix sends |
|---|---|---|
| 1 | 1 | 0.5 |
| 2 | 2 | 0.6 |
| 3, also what the Source sends when the writer gives none | 3 | 0.7 |
| 4 | 4 | 0.8 |
| 5 | 5 | 0.9 |
| none (the Provider called without the Source) | 0.7 | 0.7 |

## Through the Memory Spaces Source

[`importance.probe.mjs`](./importance.probe.mjs) mounts the real Memory Spaces Source with the RetainDB Provider and
enables RetainDB against a loopback recorder that answers RetainDB's project and memory routes. It then writes three
memories through `remember` and records the importance in each `POST /v1/memory` body.

| Memory | Importance written | main sends | Fix sends |
|---|---|---|---|
| Release notes are drafted on Monday | 1 | 1 | 0.5 |
| Release approvals need a completed canary | 5 | 5 | 0.9 |
| Release branches are cut from main | none (the Source sends 3) | 3 | 0.7 |

## Against RetainDB Server's schema

[`server-schema.probe.mjs`](./server-schema.probe.mjs) writes every Memory Spaces category at importance 1, 3 and 5
through the real Source and Provider to a loopback recorder. It runs once with `POST /v1/memory` answered and once with
it refused with 404, so that the Provider falls back to `POST /v1/memories`. It then parses each body with the
Server's own request schema for that endpoint. The schemas copy the fields the Provider sends from `api/memory.ts`
and `api/routes.ts`, and run on zod 3's API, which the Server uses.

| Category | main on `/v1/memory`: 1 / 3 / 5 | Fix on `/v1/memory`: 1 / 3 / 5 |
|---|---|---|
| `preference`, `decision` | accepted / 400 `importance` / 400 `importance` | accepted / accepted / accepted |
| `fact`, `insight`, `context`, `general` | 400 `memory_type` / 400 `memory_type`, `importance` / the same | 400 `memory_type` at every importance |

| Endpoint | main accepts | Fix accepts |
|---|---|---|
| `POST /v1/memory` | 2 of 18 | 6 of 18 |
| `POST /v1/memories` (legacy) | 0 of 18 | 0 of 18 |

The importance is now always accepted. The remaining refusals come from an older, separate bug. The Provider sends
the Source's category as RetainDB's `memory_type`, and the Server takes neither `fact`, `insight`, `context` nor
`general` on `/v1/memory`; the legacy endpoint takes only `factual`, `episodic`, `semantic` and `procedural`. That
mapping is fixed in the pull request stacked on this one.

## Against RetainDB Local

[`live.probe.mjs`](./live.probe.mjs) ran against RetainDB Local 0.2.2 from the provider lab: the `retaindb` service in
[`provider-lab/`](../../../provider-lab/README.md), with hash embeddings, on `http://127.0.0.1:18990`. The container
had been stopped. It was started for these runs, stopped again afterwards, and its volume was kept.

Each run used a new project of its own and user `rv462`: `rv462-main` with main's driver, `rv462-fix` with the fix.
Each run then:

1. wrote four memories through the real Memory Spaces Source. They share their wording and length, so RetainDB Local
   gives all four the same type (`workflow`) and quality (0.275), and only the importance differs;
2. read back what RetainDB Local stored;
3. searched `release step check before tagging the version` with the request the Provider sends;
4. searched the same words through the Source.

| Importance written | main: stored importance | Fix: stored importance |
|---|---|---|
| 1 | 0.99 | 0.661 |
| 3 | 0.99 | 0.861 |
| 5 | 0.99 | 0.99 |
| none (the Source sends 3) | 0.99 | 0.861 |

RetainDB Local added 0.161 to each importance it received (quality 0.275 × 0.28, plus the `workflow` weight
0.7 × 0.12), then capped it at 0.99, so the fix's 0.9 also reached the cap. Its `strength` follows the importance too:
0.855 for importance 1 and 1 for the others on main, and 0.605, 0.705, 0.805 and 0.705 with the fix.

| RetainDB Local's recall | main: importance written (score) | Fix: importance written (score) |
|---|---|---|
| 1st | 3 (11.1374) | 5 (11.0862) |
| 2nd | 5 (11.1118) | 3 (10.9820) |
| 3rd | 1 (11.0614) | none (10.8307) |
| 4th | none (10.9846) | 1 (10.8092) |

On main, every memory carried 0.99, so small differences in relevance set the order, and importance 1 ranked above a
memory of importance 3. With the fix, the stored importance sets it: 5 first, 3 and none next, 1 last.

Through the Source, the default `strict-v1` recall keeps at most two results whose score lies outside 0 to 1, as
RetainDB Local's scores do. It returned 3 then 5 on main, and 5 then 3 with the fix. Their scores run 0.3386 higher
than in the direct search because that search ran first: it raised each memory's access count, and RetainDB Local
adds `log1p(accessCount) / 5 + 1 / sqrt(max(1, hoursSinceAccess)) / 5` to the next search's score, 0.1386 + 0.2 here.

## Limits on RetainDB Local

- **Rich texts saturate.** The bonus RetainDB Local adds, `quality × 0.28 + typeWeight × 0.12`, grows with the text,
  and the cap is 0.99. [`local-saturation.mjs`](./local-saturation.mjs) applies RetainDB Local's own rules, transcribed
  from `cli.ts`, to five texts. For the first, the live probe's text, it gives the values the live run stored.

  | Text (type, quality) | main: 1 to 5 | Fix: 1 to 5 |
  |---|---|---|
  | Release step one: check the changelog before tagging the version (`workflow`, 0.275) | 0.99 for all | 0.661, 0.761, 0.861, 0.961, 0.99 |
  | The user prefers concise answers in Chinese. (`preference`, 0.178) | 0.99 for all | 0.636, 0.736, 0.836, 0.936, 0.99 |
  | Use pnpm 10 for installs because npm breaks the lockfile in CI. (`decision`, 0.55) | 0.99 for all | 0.748, 0.848, 0.948, 0.99, 0.99 |
  | Never push to main without a reviewed PR; the release workflow in .github/workflows/publish.yml must pass first. (`constraint`, 0.685) | 0.99 for all | 0.782, 0.882, 0.982, 0.99, 0.99 |
  | We decided to keep plain chunk retrieval and only add semantic signal where information is lost; the hybrid test passed on LoCoMo and LME. (`decision`, 0.822) | 0.99 for all | 0.824, 0.924, 0.99, 0.99, 0.99 |

  For the rich decision, importance 3, 4 and 5 store the same 0.99.
- **Memories stored before keep 0.99.** Memories that main wrote to RetainDB Local carry 0.99, and recall adds it to
  their scores, so they outrank new memories of similar relevance. Their original importance was lost to the clamp,
  so rewriting them would guess at it.

## Reproduce

The fix columns come from this branch after `pnpm build && pnpm -r build`. For the main columns, build the Provider
from main's driver first, then restore it:

```text
git show origin/main:plugins/dsh-mnemon-provider-retaindb/src/driver.ts > plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
node docs/pr-assets/retaindb-importance-scale/importance.probe.mjs <main.json>
node docs/pr-assets/retaindb-importance-scale/server-schema.probe.mjs <main.json>
node docs/pr-assets/retaindb-importance-scale/live.probe.mjs http://127.0.0.1:18990 rv462-main <main.json>
git checkout -- plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
```

Then run the same probes for the fix, with `rv462-fix` for the live run. `live.probe.mjs` refuses a project RetainDB
Local already has, because RetainDB Local returns or merges a repeated memory instead of storing it again.

```text
pnpm --filter dsh-mnemon-provider-retaindb exec vitest run     # 16 passed; on main's driver, 8 of the 9 new tests fail
pnpm --filter dsh-mnemon-provider-retaindb run typecheck
pnpm --filter dsh-mnemon-provider-retaindb run build
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run  # 296 passed, 2 skipped
node docs/pr-assets/retaindb-importance-scale/local-saturation.mjs
node scripts/verify-docs.mjs
```

The new unit tests check:

- the whole body sent for importance 1 to 5;
- the 0.7 sent for a request without an importance;
- rounding to a whole step and clamping to 1 to 5;
- a value that is not a finite number counting as none;
- the same importance on the legacy endpoint.

On main's driver, the test without an importance passes, because main also sent 0.7 then. The other eight fail.

## Limits

- No RetainDB Server and no hosted service was run. The Server's verdicts come from its own schema, parsed as the
  Server parses it. Cloud was not observed.
- The live run used RetainDB Local with the hash embeddings the provider lab configures. Its two projects and eight
  memories remain in the lab's store; the lab's `dsh-lab` project kept its six memories.
- No WebUI recording was made. The interface is unchanged, and RetainDB memories show no importance before or after.
