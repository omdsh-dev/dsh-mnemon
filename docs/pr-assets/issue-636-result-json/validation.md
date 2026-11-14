# Delegated result JSON recovery

Base: `1dec529da00a9527351efd329a4beac400cd399a`; Node 24.22.2.

## Failure boundary

The published DSH 0.2.2-rc.1 pi-ai adapter emits `MALFORMED_RESPONSE` with `Tool call "mnemon_subagent_result": ...` when its parser rejects the arguments. It preserves the failed stream and throws before tool dispatch. A repair inside the result tool's execute handler therefore cannot address this reported path.

The scoped child request-error hook now appends one correction instruction and retries the failed request in the same child. It does not edit failed stream bytes, append guessed braces, relax schema validation, restart a task or rerun a mutation itself. Completion instructions also explicitly require both enclosing objects to be closed.

## Reproduction

The new continuation regression fails on the base: the request-error hook returns no retry for the reported completion failure. Real-Host fixtures emit a result-tool stream missing its final outer brace and then throw the same adapter error. They cover:

- Valid skill completion: one model request, no correction message.
- Malformed skill completion then valid correction: two requests, one child, one correction.
- A second malformed completion: fails after two requests, no third correction.
- A review that has already created a Document: the same recovery cases, with exactly one successful write and one retained Document even if the correction fails.
- Unrelated tool/response errors remain outside this recovery path. Existing cancellation, ownership, continuation-template and finished-task tests remain active.

## Verification

- `pnpm run verify`: docs, types, deterministic build, all plugin builds/types/tests passed. Root initially identified the expected completion-text hash change plus the existing concurrent hung-backtest deadline timeout. Only completion hashes were updated; persona, task and result-schema fixtures remain unchanged.
- `pnpm run test:root --maxWorkers=2 --minWorkers=2`: **2,748 passed, 9 conditional skips**.
- `pnpm run verify:headless` and `pnpm run verify:package`: passed.
- Official DSH 0.2.2-rc.1 and rc.3: result recovery, strict chat templates, child ownership/continuation and finished-task suites, **22 passed each**.
- All model streams and memories are synthetic local fixtures. No real API requests, private logs or Desktop-profile modifications.

## Limit

This is a bounded recovery opportunity, not a guarantee that a model will always produce valid JSON. A second malformed result still fails visibly. Already completed writes are not rolled back or repeated automatically. A failing completion can consume one additional request with the child's existing model and output-token limit.
