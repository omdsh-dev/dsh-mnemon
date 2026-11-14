# Issue 629 validation / 验收记录

Base: `1dec529da00a9527351efd329a4beac400cd399a` (`0.5.45`).

## Reproduction / 复现

On the unmodified base with official npm DSH `0.2.2-rc.3`, an earlier `agent/created` observer returning `1` stops Cordis serial dispatch. Both coordinator review and explicit remember fail with the issue's exact `Mnemon review/write provider did not publish a local child with its scoped tool guard` error. Persona composition was already prepended; guard setup was not. / 在未修改的基线与官方 rc.3 上，前序监听器返回 `1` 会提前结束串行分发，两种入口均复现 issue 中的原始报错；persona 已前置，守卫尚未前置。

Moving only the guard removes that startup error but can still leave the child's memory View unbound. The fix moves guard, continuation recovery and lifecycle binding into the same early publication phase. No ownership or tool-policy checks are removed. / 仅提前守卫仍可能缺少记忆 View 绑定，因此同时前置守卫、续聊恢复及生命周期绑定，不移除身份与工具权限校验。

## Results / 结果

- Six real-host regressions cover review through spawn/fork, explicit remember, native tools, Code Mode and automatic idle review. They verify persisted Runtime Memory or Memory Space content, exact result handling, child cleanup, and reloadable parent history. / 六项真实 Host 回归验证两类写入、Provider、Code Mode、自动空闲审查、持久化内容、结果处理、子实例清理及历史可重新加载。
- Official npm `0.2.2-rc.1` and `0.2.2-rc.2`: **88 passed, 1 conditional skip each** across review, guard, activation identity, continuation, Team and task-session suites. / 两个官方版本的相关测试分别通过 88 项。
- Official npm `0.2.2-rc.3`: **100 passed, 1 conditional skip**, including real ownership/failure rollback. / rc.3 额外验证真实 Host 的身份隔离和失败回滚。
- Full baseline root suite: **2,745 passed, 9 conditional skips** with two workers. Docs, typecheck, deterministic build, workspace build/types/tests, Headless and package validation passed. The initial full run exposed the old guard-failure fixture injecting after the new early guard; injection now targets the public service method before startup, retaining the zero-model-call assertion and adding an empty-child-registry assertion. / 完整验证通过；原故障注入时机被新顺序提前超过，现改为启动前注入公共 service 方法，保留零模型调用断言并加强实例清理验证。

The reporter's exact plugin/observer combination was not available. These tests establish a reproducible cause with the same errors; they do not claim that every possible missing-guard failure is this cause. Unexpected ownership/guard failures remain closed. All models/data were local synthetic fixtures; no private memory or paid model API was used. / 未取得报告者完整插件及监听器组合，验证的是能复现相同错误的明确原因，不宣称所有守卫缺失均来自此原因；其他身份或守卫异常仍拒绝执行。全部使用本地合成模型与数据。
