# 当前回合 View 恢复 — issue #542

[English](./README.md)

2026-11-02 对比基线 `a4ad2d6955172b936ff9328f39cc5873c3ec9c55`（v0.5.38）与本 PR 改动。会话、工作区和记忆均为一次性的合成夹具。使用未修改的正式 DSH 包，模型选择由本地脚本给出，没有付费模型调用，也未访问 Desktop profile。

## 复现与边界

修复前，原版 DSH 0.2.1-rc.5 及其随附的 `standard`、`ptc` preset 可以正常工作。未复现报告者的完整 Windows 11 安装与第三方插件配置。这里证明的是一个会产生所报症状的 Mnemon 生命周期缺陷，不能据此断定报告者由哪个插件或注册顺序触发。

DSH 先写入持久的 `turn/start`，再组装提示词，然后等待 `agent/pre-step`，最后执行模型与工具。此前 Mnemon 只在自己的 `system-prompt/assemble` 监听器里获取 View。公开接口允许拦截器直接返回组装结果，不继续调用后续监听器：

```ts
ctx.on('system-prompt/assemble', async assembly => assembly, { prepend: true })
```

加入该拦截器后，真实 rc.5 Agent 回合仍收到 Mnemon 引导语，却没有 View 快照。原生工具与真实 `run_code` 均返回 `Memory operation requires the View pinned to the current turn`。在首次组装期间才注册 Mnemon 生命周期，也会错过已捕获的回调列表，导致第一次工具调用失败。

修复保留组装阶段的提前准备，并在步骤获准执行时确保其自身仍打开的回合已有 View。`AgentMemoryTurn.begin` 复用既有绑定或准备过程；本回合不可用的组合仍保持不可用。根 Agent 继续使用既有 Wake 路径。普通子 Agent 恢复缺失的绑定时，仅在该首次获准步骤收到既有 Wake，正常组装路径不变。协调器管理的记忆任务仍走既有委托路径。

## 真实宿主证据

可复用回归见 [`tests/turn-view-host.spec.ts`](../../../tests/turn-view-host.spec.ts)。只有模型选择是脚本给出的：Agent 回合、事件顺序、JSONL 会话、范围、工具权限检查、Source 插件、View 租约和 PTC worker 均使用正式宿主与真实 Mnemon 实现。

| 观察项 | 基线 | 修复后 |
|---|---|---|
| 公开拦截器下的原生读取 | 两次读取均报绑定错误 | 状态与档案搜索成功 |
| 公开拦截器下的 PTC 读取 | 两次真实 `run_code` 均报绑定错误 | 两次均成功 |
| 首次组装期间注册生命周期 | 第一次工具失败，后续步骤恢复 | 第一次工具即成功 |
| 带拦截器的普通子 Agent | 两个工具均失败 | 均成功，模型收到精确 Route/Action id |
| 根 Agent 首次、下一次及冷恢复回合 | 缺失绑定 | 分别绑定自己的持久回合 id：1、2、3 |
| 回合内修改 Source | 既有栅栏 | 本回合快照不变，下一回合看到新修订 |
| 拒绝/取消步骤、拒绝工具、回合外工具 | 既有栅栏 | 拒绝/取消步骤不留绑定，策略拒绝与回合外拒绝保留 |

另在全新的官方 rc.5 Web profile 中，通过 `dsh plugin --profile web add link:<checkout>` 加载构建后的插件，并挂载随附 `standard` 与 `ptc` preset。每个 preset 依次执行状态读取、档案搜索和文本回复。以下脱敏结果省略完整提示词、路径与 Web profile 临时访问令牌：

```json
{
  "before": {
    "standard": { "guide": true, "memorySnapshot": false, "toolErrors": [true, true] },
    "ptc": { "guide": true, "memorySnapshot": false, "toolErrors": [true, true] }
  },
  "after": {
    "standard": { "guide": true, "memorySnapshot": true, "toolErrors": [false, false] },
    "ptc": { "guide": true, "memorySnapshot": true, "toolErrors": [false, false] }
  }
}
```

回归还在 scoped Strategy 下挂载第二个 Documents Source 和 Runtime Source。每次根 Agent 模型请求，以及恢复绑定的子 Agent 首次请求，除了命名工具列表，还包含实际 `MNEMON VIEW ROUTES` 数据块、`source:extra-documents/search` 与 `source:extra-runtime/mutate`，确认模型获得了可以使用的入口，而不只是工具执行被授权。

## 验证

```bash
pnpm run verify
DSH_HOST_ROOT=/path/to/published/node_modules/@deepseek-ai/dsh \
  pnpm exec vitest run --config scripts/installed-dsh.config.ts \
  tests/turn-view-host.spec.ts tests/lifecycle-host-order.spec.ts \
  tests/source-tool-lifecycle-host.spec.ts tests/async-subagent-host.spec.ts \
  tests/resumed-memory-task-host.spec.ts
```

| 正式宿主 | 检查 | 结果 |
|---|---|---|
| 0.2.1-rc.2，仓库基线不变 | 完整 `pnpm run verify` | 通过；根测试 165 文件 / 2,394 项通过，2 文件 / 7 项跳过 |
| 0.2.1-rc.5 | 五个定向宿主测试套件 | 21 项通过 |
| 0.2.1-rc.3 | 五个定向宿主测试套件 | 21 项通过 |
| 0.2.0-rc.2 | 五个定向宿主测试套件 | 20 项通过，1 项跳过：既有冷恢复任务测试需要 0.2.1 |

七个新增回归在全部实测宿主上通过，包括 0.2.0-rc.2 的 PTC。生产代码修复前已确认复现失败；子 Agent 引导语断言也在加入窄范围 Wake 恢复前失败。正式 DSH 包缺失 sourcemap 及 Node 实验 API 警告不影响通过。本 PR 不修改依赖版本、CI 矩阵、配置或持久化格式，也不据此对未测 DSH 版本作一般兼容性保证。
