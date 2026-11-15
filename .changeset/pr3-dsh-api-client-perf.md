---
"dsh-mnemon": patch
"dsh-mnemon-source-documents": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-source-runtime": patch
"dsh-mnemon-source-skills": patch
---

Align Web client surfaces with official DSH 0.2.1+ platform APIs (`ctx.conversation.input`, `ctx.remote.directoryPicker`, `ctx.remoteAccess`, `usePanelInfo`, `uiConversation`, and `--dsh-frame-leading-clearance`) while preserving gated 0.2.0-rc.2 compatibility fallbacks, consolidate shared external store and DOM seat primitives, remove duplicate core locale bundles, and eliminate client RPC storms, subtree `MutationObserver` leaks, session-switch page remounts, and SVG graph re-render loops.
