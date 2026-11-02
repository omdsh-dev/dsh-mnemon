# Current-turn View recovery — issue #542

[中文](./README.zh-CN.md)

Tested on 2026-11-02 against baseline `a4ad2d6955172b936ff9328f39cc5873c3ec9c55` (v0.5.38) and this PR's changes. All sessions, workspaces and memory were disposable synthetic fixtures. Published DSH packages were used without modification; model choices were scripted locally, with no paid model calls or Desktop profile access.

## Reproduction and limits

Stock DSH 0.2.1-rc.5 with the shipped `standard` and `ptc` presets worked before the fix. The issue's exact Windows 11 installation and third-party plugin configuration were not reproduced. This evidence establishes a Mnemon lifecycle defect that produces the reported symptoms; it does not establish which plugin or ordering triggered the reporter's failure.

DSH opens the durable `turn/start` before assembling the prompt, then awaits `agent/pre-step` before executing the model and tools. Mnemon previously acquired its View only from its `system-prompt/assemble` listener. A valid public interceptor can return an assembly without visiting later listeners:

```ts
ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
```

With that interceptor, actual rc.5 Agent turns still received the Mnemon guide but no View snapshot. Both native tools and real `run_code` executions returned `Memory operation requires the View pinned to the current turn`. Registering Mnemon's lifecycle during the first assembly also missed that assembly's captured callback list and failed the first tool call.

The fix keeps early assembly preparation and also ensures the accepted pre-step has its own open turn's View. `AgentMemoryTurn.begin` reuses an existing pin or pending preparation and preserves an unavailable composition for the whole turn. Root Agents use their existing Wake path. A generic child that recovers a missing pin receives the existing Wake on that first accepted step; its normal assembly path is unchanged. Coordinator-owned memory tasks retain their existing delegation path.

## Real Host evidence

The reusable regression is [`tests/turn-view-host.spec.ts`](../../../tests/turn-view-host.spec.ts). Only model choices are scripted: Agent turns, event ordering, JSONL sessions, scopes, tool guards, Source plugins, View leases and the PTC worker use the published Host and real Mnemon implementations.

| Observation | Baseline | Fixed |
|---|---|---|
| Native reads with the public interceptor | Both reads fail with the pin error | Status and Documents search succeed |
| PTC reads with the public interceptor | Both real `run_code` calls fail with the pin error | Both calls succeed |
| Lifecycle registration during first assembly | First tool fails; a later step recovers | First tool succeeds |
| Generic child with the interceptor | Both tools fail | Both succeed; exact Route/Action ids reach the model |
| First, next and cold-resumed root turns | Missing pins | Each has its own durable turn id: 1, 2, 3 |
| Source mutation during a turn | Existing fence | Snapshot stays fixed; next turn sees the new revision |
| Rejected/aborted step; denied tool; tool outside a turn | Existing fences | No rejected/aborted-step pin; policy denial and outside-turn rejection retained |

A separate fresh official rc.5 Web profile loaded the built plugin through `dsh plugin --profile web add link:<checkout>` and mounted its shipped `standard` and `ptc` presets. Each ran status and Documents search followed by a text reply. The sanitized results below omit complete prompts, paths and the Web profile's transient access token:

```json
{
  "before": {
    "standard": { "guide": true, "memorySnapshot": false, "toolErrors": [true, true] },
    "ptc": { "guide": true, "memorySnapshot": false, "toolErrors": [true, true] }
  },
  "after": {
    "standard": { "guide": true, "memorySnapshot": true, "toolErrors": [false, false] },
    "ptc": { "guide": true, "memorySnapshot": true, "toolErrors": [false, false] }
  }
}
```

The regression additionally mounts a second Documents Source and Runtime Source under a scoped Strategy. Every root model request and the recovered child's first request contain the actual `MNEMON VIEW ROUTES` envelope, `source:extra-documents/search` and `source:extra-runtime/mutate`, alongside named-tool availability. This checks actionable guidance rather than only checking that tool execution is authorized.

## Verification

```bash
pnpm run verify
DSH_HOST_ROOT=/path/to/published/node_modules/@deepseek-ai/dsh \
  pnpm exec vitest run --config scripts/installed-dsh.config.ts \
  tests/turn-view-host.spec.ts tests/lifecycle-host-order.spec.ts \
  tests/source-tool-lifecycle-host.spec.ts tests/async-subagent-host.spec.ts \
  tests/resumed-memory-task-host.spec.ts
```

| Published Host | Checks | Result |
|---|---|---|
| 0.2.1-rc.2, unchanged repository baseline | Full `pnpm run verify` | Passed; 165 root files / 2,394 tests passed, 2 files / 7 tests skipped |
| 0.2.1-rc.5 | Five focused Host suites | 21 passed |
| 0.2.1-rc.3 | Five focused Host suites | 21 passed |
| 0.2.0-rc.2 | Five focused Host suites | 20 passed, 1 skipped: the existing cold-resumed task test requires 0.2.1 |

The seven new regressions pass on every tested cohort, including PTC on 0.2.0-rc.2. The baseline reproduction failed before the production fix; the child-guidance assertion also failed before its narrow Wake recovery was added. Missing sourcemaps in published DSH packages and Node experimental API warnings were non-fatal. This PR changes no dependency version, CI matrix, configuration or persistent format and makes no general compatibility claim about untested DSH releases.
