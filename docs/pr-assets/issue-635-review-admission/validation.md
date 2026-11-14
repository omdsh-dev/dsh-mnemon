# Automatic review admission recovery

Base: `1dec529da00a9527351efd329a4beac400cd399a`; Node 24.22.2.

## Reproduction and change

On the base, a first-step denial stays cached for the entire turn, even when the same executor permits the next real step. Both native and Code Mode reproductions create zero review children. Two lifecycle variants also fail because only one check occurs.

The fix permits one later-step recheck per turn/policy. Successful checks are reused; repeated model transport attempts in the same step do not repeat probes. Persisted attempts advance from 1 to 2 after reopening and recovery; the maximum of 2 still blocks subsequent review. No old permission result is carried across turns, and guards, approval requirements, cancellation and audit drains remain enforced.

`mnemon_status` now reports a bounded additional field, also available in the lifecycle snapshot:

```json
{"idleReviewAccess":{"state":"unavailable","reason":"execution-error","checkedAt":"<timestamp>"}}
```

The real-Host diagnostic test injects a synthetic private error and asserts that it never appears in the returned status. After a successful recheck the state is `available`, without a stale failure reason. No open step reports `no-open-step` without writing session events.

## Verification

- `pnpm run verify`: docs, types, deterministic build, all plugin builds/types/tests passed. The first full root run identified an outdated coordinator test double and the existing concurrent backtest deadline timeout. The double now supplies the new status method.
- `pnpm run test:root --maxWorkers=2 --minWorkers=2`: **2,745 passed, 9 conditional skips**.
- `pnpm run verify:headless` and `pnpm run verify:package`: passed.
- Official installed DSH 0.2.2-rc.1 and rc.2: tool admission and persisted-watermark suites, **29 passed each**.
- Official installed DSH 0.2.2-rc.3: the same suites plus Host execution and turn-View coverage, **90 passed**.
- Models, paths and memories are isolated synthetic fixtures. No real model API or personal Desktop profile was used.

## Limit

The reporter's restart-specific executor failure is not identified by their logs. This fixes the reproducible whole-turn failure cache and adds the requested diagnostic path; it does not prove their exact Desktop environment now succeeds. Keep issue #635 open for the resulting diagnostic if its failure persists. No watermark is reset and no guard is bypassed to force an attempt.
