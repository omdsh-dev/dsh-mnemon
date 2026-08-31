# Sidebar 与对话交互指南

**简体中文** | [English](../en/ui-guide.md) | [文档中心](./README.md)

本指南按 Sidebar 优先体验和真实用户路径编排。可选 Builtin 入口把同一个工作台嵌入会话，不恢复旧 builtin 布局。兼容工作流截图来自 v0.2.0 的 1600×900 实机页面，v0.3 的 Layer 控制保留明确标注版本的历史截图；[展示位置设置截图](../assets/screenshots/settings-entry-placement.png)展示 issue #139 本地实现恢复的选项。名称、数量和内容会随本地数据变化。

## 先看一次完整操作

[![dsh-mnemon v0.2.0 记忆系统实机演示封面](../assets/media/dsh-mnemon-memory-system-demo-poster.jpg)](../assets/media/dsh-mnemon-memory-system-demo.mp4)

[播放 1600×900 MP4](../assets/media/dsh-mnemon-memory-system-demo.mp4) · [打开 GIF](../assets/media/dsh-mnemon-memory-system-demo.gif)

约 55 秒录制在页面切换、弹窗、按钮状态变化和 Agent 答案上保留了明确停顿，并包含：四个一级页的整体上下滑动、活跃/归档切换、Provider 内容筛选与取消、创建与策略弹窗、AI 元信息多选、后台任务模型路由切换，以及一次真正完成的只读 Agent 查询。所有可能改变数据的确认动作都停在提交前。

## 交互心智

侧栏“记忆系统”始终打开工作台，从任务看板或 SSH 返回时也一样。重复点击保留当前页面；关闭工作台请使用“返回会话”。

设置 `displayMode: builtin` 后，改从会话的标签页打开“记忆系统”，侧栏入口不再出现。Host 自动将该会话映射到全局、工作区或自定义存储，所以页眉不显示存储模式和工作区选择控件。下述页面与弹窗全部共用，对话快捷入口也会打开对应标签页。详见[范围映射](./configuration.md#入口位置displaymode-与-tabenabled)。

一级页始终按**状态、运行时、档案、记忆体**排列。记忆体内部再分为**概览、检索、内容、实体**，右上角保留“沉淀记忆”和“沉淀策略”。

| 看到的动作 | 点击后发生什么 | 是否启动独立任务 Agent |
|---|---|---|
| 刷新状态、立即同步、点击记忆体卡片重连 | Host 异步读取；当前区域右上角或卡片状态灯显示一个转圈 | 否 |
| 直接检索、浏览内容、查看实体 | 并发调用 Provider 原生只读能力，结果到达即展示 | 否 |
| Agent 查询 | 先召回，再把有界证据交给无会话历史的顶层任务 Agent | 是，只读 |
| 沉淀记忆 / 存入记忆 | 先弹出可编辑确认，再判断价值、查重、提炼、选路与写入 | 确认后启动 |
| AI 维护元信息 | 每个记忆体独立快速采样并异步生成，失败只留在对应卡片 | 是，每个记忆体互相隔离 |
| 归档 | 先建立可检索冷引用，再由 Host 移动原文 | 确认后启动 |

## 1. 状态：先判断系统是否可用

[![状态页：dsh-mnemon、Mnemon Native 与三方 Provider 状态](../assets/screenshots/status-overview.png)](../assets/screenshots/status-overview.png)

最上方“记忆引擎”只展示 dsh-mnemon。Mnemon Native 的异常进入独立状态栏，三方 Provider 在下面逐项显示启用、健康和连接信息，不会把局部异常提升成整个系统故障。

页面采用渐进式并发加载；正在读取时只保留一个区域级转圈，已经返回的数据立即可见。这里同时汇总运行时、档案、记忆体、存储根以及 dsh-mnemon / Mnemon 版本。

### 检查版本

[![检查 dsh-mnemon 与 Mnemon 版本](../assets/screenshots/version-check.png)](../assets/screenshots/version-check.png)

“检查更新”只读取，不会自动安装。支持的安装来源出现新版本时才展示更新动作；更新 dsh-mnemon 后需要重启 `dsh web` 才能加载新代码。

## 2. 运行时：维护每轮都需要的热记忆

[![运行时容量、筛选与统一记忆卡片](../assets/screenshots/runtime-memory.png)](../assets/screenshots/runtime-memory.png)

顶部汇总用户档案（`USER.md`）和工作记忆（`MEMORY.md`），下方用统一卡片展示具体条目。可以按来源、文本、分类和重要性筛选；再次点击已选筛选不会破坏页面。超长字段在自己的块内省略，悬停显示全文。

[![添加运行时记忆](../assets/screenshots/runtime-memory-add.png)](../assets/screenshots/runtime-memory-add.png)

运行时条目应紧凑、独立、反复有用。身份、偏好和协作要求放用户档案；项目事实、环境、决策和工具经验放工作记忆。临时进度和原始日志不适合这一层。

工作记忆条目可带可选的分支范围（新增和编辑表单里用逗号分隔的 git 分支名）：带范围的条目显示分支徽标，只在会话 workspace 处于所列分支上时投影进模型上下文；留空则该条目在所有分支可见。分支范围不影响本页展示，也不影响磁盘上的 `USER.md`/`MEMORY.md` 投影。

## 3. 档案：保留完整项目叙事

[![档案目录、容量摘要与 Markdown 阅读器](../assets/screenshots/documents-markdown.png)](../assets/screenshots/documents-markdown.png)

左侧活跃/归档目录可切换；选中条目后重复点击仍保持选中，不会关闭右侧阅读器。右侧保留标题、检索说明、来源、revision、哈希、文件大小与完整 Markdown，切换档案时自动回到顶部。

达到 active 容量上限前，最久未使用的档案会先通过独立任务 Agent 建立 Mnemon 冷引用；Host 验证成功后才迁入 archived。失败或 revision 冲突保留 active 原文。

[![创建托管档案](../assets/screenshots/document-create-dialog.png)](../assets/screenshots/document-create-dialog.png)

标题与检索说明决定未来是否容易找到，来源路径用于追溯，正文保留 Markdown 结构。项目源文件始终只读；工作台创建受管副本。

## 4. 记忆体：统一管理可替换的第三层

### 概览与实时快照

[![快照可观察范围与多记忆体实时关系图](../assets/screenshots/overview-memory-graph.png)](../assets/screenshots/overview-memory-graph.png)

实时快照从上到下分两层阅读：

- **快照可观察范围**中的每张卡片都对应一个已激活记忆体，并先声明 Provider 真正提供的读取表面、投影方式与可观察数量。`真实关系图`、`内容投影`、`仅查询`是能力边界，不是质量等级；
- **多记忆体实时快照**把这些可读取结果合并到同一张关系图。边的颜色表示空间归属、时间、语义、因果或实体关联，Provider 与记忆体标签则保留来源；
- 图谱左下角汇总空间、记忆和实体总数，右下角显示当前渲染的元素与连接。类似 `60 / 129` 表示为保持交互流畅而展示的视窗，不表示其余数据丢失；
- 点击记忆体、实体或记忆节点后，右侧检查器展示该元素的精确上下文。自然铺开、拖拽和均匀重置只改变布局，不改写 Provider 数据。

每张卡片对应一个真实记忆空间。Provider 标签只用颜色区分，不在标签内重复放图标；`Mnemon Native` 在目录统一展示为 `mnemon`。卡片点击区域用于按需重连当前 Provider + ID，状态灯在重连期间原位变成同尺寸转圈，不触发全量同步。

首次进入概览执行一次全量同步；之后只按需同步。右上角保留“立即同步”，旁边显示距离上次全量同步的时间。

“快照可观察范围”先说明每个记忆体真实支持的读取表面，再生成多记忆体实时快照：

- Mnemon Native 提供完整类型关系；
- Hindsight 与 Holographic 贡献各自的真实图谱；
- 没有边的 Provider 只贡献内容投影；
- ByteRover 等查询型 Provider 等待明确查询。

页面不会伪造 Provider 不具备的关系、实体、删除或浏览能力。

### 手动创建记忆体

[![创建记忆体：分行信息与 Provider 选择](../assets/screenshots/memory-space-create-dialog.png)](../assets/screenshots/memory-space-create-dialog.png)

手动点击“创建记忆体”时始终由用户明确选择 Provider。只列出设置中已经启用的服务；Provider 特有字段按分行结构展示，避免横向对齐误差。创建完成后，该实例才进入目录、激活和检索工作流。

### 沉淀策略：人工指定或智能选择

[![沉淀策略：人工指定与智能选择](../assets/screenshots/distillation-strategy.png)](../assets/screenshots/distillation-strategy.png)

沉淀策略影响后续 Agent 写入目标，不改变“创建记忆体”这个人工动作：

- **人工指定**：由高级选项或现有范围明确目标；
- **智能选择**：数据边界和能力要求是硬规则，本地/共享倾向和 Prompt 是软策略；只有多个候选都合格时才调用任务 Agent。

回执保留决定来源、置信度和理由，Provider 凭据不会进入模型上下文。

### AI 维护元信息

[![AI 维护元信息：跨 Provider 多选与独立异步任务](../assets/screenshots/ai-metadata-dialog.png)](../assets/screenshots/ai-metadata-dialog.png)

可多选已激活记忆体。每个任务先调用对应 Provider 最快的原生查询方式读取少量样本，再按 system prompt 的长度和能力约束生成 title / description。任务互不共享状态；一个失败只在自己的卡片显示错误。如果模型生成的标题或说明未通过本地长度校验，该卡片会保留原有元数据，同时其他合法结果仍会更新。生成过程不关闭弹窗，卡片向右播放同色调刷新动画并原位更新。

人工生成的标题与说明属于本地目录元数据，普通重连不会覆盖；关闭 Provider 会清理映射和元数据，重新启用后从 Provider 重建，映射不到的字段用最近似默认值补充。

### 沉淀记忆

[![沉淀记忆：候选内容与人工高级约束](../assets/screenshots/remember-dialog.png)](../assets/screenshots/remember-dialog.png)

默认只需填写候选内容。点击确认后，独立任务 Agent 判断是否值得保存、选择最窄记忆体、查重、提炼并写入。“人工高级选项”只用于确实需要约束目标记忆体、分类或重要性时。

### 检索与 Agent 查询

[![真实 Agent 查询结果与多 Provider 检索范围](../assets/screenshots/recall-agent-answer.png)](../assets/screenshots/recall-agent-answer.png)

- **直接检索**返回原始证据，不启动 Agent；
- **Agent 查询**使用相同证据，再启动 evidence-only 顶层任务 Agent 组织答案；
- 各 Provider 并发返回，单个连接失败不隐藏其他来源；
- 跨 Provider 排序使用排名融合，同时保留原始分数、ID、记忆体、Provider 与分类；
- 只有 Provider 真正支持时才显示关联、链接、浏览和遗忘动作。

具体问题通常比宽泛关键词更可靠。

### 内容与实体

| 内容 | 实体 |
|---|---|
| [![记忆内容、Provider 筛选与加载更多](../assets/screenshots/memory-content.png)](../assets/screenshots/memory-content.png) | [![真实实体索引与相关记忆](../assets/screenshots/entities-context.png)](../assets/screenshots/entities-context.png) |

内容页区分可枚举、仅查询和不可浏览；Provider 标签既可点击筛选，也可再次点击取消。实体页只聚合真实实体索引，目前包括 Mnemon Native、Hindsight 与 Holographic；普通文本不会被伪装成实体能力。

## 5. 设置：服务配置与记忆体实例分开

[![记忆系统设置：显示、范围、Provider 服务与备份](../assets/screenshots/settings-memory-system.png)](../assets/screenshots/settings-memory-system.png)

设置页只管理可复用的**服务配置**：

- 记忆层卡来自运行中的 Catalog；Runtime、Documents、Memory Spaces 各有一个总开关，没有额外的参与模式选项；
- 每个三方 Provider 都有独立开关，默认关闭；
- 打开后才展示 endpoint、API Key 和 Provider 特有字段；
- API Key 使用经典 password 输入，眼睛按钮在显示/隐藏之间切换；不再使用“清除凭证”checkbox、“移除”独占行或“已安全保存”提示；
- 保存只更新服务配置，不在设置页等待完整发现或检索；健康监控放在状态页，记忆体发现放在概览；
- 全局 / 工作区 / 自定义标签显示当前有效范围；支持相同范围语义的 Provider 复用 Mnemon 的配置框架。
- 用户档案范围可独立选择：“全局用户档案”会组合全局 USER.md 与工作区/自定义 MEMORY.md，不移动任何事实源。

下面是隔离安装的 `dsh-mnemon@0.3.0` 实际设置页。三个默认 Layer 各自只有一个总开关；“已开启”表示允许系统按需使用，并不表示每回合强制 Recall。

[![v0.3 实际设置页中的运行时记忆、项目档案与记忆体总开关](../assets/screenshots/settings-memory-layers-zh-CN.jpg)](../assets/screenshots/settings-memory-layers-zh-CN.jpg)

Mnemon 自己的自定义目录、备份与迁移留在 Mnemon 专属折叠区。自定义本质上是显式路径的全局范围。

### Mnemon Native 嵌入桥接

[![隔离的最新代码 Web profile 中，由 DSH 管理的 Mnemon 嵌入 Endpoint、模型与成功状态检查](../assets/screenshots/settings-native-embeddings.jpg)](../assets/screenshots/settings-native-embeddings.jpg)

开启“由 DSH 管理嵌入配置”后，保存的 Ollama Endpoint 与模型会成为 Mnemon 子进程的权威值，也适用于无法继承 shell 启动文件的 Desktop 启动方式。Endpoint 会拒绝凭据、查询参数与片段，界面同时说明记忆与查询正文会被发送到该服务。“测试状态”只检查已保存的运行值，不会把未保存草稿误报为生效；上面的隔离 profile 通过 Mnemon v0.2.5 显示连接成功与空数据覆盖率，未包含凭据或个人记忆。

关闭 Layer 不删除数据。Sidebar 中对应 Tab 保留并标记“已关闭”，点击后显示可逆停用说明而不读取数据面；重新开启后原数据恢复可用。扩展贡献的新 Layer 首次出现时默认关闭；保存前当前运行代继续服务，候选配置验证失败也不会产生半切换。

[![实际关闭项目档案后，Sidebar 保留“档案”Tab 并显示可逆停用说明](../assets/screenshots/sidebar-layer-disabled-zh-CN.jpg)](../assets/screenshots/sidebar-layer-disabled-zh-CN.jpg)

### 后台任务 Agent 模型路由

[![后台任务 Agent：跟随主链路或指定 Provider 与模型](../assets/screenshots/settings-task-agent-routing.png)](../assets/screenshots/settings-task-agent-routing.png)

“跟随主链路”使用 DSH 新建 session 的默认模型；“指定模型 Provider”保存完整 Provider + Model 路由。这个设置只影响 AI 元信息、Agent 查询、沉淀记忆、智能 Provider 选择和档案归档，不改变当前主会话模型。推理强度由所选模型 Provider 能力与 DSH 路由支持共同决定。

在 DSH 0.1.1-rc.2 中，模型能力会进入该选择器。支持图片的路由会显示**图片输入**标记，包括第一方 `deepseek-official/deepseek-v4-flash-vision-exp` 模型。该标记表示模型能力；当前 Mnemon 后台任务仍只发送文本 Prompt。

开关、单选项与眼睛按钮都允许重复点击；即使点击当前已选值，也不会让设置页卸载或白屏。

## 6. 对话内交互

### 本回合记忆

只有已经完成且发生记忆活动的回合才显示。“本回合记忆”可以重复展开/收起；展开后列出具体工具，点击工具名跳转到对应检索、内容、实体或档案页面。

### 存入记忆

“存入记忆”位于已定稿回复的原生操作区。首次点击只读取这条回复并打开可编辑弹窗；取消不会产生任何写入。只有“确认并交给独立任务 Agent”才开始沉淀流程。

两项默认开启，可在**设置 → 记忆系统 → 对话界面**分别关闭，保存后即时生效。

## 工作区模式：查看与执行分离

| 概念 | 由什么决定 | 影响什么 |
|---|---|---|
| **查看工作区** | 工作台顶部选择器 | 当前页面展示与人工维护哪套 `<workspace>/.mnemon` |
| **执行工作区** | 当前对话 / Agent 的 cwd | 对话工具、命令与生命周期使用哪套目录 |

可以留在项目 A 对话中查看项目 B：对话 Agent 仍使用 A；从工作台发起的 AI 元信息、Agent 查询、沉淀和档案归档会启动独立任务 Agent，并显式使用查看工作区 B。没有选中主 session 时也可以正确执行。

远程 Provider 的 workspace、user、bank、project、container 和 URI 是独立命名空间，不会跟随 DSH 工作区被隐式改写。`global` 与 `custom` 只有一个明确根，不需要查看/执行对齐。

## 常见规则

- 蓝色实心表示主动作；蓝色描边通常用于编辑；红色只用于删除、断开、归档或遗忘；中性按钮用于查看、复制和取消。
- 记忆体开关只决定它是否参与 dsh-mnemon 读取路由，不等于 Mnemon CLI 默认 Store。
- Mnemon Native 物理删除需要二次确认；三方记忆体使用“断开”，不删除 Provider 数据。
- 页面按区域异步加载；局部错误不阻塞其他区域，也不会堆叠多个转圈。
- 工作台默认从 Sidebar 打开，Builtin 将相同界面放进所属会话；本回合记忆和存入记忆仍作为对话内快捷入口。

下一步：[能力地图](./capabilities.md) · [快速开始](./getting-started.md) · [Provider 指南](./memory-providers.md) · [配置参考](./configuration.md)
