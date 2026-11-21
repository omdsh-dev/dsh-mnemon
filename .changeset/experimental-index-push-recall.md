---
"dsh-mnemon": patch
"dsh-mnemon-source-documents": patch
"dsh-mnemon-source-memory-spaces": patch
---

Add an off-by-default experimental `runtimeMemory.indexPush` switch that appends bounded step-1 BM25 index matches for active Memory Space names/descriptions and Project Document summaries while reusing existing deduplication, invalidation, prompt-cache preservation, and compaction revalidation.
