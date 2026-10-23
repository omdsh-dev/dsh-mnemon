# Recall with Providers that score on different scales — issue #454

[简体中文](./README.zh-CN.md) | [Issue #454](https://github.com/omdsh-dev/dsh-mnemon/issues/454) | [Verification record](./verification.json)

Issue #454 reports that recall across Hindsight and OpenViking left the right answer out. Hindsight scored it 1.04, and the Source treated that as "unknown". Weak OpenViking rows at about 0.7 took the places ahead of it.

This change reads those two Providers' scores for what they measure. Every other Provider, and every recall without them, behaves exactly as on main.

Baseline: main `a7e3bc54`. The runs took place on 2026-10-24 (Asia/Shanghai) with:

- macOS arm64, Node 24.19.0, pnpm 10.13.1 and the Mnemon CLI 0.2.12;
- Hindsight 0.10.1 from `provider-lab`, with its local embeddings and reranker and the seeded `dsh-lab` bank;
- OpenViking v0.4.21 with `text-embedding-ada-002`. One account holds four unrelated synthetic notes; a separate user holds LoCoMo conversation `conv-26` for the rank study.

All services listen on loopback. The Memory Spaces Source and the three-tier strategy ran through `MemoryCompositionRunner` with the real Providers, in smart mode.

## Cause

- **Hindsight's scores pass 1.** Its `scores.final` adds reranker and recency boosts to relevance. For the #454 query, 6 of the 8 rows it returned scored above 1, the answer 1.091; an unrelated query scored about 0.00002. main treats a score above 1 as unknown, which comes after every high and medium row, at most two per search, and one per attempt in the three-tier strategy.
- **OpenViking's scores do not separate.** It passes on raw embedding similarity. With ada-002 every row scores 0.66 or more, relevant or not, so the default bands call all of them high. Beside another Provider, unrelated OpenViking rows take the same places as calibrated evidence.

## Fix

- **Hindsight** keeps normalized relevance. Its adapter declares `scale: 'boosted'`, and a score above 1 counts as 1 in every policy. Its other scores are banded as before, so unrelated rows stay low and are dropped.
- **OpenViking** declares `scale: 'embedding-similarity'`. In a search that also covers another Provider, with both thresholds at their defaults, `strict-v1` keeps OpenViking's rows in OpenViking's own order (`relevanceTier: ranked`):
  - after the high-relevance rows and before medium ones;
  - at most `recallQuality.maxRankedResults` per search, a new setting that defaults to 2;
  - keyword matches without a score count among them.

  The three-tier strategy admits ranked rows like high ones. A search of OpenViking alone, a threshold set away from its default, `balanced-v1` and `exhaustive-v1` all band OpenViking's rows as before.
- **Everything else is main.**
  - Mem0, Supermemory, RetainDB, ByteRover and Honcho keep their declarations.
  - The decision reasons and quality stats are unchanged; `unscaled` also counts ranked OpenViking rows.
  - The Host's checks are main's: recall reads the adapter's score semantics, and only a manifest that claims normalized scores its adapter does not report is refused.

## Why at most two OpenViking rows

OpenViking's scores cannot say whether it holds an answer, so beside another Provider only its order can be trusted. The rank study asked the 152 answerable and 47 unanswerable questions of `conv-26` (419 turns, one memory each) with the request the adapter sends:

| First evidence turn within OpenViking's top | 1 | 2 | 4 | 10 | 20 |
|---|---|---|---|---|---|
| Answerable questions | 60 (39%) | 74 (49%) | 96 (63%) | 117 (77%) | 131 (86%) |

- **Scores.** The evidence row scored 0.763 to 0.909 (median 0.841). The top row of the unanswerable questions scored 0.795 to 0.897 (median 0.841). No threshold separates them, and all are high under the default bands.
- **The trade.** A third and fourth row would add 22 of the 152 answers (63% instead of 49%). On every recall where OpenViking has nothing, they would also add two more unrelated rows and push calibrated medium rows further down. The strategy's first attempt holds four rows, so two leaves room for the other spaces.
- **Alone, nothing is capped.** OpenViking searched alone is banded as on main, and the first attempt keeps its first four rows (63% here).

## Results with the real Providers

Source search, then one Agent recall through the three-tier strategy in a fresh turn.

| Scenario | main | Fix |
|---|---|---|
| #454 query, Hindsight and OpenViking, limit 4 | 4 unrelated OpenViking notes, all high (0.664 to 0.687); 0 of 8 Hindsight rows | **4 Hindsight rows, all high, the answer (1.091) first**; the Agent gets the same 4 |
| Unrelated query, Hindsight and OpenViking, limit 4 | 4 unrelated OpenViking notes, all high; all 8 Hindsight rows dropped as low | 2 OpenViking notes, ranked; all 8 Hindsight rows dropped as low |
| Unrelated to Hindsight, Native and Hindsight, limit 6 | 4 Native rows (2 high, 2 medium); all 8 Hindsight rows dropped | the same |
| The same with OpenViking, limit 6 | 2 Native high rows and 4 unrelated OpenViking notes; both Native medium rows left out. Agent: 2 Native, 2 OpenViking | 2 Native high rows, 2 OpenViking ranked, 2 Native medium rows. Agent: 3 Native, 1 OpenViking |
| #454 query with the reporter's thresholds (0.67 and 0.78) | 3 unrelated OpenViking notes and a weaker Hindsight row, all medium; the answer left out of the search. Agent: 1 OpenViking note and the answer as unknown | **4 Hindsight rows, all high, the answer first**; OpenViking banded by those thresholds |
| #454 query, OpenViking alone, limit 4 | 4 OpenViking notes, all high | identical |

The queries were "新建记忆空间时，由谁、按什么规则选择 Provider？" ("Who chooses the Provider for a new Memory Space, and by what rules?") and "Which espresso machine does the kitchen use?". The Native space held six synthetic kitchen facts; the record lists every row.

## Tests

- **Policy tests** (`plugins/dsh-mnemon-source-memory-spaces/tests/recall-quality.spec.ts`):
  - the #454 rows;
  - ranked rows after high and before medium rows, and the cap at 2, 4 and 0, with an unscored keyword match among them;
  - OpenViking banded as before when searched alone, under the reporter's thresholds, and in `balanced-v1` and `exhaustive-v1`;
  - a boosted score above 1 counting as 1 in every policy;
  - the review scenarios: Native with unrelated Hindsight rows, Native with Honcho, Hindsight alone, and a Native medium answer. Each selects what main selects.
- **Byte-identity.** 400 deterministic recalls without Hindsight scores above 1 or ranked OpenViking rows. The candidate limit, every decision with its reason, and the selection match a frozen copy of main's three policies.
- **Source tests** (`tests/service.spec.ts`) use the real adapters on stubbed HTTP: the #454 case, the reporter's thresholds, Native with unrelated Hindsight rows, Hindsight alone, and a Native score above 1.
- **Provider semantics** (`tests/provider-conformance.spec.ts`) pins every bundled Provider's manifest and adapter. A Host test (`tests/provider-sdk.spec.ts`) keeps main's precedence: a manifest's normalized claim that the adapter does not make is refused, and an adapter's own claim stands.
- **Strategy test** (`plugins/dsh-mnemon-strategy-default-three-tier/tests/retrieval.spec.ts`): ranked rows are admitted like high ones, unknown rows one per attempt.
- **On main** 8 of the 310 Memory Spaces tests fail. The Host test passes there, since it pins main's precedence, and so does the strategy test, because the strategy already admits a tier it does not name like a high one.

## Limits

- **#454 stays open.** Per-Provider thresholds and a separate reason for an out-of-range score are not part of this change, so the pull request refers to #454 instead of closing it.
- **Other Providers.** Mem0, Supermemory, RetainDB and ByteRover are unchanged; their scales were not measured.
- **The WebUI.** Its search runs the same policy. A search across spaces with default thresholds shows at most two OpenViking results, as it already holds medium and unknown-scale rows to their budgets; searching the OpenViking space alone shows all of them, as before. No page displays tiers, and no recording was made.
