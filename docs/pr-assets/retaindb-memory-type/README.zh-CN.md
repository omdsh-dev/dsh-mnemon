# RetainDB 的记忆类型、旧接口写入与读回

[English](./README.md) | [验证记录](./verification.json)

本记录基于 #462，后者把重要度映射到 RetainDB 的 0-1 量纲（[其记录](../retaindb-importance-scale/README.zh-CN.md)）。它涵盖 RetainDB Provider 写入与读取记忆的三处修复：

1. **记忆类型。** Provider 把 Memory Spaces 的分类当作 RetainDB 的 `memory_type` 发送（`memory_type: request.category ?? 'factual'`）。Source 总会给出分类：默认为 `general`，运行时记忆与项目档案的归档使用 `context`（`src/host/runtime-capacity.ts`、`src/host/document-archive.ts`）。
2. **[旧接口写入与回执](#旧接口写入与回执)。** 旧接口把每次写入都排入队列，Provider 的回执却说已经存下。
3. **[读回类型](#读回类型)。** 分类读回时是 RetainDB 自己的类型，从 RetainDB Local 检索得到的则一律是 `general`。

基线为 `claude/fix-retaindb-importance-scale` 的 `c841066f`（#462）。验证于 2026-10-24（Asia/Shanghai）进行，环境为 macOS arm64、Node 24.19.0 与 pnpm 10.13.1。记忆均为合成数据。

证据包括：

- RetainDB 自身在 `2ad2cc4d` 的源码；
- 单元测试：Provider 向每个接口发送的类型、它的回执，以及它读回的分类；
- 用 RetainDB Server 自己的请求 schema 重放实际请求体；
- 类型修复前后对 provider lab 中 RetainDB Local 0.2.2 的实际运行。

没有运行 RetainDB Server，也没有使用托管服务。Cloud 没有实际观察到。

## RetainDB 的类型

链接均指向 [RetainDB/RetainDB](https://github.com/RetainDB/RetainDB) 的 `2ad2cc4d`。

- **`POST /v1/memory`** 声明 `memory_type: z.enum(MEMORY_TYPE_VALUES).optional()`（[`api/memory.ts:924`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L924)）。
  - 列表共 16 种类型：`factual`、`episodic`、`semantic`、`procedural`、`preference`、`event`、`relationship`、`opinion`、`goal`、`instruction`、`decision`、`constraint`、`solution`、`project_state`、`correction` 与 `workflow`（[`:63-80`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L63-L80)）。
  - 其中没有 `general`、`fact`、`insight` 与 `context`。
  - 类型不在列表中时，`@hono/zod-validator` 0.4.3 返回 HTTP 400。
- **旧接口 `POST /v1/memories`** 声明 `memory_type: z.enum(["factual", "episodic", "semantic", "procedural"]).optional().default("factual")`（[`api/routes.ts:2584`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2584)）。
- **Server 的回退类型是 `factual`。** 其写入路径把 `semantic` 归入 `factual`，`episodic` 归入 `event`，`procedural` 归入 `instruction`，其他名称一律归入 `factual`（[`engine/memory/write.ts:140-161`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/engine/memory/write.ts#L140-L161)、[`api/memory.ts:104-107`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L104-L107)）。
- **RetainDB Local** 接受任何类型。它先从正文推断类型，推断不出时使用收到的类型，并把 `fact` 与它不认识的名称都读作 `factual`（[`local/src/cli.ts:173-201`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L173-L201)、[`:302-316`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L302-L316)）。

## 原因

Provider 直接发送分类本身。在 RetainDB Server 上：

- `POST /v1/memory` 拒绝所有分类为 `fact`、`insight`、`context` 或 `general` 的记忆，包括 Source 的默认分类；
- 旧接口拒绝所有记忆，因为六个分类名它一个也不接受。

在 #462 的基础上，`POST /v1/memory` 仍拒绝 18 种分类与重要度组合中的 12 种，旧接口则 18 种全部拒绝。

## 修复

- 在 `POST /v1/memory` 上，`preference` 与 `decision` 保持原名；`fact`、`insight`、`context` 与 `general` 按 `factual` 发送。
- 旧接口 `POST /v1/memories` 不接受 `preference` 与 `decision`，所有分类都按 `factual` 发送给它。
- 没有分类的请求在两个接口上仍按 `factual` 发送。
- `factual` 是 RetainDB Server 与 RetainDB Local 自己的回退类型，也是没有分类到达时 Provider 原本就发送的类型。
- 读回时 `preference` 与 `decision` 映射回对应分类，见[读回类型](#读回类型)。

## 用 RetainDB Server 的 schema 重放

#462 记录中的 [`server-schema.probe.mjs`](../retaindb-importance-scale/server-schema.probe.mjs) 经真实的 Source 与 Provider，把每个分类在重要度 1、3、5 下各写入一次，发往本机回环记录器。它运行两遍：一遍应答 `POST /v1/memory`，另一遍对它返回 404，让 Provider 回退到 `POST /v1/memories`。随后用 Server 针对该接口的请求 schema 解析每个请求体。下表对重要度 1、3、5 都成立。

| 分类 | 发往 `/v1/memory` 的类型，修复前 → 修复后 | `/v1/memory` | 发往 `/v1/memories` 的类型，修复前 → 修复后 | `/v1/memories` |
|---|---|---|---|---|
| `preference` | `preference` → `preference` | 接受 → 接受 | `preference` → `factual` | 400 → 接受 |
| `decision` | `decision` → `decision` | 接受 → 接受 | `decision` → `factual` | 400 → 接受 |
| `fact` | `fact` → `factual` | 400 → 接受 | `fact` → `factual` | 400 → 接受 |
| `insight` | `insight` → `factual` | 400 → 接受 | `insight` → `factual` | 400 → 接受 |
| `context` | `context` → `factual` | 400 → 接受 | `context` → `factual` | 400 → 接受 |
| `general` | `general` → `factual` | 400 → 接受 | `general` → `factual` | 400 → 接受 |

| 接口 | main | #462 | 本修复 |
|---|---|---|---|
| `POST /v1/memory` | 18 中 2 | 18 中 6 | 18 中 18 |
| `POST /v1/memories`（旧接口） | 18 中 0 | 18 中 0 | 18 中 18 |

修复前的拒绝全部出在 `memory_type` 上，现在一个也不剩。

## 对 RetainDB Local 实际运行

[`live-types.probe.mjs`](./live-types.probe.mjs) 针对 provider lab 中的 RetainDB Local 0.2.2 运行：即 [`provider-lab/`](../../../provider-lab/README.md) 的 `retaindb` 服务，使用 hash 向量，地址 `http://127.0.0.1:18990`。该容器原本处于停止状态，为这两次运行而启动，结束后再次停止，数据卷保持原样。

每次运行以用户 `rv462` 经真实 Source 把每个分类在重要度 1、3、5 下各写入一次，写进一个新的专用项目：#462 的驱动用 `rv462-type-before`，本修复用 `rv462-type-after`。正文不含 RetainDB Local 推断类型时查找的词，因此它会使用收到的类型。

| 分类 | 发送的类型，修复前 → 修复后 | 存下的类型（两次相同） | 重要度 1 / 3 / 5 存下的值（两次相同） |
|---|---|---|---|
| `preference` | `preference` → `preference` | `preference` | 0.636 / 0.836 / 0.99 |
| `decision` | `decision` → `decision` | `decision` | 0.644 / 0.844 / 0.99 |
| `fact` | `fact` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `insight` | `insight` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `context` | `context` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |
| `general` | `general` → `factual` | `factual` | 0.600 / 0.800 / 0.99 |

两次运行中，18 条记忆存下的类型与重要度完全相同，只有 RetainDB Local 记录的发送类型 `metadata.original_type` 变了。

## 旧接口写入与回执

**原因。** 旧接口 `POST /v1/memories` 声明 `async: z.boolean().optional().default(true)`（[`api/routes.ts:2594`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2594)）。只要请求体没有把它设为 false，Server 就会把写入排入队列，并以 202 返回 `mode: "async"` 与一个 `jobId`（[`:2606-2638`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2606-L2638)）。Provider 从未设置这个字段，回执却写着“RetainDB stored the memory synchronously.”。`POST /v1/memory` 不受影响：Provider 发给它的是 `write_mode: "sync"`，它会先存下再应答（[`api/memory.ts:1027-1033`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L1027-L1033)）。

**修复。**

- 旧接口的请求体现在带上 `async: false`（其 schema 声明了这个字段），Server 会先存下记忆再应答。
- 仍把写入排入队列的服务器会返回 `mode: "async"` 与任务 id（旧接口为 `jobId`，`/v1/memory` 为 `job_id`）。此时回执为 `action: "queued"` 并带上该 id。Memory Spaces Source 把排队的回执算作已接受、未提交（`plugins/dsh-mnemon-source-memory-spaces/src/service.ts` 中的 `mutationResultCompletion`），与 Hindsight、Supermemory 排队写入的处理相同。
- 在 RetainDB Server 上，已存下的回执现在也带上记忆的 id。它的同步应答在 `/v1/memory` 上把 id 放在 `memory_id`，在旧接口上只放在 `memory` 中；而 Provider 以前只读 `id`，只有 RetainDB Local 会发送这个字段。

**重放。** schema 重放现在复制了两个接口的 `async` 字段，并报告 Server 会如何写入每个被接受的请求体：

| 旧接口 `POST /v1/memories` | #462 | 本 PR，仅类型修复 | 本 PR |
|---|---|---|---|
| 被接受的请求体 | 18 中 0 | 18 中 18 | 18 中 18 |
| 应答前已存下 | 0 | 0（18 条全部排队） | 18 |

`POST /v1/memory` 与以前一样，在应答前存下全部 18 个被接受的请求体。

## 读回类型

**原因。** Provider 从 `memory_type` 读取记忆的分类，并把 RetainDB 的类型原样当作分类，所以列表中的记忆读回为 `factual` 或 `workflow`，而它们都不是 Memory Spaces 的分类。RetainDB Local 的检索结果把类型放在 `type` 中，与存下的 `memory` 并列（[`local/src/cli.ts:916-933`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L916-L933)），所以每条召回的记忆都读回为 `general`。

**修复。** 类型依次从 `memory_type`、`type` 读取，再像以前一样读 `category`。`preference` 与 `decision` 映射回对应分类，其他类型一律读作 `general`。

| RetainDB 返回 | 以前的分类 | 现在的分类 |
|---|---|---|
| 列表项，`memory_type: "decision"` | `decision` | `decision` |
| 列表项，`memory_type: "factual"` | `factual` | `general` |
| RetainDB Local 检索结果，`type: "preference"` | `general` | `preference` |
| RetainDB Local 检索结果，`type: "workflow"` | `general` | `general` |

测试按 RetainDB Local 自己的结构构造检索结果。

## 复现

修复后的列来自本分支，先运行 `pnpm build && pnpm -r build`。修复前的列需要先用 #462 的驱动构建 Provider，结束后再恢复：

```text
git show claude/fix-retaindb-importance-scale:plugins/dsh-mnemon-provider-retaindb/src/driver.ts > plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
node docs/pr-assets/retaindb-importance-scale/server-schema.probe.mjs <before.json>
node docs/pr-assets/retaindb-memory-type/live-types.probe.mjs http://127.0.0.1:18990 rv462-type-before <before.json>
git checkout -- plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
```

然后对修复运行同样的探针，实际运行使用 `rv462-type-after`。

```text
pnpm --filter dsh-mnemon-provider-retaindb exec vitest run     # 27 通过；用 #462 的驱动时，11 项新测试中有 10 项失败
pnpm --filter dsh-mnemon-provider-retaindb run typecheck
pnpm --filter dsh-mnemon-provider-retaindb run build
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run  # 296 通过，2 跳过
node scripts/verify-docs.mjs
```

新的单元测试检查：

- 每个分类、以及没有分类的请求发往每个接口的类型；
- 旧接口请求体中的 `async: false`；
- 任一接口排队的应答被报告为排队；
- RetainDB Server 同步应答中的 id；
- 从 RetainDB Local 结构的检索结果与列表中读回的分类。

用 #462 的驱动时，只有没有分类的那项测试通过，因为 Provider 那时本就发送 `factual`。

## 限制

- 没有运行 RetainDB Server，也没有使用托管服务。Server 的结论来自它自己的 schema，解析方式与 Server 相同。Cloud 没有实际观察到。
- 实际运行使用的是回执与读回修复之前的驱动。这两处修复都不改变 RetainDB Local 存下的内容：它的应答带有 `id` 而没有任务，Provider 在它上面也从不回退到旧接口。
- 两次实际运行写入的两个项目与 36 条记忆仍留在 lab 的存储中；lab 自己的 `dsh-lab` 项目保留其六条记忆。
