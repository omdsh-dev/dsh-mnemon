# Holographic trust from importance — issue #447

[简体中文](./README.zh-CN.md) | [Issue #447](https://github.com/omdsh-dev/dsh-mnemon/issues/447) | [Verification record](./verification.json)

Issue #447 reports that Holographic turns the 1-5 `importance` of `mnemon_remember` into its 0-1 trust by clamping, so
every fact's trust is 1.0, `defaultTrust` never applies and `minTrust` filters nothing.

Baseline: main `a7e3bc54`. The runs took place on 2026-10-23 (Asia/Shanghai) on macOS arm64 with Node 24.19.0 and pnpm
10.13.1. All memories are synthetic.

## Cause

- The Memory Spaces Source sends every Provider an integer importance from 1 to 5, and 3 when the writer gives none.
- Holographic stored `clampTrust(importance ?? defaultTrust)`. Any value from 1 to 5 clamps to 1.0, and since an
  importance always arrives, `defaultTrust` was never used.
- `minTrust` hides facts below it, but with every fact at 1.0 it hid nothing.
- Reading back, a fact reported its trust as its importance, so every Holographic memory showed importance 1.

## Fix

- **A new fact's trust.** Importance 3 starts at the space's `defaultTrust`. Each step above or below moves the trust
  by 0.1, within 0 to 1, rounded only to a millionth so that a configured default such as 0.333 is kept exactly. With
  the defaults (0.5 and a minimum of 0.3), importance 1 to 5 start at 0.3 to 0.7, so every fact is still recalled until
  the minimum is raised. A fact that reaches the Provider without an importance starts at `defaultTrust`.
- **The minimum trust gates every read.** Search, browse, the graph, the Entities page and related reads now all
  leave out facts below `minTrust`; related reads used to ignore it. The comparison allows for float noise.
- **A hidden write says so.** A fact whose trust is below the minimum is still stored, and the receipt keeps
  `action: stored` but adds `hiddenByMinTrust`, its trust, the minimum and a hint. A duplicate of a hidden fact is
  skipped as before, with a summary that says the existing fact is hidden. A `minTrust` above `defaultTrust` + 0.2
  therefore hides every new fact, while facts written before, at trust 1.0, stay visible. Status counts every stored
  fact, hidden or not.
- **Scores stay the relevance.** Search and related scores are no longer multiplied by trust; trust orders equal
  scores instead. Scaling scores by the new, lower trusts would have pushed new facts under the recall tiers' 0.25
  floor. Today every fact scores at its relevance because its trust is 1.0, so every existing score and tier stays
  as it is.
- **Importance is kept.** A fact keeps the importance it was written with and reads back with it, on the 1-5 scale
  every Provider reports.
- **Existing facts are left as they are.** They keep trust 1.0 and have no recorded importance; their original
  importance was lost to the clamp. Rewriting them would guess at user data, and leaving them visible is the behavior
  users have today. They read back without an importance rather than with a wrong one.
- **One importance scale.** The extensions guide now states it for every Provider: the Source sends 1-5, and a backend
  with another scale maps the importance onto its own scale instead of passing or clamping the number.

## Through the Memory Spaces Source

[`trust.probe.mjs`](./trust.probe.mjs) mounts the real Memory Spaces Source with the Holographic Provider. It writes
three memories through `remember` and reads the local store. It then searches with the space's minimum trust at 0.3,
and again at 0.5.

| Memory | importance sent | main: trust / read back | Fix: trust / read back |
|---|---|---|---|
| Release notes are drafted on Monday | 1 | 1 / 1 | 0.3 / 1 |
| Release approvals need a completed canary | 5 | 1 / 1 | 0.7 / 5 |
| Release branches are cut from main | none (Source sends 3) | 1 / 1 | 0.5 / 3 |

| Search "release" | main | Fix |
|---|---|---|
| `minTrust` 0.3 | all three, score 0.9 | all three, score 0.9 |
| `minTrust` 0.5 | all three, score 0.9 | importance 5 and 3, score 0.9 |

## Other Providers

- **Unchanged and consistent with the 1-5 scale:** Mnemon Native passes the importance to the CLI. OpenViking tags it.
  Mem0 and Supermemory pass it as given.
- **Not sent at all:** Hindsight, Honcho and ByteRover do not send an importance.
- **RetainDB** sends `importance: request.importance ?? 0.7`. Because the Source always sends 1-5, the 0.7 default
  never applies, and the default suggests RetainDB's API uses 0-1. It was not verified against a RetainDB server, so it
  is reported here and not changed.

## Rollback and known effects

- **Rollback.** Going back to an earlier driver keeps every fact, but it multiplies new facts' scores by their lower
  trust:
  - a 0.9 phrase match becomes 0.63 to 0.27 for importance 5 to 1;
  - an importance-1 entity match at 0.8 becomes 0.24 and is dropped under the recall tiers' 0.25 floor;
  - importance reads back as the trust, 0.3 to 0.7.
- **Entities page order in a mixed store.** The Source orders an entity's memories by `importance ?? 0`, so in a store
  that holds both older facts (no importance) and new ones, the older facts sort last. This is a cosmetic effect;
  the Source is not changed here.

## Automated checks

```text
pnpm --filter dsh-mnemon-provider-holographic exec vitest run    # 20 passed; on main, the 11 new tests fail
pnpm --filter dsh-mnemon-provider-holographic run typecheck
pnpm --filter dsh-mnemon-provider-holographic run build
pnpm exec vitest run <the 9 root test files that exercise Holographic>   # 441 passed, 1 skipped
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run    # 296 passed, 2 skipped
node docs/pr-assets/issue-447-holographic-trust/trust.probe.mjs <out.json>
node scripts/verify-docs.mjs
```

The new unit tests cover:

- the mapping from importance to trust and its clamps at 0 and 1, with `defaultTrust` 0, 0.1 and 1;
- importance 0, fractions and NaN sent straight to the driver;
- the default trust, and a minimum equal to a default of 0.333 or 0.001;
- `minTrust` set between two importances;
- receipts for a stored fact and a duplicate hidden by the minimum;
- related scores and their gate;
- the order of equal scores: 30 importance-1 facts and then 5 importance-5 facts, with limit 30;
- a relevance score that trust does not reduce;
- a fact written before the fix that is left as it was.
