# 记忆插件开发

**简体中文** | [English](../../en/development/extensions.md) | [文档中心](../README.md)

先确定归属，再写代码。[plugin-consumer](../../../scripts/fixtures/plugin-consumer) 中的完整示例，会在仓库外只依赖打包制品编译和测试。

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
import { defineMemoryPlugin, installMemory } from 'dsh-mnemon/extension-sdk'
import { notesSource } from './source.js'

export const name = 'dsh-mnemon-source-notes'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Notes', 'zh-CN': '笔记' },
  description: { en: 'Durable personal notes.', 'zh-CN': '长期个人笔记。' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.durable-evidence' }],
})
export function apply(ctx: Context): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [notesSource] })
}
```

以上假定 `source.js` 导出定义；完整文件记忆示例见 [external-source.ts](../../../scripts/fixtures/plugin-consumer/src/external-source.ts)。Source 与 Strategy 是职责，不是强制分包/分仓。一个插件可以调用 `installMemory(ctx, { sources: [source], strategies: [strategy] })`，在同一 Fiber 下成批安装、一起卸载，保留不同的实例 key；仅在需要独立复用/替换时拆包。Strategy 仍需显式选择，随包提供不等于覆盖用户的选择。

每个可组合插件都应导出一份 JSON 安全的 `memoryPlugin` 描述，并把同一个对象传给 `installMemory`。`roles` 只描述贡献职责，不产生两套插件类型；`provides` 与 `requires` 构成激活关系图。只有两个提供者确实不能同时参与时，才把能力标记为 `exclusive: true`。只声明硬依赖：能够真实降级或空操作的插件，不应强迫用户安装无关依赖。Core 会在运行 Source factory 前校验激活图，并且仍是唯一把图编译为一个 View 的组件。没有这份预发布描述的旧插件保持既有组合行为，但 Host 只能推断有限的身份与关系信息。

Entry id 标识实例，type id 标识实现。不能剥掉 Loader 的 include 前缀。没有 Loader 身份的直接 `ctx.plugin()` 挂载，应传 `installMemory(..., { instanceId })`。路径和凭据归实例，不使用模块全局数据库或服务注册表。

## 完整 Strategy 与可叠加贡献

用 `defineMemoryStrategy` 定义，再以 `{ strategies: [definition] }` 安装。声明确定性、支持角色与上限（与角色无关的 Strategy 只列出 `ANY_MEMORY_SOURCE_ROLE`，即 `'*'`）；纯 `compose` 返回 `MemoryViewSpec`，选择准确的 Source key、eager/routed 投影预算和 Source 本地 route/action id。组合阶段不执行网络、存储或凭据访问。

可以同时安装多个主策略，每个 View 只由其中一个组合：`memoryView.strategyTypeId` 负责选择；所选主策略被停用且只剩另一个主策略时，Host 改用那一个并报告 `strategy-fallback` 诊断。完整 Strategy 用可选 `extensionSlots` 声明自有的独占扩展槽。小插件使用 `defineMemoryStrategyExtension`，以 `{ strategyExtensions: [definition] }` 安装。启用后向目标 Strategy 的一个槽贡献有界 JSON，停用只撤销自身贡献；不同槽同时参与一个 View，同一目标的重复槽会拒绝注册，不按安装顺序覆盖。目标 Strategy 未被选择时，贡献保持可观察但不执行；不支持的槽会拒绝候选运行代，并保留已有 Serving。

Core 只处理目标/槽身份、JSON、64,000 字符上限、确定性回放、生命周期和最终 View 的原有预算/权限；它只定义下文 `selection`、`projection` 与 `capture` 三个标准槽的取值契约，其他槽名归目标 Strategy 所有。扩展回调只接收 request 和权限过滤后的 Source facts，没有 Source 对象、grant 或写入回调。槽语义由目标 Strategy 的公开 SDK 定义。动态回调或槽值在具体回合中不合法时，该回合拒绝，不偷偷回退到忽略插件的 View。

### 可选的配置声明

专用 Strategy Entry 还可以导出 `memoryStrategyConfiguration`，由 Core SDK 的 `defineMemoryStrategyConfiguration` 定义。它包含中英文展示文案、公开字段（`number`、`text`、`textarea`、`string-list`、`source-list`），以及**与 `apply()` 共用的纯 `create(config)` factory**。factory 只返回一个 Strategy 或扩展贡献以及同一份 `memoryPlugin` 描述，不做 I/O、凭据访问、Source 注册或 Fiber 挂载；完整例子见内置增强包。这只是面向 Host 与未来工具的可选约定，不定义插件身份或激活关系。

helper 校验并冻结元信息副本，不执行 factory；返回的 `create(config)` 会校验传入字段与所声明的贡献，省略值的默认行为仍由 factory 负责。`number` 必须是有限整数；列表最多 32 个不重复、非空且不超过 500 字符的字符串；文本默认上限为 4,000 字符。Host 对未使用 helper 的模块复用同一套校验，同时保留 Loader 身份检查和局部错误隔离。

普通用户看不到通用的记忆插件发现、依赖图或安装弹窗。每个已安装的记忆组件都出现在**插件 → 可组合记忆**页面的**记忆组合**面板中，位于 DSH 自带的组件列表上方。DSH 插件管理器可用时，它们的启停保存在 DSH profile patch 中，因此插件页的原生组件开关与 Mnemon 控件始终一致；Mnemon 只保存所选主策略和各 Entry 的配置。

#### 插件在面板中的呈现

面板由各插件自己的声明生成，新插件无需修改 Mnemon 即可被列出、开关与配置：

| 声明 | 面板中的呈现 |
|---|---|
| `roles` | `strategy` 是**主策略**的一个选项；`source` 在**记忆来源**中有一行，关闭时也保留；`strategy-extension` 在**增强**中有一行；其他角色自成一组 |
| `label`、`description`（`en`、`zh-CN`） | 该行的名称与说明，按页面语言显示；随附组件以同样方式声明；组件详情还会显示包名以及是否随附于 dsh-mnemon |
| 扩展的 `strategyTypeId` | `'*'` 或所选主策略的类型与其他增强并列；其他类型收入“适用于其他主策略”的折叠分组 |
| `requires`、`provides` | 开启组件时，若它需要的能力没有组件提供，会一同开启第一个已安装的提供者；关闭组件时，会一同关闭因此失去所需能力的组件。主策略的最后一个来源不能关闭，该开关会被拒绝。行内以关联标签点名它需要的唯一提供者、以及只依赖它的运行中组件；组件详情列出全部关系 |
| `provides[].exclusive`、扩展的 `slot` | 两个组件声明同一能力且任一方独占，或两个扩展为有交集的主策略填充同一槽位时，不能同时运行：开启一个会关闭另一个 |
| `memoryStrategyConfiguration.fields` | 行内的齿轮，以及组件页中的选项，每个字段一个控件，带名称、说明、默认值与限制；改动后才出现**应用**。`source-list` 提供角色属于 `sourceRoles` 的运行中 Source 实例，以注册它们的组件命名 |

组件详情说明开关还会带动哪些组件，开关后的提示条会点名实际变化并提供**撤销**。请准确声明 `requires` 与 `provides`：用户正是通过它们看到插件需要什么、不能与什么同时运行。

DSH 自己的插件列表从包内的 `locale/en.json` 与 `locale/zh.json`（`meta.title`、`meta.description`）读取名称与说明，需以 `./locale/*.json` 导出并列入 `files`；缺少时显示包名。请与声明中的 `label`、`description` 保持相同文字，与随附包一致，让组件在 DSH 列表与面板中名称相同。

#### 组件自己的设置与状态卡片

声明的选项不够用时，组件可以在 `./client` 入口把自己的设置加入它的组件页，记忆空间就是这样带来它的 Provider 与嵌入。其他随附组件的设置仍由 dsh-mnemon 通过同一区域绘制：运行时记忆的用户画像范围、分层策略的后台任务。Source 还可以提供它运行时在记忆系统“状态”页卡片上显示的内容。

```tsx
import { installMemoryComponentUI } from 'dsh-mnemon/client'

export function apply(ctx) {
  ctx.effect(() => installMemoryComponentUI(ctx, {
    packageName: 'acme-memory-notes',
    settings: ({ component, writable, language }) => <NotesSettings enabled={component.enabled} readOnly={!writable} language={language} />,
    status: ({ language }) => <><strong>{notesHeadline(language)}</strong><p>{notesDetail(language)}</p></>,
  }))
}
```

设置渲染在 `mnemon.component.settings` 区域，以插件声明中的包名为键，位于组件页的状态、关系与声明的选项之后；该组件的行会出现打开它们的齿轮。它只接收页面知道的信息：`component`（`packageName`、`label`、`enabled`）、`writable`、`language`，以及存在时对话的 `sessionId` 与 `workspace`；所需的服务请通过自己的注册注入。注册会等待 dsh-mnemon 的配置出现，调用返回的函数即结束。请遵循页面的交互规则：开关与下拉选择改动即生效，需要输入的值等待你自己的**应用**，且不并入其他分组的保存。

`dsh-mnemon/client` 还导出记忆空间自己的设置所用的控件与样式，即 dsh-mnemon 绘制这些设置时所用的：`ToggleRow`，`useLive`、`useStaged` 以及 `PanelActions`、`WriteFailure`（一组设置的两种保存方式），`Callout`、`Reveal`、`GlobalLocationSetting`，以及配置页的类名表 `memorySettingsStyles`。类名表的键是一组固定的类名，属于 API：比 Starter 更旧或更新的已安装组件按名称查找它们，因此任何版本都不会重命名其中的类。配置页不会在组件的设置外层设置翻译，所以 `PanelActions` 与 `WriteFailure` 接收你传入的 `t`。导入它们的组件，应把 `dsh-mnemon` peer 最低版本声明为首个导出它们的 Starter，也就是同时导出 `MNEMON_COMPONENT_FALLBACK_PRIORITY` 的那一版。

记忆空间是 dsh-mnemon 曾代为绘制设置的随附组件。dsh-mnemon 保留它的设置，并把只有自己掌握的内容借给记忆空间自己的设置：

- **后备注册。** dsh-mnemon 以 `MNEMON_COMPONENT_FALLBACK_PRIORITY` 自行注册记忆空间的设置（取自它固定的记忆空间版本），为随附组件保留的状态卡片也会这样注册。DSH 对每个键只渲染优先级数值最低的注册，因此记忆空间以默认优先级注册自己的设置后，只要仍在注册，就会替代后备注册。所以只要记忆空间自己的客户端没有注册设置，页面就由后备注册绘制：记忆空间关闭时、打开后其客户端加载期间、客户端加载失败或其条目出错时，以及搭配本身没有设置的 0.5.21 及更早的记忆空间时。打开记忆空间会在已打开的页面下把前者换成后者；前者存在 `host.retained` 中的内容让后者从前者所在的状态开始。
- **只在 dsh-mnemon 让出时注册。** dsh-mnemon 0.5.31 及更早版本以默认优先级自己绘制记忆空间的设置，而 DSH 拒绝同一个包在同一优先级上的第二次注册。导出 `MNEMON_COMPONENT_FALLBACK_PRIORITY` 是 dsh-mnemon 的承诺：它以该优先级保留这些设置，并借给它们 `host`。因此记忆空间只在 `dsh-mnemon/client` 导出它时注册自己的设置。客户端包读取已加载的 dsh-mnemon 缺少的导出时得到 `undefined`，所以记忆空间在绘制时才读取较新的导出，而不是在加载时。
- **`host`。** 注册在记忆空间键下的设置会收到 `host`。`host.configuration` 读取借给记忆空间的配置键，并通过页面带修订栅栏的设置写入 `set` 它拥有的那个键。`host.operations.read`/`write` 调用 dsh-mnemon 为记忆空间提供的 Host 操作，并始终在页面自己的对话与工作区中执行：输入中带 `sessionId` 或 `workspaceId` 的会被拒绝。记忆空间的设置自行发起的读取（`provider-services`、`status-summary`）在相同读取仍在进行时会与之合并，但只合并在配置当前修订下发起的那一次；嵌入测试总是向 Host 重新询问。`host.retained` 在页面的客户端运行期间保存设置重新挂载时需要的内容，`host.changed()` 让记忆系统重新读取它的页面。与 Source 页面的 `management` 客户端一样，`host` 从不交出设置服务或传输层。它跟随键而不是注册者：注册在其他键下的设置不会收到它；其他包只有抢先注册在记忆空间的键下才能拿到它，而这不会给它超出 DSH 已与所有客户端插件共享的连接之外的任何权限。

状态卡片渲染在 `mnemon.component.status` 区域，同样以包名为键，在组件声明的名称下方显示 `<strong>` 中的一行要点与 `<p>` 中的一行说明。它接收 `component`、`language`，以及存在时记忆系统的 `sessionId` 与 `workspace`，并自行读取自己的 Source。无论是否提供内容，每个 Source 组件都有一张卡片：组件已关闭或其 Source 未运行时显示页面自己的说明，未提供内容时显示正在运行。标签页、卡片与页头都使用组件声明的名称。

第三方插件仍走 DSH 原生 Profile/Loader 流程：用准确包名执行 `dsh plugin --profile <Profile> add <包名>@<版本> --save-exact`，检查其 `peerDependencies` 与 `dsh.bundle.patch`，重启后在 Profile 装配中明确激活。下载 npm 包本身不等于激活，Mnemon 也不会在当前进程热加载新代码。欢迎外部作者按本页契约贡献独立仓库；通用图形化管理会在接口和社区用例稳定后再评估，不是 v0.5 承诺。

<a id="默认三层扩展"></a>

### 标准 View 扩展

`dsh-mnemon/extension-sdk` 的 `defineMemoryViewExtension` 以 `ANY_MEMORY_STRATEGY`（`'*'`）为目标：扩展跟随声明了该槽的所选 Strategy，否则保持停用并给出诊断。每个槽只有一个所有者：两个扩展指向同一 Strategy，或其中任一以 `'*'` 为目标时，后注册者会被拒绝，因为切换主策略后二者会在同一个槽相遇。`validateMemoryViewExtension` 与 `memoryViewExtensionValues` 让 Strategy 读取同样经过校验的值。`dsh-mnemon-strategy-default-three-tier/extension-sdk` 保留 `defineThreeTierExtension`，供只作用于该 Strategy 的扩展使用。随附增强使用以下标准槽：

| 可选插件 | 槽 | 贡献与边界 |
|---|---|---|
| `dsh-mnemon-strategy-scoped` | `selection` | Source key 顺序、可写子集；不创建 Source、不改变其物理存储范围 |
| `dsh-mnemon-strategy-light-context` | `projection` | 一份共享投影上限，只收紧 Host 预算；不是增量注入或摘要压缩 |
| `dsh-mnemon-strategy-auto-capture` | `capture` | 当前对话的记录指引、目标与明确 Action id；不启动后台 Agent、不直接写入 |

Starter 会安装这三个包并注册为停用的 DSH Entry，因此开关始终可用，但默认组合、预算和提醒保持 v0.4 行为。打开开关后，对应贡献自动参与当前主策略，不改变主策略；关闭只撤销该贡献，不删除任何 Source 数据。通用策略（`dsh-mnemon-strategy-general`）同样接受这三个槽。Runtime 当前没有展开 route；把常驻预算压得很低可能隐藏运行时记忆，需要针对实际任务评测。

`scoped` 的 Source key 若包含 Loader 的 include 前缀，应使用实例目录中的完整 key；省略配置时按角色/key 确定性组合现有实例，不创建新的存储。面板的**选项**可编辑包声明的字段；Profile 配置仍可用于自动化。

`scoped` 的 `sourceKeys` 表示优先顺序，`writableSourceKeys` 限定可写子集。自动容量整理同样受本轮可写范围限制；被禁止时保留原数据并报错，不绕过范围向其他 Source 迁移。只有显式人工管理走独立的管理授权。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryViewExtension, installMemory } from 'dsh-mnemon/extension-sdk'

export const inject = ['mnemonMemory']
export function apply(ctx: Context): void {
  installMemory(ctx, { strategyExtensions: [defineMemoryViewExtension({
    typeId: 'my-light-context', packageName: 'dsh-mnemon-strategy-my-light-context',
    slot: 'projection', contribute: () => ({ maxProjectionCharacters: 4096 }),
  })] })
}
```

扩展不另建后台调度器；对话内写入仍通过已有 Host 工具、授权和 Source 回执。`capture` 不能把 `manage-spaces` 等一般写操作自动当成记录：作者必须指定实际记录用的 Action id。共享检索预算仍按整个执行回合计算，不按 Source 数量倍增；缓存和 Related 准入带 Source 身份，避免同名空间串用证据。停用贡献后重建失败时，不继续使用已撤销策略：新回合不带记忆 View 运行，对话本身照常进行；已固定的旧回合仍按原租约完成。

可选的 `createTurn(view)` 返回执行级 `query(request, read)` 策略。它只获得绑定当前 Route 和私有 grant 的 `read(input, narrowerLimits?)`，Core 仍校验输入、有效上限、已分派次数和生命周期。策略可以筛选、重放结果，并用 `Evidence.output` 提供简洁模型输出，但不会获得 Source 对象、写入回调或新增权限。策略不调用 `read` 就回答的读取（例如超出预算的读取）应以 `output.notRun: true` 说明，并且不返回条目；Host 不会把它计为一次记忆空间召回。即使继承同一个不可变 View，不同执行轮次也拥有独立策略状态。不提供此钩子时，读取仍经过 Core 边界直接进入 Source。

分层策略插件用此钩子实现旧版 Documents 单次查询、Recall 两次查询的共享证据预算、去重与 Related 准入。命名工具和通用 View Route 共用这套策略。Source 保留原始检索、存储和维护能力；显式的 DSH 辅助写入/归档仍由 Host 工作流执行，不成为 Core 的通用后台任务。

策略在 manifest 的 `workflows` 中声明 Host 要为它组合的回合运行哪些后台工作。`idle-review` 让 Host 在对话空闲时审查由该策略组合的回合（[工作流](../reference/workflows.md)）。`runtime-capacity` 让 Host 接管 Runtime Source 的 `mutate` Action：写入会超出运行时记忆容量时，先归档较早的条目；具名工具、通用 View Action、子 Agent 与浏览器管理都走这一流程。分层策略声明了这两项，其他随附的策略都不声明。以展开分层策略 manifest 的方式构造的策略会连同 `workflows` 一起复制；写 `workflows: []` 可让它两项都不参与。策略选用的空闲审查就是分层策略的空闲审查：设置项是分层策略的 `idleReview`，任务 Agent 通过运行时记忆与项目档案工具写入。Host 会忽略自己不认识的工作流 id；0.5.10 之前的分层策略没有声明，按声明了这两项处理。分层策略插件仍导出 `threeTierActionWorkflow` 供已有调用方使用，Host 不再使用它。这些都不改变 Source 的独立管理协议，也不向 Core 添加三层存储逻辑。模型写入保留发起回合的 View、实例与权限，归档目标限定在该 View 的可写 Memory Spaces Source 及其定义的写入范围内；多个可写归档 Source 无法唯一确定目标时拒绝归档。浏览器使用已登记工作区对应的 scope、实例与确认修订，无需绑定用户会话。只有需要模型判断时才创建独立维护任务。

归档预检时，Host 可向所选 Memory Spaces Source 的 `body-directory` 读取传入 `{ writeScope: { viewId, grant } }`。可选响应 `writeScope: { viewId, sourceInstanceKey, memoryBodyIds }` 与 `remember` 使用相同权限：grant 中已知的命名空间，加上该 View 创建的命名空间。Source 校验 grant 所属实例；Host 校验返回的 View 与 Source 身份，将空范围视为无授权，并在写入前复查权限与当前能力。未返回此字段的 Source 仍使用较窄的已激活命名空间固定范围。响应格式损坏时拒绝操作。Host 不会用其他 Source 或当前目录替代缺失的授权；召回保留原有命名空间固定范围。

选中的 Source 默认必需；`required: false` 明确允许该实例在不可用或投影失败时被省略。必需实例失败会拒绝本轮 View，不悄悄切换策略。分层策略对可用 Source 作组合，并将它们标为可选，因此外部读取失败不会带走其他层。缺少必需实例时，Strategy 应明确拒绝，而不是返回一个空选择。

[external-strategy.ts](../../../scripts/fixtures/plugin-consumer/src/external-strategy.ts) 是完整的显式选择示例。安装后，它会出现在“插件 → 可组合记忆”页面的**主策略**选择器中，选择结果以 `memoryView.strategyTypeId` 保存；自动化部署可在尚未保存选择时通过 `mnemon.memoryTopology.strategyId` 选择它；多个适用 Strategy 是错误，不采用“后导入覆盖前者”。Profile 显式替换默认 Entry；只安装一个包不等于允许它替换当前组合。

可选 `ViewSpec.guidance` 承载 Strategy 的可信 `system`、`routing` 和读写提醒，与 Source 的引用数据分离，经校验后进入 View digest。没有提供时，Host 使用通用路由提示。已有 DSH 命名工具只显示本轮可用性，不重复注入工具目录中的 schema；外部或未绑定的操作仍展示准确 id 和 schema。已有产品工具与人工管理保留；工具存在不代表对应 Source 已进入本轮 View。分层策略的自动后台整理只在选择 `default-three-tier` 时运行，自定义 Strategy 不会隐式触发这项业务流程。

## 开放操作，有限执行

Source 自己定义操作名、输入 schema、存储、索引和维护方式。第三方 Source 还要自己负责备份数据：Mnemon Pack 备份与 Git 同步只覆盖官方的运行时记忆、项目档案与记忆空间组件，也不包含第三方 Provider 的数据与凭据。不要求五类动作、摘要树、统一表示词汇或多维预算协议。Strategy 按 id、角色或权限能力选择自己理解的公开操作。Core 从 Manifest、动态 Facts 和 Host 权限生成 `MemoryAvailableSource.routes/actions`，作者不重复填写描述。

Core 仅约束投影字符数、证据字符数/条数及已分派调用次数；这些是载荷上限，不是完整 LLM prompt 的 token 估算。Source 接收有效上限，自行提供摘录和结构化格式；Core 丢弃超限条目，不伪造摘要或切坏 JSON。已分派失败仍消耗调用次数，不自动重试。

每个变更回执必须声明 `completion`：accepted、candidate、committed、partial、failed 或 unknown。只有确认完整提交才能带 `committedAt`，Core 不补造该时间。`createMemoryMutationReceipt(..., completion)` 默认 unknown；Source 确认所请求的持久效果完成后才传 `'committed'`。取消或传输异常不证明没有发生写入；跨 Source 流程也不是原子事务。通用 View 工具和已有产品工具均向模型保留此区别。

## Provider 子模块与 Client 页面

Provider 使用 Memory Spaces SDK 的 `defineMemorySpaceProvider`。模块只收到限定子节点的 `host.install(ctx, definition)` 能力；私有父 Host、Snapshot 和 Registry 不从 SDK 导出。`installMemorySpaces` 挂载显式子模块，返回 `Promise<void>`，不返回父对象句柄。[external-provider.ts](../../../scripts/fixtures/plugin-consumer/src/external-provider.ts) 会在两个独立父 Source 内以同名子节点测试。

通过 Source 的 `/testing` 入口使用 `mountMemorySpaceProvider`，测试真实子节点注册、带实例别名的驱动创建和清理；返回值只有冻结的 descriptor/manifest 元信息、`registered`、`createAdapter` 与 `dispose`。`createMemorySpaceProviderFixture` 单独提供经过验证的连接及限定范围的驱动权限。[发布 API 测试](../../../scripts/fixtures/plugin-consumer/tests/public-api.spec.ts) 展示如何组合二者，不导入私有实现。

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

importance 只有一种量纲。Source 调用每个 Provider 的 `remember` 时，`importance` 都是 1（最低）到 5（最高）的整数，写入方没有给出时为 3。后端使用其他量纲（例如 0..1 的可信度或权重）时，应把重要度映射到自己的量纲上，而不是直接透传或截断这个数（#447）。Provider 读回时如果报告 `importance`，也使用同一个 1..5 量纲，否则就不报告。

声明 `entities` 的 Provider 会为实体页提供数据。默认情况下，Source 用 `list()` 为每个空间建立实体索引：请在请求的上限内返回全部记忆及其 `entities`，一个实体的计数就是列出的记忆中带有它的条数，也就是实体页列出的那些记忆。如果 Provider 的 `list()` 取不全整个空间（例如受服务端分页大小限制），或者不能列举，请实现可选的 `entityIndex(body, signal)`，返回 `{ memories, complete }`：带有实体的记忆，以及是否已包含全部。索引不完整时，实体页会标为部分。声明了 `entities`、但既不能列举也没有 `entityIndex` 的 Provider 显示为仅查询，它的记忆只会作为召回找到的相关记忆出现在实体页。只要空间的 `status()` 统计不变，Source 就沿用该空间的索引，因此统计应随每次写入变化。

Provider 还可以实现可选的 `get(body, id, signal)`：返回空间中这个精确 id 对应的记忆，没有时返回 `undefined`，读取时不能有副作用。实现后，遗忘、建立关联和相关记忆遍历都可以接受当前 View 没有返回过的 id，例如 Agent 刚写入的记忆，或委派请求中点名的记忆：Source 会在 View 可读的空间中查找这个 id，只有恰好一个空间持有它时才执行。没有 `get` 时，即使指明空间，这样的 id 也要等 View 把它作为证据返回后才能使用：Provider 自己的遗忘或建立关联调用未必限定在该空间内。

可选的 `./client` 通过 `dsh-mnemon/client` 的 `installMemorySourceUI` 注册，由 DSH 作为普通 Client 插件加载。页面接收 `MemorySourcePageProps`：选中实例、locale、可写状态和限定范围的 `management.read/mutate`。用 `MemorySourcePageFrame` 复用 locale/appearance；React 不接收 Host Context、驱动、令牌、LLM grant 或传输层。缺少专属页面时有通用管理入口，重复归属和渲染失败局部诊断。

工作台负责外层页面边距、最小高度与页面滚动容器。嵌套的 `memoryPageStyles.page` 内容复用这一层框架，不再重复增加视口高度或边距，经过 DSH renderer 包装层时也一样。Source 保留业务布局，可以提供有界阅读区或弹窗。内部页面变化时，在绘制前调用可选的 `onResetScroll` 回调；它只重置所属工作台的 canvas，不应滚动 DSH 祖先节点或其他插件。记忆空间这类包含固定标题与 Tab 组合头部的 Source，通过 `navigation.stickyHeader: false` 避免 Host 同时固定下级标题，并由 Source 自己负责组合头部的 sticky 布局。

需要显示某个元素时，将 Source 自有 ref 中的元素传给可选的 `onRevealElement(element, topInset)` 回调。不传 `topInset` 时，元素会停在锁定的页面标题下方；自己固定头部的 Source 则传入实测的头部高度。Host 只滚动所属 canvas，并忽略区域外的元素；不要使用全局 ID 或会移动 DSH 祖先节点的 `scrollIntoView`。关闭选择或卸载 Source 时取消待执行的动画帧。两个滚动回调均为可选：新 Source 仍支持现有 Root peer 最低版本，旧 Host 不提供回调时可手动滚动。

页面中的操作需要回到对话时（例如把某个技能放进输入框），调用可选的 `onReturnToConversation()`：它与页头的**返回会话**相同。工作台已经与对话并排时（会话标签页）不提供这个回调。

用户每次点击工作区顶栏的**刷新**，`refreshKey` 都会变化；配置页改变了页面要显示的内容时也会变化，例如切换组件、保存 Provider、同步、合并、导入 ZIP 或执行整理方案，页面隐藏时也可能变化。页面应在它变化时重新读取数据，而不是自己放置刷新或同步按钮。只有对话中的锚点（例如回合记忆栏里的一条内容）打开页面时，`navigationInput` 才是 `{ seed, nonce }`；点击标签页打开时没有它。默认 Source 把 seed 分别理解为档案 id（项目档案选中它）、召回查询（记忆空间打开后立即执行）或条目文本（运行时记忆高亮并滚动到它）。新的 `nonce` 表示对同一 seed 的又一次请求。

`dsh-mnemon/client` 还导出默认 Source 使用的控件，让安装的 Source 与它们外观和行为一致：`SearchField`（带搜索图标的 DSH 输入框）、`SelectField`（带标签的 DSH 选择菜单，支持 `inline`、`size: 'sm'`、`hideLabel` 与 `ariaLabel`）、`WriteReceipt`（写入的结果、摘要与可选的查看操作）和 `TaskAgentTag`（任务 Agent 能否接手）。它们遵循[交互约定](../guides/ui-guide.md#交互约定)。导入这些控件或读取 `refreshKey` 的 Source，应把 `dsh-mnemon` peer 最低版本声明为首个导出它们的 Starter 0.5.19。传入 `unembedded` 时，`WriteReceipt` 会多一行说明这条记忆没有向量，`embeddingManaged` 决定它的措辞：`false` 表示 DSH 不管理 Mnemon Native 嵌入配置，显示中性的说明；`true` 或不传则显示嵌入没有成功的提醒。dsh-mnemon 0.5.31 及更早版本会忽略 `embeddingManaged`。

## 独立仓库验收

业务文案和布局应留在 Source 包内。默认 Source 使用公开、仅含数据的 `presentation/locales.json`、`presentation/page.module.css`、`presentation/sidebar.module.css`，以及私有 Client 呈现模块示范这一点；独立构建无需引用仓库中的构建脚本。默认 Source 保留既有页面工具的类名命名空间以维持使用兼容；第三方 Source 可使用自己的命名空间，不必向 Root 添加词条或选择器。

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

插件运行自己的 `pnpm verify`。仓库级 `pnpm verify:plugins` 打包全部 18 个制品，用正常 semver manifest 在工作区外逐个安装、检查、测试和构建，再编译外部消费者；禁止源码 alias、manifest override 和工作区软链接。

RSI 应保存可复现候选输入/制品，对照已知组合评估，经明确安装/选择决策晋升。Strategy 回放通过，不代表任意 JavaScript 已被沙箱隔离，也不授予交易、发消息或删除外部数据的权限。
