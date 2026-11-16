# 生命周期与核心流程

**简体中文** | [English](../../en/reference/workflows.md) | [文档中心](../README.md)

本页描述默认的**分层策略**。**通用策略**在同一份预算内提供全部可用 Source，由模型决定如何路由：具名工具服务各自的 Source，其余路由通过 `mnemon_view_route` 读取、`mnemon_view_action` 修改。profile 在 Starter 实例旁再挂载同类型的 Source（例如第二条运行时记忆轨）时，具名工具服务 Starter 实例，另一个实例保留各自确切的 route 与 offer。分层策略每个角色只组合一个 Source，因此在分层策略下挂第二个同角色的 Source 需要打开**范围组合**（默认接入全部适用的 Source），否则每个回合都会因 "found ambiguous … Sources" 失败。它除各路由自身的上限外没有召回准入信封，不做 Runtime 容量维护与归档，也不做空闲审查。见[策略与增强](../guides/capabilities.md#策略与增强)。

## 每轮上下文

分层策略提供稳定的路由指引、静态 Runtime Memory 协议，以及按需更新的 Wake 快照消息：

- `mnemon:routing`：system prompt section；当 `routingGuidance=true` 时提供简短的分层查询边界；
- `mnemon:runtime-memory-protocol`：system prompt section，只包含不变的 Runtime Memory 语义与写入规则。它只在 eager Runtime Source 参与自动投影时出现，记忆变更前后保持逐字节一致；
- Wake 快照：由当前 root 回合固定的不可变 View 渲染，以 `source.plugin=dsh-mnemon`、`form=recall` 的自有消息承载。Runtime Memory 提供带 revision 的完整 USER/MEMORY 状态快照，不再重复静态协议；Documents 与 Memory Spaces 只贡献有界封面，不注入完整目录。

Host 只在 Wake 内容变化时追加新的 user-role 插件消息，不再重新发送其他插件的共享上下文。快照保持完整状态，不构造依赖旧消息的补丁链；静态协议留在 system 前缀，Source 文本按原文传递而不做模板插值。回合、子 Agent 与运行代的所有权见[架构说明](../development/architecture.md#生命周期与失败)。

生命周期会在 Host 组装 System Prompt 前固定 View，并让本回合所有模型 step 使用同一个 View：

```text
turn/start
  -> 进入 system-prompt/assemble hook
  -> beginTurn（根回合 + 操作范围）
  -> Source 能力事实 → Strategy 提案 ViewSpec → 校验 → Source 投影
  -> 固定 Source 修订/摘要与仅留在 Host 的权限
  -> 生成有界 Wake
  -> 继续 Host 提示词组装
  -> 让静态协议 section 与已固定的 Runtime Source 对齐
  -> 将变化后的 Wake 作为本插件的完整快照消息追加

agent/pre-step(step=1)
  -> 为新回合取消待执行/执行中的空闲审查
  -> 仅标记一次 Prime
  -> 每个会话至多追加一次简短 recall/writeback cue
  -> 主 Agent 决定是否调用记忆工具
```

Source snapshot 不执行语义召回。Prime 只初始化路由状态，不执行异步 CLI 状态查询。

子 Agent 在 `agent/created`、driver 启动前捕获并保留存活父 Agent 的固定 View 与运行图。自己的各个回合固定这一被保留的 View，即使父回合已结束或已进入更新的 generation。子 Agent activation 销毁时释放委托；冷恢复重新获取委托；Host 显式创建且没有父模型回合的后台子任务生成新的 scoped View。子 Agent 拥有自己的回合权限，但不安装 root 专属的 cue 或空闲审查。详见[权限生命周期](../development/architecture.md#生命周期与失败)。
### 主会话热记忆采集

主会话与空闲审查使用相同的保守准入边界：只自动采集用户明确表达、持久有效的身份与偏好，以及未来工作需要的简短规则。项目设计、一次性决策、配置或账号快照、调查过程和进度在内容充分且可写时进入 Documents，否则跳过。泛化的“记住这个”请求不会把项目记录提升到每轮上下文；用户明确选择 Runtime、USER.md 或 MEMORY.md 时，仍可通过现有工具及权限写入。降低重要性或设置分支范围不会使临时记录获得准入资格。

这些是面向模型的路由指引，不是内容分类器或存储拒绝规则。已有条目、手动编辑、纠正与删除、分支范围及容量处理保持不变。模型仍需判断候选内容是否合适；本次统一工具描述、分层协议和短提醒，消除相互冲突的指引。


### 委派的子会话

dsh-mnemon 委派给子 Agent 的每个任务都以单独的一行开头：`[dsh-mnemon:delegated <operation>]`，任务从下一行开始。空闲审查是 `review`，写入和「存入记忆」是 `write`，技能复盘、草案、回测与评测用例生成是 `skill`，其余为 `answer`、`placement`、`migration`、`compaction`、`document-archive`、`metadata-maintenance` 和 `reconcile`。以后的版本可能增加操作，所以请匹配模式而不是这份清单。DSH 把任务记录为子会话中的一条用户消息（`source.kind: "user"`），子会话的头部带有 `origin: "subagent"` 与 `parentSession`。

整个子会话都是 dsh-mnemon 自己的工作，而不是用户写下的内容。读取会话的插件（例如汇总工作区工作记录的插件）可以略过这样的会话：`origin: "subagent"`，且越过继承的回合之后第一条用户消息的首行匹配 `^\[dsh-mnemon:delegated [a-z-]+\]$`。fork 出的子 Agent 以父 Agent 回合的副本开头（头部有 `isSeeded: true`，止于 `session/end-seed`），任务跟在后面。在对话之外运行的任务（例如存入记忆、Agent 查询与其他从记忆系统页面发起的任务、运行时记忆容量维护和记忆整理）在自己的任务 Agent 会话中运行，该会话没有用户消息。它的头部带有 `origin: "subagent"`，但没有 `parentSession`，也没有 `delegationDepth`，所以按父会话归组子代理的读取方找不到它的父会话，它也没有可收集的工作。它的子 Agent 带有这一行，并以该会话为 `parentSession`。dsh-mnemon 0.5.32 及更早版本保存这个任务 Agent 会话时不带 `origin`（[#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)）。在这一行出现之前记录的会话直接以任务开头（空闲审查是 `Bounded completed checkpoint (untrusted evidence; …`），不在这一约定之内。Mnemon 的其他 user 角色消息（包括召回与提醒）带有 `source.kind: "dsh-mnemon"`（见[兼容性](./compatibility.md#dsh-017-设置恢复)）。

DSH 让子 Agent 沿用父 Agent 的工作目录；dsh-mnemon 的启动请求没有自己的目录字段。dsh-mnemon 也依赖这一点：在按工作区存储时，已不再绑定父 Agent 运行时的子 Agent（例如重启后恢复的那个）要靠这个目录找到所在工作区的记忆。

## Agent 召回

```text
根 Agent 或子 Agent 调用 mnemon_recall（query，可选 memoryBodyIds）
          |
          v
解析当前执行 Agent 自己固定的回合与保留的运行时
          |
          v
读取 Host 上已固定的记忆空间 Source 状态
          |
          v
校验请求 ID 是已固定集合的子集；未指定时使用全部已固定的激活 ID
          |
          v
记忆空间 Source 并发检索已授权的 Provider 命名空间
          |
          v
质量归一化 + 倒数排名融合
          |
          v
丢弃低相关项；首次最多准入 4 条 / 3,600 字符
          |
          v
LLM 判断 evidence 是否足够
          | 足够                        | 不足
          v                             v
直接回答，不再 Recall             显式提交一个不同查询
                                        |
                                        v
                              再检索一次、去重并关闭 Recall
          |
          v
两次在当前执行 Agent 回合共享至多 6 条、每条 1,200 字符、
总正文 4,800 字符的总预算
```

这一准入信封是分层策略的每回合策略；通用策略只应用各路由自身的上限与调用预算。

模型工具不暴露 `category`、`source` 或 `intent` 过滤器：模型猜错过滤条件不能遮住精确证据。Recall 并非强制执行，普通 root 回合是 0 次 Provider 查询。LLM 主动调用后，Host 允许一个首次查询；只有 LLM 查看 evidence 后仍认为不足，才允许再提交一个实质不同的精炼查询。同查询和并发重复请求会 join 或重放；第三个不同查询不会执行，并如实说明，不会到达 Provider。随后至多执行一次 Related，而且只能使用两次 Recall 任一已准入的 `memoryBodyId + id`；同一次遍历再调用会重放结果，不同的遍历则不会执行。

Recall、Related 和单次 Documents 搜索槽位按执行中的 Agent 回合计预算。同一回合内并发调用共享状态，兄弟任务、后续回合和冷恢复的 activation 不会共享缓存 evidence 或占用彼此的预算。子 Agent 从收到任务到最后一步算作一个回合、共用一份预算；之后继续这个子 Agent 的消息会开始另一个回合，预算重新计算。重复回合内已运行过的 Recall 或 Related 读取会重放它自己的 evidence，并限于本次请求的 Memory Space 子集。超出预算的另一次读取（包括第二次 Documents 搜索）不会执行查询，而是以它自己的查询返回 `notRun: true`、`budgetExhausted: true` 和空的 `results`，绝不返回另一次读取的 evidence；并发调用会先等正在进行的读取结束，因为失败的读取会把名额还回来。从本回合召回未准入的条目出发的 Related 遍历同样返回 `notRun: true`。Document search 另有独立边界：最多 4 条记录、每条最多 2,600 个查询附近字符、总正文最多 6,000 字符。模型侧 Memory Space 目录最多 16 项，`mnemon_status` 只返回紧凑健康汇总。完整记录、Provider 设置、路径和逐 Space 统计仍由 Web/RPC 控制面读取，不进入对话历史。

如果用户已经提供当前事实，或仓库可以直接回答，Agent 不应为了“展示记忆”而召回。

## Web 检索和 Agent 查询

Web “检索”页与模型工具路径不同：

```text
直接检索
  -> RPC 读取通道
  -> 限定到 Source 的管理检索
  -> 原始证据

Agent 查询
  -> 同一条确定性直接检索路径
  -> 派发不含 Mnemon 工具的任务 Agent
  -> 仅根据已提供的证据回答
  -> Host 将引用限定到实际的 memoryBodyId/id 对
```

“实体”和“内容”页也经 Source 管理协议执行确定性读取，不需要第二个模型。“内容”使用 Provider 的只读 browse 契约，不冒充语义 Recall。

## 显式长期写入

根 Agent 或 `/mnemon remember` 的长期写入流程：

```text
长期记忆候选
       |
       v
派发写入任务 Agent
       |
       +-- 列出记忆空间
       +-- 指定的空间，或最小的适用已激活范围
       +-- 需要查重或检查冲突时召回
       +-- 只有反复出现的独立领域才创建新范围
       +-- 按请求执行 remember / link / forget / merge
       v
结构化回执
```

空存储根首次创建 Memory Space 时使用 Mnemon 原生 `default` ID，后续 ID 由 Host 生成。向 inactive 目标写入成功后会激活它。这里的激活只影响 DSH 路由；来源数据库的合并是非破坏性的。

`mnemon_remember` 指定了记忆空间时，写入任务 Agent 只写到那里，否则不写。Host 在任务 Agent 启动前检查指定的空间：不存在的空间、Provider 已关闭或不接受写入的空间，以及已停用的空间，都会立即失败并说明原因。模型想重新启用某个停用的空间时，要先用 `mnemon_memory_body_update` 打开它；用户在记忆空间页上选中的停用空间会随写入重新打开。DSH 在任务 Agent 运行前挂上的守卫会拒绝写入其他空间的 `mnemon_remember` 或 `mnemon_link`，以及任何创建或修改空间的操作。

没有指定空间时，任务 Agent 在已激活的空间和它自己新建的空间中选择；守卫会拒绝写入或关联运行开始时就处于停用状态的空间，也拒绝把它打开。存入记忆从不合并空间。「存入记忆」遵循同样的规则，所以所有空间都停用时，除非任务 Agent 新建一个空间，否则不会保存任何内容。结果中的 `memoryBodyIds` 取自 Source 回执实际写入的空间，包括 Code Mode 程序中写入成功、之后程序才失败的那次写入；任务 Agent 报告了写入、却没有任何回执能证明时，结果为 `unknown`。写入打开了停用的空间时，`activatedMemoryBodyIds` 会列出它。来自不在本地运行子 Agent 的 provider 的任务 Agent，像以前一样不受守卫地运行；DSH 在守卫看不到的地方发布本地任务 Agent 时，写入会失败。运行结束后，委派的任务 Agent 不能再使用记忆工具：在 DSH 0.2.1 上，其他 Agent 给已结束的任务 Agent 发消息会让它从保存的状态恢复运行，这时它也无法再写入。

嵌入没有成功时（服务不可用或缺少模型），Mnemon Native 会在没有向量的情况下保存记忆，并在回执中说明（`embedded: false`）。经由任务 Agent 的写入会在 `unembedded` 中列出这些记忆，并附上 `hint`：补齐向量之前，它们不参与语义匹配，关键词、关联与时间召回仍能找到它们；嵌入服务可用后，可在 Mnemon Native 嵌入设置的 **测试状态** 中补齐。补齐使用 DSH 的存储根目录和嵌入设置，在终端运行的 `mnemon` 命令未必一致。`/mnemon remember` 会加一行说明；对话中和记忆空间页上的 **存入记忆** 回执也一样，无论记忆由任务 Agent 写入，还是直接写入某个空间；只有写入确实存入了记忆时才显示这一行。这一行的措辞只取决于 `embedding` 设置。DSH 不管理嵌入配置时（`enabled: false`，默认值），DSH 不设置任何嵌入服务，这一行是中性的说明，并指出关键词检索不受影响；不由 DSH 管理的服务没有生成向量时也是如此，例如只在 Mnemon CLI 继承的环境中配置的服务，或 Mnemon 默认地址上没有运行或缺少模型的 Ollama。DSH 管理嵌入配置时，这一行说明嵌入没有成功，回执中以提醒的颜色显示。模型读到的 `hint` 在两种情况下相同。

运行时 `add` / `replace` / `remove` 和 Document `create` / `update` 不需要模型做存储 I/O；它们通过 coordinator 进入确定性控制层。容量维护和归档才启动专用 worker。

## Runtime add：正常路径

```text
请求
  -> 规范化内容
  -> 获取进程内队列与文件锁
  -> 重新加载 memories.json
  -> 校验唯一匹配 / 重复 / 容量
  -> 写入临时 JSON 与 Markdown 投影
  -> 重命名投影文件
  -> 重命名 memories.json，作为提交标记
  -> 返回紧凑回执
```

`replace` 和 `remove` 在请求的目标内，优先用 `old_text` 唯一匹配完整正文；没有精确匹配时才使用唯一子串。重复的完整正文仍视为有歧义。只有请求中的 add 或增大正文的 replace 会超过目标上限时，才触发容量维护。

## USER.md 容量整理

容量整理与下文的 MEMORY.md 归档都属于分层策略。使用通用策略时，超出 Runtime 上限的写入会被直接拒绝。

```text
USER 新增后超过 4 KiB
          |
          v
保存修订与已提交条目的快照
          |
          v
派发无工具权限的本地压缩任务
          |
          v
返回压缩条目 + sourceIndexes
          |
          v
Host 校验：
  - 每个来源索引恰好出现一次
  - 没有重复或越界索引
  - 重要性未降低
  - 候选符合 Host 字节预算
  - 修订仍是当前版本
          |
          +-- 无效/冲突 -> 保留原始数据
          |
          v
按 UTF-8 字节确定性装填
          |
          v
重试待处理的新增操作
```

用户画像不会被发送到 Memory Spaces。worker 没有任何工具权限。

## MEMORY.md 归档与压缩

```text
分层策略下，本次 MEMORY 写入将超过配置上限（默认 10 KiB）
          |
          v
snapshot revision + 可归档的已提交 entries
（排除待提交 add，以及正被 replace/remove 的 entry）
          |
          v
Host 在本次操作的 Source / 命名空间范围内选择已有、active、可写的 Memory Spaces
          |
          +-- 任何地方都没有（该层关闭或不接受自动写入、没有就绪的 Provider、
          |   没有支持精确写入与安全删除的 active 空间）
          |     -> Runtime Source 在同一把锁内把压缩舍弃的条目追加到 runtime/archived/，
          |        再提交压缩与待提交修改；不调用模型，也不写 Provider
          |
          v
单个目标：Host 直接路由
多个目标：独立无工具 worker 只返回 source-index 路由
  模型执行失败时，Host 在合格目标中确定性兜底
          |
          v
Host 校验精确 source coverage、目标、权限与源修订
          |
          +-- 无效/revision 已变 -> 不写 Provider；保留 Runtime
          |
          v
Host 把每条原始 entry 精确写入规划的已有 Space
  - committed receipt -> 绑定目标 digest
  - skipped -> 必须取得完全一致的 Recall evidence
          |
          v
Host 按重要性与字节预算保留原始运行时记忆条目
          |
          v
CAS compactAndMutate(revision, compaction, original mutation, lineage)
  -> JSON 与两个 Markdown projection 作为一次本地提交落盘
```

planner 没有数据面工具，不能创建 Memory Space。每次写入都由 Host 发起；只有每条已提交来源都有可验证的 durable destination 后，Runtime 才会变化。若远端写入后发生很晚的跨进程 revision 冲突，原有的运行时记忆条目仍会保留；远端 Provider 无法共享本地文件锁，因此已提交的 durable copy 会作为安全重复保留，而不会被破坏性回滚。

### 运行时归档恢复

容量归档写入已激活的记忆空间，其 Provider 必须支持精确写入和安全删除。Hindsight 等异步提取目标会在任何归档写入前被排除。完全没有能接收归档的记忆空间时（该层已关闭或不接受自动写入、没有就绪的 Provider、没有激活的空间，或只剩不支持的 Provider），Runtime Source 会在同一把锁内、紧接着提交压缩与待写入内容之前，把压缩舍弃的条目追加到本地归档 `runtime/archived/`：`MEMORY.md` 供阅读，`memories.jsonl` 保存每个条目及其元数据。另一个记忆空间 Source 中有能接收归档的空间，或 Runtime Source 版本过旧、无法保留压缩舍弃的条目时，仍会拒绝。Mnemon Pack 不包含本地归档，导入 Pack 时会保留它。直接向 Provider 写入仍保持原有的异步行为。

对话归档使用所选 Source 的写入范围：回合中激活的已知空间，以及当前 View 创建的空间，都可作为归档目标。在 View 固定之后由其他操作创建的空间，需要新回合才能使用；所以当合适的空间都在 View 写入范围之外，或当前 View 不提供对它们的写入时，写入会被拒绝，而不是归档到本地。空范围始终不授权任何空间。目标错误会区分目录为空、View 范围为空或排除了当前空间、Provider 能力不支持，并报告目录、授权和可写数量。失败时待新增内容尚未保存；修正所报告的原因后，请在新回合重试同一份工具输入。已有的运行时记忆条目会保留。

归档回执或本地提交失败时，Host 仅尝试删除回执能证明由本次操作新建的条目，保留跳过或复用的既有条目。本地提交报错后，如果 Runtime 修订已变更或无法读取，则提交结果不确定：保留归档条目，避免丢失已提交的记忆。清理失败会标出剩余目标空间和条目 id。Provider 请求失败且没有返回回执时，远端结果可能不确定，因此这不是分布式事务；重试前应检查对应 Provider。

## Documents 创建、更新和归档

```text
创建/更新请求
          |
          v
按渲染后的 UTF-8 字节执行 capacityPlan
          |
     +----+----+
     |         |
   未超限     溢出
     |         |
     v         v
   提交    选择最久未访问的活跃档案
               |
               v
          保存档案与修订的快照
               |
               +-- 任何地方都没有能接收索引的记忆空间
               |     -> 不建索引，直接将文件移入归档，不派发任务 Agent
               |
               v
          派发归档任务 Agent
               |
               v
       写入并验证紧凑的 Mnemon 冷引用
       包含标题、摘要、计划路径、SHA-256
               |
          +----+----+
          |         |
         失败     回执有效
          |         |
          v         v
      保持活跃    检查修订
                    |
               +----+----+
               |         |
                冲突     一致
               |         |
               v         v
             保持活跃   将文件移入归档
                             |
                             v
                       重试原始修改
```

人工归档使用同一条“先索引、后迁移”路径；没有记忆空间能接收索引时，同样归档到本地。Mnemon 索引已经成功但 revision 冲突时不会回滚索引，因此可能出现安全的重复引用，而不会丢失 active 原文。

### 项目档案归档恢复

项目档案归档不再要求子代理为 remember/recall 回执编号。旧版本失败后若留下冷索引而档案仍为 active，重试可复用精确路径与当前内容哈希一致的索引；档案更新后需要匹配新修订的索引。异步提取或不支持安全删除的 Provider 会在写入前被拒绝。完全没有能接收索引的记忆空间时，档案会在不建索引的情况下归档到本地：原文移入归档目录，仍可在项目档案页面阅读。清理失败会报告目标空间和本次新建的 id；确认结果前应保留已有数据。

## 确定性活动评分和空闲审查

完成的 turn 累计四种信号：

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  不同工具数 < 3  -> 0
  不同工具数 = 3  -> 1
  不同工具数 >= 4 -> 2

score >= 5 时达到门槛
```

达到门槛并不代表一定写入：

```text
已完成的回合
      |
      v
score >= 5 ? -- 否 --> 为后续回合保留累计活动
      |
      是
      |
      v
Host 判断是否存在待整理内容
  - 当前轮明确要求不写记忆 -> 停止
  - 持久化意图、累计 >=320 用户字符、
    >=600 助手字符或已完成非 Mnemon 工作 -> 继续
      |
      v
等待 idleReviewMs（默认 30 秒），且距上次尝试
至少 idleReview.minIntervalMs（默认 5 分钟）
      |
      +-- 新回合 --> 取消定时器/任务，保留累计活动
      |
      v
确认 Agent 已空闲、已有 turn/end、该回合由分层策略组合，
且未达到 idleReview.maxPerSession
      |
      v
就已完成的回合启动任务 Agent
  - spawn（默认）：有界检查点，上限 idleReview.maxContextChars
  - fork：继承父 Agent 上下文
      |
      v
保守的整理决策，每轮只写一层
  - 先看档案：先检索；项目记录至多新建一份独立档案，
    不更新或归档已有档案
  - 运行时记忆：只收录用户新提出的、明确且持久的陈述；
    MEMORY.md 只收档案未涵盖的简短规则，不收项目记录
    （idleReview.runtimeMemory: false 时关闭）
  - 建了档案就不能再改工作记忆，反之亦然
  - 不提供记忆空间写入工具
      |
      +-- 已完成（含跳过）--> 清空累计活动
      |
      +-- 失败/中止 --------> 保留累计活动
```

admission 有意只使用结构信号，不调用 LLM 分类；因此达到 activity 门槛但没有 dirty candidate 的普通 checkpoint 不会启动后台模型。审查 Agent 的工具恰好是 `mnemon_document_search`、`mnemon_runtime_memory` 与 `mnemon_document_create`；`idleReview.runtimeMemory` 为 `false` 时不提供运行时记忆工具。审查 guard 让每轮只写一层：它放行的第一次新建档案或工作记忆修改决定本轮所写的层，另一层随后被拒绝，即使第一次调用失败也是如此；USER.md 的修改不受影响。“至多一份”档案或一次运行时记忆修改仍由 persona 约束，不是 Host mutation counter。审查的产出之后才进入记忆空间：工作记忆在容量整理时归档，项目档案在冷归档时建立索引。安装了 Agent Teams 工具时，除非设置 `idleReview.agentTeams: scoped`，审查会暂停；暂停期间状态页会给出提示。后台水位尚未持久化，Host 重启会丢失未处理的累计信号。

## 配置开关的关系

- `recallMode=off`：不再注入 recall cue，显式 `mnemon_recall` 仍可用。
- `writebackMode=off`：关闭写回 cue 和评分空闲审查，显式写入仍由 `writeEnabled` 决定。
- `lifecycleEnabled=false`：关闭生命周期提醒和审查，不移除显式工具或 Web 入口。
- `routingGuidance=false`：只移除额外路由 section；Runtime Memory context 仍注册。
- `writeEnabled=false`：移除语义写工具和写 RPC，拒绝写命令；它不是文件系统只读挂载保证。
