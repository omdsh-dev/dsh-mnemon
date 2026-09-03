# 架构设计

**简体中文** | [English](../en/architecture.md) | [文档中心](./README.md)

## 定位

`dsh-mnemon` 是 DSH 与可替换长期记忆 Provider 之间的集成和监督层，不是新的数据库引擎：

- DSH 提供主 Agent、生命周期事件、subagent provider、工具、命令、设置和 Web 扩展点；
- 插件提供三层知识控制面、路由策略、事务屏障和 UI；
- Mnemon Native 通过本地 `mnemon` CLI 提供命名 Store、SQLite、四类图、关系和软删除，是官方优先实现；8 个三方适配器提供由 Host 控制的 HTTP、本地文件或 CLI 数据面。

三层现在是默认拓扑，不再是写死在各入口里的唯一拓扑。运行时心智刻意只保留四个主要概念：`MemoryBoot` 装配受信任 contribution，`MemorySource` 快照一类记忆，`TurnView` 为一个回合固定 Source generation，`MemoryReceipt` 在 mutation 提交后推进下一回合。Layer、Adapter、Strategy、Guard 仍是控制面扩展边界，不成为模型或普通用户必须理解的额外对象。

只需阅读与你角色对应的一层：

| 读者 | 需要理解的概念 |
|---|---|
| 普通用户 | 运行时、档案、记忆体；默认界面与工作流保持不变 |
| 运维者 | Topology，以及每层的召回、写入、投影、维护参与模式 |
| 扩展作者 | MemoryBoot、MemorySource、TurnView、Receipt 与下文 Kernel 扩展边界 |

## 可组合记忆内核

```text
Cordis lifecycle
      |
      v
 MemoryBoot ---- trusted extensions
      |
      +---- Catalog / Topology / Kernel
      |
      +---- MemorySources (eager | routed)
                       |
turn begins -------- snapshot --------> TurnView
                       |                   |
                       |                   +--> bounded Wake --> System Prompt
                       |                   +--> Host-only Source state
                       |                                      |
model recall(query, optional source ids) ---------------------+
                                                              v
                                                    MnemonService / Provider

committed mutation --> MemoryReceipt --> next turn snapshots a new TurnView
```

`TurnView` 是轻量 generation snapshot，不是知识节点树。eager Source 文本原样进入 Wake；routed Source 在共享预算内只贡献一条 JSON 引用封面，完整 ID 权限留在 Host 并参与 digest。Recall 不再需要模型可见的 View ID、node ID、Zoom、capability token 或第二个 LLM worker。Host 从正在执行的 Agent 自身回合 pin 派生权限、验证请求 ID 是子集，然后直接调用数据面。子 Agent 继承的是已捕获的 View，而不是随时查询父 Agent 最新回合的权限。

Plan 只保留为受 Guard 约束或多 Layer 操作的内部事务机制：

```text
request -> Guard -> Strategy proposal -> Kernel validation -> MemoryPlan
                                                    |
                                                    v
                                      one atomic claim + executor(s)
                                                    |
                                                    v
                                             MemoryReceipt
```

- `MemoryBoot` 是最小 Host 装配器；它把同一套受信任扩展应用到每个独立运行图，作用域、卸载与 isolate 生命周期仍由 Cordis 拥有。
- `MemoryCatalog` 是运行图的贡献目录；注册和卸载都由生命周期拥有，并单调增加 generation。
- `MemoryTopologyManager` 原子保存某一代组合，并跟随运行中的 Catalog 把新 Layer 加为关闭候选、把已卸载 Layer 移出候选。一次操作固定同一组 Catalog/Topology/Guard generation；任一代变化后，旧计划必须重新规划。
- `MemoryKernel` 在 Strategy 之后再次校验 Layer、能力、Adapter 绑定、参与模式、预算与不可绕过的 Guard。Strategy 没有数据面句柄，不能直接读写记忆。
- Strategy 没有提出任何可执行步骤时操作失败关闭；Plan 是 claim-once 权限，顺序或并发重放都会在第二次数据面步骤前被拒绝。执行结果使用 `succeeded / partial / failed / cancelled` 回执，不把部分失败伪装成成功。
- 关闭 Layer 只停止参与，不删除、迁移或隐藏其控制面元数据。重新开启仍使用原有存储。

每层有四个独立参与通道：`recall`、`write`、`projection`、`maintenance`。`off` 完全拒绝该通道；`manual` 只接受用户/控制面显式操作；`automatic` 同时允许显式操作和模型、生命周期或系统自动操作。模型工具属于 `automatic` 触发，不能借“工具调用是显式的”绕过 `manual`。

Runtime、Documents、Memory Spaces 由三个 Layer workspace 包提供；`default-three-tier` Strategy 只是默认组合。扩展 Layer 首次被 Catalog 发现时以关闭状态加入候选拓扑，用户在描述符驱动的设置页只决定是否启用；四通道策略留在 Kernel/SDK 控制面。

## Workspace 与单包发布

源码按职责拆分，但用户仍只安装一个 `dsh-mnemon`。这保持 DSH profile 的安装、升级和回退原子性，也避免插件作者现在就承担多个 npm 包的版本矩阵。

| Workspace | 发布子路径 | 职责 |
|---|---|---|
| `packages/contracts` | `dsh-mnemon/contracts` | 纯 JSON/wire 契约；不依赖 DSH、Cordis、React 或 Provider SDK |
| `packages/kernel` | `dsh-mnemon/kernel` | Catalog、Topology、Plan、Receipt、Guard 与 Kernel |
| `packages/layer-*` | `dsh-mnemon/layers/*` | 三个默认 Layer 描述符与生命周期注册函数 |
| `packages/strategy-sdk` | `dsh-mnemon/strategy-sdk` | Strategy 定义、权限清单与 replay 测试原语 |
| `packages/strategy-default-three-tier` | `dsh-mnemon/strategy-default-three-tier` | 当前兼容行为的默认 Strategy 和拓扑 |
| `packages/provider-sdk` | `dsh-mnemon/provider-sdk` | Adapter Factory Registry 与第三层 Provider 扩展接口 |
| `packages/extension-sdk` | `dsh-mnemon/extension-sdk` | `MemoryBoot`、Host 全局扩展注册与每个运行图的生命周期附着 |
| 根 `src/` | `dsh-mnemon` / `dsh-mnemon/client` | DSH Host、现有控制器、Provider 实现、RPC 与 WebUI 组合根 |

内部 workspace 当前标记为 `private`；公开且受兼容承诺的是 `dsh-mnemon/*` exports。未来只有在生态确实需要独立发布节奏时，才将内部包拆成多个 npm 制品。

## Cordis 时空组合之上的 MemoryBoot

Cordis 提供作用域、所有权、依赖注入和卸载；`MemoryBoot` 只在其上增加记忆领域的装配约定：收集受信任 contribution、附着到每个运行图、校验 Source readiness，并按逆序释放。Host 把这个 Boot 发布为 Cordis 服务 `mnemonMemory`，`dsh-mnemon/extension-sdk` 同时提供进程级预注册入口。

扩展可以在 Host 挂载前注册，也可以在运行中注册或卸载；每个 global/workspace 运行图拥有独立 Catalog、Topology、Kernel 和 TurnView manager，但接收同一套 Boot contribution。运行中的 Catalog 变更与 Topology 新代同步；设置切换则先完整构造并验证下一代运行图，再原子交换稳定代理。

Cordis isolate 用于所有权、装卸和作用域组合，不是安全沙箱。Layer executor、Provider Adapter 和普通 JavaScript Strategy 都与 Host 同进程，只有受信任的已安装插件才能提供。模型生成的 Strategy 必须先经过 `MemoryStrategyPlugin` 不可变清单、Layer/Adapter/Capability/maxSteps 权限约束和 replay；Kernel 随后仍执行权威校验。当前版本不会自动执行模型刚写出的任意代码；未来的 shadow、canary、签名制品和回滚流程建立在这些边界之上。

## 组件图

[![dsh-mnemon 运行时架构](../assets/diagrams/zh-CN/project-architecture.svg)](../assets/diagrams/zh-CN/project-architecture.svg)

图中实线表示确定性数据或控制路径，紫色虚线表示独立任务 Agent 路径。Runtime Memory 和 Documents 直接使用受管文件；Memory Spaces 先经过 `MemoryProviderAdapter`，再进入选中的 Provider 数据面。图中第三层同时表示 Mnemon Native 与 8 种三方实现，不再把整套系统描述为只有 Native 的本地数据。点击图片可以查看 1600×900 原始 SVG。

因此跨 Agent 互操作只发生在第三层：Mnemon Native 通过对齐本地根和 Store 共享，三方引擎通过各自 Provider 作用域共享；任何 Provider 都不会自动共享 DSH 会话、Runtime 投影或 Documents。

### 第三层 Provider 契约

`MemoryProviderAdapter` 把目录、生命周期和用户操作保持在 dsh-mnemon 控制面，把 `status / search / graph projection / browse / remember / related / link / forget` 交给数据面适配器。能力声明是 UI、Agent 和服务端共同使用的硬边界，不支持的操作会被隐藏并在 Host 拒绝。完整当前矩阵见[长期记忆 Provider](./memory-providers.md)。

跨 Provider 检索并发执行，单个失败只生成带记忆体名称的 hint。每个适配器声明 score 是否为标准化相关度；已注册的纯质量策略负责扩展候选、在序列化前过滤并输出结构化计数。异构原始分数不直接比较，保留结果按各 Provider 返回次序做 reciprocal-rank 融合。新适配器和质量策略复用这些契约，不改变上层“记忆体”语义。

创建时的 Provider placement 与召回路由是两个独立阶段。placement 先在 Host 内按已配置状态、允许列表、数据边界和必需能力裁剪候选；只剩一个候选时确定性落定，多个候选时才把脱敏后的能力摘要、记忆体用途和用户策略交给无工具权限的 `spawn` worker。Host 会再次校验结构化结果必须来自合格候选，再实例化 Provider，并把规则、理由、置信度和 worker 审计信息写入记忆体元数据。endpoint、API Key 与身份头始终留在 Host。

## Host 组合根

`src/index.ts::apply()` 按以下顺序组装插件：

```text
settings.register("mnemon")
  -> resolveConfig
  -> MemoryCatalog + default contributions
  -> attach MemoryBoot contributions
  -> MemoryTopology / MemoryKernel
  -> createRunner / MnemonService
  -> RuntimeMemoryController / DocumentManager / StorageScopeInspector
  -> create default MemorySources / TurnView manager
  -> bind Boot MemorySources / validate readiness
  -> MnemonSubagentCoordinator
  -> MnemonLifecycle
  -> tools / commands / prompt sections
  -> register RPC when a Web connection exists
```

Host 声明依赖 `tools`、`settings`、`commands`、`agents` 和 `subagents`。`workspaceRegistry` 通过 Host 服务目录可选发现，只用于 Web 的受权查看。Web client 另外依赖 slots、connection 和 DSH locale 服务。

## Web 与 Headless 边界

核心 Host 组合与 profile 无关。Web 和 Headless 都会挂载设置、运行时上下文、档案、记忆体工具、生命周期钩子和受监督 worker；Agent 操作始终根据 session cwd 解析 `workspace` 存储。

Web 额外提供 `workspaceRegistry`、客户端 slots 和 `connection`，用于跨工作区查看、RPC、Sidebar、设置界面、本回合记忆和存入记忆。Headless 不提供这些浏览器服务；一次性 runner 把任务作为普通用户消息提交，等待 Agent idle、flush session、输出最终答案后退出。插件销毁会取消尚未执行的延迟审查，因此 Headless 依赖任务内完成的显式或模型引导写入，而不是 idle 后维护。

## 直接召回与受监督 mutation

Recall 是受 System Prompt 组装前固定的 Source 权限约束的确定性 Host 读取。每个执行中的 Agent 回合拥有自己的 pin。在 `agent/created`、子 Agent driver 开始执行之前，Host 通过 `parentSession` 找到仍存活的父 Agent，保留其固定 View，并将子 Agent 绑定到该运行图 generation。委托一直保留到子 Agent 本次 activation 被销毁，不受父回合结束、后续回合、View 回收或设置切换影响；嵌套子 Agent 继续捕获同一权限。每个子回合以自身身份固定被保留的 View，不安装 root 专属的提醒或空闲审查钩子。

Host 显式创建的后台子任务若没有活跃的父模型回合，会在捕获的运行图与工作区范围内生成自己的 View。冷恢复的子任务属于新 activation，重新从存活的父 Agent 获取委托。只有 lineage 字符串、没有存活父 Agent 时不授予权限。缺少执行回合权限时失败关闭，不能回退到父 Agent 后来的活跃回合或 `lastViewForAgent()`。

Recall / Related 缓存和 Documents 搜索槽位归属于不可变回合上下文对象，而不是可能复用的 session ID 或回合编号。兄弟任务、后续回合和恢复后的 activation 各有独立预算，同一回合内的并发调用则共享预算。缓存键包含选择的 Memory Space 子集，重放不会返回该子集之外的 evidence。排队中的查询保留准入时的数据面 generation，并在实际请求 Provider 前检查取消。

```text
Agent calls mnemon_recall(query, optional memoryBodyIds)
  -> resolve the executing Agent's turn pin and retained runtime
  -> read Host-only Memory Space Source state
  -> reject requested IDs outside the pinned set
  -> MnemonService searches authorized Providers concurrently
  -> normalize quality and reciprocal-rank fusion
  -> 若准入证据丢失精确锚点或足够词面覆盖，执行一次有界 Native 关键词恢复
  -> 首次最多准入 4 条，并为恢复路径预留容量
  -> LLM 直接回答，或显式提交一个不同的精炼查询
  -> 两次结果去重后共享 6 条 / 4,800 字符 envelope
```

是否发生 Recall 完全由模型判断，普通回合因此仍是 0 次 Provider Recall。在一次已经获得授权的 smart search 内，Host 会先检查准入证据是否保留查询中的日期、百分比、时间、版本、编号和数字等高信息量锚点。查询至少有两个锚点但准入结果没有覆盖有界必需集合时，只有 Mnemon Native 会针对这些锚点执行一次本地 keyword fallback。否则，一个至少产生 4 个有界词面 token 的聚焦查询，在准入证据缺少足够 token 覆盖时也可使用同一条单次本地 fallback。恢复结果必须达到对应的锚点或 token 阈值，去重后仍经过原有质量策略和输出上限。具备查询覆盖的行会排在较小的模型 envelope 之前，避免泛化的 medium-score 行抢先占用首次唯一槽位。该 fallback 不会重复请求远程 Provider，也不会新增 Recall 触发或模型调用。首次调用后，只有模型认为 evidence 不足时，才可显式提交一个实质不同的查询；同查询会 join 或重放，第三个不同查询不能到达 Provider。两次合计最多准入 6 条、每条 1,200 字符、总正文 4,800 字符；首次最多 4 条和 3,600 字符，确保恢复路径始终有容量。每次查询最多准入 1 条 medium-confidence 与 1 条 unknown-scale 结果，使有效精炼能够贡献证据，又不会打开无界低置信度流。模型输出不携带完整 Source 目录、已选 ID 回显或路由诊断，tags/entities 各最多 8 项。`mnemon_related` 使用同一套 pinned-source 校验和独立的有界 envelope。长期语义写入、关系、删除以及记忆体创建/更新仍会在需要语义判断时受监督，但确定性服务会先校验目标 Provider 的能力。Mnemon Native 仍是完整参考实现；三方适配器只开放各自能兑现的精确/异步写入、图谱、浏览、关联与删除语义。运行时记忆和 Documents 的普通变更仍由确定性控制层提交。Document search 会把连续汉字切为有界双字 token，使自然中文查询能够命中相关段落，而不需要把目录交给模型，也不增加模型请求。聚焦查询还必须达到有界最低 token 覆盖，避免仅因一个常见双字词就把多个无关 Document 序列化进对话历史。

记忆体目录的移除是独立危险操作：Mnemon Native 经确认后调用 `store remove`，成功才移除登记；所有三方 Provider 都使用“断开”语义，只删除本地连接元数据，绝不删除 Provider 记忆。

## 独立任务 Agent 与内部 Worker

Web 工作台发起的 AI 元信息、Agent 查询、记忆沉淀和档案归档先创建一个新的顶层任务 Agent。这个 Agent 不借用对话历史，cwd 明确绑定工作台选中的工作区，并组合 DSH 的默认 preset；任务完成后立即释放。它的模型路由默认跟随 DSH 新会话默认值，也可以用 `taskAgentModel` 固定完整 Provider + Model。同一 `taskAgentModel` 路由也会作用到 coordinator 派发的所有子代理委托（空闲复盘、写入、问答、Provider 选择、迁移、压缩、档案归档、元信息维护），因此 `fixed` 模式下顶层任务 Agent 与所有内部 worker 共用同一条模型路由。

顶层任务 Agent 是用户可感知的执行单元；下述 `spawn` / `fork` 是插件内部受限 Worker Provider。任务 Agent 需要语义判断时仍会调度 bounded worker，worker 继承其父任务 Agent 的模型路由。因此，界面统一使用“独立任务 Agent”，而诊断与架构文档保留 worker / subagent 术语。

### `spawn` worker

`spawn` 使用新的隔离上下文。插件为每类任务提供：

- 固定 persona；
- 最小工具白名单；
- 一个经过 schema 校验、随机命名、仅用于本次运行且纳入同一白名单的结果工具；
- `maxDepth: 1`；
- 可取消的 signal 和有界 token 预算。

它用于长期语义写入、证据限定问答、热记忆整理和 Document 归档；Recall 与 related 读取不再消耗第二次模型调用。

### `fork` worker

评分后台审查必须使用名为 `fork` 且 `inheritsParentContext=true` 的 provider。它只继承已经完成的父 checkpoint，用于判断是否需要维护热记忆或最多一份项目档案。它不是用户任务的延续，也不会把审查推理注入主对话。

当前审查白名单不包含 `mnemon_remember`、`mnemon_forget` 或记忆体维护工具，因此后台审查不会直接修改长期记忆体。

## 控制面与数据面

```text
LLM-owned judgment                  Host-owned guarantees
------------------                  ---------------------
what is worth keeping               input validation
which Memory Space fits             path boundary
whether two items are duplicates    process timeout/cancel
how to summarize a Document         file lock + atomic rename
whether a reusable artifact exists  UTF-8 capacity accounting
                                     revision conflict rejection
                                     RPC trust / authentication boundary
```

必须区分“persona 约束”和“Host 硬保证”。例如 MEMORY 归档 worker 被要求覆盖每条已提交热记忆，但 Host 只能硬校验结构化 action、revision 和字节预算；USER 压缩的 source coverage 则由 Host 逐项验证。

## Web RPC 边界

WebUI 不启动系统进程，也不直接打开 SQLite：

```text
browser component
  -> typed client wrapper
  -> DSH transport trust / authentication
  -> Host validation
  -> controller / service / bounded worker
  -> local CLI or managed files
```

同一个 Mnemon 构建无需检测运行时版本即可支持两代 DSH transport。稳定版 0.1.2-rc.1 与它的 alpha.5 前序版本会忽略末尾 authority 参数，并用启动 token 建立的浏览器会话统一保护所有通道。上一条 0.1.1-rc.2 版本线中，读与激活通道使用 `trusted-host`，写、设置和备份默认保持 `loopback`，只有启动时的 `remoteAccess=trusted-host` 兼容设置会将三者整体提升。激活处理器仍只接受精确的记忆体 ID 与布尔状态；Provider 凭据值只经私密管理目录传递，普通读目录始终脱敏。浏览器组件从 Host settings 推导产品可写性，并在传输前禁用 mutation 控件。`writeEnabled=false` 时所有 mutation 处理器都会在 Host 边界拒绝请求。

## 国际化

`src/client/locales.ts` 以中文键集定义 `MnemonKey`，英文词典必须满足同一键集合；`src/client/index.ts` 把两套词典注册到 DSH locale。主要 Web 页面和设置卡随 DSH 全局语言即时切换，并复用全局明暗主题。

当前命令输出、工具卡标题、持久化的兼容默认记忆体名称和部分后端错误仍是单语，这是 Roadmap 中的已知缺口。

## 关键模块

| 模块 | 职责 |
|---|---|
| `src/index.ts` | Host 组合与注册 |
| `src/config.ts` | 配置 schema、默认值和解析 |
| `src/process.ts` | 无 shell 的有界进程执行 |
| `src/runner.ts` | CLI 发现、参数、序列化和 JSON 解析 |
| `src/service.ts` | 长期记忆应用门面 |
| `src/memory-bodies.ts` | Memory Space 目录元数据 |
| `src/providers/*` | 第三层 Provider 契约、目录、原生路由与三方适配器 |
| `src/runtime-memory.ts` | 热记忆事实源与投影 |
| `src/documents.ts` | Documents 控制面 |
| `src/subagent.ts` | worker 编排与容量事务 |
| `src/lifecycle.ts` | per-root-Agent 生命周期 |
| `src/review-activity.ts` | 确定性审查评分 |
| `src/tools.ts` | 模型工具及 root/worker 分流 |
| `src/rpc.ts` | Web 读写通道 |
| `src/storage-scope.ts` | 三种存储范围的只读盘点 |
| `src/client/*` | Web 工作台、设置和 locale |
