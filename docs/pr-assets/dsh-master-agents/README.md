# Official DSH rc.1 and activation-owned master

[简体中文](./README.zh-CN.md) | **English**

Acceptance date: 2026-11-05. These screenshots use the built PR packages, still labelled `0.5.40`, in two disposable Hosts with fictional Lumen data. They are not screenshots of a released compatibility update. [Verification record](./verification.json).

## Scope and behavior

- Official npm `@deepseek-ai/dsh@0.2.2-rc.1` (tag commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`) retains registry ownership, provider enumeration, nested activation requests and hidden detached tasks. Its branch is preserved.
- The separately built, unmodified master snapshot is exactly `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Its identical package version is not evidence of identical APIs. It uses `subagents.rootOf()`, flat activation requests and ordinary task roots.
- Both use Node 24.22.2 for installed-Host tests and WebUI acceptance. The source build completed all 10 build gates with the full Node 25.6.1 distribution. Official npm/older Host CI targets remain; the unpublished source snapshot is a separate local check, not a promise of arbitrary master or alpha support.
- Child publication is guarded before its first step. Model, effort, preset, working directory, pinned memory authority, result identity, cancellation and disposal remain covered. The real Host tests also exercise runtime compaction, Document creation/archive, provider placement, metadata maintenance and Team pause/scoped policies with spawn/fork and native/PTC.
- Configured custom provider names are discovered even before Mnemon starts, after Mnemon recreation and after rename/removal. A provider with no public `providerName` configuration can be named in `subagentProviderNames`; all existing live-provider/isolation checks still apply. This setting does not select a Memory Space provider.

## Actual visibility

Master task roots retain `mnemon-task-v1-…` IDs and `Mnemon · …` titles and are discoverable by ACP after completion. The standard WebUI hides non-current roots whose `sessionListMetadata.blank` is true. The six task roots in this live run had titles and child catalogs but no root conversation turn: **both actual sidebars showed only the two user conversations**. Workspaces use explicit session membership, not cwd equality. Missing list metadata, a different client or explicit opening can expose a task record; master is not guaranteed silent. No synthetic user turn was inserted to make a screenshot look different.

The completed idle-review child is accessible through its parent's subagent menu on both versions. This is distinct from independent task roots. Direct reads and direct search do not start an Agent or create task sessions. Durable task/run identity prevents reopened completed master records from joining conversation automation or obtaining Mnemon write tools.

| Surface | Fixed master | Official rc.1 |
|---|---|---|
| Ordinary chat recall and Documents retrieval | [Screenshot](./master-live-recall.jpg) | [Screenshot](./rc1-live-recall.jpg) |
| Save to memory: actual AI write receipt | [Screenshot](./master-live-save.jpg) | [Screenshot](./rc1-live-save.jpg) |
| Stored record, independently read back | [Screenshot](./master-stored-memory.jpg) | [Screenshot](./rc1-stored-memory.jpg) |
| Ask Agent: answer with matching memory citation | [Screenshot](./master-live-ask-agent.jpg) | [Screenshot](./rc1-live-ask-agent.jpg) |
| Completed real-model idle review | [Screenshot](./master-live-idle-review.jpg) | [Screenshot](./rc1-live-idle-review.jpg) |
| Generated Skills draft | [Screenshot](./master-live-skills.jpg) | [Screenshot](./rc1-live-skills.jpg) |
| Backtest outcome (including rc.1 failures) | [Screenshot](./master-live-backtest.jpg) | [Screenshot](./rc1-live-backtest-error.jpg) |
| Actual default sidebar | [Screenshot](./master-session-list.jpg) | [Screenshot](./rc1-session-list.jpg) |
| Saved memory after full Host process restart | [Screenshot](./master-after-restart-memory.jpg) | [Screenshot](./rc1-after-restart-memory.jpg) |

The browser's normal viewports were left unchanged. The source Host and npm Host have upstream UI differences; screenshots establish actual behavior, not pixel-identical layouts.

After full process restarts, all 23 master and 21 rc.1 session records remained, with zero new task sessions from reopening/reading. Each Host retained exactly one acceptance memory. Reopening the completed master idle-review child and actually calling `mnemon_remember` returned the finished-task guard error; the sentinel was absent from all Native insight tables. The initial `mnemon_runtime_memory` probe was unavailable in that tool set, so it is not counted as a guard invocation. [Actual rejected call](./master-after-restart-guard.jpg).

## Real-model results and limits

The relay recorded 53 HTTP-200 model requests within a 64-request bound; HTTP success includes the malformed outputs described below. Exact usage counters are in the verification record.

The user-authorized `deepseek-flash` route (UI: DeepSeek-V4.1-Flash, High) completed chat recall, Documents retrieval, Save, cited Ask Agent, idle review and Skills proposal/draft generation on both Hosts. The synthetic write recorded the 180 ms API target, 5/25/100% rollout, 20-minute observation, 0.5% rollback threshold and 48-hour image retention. Ask Agent retrieved and cited that same new record.

Skills backtest execution and content quality are separate. Master produced four scored baseline/draft case executions; the draft's aggregate score improved, but individual factual criteria still failed. No generated skill was adopted. On official rc.1 only **one of four case executions was scored; three failed** with `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`. Each failed case used the existing two-attempt policy, leaving six failed executor sessions. All six saved tool inputs lacked the final outer `}`; five also lacked the required `result.answer`. The completion instructions, schema, High effort and 16,384-token limit remained present. No input was silently repaired or counted as success.

Independent review replayed all six saved inputs through both actual Host translators: both rejected all six identically. Their compiled translation/SSE/adapter/replay code was identical. This supports an incomplete-input failure rather than a compatibility-branch regression; it does **not** turn the rc.1 live backtest into a pass. The preserved Host stream is the evidence boundary, not an independently captured upstream HTTP stream. The controlled-model compatibility suites separately cover valid execution, grading, guards and cancellation. This is not a live certification of every model or third-party Memory Space provider.

A loopback relay forwarded model requests/responses unchanged and retained only request counts, model and usage metadata. Four initial fixture endpoint requests returned 404 before the route was corrected to DeepSeek's Anthropic endpoint; they produced no successful model result. Credentials and raw sessions are excluded from this evidence.

## Reproduce the Host checks

Use an authorized, separate DSH checkout at the exact commit above. Install its frozen dependencies and build without source edits; set `DSH_SOURCE` to that checkout and `RC_INSTALL` to a separate installation containing the exact official npm package. `NODE24` is the Node 24.22.2 executable. From the Mnemon checkout:

```sh
pnpm run verify
DSH_HOST_ROOT="$RC_INSTALL/node_modules/@deepseek-ai/dsh" "$NODE24" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
DSH_HOST_ROOT="$DSH_SOURCE/apps/cli" "$NODE24" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
```

The installed-Host resolver maps source workspace package names and prevents accidental fallback to older development packages through `NODE_PATH`. Source build/runtime acceptance does not modify DSH or add a private-source checkout requirement to public CI. The API request differences and evidence support the upstream request [dsh-external/issues#681](https://github.com/dsh-external/issues/issues/681).
