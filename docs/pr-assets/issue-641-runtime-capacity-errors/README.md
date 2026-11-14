# Runtime capacity failure handling (#641)

[简体中文](./README.zh-CN.md) | **English**

Verified on 2026-11-15 (Asia/Shanghai). Code revision: `e440b3a003a3bb647422c52bf4bd56b62174957a`; based on main `36b341d7722efd2ceab80ba21e3f1c2c8924666b`. Later commits add evidence only. The development build still reports package version 0.5.45; it is identified by this code revision and the bundle digest in [validation.json](./validation.json), not by that version label.

## Findings and change

A normal Source capacity Error entered maintenance, but a serialized object with the same code did not: `sourceFailure` required `instanceof Error`. JSON serialization can also omit the non-enumerable `message`. The fix recognizes the Source protocol's code across plain objects and realms, reconstructs capacity context from validated numeric fields when necessary, and returns genuine, readable errors through the Runtime coordinator and RPC save path.

Routing failure and archive failure are separate outcomes. A router that finishes without its structured result still uses the existing eligible-destination fallback. Successful receipts retain its explanation. If a later archive step fails, the error now includes that actual failure and up to three bounded, redacted routing diagnostics. It does not turn a failed or uncertain write into success.

No capacity limits, storage formats, destinations, Source authorization, receipt verification, cleanup rules or model budgets changed. Existing Error identity is retained when no new context is needed; aggregate cleanup failures retain their causes and entries. No raw failure-object dump is added.

## Verification

- Complete `pnpm run verify`: **2,801 root tests passed / 9 conditional skips**; **899 workspace-plugin tests passed / 4 conditional skips**. Documentation, types, deterministic builds, Headless and package validation pass.
- Published DSH **0.2.2-rc.1**: **235 focused tests passed / 1 conditional skip**.
- Published DSH **0.2.2-rc.3**, complete installed-Host suite: **2,802 passed / 8 conditional skips**.
- The 21 new regressions cover serialized messages, ordinary JSON Error serialization, foreign-realm Errors, four Host write entry points, exact archival and committed pending data, missing routing results, failure diagnostics, structured cancellation, and keeping private extra fields out of UI responses.
- Real published **0.2.2-rc.3 WebUI**, macOS arm64 / Node 24.22.2: a 5,625-byte USER entry exceeds the unchanged 4,096-byte limit. The page shows the projected/current/limit values and the maintenance reason; disk inspection confirms zero entries. A subsequent 93-byte synthetic profile entry saves successfully and is the only persisted entry.

| Real UI observation | Evidence |
| --- | --- |
| Capacity error remains readable; no entry persisted | [Screenshot](./capacity-error.jpg) |
| The next valid save succeeds | [Screenshot](./save-recovered.jpg) |

The UI probe exercises the shared capacity-error path with USER memory; automated tests cover over-limit MEMORY writes through named tools, generic Actions, coordinator fallback and management RPC. It is not a reproduction of the reporter's exact Windows Desktop or model environment, and does not establish why that model omitted its result. The Web fixture uses temporary data and a loopback model stub; this UI probe makes no model request. No paid API or personal Desktop data was used.

## Reproduction

```sh
VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=2 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=2 pnpm run verify
DSH_HOST_ROOT=<official-rc1-package> pnpm run test:installed-dsh tests/runtime-capacity-workflow.spec.ts tests/subagent.spec.ts --maxWorkers=2 --minWorkers=2
DSH_HOST_ROOT=<official-rc3-package> pnpm run test:installed-dsh --maxWorkers=2 --minWorkers=2
MNEMON_E2E_DSH=<official-rc3-bin> MNEMON_E2E_PORT=19641 node scripts/serve-e2e.mjs
```

The reusable harness is [serve-e2e.mjs](../../../scripts/serve-e2e.mjs). On Runtime Memory, add to **User profile** the text `Synthetic capacity probe. ` followed by 400 repetitions of `durable-fact; `. After observing the rejection, save `Synthetic verification: concise profile memory can be saved after a rejected oversized write.`. Inspect the isolated `data/runtime/memories.json`; do not edit it. The initial 12,625-byte probe was rejected by the separate 8,192-byte per-entry input limit and is not counted as the capacity-maintenance probe.
