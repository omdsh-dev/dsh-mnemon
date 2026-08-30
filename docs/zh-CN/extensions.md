# 记忆插件开发

**简体中文** | [English](../en/extensions.md) | [文档中心](./README.md)

先确定归属，再写代码。[plugin-consumer](../../scripts/fixtures/plugin-consumer/) 中的完整示例，会在仓库外只依赖打包制品编译和测试。

## 一个插件，一种主要职责

| 插件 | 拥有 | 公开依赖 |
|---|---|---|
| `dsh-mnemon-source-*` | 一种记忆权威、投影、检索/修改及可选页面 | Core contracts 与 extension SDK |
| `dsh-mnemon-strategy-*` | Host 请求时，哪些 Source 实例以何种上下文形态、预算、route/action 参与 | Core contracts 与 extension SDK |
| `dsh-mnemon-provider-*` | Memory Spaces 内部驱动、描述符、能力、连接 schema、图标 | Memory Spaces Provider SDK |

Source 不需要再实现 Provider；Provider 不需要理解 View 组合；Strategy 只接收 facts，不接收 Source 对象。跨包只引用声明过的公开出口，不进入其他插件的 `src`、控制器、注册表或构建配置。

| 入口 | 职责 |
|---|---|
| `dsh-mnemon` | DSH Host 与默认 Starter |
| `dsh-mnemon/core` | 安装 Source 无关服务的 Cordis 插件；不导出引擎，不带 Host/UI |
| `dsh-mnemon/contracts` | Source/Strategy 回调契约，以及 JSON 安全的 manifest、facts、ViewSpec、View、Evidence、Receipt |
| `dsh-mnemon/extension-sdk` | Source/Strategy 定义、生命周期注册与校验 |
| `dsh-mnemon/testing` | 限定范围的组合、route/action、管理测试，JSON 诊断与已构建 Client 制品加载器 |
| `dsh-mnemon/client` | DSH 工作台与 Source 页面 SDK |
| `dsh-mnemon-source-memory-spaces/provider-sdk` | Memory Spaces 自己的 Provider 子模块协议 |
| `dsh-mnemon-source-memory-spaces/testing` | 私有子模块夹具，以及驱动权限/连接夹具 |

## 公开贡献服务，不公开引擎

沿用 DSH 服务/Slot 的思路，扩展点是小而明确的贡献契约。`Context.mnemonMemory` 的类型为 `MnemonMemoryService`，实际对象也只暴露 `installContributions`，并被冻结。作者调用 `installMemory(ctx, contribution, options?)`：由它解析当前 Entry 身份，并将注册清理绑定到该 Fiber；不另建平行注册 API。

引擎、已安装记录、注册表、运行代和租约留在内部，`extension-sdk`、`contracts` 与 Core 插件均不导出这些对象。`MemorySourceRuntime` 则有意公开：它描述**你的 Source 要实现的回调**，不是引擎句柄。定义/factory 属于 Host 侧可执行契约；元信息、操作输入和结果保持 JSON 安全。这个服务边界不等于任意 JavaScript 的安全沙箱。

## Source 生命周期

用 `defineMemorySource` 定义 `MemorySourceDefinition`。manifest 声明 API 版本、type id、包名、角色、一致性和 route/action；factory 接收稳定的实例来源及不可变配置。

- `facts(request)`：有界、非敏感的可用性、修订和能力。
- `project(request)`：与选中修订一致的有界文本及 Source 自己的 ReadGrant。并发快照按请求/scope 捕获，不共享一个可变的“最近快照”。
- `query`：只收到 `{ id, scope }` 形式的 `view` 和属于本实例的 `grant`，执行 Source 自身范围限制，返回带来源的有界 Evidence。
- `mutate`：只执行已授权的 action，响应取消，区分已提交、部分成功、失败。它同样只收到 View 身份及可选的本实例 `grant`；读取凭据不等于写授权。
- 可选 `manage`：独立于模型 grant 的认证人工管理，再次检查确认和精确修订。
- 可选 `dispose`：运行代租约排空后释放其私有资源。

完整 `ComposableMemoryView` 留在 Host 与组合测试中，不传给 Source 回调。Source 不得从 `request.view` 遍历其他实例的投影或凭据；需要自身读取范围的写操作直接使用 `request.grant`。

`facts(request, signal)` 和 `project(request, signal)` 的第二个参数是取消信号；网络读取必须传递它，回调不得写入数据。Core 并行读取不同 Source，每次读取默认最多 10 秒；DSH Host 采用现有 `timeoutMs` 配置，独立测试可设置 `MemoryCompositionRunner({ sourceTimeoutMs })`。信号不进入 Strategy 的 JSON 输入。超时或远程异常生成脱敏的 `view.diagnostics`；协议不合法仍直接拒绝。取消整轮不会被当作可选 Source 降级。超时不能中断阻塞事件循环的同步代码，这不是恶意插件沙箱。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { notesSource } from './source.js'

export const name = 'dsh-mnemon-source-notes'
export const inject = ['mnemonMemory']
export function apply(ctx: Context): void {
  installMemory(ctx, { sources: [notesSource] })
}
```

以上假定 `source.js` 导出定义；完整文件记忆示例见 [external-source.ts](../../scripts/fixtures/plugin-consumer/src/external-source.ts)。一个插件注册 Source **或** Strategy，不兼任二者。

Entry id 标识实例，type id 标识实现。不能剥掉 Loader 的 include 前缀。没有 Loader 身份的直接 `ctx.plugin()` 挂载，应传 `installMemory(..., { instanceId })`。路径和凭据归实例，不使用模块全局数据库或服务注册表。

## Strategy

用 `defineMemoryStrategy` 定义，再以 `{ strategies: [definition] }` 安装。声明确定性、支持角色与上限；返回 `MemoryViewSpec`，选择准确的 Source key、eager/routed 投影预算和 Source 本地 route/action id。网络、存储、凭据访问不属于 Strategy。

选中的 Source 默认必需；`required: false` 明确允许该实例在不可用或投影失败时被省略。必需实例失败会拒绝本轮 View，不悄悄切换策略。默认三层对可用 Source 作组合，并将它们标为可选，因此外部读取失败不会带走其他层。缺少必需实例时，Strategy 应明确拒绝，而不是返回一个空选择。

[external-strategy.ts](../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) 是完整的显式选择示例。默认 Host 沿用 `mnemon.memoryTopology.strategyId` 配置选择其 type id；多个适用 Strategy 是错误，不采用“后导入覆盖前者”。Profile 显式替换默认 Entry；只安装一个包不等于允许它替换当前组合。

## Provider 子模块与 Client 页面

Provider 使用 Memory Spaces SDK 的 `defineMemorySpaceProvider`。模块只收到限定子节点的 `host.install(ctx, definition)` 能力；私有父 Host、Snapshot 和 Registry 不从 SDK 导出。`installMemorySpaces` 挂载显式子模块，返回 `Promise<void>`，不返回父对象句柄。[external-provider.ts](../../scripts/fixtures/plugin-consumer/src/external-provider.ts) 会在两个独立父 Source 内以同名子节点测试。

通过 Source 的 `/testing` 入口使用 `mountMemorySpaceProvider`，测试真实子节点注册、带实例别名的驱动创建和清理；返回值只有冻结的 descriptor/manifest 元信息、`registered`、`createAdapter` 与 `dispose`。`createMemorySpaceProviderFixture` 单独提供经过验证的连接及限定范围的驱动权限。[发布 API 测试](../../scripts/fixtures/plugin-consumer/tests/public-api.spec.ts) 展示如何组合二者，不导入私有实现。

```yaml
- id: work-spaces
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/work-memory
    providers:
      - use: dsh-mnemon-provider-holographic
        instanceId: local-facts
```

**Source 自己定义 Provider Fiber**；Core 不提供 Provider factory registry 或第二个 Context 服务。能力声明必须真实：查询型后端不能伪造全量浏览或图关系。

可选的 `./client` 通过 `dsh-mnemon/client` 的 `installMemorySourceUI` 注册，由 DSH 作为普通 Client 插件加载。页面接收 `MemorySourcePageProps`：选中实例、locale、可写状态和限定范围的 `management.read/mutate`。用 `MemorySourcePageFrame` 复用 locale/appearance；React 不接收 Host Context、驱动、令牌、LLM grant 或传输层。缺少专属页面时有通用管理入口，重复归属和渲染失败局部诊断。

## 独立仓库验收

每个插件拥有自己的 `package.json`、exports、`src/`、`tests/`、TypeScript/构建/测试配置及 README。声明公开 peer 与开发依赖，发布 Host/Client 制品和类型，不依赖兄弟路径、工作区源码别名、根测试夹具或隐式依赖提升。

只有默认 Starter 挂载默认组合；Source/Strategy 包不携带自动激活默认实例的 patch。用户 Profile、Bundle 或明确的父组合负责激活和替换。

```ts
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as notes from './index.js'
import * as focus from './strategy.js'

const runner = new MemoryCompositionRunner()
try {
  await runner.mount(notes, { instanceId: 'work', config: { path: '/tmp/test-notes.txt' } })
  await runner.mount(focus, {
    instanceId: 'focus',
    config: { sourceKeys: ['source:work'], mode: 'eager' },
  })
  const turn = await runner.beginTurn()
  try {
    const route = turn.view.routes.find(route => route.sourceRouteId === 'read')!
    const evidence = await turn.executeRoute(route.id, {})
    // 断言投影、证据与来源；写操作使用
    // turn.executeAction(offer.id, input, authorize)，明确给出测试授权。
  } finally { turn.release() }
} finally { await runner.dispose() }
```

正式测试使用唯一临时路径，先释放 turn，再 dispose runner。`runner.inspect()` 只返回 JSON 评估/运行代诊断；`managementClient(sourceKey)` 提供限定实例的人工操作。turn 不暴露租约，runner 不暴露引擎；通过卸载/重挂插件测试替换，不修改内部注册表。dispose 也会释放遗留 turn；在途操作持有自己的租约，完成后才排空。这是在真实 Cordis/Core 上的测试夹具，不是另一套生产 Loader。

至少覆盖：正常组合、缺失/歧义依赖、双实例、schema/能力/授权拒绝、并发快照、旧修订、取消/部分失败、卸载排空/重载、持久化、管理与真实页面点击。Provider 另测凭据、真实能力、上游损坏数据、超时与父 Source 内 conformance。

插件运行自己的 `pnpm verify`。仓库级 `pnpm verify:plugins` 打包全部 14 个制品，用正常 semver manifest 在工作区外逐个安装、检查、测试和构建，再编译外部消费者；禁止源码 alias、manifest override 和工作区软链接。

RSI 应保存可复现候选输入/制品，对照已知组合评估，经明确安装/选择决策晋升。Strategy 回放通过，不代表任意 JavaScript 已被沙箱隔离，也不授予交易、发消息或删除外部数据的权限。
