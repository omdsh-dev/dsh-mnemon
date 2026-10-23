---
"dsh-mnemon-provider-openviking": patch
---

Memories can be stored in OpenViking 0.5.1 and later again (#455). Every write there failed with `body.timeout: Extra inputs are not permitted`: the write sent a `timeout` field that 0.5.1 removed. It now sends only the four fields every release from 0.4.16 to 0.5.2 declares, and the request's own deadline bounds the wait as before. OpenViking 0.5.1 also appends a reserved trailer to each memory file and counts it in the bytes it reports; a write is still reported only when the exact text reads back.
