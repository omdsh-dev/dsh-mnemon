# 不同 Provider 分数尺度不一致时的召回：issue #454

[English](./README.md) | [Issue #454](https://github.com/omdsh-dev/dsh-mnemon/issues/454) | [验证记录](./verification.json)

Issue #454 报告：跨 Hindsight 与 OpenViking 召回时，正确答案被丢掉。Hindsight 给正确答案打了 1.04 分，Source 把它判为“未知”；OpenViking 约 0.7 分的弱相关结果反而排在它前面。

本次改动按这两个 Provider 的分数实际衡量的东西来解读它们。其他 Provider，以及不涉及它们的召回，行为与 main 完全相同。

基线为 main `a7e3bc54`。本次验证于 2026-10-24（Asia/Shanghai）进行，环境如下：

- macOS arm64，Node 24.19.0，pnpm 10.13.1，Mnemon CLI 0.2.12；
- Hindsight 0.10.1，来自 `provider-lab`，使用其本地 embedding 与 reranker，以及已播种数据的 `dsh-lab` bank；
- OpenViking v0.4.21，使用 `text-embedding-ada-002`。一个账号中放入四条不相关的合成记录；另一个用户下放入 LoCoMo 对话 `conv-26`，用于名次研究。

所有服务都只监听本机回环地址。记忆空间 Source 与三层策略通过 `MemoryCompositionRunner` 运行，挂载真实的 Provider，以 smart 模式检索。

## 原因

- **Hindsight 的分数会超过 1。** 它的 `scores.final` 在相关度之上叠加了 reranker 与时效加成。对 #454 的查询，它返回的 8 条结果中有 6 条超过 1，正确答案为 1.091；不相关查询约为 0.00002。main 把超过 1 的分数判为 unknown：排在所有高、中档结果之后，每次检索最多两条，三层策略每次尝试只接纳一条。
- **OpenViking 的分数无法区分相关与否。** 它透传原始的 embedding 相似度。用 ada-002 时，无论是否相关，每条结果都在 0.66 以上，默认分档会把它们全部判为高相关。与其他 Provider 一起检索时，不相关的 OpenViking 结果会占据与已校准证据相同的位置。

## 修复

- **Hindsight** 保留归一化相关度。它的适配器声明 `scale: 'boosted'`，超过 1 的分数在所有策略中都按 1 计。其余分数照旧分档，所以不相关的结果仍是低分并被丢弃。
- **OpenViking** 声明 `scale: 'embedding-similarity'`。检索同时覆盖其他 Provider、且两个阈值都是默认值时，`strict-v1` 按 OpenViking 自己的顺序保留它的结果（`relevanceTier: ranked`）：
  - 排在高相关结果之后、中相关结果之前；
  - 每次检索最多 `recallQuality.maxRankedResults` 条，这是一个新设置，默认为 2；
  - 不带分数的关键词匹配也计入其中。

  三层策略像对待高相关结果一样接纳 ranked 结果。只检索 OpenViking、把任一阈值改离默认值，以及 `balanced-v1` 与 `exhaustive-v1`，都仍按原方式为 OpenViking 的结果分档。
- **其余一切与 main 相同。**
  - Mem0、Supermemory、RetainDB、ByteRover 与 Honcho 的声明不变。
  - 判定原因与质量统计不变；`unscaled` 也统计 ranked 的 OpenViking 结果。
  - Host 的检查与 main 相同：召回读取适配器的分数语义，只有 Manifest 声明了归一化分数而适配器没有报告时才拒绝加载。

## 为什么最多两条 OpenViking 结果

OpenViking 的分数说明不了它是否有答案，所以与其他 Provider 一起检索时，只有它的顺序可信。名次研究用适配器发出的同一请求，对 `conv-26`（419 轮对话，每轮一条记忆）的 152 个可回答问题与 47 个不可回答问题进行了检索：

| 首条证据出现在 OpenViking 的前几名 | 1 | 2 | 4 | 10 | 20 |
|---|---|---|---|---|---|
| 可回答问题 | 60（39%） | 74（49%） | 96（63%） | 117（77%） | 131（86%） |

- **分数。** 证据所在结果为 0.763 至 0.909（中位数 0.841）；不可回答问题的首条结果为 0.795 至 0.897（中位数 0.841）。没有阈值能区分二者，而且在默认分档下全部是高相关。
- **取舍。** 第三、第四条会多覆盖 152 个答案中的 22 个（63% 而非 49%）；但在每次 OpenViking 没有答案的召回中，它们也会多带进两条不相关结果，并把已校准的中相关结果继续往后挤。策略的首次尝试只容纳四条，两条为其他空间留出了位置。
- **单独检索不设上限。** 只检索 OpenViking 时按 main 的方式分档，首次尝试保留它的前四条（这里为 63%）。

## 真实 Provider 上的结果

先做 Source 检索，再在一个新的回合中通过三层策略做一次 Agent 召回。

| 场景 | main | 修复后 |
|---|---|---|
| #454 查询，Hindsight 与 OpenViking，上限 4 | 4 条不相关的 OpenViking 记录，全部为高（0.664 至 0.687）；Hindsight 8 条中 0 条入选 | **4 条 Hindsight 结果，全部为高，正确答案（1.091）排第一**；Agent 拿到同样的 4 条 |
| 不相关查询，Hindsight 与 OpenViking，上限 4 | 4 条不相关的 OpenViking 记录，全部为高；Hindsight 8 条全部作为低分丢弃 | 2 条 OpenViking 记录，ranked；Hindsight 8 条全部作为低分丢弃 |
| 与 Hindsight 无关的查询，Native 与 Hindsight，上限 6 | 4 条 Native 结果（2 高、2 中）；Hindsight 8 条全部丢弃 | 相同 |
| 同上，再加 OpenViking，上限 6 | 2 条 Native 高相关与 4 条不相关的 OpenViking 记录；两条 Native 中相关结果都被挤掉。Agent：2 条 Native、2 条 OpenViking | 2 条 Native 高相关、2 条 OpenViking ranked、2 条 Native 中相关。Agent：3 条 Native、1 条 OpenViking |
| #454 查询，使用报告者的阈值（0.67 与 0.78） | 3 条不相关的 OpenViking 记录与一条较弱的 Hindsight 结果，全部为中；正确答案没有进入检索结果。Agent：1 条 OpenViking 记录与作为 unknown 的正确答案 | **4 条 Hindsight 结果，全部为高，正确答案排第一**；OpenViking 按这组阈值分档 |
| #454 查询，只检索 OpenViking，上限 4 | 4 条 OpenViking 记录，全部为高 | 完全相同 |

两条查询分别是“新建记忆空间时，由谁、按什么规则选择 Provider？”与“Which espresso machine does the kitchen use?”（厨房用的是哪台咖啡机？）。Native 空间中有六条关于厨房的合成记录；验证记录列出了每一条结果。

## 测试

- **策略测试**（`plugins/dsh-mnemon-source-memory-spaces/tests/recall-quality.spec.ts`）：
  - #454 中的那组结果；
  - ranked 结果排在高相关之后、中相关之前，上限分别为 2、4 与 0，其中包含一条不带分数的关键词匹配；
  - 只检索 OpenViking、使用报告者的阈值，以及 `balanced-v1` 与 `exhaustive-v1` 下，OpenViking 仍按原方式分档；
  - 带加成且超过 1 的分数在所有策略中都按 1 计；
  - 评审中的场景：Native 加不相关的 Hindsight 结果、Native 加 Honcho、只检索 Hindsight，以及 Native 的中相关答案。每个场景选出的结果都与 main 相同。
- **逐字节一致。** 400 次确定性的召回，其中没有超过 1 的 Hindsight 分数，也没有 ranked 的 OpenViking 结果。候选上限、每条判定及其原因、选择结果都与冻结的 main 三个策略副本完全一致。
- **Source 测试**（`tests/service.spec.ts`）以真实适配器配合模拟的 HTTP 响应，覆盖：#454 的情形、报告者的阈值、Native 加不相关的 Hindsight 结果、只检索 Hindsight，以及超过 1 的 Native 分数。
- **Provider 语义**（`tests/provider-conformance.spec.ts`）固定每个内置 Provider 的 Manifest 与适配器声明。Host 测试（`tests/provider-sdk.spec.ts`）保持 main 的优先级：Manifest 声明了归一化分数而适配器没有报告时拒绝，适配器自己的声明则照常生效。
- **三层策略测试**（`plugins/dsh-mnemon-strategy-default-three-tier/tests/retrieval.spec.ts`）：ranked 结果像高相关结果一样被接纳，未知结果每次尝试一条。
- **在 main 上** 记忆空间的 310 项测试中有 8 项失败。Host 测试在 main 上通过，因为它固定的正是 main 的优先级；策略测试同样通过，因为策略本来就把它不认识的档位当作高相关接纳。

## 限制

- **#454 仍保持打开。** 按 Provider 分别配置阈值，以及为超出范围的分数单独给出原因，不在本次改动之内，所以 PR 只引用 #454，不关闭它。
- **其他 Provider。** Mem0、Supermemory、RetainDB 与 ByteRover 不变，没有测量它们的分数尺度。
- **WebUI。** 它的检索使用同一策略。阈值为默认值时，跨空间检索最多显示两条 OpenViking 结果，正如中相关与未知量纲结果也受各自的条数限制；只检索 OpenViking 空间时，仍与以前一样全部显示。没有页面展示档位，也没有录制。
