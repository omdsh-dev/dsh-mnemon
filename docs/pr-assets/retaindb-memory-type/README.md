# RetainDB memory types, legacy writes and read-back

[简体中文](./README.zh-CN.md) | [Verification record](./verification.json)

This record is stacked on #462, which maps importance onto RetainDB's 0-1 scale
([its record](../retaindb-importance-scale/README.md)). It covers three fixes to how the RetainDB Provider writes
and reads memories:

1. **Memory types.** The Provider sent the Memory Spaces category as RetainDB's `memory_type`
   (`memory_type: request.category ?? 'factual'`). The Source always sends a category: `general` by default, and
   `context` for Runtime and document archives (`src/host/runtime-capacity.ts`, `src/host/document-archive.ts`).
2. **[Legacy writes and receipts](#legacy-writes-and-receipts).** The legacy endpoint queued every write while the
   Provider's receipt said it was stored.
3. **[Reading types back](#reading-types-back).** Categories read back as RetainDB's own type, or as `general` from
   RetainDB Local's search.

Baseline: `claude/fix-retaindb-importance-scale` at `c841066f` (#462). The runs took place on 2026-10-24
(Asia/Shanghai) on macOS arm64 with Node 24.19.0 and pnpm 10.13.1. All memories are synthetic.

The evidence:

- RetainDB's own source at `2ad2cc4d`;
- unit tests of the type the Provider sends to each endpoint, of its receipts, and of the categories it reads back;
- a replay of the exact bodies against RetainDB Server's own request schema;
- a live run against RetainDB Local 0.2.2 from the provider lab, before and after the type fix.

No RetainDB Server and no hosted service was run. Cloud was not observed.

## RetainDB's types

Links point to [RetainDB/RetainDB](https://github.com/RetainDB/RetainDB) at `2ad2cc4d`.

- **`POST /v1/memory`** declares `memory_type: z.enum(MEMORY_TYPE_VALUES).optional()`
  ([`api/memory.ts:924`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L924)).
  - The list holds 16 types: `factual`, `episodic`, `semantic`, `procedural`, `preference`, `event`, `relationship`,
    `opinion`, `goal`, `instruction`, `decision`, `constraint`, `solution`, `project_state`, `correction` and `workflow`
    ([`:63-80`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L63-L80)).
  - It has no `general`, `fact`, `insight` or `context`.
  - `@hono/zod-validator` 0.4.3 answers a type outside the list with HTTP 400.
- **The legacy `POST /v1/memories`** declares
  `memory_type: z.enum(["factual", "episodic", "semantic", "procedural"]).optional().default("factual")`
  ([`api/routes.ts:2584`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2584)).
- **The Server falls back to `factual`.** Its write path folds `semantic` into `factual`, `episodic` into `event` and
  `procedural` into `instruction`, and any other name into `factual`
  ([`engine/memory/write.ts:140-161`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/engine/memory/write.ts#L140-L161),
  [`api/memory.ts:104-107`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L104-L107)).
- **RetainDB Local** takes any type. It infers a type from the text and otherwise falls back to the type it was sent,
  reading `fact` and any name it does not know as `factual`
  ([`local/src/cli.ts:173-201`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L173-L201),
  [`:302-316`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L302-L316)).

## Cause

The Provider sent the category itself. On RetainDB Server:

- `POST /v1/memory` refused every memory of category `fact`, `insight`, `context` or `general`, the Source's default
  included;
- the legacy endpoint refused every memory, since it takes none of the six category names.

With #462, `POST /v1/memory` still refused 12 of 18 category and importance combinations, and the legacy endpoint all
18.

## Fix

- On `POST /v1/memory`, `preference` and `decision` keep their names. `fact`, `insight`, `context` and `general` are
  sent as `factual`.
- The legacy `POST /v1/memories` receives `factual` for every category, since it takes no `preference` or `decision`.
- A request without a category is still sent as `factual` on both endpoints.
- `factual` is the type RetainDB Server and RetainDB Local fall back to themselves, and the type the Provider already
  sent when no category reached it.
- Reading back maps `preference` and `decision` back to those categories; see [Reading types back](#reading-types-back).

## Against RetainDB Server's schema

[`server-schema.probe.mjs`](../retaindb-importance-scale/server-schema.probe.mjs), from #462's record, writes every
category at importance 1, 3 and 5 through the real Source and Provider to a loopback recorder. It runs once with
`POST /v1/memory` answered and once with it refused with 404, so that the Provider falls back to
`POST /v1/memories`. It then parses each body with the Server's own request schema for that endpoint. The table holds
for importance 1, 3 and 5 alike.

| Category | Type sent to `/v1/memory`, before → after | `/v1/memory` | Type sent to `/v1/memories`, before → after | `/v1/memories` |
|---|---|---|---|---|
| `preference` | `preference` → `preference` | accepted → accepted | `preference` → `factual` | 400 → accepted |
| `decision` | `decision` → `decision` | accepted → accepted | `decision` → `factual` | 400 → accepted |
| `fact` | `fact` → `factual` | 400 → accepted | `fact` → `factual` | 400 → accepted |
| `insight` | `insight` → `factual` | 400 → accepted | `insight` → `factual` | 400 → accepted |
| `context` | `context` → `factual` | 400 → accepted | `context` → `factual` | 400 → accepted |
| `general` | `general` → `factual` | 400 → accepted | `general` → `factual` | 400 → accepted |

| Endpoint | main | #462 | This fix |
|---|---|---|---|
| `POST /v1/memory` | 2 of 18 | 6 of 18 | 18 of 18 |
| `POST /v1/memories` (legacy) | 0 of 18 | 0 of 18 | 18 of 18 |

Every refusal before was for `memory_type`, and none is left.

## Against RetainDB Local

[`live-types.probe.mjs`](./live-types.probe.mjs) ran against RetainDB Local 0.2.2 from the provider lab: the
`retaindb` service in [`provider-lab/`](../../../provider-lab/README.md), with hash embeddings, on
`http://127.0.0.1:18990`. The container had been stopped. It was started for these runs, stopped again afterwards, and
its volume was kept.

Each run wrote every category at importance 1, 3 and 5 through the real Source, as user `rv462`, into a new project of
its own: `rv462-type-before` with #462's driver, `rv462-type-after` with the fix. The texts carry none of the words
RetainDB Local infers a type from, so it falls back to the type it was sent.

| Category | Type sent, before → after | Type stored, before and after | Importance stored for 1 / 3 / 5, before and after |
|---|---|---|---|
| `preference` | `preference` → `preference` | `preference` | 0.636 / 0.836 / 0.99 |
| `decision` | `decision` → `decision` | `decision` | 0.644 / 0.844 / 0.99 |
| `fact` | `fact` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `insight` | `insight` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `context` | `context` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `general` | `general` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |

The stored type and importance are the same in both runs for all 18 memories. Only the type RetainDB Local records
as sent, `metadata.original_type`, changed.

## Legacy writes and receipts

**Cause.** The legacy `POST /v1/memories` declares `async: z.boolean().optional().default(true)`
([`api/routes.ts:2594`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2594)).
Unless the body sets it to false, the Server queues the write and answers 202 with `mode: "async"` and a `jobId`
([`:2606-2638`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2606-L2638)).
The Provider never set it, yet its receipt said "RetainDB stored the memory synchronously." `POST /v1/memory` was
not affected: the Provider sends it `write_mode: "sync"`, and it stores before it answers
([`api/memory.ts:1027-1033`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L1027-L1033)).

**Fix.**

- The legacy body now carries `async: false`, which its schema declares, so the Server stores the memory before it
  answers.
- A server that queues the write anyway answers with `mode: "async"` and a job id (`jobId` on the legacy endpoint,
  `job_id` on `/v1/memory`). The receipt is then `action: "queued"` with that id. The Memory Spaces Source counts a
  queued receipt as accepted, not committed (`mutationResultCompletion` in
  `plugins/dsh-mnemon-source-memory-spaces/src/service.ts`), as it does for Hindsight's and Supermemory's queued
  writes.
- A stored receipt now names the memory on RetainDB Server too. Its synchronous answers carry the id as `memory_id`
  on `/v1/memory`, and only inside `memory` on the legacy endpoint, where the Provider read `id` alone, which only
  RetainDB Local sends.

**Replay.** The schema replay now copies both endpoints' `async` fields and reports how the Server would write each
accepted body:

| Legacy `POST /v1/memories` | #462 | This PR, types only | This PR |
|---|---|---|---|
| Bodies accepted | 0 of 18 | 18 of 18 | 18 of 18 |
| Stored before the answer | 0 | 0 (all 18 queued) | 18 |

`POST /v1/memory` stores all 18 accepted bodies before it answers, as before.

## Reading types back

**Cause.** The Provider read a memory's category from `memory_type` and passed RetainDB's type through, so a listed
memory read back as `factual` or `workflow`, which are not Memory Spaces categories. RetainDB Local's search results
carry the type as `type` beside the stored `memory`
([`local/src/cli.ts:916-933`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L916-L933)),
so every recalled memory read back as `general`.

**Fix.** The type is read from `memory_type`, then `type`, then `category` as before. `preference` and `decision`
map back to those categories, and any other type reads as `general`.

| RetainDB returns | Category before | Category now |
|---|---|---|
| List item, `memory_type: "decision"` | `decision` | `decision` |
| List item, `memory_type: "factual"` | `factual` | `general` |
| RetainDB Local search result, `type: "preference"` | `general` | `preference` |
| RetainDB Local search result, `type: "workflow"` | `general` | `general` |

The test builds its search results in RetainDB Local's own shape.

## Reproduce

The after columns come from this branch after `pnpm build && pnpm -r build`. For the before columns, build the
Provider from #462's driver first, then restore it:

```text
git show claude/fix-retaindb-importance-scale:plugins/dsh-mnemon-provider-retaindb/src/driver.ts > plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
node docs/pr-assets/retaindb-importance-scale/server-schema.probe.mjs <before.json>
node docs/pr-assets/retaindb-memory-type/live-types.probe.mjs http://127.0.0.1:18990 rv462-type-before <before.json>
git checkout -- plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
```

Then run the same probes for the fix, with `rv462-type-after` for the live run.

```text
pnpm --filter dsh-mnemon-provider-retaindb exec vitest run     # 27 passed; on #462's driver, 10 of the 11 new tests fail
pnpm --filter dsh-mnemon-provider-retaindb run typecheck
pnpm --filter dsh-mnemon-provider-retaindb run build
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run  # 296 passed, 2 skipped
node scripts/verify-docs.mjs
```

The new unit tests check:

- the type sent to each endpoint for every category, and for a request without one;
- the legacy body's `async: false`;
- a queued answer on either endpoint, reported as queued;
- the ids RetainDB Server's synchronous answers carry;
- the categories read back from RetainDB Local-shaped search results and from lists.

On #462's driver, only the test without a category passes, because the Provider already sent `factual` then.

## Limits

- No RetainDB Server and no hosted service was run. The Server's verdicts come from its own schema, parsed as the
  Server parses it. Cloud was not observed.
- The live runs used the driver before the receipt and read-back fixes. Neither changes what RetainDB Local stores:
  its answers carry `id` and no job, and the Provider never falls back to the legacy endpoint there.
- The live runs' two projects and 36 memories remain in the lab's store; the lab's `dsh-lab` project kept its six
  memories.
