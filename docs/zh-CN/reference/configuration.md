# 配置参考

**简体中文** | [English](../../en/reference/configuration.md) | [文档中心](../README.md)

## 配置位置与生效方式

配置即 DSH profile 中的 `mnemon` 条目。DSH 的 settings 服务把用户值写入 profile patch：

```text
$DSH_HOME/profiles/<profile>/cordis.patch.yml
```

Web profile 的 patch 通常是 `~/.dsh/profiles/web/cordis.patch.yml`。旧宿主留下的 `settings.yaml` 会被导入 profile 一次，并保留为 `settings.yaml.imported`，参见[来自旧宿主的设置](./compatibility.md#来自旧宿主的设置)。当前全部配置标记为 `live` 生效；改动生效时会先初始化候选运行图，再原子切换 Host 服务。

执行中的回合保留已固定的运行图。已经派发的子 Agent 保留委托运行图直到本次 activation 销毁，即使父回合已结束；后续父回合和新委托的 activation 使用新 generation。保存设置不会静默扩大既有任务的 Recall 权限。

与 DSH 对所有自带配置的插件一样，Web 界面在“插件”中该插件自己的页面编辑 Mnemon 的设置，而不在“设置”中。[界面指南](../guides/ui-guide.md#在插件页中)展示了每个部分。

| 界面位置 | 设置 | 保存为 |
|---|---|---|
| 记忆组合 | 主策略；每个记忆来源与增强各一个开关；各组件声明的选项 | `memoryView.strategyTypeId` 与 `memoryView.entries.<entry>.config`；组件的开关状态由 DSH 插件管理器写为对应 Entry 的 `disabled` 行 |
| 存储 | 存储范围、数据目录、排除工作区、备份与迁移；Git 同步开关 | `storageScope`、`dataDir`、`excludedWorkspaces`、`syncEnabled` |
| 界面 | 记忆系统入口、回合记忆栏、存入记忆按钮 | `displayMode`、`conversationInteraction.turnBar`、`conversationInteraction.saveAction` |
| 运行时记忆页面 | 用户画像范围 | `runtimeUserScope` |
| 记忆空间页面 | 记忆 Provider；Mnemon Native 嵌入（自动、Ollama 或 OpenAI 兼容） | `state/memory-providers.json` 中的 Provider 注册表；`embedding` |
| 分层策略页面 | 任务 Agent 模型；空闲审查 | `taskAgentModel`；`idleReview` |
| 技能管理页面 | 自进化、草案自动回测、复盘参数、对话提示、侧边栏入口 | `skills`；见[技能管理设置](#技能管理设置) |

开关与选择器立即生效；存储目录、嵌入连接、审查参数与组件选项等需要输入的值要点击**应用**。Provider 可复用的服务字段（服务地址、凭据、可执行文件）保存在 Provider 注册表中，而不是 Mnemon 的 YAML；启用或保存 Provider 时，会把它已有的命名空间发现到**记忆空间 → 概览**，关闭时只移除这些本地映射。其他高级项需要直接修改 YAML。

OpenViking user key 没有 admin 权限时，可组合服务字段 `discoveryUser`、`endpoint`、`apiKey`、`account`，显式发现单个用户的记忆空间；`discoveryUser` 留空仍枚举 admin。服务字段保存在 Memory Spaces 的 Provider 注册表，不是新的 Mnemon 顶层 YAML 设置。参见 [OpenViking 配置与兼容性](../guides/memory-providers.md#运维边界)。

## 完整示例

```yaml
mnemon:
  storageScope: global # global | workspace | custom | workspaces
  runtimeUserScope: storage # storage | global
  excludedWorkspaces: [] # 可选的已存在工作区绝对路径，支持 ~
  # dataDir: ~/mnemon-data       # custom 时必填
  # cliPath: /opt/homebrew/bin/mnemon
  # store: legacy-store          # 兼容发现提示，不是常规路由目标
  timeoutMs: 10000
  defaultRecallLimit: 10
  runtimeMemory:
    inheritToSubagents: false
    memoryLimitBytes: 10240
    userLimitBytes: 4096
    maintenanceMaxTokens: 8192
  embedding:
    enabled: false
    endpoint: http://localhost:11434
    model: nomic-embed-text
  memoryTopology:
    layers:
      runtime: { enabled: true }
      documents: { enabled: true }
      memory-spaces: { enabled: true }
  recallQuality:
    policy: strict-v1
    lowScoreThreshold: 0.25
    highScoreThreshold: 0.6
    candidateMultiplier: 3
    maxMediumResults: 4
    maxRankedResults: 4
    maxUnknownResults: 2
  routingGuidance: true
  lifecycleEnabled: true
  recallMode: guided
  writebackMode: guided
  idleReviewMs: 30000
  idleReview:
    persistWatermark: false
    enabled: true
    runtimeMemory: true # false：只建项目档案
    provider: spawn
    fallback: spawn
    agentTeams: pause # pause | scoped
    minIntervalMs: 300000
    maxPerSession: 20
    maxContextChars: 24000
    maxTokens: 16384
  tabEnabled: true
  writeEnabled: true
  taskAgentModel:
    mode: inherit # inherit | fixed
    # followConversation: true # 与 inherit 一起使用：跟随会话
    # provider: deepseek # fixed 时必填
    # model: deepseek-chat # fixed 时必填
  remoteAccess: read-only # 远程管理：read-only | trusted-host
```

## 选项

| 配置 | 默认值 | 范围 | 实现语义 |
|---|---:|---|---|
| `storageScope` | `global` | `global` / `workspace` / `custom` / `workspaces` | 统一控制 Runtime、Documents、Memory Spaces 和预留 state 根目录 |
| `runtimeUserScope` | `storage` | `storage` / `global` | 让 USER.md 跟随当前存储根，或叠加全局 USER.md，同时保持项目 MEMORY.md 与其他层使用所选范围 |
| `excludedWorkspaces` | `[]` | 已存在目录的绝对路径列表 | 让指定工作区及其子代理不参与记忆，不删除已有数据 |
| `dataDir` | 未设置 | 绝对路径、`~` 或 `~/...` | `custom` 时必填；`workspaces` 时为可选集中根目录；旧配置只设置它时自动解析为 `custom` |
| `cliPath` | 自动发现 | 可执行路径 | 显式指定 Mnemon CLI |
| `store` | 未设置 | `[A-Za-z0-9][A-Za-z0-9_-]*` | 用于旧 Store 的兼容发现/首选提示；语义操作由 Memory Space 路由 |
| `timeoutMs` | `10000` | 100–120000 ms | 单次 CLI 硬超时 |
| `defaultRecallLimit` | `10` | 1–50 | 服务和 UI 默认召回条数；不同入口可能再收紧 |
| `runtimeMemory.memoryLimitBytes` | `10240` | 1–1048576 字节 | 完整 `MEMORY.md` 投影的 UTF-8 字节上限 |
| `runtimeMemory.userLimitBytes` | `4096` | 1–1048576 字节 | 完整 `USER.md` 投影的 UTF-8 字节上限 |
| `runtimeMemory.maintenanceMaxTokens` | `8192` | 1–1000000 tokens | Runtime 迁移与压缩 worker 的完成 token 预算；不改变项目档案归档与元信息维护预算 |
| `embedding` | `{ enabled: false, endpoint: http://localhost:11434, model: nomic-embed-text, apiKey: '', protocol: auto }` | enabled + HTTP(S) endpoint + model + 可选 apiKey + protocol（auto/ollama/openai） | 开启后，Host 为每个 Mnemon CLI 子进程注入保存的 endpoint、模型、API Key 与协议覆盖；endpoint 以 `/v1` 结尾时 Mnemon 自动使用 OpenAI 兼容协议并以 Bearer 头携带 apiKey，`protocol: openai` 可对非 `/v1` 端点显式指定；关闭后不干预既有 Host 环境和 Mnemon 默认值 |
| `memoryTopology.layers.<id>.enabled` | 三个默认层为 `true` | boolean | 旧版记忆层标记。记忆组合中 Source 的开关会打开或关闭它的 DSH Entry，并同时恢复这个标记；读不到组件时才使用它。关闭 Source 不会删除或迁移数据 |
| `memoryTopology.layers.<id>.participation` | 每层各自的默认值 | `recall`、`write`、`projection`、`maintenance` 分别取 `off` / `manual` / `automatic` | 分层策略下每一层如何参与各类工作 |
| `memoryView.strategyTypeId` | 未设置 | Strategy type id，例如 `default-three-tier` 或 `general` | 当前选择的主策略，由**主策略**选择器写入，优先于 `memoryTopology.strategyId` |
| `memoryView.entries.<entry>.config` | `{}` | 组件声明的选项 | 在组件页保存的选项。开关状态不在这里：DSH 插件管理器把它写为 profile patch 中对应 Entry 的 `disabled` 行，早先保存的选择会一次性迁移过去 |
| `persistenceStrategy` | `{ mode: manual }` | `manual` / `automatic`、`providerId`、`prompt`、`rules` | 新空间的 Provider：任务 Agent 新建记忆空间时固定使用一个 Provider，或按允许的 Provider、数据边界、必需能力与偏好智能选择；已有空间仍按名称与说明路由 |
| `recallQuality.policy` | `strict-v1` | 已注册策略 ID | 在召回正文序列化给 Agent 或客户端前执行的确定性策略 |
| `recallQuality.lowScoreThreshold` | `0.25` | 0–1，低于高分阈值 | `strict-v1` 会移除低于此边界的标准化分数结果 |
| `recallQuality.highScoreThreshold` | `0.6` | 0–1，高于低分阈值 | 保留结果达到此边界时标记为高相关度 |
| `recallQuality.candidateMultiplier` | `3` | 1–5 | 在过滤前扩大各 Provider 候选请求，最多不超过服务的 50 条上限 |
| `recallQuality.maxMediumResults` | `4` | 0–50 | `strict-v1` 在全部高相关度结果之后最多接纳的中相关度条数 |
| `recallQuality.maxRankedResults` | `4` | 0–50 | `strict-v1` 最多接纳的 Provider 排名结果数；不表示标准化置信度，与中相关度结果按排名交错选择 |
| `recallQuality.maxUnknownResults` | `2` | 0–50 | `strict-v1` 在有分数证据之后最多接纳的无 score 或未声明量纲条数 |
| `routingGuidance` | `true` | boolean | 是否注册额外的分层路由 system section |
| `lifecycleEnabled` | `true` | boolean | 是否启用 pre-step cue 和评分空闲审查 |
| `recallMode` | `guided` | `guided` / `off` | 是否在每个会话注入一次可持续复用的按需 recall cue；不移除显式召回 |
| `writebackMode` | `guided` | `guided` / `off` | 是否在每个会话注入一次可持续复用的运行时记忆 cue，并启用评分加 dirty admission 的空闲审查；不移除显式写入 |
| `idleReviewMs` | `30000` | 5000–600000 ms | 达标后需要连续空闲的时间 |
| `idleReview.enabled` | `true` | boolean | 自动审查独立开关 |
| `idleReview.runtimeMemory` | `true` | boolean | 允许审查修改运行时记忆（USER.md 与 MEMORY.md）；`false` 时只创建项目档案 |
| `idleReview.persistWatermark` | `false` | boolean | 在实际运行时存储根目录中，为同一持久父会话保留尝试限额和冷却时间 |
| `idleReview.provider` | `spawn` | `spawn` / `fork` | 有界检查点或继承父上下文 |
| `idleReview.fallback` | `spawn` | `spawn` / `skip` | 仅启动前处理 fork 缺失/不兼容 |
| `idleReview.agentTeams` | `pause` | `pause` / `scoped` | 安装 Team 工具时暂停，或显式启用受 guard 保护的审查；已在每个受支持的 DSH 及其官方 Teams 上验证 |
| `idleReview.minIntervalMs` | `300000` | 5000–86400000 ms | 两次尝试的最短间隔 |
| `idleReview.maxPerSession` | `20` | 0–200 | 当前加载父 Agent 的尝试上限；显式启用持久化后按父会话保留；包括失败/取消 |
| `idleReview.maxContextChars` | `24000` | 1000–1000000 | spawn 检查点字符上限 |
| `idleReview.maxTokens` | `16384` | 128–131072 | 每次模型响应输出上限 |
| `displayMode` | `sidebar` | `sidebar` / `builtin`；兼容旧值 `buildin` | 记忆系统入口：独立 Sidebar 或会话内标签页，共用同一工作台；旧拼写自动迁移为 `builtin` |
| `tabEnabled` | `true` | boolean | 是否挂载所选入口和工作台；关闭后 Host RPC、命令和 Agent 工具保持注册 |
| `writeEnabled` | `true` | boolean | 是否暴露语义写工具、写 RPC 和写命令 |
| `syncEnabled` | `false` | boolean | 本机是否同步到 Git 仓库。默认关闭，关闭时保持沉默：存储页那一行只有标题与开关，不读取状态，也不执行 Git 命令。仓库、分支、目录、提交身份、令牌与自动同步间隔（`autoBackupMinutes`）保存在 `state/sync-git.json`，不在这里 |
| `taskAgentModel` | `{ mode: inherit }` | `inherit` / `fixed`；`followConversation`：boolean | 独立任务 Agent 与空闲审查 worker 的模型路由：`inherit`（**跟随全局**）、`inherit` 加 `followConversation: true`（**跟随会话**），或必须同时保存 `provider` 与 `model` 的 `fixed`（**自定义**）。见[后台任务 Agent 的模型路由](#后台任务-agent-的模型路由) |
| `subagentProviderNames` | `[]` | 最多 32 个非空名称，每个最多 128 字符 | Host 不再支持枚举且自定义插件把名称隐藏在代码中时，提供额外子 Agent Provider 候选。在 Mnemon 插件配置中填写，隔离检查仍然有效；标准 `providerName` 配置会自动发现。 |
| `remoteAccess` | `read-only` | `read-only` / `trusted-host` | 非 loopback Mnemon 管理授权，仅启动时读取，由 API Gateway 映射执行 |
| `conversationInteraction.turnBar` | `true` | boolean | 回复下方的回合记忆栏，立即生效 |
| `conversationInteraction.saveAction` | `true` | boolean | 已完成回复上的**存入记忆**操作及其确认框，立即生效 |
| `skills` | 见[技能管理设置](#技能管理设置) | 该节列出的各键 | 技能管理的自进化、复盘参数、对话提示与侧边栏入口；立即生效，不重建记忆运行图 |

所有值都保存在 `mnemon` 条目下并实时生效：界面的 `mnemon-ui` 设置范围保存为 `conversationInteraction`，`mnemon-view` 设置范围保存为 `memoryView`，`mnemon-skills` 设置范围保存为 `skills`。存储根只会在新运行图初始化成功后原子切换。

Git 同步的默认提交者跟随 Host 在 `state/sync/git` 中解析的 Git 身份；`state/sync-git.json` 中的自定义身份优先。旧的占位姓名/邮箱组合也跟随 Git，只有未配置的字段才使用占位值。优先级与作者被拒绝后的恢复步骤见 [Git 仓库同步](../guides/operations.md#git-仓库同步)。

### 子 Agent 的 Runtime 记忆继承

在 **插件 → dsh-mnemon → 运行时记忆** 中，**子 Agent 自动继承 Runtime 记忆**控制是否自动注入用户画像与工作记忆。开关**默认关闭**；已有配置未设置该字段时也保持关闭。可以通过界面开启，或设置 `runtimeMemory.inheritToSubagents: true`。

设置作用于新建子 Agent。每个子 Agent 在派发时捕获当前选择，并与委托记忆 View 一起保留，运行中切换设置不会改变该任务的选择。开启后，在每轮首个被接受的步骤追加捕获的 Runtime 投影，兼容原生工具与 PTC；后续工具步骤不重复追加，也不改写已有请求前缀。开关只过滤各个 Runtime Source 实例的投影，父任务明确提供的上下文、记忆工具访问、其他来源投影及后台维护的必要输入仍按原规则工作；不会移除任务或会话历史中已经包含的内容。

### Runtime Memory 容量与维护预算

在**插件 → 可组合记忆 → 运行时记忆 → 容量上限**中，以字节填写用户画像和工作记忆的上限，再点击**应用**。两项均接受 1–1048576 之间的整数；**放弃修改**恢复已保存的值。默认仍为 4096 字节（4 KiB）和 10240 字节（10 KiB）。此表单保留单独配置的维护 token 预算。

长会话可以提高运行时记忆的两个字节上限和有界迁移/压缩 worker 预算，无需再补丁修改生成的包文件：

```yaml
mnemon:
  runtimeMemory:
    memoryLimitBytes: 20480
    userLimitBytes: 10240
    maintenanceMaxTokens: 32768
```

默认值保持已发布版本的 10240 / 4096 / 8192 行为。保存后会构建新的运行图，后续 Runtime 读取、写入、容量维护与 Mnemon Pack 校验统一使用这组上限。已有条目与 `memories.json` 格式不变。若把字节上限降低到当前用量以下，不会删除数据；Runtime 视图会显示超容状态，后续写入需要先压缩或重新提高上限。回滚只需删除该配置块或恢复默认值。

存储字节上限计算条目正文和分隔符。模型快照中的重要性与时间跨度注释不占用存储容量，但会占用 Strategy 已有的投影字符预算；它们不增加排序、相关性过滤或独立配置。

自动 Runtime Action（包括空闲复盘）只能保留或提高已有条目的重要度，不能降低；容量规划与压缩提交也遵循同一规则。替换回执会说明是否保留了原重要度。用户仍可在运行时记忆页面显式降低重要度，已有条目不会被自动重新分类。

运行时记忆页面显示每个文件的已用大小与上限。

![运行时记忆：USER.md 与 MEMORY.md 及其默认上限](../../assets/webui-v0.5.32/zh-CN/memory-runtime-limits.jpg)

### Mnemon Native 嵌入

从 Finder 或 Dock 启动的 macOS 应用通常不会继承交互式 shell 启动文件。在 Mnemon Native 中开启“由 DSH 管理嵌入配置”，即可让保存值成为每个 Mnemon 子进程的权威配置：

```yaml
mnemon:
  embedding:
    enabled: true
    endpoint: http://127.0.0.1:11434
    model: qwen3-embedding:0.6b
```

OpenAI 兼容服务器把 endpoint 指到 `/v1` 基础 URL 即可，Mnemon 会自动从 Ollama 协议切换到 OpenAI 协议（`/v1/embeddings`）；需要认证的服务填写 `apiKey`，它将以 Bearer 头注入。不以 `/v1` 结尾的兼容端点用 `protocol: openai` 显式指定协议：

```yaml
mnemon:
  embedding:
    enabled: true
    endpoint: http://127.0.0.1:8080/api
    model: bge-m3-mlx-8bit
    apiKey: sk-...
    protocol: openai
```

Host 会复制正常进程环境，然后只在子进程中覆盖 `MNEMON_EMBED_ENDPOINT`、`MNEMON_EMBED_MODEL`、`MNEMON_EMBED_API_KEY` 与 `MNEMON_EMBED_PROTOCOL`（`protocol: auto` 时不注入协议变量，由 Mnemon 按 `/v1` 自动探测）；不会修改桌面会话、`launchctl`、shell 文件或 Mnemon 持久数据。保存后会切换到新的运行图，后续调用无需重启 DSH 即可使用新值。`enabled: false` 或省略 `embedding` 时，dsh-mnemon 不注入覆盖值，原有继承环境与 Mnemon 内建默认值保持不变。`MNEMON_EMBED_DIMENSIONS` 仍属于可通过 Host 环境继承的高级配置。

Endpoint 必须是不含凭据、查询参数或片段的 HTTP(S) 绝对 URL。Mnemon 会把记忆与查询正文发给该服务；apiKey 与其他设置一样保存在 DSH 设置文件中，远程明文 HTTP 会暴露传输内容，请使用受信任的回环地址或 HTTPS。“测试状态”要求 Mnemon CLI 0.2.13 或更高版本，针对每个已有 Mnemon Native Store 执行实际生效的 `mnemon embed --status`，报告所选模型能否为合成探测文本生成非空向量、CLI 报告的解析协议与已有向量覆盖率，不会回填或改写记忆。旧版或无法识别的 CLI 会提示升级，不会显示检测成功；单独的 `ollama_available` 只能证明 Provider 可达。覆盖率 100% 描述的是已有向量，不代表当前模型可用，也不代表已有向量与当前模型兼容。合成探测不发送已有记忆，并遵循所配置 Provider 的正常计费和超时行为。有未保存编辑时必须先保存，避免把草稿值误报成已生效。

### 记忆来源开关

每个记忆 Source 在**记忆组合**中有一个开关。它通过 DSH 插件管理器打开或关闭该 Source 的 DSH Entry，并在 profile patch 中保存为对应 Entry 的 `disabled` 行。打开表示允许主策略在需要时使用该 Source，并不强制每一轮召回或写入；关闭会同时停止它的上下文注入、工具、后台任务与数据面 Web/RPC 操作。

只要全局还注册着至少一个具有相同 `manifest.typeId` 的活动 Source，Host 就保留对应的命名工具族。移除最后一个 `memory-spaces`、`documents` 或 `runtime` 实例，分别移除其 10、3 或 1 个命名工具；重新注册该类型会恢复工具。三类齐全时 Mnemon 共注册 17 个工具，缺少 Memory Spaces 时为 7 个。两个通用 View 工具与 `mnemon_subagent_result` 独立保留。工作区更窄的 View 或旧版分层标记仍控制执行授权，不会移除其他工作区的全局工具。

首次通过 Loader 启动时，命名工具族等待 `Loader.await()` 就绪后按原有注册顺序发布；通用 View 工具和结果工具立即可用。后续重新启用会追加恢复的工具族，不会重新注册仍在运行的工具。DSH 独立决定模型请求中的工具 schema 顺序。

配置事务只发布最终 Source 集合，回滚也遵循这一边界，中间的卸载与重载不会改变模型 schema。已有 Agent 在下一次模型请求时收到正常的 DSH 工具目录更新。委派子 Agent 的任务允许列表只包含当前已注册的工具；没有适用的 Runtime 或 Documents 写入目标时，空闲审查会跳过。

![记忆组合：每个记忆来源与增强各有一个开关](../../assets/webui-v0.5.32/zh-CN/plugin-composition.jpg)

关闭是可逆的路由状态，不是删除。它在记忆系统中的页面会保留并标记为**未运行**，不读取数据面；状态页与管理目录仍可查看。重新打开后使用原来的目录与数据。最后一个运行中的 Source 不能关闭。旧版的 `memoryTopology.layers.<id>.enabled` 标记会随 Source 一起恢复，只在读不到组件时使用。

WebUI 从实时管理目录读取 Source 实例，新增 Source 无须修改前端。Source type id 匹配配置，Strategy 选择精确的实例 key。设置更新有修订栅栏，候选组合验证成功后才会替换。Core 与 Source 边界会再次检查能力、范围与当前授权。

### 召回质量策略

`strict-v1` 的 0–1 阈值只适用于明确声明为标准化 `normalized-relevance` 相关度的 Provider。它移除非正分与低于阈值的标准化结果，优先保留高相关度结果，再按已有的融合排名交错接纳中相关度和 `ranked` 结果，分别受配额限制（默认各 4 条）；最后最多接纳 2 条无分数或未声明量纲的结果。请求的总条数上限始终有效，不用弱证据补满。`balanced-v1` 把低分结果放在主要证据之后，`exhaustive-v1` 为检查保留有限数值的结果。

Hindsight 的加权最终排名分和 OpenViking 的原始相似度使用 `provider-native` 语义。有限分数按 Provider 返回顺序进入有配额的 `ranked` 档，即使大于 1 也不再降为 unknown，且不会生成 `normalizedScore`。此档只提供有序候选，不保证置信度。全局相关度阈值不能校准这些量纲；可调整 `maxRankedResults` 控制接纳量，设为 0 会关闭此档。跨 Provider 只融合排名，不比较原始分数大小；不通过钳制或每次查询的 min/max 转换把无关候选变成高相关度。

声明标准化分数却返回大于 1 的 Provider 同样进入 `ranked`，原因记为 `out-of-range-score`，并通过 `source.quality.outOfRange` 诊断。`source.quality.ranked` 统计排名候选，`unscaled` 单独统计未声明量纲，`unscored` 统计缺失分数；非有限分数会被拒绝。Source 与相关 Provider 应一起升级：旧 Source 会安全地把新的 native 声明当作未知量纲，但仍沿用旧接纳上限。不修改已存记忆或凭据。

这些是 Memory Spaces Source 自己维护的纯函数召回质量策略，配置只能选择已随该 Source 提供的策略 ID。内部注册函数不是公开插件 API；自定义检索实现应通过 Source/Provider 的公开契约接入。非法候选上限、决策或选择会回退到 `strict-v1`；配置未知 ID 会拒绝候选运行图。过滤计数通过结构化的 `source.quality` 返回，不会拼接进 Agent hint。

### 浏览器认证

DSH 负责浏览器认证或配对，以及 Host/Origin 校验。远程页面使用命名空间 API Gateway，本地回环客户端与 DSH 桌面版窗口（`dsh-app://app/`）使用各自的通道；只有 DSH 为页面声明了不持有 Host 的传输方式时，应用页面才按远程页面处理。Mnemon 网关映射单独执行 `remoteAccess`：`read-only` 允许普通读取、小范围激活和设置查看，但拒绝写入、ZIP 操作、View 变更与设置修改；没有 `trusted-host` 授权时，设置快照报告 `writable: false`。修改这项仅在启动时读取的策略后请重启 DSH。DSH `trustedHosts` 不能代替 HTTPS 或部署层访问控制。`writeEnabled=false` 是产品级只读模式，不能代替传输层认证。

完整的代理、启动 token、可信 authority、重启与验证流程见[云端 WebUI](../guides/operations.md#cloud-hosted-webui)。

### 按工作区排除记忆

在 **存储 → 排除记忆的工作区** 中每行填写一个路径并应用。默认空列表不改变现有行为。路径支持 `~`，经真实路径规范化后精确匹配工作区目录（包括符号链接别名），不支持通配符或递归目录规则。工作区身份取自 DSH 会话头，与存储范围设置无关。子代理即使改变 cwd，也继承父会话的工作区决策；父 Agent 未加载时，可通过 DSH 的工作区与会话目录识别父会话所属工作区。

被排除的会话不再获得新的记忆 View、提示词指导、召回提醒或记忆工具，也不参与自动整理、技能演化、容量维护和记忆写入。工作台标明“已排除记忆”，保留已有数据的查看，拒绝记忆写入与 Agent 辅助操作。配置仍可编辑，便于移除排除项。无效、不存在或不可访问的目录会被忽略，并在工作台提示；无法识别当前或父工作区时会给出诊断，不会静默停用无关会话。

保存后对后续操作生效，不抹除已经进入会话的历史和已完成写入，也不回滚已经派发给 Provider 的操作。移除路径后，下一轮恢复记忆参与，无需迁移或删除数据。这是 Mnemon 的参与设置，不是文件系统或 Host 的安全沙箱。

## 存储范围

### `global`

```text
MNEMON_DATA_DIR when non-empty
  otherwise ~/.mnemon
```

适合希望多个工作区共享 Runtime、Documents 和 Memory Spaces 的用户；其他 Mnemon-enabled Agent 使用相同根时，也可以共享其中的 Mnemon Memory Spaces。

### `workspace`

```text
Agent / 工具 / 生命周期：resolve(currentSession.header.cwd, ".mnemon")
Web 工作台查看：resolve(workspaceRegistry.get(selectedWorkspaceId).path, ".mnemon")
```

每个 DSH 工作区拥有独立的记忆根，包含运行时记忆、项目档案与记忆空间。对话 Agent、模型工具、命令和生命周期按当前会话的 cwd 路由；Web 发起的独立任务 Agent 则显式使用工作台选择的 Host 已登记工作区，不能提交任意路径。因此，没有选中主会话时，整理名称与说明、Agent 查询、存入记忆和档案归档仍会写入记忆系统顶栏选定的工作区。

Headless 没有 `workspaceRegistry`；其新 session 的 cwd 就是启动 `dsh --profile headless ...` 的目录，因此 `workspace` 直接解析为 `<启动命令 cwd>/.mnemon`。

### 全局 USER.md 与工作区项目记忆同时生效

若要跨仓库共享用户级协作要求，同时隔离项目事实，可在**插件 → 可组合记忆**页面把存储范围选为“工作区”，并在“运行时记忆”页面把用户画像范围选为“全局共享”，或配置：

```yaml
mnemon:
  storageScope: workspace
  runtimeUserScope: global
```

此后每回合会把全局根（设置 `MNEMON_DATA_DIR` 时使用该目录，否则使用 `~/.mnemon`）的 `USER.md` 与 `<workspace>/.mnemon` 的 `MEMORY.md` 一起投影。`target=user` 变更和本地 USER.md 压缩只写全局事实源；`target=memory`、Documents、Memory Spaces 与 Provider state 仍留在工作区。全局 MEMORY.md 和工作区 USER.md 条目会完整保留在磁盘，但在该模式下不进入投影。

切换设置不会复制、合并或删除条目；改回 `runtimeUserScope: storage` 后，原工作区 USER.md 会重新可见。Mnemon Pack 仍表示一个所选存储根，因此工作区 Pack 不会暗中带入独立的全局 USER.md；重要的全局档案需要单独备份全局根。

### `workspaces`

这是 Starter 的内置模式，无需额外安装插件。在“存储范围”中选择“集中存储 · 按工作区隔离”，如需自己的集中根目录，在同组“数据目录”中选择“自定义”。

```yaml
mnemon:
  storageScope: workspaces
  dataDir: ~/central-memory # 可选；默认 MNEMON_DATA_DIR 或 ~/.mnemon
  runtimeUserScope: global # 可选；只共享 USER.md
```

四个 area（`runtime`、`data`、`documents`、`state`）都保存在 `<集中根>/workspaces/<规范工作区路径的 SHA-256>/`。现存符号链接别名解析到同一 ID，不同工作区路径相互隔离。移动或重命名会选择新 ID，不会自动迁移。侧栏跟随所选的已登记工作区，会话标签页和 Headless 跟随所属会话 cwd。即使集中根为自定义目录，全局 USER.md 仍使用 `MNEMON_DATA_DIR` 或 `~/.mnemon`。

工作区身份解析允许尚未创建的目录后代，包括 Unicode 名称和符号链接别名下的后代。若路径位于现存文件之下，所有平台（包括 Windows）都会在计算存储 ID 之前以 `ENOTDIR` 拒绝。有效 ID 保持不变，既有存储不会被移动、改写或删除。

切换范围不会迁移、合并或删除旧根。ZIP Pack 仍只包含当前工作区根；要保留全部工作区，请备份整个集中目录。远端 Provider 命名空间仍遵循自身共享语义。

### `custom`

```yaml
mnemon:
  storageScope: custom
  dataDir: /absolute/path/to/mnemon-data
```

也允许 `~` 和 `~/...`。相对路径会被拒绝。

### 选择跨 Agent 共享范围

| 目标 | 推荐范围 | 说明 |
|---|---|---|
| 本机多个 Agent 共享长期记忆 | `global` | 各方统一使用 `~/.mnemon` 或同一个 `MNEMON_DATA_DIR` |
| 多个 Agent 共享指定数据根 | `custom` | 各方显式配置同一个绝对目录，便于隔离和备份 |
| 只在一个项目内共享 | `workspace` | 各方都需要把 Mnemon 根对齐到该项目的 `<workspace>/.mnemon` |

Mnemon Native 通过 `data/<store>/mnemon.db` 与其他 Mnemon-enabled Agent 原生互操作；三方引擎通过配置的 Provider 作用域互操作。Runtime、Documents、DSH 激活状态和 UI 元数据仍属于 dsh-mnemon 管理范围。见[长期记忆 Provider](../guides/memory-providers.md)。

第三方服务配置、记忆空间范围配置与 Secret 保存在当前范围根目录的 `state/memory-providers.json`，不会写入 profile patch。服务配置由同一 Provider 的多个记忆空间复用；运行时才与单个记忆空间配置合并。Mnemon Native 的 ZIP 只包含 Runtime、Documents 与原生记忆空间；第三方服务数据、连接凭据和本地三方 Store 不进入该 ZIP。

## CLI 发现优先级

```text
config.cliPath
  -> executable MNEMON_CLI_PATH
  -> each PATH directory
  -> Windows: GOBIN/mnemon.exe
              first GOPATH/bin/mnemon.exe, or ~/go/bin/mnemon.exe
              %LOCALAPPDATA%/Programs/mnemon/mnemon.exe
              %ProgramFiles%/mnemon/mnemon.exe
              PNPM_HOME, PNPM_HOME/bin, NVM_SYMLINK
              %LOCALAPPDATA%/pnpm, %LOCALAPPDATA%/pnpm/bin, %APPDATA%/npm
              (mnemon.exe or verified mnemon.cmd in these global bin directories)
  -> Unix: ~/.local/bin/mnemon
           /opt/homebrew/bin/mnemon
           /usr/local/bin/mnemon
           /usr/bin/mnemon
```

显式 `cliPath` 会被采用；既可以填写完整路径，也可以填写 PATH 中的命令名（例如 `mnemon`）。状态检查与实际调用使用同一套发现规则，并在重新检查时识别安装或移除的 CLI，无需重启 DSH。若显式指定的命令不可执行，实际调用会返回启动错误，不会悄悄改用其他 CLI。Windows 自动发现接受普通 `.exe` 文件及经过验证的官方 npm/pnpm `mnemon.cmd` 启动器。包管理器启动器通过 Node 调用，全程不使用 shell；任意其他 `.cmd` 与 `.bat` wrapper 仍被排除。迁移至 npm 后，请将显式 CLI 配置指向 npm 启动器，并在“状态 → 检查版本”核对可执行文件路径。

## 兼容 Store 提示优先级

```text
config.store
  -> MNEMON_STORE
  -> <storageRoot>/active
  -> default
```

Memory Space 目录建立后，长期语义操作使用明确的记忆空间 ID，不依赖全局 active Store 进行路由。

## 后台任务 Agent 的模型路由

整理名称与说明、Agent 查询、记忆系统与对话中的存入记忆和档案归档会创建一个不继承主对话历史的独立顶层任务 Agent。它使用当前查看工作区作为 cwd；即使没有选中主 Agent session，也能落到左上角选定工作区。任务完成后释放的是 Agent 实例，DSH 已保存的本地会话记录会保留；Mnemon 不自动删除这些记录。官方 DSH 0.2.2-rc.1 及更早的受支持 Host 保留子代理来源标记，侧栏和 ACP 对话列表不会显示这些记录（[#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)）。DSH 0.2.2-rc.2 与已检查的 master 快照移除了这一公开创建路径，因此 ACP 可列出带 `Mnemon · …` 标题的任务根；标准 WebUI 当前仍隐藏未开始对话轮次且不是当前打开项的根会话。其他客户端或列表元数据缺失时仍可能显示。仅重新打开已完成记录不会恢复 Mnemon 工具权限，重启后同样如此；用户主动发送的新轮次遵循当前权限。详见[Host 兼容说明](./compatibility.md#已发布的-dsh-022-rc1-与-issue-554)。

“分层策略”页面的“后台任务 → 任务 Agent 模型”为这些任务 Agent 与空闲审查 worker 提供三个选项：

- **跟随全局**（`mode: inherit`，默认）：任务 Agent 使用 DSH“创建新会话”时的默认 Provider / Model，DSH 会把它设为最近一次在任意会话中选择的模型；该路由不可用时才沿用当前可用主 Agent 的完整模型路由。空闲审查 worker 以及会话委派的其他 worker 使用所属会话的路由。
- **跟随会话**（`mode: inherit` 加 `followConversation: true`）：使用 DSH 给发起该工作的会话自身委派（包括空闲审查）所用的路由，即其最近一次请求的 provider、模型与推理等级，第一次请求之前则用创建时的路由。该会话未打开时跟随全局。`followConversation` 是独立的配置键，不认识它的版本会按**跟随全局**读取。
- **自定义**（`mode: fixed`）：保存完整的 Provider + Model（两者都必填），只覆盖 Mnemon 后台任务，不改变对话主 Agent。它还会钉住空闲审查 worker，以及写入、证据问答、Provider 选择、迁移、压缩、归档和元信息维护 worker 的路由。

独立任务 Agent 内部如需语义判断（例如为新空间智能选择 Provider），仍可调度受限 worker；该 worker 继承任务 Agent 的模型路由。对话中的 Recall 与 Related 是 Host 直接读取，不使用任何模型路由。

```yaml
mnemon:
  taskAgentModel:
    mode: fixed
    provider: deepseek
    model: deepseek-chat
```

DSH 的实时模型目录会报告各模型的输入模态，选择器为支持图片的模型标记**图片输入**。选中它不代表 Mnemon 后台任务会摄取图片：整理名称与说明、Agent 查询、存入记忆、智能选择与档案归档仍只提交文本与有界证据。在主对话中，dsh-mnemon 追加生命周期指引时会保留 DSH 管理的图片块及其附件引用，活动阈值只计算文本块。原始图片字节不会复制进运行时记忆、项目档案或记忆空间。

当前策略不驱动空闲审查或运行时容量维护时，**记忆系统**会直接列出未运行的维护任务，无需先选择会话。General 策略不驱动这两项维护。设置页会说明生效条件，并保留配置供切回支持相应能力的策略后使用；仅开启审查开关不会让策略自动支持这些任务。手动操作继续遵循原有权限。

## 技能管理设置

技能管理的设置保存在 `mnemon` 条目的 `skills` 下，通过 `mnemon-skills` 设置范围在**插件 → 可组合记忆**里它自己的页面上编辑。设置保存后实时生效；链接更新权限变更会刷新 Source 运行图，其他技能设置不重建运行图；目标选择、草案预算与复盘参数需要点击**应用**或**放弃**。草案预算在每次起草开始时读取。各项含义见[技能管理指南](../guides/skills.md#自进化)。

| 键 | 默认值 | 范围 | 含义 |
|---|---:|---|---|
| `skills.evolution` | `false` | boolean | **自进化**：后台复盘并建议改进技能；会创建落盘的任务及子代理会话，Mnemon 不自动删除这些记录 |
| `skills.allowCreate` | `true` | boolean | **新建技能建议**：允许复盘提出尚不存在的新技能 |
| `skills.allowUpdate` | `true` | boolean | **改进已有技能**：允许复盘提出已有技能的改进 |
| `skills.allowLinkedUpdates` | `false` | boolean | **允许更新链接技能**：更新已有符号链接或 junction 背后的原始文件，所有共享 Agent 都会受影响。创建、安装、移除规则不变，仅对可信目标开启。 |
| `skills.targetScope` | `user` | `storage` / `user` / `project` | **新技能写入位置**：`user` → `user-dsh`；`project` → `project-dsh`；`storage` 跟随 `storageScope`（`global` / `custom` → 用户，`workspace` / `workspaces` → 项目）。设置页面支持应用或放弃 |
| `skills.autoBacktest` | `true` | boolean | **草案自动回测**：草案写好后用测试用例与当前版本对比 |
| `skills.autoAdopt` | `false` | boolean | 自动起草并采纳新的空闲审查建议；要求自进化与自动回测开启、完整文本回测不退步，最多重写两次。 |
| `skills.draftMaxTokens` | `32768` | 整数，128–131072 | **草案输出 token 上限**：首次生成完整草案的预算，包含推理 token |
| `skills.draftRetryMaxTokens` | `65536` | 整数，128–131072 | **重试输出 token 上限**：仅在 `max-tokens` 且此值大于 `draftMaxTokens` 时重新生成一次；相同或更小值关闭截断重试 |
| `skills.hints` | `true` | boolean | **对话提示**：在每个回合下方显示**本回合技能** |
| `skills.sidebar` | `false` | boolean | **侧边栏入口**：技能管理单独显示在侧边栏，不再放在记忆系统里 |
| `skills.reviewThreshold` | `5` | 1–50 | **复盘阈值**：对话窗口的活动积分达到它才会复盘 |
| `skills.idleSeconds` | `20` | 0–3600 秒 | **空闲等待**：对话空闲多久后开始复盘 |
| `skills.cooldownSeconds` | `150` | 0–86400 秒 | **复盘间隔**：同一段对话两次复盘之间的最短时间 |
| `skills.minConfidence` | `0.6` | 0–1 | **最低置信度**：低于它的建议不予收下 |
| `skills.expiryDays` | `7` | 1–90 天 | **建议有效期**：未处理的建议超过这个时间即过期 |
| `skills.maxPendingPerSession` | `5` | 1–20 | **单个对话待处理上限**：超出后，这段对话里置信度最低的待处理建议过期 |
| `skills.casesPerRun` | `8` | 1–20 | **每次回测用例数**：一次自动回测最多运行的用例数 |

关闭自进化时也可以配置**草案生成**。两项预算分别明确限制每次尝试，避免隐性翻倍用户设置的上限。每份草案最多尝试两次，与原有的文件校验失败修正共用一次重试机会。只有 `max-tokens` 才可使用较大的预算；取消和其他模型错误不重试。截断结果在解析和保存前丢弃，重试使用新的任务与子代理。成功草案仍通过原有 schema、内容校验和采纳校验；默认仍须用户手动采纳，生成草案本身不会改动已安装技能。复盘、用例生成、执行和评分仍使用原有预算。

两项均应符合所选提供方/模型的输出上限。若仍被截断，错误会列出实际尝试的预算、原 `SKILL.md` 的 UTF-8 字节数（新技能为零）以及设置位置。只在模型支持的范围内提高预算；提供方拒绝请求预算时应调低。如果完整文件无法容纳于该上限，需要缩短技能或选择输出上限更高的模型。

`skills.targetScope` 默认保留 `user`，兼容现有安装：升级或修改存储范围不会把新技能写到另一个根目录。需要跟随存储范围时显式选择 `storage`。新建议记录解析后的目标；草案及重新起草保留该目标，采纳沿用草案的目标，除非用户手动选择其他位置。旧版本中没有目标字段的建议在起草时使用当前设置；已有草案保留记录的目标。改进已有技能始终写回 `baseKey` 与记录来源共同确定的原文件（包括所属项目），不受设置、所选存储范围或目标覆盖影响。

项目根来自所选工作区的 Skills Source 目录，遵循 DSH 的发现规则（最近的 `.git` 祖先目录，否则为工作区本身），不使用模型任务的工作目录。缺少工作区/项目或目标不可写时，复盘/起草会显示明确错误，不静默降级到用户技能。采纳时重新检查最终选择的项目：不会重建起草后被删除的项目，用户可以明确改选用户根目录；后续文件系统错误也会显示。不会迁移技能或改变发现优先顺序，默认仍由用户手动采纳；可选的自动采纳也遵守这些 Source 校验。

两个建议开关默认均为 `true`，保留旧配置的行为，可分别关闭；两项均关闭时暂停自动和手动会话复盘，不再发起模型调用。开关同时约束对应的评测用例和已在运行的复盘结果。已有建议以及明确发起的生成草案、回测和采纳操作仍可使用。`skills.evolution` 继续作为自动复盘的总开关。

```yaml
mnemon:
  skills:
    evolution: true
    idleSeconds: 30
```

技能管理 Source 自己的数据（建议、用例、记录的对话、版本、市场来源）不是配置，保存在存储根目录的 `skills/` 文件夹中，见[存储模型](./storage-model.md#技能管理)。

## Provider 要求

普通 worker 会优先选择 `spawn`；如果没有该名称，可以选择另一个不继承父上下文的 provider，前提是它限制深度（`depthLimit`），并让子 Agent 使用自己的指令和工具：

- 在 DSH 0.2.0 上，provider 从启动请求中接受这两项（`toolFilter` 与 `persona`）；
- 在 DSH 0.2.1 上，没有 provider 接受这两项，它必须是由 DSH 在本进程中创建子 Agent 的 provider（例如它的 spawn 与 fork），由 Mnemon 自己为子 Agent 配上它们；见 [DSH 0.2.0 与 0.2.1](./compatibility.md#dsh-020-与-021)。

每个子 Agent 都通过固定注册的同一个 `mnemon_subagent_result` 工具交回结果，并带上为它签发的可撤销 `requestId`：子 Agent 返回 `{ requestId, result }`，Host 按该操作的 schema 校验 `result`，拒绝过期或其他子任务提交的结果。

空闲审查默认使用不继承父上下文的 `spawn` Provider，并从父 Agent 当前公开 surface 构建有界检查点。仅收录完整可见文本消息与成功工具结果，不重建被省略或不可用的上下文。`idleReview.provider: fork` 保留完整父上下文审查，并要求 `inheritsParentContext=true`。fork 缺失或不兼容时，`idleReview.fallback` 在启动前选择 `spawn` 或 `skip`；已启动的运行绝不通过其他 Provider 重试。

审查要求本地子 Agent 发布、`agents.isOwnedBy` 和 `agent.ctx.tools.guard`；guard 同样阻止无关的 own-scope 插件工具与 Code Mode 子调用。`maxContextChars` 限制 spawn 检查点；`maxTokens` 限制每次模型响应，不限制 fork 继承输入或多步运行的总用量。

**审查写入什么。**每条知识只进一层。项目记录（设计、实现细节、路径、端口、范围约定、交接说明等）最多写成一份项目档案。工作记忆（MEMORY.md）只收用户明确说过的简短规则，例如约定、纠正、环境事实或工具特性，且项目档案和已有条目都未涵盖；USER.md 收身份与偏好。guard 让每轮审查只写一层：建了项目档案后，修改工作记忆会被拒绝；修改工作记忆后，新建项目档案会被拒绝；USER.md 的修改不受影响。`idleReview.runtimeMemory: false` 会从审查中收回 `mnemon_runtime_memory`，审查只创建项目档案。审查从不写入记忆空间：工作记忆在容量整理时归档进去，项目档案在冷归档时建立索引；**存入记忆**与 `mnemon_remember` 则直接写入。

`idleReviewMs` 仍是连续空闲防抖时间。`minIntervalMs` 限制尝试间隔，失败与取消也计入；`maxPerSession` 限制尝试次数，零表示暂停。默认情况下，新的父 Agent（包括重启 Host 或重新打开会话）获得新的内存内预算。

在分层策略的空闲审查设置中启用**重新打开会话后保留审查限额**，或设置 `idleReview.persistWatermark: true`，即可恢复同一持久父会话的尝试次数和剩余冷却时间。身份由实际运行时存储根目录与父会话 ID 共同决定；新会话或其他根目录使用独立预算，选择 Source/View 或使用全局 USER.md 不改变身份。重建 Agent 或回退 surface 不重置已保留的额度；若 DSH 在清空/压缩时分配新会话 ID，则按新会话处理。在运行中的 Agent 打开此开关后，会立即合并该根目录已用的次数和上次尝试时间作为持久基线，不额外计次或启动工作。关闭后新增内存内尝试、再重新启用时会再次合并，不携带其他根目录的用量。每次尝试在启动子代理前先写入磁盘，失败和取消也计次；预约后崩溃可能消耗一次额度而未启动子代理。重启不重放工作、不补跑审查，仍需新的合格检查点。系统时钟回拨导致的未来时间仍保留冷却约束，并以有界定时器等待。

工作区显示本会话尝试次数、配置上限、恢复次数和最早下次时间；它们是会话准入次数，不是全局完成总量。状态损坏/版本不受支持、读写失败或锁冲突会明确暂停自动审查，普通对话、召回与手动操作仍可使用。停止使用此根目录的所有 Host，检查 `state/idle-review/` 中该会话的 JSON 或废弃 `.lock` 目录，修复/恢复状态，仅删除确认已废弃的锁，然后重新打开会话。删除水位文件会明确重置预算。关闭 `persistWatermark` 会恢复内存内限额但保留文件；重新启用时可恢复已有状态。回滚到旧版本会忽略这些文件。水位仅保存在本机，不进入 Pack/Git 同步，直到手动删除前一直保留；不增加自动清理、重放或 Skills 演进状态。见[存储模型](./storage-model.md#统一根目录)。

在合格回合的可等待停止钩子中、DSH 写入 `turn/end` 之前，Mnemon 会通过正常工具执行链向父会话的必需结果提交工具发送私有空操作检查。后续空闲计时器使用该检查点的准入结果，不再执行父会话工具。会话守卫拒绝所有 `mnemon_*` 时，会在创建子代理、调用模型前跳过检查点，不消耗次数或冷却时间。工作区会说明跳过原因；后续每个合格轮次重新检查，工具策略调整或临时执行链故障恢复后无需重置。需要审批时直接跳过，不弹出审批请求。原生工具与 Code Mode 都适用，不改变工具 schema；Code Mode 保留 DSH 正常的本地工具分发审计事件，但不进入模型可见对话。检查不会写记忆或结束对话轮次。五秒超时会撤销检查凭证并请求取消；停止钩子仍会等待工具执行和审计事件写入收尾，再允许 `turn/end`。扩展必须响应取消并结束自身任务；不配合的扩展可能延迟回合结束。下个合格回合会重新检查。这是通过父会话结果提交通道进行的保守准入，不保证每个写工具或采用不同策略的子代理后续一定获准。显式审查及准入后真实 provider/写入失败保留原有行为。

审查 worker 结束后通过 DSH 公开 API dispose。持久会话历史保留：已发布 Host 没有插件范围的归档/TTL 契约，Mnemon 不删除会话文件或其他插件的 Agent。

**Agent Teams 兼容：**现有配置默认保留 `idleReview.agentTeams: pause`。同时检测到公开 `agentTeams` 服务与父 Agent 作用域的 `spawn_teammate` 工具时，在创建子代理前暂停。仅加载 TeamService 不会暂停审查。

使用任一受支持 DSH 版本的官方 Agent Teams 组件时，可在分层策略页面（**插件 → 可组合记忆**）的空闲审查中选择**受限任务 Agent 审查**，或设置 `idleReview.agentTeams: scoped`。该已发布 Team 策略兼容有界 spawn 与显式 fork。此模式仍检查父子归属、本地子代理发布、`maxDepth: 1` 和单调的审查工具白名单（包括 Code Mode 子调用）。审查子代理仍不能使用 Team 工具或再次委派；父 Agent 保留 Teams。不会猜测包版本或移除其他插件的策略。缺少 guard/归属能力或策略报错时，运行失败且不通过 fallback 重放。保留 `pause` 可在安装 Team 工具时不运行审查；也可设置 `idleReview.enabled: false`，只关闭审查，保留 Teams、召回与主动写入。

有界 spawn 按公开的扁平 `user/message` 事件读取真实用户证据，仅保留已完成检查点之前、当前可见的完整消息；注入的召回、摘要和没有真实用户来源的消息不会被提升为用户断言。配置的字符预算内，明确决策与禁止写入指令都以整条消息保留。

失败的审查仍计为失败。如果失败前已有写入提交，工作区显示子运行 id 和已提交变更回执元数据，包括 Code Mode 外层失败前已提交的内部工具。不自动回滚或重放。手动重试前请核对该运行、档案 id 或 Runtime revision。后续审查仍遵守冷却和会话预算。只需停用此维护流程时，可在分层策略页面关闭**空闲审查**，或设置 `idleReview.enabled: false`。

关闭或切换会话后，已销毁的 Agent 不再启动空闲审查；过期定时器直接跳过，不预留尝试次数。如果销毁与异步准备并发，没有已提交写入的上下文失效错误按取消处理，不新增失败横幅；已经预留的次数与冷却仍保留，与上文的崩溃和取消计次一致。部分写入仍保留核对回执和警告；取消的审查不会自动重放。


## 只读配置

```yaml
mnemon:
  writeEnabled: false
```

效果：

- 不注册模型写工具；
- 写与激活 RPC 保持注册，在 Host 边界拒绝记忆 mutation；
- `/mnemon remember` 和 `/mnemon forget` 拒绝；
- Source 管理与模型 action 同样不能绕过 Host 的写入限制。

它是“功能只读”，不是文件系统只读模式：Runtime 控制器仍可能初始化或修复投影，Document 搜索会更新 LRU 访问时间，Mnemon 读命令也可能触发上游数据库迁移。不要把 `writeEnabled=false` 用作只读挂载的安全承诺。

## 开关交互

```text
writeEnabled=false
  -> overrides all explicit semantic writes

writebackMode=off
  -> no write cue, no scored review
  -> explicit writes remain when writeEnabled=true

recallMode=off
  -> no recall cue
  -> explicit recall remains

lifecycleEnabled=false
  -> no lifecycle cues or review
  -> UI, commands, and explicit tools remain

routingGuidance=false
  -> removes only mnemon:routing
  -> runtime-memory context remains
```

## 入口位置：`displayMode` 与 `tabEnabled`

记忆系统默认使用 Sidebar：从 DSH 左侧栏打开独立主内容区工作台，使用无 Mnemon Logo 的 DSH 官方风格极简皮肤。设置 `displayMode: builtin`，或在**界面 → 记忆系统入口**中选择**会话标签页**，即可把同一个工作台放进当前会话的 `conversation.view` 标签页。页面、导航、弹窗和样式全部共用，不维护另一套 builtin 界面。主题作者可在两种位置使用[受支持的表面选择器与自定义属性](../guides/ui-guide.md#theme-skin-overrides)。

侧栏“记忆系统”的样式、折叠图标和选中状态与 DSH 原生“插件”入口一致。重复点击仍保持打开；**返回会话**或 Esc 会回到当前会话。选择“插件”、其他原生面板或“新建会话”会切换主面板。与任务看板、SSH 切换时，同时同步面板可见性和入口状态，即使其他插件的激活通知遗漏，点击也能重新打开记忆系统。

会话标签页隐藏页眉中的存储模式标记、工作区选择和对齐控件。所有读取、写入和独立任务请求都通过现有 Host 路由跟随所属会话：

| `storageScope` | 会话标签页的实际读写根 |
|---|---|
| `global` | 共享 `MNEMON_DATA_DIR` 或 `~/.mnemon`，不受会话工作区影响 |
| `workspace` | 当前会话的 `<cwd>/.mnemon`；切换会话时自动跟随各自工作区 |
| `custom` | 配置的 `dataDir`，不受会话工作区影响 |
| `workspaces` | 所属会话在 `<集中根>/workspaces/<工作区路径哈希>/` 下的子目录 |

既有 `runtimeUserScope: global` 例外仍让 USER.md 保持全局。切换入口不会改变范围、迁移记忆数据或恢复旧 builtin 导航。选择后立即切换入口。

规范拼写统一为 **`builtin`**。历史上的 `displayMode: buildin` 偏好仍会被识别，运行时与界面统一使用 `builtin`。Host 启动及配置外部热更新时，通过 DSH 带修订号保护的设置接口自动写回这一个字段；旧客户端 RPC 提交 `buildin` 也直接保存为 `builtin`。其他字段和配置注释保持不变，并发期间用户明确选择的 Sidebar 优先，不会被迁移覆盖。

在**插件 → 可组合记忆**页面保存后，当前界面会立即更新。回环页面上，Client 还会跟随 DSH 的设置文档：在其他窗口保存，或 Host 重新加载了对 profile 的修改，都无需刷新浏览器即可看到。远程页面不接收 DSH 的设置镜像，需要刷新才能看到别处的修改。

如果旧值只来自组合 profile，迁移保存一条规范的用户设置覆盖，不直接改写 profile 文件。只读设置仍识别旧拼写，但不会绕过只读限制写盘；落盘失败会记录在 Host 日志中，不会关闭已归一化的入口。

`tabEnabled=false` 会实时移除所选入口和工作台；重新开启后恢复配置的入口位置，两种入口不会同时出现。Host RPC、命令和工具保持注册，运行中的 Agent 或命令不会因界面开关而失效。对话中的回合记忆栏与存入记忆仍由各自的界面开关控制，并跳转到所选入口。

## Profile patch 覆盖

包内 `cordis.patch.yml` 提供默认 config 行。DSH profile 的同 ID 配置可能整体覆盖这行。不要在 profile 的最终 patch 中只增加 `cliPath`；请改用 `MNEMON_CLI_PATH` 或用户设置 `mnemon.cliPath`。确因其他原因需要自定义 profile patch 时，应保留仍需启用的全部键，而不是假设深合并。

已认证网关管理所需的 `remoteAccess` 覆盖属于这种整行自定义。请使用[远程管理操作步骤](../guides/operations.md#remote-management)中的完整、可随升级核对的示例，保留当前配置的其他字段；单独的 `config: { remoteAccess: trusted-host }` 片段会替换这些字段。

## 常见配置

工作区隔离：

```yaml
mnemon:
  storageScope: workspace
```

在各会话内使用相同的工作区隔离：

```yaml
mnemon:
  storageScope: workspace
  displayMode: builtin
```

显式指定 Windows CLI 路径：

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

自定义数据盘和较长 CLI 超时：

```yaml
mnemon:
  storageScope: custom
  dataDir: /Volumes/AgentData/mnemon
  timeoutMs: 30000
```

保留显式工具、关闭生命周期行为：

```yaml
mnemon:
  lifecycleEnabled: false
```

仅关闭后台写回判断：

```yaml
mnemon:
  writebackMode: off
```

## 范围组合的来源选择

范围组合中，未设置 `sourceKeys` 会继承适用的运行时记忆、档案和记忆空间。选择器显示实际默认选择，首次编辑也从此开始。“恢复默认”移除覆盖字段，不保存 `[]`。显式清空并保存时需确认，因为对应 View 将不再提供这些来源；取消不会修改已保存配置。已有 `writableSourceKeys: []` 仍表示只读，此界面保护不改变 Host 授权，也不迁移已有偏好。
