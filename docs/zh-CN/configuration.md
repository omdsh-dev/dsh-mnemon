# 配置参考

**简体中文** | [English](../en/configuration.md) | [文档中心](./README.md)

## 配置位置与生效方式

插件在 DSH settings 服务中注册 `mnemon` 命名空间。用户配置位于：

```text
$DSH_HOME/settings.yaml
```

默认通常是 `~/.dsh/settings.yaml`。当前全部配置标记为 `live` 生效；保存后会先初始化候选运行图，再原子切换 Host 服务。

执行中的回合保留已固定的运行图。已经派发的子 Agent 保留委托运行图直到本次 activation 销毁，即使父回合已结束；后续父回合和新委托的 activation 使用新 generation。保存设置不会静默扩大既有任务的 Recall 权限。

Web 设置页编辑 `storageScope`、独立的 `runtimeUserScope`、`dataDir`、Mnemon Native 的 Ollama 嵌入覆盖、三个记忆层的总开关、后台任务 Agent 的模型路由，以及 `mnemon-ui` 下的回合记忆条和存入记忆按钮。“全局 / 工作区”是整个记忆系统的范围；USER.md 用户档案也可以显式保持全局，而项目记忆继续跟随该范围。`custom` 数据位置、嵌入运行配置与 ZIP 备份 / 迁移收纳在 Mnemon Native 折叠栏。每个第三方 Provider 有独立的服务配置折叠栏；这里保存的是 endpoint、凭据或可执行文件等可复用服务信息，不会创建记忆体。具体记忆体及其数据范围仍在“记忆体 → 概览”中创建。其他高级项需要直接修改 YAML。

## 完整示例

```yaml
mnemon:
  storageScope: global # global | workspace | custom
  runtimeUserScope: storage # storage | global
  # dataDir: ~/mnemon-data       # custom 时必填
  # cliPath: /opt/homebrew/bin/mnemon
  # store: legacy-store          # 兼容发现提示，不是常规路由目标
  timeoutMs: 10000
  defaultRecallLimit: 10
  runtimeMemory:
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
    maxUnknownResults: 2
  routingGuidance: true
  lifecycleEnabled: true
  recallMode: guided
  writebackMode: guided
  idleReviewMs: 30000
  tabEnabled: true
  writeEnabled: true
  taskAgentModel:
    mode: inherit # inherit | fixed
    # provider: deepseek # fixed 时必填
    # model: deepseek-chat # fixed 时必填
  remoteAccess: read-only # 仅 rc.2：read-only | trusted-host
```

## 选项

| 配置 | 默认值 | 范围 | 实现语义 |
|---|---:|---|---|
| `storageScope` | `global` | `global` / `workspace` / `custom` | 统一控制 Runtime、Documents、Memory Spaces 和预留 state 根目录 |
| `runtimeUserScope` | `storage` | `storage` / `global` | 让 USER.md 跟随当前存储根，或叠加全局 USER.md，同时保持项目 MEMORY.md 与其他层使用所选范围 |
| `dataDir` | 未设置 | 绝对路径、`~` 或 `~/...` | `custom` 时必填；旧配置只设置它时自动解析为 `custom` |
| `cliPath` | 自动发现 | 可执行路径 | 显式指定 Mnemon CLI |
| `store` | 未设置 | `[A-Za-z0-9][A-Za-z0-9_-]*` | 用于旧 Store 的兼容发现/首选提示；语义操作由 Memory Space 路由 |
| `timeoutMs` | `10000` | 100–120000 ms | 单次 CLI 硬超时 |
| `defaultRecallLimit` | `10` | 1–50 | 服务和 UI 默认召回条数；不同入口可能再收紧 |
| `runtimeMemory.memoryLimitBytes` | `10240` | 1–1048576 字节 | 完整 `MEMORY.md` 投影的 UTF-8 字节上限 |
| `runtimeMemory.userLimitBytes` | `4096` | 1–1048576 字节 | 完整 `USER.md` 投影的 UTF-8 字节上限 |
| `runtimeMemory.maintenanceMaxTokens` | `8192` | 1–1000000 tokens | Runtime 迁移与压缩 worker 的完成 token 预算；不改变项目档案归档与元信息维护预算 |
| `embedding` | `{ enabled: false, endpoint: http://localhost:11434, model: nomic-embed-text, apiKey: '', protocol: auto }` | enabled + HTTP(S) endpoint + model + 可选 apiKey + protocol（auto/ollama/openai） | 开启后，Host 为每个 Mnemon CLI 子进程注入保存的 endpoint、模型、API Key 与协议覆盖；endpoint 以 `/v1` 结尾时 Mnemon 自动使用 OpenAI 兼容协议并以 Bearer 头携带 apiKey，`protocol: openai` 可对非 `/v1` 端点显式指定；关闭后不干预既有 Host 环境和 Mnemon 默认值 |
| `memoryTopology.layers.<id>.enabled` | 三个默认层为 `true` | boolean | 是否让该 Layer 参与；关闭不会删除或迁移已有数据 |
| `recallQuality.policy` | `strict-v1` | 已注册策略 ID | 在召回正文序列化给 Agent 或客户端前执行的确定性策略 |
| `recallQuality.lowScoreThreshold` | `0.25` | 0–1，低于高分阈值 | `strict-v1` 会移除低于此边界的标准化分数结果 |
| `recallQuality.highScoreThreshold` | `0.6` | 0–1，高于低分阈值 | 保留结果达到此边界时标记为高相关度 |
| `recallQuality.candidateMultiplier` | `3` | 1–5 | 在过滤前扩大各 Provider 候选请求，最多不超过服务的 50 条上限 |
| `recallQuality.maxMediumResults` | `4` | 0–50 | `strict-v1` 在全部高相关度结果之后最多接纳的中相关度条数 |
| `recallQuality.maxUnknownResults` | `2` | 0–50 | `strict-v1` 在有分数证据之后最多接纳的无 score 或未知量纲条数 |
| `routingGuidance` | `true` | boolean | 是否注册额外的分层路由 system section |
| `lifecycleEnabled` | `true` | boolean | 是否启用 pre-step cue 和评分后台审查 |
| `recallMode` | `guided` | `guided` / `off` | 是否在每个会话注入一次可持续复用的按需 recall cue；不移除显式召回 |
| `writebackMode` | `guided` | `guided` / `off` | 是否在每个会话注入一次可持续复用的热记忆 cue，并启用评分加 dirty admission 的后台审查；不移除显式写入 |
| `idleReviewMs` | `30000` | 5000–600000 ms | 达标后需要连续空闲的时间 |
| `displayMode` | `sidebar` | `sidebar` / `builtin`；兼容旧值 `buildin` | 入口位置：独立 Sidebar 或会话内标签页，共用同一工作台；旧拼写自动迁移为 `builtin` |
| `tabEnabled` | `true` | boolean | 是否挂载所选入口和工作台；关闭后 Host RPC、命令和 Agent 工具保持注册 |
| `writeEnabled` | `true` | boolean | 是否暴露语义写工具、写 RPC 和写命令 |
| `taskAgentModel` | `{ mode: inherit }` | `inherit` / `fixed` | AI 元信息、Agent 查询、记忆沉淀和档案归档使用的独立任务 Agent，以及空闲复盘 worker 的模型路由；`fixed` 必须同时保存 `provider` 与 `model`，并会钉住对应的写入、证据问答、Provider 选择、迁移、压缩、归档和元信息维护 worker。对话中的 Recall 与 Related 是 Host 直接读取，不使用该路由 |
| `remoteAccess` | `read-only` | `read-only` / `trusted-host` | DSH 0.1.1-rc.2 的非 loopback Mnemon 管理 RPC 兼容策略；仅启动时读取，DSH 0.1.2-alpha.1 会忽略 |
| `mnemon-ui.turnBar` | `true` | boolean | 回合尾记忆活动条；默认开启，**保存后实时生效** |
| `mnemon-ui.saveAction` | `true` | boolean | 已定稿助手回复旁的「存入记忆」图标与确认弹窗；默认开启，**保存后实时生效** |

`mnemon` Host/存储命名空间和 `mnemon-ui` 浏览器呈现命名空间都实时生效。存储根只会在新运行图初始化成功后原子切换；旧版 `mnemon.conversationInteraction` 仍会作为迁移默认值读取，但新保存只写入 `mnemon-ui`。

### Runtime Memory 容量与维护预算

长会话可以提高两类热记忆的字节上限和有界迁移/压缩 worker 预算，无需再补丁修改生成的包文件：

```yaml
mnemon:
  runtimeMemory:
    memoryLimitBytes: 20480
    userLimitBytes: 10240
    maintenanceMaxTokens: 32768
```

默认值保持已发布版本的 10240 / 4096 / 8192 行为。保存后会构建新的运行图，后续 Runtime 读取、写入、容量维护与 Mnemon Pack 校验统一使用这组上限。已有条目与 `memories.json` 格式不变。若把字节上限降低到当前用量以下，不会删除数据；Runtime 视图会显示超容状态，后续写入需要先压缩或重新提高上限。回滚只需删除该配置块或恢复默认值。

下方隔离 DSH Web 对比图先展示默认 USER 4.0 KB / MEMORY 10.0 KB，再展示已生效的 USER 10.0 KB / MEMORY 20.0 KB 配置。两张截图均使用空的临时根，不含私有记忆。

[![Runtime Memory 默认容量与配置后容量对比](../assets/screenshots/runtime-memory-capacity-configuration.png)](../assets/screenshots/runtime-memory-capacity-configuration.png)

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

Endpoint 必须是不含凭据、查询参数或片段的 HTTP(S) 绝对 URL。Mnemon 会把记忆与查询正文发给该服务；apiKey 与其他设置一样保存在 DSH 设置文件中，远程明文 HTTP 会暴露传输内容，请使用受信任的回环地址或 HTTPS。“测试状态”会针对当前默认 Store 执行实际生效的 `mnemon embed --status`，只报告嵌入服务可达性、模型、Mnemon 报告的解析协议与嵌入覆盖率，不会回填或改写记忆。有未保存编辑时必须先保存，避免把草稿值误报成已生效。

### 记忆层开关

每层只有一个总开关。`enabled=true` 表示允许默认策略在需要时使用该层，并不强制每回合召回或写入；`enabled=false` 会同时停止该层的上下文注入、模型调用、后台处理和数据面 Web/RPC 操作。

[![隔离安装的 v0.3 中文设置页：三个默认记忆层各有一个总开关](../assets/screenshots/settings-memory-layers-zh-CN.jpg)](../assets/screenshots/settings-memory-layers-zh-CN.jpg)

关闭是可逆的路由状态，不是删除操作。Sidebar 中对应 Tab 会保留并标记“已关闭”，页面不会读取数据面；状态、Catalog 和管理目录仍可观察。重新开启后使用原目录和原数据。

[![关闭项目档案后的实际中文 Sidebar：Tab 保留，数据不被读取或删除](../assets/screenshots/sidebar-layer-disabled-zh-CN.jpg)](../assets/screenshots/sidebar-layer-disabled-zh-CN.jpg)

WebUI 从 `memory-system` 描述符读取真实 Layer，因此扩展插件新增 Layer 时不需要修改前端枚举。设置页只提交变化 Layer 的 `enabled` 布尔值；同一次保存带 revision fence，候选运行图无法验证时，当前运行代保持不变。Kernel 内部仍按能力、触发来源和 Guard 做权威校验，但这些不是 v0.3 的普通用户配置项。

### 召回质量策略

`strict-v1` 是面向 Agent 的安全默认值：仅对明确声明为 0–1 标准化相关度的 Provider，在正文进入 Agent 前移除非正分和低于阈值的结果；随后在请求上限内保留全部高相关度结果，默认最多保留 4 条中相关度结果和 2 条无 score 或未知量纲结果，不再用较弱证据补满 limit。`balanced-v1` 把低分结果放在主要证据之后，`exhaustive-v1` 为直接检查保留有限分数结果。超出声明范围的分数按未知量纲处理，不伪造成置信度。跨 Provider 排序继续使用倒数排名融合。

策略是纯函数、受限的 Host 扩展。其他插件可在运行图创建前调用 `registerRecallQualityPolicy(policy)`，然后在配置中选择该策略 ID。非法候选上限、决策或选择会回退到 `strict-v1`；配置未知 ID 会拒绝候选运行图。过滤计数通过结构化的 `source.quality` 返回，不会拼接进 Agent hint。

### 浏览器认证

同一条无分支注册路径支持两个已验证 DSH 版本。Mnemon 始终传入 0.1.1-rc.2 所需的末尾 authority 对象；0.1.2-alpha.1 的双参数 JavaScript 实现会自然忽略它，因此无需 package 版本判断或 capability 分支。

在 DSH 0.1.1-rc.2 上，`remoteAccess` 仍是真实的启动时安全边界，不能通过 Web settings 修改。默认 `read-only` 会把设置、ZIP 备份、Provider 连接和宽泛 mutation 限制在 loopback；只有部署层已经提供可靠认证时，才可使用 `trusted-host` 将三个管理通道整体提升。DSH `trustedHosts` 只是 Host/Origin 防线，不是用户身份认证。

DSH 0.1.2-alpha.1 已移除逐方法权限层，所有 Mnemon RPC 统一经过一次性启动 token 与签名 Cookie 建立的浏览器会话。它会忽略 `remoteAccess`；该设置仅为同一插件配置安全回滚到 rc.2 而保留。两个版本中的 `writeEnabled=false` 都只是产品级只读模式，不能替代 transport 身份认证。

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

每个 DSH 工作区拥有独立的三层记忆根。对话 Agent、模型工具、命令和生命周期按当前会话的 cwd 路由；Web 发起的独立任务 Agent 则显式使用工作台选择的 Host 已登记工作区，不能提交任意路径。因此，没有选中主会话时，AI 元信息、Agent 查询、记忆沉淀和档案归档仍会写入左上角选定的工作区。

Headless 没有 `workspaceRegistry`；其新 session 的 cwd 就是启动 `dsh --profile headless ...` 的目录，因此 `workspace` 直接解析为 `<启动命令 cwd>/.mnemon`。

### 全局 USER.md 与工作区项目记忆同时生效

若要跨仓库共享用户级协作要求，同时隔离项目事实，可在设置中同时选择“工作区”与“全局用户档案”，或配置：

```yaml
mnemon:
  storageScope: workspace
  runtimeUserScope: global
```

此后每回合会把全局根（设置 `MNEMON_DATA_DIR` 时使用该目录，否则使用 `~/.mnemon`）的 `USER.md` 与 `<workspace>/.mnemon` 的 `MEMORY.md` 一起投影。`target=user` 变更和本地 USER.md 压缩只写全局事实源；`target=memory`、Documents、Memory Spaces 与 Provider state 仍留在工作区。全局 MEMORY.md 和工作区 USER.md 条目会完整保留在磁盘，但在该模式下不进入投影。

切换设置不会复制、合并或删除条目；改回 `runtimeUserScope: storage` 后，原工作区 USER.md 会重新可见。Mnemon Pack 仍表示一个所选存储根，因此工作区 Pack 不会暗中带入独立的全局 USER.md；重要的全局档案需要单独备份全局根。

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

Mnemon Native 通过 `data/<store>/mnemon.db` 与其他 Mnemon-enabled Agent 原生互操作；三方引擎通过配置的 Provider 作用域互操作。Runtime、Documents、DSH 激活状态和 UI 元数据仍属于 dsh-mnemon 管理范围。见[长期记忆 Provider](./memory-providers.md)。

第三方服务配置、记忆体范围配置与 Secret 保存在当前范围根目录的 `state/memory-providers.json`，不会写入 `settings.yaml`。服务配置由同一 Provider 的多个记忆体复用；运行时才与单个记忆体配置合并。Mnemon Native 的 ZIP 只包含 Runtime、Documents 与原生记忆体；第三方服务数据、连接凭据和本地三方 Store 不进入该 ZIP。

## CLI 发现优先级

```text
config.cliPath
  -> executable MNEMON_CLI_PATH
  -> each PATH directory
  -> Windows: GOBIN/mnemon.exe
              first GOPATH/bin/mnemon.exe, or ~/go/bin/mnemon.exe
              %LOCALAPPDATA%/Programs/mnemon/mnemon.exe
              %ProgramFiles%/mnemon/mnemon.exe
  -> Unix: ~/.local/bin/mnemon
           /opt/homebrew/bin/mnemon
           /usr/local/bin/mnemon
           /usr/bin/mnemon
```

显式 `cliPath` 会被采用；既可以填写完整路径，也可以填写 PATH 中的命令名（例如 `mnemon`）。状态检查与实际调用使用同一套发现规则，并在重新检查时识别安装或移除的 CLI，无需重启 DSH。若显式指定的命令不可执行，实际调用会返回启动错误，不会悄悄改用其他 CLI。Windows 自动发现只接受普通 `.exe` 文件；进程执行不使用 shell，因此有意排除 `.cmd` 与 `.bat` wrapper。

## 兼容 Store 提示优先级

```text
config.store
  -> MNEMON_STORE
  -> <storageRoot>/active
  -> default
```

Memory Space 目录建立后，长期语义操作使用明确的记忆体 ID，不依赖全局 active Store 进行路由。

## 后台任务 Agent 的模型路由

AI 元信息、Agent 查询、工作台/对话区的记忆沉淀和档案归档会创建一个无会话历史的独立顶层任务 Agent。它使用当前查看工作区作为 cwd；即使没有选中主 Agent session，也能落到左上角选定工作区。任务完成后 Agent 会被释放。

默认的 `inherit` 先使用 DSH“创建新会话”时的默认 Provider / Model；该路由不可用时才沿用当前可用主 Agent 的完整模型路由。设置页选择“指定模型 Provider”后，会保存完整的 Provider + Model，并只覆盖 Mnemon 后台任务，不改变对话主 Agent。独立任务 Agent 内部如需语义判断，仍可调度受限 worker；该 worker 继承任务 Agent 的模型路由。

```yaml
mnemon:
  taskAgentModel:
    mode: fixed
    provider: deepseek
    model: deepseek-chat
```

DSH 0.1.1-rc.2 会在实时模型目录中提供各模型声明的输入模态。dsh-mnemon 保留这些元数据，并为支持图片的选项标记**图片输入**；0.1.1 预发布版本线提供的第一方图片输入项是 `deepseek-official/deepseek-v4-flash-vision-exp`。选中它不代表当前 Mnemon 后台任务会摄取图片：AI 元信息、Agent 查询、记忆沉淀、智能选择与档案归档仍只提交文本和有界证据。在主对话中，dsh-mnemon 追加生命周期指引时会保留 DSH 管理的图片块及其持久 attachment 引用，活动阈值只计算文本块。原始图片字节不会复制进 Runtime、Documents 或 Memory Spaces。

## Provider 要求

普通 worker 会优先选择 `spawn`；如果没有该名称，可以选择另一个具备全部能力的 provider：

```text
outputSchema = true
toolFilter   = true
persona      = true
depthLimit   = true
```

后台审查没有回退：必须存在名为 `fork` 的兼容 provider，并且：

```text
inheritsParentContext = true
```

缺少 `fork` 不会阻止确定性状态或普通 UI 读取，但达到审查门槛时会记录 subagent 失败。

## 只读配置

```yaml
mnemon:
  writeEnabled: false
```

效果：

- 不注册模型写工具；
- 不注册 `/dsh-mnemon-write` RPC；
- `/mnemon remember` 和 `/mnemon forget` 拒绝；
- `MnemonService` 的语义 mutation 拒绝。

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

记忆系统默认使用 Sidebar：从 DSH 左侧栏打开独立主内容区工作台，使用无 Mnemon Logo 的 DSH 官方风格极简皮肤。设置 `displayMode: builtin`，或在设置页选择 Builtin，即可把同一个工作台放进当前会话的 `conversation.view` 标签页。页面、导航、弹窗和样式全部共用，不维护另一套 builtin 界面。

侧栏“记忆系统”是打开工作台的导航入口，重复点击仍保持打开；请使用“返回会话”关闭。与任务看板、SSH 切换时，同时同步面板可见性和入口状态，即使其他插件的激活通知遗漏，点击也能重新打开记忆系统。

Builtin 隐藏页眉中的存储模式标记、工作区选择和对齐控件。所有读取、写入和独立任务请求都通过现有 Host 路由跟随所属会话：

| `storageScope` | Builtin 实际读写根 |
|---|---|
| `global` | 共享 `MNEMON_DATA_DIR` 或 `~/.mnemon`，不受会话工作区影响 |
| `workspace` | 当前会话的 `<cwd>/.mnemon`；切换会话时自动跟随各自工作区 |
| `custom` | 配置的 `dataDir`，不受会话工作区影响 |

既有 `runtimeUserScope: global` 例外仍让 USER.md 保持全局。切换入口不会改变范围、迁移记忆数据或恢复旧 builtin 导航。设置 RPC 保存后实时切换入口。

规范拼写统一为 **`builtin`**。v0.4.0–v0.4.1 忽略的历史 `displayMode: buildin` 偏好会重新识别，但运行时与界面统一使用 `builtin`。Host 启动及配置外部热更新时，通过 DSH 带修订号保护的设置接口自动写回这一个字段；旧客户端 RPC 提交 `buildin` 也直接保存为 `builtin`。其他字段和配置注释保持不变，并发期间用户明确选择的 Sidebar 优先，不会被迁移覆盖。

如果旧值只来自组合 profile，迁移保存一条规范的用户设置覆盖，不直接改写 profile 文件。只读设置仍识别旧拼写，但不会绕过只读限制写盘；落盘失败会记录在 Host 日志中，不会关闭已归一化的入口。

`tabEnabled=false` 会实时移除所选入口和工作台；重新开启后恢复配置的入口位置，两种入口不会同时出现。Host RPC、命令和工具保持注册，运行中的 Agent 或命令不会因界面开关而失效。对话内的本回合记忆与存入记忆仍由 `mnemon-ui` 独立控制，并跳转到所选入口。

## Profile patch 覆盖

包内 `cordis.patch.yml` 提供默认 config 行。DSH profile 的同 ID 配置可能整体覆盖这行。不要在 profile 的最终 patch 中只增加 `cliPath`；请改用 `MNEMON_CLI_PATH` 或用户设置 `mnemon.cliPath`。确因其他原因需要自定义 profile patch 时，应保留仍需启用的全部键，而不是假设深合并。

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
