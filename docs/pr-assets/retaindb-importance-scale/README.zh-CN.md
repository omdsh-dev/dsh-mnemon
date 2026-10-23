# RetainDB 重要度改用其 0-1 量纲

[English](./README.md) | [验证记录](./verification.json)

Memory Spaces Source 给每条记忆一个 1 到 5 的整数重要度，写入方没有给出时为 3。RetainDB Provider 把这个数原样发给 RetainDB，而 RetainDB 的重要度取 0 到 1。

基线为 main `a7e3bc54`。验证于 2026-10-23 与 2026-10-24（Asia/Shanghai）进行，环境为 macOS arm64、Node 24.19.0 与 pnpm 10.13.1。记忆均为合成数据。

证据包括：

- RetainDB 自身在 `2ad2cc4d` 的源码，涉及 RetainDB Server 与 RetainDB Local；
- 对 Provider 所发请求体的请求层面检查：单元测试，以及一个经真实 Memory Spaces Source 向本机回环记录器写入的探针；
- 用 RetainDB Server 自己的请求 schema 重放这些请求体；
- 在 main 与修复后，对 provider lab 中 RetainDB Local 0.2.2 的实际运行。

没有运行 RetainDB Server，也没有使用托管服务。RetainDB 的 README 把 Server 与 Cloud 放在一起介绍，作为围绕同一记忆模型的 API 层；Cloud 本身没有实际观察到。

## RetainDB 的接口约定

链接均指向 [RetainDB/RetainDB](https://github.com/RetainDB/RetainDB) 的 `2ad2cc4d`。

- **RetainDB Server**（`packages/server` 中可自行部署的 API）拒绝大于 1 的重要度。
  - `POST /v1/memory` 与旧接口 `POST /v1/memories` 都声明 `importance: z.number().min(0).max(1).optional().default(0.5)`（[`api/memory.ts:932`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/memory.ts#L932)、[`api/routes.ts:2588`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/api/routes.ts#L2588)）。
  - 两者都用 `@hono/zod-validator` 0.4.3 解析请求体，解析失败时返回 HTTP 400。
  - 数据库与写入路径的默认值都是 0.5（[`prisma/schema.prisma:230`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/prisma/schema.prisma#L230)、[`engine/memory/write.ts:707`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/engine/memory/write.ts#L707)）。
  - 其接口约定登记写明“importance must be between 0 and 1 when provided”（[`contracts/registry.mjs:351`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/server/src/contracts/registry.mjs#L351)）。
- **RetainDB Local 0.2.2** 默认 0.62。它存下 `clamp((importance ?? 0.62) + quality * 0.28 + typeWeight * 0.12, 0.1, 0.99)`，并把它计入每次召回的得分（[`local/src/cli.ts:728`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L728)、[`:904`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L904)）。重要度只要不小于 1，存下的就是 0.99。
- **RetainDB 自身的写入方**大致使用 0.5 到 0.9。
  - 其 SDK 的抽取发送 `max(0.5, min(1, confidence || 0.7))`（[`sdk/src/whisper-agent.ts:284`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/sdk/src/whisper-agent.ts#L284)）。
  - RetainDB Local 自己的写入使用 0.55 到 0.92（[`cli.ts:804`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L804)、[`:1838`](https://github.com/RetainDB/RetainDB/blob/2ad2cc4d6d58145eca1a6cbbce66dfc5b5380f38/packages/local/src/cli.ts#L1838)）。
  - 也有客户端默认发送 0.7，例如 Hermes Agent 的 RetainDB provider（[`plugins/memory/retaindb/__init__.py:148`](https://github.com/NousResearch/hermes-agent/blob/419e6627aaeda9c87e0b17bcc013484a2bfdb194/plugins/memory/retaindb/__init__.py#L148)）。

## 原因

- Source 发给每个 Provider 的重要度都是 1 到 5 的整数，写入方没有给出时为 3：`plugins/dsh-mnemon-source-memory-spaces/src/service.ts` 中的 `prepareRemember` 对 `remember` 与 `rememberMany` 都调用 `src/sdk/input.ts` 的 `integer(request.importance, 3, 1, 5)`。
- Provider 发送的是 `importance: request.importance ?? 0.7`。经过 Source 时重要度总会给出，所以 0.7 这个回退值从未生效，RetainDB 收到的是 1 到 5。
- **在 RetainDB Server 上**，main 中重要度为 2 到 5 的写入（包括 Source 的默认值 3）都被 HTTP 400 拒绝。它们并没有被压到最高值，而是根本没有存下。下文的重放说明了这一点。
- **在 RetainDB Local 上**，每条记忆都存为 0.99，召回时重要度不再能区分记忆。下文的实际运行说明了这一点。

## 修复

- `remember` 把 Source 的重要度映射到 RetainDB 自身写入方使用的 0.5 到 0.9：3 发送为 0.7，每高或低一档加减 0.1，并保留两位小数，所以 1 发送为 0.5，而不是 0.49999999999999994。
- 输入按 Holographic Provider 的方式读取（#459）：先取整到一档，再限定在 1 到 5，所以 9 发送为 0.9，2.4 发送为 0.6。不是有限数的值按没有重要度处理。Source 不会发送这两种值。
- 没有重要度的请求仍按 0.7 发送。只有不经 Source 直接调用 Provider 时才会出现这种请求。
- 旧接口 `POST /v1/memories` 的回退发送同样的值，因为它就是去掉 `write_mode` 的同一个请求体。
- 读回不做映射。Provider 读取检索与列表结果时不读重要度，只读 id、正文、分数、类型与创建时间，因此修复前后，召回与浏览都不显示 RetainDB 的重要度。
- RetainDB 中已有的记忆不会被改写。

| Provider 收到的重要度 | main 发送 | 修复后发送 |
|---|---|---|
| 1 | 1 | 0.5 |
| 2 | 2 | 0.6 |
| 3，也是写入方没有给出时 Source 发送的值 | 3 | 0.7 |
| 4 | 4 | 0.8 |
| 5 | 5 | 0.9 |
| 无（不经 Source 直接调用 Provider） | 0.7 | 0.7 |

## 经过 Memory Spaces Source

[`importance.probe.mjs`](./importance.probe.mjs) 挂载真实的 Memory Spaces Source 与 RetainDB Provider，让 RetainDB 连接一个本机回环记录器，由它应答 RetainDB 的项目与记忆接口。随后经 `remember` 写入三条记忆，记录每个 `POST /v1/memory` 请求体中的重要度。

| 记忆 | 写入的重要度 | main 发送 | 修复后发送 |
|---|---|---|---|
| Release notes are drafted on Monday | 1 | 1 | 0.5 |
| Release approvals need a completed canary | 5 | 5 | 0.9 |
| Release branches are cut from main | 无（Source 发送 3） | 3 | 0.7 |

## 用 RetainDB Server 的 schema 重放

[`server-schema.probe.mjs`](./server-schema.probe.mjs) 经真实的 Source 与 Provider，把每个 Memory Spaces 分类在重要度 1、3、5 下各写入一次，发往本机回环记录器。它运行两遍：一遍应答 `POST /v1/memory`，另一遍对它返回 404，让 Provider 回退到 `POST /v1/memories`。随后用 Server 针对该接口的请求 schema 解析每个请求体。schema 从 `api/memory.ts` 与 `api/routes.ts` 复制了 Provider 发送的字段，并在 Server 使用的 zod 3 API 上运行。

| 分类 | main 在 `/v1/memory`：1 / 3 / 5 | 修复后在 `/v1/memory`：1 / 3 / 5 |
|---|---|---|
| `preference`、`decision` | 接受 / 400 `importance` / 400 `importance` | 接受 / 接受 / 接受 |
| `fact`、`insight`、`context`、`general` | 400 `memory_type` / 400 `memory_type`、`importance` / 同上 | 每档都是 400 `memory_type` |

| 接口 | main 接受 | 修复后接受 |
|---|---|---|
| `POST /v1/memory` | 18 中 2 | 18 中 6 |
| `POST /v1/memories`（旧接口） | 18 中 0 | 18 中 0 |

现在重要度总能被接受。剩下的拒绝来自一个更早的、独立的缺陷：Provider 把 Source 的分类当作 RetainDB 的 `memory_type` 发送，而 Server 在 `/v1/memory` 上不接受 `fact`、`insight`、`context` 与 `general`，旧接口只接受 `factual`、`episodic`、`semantic` 与 `procedural`。这一映射在基于本 PR 的后续 PR 中修复。

## 对 RetainDB Local 实际运行

[`live.probe.mjs`](./live.probe.mjs) 针对 provider lab 中的 RetainDB Local 0.2.2 运行：即 [`provider-lab/`](../../../provider-lab/README.md) 的 `retaindb` 服务，使用 hash 向量，地址 `http://127.0.0.1:18990`。该容器原本处于停止状态，为这两次运行而启动，结束后再次停止，数据卷保持原样。

每次运行使用一个新的、专用的项目与用户 `rv462`：main 的驱动用 `rv462-main`，修复用 `rv462-fix`。每次运行依次：

1. 经真实 Memory Spaces Source 写入四条记忆。它们措辞与长度相同，RetainDB Local 给四条记忆的类型（`workflow`）与质量分（0.275）都一样，只有重要度不同；
2. 读回 RetainDB Local 存下的值；
3. 用 Provider 发出的同样请求检索 `release step check before tagging the version`；
4. 经 Source 检索同样的词。

| 写入的重要度 | main：存下的重要度 | 修复后：存下的重要度 |
|---|---|---|
| 1 | 0.99 | 0.661 |
| 3 | 0.99 | 0.861 |
| 5 | 0.99 | 0.99 |
| 无（Source 发送 3） | 0.99 | 0.861 |

RetainDB Local 给收到的每个重要度加上 0.161（质量分 0.275 × 0.28，加上 `workflow` 权重 0.7 × 0.12），再封顶为 0.99，所以修复后发送的 0.9 也到了上限。它的 `strength` 同样随重要度变化：main 上重要度 1 为 0.855，其余为 1；修复后分别为 0.605、0.705、0.805 与 0.705。

| RetainDB Local 的召回 | main：写入的重要度（得分） | 修复后：写入的重要度（得分） |
|---|---|---|
| 第 1 | 3（11.1374） | 5（11.0862） |
| 第 2 | 5（11.1118） | 3（10.9820） |
| 第 3 | 1（11.0614） | 无（10.8307） |
| 第 4 | 无（10.9846） | 1（10.8092） |

在 main 上，每条记忆都是 0.99，顺序由相关度的细微差别决定，重要度 1 的记忆还排在一条重要度 3 的记忆之前。修复后，存下的重要度决定了顺序：5 在最前，3 与“无”其次，1 在最后。

经过 Source 时，默认的 `strict-v1` 召回对得分不在 0 到 1 之间的结果最多保留两条，RetainDB Local 的得分正是如此。main 上返回的依次是 3 与 5，修复后依次是 5 与 3。这两次的得分比直接检索高 0.3386，因为直接检索先运行，提高了每条记忆的访问次数；RetainDB Local 会在下一次检索的得分上加上 `log1p(accessCount) / 5 + 1 / sqrt(max(1, hoursSinceAccess)) / 5`，这里是 0.1386 + 0.2。

## RetainDB Local 上的局限

- **内容丰富的正文会饱和。** RetainDB Local 加上的加成 `quality × 0.28 + typeWeight × 0.12` 随正文增长，而上限是 0.99。[`local-saturation.mjs`](./local-saturation.mjs) 把从 `cli.ts` 转录的 RetainDB Local 规则用于五段正文；第一段即实际运行探针的正文，得到的正是实际运行存下的值。

  | 正文（类型，质量分） | main：1 到 5 | 修复后：1 到 5 |
  |---|---|---|
  | Release step one: check the changelog before tagging the version（`workflow`，0.275） | 全部 0.99 | 0.661、0.761、0.861、0.961、0.99 |
  | The user prefers concise answers in Chinese.（`preference`，0.178） | 全部 0.99 | 0.636、0.736、0.836、0.936、0.99 |
  | Use pnpm 10 for installs because npm breaks the lockfile in CI.（`decision`，0.55） | 全部 0.99 | 0.748、0.848、0.948、0.99、0.99 |
  | Never push to main without a reviewed PR; the release workflow in .github/workflows/publish.yml must pass first.（`constraint`，0.685） | 全部 0.99 | 0.782、0.882、0.982、0.99、0.99 |
  | We decided to keep plain chunk retrieval and only add semantic signal where information is lost; the hybrid test passed on LoCoMo and LME.（`decision`，0.822） | 全部 0.99 | 0.824、0.924、0.99、0.99、0.99 |

  对这条内容丰富的决策，重要度 3、4、5 存下的都是 0.99。
- **之前存下的记忆保留 0.99。** main 写入 RetainDB Local 的记忆都是 0.99，召回时会计入得分，所以相关度相近时，它们会排在新记忆之前。原始重要度已在截断中丢失，改写它们只能靠猜测。

## 复现

修复列来自本分支，先运行 `pnpm build && pnpm -r build`。main 列需要先用 main 的驱动构建 Provider，结束后再恢复：

```text
git show origin/main:plugins/dsh-mnemon-provider-retaindb/src/driver.ts > plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
node docs/pr-assets/retaindb-importance-scale/importance.probe.mjs <main.json>
node docs/pr-assets/retaindb-importance-scale/server-schema.probe.mjs <main.json>
node docs/pr-assets/retaindb-importance-scale/live.probe.mjs http://127.0.0.1:18990 rv462-main <main.json>
git checkout -- plugins/dsh-mnemon-provider-retaindb/src/driver.ts
pnpm --filter dsh-mnemon-provider-retaindb run build
```

然后对修复运行同样的探针，实际运行使用 `rv462-fix`。`live.probe.mjs` 会拒绝 RetainDB Local 中已有的项目，因为 RetainDB Local 遇到重复的记忆时会返回或合并已有的那条，而不会再存一次。

```text
pnpm --filter dsh-mnemon-provider-retaindb exec vitest run     # 16 通过；用 main 的驱动时，9 项新测试中有 8 项失败
pnpm --filter dsh-mnemon-provider-retaindb run typecheck
pnpm --filter dsh-mnemon-provider-retaindb run build
pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run  # 296 通过，2 跳过
node docs/pr-assets/retaindb-importance-scale/local-saturation.mjs
node scripts/verify-docs.mjs
```

新的单元测试检查：

- 重要度 1 到 5 时发送的完整请求体；
- 没有重要度的请求发送 0.7；
- 取整到一档并限定在 1 到 5；
- 不是有限数的值按没有重要度处理；
- 旧接口收到同样的重要度。

用 main 的驱动时，没有重要度的那项测试也通过，因为 main 在这种情况下同样发送 0.7；其余八项失败。

## 限制

- 没有运行 RetainDB Server，也没有使用托管服务。Server 的结论来自它自己的 schema，解析方式与 Server 相同。Cloud 没有实际观察到。
- 实际运行使用 provider lab 为 RetainDB Local 配置的 hash 向量。运行写入的两个项目与八条记忆仍留在 lab 的存储中；lab 自己的 `dsh-lab` 项目保留其六条记忆。
- 没有录制 WebUI。界面没有变化，修复前后 RetainDB 的记忆都不显示重要度。
