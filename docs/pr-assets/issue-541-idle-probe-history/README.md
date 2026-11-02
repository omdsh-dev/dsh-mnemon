# Issue 541: idle PTC history integrity

[中文](./README.zh-CN.md)

Synthetic validation on 2026-11-02, based on v0.5.38 (`a4ad2d6955172b936ff9328f39cc5873c3ec9c55`). No user session or Desktop profile was read or modified; the deterministic local model makes no network model calls.

## Reproduction and result

The real DSH Agent in `tests/idle-review-tool-access-host.spec.ts` runs two eligible parent turns in PTC mode. Unmodified main appends a probe after `turn/end`; the published v4 validator rejects it:

```text
SessionFormatError: tool/ptc-dispatch-start is outside an open turn
```

The fixed branch awaits the probe in `agent/turn-stopping`, including a deliberately delayed PTC audit event after timeout. The idle timer starts an authorized reviewer without adding parent tool events. The v4 validator and a fresh JSONL persistence reader both accept the complete history. Guards, approval suppression, wrapper/post-policy denial, cancellation, persistent quota and later recovery remain covered.

`tests/fixtures/issue-541-idle-probe-v4.jsonl` is captured from that real rc.5 reproduction, with only temporary filesystem paths replaced by `/synthetic/issue-541`. Its dialogue, model and data are synthetic. Recovery changes two probe audit records into namespaced ignorable records retaining their original type/data and coordinates; every conversation message and other physical row remains unchanged. The published reader rejects the original and accepts the copy, for JSONL and checksummed Zstandard. Re-running recovery preserves bytes. Ambiguous/incomplete/non-probe cases refuse output.

## Reproduce

```bash
pnpm exec vitest run tests/idle-review-tool-access-host.spec.ts tests/lifecycle.spec.ts tests/legacy-session-repair.spec.ts
DSH_HOST_ROOT=/path/to/installed/node_modules/@deepseek-ai/dsh pnpm run test:installed-dsh tests/idle-review-tool-access-host.spec.ts tests/legacy-session-repair.spec.ts
node bin/repair-legacy-session.mjs --input tests/fixtures/issue-541-idle-probe-v4.jsonl
pnpm run verify
```

Complete `pnpm run verify` passed: 2,400 root tests / 7 existing opt-in skips, all component suites, types, deterministic builds, Headless and package checks. Six additional guard/recovery cases were then added: the final full root suite passed 2,406 / 7 skips. Installed rc.5 focused suites: 287 passed; installed 0.2.0-rc.2: 158 passed. The [CLI preview](./recovery-preview.json) contains only synthetic fixture digests and counts.

## Limits

The five-second deadline cancels the probe but cannot hard-kill same-process extension middleware: the stopping hook must drain it before ending the turn. Admission is a checkpoint, not a guarantee of future child/write permission. Recovery is opt-in and copy-only; it does not automatically repair any user's store, remove audit data, or certify unrelated corruption. Seeded/child sessions and unpaired or otherwise ambiguous audit records are refused. No upstream DSH code is modified.
