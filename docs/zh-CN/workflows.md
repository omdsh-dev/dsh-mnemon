# 生命周期与核心流程

**简体中文** | [English](../en/workflows.md) | [文档中心](./README.md)

## 每轮上下文

插件会注册稳定的路由指导、一份静态 Runtime Memory 协议和一个 Wake context 槽位：

- `mnemon:routing`：system prompt section；当 `routingGuidance=true` 时提供简短的分层查询边界；
- `mnemon:runtime-memory-protocol`：system prompt section，只包含不变的 Runtime Memory 语义与写入规则。它只在 eager Runtime Source 参与自动投影时出现，记忆变更前后保持逐字节一致；
- `mnemon:runtime-memory`：由当前 root 回合固定的不可变 Wake 填充。Runtime Memory 提供带 revision 的完整 USER/MEMORY 状态快照，不再重复静态协议；Documents 与 Memory Spaces 只贡献有界封面，不注入完整目录。

DSH 只在这份动态 Wake 发生变化时追加新的 user-role runtime-context 快照。该快照仍刻意保持完整，因为 DSH 将最新 runtime-context 消息定义为取代旧快照；完整状态能保护 resume、fork、compaction、删除和上下文裁剪语义。把不变协议放入稳定 system 前缀，可以从每个变化后的尾部快照移除这些字节，又不需要构造不可恢复的 diff 链。

生命周期会在 Host 组装 System Prompt 前固定 View，并让本回合所有模型 step 使用同一个 View：

```text
turn/start
  -> 进入 system-prompt/assemble hook
  -> beginTurn(root turn + operation scope)
  -> Source facts → Strategy ViewSpec → validation → Source projection
  -> pin Source revisions/digests and Host-only authority
  -> build bounded Wake
  -> 继续真正的 Host prompt assembly
  -> 让静态协议 section 与已固定的 Runtime Source 对齐
  -> replace mnemon:runtime-memory with that Wake

agent/pre-step(step=1)
  -> cancel pending/running background review for a new turn
  -> mark Prime once
  -> 每个会话至多追加一次简短 recall/writeback cue
  -> main Agent decides whether to call a memory tool
```

Source snapshot 不执行语义召回。Prime 只初始化路由状态，不执行异步 CLI 状态查询。

子 Agent 在 `agent/created`、driver 启动前捕获并保留存活父 Agent 的固定 View 与运行图。自己的各个回合固定这一被保留的 View，即使父回合已结束或已进入更新的 generation。子 Agent activation 销毁时释放委托；冷恢复重新获取委托；Host 显式创建且没有父模型回合的后台子任务生成新的 scoped View。子 Agent 拥有自己的回合权限，但不安装 root 专属的 cue 或空闲审查。详见[权限生命周期](./architecture.md#直接召回与受监督-mutation)。

## Agent 召回

```text
Root or child Agent calls mnemon_recall(query, optional memoryBodyIds)
          |
          v
resolve the executing Agent's own turn pin and retained runtime
          |
          v
read the pinned Memory Space Source state on the Host
          |
          v
validate requested IDs are a subset; otherwise use every pinned active ID
          |
          v
Memory Spaces Source searches granted Provider namespaces concurrently
          |
          v
quality normalization + reciprocal-rank fusion
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
总正文 4,800 字符的 envelope
```

模型工具不暴露 `category`、`source` 或 `intent` 过滤器：模型猜错过滤条件不能遮住精确证据。Recall 并非强制执行，普通 root 回合是 0 次 Provider 查询。LLM 主动调用后，Host 允许一个首次查询；只有 LLM 查看 evidence 后仍认为不足，才允许再提交一个实质不同的精炼查询。同查询和并发重复请求会 join 或重放；第三个不同查询只重放最新 evidence，不再到达 Provider。随后至多执行一次 Related，而且只能使用两次 Recall 任一已准入的 `memoryBodyId + id`；重复 Related 同样重放结果。

Recall、Related 和单次 Documents 搜索槽位按执行中的 Agent 回合计预算。同一回合内并发调用共享状态，兄弟任务、后续回合和冷恢复的 activation 不会共享缓存 evidence 或占用彼此的预算。重放结果限于本次请求的 Memory Space 子集。Document search 另有独立边界：最多 4 条记录、每条最多 2,600 个查询附近字符、总正文最多 6,000 字符。模型侧 Memory Space 目录最多 16 项，`mnemon_status` 只返回紧凑健康汇总。完整记录、Provider 设置、路径和逐 Space 统计仍由 Web/RPC 控制面读取，不进入对话历史。

如果用户已经提供当前事实，或仓库可以直接回答，Agent 不应为了“展示记忆”而召回。

## Web 检索和 Agent 查询

Web “检索”页与模型工具路径不同：

```text
Direct search
  -> RPC read channel
  -> Source-scoped management search
  -> raw evidence

Agent search
  -> the same deterministic direct search
  -> spawn a worker with no Mnemon tools
  -> answer only from supplied evidence
  -> Host filters citations to actual memoryBodyId/id pairs
```

“实体”和“内容”页也经 Source 管理协议执行确定性读取，不需要第二个模型。“内容”使用 Provider 的只读 browse 契约，不冒充语义 Recall。

## 显式长期写入

根 Agent 或 `/mnemon remember` 的长期写入流程：

```text
durable candidate
       |
       v
spawn write worker
       |
       +-- list Memory Spaces
       +-- choose the narrowest suitable scope
       +-- recall when duplicate/conflict checking is useful
       +-- create a new scope only for a recurring distinct domain
       +-- remember / link / forget / merge as requested
       v
structured receipt
```

空存储根首次创建 Memory Space 时使用 Mnemon 原生 `default` ID，后续 ID 由 Host 生成。向 inactive 目标写入成功后会激活它。这里的激活只影响 DSH 路由；来源数据库的合并是非破坏性的。

运行时 `add` / `replace` / `remove` 和 Document `create` / `update` 不需要模型做存储 I/O；它们通过 coordinator 进入确定性控制层。容量维护和归档才启动专用 worker。

## Runtime add：正常路径

```text
request
  -> normalize content
  -> acquire in-process queue and file lock
  -> reload memories.json
  -> validate unique match / duplicate / capacity
  -> write temporary JSON and Markdown projections
  -> rename projections
  -> rename memories.json as the commit marker
  -> return compact receipt
```

`replace` 和 `remove` 必须通过 `old_text` 唯一命中一条。只有请求中的 add 或增大正文的 replace 会超过目标上限时，才触发容量维护。

## USER.md 容量整理

```text
USER add exceeds 4 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn no-tool local compactor
          |
          v
return compacted entries + sourceIndexes
          |
          v
Host validates:
  - every source index appears exactly once
  - no duplicate or out-of-range index
  - importance is not lowered
  - candidate fits the Host byte budget
  - revision is still current
          |
          +-- invalid/conflict -> preserve original data
          |
          v
deterministic UTF-8 packing
          |
          v
retry pending add
```

用户画像不会被发送到 Memory Spaces。worker 没有任何工具权限。

## MEMORY.md 归档与压缩

```text
MEMORY add exceeds 10 KiB
          |
          v
snapshot revision + 可归档的已提交 entries
（排除待提交 add，以及正被 replace/remove 的 entry）
          |
          v
Host 选择已有、active、可写的 Memory Spaces
          |
          v
spawn 无工具 planner
  output: 完整 source-index 路由 + 有界压缩候选
          |
          v
Host 校验精确 source coverage、目标、候选和字节预算
          |
          +-- 无效/revision 已变 -> 不写 Provider；保留 Runtime
          |
          v
Host 把每条原始 entry 精确写入规划的已有 Space
  - committed receipt -> 绑定目标 digest
  - skipped -> 必须取得完全一致的 Recall evidence
          |
          v
CAS compactAndMutate(revision, compaction, original mutation, lineage)
  -> JSON 与两个 Markdown projection 作为一次本地提交落盘
```

planner 没有数据面工具，不能创建 Memory Space。每次写入都由 Host 发起；只有每条已提交来源都有可验证的 durable destination 后，Runtime 才会变化。若远端写入后发生很晚的跨进程 revision 冲突，原 hot entries 仍会保留；远端 Provider 无法共享本地文件锁，因此已提交的 durable copy 会作为安全重复保留，而不会被破坏性回滚。

## Documents 创建、更新和归档

```text
create/update request
          |
          v
capacityPlan using rendered UTF-8 bytes
          |
     +----+----+
     |         |
    fits     overflow
     |         |
     v         v
 commit    select least-recently-used active Document
               |
               v
          snapshot document + revision
               |
               v
          spawn archive worker
               |
               v
       write/verify concise Mnemon cold reference
       with title, summary, planned path, SHA-256
               |
          +----+----+
          |         |
        failed    receipt ok
          |         |
          v         v
   keep active   revision check
                    |
               +----+----+
               |         |
             conflict   current
               |         |
               v         v
          keep active  move file to archived
                             |
                             v
                    retry original mutation
```

人工归档使用同一条“先索引、后迁移”路径。Mnemon 索引已经成功但 revision 冲突时不会回滚索引，因此可能出现安全的重复引用，而不会丢失 active 原文。

## 确定性活动评分和后台审查

完成的 turn 累计四种信号：

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  unique tools < 3  -> 0
  unique tools = 3  -> 1
  unique tools >= 4 -> 2

eligible when score >= 5
```

达到门槛并不代表一定写入：

```text
completed turn
      |
      v
score >= 5 ? -- no --> retain activity for later turns
      |
     yes
      |
      v
Host dirty admission
  - 当前轮明确要求不写记忆 -> stop
  - 持久化意图、累计 >=320 用户字符、
    >=600 助手字符或已完成非 Mnemon 工作 -> continue
      |
      v
wait idleReviewMs (default 30 s)
      |
      +-- new turn --> cancel timer/worker, retain activity
      |
      v
confirm Agent is idle and turn/end exists
      |
      v
fork completed parent checkpoint
      |
      v
conservative maintenance decision
  - at most one hot-memory mutation by persona
  - at most one Document create/update by persona
  - no direct long-term remember/forget tools
      |
      +-- completed, including skip -> clear activity
      |
      +-- failed/aborted ------------> retain activity
```

admission 有意只使用结构信号，不调用 LLM 分类；因此达到 activity 门槛但没有 dirty candidate 的普通 checkpoint 不会启动后台模型。“最多一次”当前由 worker persona 约束，不是 Host mutation counter。后台水位尚未持久化，Host 重启会丢失未处理的累计信号。

## 配置开关的关系

- `recallMode=off`：不再注入 recall cue，显式 `mnemon_recall` 仍可用。
- `writebackMode=off`：关闭写回 cue 和评分后台审查，显式写入仍由 `writeEnabled` 决定。
- `lifecycleEnabled=false`：关闭生命周期提醒和审查，不移除显式工具或 Web 入口。
- `routingGuidance=false`：只移除额外路由 section；Runtime Memory context 仍注册。
- `writeEnabled=false`：移除语义写工具和写 RPC，拒绝写命令；它不是文件系统只读挂载保证。
