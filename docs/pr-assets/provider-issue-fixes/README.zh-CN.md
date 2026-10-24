# Provider 问题修复，2026-10-24

[English](./README.md) · [验收索引](../README.md)

实测代码：`868148eba31c78b2897cafb0333d490bee83eb1c`，基于 main `a7e3bc549c777ada56ca703099eb61a7340b1da3`。环境为 macOS arm64、Node 24.22.1、pnpm 10.13.1。测试仅使用合成记忆、临时本地存储和受控 HTTP 响应，不使用个人凭据或私有记忆。

## 范围与结果

| 问题 | 复现的行为 | 修复与回归覆盖 |
|---|---|---|
| [#455](https://github.com/omdsh-dev/dsh-mnemon/issues/455)，OpenViking 写入 | 已移除的 `timeout` 字段被拒绝；元数据字节数使已完成写入被误判 | 只发送通用四字段，保留客户端超时；仅在完整正文读回一致且索引完成时接受含元数据的字节数。[写入测试](../../../plugins/dsh-mnemon-provider-openviking/tests/write-regression.spec.ts) 覆盖新旧 schema、短写入、读回不一致及超时。 |
| [#452](https://github.com/omdsh-dev/dsh-mnemon/issues/452) 中的既有 keyword 通道 | keyword 实际执行语义检索 | 将完整查询转义为忽略大小写的字面量，调用 `search/grep`，按文件去重、限制命名空间并读完整正文。[keyword 测试](../../../plugins/dsh-mnemon-provider-openviking/tests/keyword-search.spec.ts) 覆盖版本、Windows 路径、标点、中文、隔离、256 行上限、端点不可用与取消。 |
| [#454](https://github.com/omdsh-dev/dsh-mnemon/issues/454)，分数量纲不一致 | Hindsight 加权后的正确答案被分为 unknown，排在 OpenViking 的分档之后；无分数 keyword 命中受到 unknown 配额限制 | OpenViking、Hindsight、RetainDB 声明原生顺序。[Source 测试](../../../plugins/dsh-mnemon-source-memory-spaces/tests/service.spec.ts) 保留 Hindsight 的 1.038/1.02 与 OpenViking 命中、非单调分数顺序及五条 keyword 命中。[策略测试](../../../plugins/dsh-mnemon-source-memory-spaces/tests/recall-quality.spec.ts) 保留归一化 Provider 的过滤和配额，拒绝非有限分数。[Strategy 测试](../../../plugins/dsh-mnemon-strategy-default-three-tier/tests/retrieval.spec.ts) 继续执行每轮六条的总预算。 |
| [#447](https://github.com/omdsh-dev/dsh-mnemon/issues/447)，Holographic 量纲 | Source 的 importance 3 被当成 trust 1，defaultTrust 不生效 | importance 3 使用 defaultTrust，每一级调整 0.1。[Driver 测试](../../../plugins/dsh-mnemon-provider-holographic/tests/driver.spec.ts) 覆盖量纲、关联读取的 minTrust、隐藏回执及旧可信度保留；Source 用例覆盖省略 importance 的路径。 |
| RetainDB 写入与响应兼容 | 1..5 importance 和不受支持的分类被拒绝；嵌套结果丢失；排队或缺少确认被误报为已存储 | importance 映射为 0.5..0.9，发送受支持的类型，旧端点请求同步写入，解析嵌套命中并区分回执。[Driver 测试](../../../plugins/dsh-mnemon-provider-retaindb/tests/driver.spec.ts) 覆盖 Local、当前和旧 Server 响应、拒绝写入及认证失败不回退。 |

[组合 Host 测试](../../../tests/openviking-host.spec.mjs) 使用[回环 OpenViking 协议夹具](../../../scripts/fixtures/openviking-protocol.mjs) 验证写入、搜索、读回以及账号和 Source 隔离。keyword 返回已存完整正文，无法检索另一账号的记忆。

## 验证

保留新增或更新的 Provider、Source 测试，将生产源码恢复为 main 后，回归运行得到 **42 失败、178 通过、1 个真实服务用例跳过**。恢复修复后定向检查通过。最终完整验证通过 **681 项插件测试、2,168 项根测试**，**10 项按需启用的测试跳过**。

```sh
# 使用 Node 24.22.1 和 pnpm 10.13.1。
pnpm run verify
pnpm run verify:plugins --skip-build
pnpm run release:intent
pnpm run verify:docs
git diff --check
```

- `verify`：文档、全部类型检查、确定性双构建、全部 workspace 构建和测试、根 Client/Host 测试、真实 DSH Headless 启动、包内容、公开入口及 lint 均通过。
- `verify:plugins --skip-build`：18 个独立插件仓库与 19 个打包制品通过，包含外部 SDK 消费者、真实 DSH 中的 Starter 升级及可选 Strategy 组合。
- 发布意图覆盖与最终文档、diff 检查：通过。
- 环境诊断：首次使用 pnpm 11 时，既有 workspace 循环依赖被拒绝；随后 Node 25 在无关的 Runtime 符号链接清理测试上失败。切换 CI 工具链后两者均消失，没有修改 Runtime 或构建代码。上游缺失 sourcemap 的非致命告警仍保留。

## 兼容性与限制

界面组件、交互和配置键保持不变，既有总条数、正文和每轮预算继续生效。原生分数保留供检查，不虚构为置信度；本次没有引入跨 Provider 重排器或新排名设置。升级时同步更新 Memory Spaces Source 与相关 Provider。

Holographic 的 version-1 存储为新事实增加可选 importance 字段，旧事实与可信度不迁移。旧版本也能加载该存储；回滚会恢复原来的可信度映射及读取行为。Provider 升级不会删除远端记忆；未知写入结果需要先检查再重试。

本记录不认证真实云账号或 LLM 召回质量；现有按需启用的远端、CLI、模型测试仍跳过。grep 最多返回 256 个匹配行，并报告达到上限；keyword 将完整查询当作字面量，不引入正则语法、多词解析或自动语义回退。官方插件迁移、Hermes 模式、UI adapter 插件、逐空间写入策略与多模态接入留待后续。
