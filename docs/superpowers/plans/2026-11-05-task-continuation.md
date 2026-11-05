# User-directed memory task continuation

> **For agentic workers:** Use superpowers:executing-plans in the existing PR #567 worktree. The user approved this behavior in chat and requested the PR update; implement without another permission gate.

**Goal:** Let users continue reading and changing memory in a completed task's conversation, while history inspection, Host restart and automatic notifications cannot repeat the completed task.

**Architecture:** Recognize Mnemon task records durably and install a separate, user-directed turn lifecycle when they resume. Each accepted new user message gets a fresh normal memory View using the session's workspace and current configuration; release it at turn end. Task continuation never registers ordinary idle-review/Skills automation, and never reopens an old completion callback.

**Tech Stack:** TypeScript, public DSH/Cordis services, Vitest real-Host fixtures, isolated WebUI.

**Spec:** User-approved chat design immediately before “按照这个调整pr”: same conversation/history, new execution authority and results, original task stays completed, no automatic writes on viewing/restart/notifications.

## Global constraints

- Update existing PR #567 only; preserve official rc.1 and fixed master fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159 coverage and older Host CI.
- Do not edit DSH source or weaken normal View, enabled-source, workspace, write-policy, cancellation or result-identity checks.
- Automatic Agent messages, completion notices and history replay cannot authorize memory operations. Subsequent user messages can.
- No stale completion request can overwrite an earlier result or trigger duplicate effects.
- Use synthetic data, preserve existing evidence as historical where behavior changes, and keep credentials/raw logs out of Git.

## Review focus

- Human continuation followed by an automatic message: authority must end with the human turn.
- Cold resume or Mnemon recreation: new user input works without borrowing an old parent View.
- Root tasks and delegated children: own workspace/current policy wins; new delegated work must remain possible.
- Disabled writes/changed source selection/second workspace: no revived old authority or cross-workspace mutation.
- Concurrent task continuations, cancellation and failed View preparation: no leaked or shared permits.

## Task 1: Explicit user continuation lifecycle

**Files:** new `src/host/task-continuation.ts`; `src/host/lifecycle.ts`, `src/host/subagent.ts`, task identity helpers and focused real-Host tests.

**Interfaces:** `TaskContinuation` owns one restored Agent's temporary memory turn and scoped guard; task identity uses reserved IDs on Hosts with public activation childId support; older one-shot startup stays compatible. `MnemonSubagentCoordinator` recognizes/installs/restores continuations and disposes them with its lifetime; `MnemonLifecycle` excludes them from conversation automation.

- [x] Add real-Host failing tests for root/child manual write and recall, automatic refusal, repeat manual turns, expired completion, cold restore and changed scope/policy.
- [x] Run focused specs; observe the existing finished-task refusal on the manual path.
- [x] Add durable recognition and per-user-turn authority using `AgentMemoryTurn`; keep existing automatic-message refusal tests.
- [x] Verify first-step scope, delegated operations and cleanup on baseline, official rc.1 and pinned master. Extend failure/concurrency coverage where the implementation exposes a distinct boundary.
- [x] Commit the verified runtime/test changes.

## Task 2: Evidence, review and PR update

**Files:** bilingual compatibility docs/register, existing changeset, `docs/pr-assets/dsh-master-agents/`, PR description.

- [ ] Capture real Host continuation in the same task conversation, stored readback and a refused automatic continuation, including after restart; label controlled/live evidence accurately.
- [ ] Update old finished-task screenshot claims to historical behavior and explain the new user-directed behavior in both languages.
- [ ] Run `pnpm run verify`, official rc.1 and pinned-master installed-Host suites; inspect failures and record exact counts/limits.
- [ ] Obtain independent whole-branch review, fix important findings, and verify affected paths.
- [ ] Push to `codex/compat-dsh-master-agents`, update PR #567 around its final behavior, and check remote CI.

## Execution record

- Initial PR head: c2d2445ec9c379a016e4dba469e768a2f6f4ae98. Worktree clean; existing PR CI had 10 passing checks.
- Existing coordinator revokes completion request IDs and releases workflow Views in `finally`; the new path must acquire fresh authority.
- Fixed master records direct browser prompts as source `user`, Agent relays as `agent-message`, and task notices as `subagent-settled`. Existing Mnemon synthetic continuation prompts use their plugin source.
