# 记忆插件开发

**简体中文** | [English](../en/extensions.md) | [文档中心](./README.md)

先确定归属，再写代码。[plugin-consumer](../../scripts/fixtures/plugin-consumer/) 中的完整示例，会在仓库外只依赖打包制品编译和测试。

## 区分贡献的职责

| 插件 | 拥有 | 公开依赖 |
|---|---|---|
| `dsh-mnemon-source-*` | 一种记忆权威、投影、检索/修改及可选页面 | Core contracts 与 extension SDK |
| `dsh-mnemon-strategy-*` | 完整 View Strategy，或目标 Strategy 支持的可叠加贡献 | Core contracts、extension SDK；目标 Strategy 的扩展 SDK |
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

以上假定 `source.js` 导出定义；完整文件记忆示例见 [external-source.ts](../../scripts/fixtures/plugin-consumer/src/external-source.ts)。Source 与 Strategy 是职责，不是强制分包/分仓。一个插件可以调用 `installMemory(ctx, { sources: [source], strategies: [strategy] })`，在同一 Fiber 下成批安装、一起卸载，保留不同的实例 key；仅在需要独立复用/替换时拆包。Strategy 仍需显式选择，随包提供不等于覆盖用户的选择。

Entry id 标识实例，type id 标识实现。不能剥掉 Loader 的 include 前缀。没有 Loader 身份的直接 `ctx.plugin()` 挂载，应传 `installMemory(..., { instanceId })`。路径和凭据归实例，不使用模块全局数据库或服务注册表。

## 完整 Strategy 与可叠加贡献

用 `defineMemoryStrategy` 定义，再以 `{ strategies: [definition] }` 安装。声明确定性、支持角色与上限；纯 `compose` 返回 `MemoryViewSpec`，选择准确的 Source key、eager/routed 投影预算和 Source 本地 route/action id。组合阶段不执行网络、存储或凭据访问。

完整 Strategy 用可选 `extensionSlots` 声明自有的独占扩展槽。小插件使用 `defineMemoryStrategyExtension`，以 `{ strategyExtensions: [definition] }` 安装。启用后向目标 Strategy 的一个槽贡献有界 JSON，停用只撤销自身贡献；不同槽同时参与一个 View，同一目标的重复槽会拒绝注册，不按安装顺序覆盖。目标 Strategy 未被选择时，贡献保持可观察但不执行；不支持的槽会拒绝候选运行代，并保留已有 Serving。

Core 只处理目标/槽身份、JSON、64,000 字符上限、确定性回放、生命周期和最终 View 的原有预算/权限，不解释业务槽名。扩展回调只接收 request 和权限过滤后的 Source facts，没有 Source 对象、grant 或写入回调。槽语义由目标 Strategy 的公开 SDK 定义。动态回调或槽值在具体回合中不合法时，该回合拒绝，不偷偷回退到忽略插件的 View。

### 可选的视图配置声明

专用 Strategy Entry 可以导出 `memoryStrategyConfiguration`，由 Core SDK 的 `defineMemoryStrategyConfiguration` 定义。它包含中英文展示文案、公开字段（`number`、`text`、`textarea`、`string-list`、`source-list），以及**与 `apply()` 共用的纯 `create(config)` factory**。factory 只返回一个 Strategy 或扩展贡献，不做 I/O、凭据访问、Source 注册或 Fiber 挂载；完整例子见可选策略包。这只是可选的编辑器约定，不是组合功能的准入要求。混合 Source/Strategy Entry 以及未声明编辑器的插件仍可观察，由 DSH 管理配置。

Host 只发现已存在的 `(scope/)dsh-mnemon-strategy-*` Loader Entry（包括停用项），页面不会安装任意包。预览使用真实 Source 进行组合，不提交配置、不执行 Action、不调用模型。应用前校验完整候选，经 Cordis 更新原 Entry，把 Profile 级用户偏好保存在 DSH 设置中。`mnemon-view-<Loader 装配目录摘要>` 命名空间在共享设置文件内隔离各 Profile（没有装配目录的嵌入式 Host 使用 `mnemon-view`），不改写包内或生成的 Loader YAML。加载或持久化失败会回滚；已有轮次的 pin 保持不变。Source 上限及 Host 的写入/权限约束仍然有效。

### 默认三层扩展

默认三层的 `dsh-mnemon-strategy-default-three-tier/extension-sdk` 提供 `defineThreeTierExtension` 和三个槽：

| 可选插件 | 槽 | 贡献与边界 |
|---|---|---|
| `dsh-mnemon-strategy-scoped` | `selection` | Source key 顺序、可写子集；不创建 Source、不改变其物理存储范围 |
| `dsh-mnemon-strategy-light-context` | `projection` | 一份共享投影上限，只收紧 Host 预算；不是增量注入或摘要压缩 |
| `dsh-mnemon-strategy-auto-capture` | `capture` | 当前对话的记录指引、目标与明确 Action id；不启动后台 Agent、不直接写入 |

三个包都是可选安装，不属于默认 Starter 的运行依赖。把包安装并作为 DSH Entry 启用后，它们会自动参与 `default-three-tier`，不需要修改 `strategyId`。仅下载 npm 包不等于启用。默认 Source 组合、预算和提醒在没有扩展时不变。Runtime 当前没有展开 route；把常驻预算压得很低可能隐藏热记忆，需要针对实际任务评测。

在依赖已安装的 Profile 的最终 `cordis.patch.yml` 追加以下配置即可同时启用。Source key 若包含 Loader 的 include 前缀，应使用实例目录中的完整 key；省略 `scoped.config` 时按角色/key 确定性组合现有实例，不创建新的存储。

```yaml
- insert:
    - id: mnemon-strategy-scoped
      name: dsh-mnemon-strategy-scoped
    - id: mnemon-strategy-light-context
      name: dsh-mnemon-strategy-light-context
      config:
        maxProjectionCharacters: 4096
    - id: mnemon-strategy-auto-capture
      name: dsh-mnemon-strategy-auto-capture
```

`scoped` 的 `sourceKeys` 表示优先顺序，`writableSourceKeys` 限定可写子集。自动容量整理同样受本轮可写范围限制；被禁止时保留原数据并报错，不绕过范围向其他 Source 迁移。只有显式人工管理走独立的管理授权。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export const inject = ['mnemonMemory']
export function apply(ctx: Context): void {
  installMemory(ctx, { strategyExtensions: [defineThreeTierExtension({
    typeId: 'my-light-context', packageName: 'dsh-mnemon-strategy-my-light-context',
    slot: 'projection', contribute: () => ({ maxProjectionCharacters: 4096 }),
  })] })
}
```

扩展不另建后台调度器；对话内写入仍通过已有 Host 工具、授权和 Source 回执。`capture` 不能把 `manage-spaces` 等一般写操作自动当成记录：作者必须指定实际记录用的 Action id。共享检索预算仍按整个执行回合计算，不按 Source 数量倍增；缓存和 Related 准入带 Source 身份，避免同名空间串用证据。停用贡献后重建失败时，不继续使用已撤销策略；已固定的旧回合仍按原租约完成。

可选的 `createTurn(view)` 返回执行级 `query(request, read)` 策略。它只获得绑定当前 Route 和私有 grant 的 `read(input, narrowerLimits?)`，Core 仍校验输入、有效上限、已分派次数和生命周期。策略可以筛选、重放结果，并用 `Evidence.output` 提供简洁模型输出，但不会获得 Source 对象、写入回调或新增权限。即使继承同一个不可变 View，不同执行轮次也拥有独立策略状态。不提供此钩子时，读取仍经过 Core 边界直接进入 Source。

默认三层插件用此钩子实现旧版 Documents 单次查询、Recall 两次查询的共享证据预算、去重与 Related 准入。命名工具和通用 View Route 共用这套策略。Source 保留原始检索、存储和维护能力；显式的 DSH 辅助写入/归档仍由 Host 工作流执行，不成为 Core 的通用后台任务。

选中的 Source 默认必需；`required: false` 明确允许该实例在不可用或投影失败时被省略。必需实例失败会拒绝本轮 View，不悄悄切换策略。默认三层对可用 Source 作组合，并将它们标为可选，因此外部读取失败不会带走其他层。缺少必需实例时，Strategy 应明确拒绝，而不是返回一个空选择。

[external-strategy.ts](../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) 是完整的显式选择示例。默认 Host 沿用 `mnemon.memoryTopology.strategyId` 配置选择其 type id；多个适用 Strategy 是错误，不采用“后导入覆盖前者”。Profile 显式替换默认 Entry；只安装一个包不等于允许它替换当前组合。

可选 `ViewSpec.guidance` 承载 Strategy 的可信 `system`、`routing` 和读写提醒，与 Source 的引用数据分离，经校验后进入 View digest。没有提供时，Host 使用通用路由提示。已有 DSH 命名工具只显示本轮可用性，不重复注入工具目录中的 schema；外部或未绑定的操作仍展示准确 id 和 schema。已有产品工具与人工管理保留；工具存在不代表对应 Source 已进入本轮 View。默认三层的自动后台整理只在选择 `default-three-tier` 时运行，自定义 Strategy 不会隐式触发这项业务流程。

## 开放操作，有限执行

Source 自己定义操作名、输入 schema、存储、索引和维护方式。不要求五类动作、摘要树、统一表示词汇或多维预算协议。Strategy 按 id、角色或权限能力选择自己理解的公开操作。Core 从 Manifest、动态 Facts 和 Host 权限生成 `MemoryAvailableSource.routes/actions`，作者不重复填写描述。

Core 仅约束投影字符数、证据字符数/条数及已分派调用次数；这些是载荷上限，不是完整 LLM prompt 的 token 估算。Source 接收有效上限，自行提供摘录和结构化格式；Core 丢弃超限条目，不伪造摘要或切坏 JSON。已分派失败仍消耗调用次数，不自动重试。

每个变更回执必须声明 `completion`：accepted、candidate、committed、partial、failed 或 unknown。只有确认完整提交才能带 `committedAt`，Core 不补造该时间。`createMemoryMutationReceipt(..., completion)` 默认 unknown；Source 确认所请求的持久效果完成后才传 `'committed'`。取消或传输异常不证明没有发生写入；跨 Source 流程也不是原子事务。通用 View 工具和已有产品工具均向模型保留此区别。

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

插件运行自己的 `pnpm verify`。仓库级 `pnpm verify:plugins` 打包全部 17 个制品，用正常 semver manifest 在工作区外逐个安装、检查、测试和构建，再编译外部消费者；禁止源码 alias、manifest override 和工作区软链接。

RSI 应保存可复现候选输入/制品，对照已知组合评估，经明确安装/选择决策晋升。Strategy 回放通过，不代表任意 JavaScript 已被沙箱隔离，也不授予交易、发消息或删除外部数据的权限。
