<h1 align="center">dsh-mnemon</h1>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-mnemon?label=npm" /></a>
  <a href="https://www.npmjs.com/package/dsh-mnemon"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-mnemon?label=downloads%20total" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/omdsh-dev/dsh-mnemon" /></a>
  <a href="https://github.com/omdsh-dev/dsh-mnemon/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/omdsh-dev/dsh-mnemon" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://dshfind.com/zh/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?lang=zh" /></a>
  <a href="https://dshfind.com/zh/plugins/omdsh-dev/dsh-mnemon?ref=badge"><img alt="dshfind 下载量" src="https://dshfind.com/api/badge/omdsh-dev/dsh-mnemon?metric=downloads&amp;lang=zh" /></a>
</p>

<p align="center"><strong>DeepSeek Harness 的三层、可插拔、Agent 驱动记忆系统。</strong></p>
<p align="center">三层记忆 · 九种长期记忆 Provider · 一套受监督工作流</p>

<p align="center">
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/9196fd9991676a6bd9a84d615fcd301eb52e872a/docs/assets/media/dsh-mnemon-memory-system-demo-poster.jpg" alt="dsh-mnemon v0.2.0 多记忆体实时快照与 Provider 可观察范围" width="1180">
  </a>
</p>

<p align="center">
  <a href="./docs/zh-CN/capabilities.md"><strong>先看能力地图</strong></a> ·
  <a href="./docs/zh-CN/getting-started.md">5 分钟开始</a> ·
  <a href="./docs/zh-CN/releases/v0.4.6.md">v0.4.6 升级说明</a> ·
  <a href="https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4">观看宽屏实机演示</a>
</p>

`dsh-mnemon` 为 DSH 提供统一的记忆控制面，但不要求所有知识进入同一种数据库。运行时记忆让紧凑上下文每轮可用；项目档案保留完整叙事；记忆体按需召回长期证据，底层可选择 **Mnemon、OpenViking、Honcho、Mem0、Hindsight、Holographic、RetainDB、ByteRover 或 Supermemory**。

[Mnemon](https://github.com/mnemon-dev/mnemon) 仍是官方优先的原生引擎。可以替换的是第三层；无论选择哪个 Provider，前两层的存储、工作区和交互心智保持不变。

从 v0.3.0 开始，三层是可组合内核中的**默认拓扑**，不再是各入口各自写死的唯一结构。`MemoryBoot` 把受信任的 Layer、Adapter、Strategy、Guard 与 `MemorySource` 装配为一代运行图；每个用户回合固定一份轻量 `TurnView`：Runtime 精确内容 eager 进入 Wake，Documents 与 Memory Spaces 只给出有界路由封面，完整召回权限保留在 Host。用户仍只安装一个 `dsh-mnemon`，设置、工具、RPC 与 UI 工作流不变。参见[可组合架构](./docs/zh-CN/architecture.md#可组合记忆内核)与[扩展开发指南](./docs/zh-CN/extensions.md)。

v0.4.0 将 Sidebar 设为记忆系统的唯一工作台入口，移除 builtin 展示模式及其设置。旧展示偏好会被忽略，不改变记忆数据；完整的 view-based 升级计划放在 v0.5，不包含在本版中。更新前请阅读[升级与兼容性说明](./docs/zh-CN/releases/v0.4.0.md#升级与兼容性)。

v0.4.1 修复记忆系统和存入记忆在依赖 `this` 的 DSH settings store 上的渲染崩溃，以及 ZIP 导出失败和跨时区归档差异；保留 v0.4.0 工作流与既有记忆格式。详见[补丁发布说明](./docs/zh-CN/releases/v0.4.1.md)。

v0.4.2 恢复可选 `displayMode: builtin`，只将 Sidebar 优先迭代的共用界面放入会话。旧 `buildin` 仍可识别，并自动保存为 `builtin`，不改变记忆数据。详见[发布说明](./docs/zh-CN/releases/v0.4.2.md)与[入口位置与范围映射](./docs/zh-CN/configuration.md#入口位置displaymode-与-tabenabled)。

v0.4.3 让折叠后的记忆系统图标与侧栏相邻控件对齐，并保留原有展开样式。详见[补丁发布说明](./docs/zh-CN/releases/v0.4.3.md)。

v0.4.4 同时支持新旧 DSH 会话投影接口，修复旧版宿主读取会话历史失败的问题，并保持新版宿主和已有投影检查点兼容。详见[补丁发布说明](./docs/zh-CN/releases/v0.4.4.md)。

v0.4.5 在已安装 Better Sidebar 时向其注册记忆系统，同时保留 DSH 普通 Sidebar 入口，并兼容两种客户端加载顺序。详见[补丁发布说明](./docs/zh-CN/releases/v0.4.5.md)。

v0.4.6 继续以 DSH 0.1.1-rc.2 作为稳定基线，并通过能力检测兼容 DSH 0.1.2-alpha.4 与 alpha.5 的 Session 事件快照接口。详见[补丁发布说明](./docs/zh-CN/releases/v0.4.6.md)。

## 30 秒理解能力边界

| 层级 | 适合保存 | 如何进入 Agent 上下文 | 由谁管理 |
|---|---|---|---|
| **运行时** | 偏好、协作规则、项目约定、环境事实 | `USER.md` / `MEMORY.md` 每轮紧凑投影 | dsh-mnemon Host 确定性管理 |
| **档案** | 设计、调查、流程、复盘、交接材料 | 先检索，再按需阅读全文 | dsh-mnemon Host 确定性管理 |
| **记忆体** | 跨会话事实、决策、实体与关系 | 从已激活记忆体召回有界证据 | Mnemon Native 或三方 Provider |

三层不是同一内容的副本。简单判断规则是：**每轮都需要的放运行时，需要完整阅读的放档案，需要跨任务按需召回的放记忆体。**当前指令、仓库文件与实时工具结果始终高于历史记忆。

## 点击之后，谁在工作

| 用户操作 | 实际执行方式 | 数据影响 |
|---|---|---|
| **检索** | 并发调用各 Provider 最快的原生召回路径 | 只读 |
| **Agent 查询** | 新建独立顶层任务 Agent，只接收有界证据并组织答案 | 只读 |
| **沉淀记忆** / **存入记忆** | 独立任务 Agent 判断、选路、查重、提炼；Host 控制写入 | 只有通过判断才写入 |
| **智能选择** | 硬规则先筛选，只有真实歧义才交给任务 Agent | 保存路由回执 |
| **AI 维护元信息** | 每个选中记忆体各自启动异步任务，并使用最快采样路径 | 只更新本地标题与说明 |
| **归档档案** | 任务 Agent 先建立可检索冷引用，Host 验证后移动原文 | 受监督迁移 |
| **本回合记忆** | 展开本轮召回、写入和档案检索；点击条目精确跳转 | 只读 |

只有明确写出“任务 Agent”的行才会消耗独立模型上下文；**检索**和**本回合记忆**都是确定性的 Host 读取。

任务 Agent 不会复用或挤占主对话历史，默认跟随 DSH 新建会话时的模型路由；也可以在**设置 → 记忆系统 → 后台任务 Agent**单独指定 Provider 与模型。该固定路由也作用于空闲复盘、写入、证据问答、Provider 选择、记忆迁移、USER 压缩、档案归档和元信息维护等受限 Mnemon worker；对话中的 Recall 与 Related 仍由 Host 直接读取，不使用后台路由。

在 DSH 0.1.1-rc.2 中，第一方 `deepseek-official/deepseek-v4-flash-vision-exp` 路由会标记为**图片输入**。Mnemon 后台任务目前仍只发送文本 Prompt；多模态对话消息在生命周期处理中保留 DSH attachment 引用，不会把原始图片字节复制到记忆。

## 一套记忆体工作流，九种 Provider

| Provider | 形态 | 适合场景 |
|---|---|---|
| **[Mnemon](https://github.com/mnemon-dev/mnemon)** | 官方原生，本地 CLI + SQLite | 精确写入、实体、类型关系、本地优先共享 |
| **[OpenViking](https://github.com/volcengine/OpenViking)** | HTTP + `viking://` | 资源树与异步提炼 |
| **[Honcho](https://github.com/plastic-labs/honcho)** | HTTP workspace / peers | 团队与 Agent peer conclusions |
| **[Mem0](https://github.com/mem0ai/mem0)** | Platform 或自托管 HTTP | 已有用户 / Agent 记忆 |
| **[Hindsight](https://github.com/vectorize-io/hindsight)** | HTTP memory bank | bank、实体与 Provider 原生图谱 |
| **[Holographic](https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/holographic)** | 本地结构化事实文件 | 可审计事实、信任评分、本地实体 |
| **[RetainDB](https://github.com/RetainDB/RetainDB)** | HTTP project / user | 项目与用户双作用域画像 |
| **[ByteRover](https://github.com/campfirein/byterover-cli)** | 本地 `brv` CLI | 代码知识树与 curate 流程 |
| **[Supermemory](https://github.com/supermemoryai/supermemory)** | HTTP container | 文档摄取与容器级共享 |

Provider 能力差异会如实展示：引擎没有图谱边、删除语义或可枚举内容时，dsh-mnemon 不会伪造。**设置页管理可复用的 Provider 服务；记忆体页管理具体实例、激活、作用域与元信息。**三方 Provider 默认关闭。

完整差异见 [Provider 能力与部署矩阵](./docs/zh-CN/memory-providers.md)。

## 真实 WebUI 演示

下面约 55 秒的素材来自真实的 1600×900 DSH WebUI：在完整上下滑动、页面切换、Provider 卡片、弹窗、按钮状态变化和 Agent 答案上都保留了更清晰的停留，并包含一次真正完成的只读 Agent 查询。可能改变数据的确认按钮都没有提交。

![dsh-mnemon v0.2.0 完整 WebUI：上下滚动与按钮交互](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.gif)

[观看 1600×900 MP4](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/media/dsh-mnemon-memory-system-demo.mp4) · [按页面查看交互指南](./docs/zh-CN/ui-guide.md)

## 5 分钟开始使用

### 1. 安装 Mnemon Native

Mnemon 是默认引擎，也是最简单的本地优先起点：

```sh
# macOS
brew install --cask mnemon-dev/tap/mnemon

# macOS / Linux，也可以通过 Go 安装
go install github.com/mnemon-dev/mnemon@latest

mnemon --version
```

Windows 推荐安装 v0.2.3 或更高版本的官方 ZIP；标准安装目录与 checksum 步骤见[快速开始](./docs/zh-CN/getting-started.md#2-安装-mnemon)。

### 2. 安装 DSH 与插件

Registry 安装仍以稳定的 DSH 0.1.1-rc.2 验证；其完整 profile 需要 Node.js `^22.19.0 || >=24.0.0`，Node 20 缺少 rc.2 使用的宿主原语。源码兼容性也已针对最新的 DSH 0.1.2-alpha.5 预览版验证，rc.2 仍是推荐的 registry 安装目标。dsh-mnemon 包本身仍为较旧且兼容的 DSH Host 保留 Node.js 20 支持。下面显式指定已发布版本以保证可复现安装；插件作者可参照 [alpha 源码验证流程](./docs/zh-CN/development.md#dsh-012-alpha5-源码验证)。

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.2
dsh --version
```

```sh
dsh plugin --profile web add dsh-mnemon
dsh --profile web
```

DSH 各 profile 的插件清单彼此独立。一次性 Headless 任务需要单独安装：

```sh
dsh plugin --profile headless add dsh-mnemon
dsh --profile headless "回答前先检查持久化的项目上下文。"
```

本地开发检出使用绝对路径：

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-mnemon"
dsh plugin --profile headless add "link:/absolute/path/to/dsh-mnemon"
```

### 3. 完成第一次验证

1. 打开**记忆系统 → 状态**，确认 dsh-mnemon、Mnemon Native、运行时、档案和已启用 Provider 正常；
2. 打开**记忆体 → 概览 → 创建记忆体**，人工选择一个已启用 Provider；
3. 通过**沉淀记忆**提交一条稳定、未来仍有用的候选；
4. 在**检索**先执行直接检索，再对同一个问题执行**Agent 查询**；
5. 回到对话，展开**本回合记忆**并点击一个具体工具条目。

一级页顺序刻意保持稳定：**状态、运行时、档案、记忆体**。

## 沿用熟悉心智，扩展底层能力

### Agent 驱动的记忆操作

| 受监督沉淀 | 有界 Agent 查询 |
|---|---|
| [![编辑候选内容后再调度独立任务 Agent](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/remember-dialog.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/remember-dialog.png) | [![基于多 Provider 有界证据完成只读 Agent 查询](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/recall-agent-answer.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/recall-agent-answer.png) |

工作台会在调度前明确展示任务边界，并把返回答案与本次证据范围放在一起。对话内的“本回合记忆”和“存入记忆”仍默认开启，可在**设置 → 记忆系统 → 对话界面**分别关闭。

### 人工创建与策略选路

| 明确选择底层 | 智能路由后续沉淀 |
|---|---|
| [![创建记忆体时明确选择 Provider](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/memory-space-create-dialog.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/memory-space-create-dialog.png) | [![在人工指定与智能选择之间配置沉淀策略](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/distillation-strategy.png)](https://github.com/omdsh-dev/dsh-mnemon/blob/e6ca446e45bdd17991f3c7c98560456de465282b/docs/assets/screenshots/distillation-strategy.png) |

手动创建记忆体始终由用户明确选择。智能选择属于“沉淀策略”：硬规则定义候选范围，策略 Prompt 只在多个候选都合格时帮助任务 Agent 决策。

## 全局、工作区与自定义

| 范围 | 行为 |
|---|---|
| `global` | 使用 `~/.mnemon`，适合多个工作区和本机 Agent 共享控制面 |
| `workspace` | 使用 `<workspace>/.mnemon`；支持工作区跟随的本地 Provider 会随有效工作区切换 |
| `custom` | 显式路径的全局语义，适合团队约定或隔离环境 |

同时设置 `storageScope: workspace` 与 `runtimeUserScope: global`，即可让全局 USER.md 用户档案和工作区 MEMORY.md 同时进入投影。用户档案写入保持全局，项目 Runtime、Documents、Memory Spaces 与 Provider state 继续隔离；切换时不会复制或删除已有条目。

远程 Provider 的 workspace、user、bank、project、container 与 URI 保留自己的命名空间；切换 DSH 工作区不会暗中改写。工作区模式下，工作台可以查看一个选定工作区，而当前会话继续使用自己的 cwd；从工作台启动的独立任务 Agent 使用查看工作区，即使没有选中主会话也能正确执行。

## Web、对话与 Headless 使用同一套系统

| 表面 | 可用能力 |
|---|---|
| **Sidebar WebUI** | 状态、运行时、档案、记忆体、Provider 服务、可视化与确认入口 |
| **对话内 UI** | 本回合记忆、存入记忆、精确跳转对应页面 |
| **Headless** | 没有 WebUI，但保留运行时注入、档案检索、记忆体工具、工作区路由与受监督写入 |
| **命令** | `/mnemon status`、`recall`、`related`、`remember`、`forget` |

## 数据与安全边界

- 运行时和档案是本地确定性存储；Mnemon Native 默认本地，三方 Provider 必须显式启用。
- Provider 凭据以 mode `0600` 保存在 `<storageRoot>/state/memory-providers.json`，不会返回浏览器、智能选择 Agent 或 Mnemon Pack。
- Host 调用使用参数数组并禁用 shell，同时约束输出、超时、取消、schema、路径、锁与 revision。
- 关闭 Provider 只清理本地目录元数据，不删除远程数据；重连时从 Provider 重建，无法映射的字段才使用本地默认值。
- 切换范围不会自动迁移、合并或删除旧根目录。
- 当前没有确定性 secret scanner；任何层级都不应保存 key、token、私钥或原始敏感日志。
- 卸载插件不会删除本地或远程记忆数据。

备份、恢复与故障诊断见[运维、安全与故障处理](./docs/zh-CN/operations.md)。

## 文档地图

| 我想要…… | 从这里开始 |
|---|---|
| 看清完整产品边界 | [能力地图](./docs/zh-CN/capabilities.md) |
| 安装并验证第一次工作流 | [快速开始](./docs/zh-CN/getting-started.md) |
| 跟随所有可见点击与 Agent 行为 | [Sidebar 与对话交互指南](./docs/zh-CN/ui-guide.md) |
| 比较或部署九种 Provider | [长期记忆 Provider](./docs/zh-CN/memory-providers.md) |
| 理解分层与生命周期 | [存储模型](./docs/zh-CN/storage-model.md) · [工作流](./docs/zh-CN/workflows.md) |
| 配置范围、路由与模型 | [配置参考](./docs/zh-CN/configuration.md) |
| 备份、更新或排障 | [运维指南](./docs/zh-CN/operations.md) |
| 接入工具、命令或 RPC | [接口参考](./docs/zh-CN/interfaces.md) |
| 开发 Layer、Adapter、Strategy、Guard 或 MemorySource 扩展 | [扩展开发指南](./docs/zh-CN/extensions.md) |
| 查看本次升级 | [v0.4.6 发布说明](./docs/zh-CN/releases/v0.4.6.md) |

完整目录见[文档中心](./docs/zh-CN/README.md)。

## 开发

```sh
pnpm install
pnpm run verify
```

`verify` 会执行 TypeScript 检查、Vitest、可复现双构建、隔离的真实 Headless profile 激活检查与发布包验证。`lib/` 是生成产物，故意不进入版本库。

提交 Issue 或 Pull Request 前请阅读[贡献规范](./CONTRIBUTING.zh-CN.md)（[English](./CONTRIBUTING.md)）并使用双语仓库模板；缺少必填信息的报告和 PR 描述会被双语自动化规则拒绝。

## 许可证

MIT。安全问题请通过 [SECURITY.md](./SECURITY.md) 私下报告，不要公开提交 issue。
