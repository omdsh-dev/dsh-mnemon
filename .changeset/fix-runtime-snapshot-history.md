---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
---

Bound model-visible Mnemon snapshot history to four complete snapshots or 64 KiB UTF-8, preserving request prefixes for Runtime additions and age updates. Checkpoint immediately on removed/corrected facts or changed authority, workspace, Source, branch or opaque grants; preserve the complete current projection and the append-only audit across session resume. Runtime Sources supply scope and visible-entry digests without changing stored memory formats.
