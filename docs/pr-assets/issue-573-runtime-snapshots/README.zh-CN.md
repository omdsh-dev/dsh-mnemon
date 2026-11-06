# 有界 Runtime 快照历史

**简体中文** | [English](./README.md)

Issue：[#573](https://github.com/omdsh-dev/dsh-mnemon/issues/573)。基线：`20ab2b57f4c6241165b08c415bfa802354eea11f`，dsh-mnemon 0.5.41。2026-11-06 使用 Node 24.22.2 验证。记忆均为合成数据；只脚本化模型选择，没有调用外部或付费 API。

## 行为与证据

原修复每次内容变化都会淘汰旧快照。当回归测试要求完整保留上一次请求前缀时，原实现失败。修订后的策略允许 Runtime 新增和年龄变化在一组中追加，最多保留**四份完整快照或 64 KiB UTF-8 文本**；再追加会越过任一预算时，将旧组 checkpoint 为当前完整快照。当前单份超过 64 KiB 时仍独立完整保留，不截断。这些阈值是初始工程默认值，不是实测最优缓存配置。

真实 Host 测试显式使用 default-three-tier Strategy，同时包含 Runtime、Documents、Memory Spaces ReadGrant，以及额外 Runtime/Documents 实例。native 和 PTC 均执行真实 status/search 工具。八个回合、24 次模型请求中，每回合快照数量为 `1, 2, 3, 3, 3, 4, 1, 1`；组内和 checkpoint 后各执行一次 JSONL 卸载恢复。除 checkpoint 请求外，每次请求都逐字保留前一请求的完整模型消息前缀，工具定义也保持一致。预算 checkpoint 恰好产生一次新 request series。普通 Runtime 写入没有改变授权边界或 surface content generation。

实际请求还覆盖事实修正、删除、分支切换、复制历史到另一工作区、渲染快照完全同文的 Documents grant 撤回，以及 Runtime 投影权限关闭。禁用 lifecycle 注入、自有插件请求或无 View 都不会绕过清理。被拒绝、取消或首批为空的回合不发请求，也不会提前写淘汰记录；下一次适用请求会清除旧快照。既有委派 View 租约和工具权限测试继续通过。

五种真实 Host middleware 顺序覆盖全局/agent 级 request 短路。已接受步骤被取消后不提交排队中的淘汰。若 lifecycle 卸载与已接受步骤重叠且没有取消，已捕获的 checkpoint 在两种 observer 顺序下仍会完成，只访问公开 Session。模拟追加失败会阻止模型请求、记录 hook 取消，下一轮可安全重试。真实默认 light-context 投影及 JSONL 恢复验证旧截断快照清理，同时保留普通 recall 与其他生产者。

单元测试覆盖精确 UTF-8 字节边界、超大当前内容、元数据恢复、不透明 grant 收窄、Source/mode/Route/Action/指引变化、未知 provenance，以及用户、普通召回、指引和其他生产者消息的原样保留。Source 正文不被解释为 Host 指令。最新快照表示当前“投影”状态；缺失可能来自过滤或预算，不代表存储删除。

## 公开 Host 契约与持久化

普通更新追加 user 角色快照。checkpoint 使用已发布的 Session `append()`、单节点 `surfaceOp: replace` 和 `sourceEventSeqs`。空内容 `developer/message` 是公开 Session 支持的、不派生模型消息的表示；没有 Source 文本、指令或工具变更。持久 `step/start` 事件排队一个 microtask，在同步 Session 发布结束后、Host 恢复异步请求准备前提交淘汰。因此后续 `agent/request` middleware 不调用 `next()` 也无法绕过清理。取消或尚未接受的步骤在释放时丢弃计划；已接受步骤的 checkpoint 会在 lifecycle 卸载后完成，不访问已释放的 View 或 Source。追加失败会保留 inbox，以可见 hook 错误取消请求。完整原文与来源关系保留在追加式审计中，穿插的会话消息不被重写。

Host 快照元数据只包含版本 1、授权边界摘要和可见条目摘要，不含原始 ReadGrant、路径或记忆正文。边界保守涵盖 generation、范围、Source/mode、routes/actions、不透明 grants、指引和非 Runtime 投影。Runtime 通过 fragment provenance 自己提供分支/存储范围和条目摘要。年龄不参与条目身份；删除或修正旧条目会立即 checkpoint。已截断或未知 Source provenance 按全文比较，不启用追加历史优化。

未标记旧快照只迁移一次。旧 `recall` 必须属于同一生产者，并具有完整内置 Runtime 信封，或可严格识别的官方截断：已发布的固定首部、文件结构，以及已知 Wake 边界处的 SDK `…` 标记。包含已发布 V3 的 `plugin` 归属及其 `plugin:dsh-mnemon` V4 迁移。过短或未知截断、普通召回、带引用前缀的文本及其他生产者保持不变；不会借用后续 fragment 的关闭标签或省略号，把部分引用误认为快照。Runtime JSON/Markdown 存储与已有投影预算不变。旧 Source 仍可读取，采用保守 checkpoint；回滚插件后审计仍有效，但可能重新积累快照。清理要求插件仍在运行，完全卸载后已无其 hooks。已固定/委派 View 的权限生命周期保持原样。

## 验证

产品代码验证于 `c3508f58dda18e8656e620ebbd015e49e52d2435`；后续提交只记录验证结果。独立复审重跑了短路、卸载和跨 fragment 回归，确认没有剩余阻塞项。

`pnpm run verify` 全部通过：文档、根/工作区类型检查、确定性构建（58 个文件）、工作区构建/测试、根测试、Headless 激活和包验证。根测试 **2,625 通过 / 8 项条件跳过**，174 个文件通过；插件工作区测试 **792 通过 / 3 项条件跳过**。跳过项为需显式启用的付费 Flash 测试（5）、Native CLI 集成（根/插件合计 3）、Windows smoke（1）、OpenViking endpoint 集成（1），以及一个按 Host 能力限定的 legacy 场景（1）。没有使用真实凭据启用这些测试。lifecycle/guidance/state/Session/Host 定向套件 **183/183**，其中 **34 项真实 Host 场景**；Runtime Source provenance 套件 **6/6**。

三份快照套件（Session 12、state 13、真实 Host 34）在所有指定 Host 上通过：

| Host | 结果 |
| --- | --- |
| 0.2.0-rc.2 | 59/59 |
| 0.2.1-rc.3 | 59/59 |
| 0.2.1-rc.5（仓库固定版，包含在完整验证中） | 59/59 |
| 0.2.2-rc.1 | 59/59 |
| 已有构建 master `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | 59/59 |

Headless 验证激活 38 个工具，含 8 个代表性 Mnemon 工具，并检查旧设置迁移与重启。包验证覆盖 68 个打包文件、15 个 Node 入口、37 个公共类型依赖、22 个浏览器声明和 1 个可执行入口；`publint --strict` 与 `attw` 均通过。没有修改 DSH 源码、将 tsconfig 指向 checkout、使用凭据或真实用户记忆。

已安装 Host 命令（每个已发布版本使用独立安装）：

```sh
DSH_HOST_ROOT=<installed-dsh-package> pnpm exec vitest run --config scripts/installed-dsh.config.ts tests/memory-snapshot.spec.ts tests/memory-snapshot-state.spec.ts tests/turn-view-host.spec.ts
pnpm run verify
pnpm run verify:docs
git diff --check
```

不声称测得 Provider 命中率。[DeepSeek 缓存文档](https://api-docs.deepseek.com/guides/kv_cache/)要求匹配已持久化前缀，并明确缓存为 best-effort。测试证明的是请求前缀稳定性，不是远端缓存持久化、节省 token 数或模型推理质量。测试重新加载真实 JSONL，但不声称完成 Windows Electron 进程重启，也没有复刻报告者私有的 1,206 回合会话。审计记录与空 surface 节点仍按追加方式增长。
