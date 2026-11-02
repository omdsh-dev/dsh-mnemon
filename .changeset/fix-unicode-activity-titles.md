---
"dsh-mnemon": patch
---

Keep supplementary Unicode characters whole when truncating memory activity titles, excerpts, identifiers, and references. Prevent newly written tool metadata from containing lone surrogates that can make subsequent model requests fail with HTTP 400. Original memory content and existing length limits are unchanged; already persisted session metadata is not rewritten.
