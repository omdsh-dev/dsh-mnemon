# 只读记忆空间：issue #434

[English](./README.md) | **简体中文** | [Issue #434](https://github.com/omdsh-dev/dsh-mnemon/issues/434) | [验证记录](./verification.json)

Issue #434 同时提出两点。已有的命名空间（例如另一个工具仍在写入的 Hindsight bank）应当继续可读。DSH 的每一次新写入只进入为它选定的命名空间。这是 [PR #457](https://github.com/omdsh-dev/dsh-mnemon/pull/457) 计划中 Provider 策略的第一步：DSH 写入的命名空间之外，其余命名空间都只读。

测试分支为 `claude/feat-434-space-write-policy`，基于 main `a7e3bc54`（v0.5.34），于 2026-10-23（Asia/Shanghai）验证，环境为 macOS arm64、Node 24.19.0、pnpm 10.13.1。

Provider 使用 `provider-lab/` 中的 Hindsight（官方 GHCR standalone 镜像），地址为 `127.0.0.1:18889`。所有请求都经过 `127.0.0.1:19660` 上一个计数代理，代理记录每一个请求。本记录新建了两个 bank：

- `wp434-legacy` 直接通过 Hindsight API 写入两条记忆，模拟另一个工具写下的内容；
- `wp434-dsh` 开始时为空。

两个 bank 都使用 Hindsight 的 `chunks` 提取模式，不需要 LLM；实验环境中的 Ollama 没有运行。召回使用 Hindsight 本地的嵌入与重排模型。

## 改动

- **明确的选择。** 空间的**编辑**对话框中新增**写入**，位于它所作用的 Provider 设置下方：**可写入**（“DSH 照常写入这里。”）或**只读**（“照常召回；DSH 不再写入这里，也不写入同一命名空间的其他空间。”）。只读空间的卡片上会显示**只读**。只改动这一选择时，只保存这一选择；与其他设置一起改动时，如果设置已保存而选择没能保存，页面会明确说明。同一个选择也是 Source 管理操作 `body-write-policy`，参数为 `{ memoryBodyId, policy: 'writable' | 'read-only' }`，与所有管理变更一样需要确认。页面客户端通过 `setWritePolicy` 调用它，Agent 工具无法调用它。
- **在调用 Provider 之前拒绝。** 记忆空间服务在写入真正发出时读取磁盘上的设置，而不是在组成 View 时读取。检查覆盖存入、批量写入中的每个目标与每一条、遗忘、链接、合并进空间、删除 Mnemon Native Store 与补齐向量；合并在导入前、补齐在每一步前都会再检查一次。Agent、页面、任务 Agent 与 Host 的每条写入路径最终都经过这里。被拒绝的写入会写明是哪个空间，且不会调用 Provider。
- **按写入的落点，而不是按卡片。** 每个空间都有一个键：Provider 类型，再加上 Provider 指明的写入落点，运行时的默认值都已解析。内置 Provider 通过新增的可选适配器方法 `namespaceKey` 给出：
  - Hindsight：地址与 bank；
  - Mem0：地址、user 与 agent，通配符按 `dsh-user` 与 `dsh` 写入；
  - Honcho：地址、workspace 与两个 peer；
  - RetainDB：地址、project 与 user；
  - Supermemory：地址与 container tag；
  - OpenViking：地址、account 与记忆根。actor peer 只是请求头，不计入；
  - Holographic：解析后的存储文件；
  - ByteRover：解析后的目录；
  - Mnemon Native：它的 Store。

  没有该方法的 Provider 只按服务地址确定键，从而失败即封闭。两个键中一个是另一个的前缀时，视为同一落点，因此只有服务器才知道归属用户的 OpenViking 记忆根，会覆盖其 account 下的所有记忆根。手动创建的空间、持久化策略新建的空间、同一服务器上的第二个 Provider 实例、重新连接、重新发现以及打开开关，都不会带来写入。
- **可写入只作用于该空间自己的落点。** 它只移除这一个键，不会经由通配符或旧的 externalId 移除别的键。如果某个空间也写入另一个只读空间的落点，它仍保持只读，并说明原因。
- **不退回。** 未指定空间的写入进入唯一一个已激活且可写的空间；一个都没有或不止一个时，会要求指明空间。Source 的 facts 不再为只读空间提供链接与遗忘，`archivableCount` 也不计入它们。交给 Host 写入方的写入范围不包含它们，任务 Agent 的目标检查拒绝它们，工具守卫让写入方不碰它们。无论在对话中还是记忆空间页面上，“存入记忆”都不列出它们。所有空间都只读时，运行时记忆容量维护与文档归档改走本地归档。
- **模型与页面看到的内容。** 模型查看的空间目录中，只读空间标为 `writePolicy: 'read-only'`，其 `remember`、`link`、`forget` 显示为 `false`。召回证据与页面条目也给出同样的能力，因此不会在这些记忆上提供“遗忘”。
- **保存位置。** 设置按数据目录、按记忆空间 Source 实例保存在 `state/memory-provider-write-policy.json`，与 Provider 连接放在一起。单独存一个文件，是因为旧版本会重写空间注册表，并丢掉它们不认识的字段。最多可以有 1,000 个只读落点；超出时会拒绝设为只读，而不是丢弃最早的。文件或其中的条目无法读取时，所有空间都按只读处理，召回照常：此时目录中带有 `writePolicyProblem`，未指定空间的写入会说明原因，页面显示横幅，并在确认后提供**重置写入选择**。
- **没有设置的空间不受影响。** 不写文件，不加字段，revision 编码不变，报错与以前相同。Mnemon Native 的召回仍会在 Store 中记录读取，这一点在所有空间都一样。

## 真实 Hindsight 上的结果

main 与分支对同样的两个 bank 运行同一个场景。先运行分支，这样 main 的写入不会影响分支看到的内容。每一行是对记忆空间服务的一次调用，也就是 Source 为 Agent、页面与 Host 发出的调用。

| 写入 | main `a7e3bc54` | 分支 |
|---|---|---|
| 指定旧空间存入 | 已写入：向 `wp434-legacy` 发出 `POST /memories` | 拒绝，无请求 |
| 指定旧空间批量写入 | 已写入：`POST /memories` | 拒绝，无请求 |
| 遗忘一条旧记忆 | 已写入：`PATCH /memories/<id>` 使其失效 | 拒绝，无请求 |
| 未指定空间的自动采集，且旧空间是唯一激活的空间 | 已写入：`POST /memories` | 拒绝（“no active memory space takes writes”），无请求 |
| 指定 DSH 空间存入 | 在 `wp434-dsh` 中排队 | 在 `wp434-dsh` 中排队 |
| 未指定空间存入，两个空间都激活 | 拒绝：“memoryBodyId is required” | 在 `wp434-dsh`（唯一可写的空间）中排队 |
| 跨两个空间召回 | 两个 bank 都有结果 | 两个 bank 都有结果 |

| 计数 | main | 分支 |
|---|---|---|
| `wp434-legacy` 收到的 Hindsight 变更请求 | 4 个（3 个 `POST`、1 个 `PATCH`） | 0 |
| `wp434-legacy` 中的记忆，前 → 后 | 2 → 4（新增三条，一条失效） | 2 → 2 |
| `wp434-dsh` 收到的 Hindsight 变更请求 | 1 | 2（`POST /memories`） |
| `wp434-dsh` 中的记忆，前 → 后 | 4 → 5 | 2 → 4 |

在分支上，DSH bank 返回的每个回执都是 `queued`，完成状态为 `accepted`，不会是 `committed`。Hindsight 在后台完成提取，只读设置不改变这类回执的含义。分支运行前，`wp434-dsh` 已有两条记忆。它们来自同一分支场景更早的一次运行；那次运行的召回发生在 Hindsight 存好写入之前，因此没有记录。

这个真实场景已作为 `plugins/dsh-mnemon-source-memory-spaces/tests/hindsight-write-policy.live.spec.ts` 提交。它需要通过 `MNEMON_WRITE_POLICY_HINDSIGHT` 显式开启，计数代理在测试内部运行。上面的记录基于 `e55da9e4`。按评审意见修复后，在 `3cd04d74` 上重新运行了一次：指向旧 bank 的四次写入都被拒绝，Hindsight 没有收到任何请求；写入 DSH bank 的两次各发出一个 `POST /memories`，完成状态为 `accepted`；召回两个 bank 都能读到。`wp434-legacy` 前后都是 4 条记忆，`wp434-dsh` 从 5 条变为 7 条。

## WebUI 中的表现

`scripts/serve-e2e.mjs --remember-target` 用全新的夹具运行真实的 DSH WebUI：夹具含文档演示用的几个 Mnemon Native 空间，以及一个按脚本把记忆指定写入 Lumen 项目的模型。main `a7e3bc54`（端口 19662）与本分支（端口 19663）各运行一次，由 headless Chrome 经 CDP 操作，浅色模式，中英文各一遍。两种语言下空间名称都是夹具中的中文名。

**选择项在空间的编辑对话框中。** main 没有这个选择。在本分支上，**写入**下有**可写入**（默认选中）和**只读**两项，旁边写明各自的含义。

| main | 本改动 |
|---|---|
| ![main：没有写入选项](./zh-edit-before.jpg) | ![本改动：选中可写入](./zh-edit-after.jpg) |
| ![main，英文界面](./en-edit-before.jpg) | ![本改动，英文界面](./en-edit-after.jpg) |

| 选择只读 | 选择只读，英文界面 |
|---|---|
| ![选中只读](./zh-edit-read-only-after.jpg) | ![选中只读，英文界面](./en-edit-read-only-after.jpg) |

**卡片。** 保存后，Lumen 项目的卡片显示**只读**。它的删除按钮不可用，因为只读的 Mnemon Native 空间会保留它的 Store；鼠标悬停时会说明这一点。

| main | 本改动 |
|---|---|
| ![main：卡片](./zh-cards-before.jpg) | ![本改动：Lumen 项目显示只读](./zh-cards-after.jpg) |
| ![main，英文界面](./en-cards-before.jpg) | ![本改动，英文界面](./en-cards-after.jpg) |

**对话中的“存入记忆”。** main 把 Lumen 项目列为可选去处。本分支不再列出它，另一个已激活的空间“团队约定”仍在列表中。

| main | 本改动 |
|---|---|
| ![main：列出 Lumen 项目](./zh-save-to-before.jpg) | ![本改动：不再列出 Lumen 项目](./zh-save-to-after.jpg) |
| ![main，英文界面](./en-save-to-before.jpg) | ![本改动，英文界面](./en-save-to-after.jpg) |

**模型把写入指向该空间。** 收到 `remember-target-check` 后，模型先列出空间，再调用 `mnemon_remember` 并指定 Lumen 项目。在 main 上，任务 Agent 把记忆写进了该空间（`added`）。在本分支上，Host 在任何任务 Agent 运行之前就拒绝了这次写入，模型转述拒绝原因：`Memory Space "default" (Lumen 项目) is read only: it is recalled and takes no writes. Name a writable space.` 模型的回复由脚本给出，两种语言下都是中文。

| main | 本改动 |
|---|---|
| ![main：写入 Lumen 项目](./zh-remember-before.jpg) | ![本改动：被拒绝](./zh-remember-after.jpg) |

![本改动，英文界面](./en-remember-after.jpg)

## 测试

- `plugins/dsh-mnemon-source-memory-spaces/tests/write-policy.spec.ts` 用一个统计写入次数的 bank Provider 驱动真实的 Source。每条写入路径各有一项测试：View 的存入、遗忘与链接，以及管理操作的存入、批量写入、遗忘与链接。其余测试覆盖以下情形：显式指定旧空间（未激活时与重新打开后）；为同一 bank 手动创建的空间；设置改为指向该 bank 的空间；断开后重新挂载；View 组成后更改设置；默认目标；不退回；facts 与写入范围；召回证据与页面条目给出只读空间当前的能力。评审指出的情形各有测试：带通配符的 Mem0 user 与 agent、同一存储上手动或由持久化策略创建的 Holographic 空间、空白与相对的 ByteRover 目录、OpenViking 的 peer、末尾斜杠与只有服务器才知道归属用户的记忆根、改指向另一个 bank 的 Hindsight 空间、同一服务器上的第二个 Provider 实例，以及 1,000 个落点的上限。在 Mnemon Native 上，测试覆盖以下情形：存入、批量写入、遗忘、链接、合并、补齐向量与删除都不运行任何写入记忆或向量的命令；合并目标与补齐在中途变为只读；批量写入在目标变为只读时停下；设置文件无法读取、格式不支持或含有无法读取的条目，目录与未指定空间的写入都会说明原因，并可重置；重启以及另一个数据目录；没有设置时行为不变。
- `write-policy-page.spec.tsx` 在真实 Source 上渲染真实页面，覆盖选择、只改动选择时只保存选择、卡片标记、改回可写入、页面自身的“存入记忆”对话框不提供只读空间，以及设置文件无法读取时的横幅与确认后的重置。
- `hindsight-write-policy.live.spec.ts` 就是上文的真实场景，需要通过 `MNEMON_WRITE_POLICY_HINDSIGHT` 显式开启。
- 其余由根目录测试覆盖。层组合矩阵新增只读空间：覆盖经 Agent 工具、网页与 Host 自身路径的 MEMORY.md 归档与文档归档，以及 View 提供的内容。任务 Agent 的目标检查与工具守卫也有测试；“存入记忆”的去处列表不含只读空间；只读 Native 空间不提供**补齐**。

```text
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run   # 315 通过，3 跳过
pnpm exec vitest run --dir tests                                # 2,176 通过，7 跳过
pnpm run typecheck && pnpm --filter dsh-mnemon-source-memory-spaces run typecheck
pnpm --filter dsh-mnemon-source-memory-spaces run build && pnpm run build
MNEMON_CLI_PATH=/nonexistent/mnemon pnpm run verify:plugins
node scripts/verify-docs.mjs
```

## 限制

- WebUI 截图使用 Mnemon Native 空间，而不是 Hindsight bank，因为 e2e 夹具中没有 Hindsight。截图展示的写入路径，与上文 Hindsight 场景测量的路径相同。
- 在 main 上，英文那一遍的 `remember-target-check` 重复了中文那一遍已经存入的记忆。Mnemon 识别出重复，因此那一遍没有新内容，记录中只保留中文截图。
- Hindsight 的写入是异步提取，因此它从来不是归档目标。在两个版本上都不会发生向只读 Hindsight bank 归档的情况，所以归档在层组合矩阵中用 Mnemon Native 验证。
- 任务 Agent 写入方需要模型。它的目标检查与工具守卫在 Host 测试中验证，没有实际运行。
- Pack 恢复与 Git 同步会复制整个存储。只读设置约束的是 DSH 自己的写入，所以不会阻止它们。两者都不携带设置文件，也都不会删除它。
