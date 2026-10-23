---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-provider-hindsight": patch
"dsh-mnemon-provider-openviking": patch
---

Recall no longer leaves out a Hindsight answer that scores above 1, or lets OpenViking's similarity crowd it out (#454). Hindsight adds reranker and recency boosts to its final score, so a relevant memory can pass 1; such a score now counts as 1 and is banded high instead of unknown. OpenViking passes on its server's embedding similarity, which the default thresholds do not fit: in a search that also covers another Provider, with both thresholds at their defaults, `strict-v1` keeps OpenViking's results in OpenViking's own order after the high-relevance results, at most `recallQuality.maxRankedResults` of them (new, default 2), keyword matches without a score included. Searching OpenViking alone, or setting a threshold away from its default, bands its results as before, and every other Provider's results are unchanged. The WebUI's search follows the same rule, so a search across spaces shows at most that many OpenViking results; searching the OpenViking space alone shows all of them. Provider authors can describe such scores with `scale: 'boosted'` or `scale: 'embedding-similarity'` on the adapter's `scoreSemantics`.
