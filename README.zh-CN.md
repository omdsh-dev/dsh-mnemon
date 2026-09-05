# dsh-mnemon

**简体中文** | [English](https://github.com/omdsh-dev/dsh-mnemon/blob/main/README.md)

[![npm](https://img.shields.io/npm/v/dsh-mnemon)](https://www.npmjs.com/package/dsh-mnemon) [![下载量](https://img.shields.io/npm/dt/dsh-mnemon)](https://www.npmjs.com/package/dsh-mnemon) [![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/omdsh-dev/dsh-mnemon/blob/main/LICENSE) [![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?lang=zh)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-mnemon)

**DeepSeek Harness 的可组合记忆系统。默认三层，自定义 Source 与 Strategy，每回合一个 View。**

运行时上下文、可检索档案和长期证据，使用同一个熟悉的 Sidebar。默认 Starter 安装经过验证的插件组合；贡献者可以独立替换或扩展其中的部分。

[![真实 DSH Sidebar 中的合成 Runtime 记忆](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/showcase/zh-CN/runtime.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/showcase/demo.mp4)

[快速开始](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/getting-started.md) · [观看演示](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/showcase/demo.mp4) · [制作插件](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md) · [文档中心](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/README.md)

## 三层记忆，三种用途

| 记忆 | 适合保存 | 如何进入 Agent 上下文 |
|---|---|---|
| **运行时** | 偏好、协作约定、下一轮就需要的事实 | 紧凑的 USER / MEMORY 投影 |
| **档案** | 设计、调查、流程和交接材料 | 先检索，再阅读相关叙事 |
| **记忆体** | 长期事实、决策、实体与关系 | 从已启用后端按需召回证据 |

Sidebar、对话工具与 Headless 使用同一套数据。全局、工作区与自定义范围明确可选。直接检索不创建 Mnemon 任务 Agent；Agent 查询、语义写入和整理可能使用已配置的模型。[流程与调用开销](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/reference/workflows.md)。

## 从默认组合开始

先准备兼容的 DSH Host。**Mnemon Native 还需要单独安装 `mnemon` CLI**；npm Starter 不包含这个二进制，也不会安装三方后端服务。参见[各平台安装步骤](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/getting-started.md)和[已验证的兼容基线](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/reference/compatibility.md)。

```sh
mnemon --version
dsh plugin --profile web add dsh-mnemon
dsh web
```

Headless 使用同一个包：`dsh plugin --profile headless add dsh-mnemon`。

打开**记忆系统 → 状态**，然后添加一条运行时记忆。创建档案前先选择 DSH 工作区，全局存储也需要工作区身份。需要长期沉淀时，人工选择 Provider 并创建记忆体。默认以 Sidebar 展示，可选 Builtin 使用同一组页面。

从 v0.4 升级保留熟悉的配置、数据与工作流。三个可选增强仅在**设置 → 记忆系统**中透出，不增加 View 页或通用记忆插件管理器。[升级清单](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/reference/compatibility.md)。

## Source + Strategy → View

[![Source facts 经 Strategy 与 Core 校验，形成交给 DSH Host 的唯一 View](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e1b58f917289325ee430106385da2d4ff2c67153/docs/assets/diagrams/composable-memory.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/architecture.md)

- **Source** 拥有记忆、投影、读写操作，以及可选的 DSH 页面。
- **Strategy** 决定可用 Source 如何参与：选择范围、常驻内容、检索与使用指引。纯组合不写入记忆。
- **Core** 校验提案，调用 Source 生成有界投影，编译为不可变 **View**；**DSH Host** 将它固定到执行回合，并控制工具访问。

View 不仅包含上下文，也包含 LLM 接下来可以使用的限定范围 route/action。它不是另一种数据库，也不是前端页面。Memory Spaces 自己拥有 Provider 子 Fiber；Core 只提供小型的 `ctx.mnemonMemory` 贡献服务。

默认插件和外部仓库使用同一套公开契约。Source 作者保留数据与后端选择，Strategy 作者复用这些能力、回合生命周期、预算与测试夹具。[完整架构与时序图](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/architecture.md)。

## 官方插件

Starter 随附 **3 个 Source、1 个默认 Strategy、3 个可选策略贡献、9 个 Provider**。各包独立版本、独立发布；Starter 固定经过测试的精确组合。

| 包 | 职责 | 默认状态 |
|---|---|---|
| [dsh-mnemon-source-runtime](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-runtime/README.md) | USER / MEMORY、修订与本地热记忆 | 启用 |
| [dsh-mnemon-source-documents](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-documents/README.md) | Markdown、搜索、修订与归档 | 启用 |
| [dsh-mnemon-source-memory-spaces](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-memory-spaces/README.md) | 长期证据及 Source 自有 Provider 子模块 | 启用 |
| [dsh-mnemon-strategy-default-three-tier](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-default-three-tier/README.md) | 默认三层 View 与回合检索策略 | 选中 |
| [dsh-mnemon-strategy-auto-capture](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-auto-capture/README.md) | 当前回合中主动记录有用事实的指引 | 关闭 |
| [dsh-mnemon-strategy-light-context](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-light-context/README.md) | 所有选中 Source 共享的常驻投影上限 | 关闭 |
| [dsh-mnemon-strategy-scoped](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-strategy-scoped/README.md) | 有序选择 Source，并限定可写子集 | 关闭 |

三个增强使用默认 Strategy 的不同槽，可以共存，最终仍输出一个 View。主动记录是指引，不是自主记录器；投影上限不是 token 计费或增量注入；范围组合不创建存储。

Memory Spaces 可使用以下 Provider 插件：

[Mnemon Native](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mnemon-native/README.md) · [OpenViking](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-openviking/README.md) · [Honcho](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-honcho/README.md) · [Mem0](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-mem0/README.md) · [Hindsight](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-hindsight/README.md) · [Holographic](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-holographic/README.md) · [RetainDB](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-retaindb/README.md) · [ByteRover](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-byterover/README.md) · [Supermemory](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-provider-supermemory/README.md)。

Native 是默认后端，三方服务需要显式配置和启用。图谱、删除、精确写入与枚举能力保留各后端的真实差异。[Provider 能力与部署](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/memory-providers.md)。

## 制作自己的组合

通过 `dsh-mnemon/extension-sdk` 定义 Source 或 Strategy，并注册到所属 Cordis Fiber。可叠加贡献使用目标 Strategy 的 SDK；Memory Spaces 驱动使用 `dsh-mnemon-source-memory-spaces/provider-sdk`。

个人仓库拥有自己的 manifest、公开依赖、实现、测试与构建。DSH Profile/Loader 负责安装和挂载；Mnemon 不扫描任意已安装插件。安装代码、激活贡献、选择完整 Strategy，是不同的决定。

从[插件开发指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)和[外部消费者示例](https://github.com/omdsh-dev/dsh-mnemon/tree/main/scripts/fixtures/plugin-consumer/)开始，验证独立包、双实例、卸载、限定读取与授权写入。Git 或 Notion 集成可以做成新的 Source；这不代表现有所有 DSH memory 插件都已无缝支持。

欢迎维护独立插件仓库。向本仓库贡献时遵循[贡献规范](https://github.com/omdsh-dev/dsh-mnemon/blob/main/CONTRIBUTING.zh-CN.md)，新能力与 Provider 请先通过 Issue 讨论。

## 数据与信任边界

- Runtime 与 Documents 保存在本地，Native 默认本地；外部 Provider 使用各自配置的服务与范围。
- 停用参与不擦除记忆，切换存储范围不迁移数据。停用 Provider 可能清理本地目录元信息，但不删除远端数据。
- 已保存的 Provider 凭据留在 Host，不进入 Mnemon Pack；Pack 仍包含私有记忆，需要妥善保护。
- Source 与 Strategy 是受信任的同进程 JavaScript，**不是沙箱代码**。历史记忆不能覆盖当前指令，模型生成的插件不会自动安装。

[备份与恢复](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/operations.md) · [安全策略](https://github.com/omdsh-dev/dsh-mnemon/blob/main/SECURITY.md) · [发布历史](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/releases/README.md) · [Roadmap](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/roadmap.md)

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:plugins
```

使用 Node.js `^22.19.0 || >=24.0.0` 与 pnpm 10.13.1。各包可以独立验证；WebUI 素材来自临时数据和真实 DSH Host。机制测试不等于 LLM 准确度或真实云 Provider 一致性验证。[开发指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/README.md) · [素材来源](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/assets/showcase/README.md)。
