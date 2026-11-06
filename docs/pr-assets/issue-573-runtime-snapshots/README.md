# Runtime snapshot history verification

[简体中文](./README.zh-CN.md) | **English**

Issue: [#573](https://github.com/omdsh-dev/dsh-mnemon/issues/573). Base: `0db25213d128dfeb420163de20fd41a787366c87`, dsh-mnemon 0.5.41. Run on 2026-11-06 with Node 24.22.2. All data is synthetic; the adapter scripts model choices without an external model or paid API.

## Observed behavior

Before the fix, the real DSH adapter received snapshot counts `1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3` across a first turn, one changed projection, one unchanged turn and JSONL session resume. The regression failed because only one full snapshot should reach each request.

After the fix, three projection revisions, an unchanged turn and JSONL resume produced 15 requests with exactly one complete snapshot each. The append-only audit retained exactly three full snapshot messages. Unchanged text, including after resume, did not add another snapshot. Tool-driven continuation steps kept the same pinned View.

A separate resumed backlog test retained user text, ordinary Mnemon recalls, guidance and another producer's full snapshot verbatim. It retired only the three eligible Mnemon snapshots and recorded a separate one-node replacement with `sourceEventSeqs` for each. The actual adapter requests contained no Mnemon developer message. Unit coverage also preserves partial/quoted legacy text and all 13,000-plus characters of a literal current projection.

## Public Host contract

The implementation uses published Session `append()` with `surfaceOp: { op: 'replace', startSeq, endSeq }` and `sourceEventSeqs`. Each replaced range contains exactly one owned snapshot. Empty `developer/message` content is a public Session representation that derives no model message. These records contain no instructions, memory text or tool changes; the current full snapshot remains user-role data.

Retirements run inside the public `agent/request` waterfall, after `step/start` and before request construction. This ordering satisfies the persisted Session codec, which requires developer records to belong to an open step. Request objects and upstream source are not modified. On resume, the Host reconstructs the replacements from JSONL before the next adapter request.

New snapshots use `source.kind: dsh-mnemon`, `source.form: memory-snapshot`. Older `recall` messages are eligible only when the same producer carries one text block containing the complete built-in Runtime envelope, including the revision/size headings emitted by 0.5.34 or the current headings. Arbitrary recalls and unrecognized historical shapes are preserved. No memory store, projection budget, grant or tool authority changes.

## Validation

| Host | Command scope | Result |
|---|---|---|
| Published 0.2.1-rc.5 | `pnpm run verify` | Passed; root 2557 passed, 8 conditional skips; workspace suites, deterministic builds, Headless activation/restart and package checks passed |
| Published 0.2.0-rc.2 | `tests/memory-snapshot.spec.ts`, `tests/turn-view-host.spec.ts` through `scripts/installed-dsh.config.ts` | 14 passed |
| Published 0.2.1-rc.3 | Same installed-Host tests | 14 passed |
| Published 0.2.2-rc.1 | Same installed-Host tests | 14 passed |
| Existing master build `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | Same acceptance tests against its built packages | 14 passed; source checkout unchanged |

The published packages emit missing source-map warnings in Vite; the PTC fixture also emits Node's TypeScript stripping experimental warning. Both are existing dependency diagnostics, with no failing tests. Conditional suites requiring external services, credentials, a native CLI or platform-specific behavior remain skipped by their existing gates.

No production memory, user preview profile or external API was used. This test exercises persistence unload/reload through the real JSONL codec; it does not claim a Windows Electron process restart or reproduce the reporter's private 1,206-turn session. Historical audit files and empty surface nodes remain append-only. Rolling back the plugin preserves the Host-readable log, but the older plugin can accumulate snapshots again.
