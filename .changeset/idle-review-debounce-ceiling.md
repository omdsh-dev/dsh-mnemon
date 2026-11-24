---
"dsh-mnemon": patch
---

Raise the `idleReviewMs` idle-review debounce ceiling from 10 minutes (`600000` ms) to 24 hours (`86400000` ms) to match `idleReview.minIntervalMs`, validate `idleReviewMs` bounds in the settings RPC handler, and expose it under **Review limits** on the Layered strategy settings page across all 8 UI locales.
