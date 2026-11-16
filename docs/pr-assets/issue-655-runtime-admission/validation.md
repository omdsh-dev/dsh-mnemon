# Attended Runtime capture admission (#655)

The model-facing Runtime tool, Layered protocol (including no-recall/local-archive and scoped variants), routing guidance and write reminders now share the same boundary: explicit durable user facts and compact rules needed for future work. Project records and transient state route to writable Documents when substantial; otherwise the Agent should skip them. An explicit Runtime destination remains supported.

## Reproduction and verification

- Before the production change, 12 new assertions failed: all protocol/reminder variants and the actual registered tool still offered broader project/transient capture.
- After the change, the targeted instruction, tool-table and real-Host suite passed all 119 tests.
- The real published DSH Host test delivers the new Layered instructions to its model adapter, executes an explicit project-decision write to MEMORY.md with low importance and branch scope, and verifies the persisted entry and successful receipt.
- Full `pnpm run verify` passed: docs, type checks, deterministic builds, all package/root tests, real Headless activation and package validation. Optional live-provider/CLI tests remain skipped when their prerequisites are absent.

## Limits and retained behavior

This is a routing-instruction correction, not a deterministic semantic filter. The real-Host test uses a scripted adapter to validate delivered instructions and working tools; it does not claim a live model will always classify every fact correctly. No API credentials or user data were used. Storage, existing memory, permissions, manual writes, branch scoping, correction/removal and capacity maintenance are unchanged. No UI layout changes.
