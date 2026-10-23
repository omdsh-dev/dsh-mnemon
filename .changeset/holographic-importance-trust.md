---
"dsh-mnemon-provider-holographic": patch
---

Holographic now gives each new fact a trust from its importance (#447). Before, the 1-5 importance was clamped as if it were a 0-1 trust, so every fact started at 1.0, the space's default trust never applied and its minimum recall trust filtered nothing. Importance 3, the default, now starts at the space's `defaultTrust`, and each step above or below moves it by 0.1 within 0 to 1. Search, browse, the graph, the Entities page and related reads leave out facts below `minTrust`, so a `minTrust` above `defaultTrust` + 0.2 hides every new fact while facts written before (trust 1.0) stay visible; a write whose fact is hidden is still stored, and its receipt says so. Search and related scores stay the plain relevance, so recall tiers do not move, and equal scores are ordered by trust. A fact keeps its importance and reads back with it instead of reporting its trust as importance.
