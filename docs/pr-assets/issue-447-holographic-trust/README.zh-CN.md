# Holographic 按重要度设定可信度：issue #447

[English](./README.md) | [Issue #447](https://github.com/omdsh-dev/dsh-mnemon/issues/447) | [验证记录](./verification.json)

Issue #447 报告：Holographic 把 `mnemon_remember` 的 1–5 `importance` 直接截断成 0–1 的可信度，导致每条事实的可信度都是 1.0，`defaultTrust` 从不生效，`minTrust` 也过滤不掉任何内容。

基线为 main `a7e3bc54`。验证于 2026-10-23（Asia/Shanghai）进行，环境为 macOS arm64、Node 24.19.0、pnpm 10.13.1。记忆均为合成数据。

## 原因

- Memory Spaces Source 交给每个 Provider 的重要度都是 1 到 5 的整数；写入方没有给出时为 3。
- Holographic 存储的是 `clampTrust(importance ?? defaultTrust)`。1 到 5 的任何值都会截断成 1.0；又因为重要度总会传进来，`defaultTrust` 从没用上。
- `minTrust` 会隐藏可信度低于它的事实，但所有事实都是 1.0，所以什么也隐藏不了。
- 读回时，事实把自己的可信度当作重要度报告，于是每条 Holographic 记忆都显示重要度 1。

## 修复

- **新事实的可信度。** 重要度 3 从空间的 `defaultTrust` 起步，每高或低一档加减 0.1，并限定在 0 到 1 之间。结果只舍入到百万分之一，所以 0.333 这类配置的默认值会原样保留。按默认值（0.5，最低 0.3），重要度 1 到 5 分别从 0.3 到 0.7 起步，因此在调高最低值之前，每条事实仍会被召回。到达 Provider 时没有重要度的事实，从 `defaultTrust` 起步。
- **最低可信度对每种读取都生效。** 检索、浏览、图谱、实体页和关联读取现在都会略过可信度低于 `minTrust` 的事实；关联读取以前不受它约束。比较时会容忍浮点误差。
- **被隐藏的写入会说明。** 可信度低于最低值的事实仍会存入。回执保持 `action: stored`，另外加上 `hiddenByMinTrust`、它的可信度、最低值和一条提示。被隐藏事实的重复写入仍像以前一样跳过，摘要会说明已有事实是隐藏的。因此，`minTrust` 高于 `defaultTrust` + 0.2 时所有新事实都会被隐藏，而更早写入、可信度为 1.0 的事实仍然可见。状态页的计数包括所有已存事实，不论是否隐藏。
- **分数保持为相关度。** 检索和关联的分数不再乘以可信度，可信度改为决定同分时的先后。如果按新的、更低的可信度去缩放分数，新事实会跌破召回分档 0.25 的下限。现在每条事实的分数就等于相关度（因为可信度都是 1.0），所以现有的每个分数和分档都保持不变。
- **重要度会被保存。** 事实保存写入时的重要度，读回时也带着它，使用每个 Provider 都采用的 1–5 量纲。
- **已有事实保持原样。** 它们的可信度仍为 1.0，也没有记录重要度，因为原始重要度已经在截断时丢失。改写它们等于去猜测用户数据，而保持可见正是用户现在看到的行为。它们读回时不带重要度，而不是带一个错误的值。
- **统一的重要度量纲。** 扩展指南现在为所有 Provider 写明：Source 发送的重要度是 1–5，后端使用其他量纲时，应把重要度映射到自己的量纲上，而不是直接透传或截断这个数。

## 经由 Memory Spaces Source 验证

[`trust.probe.mjs`](./trust.probe.mjs) 挂载真实的 Memory Spaces Source 与 Holographic Provider，通过 `remember` 写入三条记忆并读取本地存储，然后先在空间最低可信度为 0.3 时检索，再改为 0.5 检索一次。

| 记忆 | 发送的重要度 | main：可信度 / 读回重要度 | 修复：可信度 / 读回重要度 |
|---|---|---|---|
| Release notes are drafted on Monday | 1 | 1 / 1 | 0.3 / 1 |
| Release approvals need a completed canary | 5 | 1 / 1 | 0.7 / 5 |
| Release branches are cut from main | 无（Source 发送 3） | 1 / 1 | 0.5 / 3 |

| 检索 "release" | main | 修复 |
|---|---|---|
| `minTrust` 0.3 | 三条全部返回，分数 0.9 | 三条全部返回，分数 0.9 |
| `minTrust` 0.5 | 三条全部返回，分数 0.9 | 只返回重要度 5 和 3，分数 0.9 |

## 其他 Provider

- **保持不变，且符合 1–5 量纲：** Mnemon Native 把重要度传给 CLI；OpenViking 把它写成标签；Mem0 与 Supermemory 原样传递。
- **不发送重要度：** Hindsight、Honcho 与 ByteRover。
- **RetainDB** 发送 `importance: request.importance ?? 0.7`。由于 Source 总会发送 1–5，0.7 这个默认值永远不会生效；而这个默认值本身暗示 RetainDB 的接口使用 0–1。我们没有用 RetainDB 服务端核实，所以只在这里报告，本次不做修改。

## 回退与已知影响

- **回退。** 退回更早的驱动时，所有事实都会保留，但新事实的分数会乘以它们较低的可信度：
  - 0.9 的短语匹配，对重要度 5 到 1 分别变成 0.63 到 0.27；
  - 重要度 1、0.8 的实体匹配变成 0.24，跌破召回分档 0.25 的下限而被丢弃；
  - 读回的重要度会是可信度本身，即 0.3 到 0.7。
- **混合存储中实体页的顺序。** Source 按 `importance ?? 0` 排列一个实体的记忆，所以在既有更早事实（没有重要度）又有新事实的存储中，更早的事实会排在最后。这只是显示上的影响，本次不修改 Source。

## 自动化检查

```text
pnpm --filter dsh-mnemon-provider-holographic exec vitest run    # 20 项通过；在 main 上 11 项新测试失败
pnpm --filter dsh-mnemon-provider-holographic run typecheck
pnpm --filter dsh-mnemon-provider-holographic run build
pnpm exec vitest run <涉及 Holographic 的 9 个根目录测试文件>      # 441 项通过，1 项跳过
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run    # 296 项通过，2 项跳过
node docs/pr-assets/issue-447-holographic-trust/trust.probe.mjs <out.json>
node scripts/verify-docs.mjs
```

新增的单元测试覆盖：

- 重要度到可信度的映射，以及在 0 和 1 处的截断，覆盖 `defaultTrust` 为 0、0.1 和 1 的情形；
- 直接发给驱动的重要度 0、小数和 NaN；
- 默认可信度，以及最低值等于默认值 0.333 或 0.001 的情形；
- 把 `minTrust` 设在两个重要度之间的情形；
- 被最低值隐藏的已存事实和重复写入的回执；
- 关联分数及其门槛；
- 同分时的顺序：先 30 条重要度 1 的事实、再 5 条重要度 5 的事实，限制为 30 条；
- 不会被可信度压低的相关度分数；
- 修复前写入、保持原样的事实。
