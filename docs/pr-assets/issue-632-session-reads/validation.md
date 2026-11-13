# Issue 632 validation / 验收记录

Base: `1dec529da00a9527351efd329a4beac400cd399a` (`0.5.45`).

- A synthetic 46,000-event session rejects unbounded reads. Both regression cases fail on the base, and pass with the fix. Recent turn/step, checkpoint and failure-detail reads touch fewer than 600 events per case. / 4.6 万条事件的合成会话会拒绝无界读取，原版本两项复现失败，修复后通过；近期状态、审查片段和错误查询不读取完整历史。
- Every production snapshot has explicit bounds of at most 256 events. Activity and skill projections preserve receipts across page boundaries and retain old turns; a second unchanged refresh performs no snapshot reads, and an append reads only the new range. A long open turn is not rescanned by each tool guard. / 所有生产快照均明确限定范围，最多 256 条；跨页工具凭据及旧轮次记录保留，重复刷新无需读取，新事件仅增量处理，工具守卫不反复扫描长轮次。
- `pnpm run verify`: docs, types, deterministic build, workspace builds/types/tests passed. Root tests hit the existing 5-second skill-backtest deadline under default parallel load. Full rerun with `pnpm run test:root --maxWorkers=2 --minWorkers=2`: **2,744 passed, 9 conditional skips**. `verify:headless` and `verify:package` then passed. / 全部验证阶段已完成；默认并发下已有技能回测超时测试失败一次，降低并发整套重跑通过，未修改超时或测试逻辑。
- Official npm DSH **0.2.2-rc.3**, Node **24.22.2**, installed-host tests: **311 passed, 1 conditional skip**, covering bounded reads, lifecycle, turn Views, skill evolution, idle review, Team review and task-session continuation. All model work used synthetic local fixtures. / 官方安装包验证覆盖生命周期、View、技能、审查、Teams 和任务会话续聊，模型均使用本地合成数据。

This verifies read bounds, incremental behavior and preserved functionality. It does not claim to reproduce the reporter's exact 188-second stall or RSS peak without their original log and environment. No UI, configuration or stored-session format changes. / 已验证读取边界、增量行为及功能保留；未使用报告者原始日志和环境，不宣称复现其具体的 188 秒停顿或内存峰值。UI、配置及会话持久化格式不变。
