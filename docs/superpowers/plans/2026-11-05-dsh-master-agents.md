# DSH master Agent compatibility implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user approved the design and requested implementation and a PR; continue without another approval gate.

**Goal:** Keep the official DSH 0.2.2-rc.1 behavior while supporting the Agent/Subagent contracts in master `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, with visible independent task sessions as the accepted master-only difference.

**Architecture:** Detect runtime contracts by their public capabilities, not the shared version string. Keep the published-host path; use reserved child identities for creation-time composition on activation-owned Hosts. New-master independent tasks are ordinary owned roots with durable task identity and descriptive titles; they never inherit user conversation history or recursively trigger automatic work.

**Tech Stack:** TypeScript, Cordis/DSH, Vitest, built WebUI, isolated profiles and synthetic data, limited user-authorized DeepSeek live-model acceptance.

**Spec:** User-approved design in this chat: one plugin artifact, unchanged agent functions and controls, rc.1 remains silent, master may expose previously internal task sessions, and substantial real-Host screenshots accompany the PR.

## Global constraints

- Pin source acceptance to `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`; it reports rc.1 but is not the official rc.1 artifact.
- Preserve supported older DSH branches and the official rc.1 CI job. No alpha support claim.
- Guards and persona/tool composition must exist before first model/tool execution; failures must roll back without an unguarded retry.
- Preserve model route, reasoning effort, preset, workspace, memory view, result identity, cancellation and cleanup.
- A task may be visible; it must remain identifiable after restart and must not join the normal conversation review loop.
- Test profiles/data are disposable. Credentials, raw private logs and local paths stay out of Git. Screenshots use synthetic records and exclude secrets.

## Review focus

- Concurrent and nested same-parent starts must not attach each other's guard or persona.
- A same-ID replacement, missing publication or failed guard must not gain execution authority.
- Resuming a completed visible task after restart must not recreate automatic review or repeat a completed write.
- Publication-time root queries must not reject a legitimate child before its Activation exists.
- Provider discovery, fork context and route selection must preserve the supported delegation behavior.

## Task 1: Dual-contract child startup

**Files:** `src/host/dsh.ts`, `src/host/agent-compat.ts`, `src/host/subagent-start.ts`, `src/host/review-tools.ts`, `src/host/continuation-turn.ts`, `src/host/subagent.ts`; corresponding unit and real-Host specs.

**Interfaces:** Structural optional `rootOf`, `roots`, `list` and reserved `childId`; a shared creation scope binds the reserved ID to the parent and actual child. Existing public Mnemon SDK signatures stay unchanged.

- [x] Add failing tests for flattened master startup, provider selection without the old list method, exact-child composition/guards, overlap, nested starts, rollback and cancellation.
- [x] Observe failures on the current implementation; baseline ownership/task/guard suite is 31/31 passing.
- [x] Implement capability-selected startup and shared publication identity; retain legacy nested request and ownership checks.
- [x] Run the targeted unit and real-Host tests against baseline, official rc.1 and built pinned master.
- [x] Commit the tested change.

## Task 2: Conversation and independent-task lifecycle

**Files:** `src/host/lifecycle.ts`, focused task-identity helper if required, `tests/task-agent-session-host.spec.ts`, `tests/agent-ownership-host.spec.ts`, `tests/lifecycle.spec.ts`, restart/resume coverage.

- [x] Add failing master tests: no roots method, fresh ordinary task roots, correct parent/child memory scope, visible title/identity, and no automatic work after task resume.
- [x] Implement authoritative root classification and marker-based task exclusion; preserve rc.1 hidden-task metadata.
- [x] Verify Save to memory, Ask Agent, idle review, runtime maintenance and Skills task execution, including cancellation and two-workspace concurrency.
- [x] Commit after targeted tests and typecheck pass.

## Task 3: Real-Host UI and model acceptance

**Files:** Acceptance harness and sanitized evidence under `docs/pr-assets/dsh-master-agents/`; installed/source Host test helpers if needed.

- [x] Run the same built Mnemon packages on official rc.1 and fixed master with isolated profiles.
- [x] Capture actual desktop-width WebUI screenshots for ordinary chat recall, AI save, Ask Agent, idle review, Skills generation/backtest, and actual master session visibility; compare rc.1 behavior.
- [x] Use the authorized DeepSeek key for bounded live checks; verify tool receipts/data and cancellation in addition to screenshots. Report controlled-model and live-model evidence separately.
- [x] Restart each Host and verify data/task identity/session visibility. Sanitize and inspect every committed screenshot.

## Task 4: Documentation, verification and PR

- [x] Add a root patch changeset and bilingual compatibility documentation stating official rc.1 did not remove these methods; the fixed master did.
- [x] Keep existing CI coverage; add reproducible pinned-source validation without depending on unavailable private-repository CI credentials.
- [x] Run appropriate full verification, official rc.1 and source-Host checks; record exact results and limitations.
- [x] Obtain a fresh whole-branch review using superpowers:requesting-code-review; fix important findings with regression tests.
- [x] Push `codex/compat-dsh-master-agents` and open one PR with linked screenshots and compatibility scope: [PR #567](https://github.com/omdsh-dev/dsh-mnemon/pull/567). Do not merge or publish.

## Execution record

- Baseline: 31 tests passed across ownership, task sessions and idle-review access on the pinned development Host.
- Source preparation: frozen pnpm install succeeded. The first source build used a minimal Node 24 distribution without C headers; the full Node 25 distribution completed all 10 build gates. Runtime acceptance uses Node 24.22.2.
- Additional discovery: master also removed `subagents.list()`. Include provider selection in the adapter and verify supported alternatives; do not silently weaken provider capability requirements.

- Core validation: `pnpm run verify` passed (2,506 root tests and 753 workspace tests; 8 root and 3 workspace skips). The same branch passed official rc.1 (2,506 passed / 8 skipped) and pinned master (2,507 passed / 7 skipped).
- Source test resolution now indexes the selected workspace instead of accidentally falling back through pnpm NODE_PATH to the old development cohort. No DSH source was modified.
- The graduated Team package requires per-session enablement and per-step conditional tool admission. Mnemon preserves its pause/scoped policies; the real Team matrix passes with spawn/fork, native/PTC, cancellation and intact parent Team tools.

- Final verification: 2,515 root tests / 8 skips plus 753 workspace tests / 3 skips; official rc.1 2,515 / 8; fixed master 2,516 / 7. Provider preloading/recreation/rename/removal regression passes; old Cordis fixtures wait for the public reload barrier. Snapshot comparisons ignore read-time timestamps.
- Live acceptance: 53 HTTP-200 DeepSeek requests. Both Hosts completed recall, Save, Ask, idle review and Skills draft generation. rc.1 Skills backtest remains partial: 1 scored case execution, 3 malformed-input execution failures (6 attempts); both Host parsers reject the same inputs offline. No skill was adopted.
- Real sidebar discovery refined the visibility assumption: master ACP exposes task roots, while its WebUI filters blank non-current roots. Both screenshots show only user conversations. Full Host restarts retained all session IDs/data; a real resumed-task write was denied with no sentinel insight or new automatic task.
