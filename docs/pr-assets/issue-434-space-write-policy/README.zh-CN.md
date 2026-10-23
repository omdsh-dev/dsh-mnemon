# 只读记忆空间：issue #434

[English](./README.md) | **简体中文** | [Issue #434](https://github.com/omdsh-dev/dsh-mnemon/issues/434) | [验证记录](./verification.json)

Issue #434 同时提出两点。已有的命名空间（例如另一个工具仍在写入的 Hindsight bank）应当继续可读。DSH 的每一次新写入只进入为它选定的命名空间。这是 [PR #457](https://github.com/omdsh-dev/dsh-mnemon/pull/457) 计划中 Provider 策略的第一步：DSH 写入的命名空间之外，其余命名空间都只读。

测试分支为 `claude/feat-434-space-write-policy`，基于 main `a7e3bc54`（v0.5.34），于 2026-10-23（Asia/Shanghai）验证，环境为 macOS arm64、Node 24.19.0、pnpm 10.13.1。

Provider 使用 `provider-lab/` 中的 Hindsight（官方 GHCR standalone 镜像），地址为 `127.0.0.1:18889`。所有请求都经过 `127.0.0.1:19660` 上一个计数代理，代理记录每一个请求。本记录新建了两个 bank：

- `wp434-legacy` 直接通过 Hindsight API 写入两条记忆，模拟另一个工具写下的内容；
- `wp434-dsh` 开始时为空。

两个 bank 都使用 Hindsight 的 `chunks` 提取模式，不需要 LLM；实验环境中的 Ollama 没有运行。召回使用 Hindsight 本地的嵌入与重排模型。

## 改动

- **明确的选择。** 空间的**编辑**对话框中新增**写入**：**可写入**（“DSH 可以在这里存入、遗忘和链接记忆。”）或**只读**（“照常召回；DSH 不再在这里存入、遗忘、链接或归档记忆。”）。只读空间的卡片上会显示**只读**。同一个选择也是 Source 管理操作 `body-write-policy`，参数为 `{ memoryBodyId, policy: 'writable' | 'read-only' }`，与所有管理变更一样需要确认。页面客户端通过 `setWritePolicy` 调用它，Agent 工具无法调用它。
- **在调用 Provider 之前拒绝。** 记忆空间服务在写入真正发出时读取磁盘上的设置，而不是在组成 View 时读取。检查覆盖存入、批量写入中的每个目标与每一条、遗忘、链接、合并进空间、删除 Mnemon Native Store 与补齐向量。Agent、页面、任务 Agent 与 Host 的每条写入路径最终都经过这里。被拒绝的写入会写明是哪个空间，且不会调用 Provider。
- **按命名空间，而不是按卡片。** 只读条目按 externalId 标识命名空间，或按标识命名空间的设置（已填入默认值）标识；Mnemon Native Store 按其 id 标识。因此，为同一个 bank 手动创建的空间、重新连接、重新发现、打开开关，以及通配读取，都同样只读。设置改为指向另一个命名空间的空间，采用那个命名空间的设置。
- **不退回。** 未指定空间的写入进入唯一一个已激活且可写的空间；一个都没有或不止一个时，会要求指明空间。Source 的 facts 不再为只读空间提供链接与遗忘，`archivableCount` 也不计入它们。交给 Host 写入方的写入范围不包含它们，任务 Agent 的目标检查拒绝它们，工具守卫让写入方不碰它们；“存入记忆”也不列出它们。所有空间都只读时，运行时记忆容量维护与文档归档改走本地归档。
- **模型看到的内容。** 模型查看的空间目录中，只读空间标为 `writePolicy: 'read-only'`，其 `remember`、`link`、`forget` 显示为 `false`。
- **保存位置。** 设置保存在 `state/memory-provider-write-policy.json`，与 Provider 连接放在一起。单独存一个文件，是因为旧版本会重写空间注册表，并丢掉它们不认识的字段。只有存在只读空间时才有这个文件。文件无法读取时，所有空间都按只读处理，直到修复或删除该文件；召回照常。
- **没有设置的空间不受影响。** 不写文件，不加字段，revision 编码不变；没有设置的空间，报错与以前相同。

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

## 测试

- `plugins/dsh-mnemon-source-memory-spaces/tests/write-policy.spec.ts` 用一个统计写入次数的 bank Provider 驱动真实的 Source。每条写入路径各有一项测试：View 的存入、遗忘与链接，以及管理操作的存入、批量写入、遗忘与链接。其余测试覆盖以下情形：显式指定旧空间（未激活时与重新打开后）；为同一 bank 手动创建的空间；设置改为指向该 bank 的空间；断开后重新挂载；View 组成后更改设置；默认目标；不退回；facts 与写入范围。在 Mnemon Native 上，测试覆盖以下情形：存入、批量写入、遗忘、链接、合并、补齐向量与删除都不运行任何修改 Store 的命令；批量写入在目标变为只读时停下；设置文件无法读取或格式不支持；重启以及另一个数据目录；没有设置时行为不变。
- `write-policy-page.spec.tsx` 在真实 Source 上渲染真实页面，覆盖选择、卡片标记与改回可写入。
- 其余由根目录测试覆盖。层组合矩阵新增只读空间：覆盖经 Agent 工具、网页与 Host 自身路径的 MEMORY.md 归档与文档归档，以及 View 提供的内容。任务 Agent 的目标检查与工具守卫也有测试；“存入记忆”的去处列表不含只读空间；只读 Native 空间不提供**补齐**。

```text
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run   # 307 通过，2 跳过
pnpm exec vitest run --dir tests                                # 2,176 通过，7 跳过
pnpm run typecheck && pnpm --filter dsh-mnemon-source-memory-spaces run typecheck
pnpm --filter dsh-mnemon-source-memory-spaces run build && pnpm run build
MNEMON_CLI_PATH=/nonexistent/mnemon pnpm run verify:plugins
node scripts/verify-docs.mjs
```

## 限制

- 没有录制 WebUI。页面测试在真实 Source 与真实 Provider 上渲染真实页面。
- Hindsight 的写入是异步提取，因此它从来不是归档目标。在两个版本上都不会发生向只读 Hindsight bank 归档的情况，所以归档在层组合矩阵中用 Mnemon Native 验证。
- 任务 Agent 写入方需要模型。它的目标检查与工具守卫在 Host 测试中验证，没有实际运行。
- Pack 恢复与 Git 同步会复制整个存储。只读设置约束的是 DSH 自己的写入，所以不会阻止它们。两者都不携带设置文件，也都不会删除它。
