# Source tool lifecycle / Source 工具生命周期

Synthetic local acceptance for issue #522. All records use disposable temporary storage and deterministic local model adapters; no personal DSH profile, private data, remote inference, or paid API is used.

Issue #522 的本地合成验收。全部记录使用可丢弃的临时存储与确定性本地模型适配器，不使用个人 DSH profile、私有数据、远程推理或付费 API。

## Reproduce / 复现

```sh
pnpm exec vitest run tests/source-tool-lifecycle.spec.ts tests/source-tool-lifecycle-host.spec.ts
pnpm exec vitest run tests/lifecycle.spec.ts
```

The Host fixture composes published Cordis, Agent, AgentLoop, ToolRuntime, Session, SystemPrompt and SubagentRuntime packages, plus real public spawn/fork providers and actual Mnemon Sources. Only model replies are scripted. The schema golden test in `tests/memory-tools.spec.ts` separately preserves the existing model-facing definitions byte for byte.

Host fixture 组合已发布的 Cordis、Agent、AgentLoop、ToolRuntime、Session、SystemPrompt、SubagentRuntime、真实的公共 spawn/fork provider 与实际 Mnemon Source；只固定模型响应。`tests/memory-tools.spec.ts` 的 schema golden 测试另行逐字节检查既有模型工具定义。

## Observed / 实测

| State / 状态 | Mnemon tools / 工具数 |
|---|---:|
| All built-in Source types registered / 全部内置 Source 类型已注册 | 17 |
| Memory Spaces absent / 无 Memory Spaces | 7 |
| Documents absent / 无 Documents | 14 |
| Runtime absent / 无 Runtime | 16 |
| All built-ins absent / 无内置 Source | 3 |

- Last-instance removal and three disable/enable cycles remove and restore the family. Another same-type instance, including a third-party definition, keeps it alive. / 最后一个实例移除以及三轮关闭/恢复会移除和恢复工具族；其他同类型实例（包含第三方定义）仍可维持工具族。
- Nested transactions, compensated rollback and Host bootstrap during a transaction retain committed schemas; disposal removes the subscriber and leaves the independent result tool intact. / 嵌套事务、补偿回滚和事务中 Host 启动均保留已提交 schema；销毁清理订阅，独立结果工具不受影响。
- One already loaded Agent receives 7 -> 17 -> 7 tools over ordinary model requests. With Memory Spaces absent it successfully writes a Runtime entry and creates a Document. / 同一个已加载 Agent 的正常模型请求依次收到 7 -> 17 -> 7 个工具；缺少 Memory Spaces 时仍成功写入 Runtime 条目和创建 Document。
- Both spawn and fork reviews start with Documents or Runtime absent; no unknown tool reaches DSH `restrict()`. / Documents 或 Runtime 缺失时，spawn 和 fork 审查都能启动，不向 DSH `restrict()` 传入未知工具名。
- Absent targets, global read-only mode and a Scoped read-only View skip review without any child model request; an automatic scheduler rechecks target availability before consuming an attempt. / 无目标、全局只读和 Scoped 只读 View 均跳过审查且不产生子 Agent 模型请求；自动调度在消耗次数前再次检查目标可用性。
- A workspace View selecting only Runtime keeps all 17 global tools. / 仅选择 Runtime 的工作区 View 仍保留全部 17 个全局工具。
- A held Runtime call stays uncancelled when Memory Spaces is removed and commits its synthetic fact after release. / 暂停中的 Runtime 调用在 Memory Spaces 移除后没有被取消，恢复后成功提交合成条目。

Local acceptance on the pinned published DSH 0.2.1-rc.2: 19 tests passed across the two focused files. The lifecycle suite also covers admission. Supported alternative DSH installations are checked by PR CI; these local fixtures make no claim about live Provider accounts.

本地在固定的已发布 DSH 0.2.1-rc.2 上验收：两个专门测试文件共 19 个测试通过，生命周期测试另行覆盖调度准入。其他受支持 DSH 安装由 PR CI 检查；这些本地 fixture 不证明真实 Provider 账号的行为。
