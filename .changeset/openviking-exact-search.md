---
"dsh-mnemon-provider-openviking": patch
---

Keyword search finds exact text in OpenViking spaces (#452). Direct search with Keyword search, and `mnemon_recall` in keyword mode, now go through OpenViking's `search/grep`, so an ID, a version, a path or an error code is found by its exact text instead of by meaning: each term, or a double-quoted phrase, is matched literally, in any case and as a whole word, and the memory holding more of the terms comes first. Smart recall and Basic match are unchanged. A server without `search/grep` answers keyword searches semantically and says so.
