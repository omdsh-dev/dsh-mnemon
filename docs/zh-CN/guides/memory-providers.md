# 长期记忆 Provider

**简体中文** | [English](../../en/guides/memory-providers.md) | [文档中心](../README.md)

记忆空间保存 dsh-mnemon 的长期记忆，其后端是可以替换的 Provider：记忆空间契约保持稳定，Provider 负责具体数据面。**Mnemon Native 是官方优先、默认实现**；三方 Provider 是显式选择的集成，适合已经使用其他记忆引擎，或需要不同共享、提炼与召回模型的团队。

只有 Mnemon Native 需要 Mnemon CLI。缺少 CLI 时，其他已就绪的 Provider 也可以为记忆空间服务，已保存的 Provider 选择依然有效。

![插件中的记忆空间页面：Mnemon Native 与各第三方 Provider](../../assets/webui-v0.5.32/zh-CN/plugin-spaces.jpg)

每个适配器都是独立发布的 `dsh-mnemon-provider-*` 包，由 Memory Spaces Source 作为子插件安装。Starter 随附九个包，外部服务仍需显式配置后启用；不捆绑外部后端服务或 CLI。参见[官方包列表](../../../README.zh-CN.md#官方插件)和 [Provider 作者契约](../development/extensions.md)。

## Provider 能力矩阵

| Provider | 数据面 | 召回 / 浏览 | 图谱 / 关联 | 写入 | 遗忘 |
|---|---|---|---|---|---|
| **Mnemon Native** | 官方 CLI 操作本地 `mnemon.db` | 支持 / 支持 | 完整类型图谱 / 支持 | 精确写入 | 软删除 |
| **OpenViking** | 已有 HTTP 服务与 `viking://` 记忆根 | 支持 / 支持 | 投影节点 / 不支持 | 经验证的精确正文 | 仅允许精确用户 `.md` 资源的受控硬删除 |
| **Honcho** | v3 工作区 conclusions | 支持 / 支持 | 不支持 / 不支持 | 精确 Peer conclusion | 硬删除 |
| **Mem0** | Platform v3 或自托管 HTTP API | 支持 / 支持 | 不支持 / 不支持 | 异步提炼 | 硬删除 |
| **Hindsight** | Memory bank API 与知识图谱 | 支持 / 支持 | Provider 图谱 / 支持 | 异步 retain | invalidation（软删除） |
| **Holographic** | 本地原子结构化事实文件 | 支持 / 支持 | 实体/语义图谱 / 支持 | 精确事实 | 硬删除 |
| **RetainDB** | Project/User 作用域 HTTP API | 支持 / 支持 | 不支持 / 不支持 | 精确记忆 | 硬删除 |
| **ByteRover** | 本地 `brv` CLI 与知识目录 | 支持 / 不支持 | 不支持 / 不支持 | 异步 curate | 不支持 |
| **Supermemory** | Container 作用域 HTTP API | 支持 / 支持 | 投影节点 / 不支持 | 异步文档摄取 | Provider forget |

Host 只暴露适配器能够兑现的能力；UI 与 Agent 工具不会伪造缺失的图谱、关联、链接、浏览或删除语义。

<a id="服务与记忆体字段"></a>

## 服务与记忆空间字段

| Provider | 工作区行为 | 记忆空间页面中的服务配置 | 记忆空间中的实例配置 |
|---|---|---|---|
| OpenViking | 保持 Provider 全局作用域 | `endpoint`、`apiKey`、`account`、可选 `discoveryUser` | `targetUri`、`user`、`actorPeerId` |
| Honcho | 保持 Provider 全局作用域 | `endpoint`、`apiKey` | `workspace`、`userId`、`agentId` |
| Mem0 | 保持 Provider 全局作用域 | `endpoint`、`apiKey`、`mode` | `userId`、`agentId`、`rerank` |
| Hindsight | 保持 Provider 全局作用域 | `endpoint`、`apiKey` | `bankId`、`budget` |
| Holographic | 默认随工作区，可由路径覆盖 | `dataPath` | `defaultTrust`、`minTrust` |
| RetainDB | 保持 Provider 全局作用域 | `endpoint`、`apiKey` | `project`、`userId` |
| ByteRover | 默认随工作区，可由目录覆盖 | `cliPath`、`apiKey`、`defaultDirectory` | `workingDirectory` |
| Supermemory | 保持 Provider 全局作用域 | `endpoint`、`apiKey` | `containerTag`、`searchMode` |

“记忆空间”页面（在**插件 → 可组合记忆**中点击“记忆空间”）的“记忆 Provider”保存 Provider 服务配置，同一范围内该 Provider 的所有记忆空间复用它。启用或保存 Provider 时会进行权威发现，把它可见的命名空间（bank、project、workspace、user 或 container tag 等）同步进记忆空间目录，Provider 提供的标题与描述成为本地路由元数据。“**记忆空间 → 概览**”负责创建、编辑、启停与删除记忆空间，并只呈现 workspace、user、bank、container、target URI 等实例范围。Host 在调用适配器前合并两层配置。Secret 保存在 `<storageRoot>/state/memory-providers.json`，权限为 `0600`；WebUI 只以掩码表示已配置的 Secret，输入新值即可替换。

**之后新建的命名空间。** 设置保存之后才在 Provider 端新建的命名空间，无需再次保存设置也能找到。Host 开始服务一个数据目录后不久，会再询问一次每个已启用的 Provider；**记忆空间 → 概览**中的**重新发现**可以随时再问。重新发现只做添加：

- 第一次见到的命名空间以未激活状态挂载，只有你打开开关后才参与召回。
- 已挂载的空间保持原有的激活状态、名称、描述与设置；已挂载空间已经读取的命名空间不会再添加。手动创建的空间只要指向同一个 bank、workspace、user、tag、记忆 URI 或目录，就算作该命名空间，其余设置（如召回预算或单个 peer）不同也一样。
- 你断开过的命名空间（无论是发现的还是手动创建的）保持断开；重新保存该 Provider 的设置会像以前一样恢复它报告的全部命名空间。
- 出错或 30 秒内没有响应的 Provider 保留原有空间，页面会说明原因。

启动时的发现在每个 Host 进程中对每个数据目录只运行一次；只读部署、记忆空间层关闭，或其 `maintenance` 参与方式不是 `automatic` 时不运行。Honcho 与 OpenViking 只列出前 100 个命名空间。

DSH 的“工作区”模式不会统一重写所有 Provider 命名空间。Mnemon Native 自动随工作区切换；Holographic 与 ByteRover 默认使用工作区下的本地路径，但允许显式路径覆盖；其余远程 Provider 继续使用记忆空间中配置的 URI、workspace、user、bank、project 或 container，切换 DSH 工作区不会隐式改写这些身份。

## 只读空间

记忆空间可以设为**只读**。DSH 仍照常召回它，包括召回、关联、内容、实体与直接检索，但不会向它写入。这样可以让已有的命名空间（例如另一个工具也在写入的 Hindsight bank）继续可读，而新的记忆写进单独的空间。设置方法：打开空间的**编辑**对话框，在**写入**下选择**只读**。之后空间卡片上会显示**只读**。

- **不会有写入到达它的 Provider。** 存入（单条或批量）、遗忘、链接、任务 Agent 的写入、归档 MEMORY.md 或文档索引，以及合并进该空间，都会在调用 Provider 之前被拒绝，报错会写明是哪个空间。只读的 Mnemon Native 空间还会保留它的 Store：只读期间不能删除，**补齐**也不会为它生成向量。
- **未指定空间的写入。** 这类写入会进入唯一一个已激活且可写的空间。如果一个都没有，或者不止一个，写入会要求指明空间，不会退回到只读空间。如果所有空间都是只读，写满的 MEMORY.md 会归档到本地归档文件。
- **设置跟随命名空间，而不是卡片。** 为同一个 bank、workspace、user、tag、URI 或目录手动创建的空间同样是只读；重新连接、重新发现或打开开关之后，该命名空间也仍是只读。把其中任何一个空间改为可写，整个命名空间都会变为可写。如果修改某个空间的设置、让它指向另一个命名空间，它就采用那个命名空间的设置。
- **每次写入都在发生时检查。** 在设置更改之前开始的轮次也无法写入该空间。
- **设置保存在哪里。** 设置按数据目录保存在 `<storageRoot>/state/memory-provider-write-policy.json`，与 Provider 连接放在一起。Pack 和 Git 同步都不携带这个文件，恢复 Pack 或同步之后它也保持不变。这个设置只约束 DSH 自己的写入，不约束 Pack 或 Git 同步所复制的存储。
- **如果这个文件无法读取**，在修复或删除它之前，所有空间都按只读处理；召回不受影响。本版本之前的 dsh-mnemon 会忽略这个文件。

## Provider 视图与厂商插件

Provider 在记忆之外还保存了其他内容时，空间卡片上会出现**浏览**。它以标签页打开 Provider 的视图，通过空间自己的连接读取，视图中不做任何写入。OpenViking 提供三个视图：

- **viking:// 层级**：该空间用户的目录，以及账号的 `resources` 和 `agent` 目录，附带服务端保存的摘要。点开文件可以预览：文本，或不超过 2.5 MB 的图片。
- **资源**：服务端或 OpenViking 官方插件保存在 `viking://resources` 下的内容，例如图片与附件（#453），附带服务端为每项生成的摘要。
- **服务端改动**：OpenViking 的记忆抽取新增、更新或删除了什么，每个已提交的会话一项，最新的在前，展开可看改动前后。它读取服务端保存在每个会话归档旁的 `memory_diff.json`，范围是最近 20 个会话。

**OpenViking 官方插件。** 当 `@openviking/dsh-memory-plugin` 在同一个 DSH 配置中运行时，OpenViking 空间的卡片会写明它的版本以及是否自动捕获，**浏览**中显示完整信息：自动召回、自动捕获、是否跳过任务 Agent 会话、连接到哪里（不含凭据），以及那是否就是该空间自己的命名空间（同一服务端、账号与用户）。dsh-mnemon 只读取插件报告的自身状态，从不改动插件：它的工具对模型照常可见，技能、召回与捕获都按 OpenViking 的设计运行，配置保持原样。

**在它旁边把空间设为只读。** 当插件会自行把内容捕获进该空间自己的命名空间时，同一条记忆可能被存两次：一次来自插件的捕获，一次来自 dsh-mnemon。此时卡片和**浏览**会建议把空间设为对 dsh-mnemon 只读，让插件的捕获成为那里唯一的写入方，dsh-mnemon 仍照常召回该空间。只有按下**设为只读**才会改动，它设置的是上文所述的空间写入策略；在**编辑**中可以改回。插件关闭了自动捕获、连接到另一个命名空间或没有说明连接到哪里，或者空间已经只读时，不会出现这条建议。

## 手动与智能选择

手动模式保留原工作流：创建记忆空间、选择一个引擎、完成配置，之后仍使用同一套检索、内容、实体和沉淀入口。

智能模式从用户勾选的候选建立 allowlist：

1. Host 先强制执行数据边界与必需能力；
2. 只剩一个合格 Provider 时，由规则确定性选择；
3. 有多个合格候选时，独立任务 Agent 结合路由说明、软偏好和用户策略 Prompt 判断；
4. Host 再验证结果属于合格集合，并保存选择来源、理由、置信度与候选 ID。

连接凭据永远不会进入 selector Prompt。`local-only` 会在模型选择前排除全部远程 Provider。Mnemon CLI 可用时，Mnemon Native 始终是本地候选。

## 运维边界

- OpenViking 使用 `content/write`、`mode: "create"`、`wait: true` 创建新的 `.md` 文件，只发送 0.4.16 至 0.5.2 各版本都声明的四个字段（各版本都会拒绝其他字段，0.5.1 起去掉了 `timeout`），然后用 `content/set_tags` 设置来源、分类与重要度标签；服务器无法设置标签、或 5 秒内未确认时，已验证的记忆仍然保留，回执中 `tagsApplied` 为 `false`。分类分别映射至 `preferences`、`experiences`（insight/decision）、`events`（context）或 `entities`（fact/general），文件名以 `_<分类>-<uuid>.md` 结尾，因此读回的分类与写入时一致。文件名不含分类的文件（旧版本写入的，或 OpenViking 自己写入的）按所在文件夹读回：`preferences` 为 preference，`experiences` 为 insight，`events` 为 context，`entities` 为 fact。未知分类按 `general` 保存。服务器拒绝的写入（HTTP 4xx，408 与 409 除外）会报告为未保存。只有 URI、字节数、向量索引完成状态和公开完整正文读回均匹配时才返回 stored；记忆文件的语义处理状态允许为 `skipped`。召回与浏览读取完整正文，不把摘要当作原文；这些写入不再使用会话抽取或 LLM 提炼。
- 在**直接检索**或 **Agent 查询**中选择**关键词检索**策略，或以 `mode: "keyword"` 调用 `mnemon_recall` 时，OpenViking 通过精确文本接口 `search/grep` 检索（#452）；Agent 查询的任务 Agent 根据这些结果作答。查询按空白分成若干词，只查前 8 个。用双引号（直引号或弯引号）括起的短语算一个词，且只在记忆的同一行内匹配。词尾表示句子结束的标点会去掉，所以 `fleet-777?` 查的是 `fleet-777`。`a`、`5` 这样的单字符词只在查询没有其他词时才计入，单个汉字或日文字符则总是计入。每个词都按字面、忽略大小写匹配，但不从数字或单词的中间匹配：数字不能紧挨数字，以空格分词的文字中字母不能紧挨字母。因此 `29.8.5` 不会匹配 `29.8.50`，`fleet-04` 不会匹配 `fleet-042`，`кот` 不会匹配 `который`，而 `5.2.2` 能匹配 `v5.2.2`，`3.12` 能匹配 `Python3.12`。中文、日文等不以空格分词的文字可在任意位置匹配。同时含数字和字母、至少 7 位的十六进制 ID 按开头匹配，因此 `9f86d08` 能找到 `9f86d081884c…`，但不会从更长 ID 的中间匹配。
- 包含更稀有的词、包含的词更多的记忆排在前面。包含相同词的记忆中，Mnemon 最后写入的排在前面，因此更新排在被它取代的记忆之前；文件名不带时间的文件（例如 OpenViking 自己写入的）按服务器返回的顺序排在其后。返回读回的完整记忆，结果不带分数。先用一次 grep 查全部词：它最多返回 256 行匹配，按文件名顺序遍历文件，对 Mnemon 写入的文件即从旧到新；这次 grep 装满时，再为每个词各执行一次 grep，常见词因此挤不掉稀有词。某个词自己的 grep 也装满时，结果会指出这个词：此后的记忆可能缺失，换用更稀有的词即可找到。grep 装满之前会读取空间中的每个记忆文件，0.5.1.1 还用 Python 读取并先去掉其中的元数据，因此空间越大，关键词检索越慢。在 0.5.1.1 上，一次 grep 读 64 条记忆用时 9 ms，读 512 条用时 47 ms。智能召回与基础匹配仍为语义检索。没有 `search/grep` 的服务器（返回不指明资源的 404 或返回 405）会以语义检索回答关键词检索，并说明这一点；其他 grep 错误会如实报告。
- OpenViking 服务须支持上述正文 API；可选集成测试在正式发布的 0.4.16、0.4.20、0.4.21、0.5.0 与 0.5.1.1 后端上均通过。0.5.1 起，服务器会在每个记忆文件末尾追加保留的 `MEMORY_FIELDS` 尾注，并把它计入 `written_bytes`；精确读回仍须返回所请求的原文。默认通过 Admin API 发现，需配置 `account` 与能枚举该账号用户的 key。没有 admin 权限的 user key 可在 `endpoint`、`apiKey`、`account` 之外填写 **User Key 所属用户（跳过 Admin）**（`discoveryUser`）。这会显式选择 `viking://user/<discoveryUser>/memories`，通过只读 `GET /api/v1/fs/ls` 验证后同步一个空间。此模式不发送 account/user 身份请求头，由服务端从 key 解析身份；`account` 标识本地映射，不能覆盖 key 所属租户。账号和用户标识应向服务管理员获取。根目录不存在、访问被拒或响应无效时拒绝保存并保留原配置；不会只凭 health 成功保存，也不在 admin 错误后自动降级。云服务可用性与写入权限需要另外验证，确定性测试不代表真实云账号认证。参见上游[身份验证](https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/04-authentication.md)与[托管服务入门](https://github.com/volcengine/OpenViking/blob/main/docs/en/getting-started/02-quickstart.md)。
- 已有显式 `viking://user/<user>/memories` 根保持有效；旧 `viking://user/memories` 通过已配置 `user` 展开，未配置时使用经过身份验证的 system-status 用户信息。user-key 发现使用显式所属用户，拒绝不匹配的空间用户。拒绝危险路径成分以及所选用户根以外的删除。注册表格式不变；降级前用当前版本清空 `discoveryUser` 并使用具有 admin 权限的配置，或禁用服务并恢复兼容配置。远端记忆保持不变。
- OpenViking 错误、索引未完成和超时不会返回已提交回执。远端文件可能已经存在，错误会附带请求 URI，重试前应检查该文件；不自动回退到抽取或重试。经过验证的回执包含精确文件 `id`，使 Host 能在后续本地归档失败时只删除本次新建索引。结果不明的远端写入保留待检查。升级或回退适配器均不会删除已有远端文件；降级会恢复旧写入方式，它把标签放在写入请求里，因此需要 OpenViking 0.4.18 或更高版本。
- WebUI 不直接调用远程服务或本地 CLI；Provider I/O 都留在 Host，统一具备取消、超时、进程输出上限和 shell-disabled 参数执行。
- “断开”三方记忆空间只删除本地目录登记，不删除底层数据。单条记忆的“遗忘”是另一项按能力开放的操作。
- Holographic 是对本地结构化事实语义的 TypeScript 适配，使用原子 JSON 存储，并保持独立的数据格式与生命周期实现。
- Hindsight 使用轻量存活检查，并从 Provider 的 bank stats、实体目录与图谱响应读取真实统计、实体和关系；旧版缺少统计接口时仍可使用召回与图谱表面。
- ByteRover 只开放聚焦的 `status`、`query` 与 `curate`；不会虚构广域知识树浏览和删除能力。
- Supermemory 的浏览结果合并已抽取 memory entries 与仍可浏览的 ingested documents，并按 Provider ID 去重；文档未完成抽取时也不会从“内容”页消失。
- Mnemon Native 会记录使用。Agent、`/mnemon recall` 或 **Agent 查询**发起的召回，会把查询写入存储的操作日志（`mnemon log`，保留最近 5,000 条操作），并把返回的记忆计为已访问；Mnemon 的保留策略会参考访问次数（`mnemon gc` 不会建议清理访问过三次的记忆）。记忆系统自身的检索（记忆空间页上的**直接检索**和实体页上的**查找相关记忆**）改为用 `mnemon --readonly` 读取快照，与它的列表和图谱一样，不做任何改动。Host 归档时核验自身写入的检查读取实时存储，因为其他进程写入期间，快照不一定与存储一致。
- Mnemon Pack 包含 Mnemon Native 记忆空间、运行时与档案；三方连接、凭据、本地三方 Store 与远程数据都不进入 Pack。
- 外部产品的可用性、价格、隐私、保留策略和许可证由各自运营方决定。把私有记忆发送给远程 Provider 前应先评估这些边界。

来源归属与许可证边界见[第三方声明](../../../THIRD_PARTY_NOTICES.md)。
