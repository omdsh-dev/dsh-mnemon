# Scoped memory tool availability / 作用域记忆工具可用性

The report permits keeping the View consistent with the current tool surface. This fix implements that path using DSH's public `tools.get(name, agent)` lookup. It does not re-register hidden tools, lift restrictions, or claim to identify the reporter's unprovided `ops-ptc` preset. Execution guards remain authoritative.

Issue 接受让 View 与当前工具面一致的解决路径。本修复使用 DSH 公共 `tools.get(name, agent)` 查询实现该方案，不重新注册被隐藏的工具、不解除限制，也不声称已取得或定位报告者未提供的 `ops-ptc` 预设。执行守卫仍是最终约束。

## Real Host reproduction / 真实 Host 复现

`tests/source-tool-lifecycle-host.spec.ts` composes published DSH tools, AgentLoop, Session storage and the actual Mnemon lifecycle. Its PTC case also loads the published Node PTC runtime and sandbox services. Only model choices and test data are synthetic; no external model API is used.

该测试组合正式发布的 DSH 工具、AgentLoop、Session 存储及真实 Mnemon 生命周期。PTC 用例还加载已发布的 Node PTC runtime 与沙箱服务；仅模型选择及数据使用合成夹具，未调用外部模型 API。

A scoped allowlist retains Runtime, recall, status, space inspection, Document search and create, matching the report's callable set. Before the fix, both native and PTC cases fail because the View still lists `mnemon_remember` and other hidden tools.

作用域白名单保留 Runtime、召回、状态、空间目录、档案搜索和创建，与报告中的可调用集合一致。修复前，普通模式和 PTC 模式均因 View 仍宣称 `mnemon_remember` 等隐藏工具可用而失败。

After the fix / 修复后：

| Check / 检查 | Observed / 实测 |
|---|---|
| Restricted PTC SDK / 受限 SDK | `sdk:undefined\|function` for remember / runtime |
| View availability / View 可用性 | Lists the allowed tools and omits hidden ones / 仅列出可见工具 |
| Allowed Runtime add / 允许的 Runtime 写入 | Synthetic content persisted / 合成内容写入成功 |
| Lift the scoped restriction / 解除作用域限制 | SDK returns `sdk:function\|function`; next View advertises remember again / SDK 及下个 View 同步恢复 |
| PTC model surface / PTC 模型面 | Only `run_code`; its permitted SDK tools remain advertised / 仅 `run_code`，允许的 SDK 工具仍正常列出 |

## Preservation checks / 保持行为检查

Unit regressions cover a partly visible tool family, no tools, only generic reads, only generic writes, exact-ID repair hints, legacy Hosts without lookup, and unchanged output for an unrestricted scope. Filtering does not mutate the pinned View, digest, grants or Runtime content. Existing snapshot and subagent request-prefix tests preserve append-only behavior and the Runtime inheritance switch.

回归覆盖部分工具族、全隐藏、仅通用读取、仅通用写入、精确 ID 错误提示、缺少查询接口的旧 Host，以及无限制作用域输出不变。筛选不修改固定 View、digest、授权或 Runtime 内容；原有快照和子 Agent 请求前缀测试保持 append-only 行为及 Runtime 继承开关。

Commands / 命令：

```sh
pnpm exec vitest run tests/memory-tools.spec.ts tests/source-tool-lifecycle-host.spec.ts tests/memory-snapshot.spec.ts tests/default-three-tier-host.spec.ts
pnpm run verify
```

The three new unit regressions and two real Host regressions fail against the original production files and pass after the fix. The four focused suites contain 143 passing tests. / 三个新增单元回归及两个真实 Host 回归均在原生产代码上失败，修复后通过；四个定向测试组共 143 项通过。

Full verification / 全仓验证：`pnpm run verify` passed with 3,737 tests passed and 14 existing optional tests skipped; type checks, builds, Source suites, docs, Headless and package checks passed. / 类型、构建、Source、文档、Headless 及打包检查全部通过。
