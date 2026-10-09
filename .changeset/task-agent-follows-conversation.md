---
"dsh-mnemon": patch
---

The Memory System's status page now carries a **Background tasks** card: it states the Provider / Model the current conversation's background work actually uses, offers **Choose a model** without opening the plugin configuration, says so when the model directory cannot be read (and offers **Read again**) instead of silently falling back, and stays read-only when settings are not writable. The same model setting keeps working under the Layered strategy's page; a dialog now leaves Escape and Tab to a menu opened above it.

Background task Agents now follow the conversation that asked for the work: `taskAgentModel: inherit` resolves the session's own Provider / Model before the DSH new-session default.
