# Idle review after Agent disposal / Agent 销毁后的空闲审查

Issue: [#623](https://github.com/omdsh-dev/dsh-mnemon/issues/623). Base: `455dd1c017d82c4f75af1b9510d383c059b0690e`.

## Behavior / 行为

A queued review whose Agent context is already inactive starts no worker and consumes no attempt or cooldown. Mnemon does not install lifecycle, recovery or continuation effects on disposed contexts. Mandatory child tool isolation still fails closed if publication races teardown.

排队期间上下文已经销毁的审查直接跳过，不启动子代理、不消耗次数或冷却。失效上下文不再安装生命周期、恢复或接续监听。若子代理发布与销毁并发，工具隔离仍拒绝未受保护的执行。

Inactive-context errors during review preparation or cleanup, including wrapped Cordis errors, produce no new review-failure banner when no writes committed. Actual failures and partial-write receipts remain visible. The existing reservation policy is unchanged: once asynchronous review preparation has reserved an attempt, cancellation does not rewind the budget or replay the checkpoint.

审查准备或清理中的上下文失效错误，包括包装后的 Cordis 错误，在没有已提交写入时不新增失败横幅。真实失败和部分写入回执仍保留。现有预留规则不变：异步准备阶段已经预留的次数不会因取消而退回，也不会自动重放检查点。

## Regression evidence / 回归证据

The new lifecycle tests failed on the unchanged base: four failures and one passing partial-write control. After the fix:

新增生命周期用例在原代码上有 4 项失败，部分写入对照通过。修复后的断言包括：

| Scenario / 场景 | Verified result / 验证结果 |
| --- | --- |
| Already inactive root / 根 Agent 已失效 | No effect installation; zero adopted Agents / 不安装 effect，不纳入生命周期 |
| Stale timer, persistence off/on / 内存与持久限额下的过期定时器 | No worker, zero attempts, no next-review time, no error / 不派子代理、不计次、不产生冷却或错误 |
| Wrapped inactive-context error without writes / 无写入的包装失效错误 | No failure counter or banner state / 不增加失败计数或横幅状态 |
| Same error after a Document committed / 档案提交后发生同类错误 | Partial receipt retained, failure remains visible / 保留部分写入回执与失败提示 |
| Disposed parent/child publication / 父子上下文已销毁 | No unguarded worker / 不放行未受保护的子代理 |
| Real Host close before timer / 真实 Host 在计时结束前关闭 | Zero model calls or reservations; reopening allows a later normal review / 不调用模型、不预留；重新打开后可正常审查 |
| Real Host close during preparation / 真实 Host 在准备中关闭 | No child/model call, no failure; existing reservation retained / 不启动子代理、不报失败；已有预留保留 |

Focused tests on the published DSH **0.2.2-rc.1** and **0.2.2-rc.2**, both with Node **24.22.2**: **347 passed each**. These execute actual Cordis scopes and DSH Agent/session/subagent services with local scripted models; no paid API, real user memory or native Windows Desktop session is involved.

正式发布的 DSH **0.2.2-rc.1** 与 **0.2.2-rc.2**（Node **24.22.2**）定向测试各 **347 项通过**。使用真实 Cordis scope 和 DSH Agent、会话与子代理服务，模型为本机确定性夹具；没有付费 API、真实用户记忆或原生 Windows Desktop 会话。

```sh
DSH_HOST_ROOT=<published-host> pnpm run test:installed-dsh \
  tests/agent-context.spec.ts tests/lifecycle.spec.ts tests/review-tools.spec.ts \
  tests/continuation-turn.spec.ts tests/subagent.spec.ts \
  tests/agent-ownership-host.spec.ts tests/idle-review-watermark-host.spec.ts
```

The full verification initially hit the pre-existing five-second hung-backtest test timeout under concurrent load. Its unchanged focused rerun passed. Full-suite and package results are recorded in the PR validation section.

首次完整验证在并发负载下遇到已有的技能回测用例五秒超时；原样定向重跑通过。全套与包验证结果记录在 PR 的验证章节。

## Compatibility / 兼容性

No new setting, storage format or public Source/Provider contract. The lifetime method is optional for older adapters. Review mode, model selection, tools and quotas retain their existing semantics. Upgrading or rolling back requires no data migration.

没有新增设置、存储格式或 Source/Provider 契约。旧适配器可以没有生命周期查询方法。审查模式、模型选择、工具与配额语义保持原有规则；升级与回滚不需要数据迁移。
