# Issue #554: source Host Agent ownership

## Scope / 范围

Fix activation after `agents.roots()` disappears and preserve exact live ownership for conversation-bound memory, spawn/fork composition, review guards, cancellation and cleanup. Source-only standalone management is refused before Session creation: no ordinary visible task conversation is created. This is not a claim of full source DSH 0.2.2 compatibility.

修复 `agents.roots()` 移除后的激活故障，并保留对话记忆、spawn/fork 组合、审查守卫、取消和清理的确切存活实例归属。源码版独立管理在创建 Session 前拒绝，不创建可见的普通任务会话；不宣称全面兼容 DSH 0.2.2 源码版。

The source build and published package carry the same version string but different contracts:

| Host | Registry | Subagent runtime |
|---|---|---|
| npm `0.2.2-alpha.3` | `roots`, `isOwnedBy`, `list` | no `rootOf` / `lineageOf`; nested activation request |
| source `8bd073392eef6f54e921a093b95076248eb08cbb` | `list`, no ownership methods | `rootOf`; flat activation request; no provider enumeration |
| upstream `b3d4933f39ff33733f7f5d6a422addec62168fc9` | no registry ownership | `lineageOf` returns exact root and verified creation ancestors at `agent/created`; covered by contract tests, not a second source-build claim |

## Upstream contracts / 上游契约

- [Reported source revision](https://github.com/deepseek-ai/deepseek-harness/commit/8bd073392eef6f54e921a093b95076248eb08cbb).
- [Source rootOf and admission ordering](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/subagent/subagent/src/manager.ts): the managed activation becomes resident after `agent/created`; `subagent/start` then runs before `submitAdmitted` checks cancellation and queues the prompt.
- [Contained lifecycle notifications](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/subagent/subagent/src/lifecycle.ts): listener exceptions are logged, not propagated. Mnemon's isolated start cancellation scope therefore aborts admission synchronously on hook failure.
- [Public activation/provider API](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/subagent/subagent/src/index.ts).
- [Publication-time lineage contract](https://github.com/deepseek-ai/deepseek-harness/commit/b3d4933f39ff33733f7f5d6a422addec62168fc9).
- [Agent factory options](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/core/agent/src/index.ts) and [Session persistence API](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/session/session-persistence/src/index.ts) expose no hidden/temporary standalone-root option or public Session deletion. No metadata-based ownership bypass is used.

## Reproduction / 复现

Use disposable directories only, with Node `24.22.2`. The official source was checked out at the exact revision above and built unmodified with its pinned pnpm `11.28.5`:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries
pnpm run build:native-system
```

The native build needs matching Node development headers. `git status --short` remained empty after the build. Mnemon's tsconfig and dependency versions remain pinned to published npm packages.

From the Mnemon checkout, use the canonical physical path of that source build's `apps/cli` as `DSH_HOST_ROOT` and remove ambient `NODE_PATH`:

```sh
env -u NODE_PATH DSH_HOST_ROOT=<physical-source-root>/apps/cli \
  node node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts \
  tests/agent-ownership-host.spec.ts
```

The same fixture runs against a published `@deepseek-ai/dsh` installation by changing only `DSH_HOST_ROOT`. All model responses and data are synthetic; no paid API, Desktop profile, credentials or personal memory was used.

## Evidence / 验证

- Before the production change, all six original real-host cases failed at `MnemonLifecycle.start`: `this.ctx.agents.roots is not a function or its return value is not iterable`.
- After the ownership change, the next failure identified the source Host's flat activation request. After that adaptation, actual guarded spawn/fork execution and cancellation passed.
- The coordinator provider test failed with `this.subagents.list is not a function` before the provider-lookup adaptation.
- The standalone-management rejection test initially resolved successfully and created a task Session. The final preflight rejects before the callback, with unchanged persisted Session inventory and zero model calls.
- A real nested creator initially failed composition; same-scope indirect descendants initially received an unrelated root review guard. Direct-creator publication evidence now distinguishes them while validating both exact live instances and their tree root. The production coordinator keeps `maxDepth: 1` and rejects a resident child's further delegation before creating another child or calling a model.
- Final results are summarized in `results.txt`; the broader alpha/profile limitations below are part of the acceptance record.

## Known limits / 已知限制

Source-only standalone management is unavailable: standalone Skills tasks, Memory-page evidence answers and Save to memory, Runtime maintenance, Document creation/archive, Provider placement, and Memory Space metadata maintenance. The error directs users needing these operations to the verified published `@deepseek-ai/dsh@0.2.1-rc.5`. Existing published Hosts retain the hidden-task behavior. No Session is migrated, rewritten or deleted.

源码版上述独立管理入口明确拒绝，并提示需要这些功能的用户使用已验证的发布包 `@deepseek-ai/dsh@0.2.1-rc.5`；已发布 Host 的隐藏任务行为保持不变，不迁移、改写或删除 Session。

The full npm alpha.3 root suite already failed on the unchanged base: 31 View-management tests across three files, plus four legacy descriptor-repair tests. Rebuilding both root and independent plugins did not remove them. These results are not attributed to ownership changes or all dismissed as test drift. The descriptor failures assert upstream rejection, but alpha.3 now accepts those inputs; the View-management failures are tracked separately from ownership acceptance for matching-Loader fixture/cohort investigation. Baseline and final commands use canonical physical Host paths and unset `NODE_PATH`.

The source Headless verification passes its enabled-plugin checks, then fails the disabled-profile completeness assertion because upstream `typert-loader` remains pending on `typert`. It is not recorded as a passing full profile verification. Existing published RC verification remains required and unchanged.

The no-first-prompt guarantee for publication hook failures applies to activations started by Mnemon, whose startup scope can cancel admission. Native Host activations bypass that scope: source DSH contains child-memory installation failures and can run the ordinary model without memory. Real-host retain/hook failure tests verify that the child's pinned-View reads and Actions reject, never borrow the root's active View, and leave no retained child runtime binding or pin. This is an explicit degraded native path, not a claim that Mnemon can cancel every Host activation.

发布 hook 失败时“首个 prompt 不入队”的保证只适用于 Mnemon 发起、受其启动取消域保护的任务。Host 原生激活不经过该取消域；源码 Host 吞掉子 Agent 记忆安装异常后，普通模型仍可能继续。真实 Host 测试验证了此时子 Agent 无 View 的读取和 Action 均拒绝，不借用 root 的当前 View，也不残留子 Agent 的运行时绑定或 pin。
