# OpenViking 记忆空间的精确文本关键词检索：issue #452

[English](./README.md) | [Issue #452](https://github.com/omdsh-dev/dsh-mnemon/issues/452) | [验证记录](./verification.json)

Issue #452 指出：OpenViking 记忆空间只能按语义检索，因此精确的编号、版本号、路径或错误码查找得不稳定，或者排在相近条目之后。而 OpenViking 本身就有精确文本接口 `POST /api/v1/search/grep`。

基线为 main `a7e3bc54`。验证于 2026-10-23（Asia/Shanghai）进行，环境如下：

- macOS arm64，Node 24.19.0，pnpm 10.13.1；
- OpenViking v0.4.21：取自 Docker 镜像，API Key 认证；
- OpenViking 0.5.1.1：取自 PyPI，运行在 Python 3.12.13 上，dev 认证模式。

两台服务端都只监听本机回环地址，使用 `text-embedding-ada-002` 向量（1,536 维），并在 `viking://user/wp452/memories` 下存放同样的 64 条合成记录：

- 一条 PostgreSQL 安装路径与服务名；
- 一条 Redis 记录、一条笔记本上的 Docker 记录；
- 一条带 SHA-256 的档案归档索引；
- 60 台只有数字不同的主机 `fleet-000` 至 `fleet-059`（`Docker Engine 29.8.<n>`）。

## 原因

无论 `mode` 是什么，Provider 都把检索发往语义接口 `search/find`。所以直接检索里的**关键词检索**，以及 `mode: "keyword"` 的 `mnemon_recall`，实际也按语义检索。在只有数字不同的记录之间，向量分不清 `29.8.37` 与 `29.8.36`。

## 修复

OpenViking 空间的关键词检索改走 `search/grep`：

- **请求字段。** 只发送 `uri`（该空间的记忆根）、`pattern`、`case_insensitive` 与 `node_limit`，这四个字段从 0.4.16 到 0.5.2 的每个版本都有声明。
- **拆词。** 查询按空白拆分，用双引号括起的短语保持完整。每个词都转义正则字符后按字面发送，匹配时忽略大小写。
- **完整单词。** 只有完整单词才算匹配：词的首尾若是 ASCII 字母或数字，相邻字符就不能也是字母或数字，因此 `29.8.5` 不会匹配 `29.8.50`。像中文这样不用空格分词的文字，出现在任何位置都算匹配。发给服务器的是不带边界条件的普通词，因为远程向量后端会把 pattern 当作词语做关键词召回；完整单词的判断由 Provider 自己完成。
- **排序与过滤。** 包含更多查询词的记忆排在前面，其余保持 grep 原来的顺序。记忆根以外的文件和 OpenViking 的系统文件（`.abstract.md`、`.overview.md`）会被排除。
- **结果内容。** 与语义检索一样读回完整记忆，结果不带分数。
- **特殊情况。** 尚未写入任何记忆的空间（记忆根还不存在）返回空结果；没有 `search/grep` 的服务器改用语义检索作答，并在结果提示里说明。
- **不变的部分。** 智能召回、基础匹配以及未指定模式的检索，仍与以前完全一样走语义检索。

档案归档在复用上次尝试留下的索引时，也会以关键词模式按内容哈希查找空间。在 OpenViking 上，这一查找现在是精确的：哈希按原文命中，归档在复用前仍会核对内容。Host 测试与 e2e 环境使用的协议 fixture，现在也像 OpenViking 一样应答 `search/grep`。

## 结果

### 逐个版本检索

对全部 60 台主机，以关键词模式检索 `29.8.<n>`，上限 10 条：

| 服务器 | main：精确主机排第一 | main：进入前 10 | main：未找到 | main：每次结果数 | 修复：精确主机排第一 | 修复：每次结果数 |
|---|---:|---:|---:|---:|---:|---:|
| v0.4.21 | 60 次中 34 次 | 56 | 4 | 10 | 60 次中 60 次 | 1.02 |
| 0.5.1.1 | 60 次中 34 次 | 56 | 4 | 9.03 | 60 次中 60 次 | 1.02 |

修复后多出的 0.02 来自 `29.8.0`：笔记本那条记录也写着这个版本。每次检索的平均耗时：main 为 942 ms 与 901 ms，修复后为 17 ms 与 12 ms。

### 五个查找

两台服务器上，下面五个查找的排名完全相同：

| 查询 | main（排名，结果数） | 修复（排名，结果数） |
|---|---|---|
| `postgresql-x64-18` | 1，10 | 1，1 |
| `29.8.37` | 3，8–10（`fleet-031`、`fleet-036` 在前） | 1，1 |
| `fleet-042` | 1，2–10 | 1，1 |
| 档案的 SHA-256 | 1，2–9 | 1，1 |
| `"D:\Program Files (x86)\PostgreSQL\18"` | 1，9 | 1，1 |

### 经记忆空间 Source 的直接检索

经 Source 以关键词检索查询 `29.8.37`：

- main 返回 10 条，全部判为 `high`，精确的主机排第三；
- 修复后只返回这台主机。

智能召回在修复前后返回同样的 10 条。

## 自动化检查

```text
pnpm --filter dsh-mnemon-provider-openviking exec vitest run     # 97 通过，1 跳过；在 main 上 14 项新测试中 13 项失败
pnpm --filter dsh-mnemon-provider-openviking run typecheck
pnpm --filter dsh-mnemon-provider-openviking run build
pnpm exec vitest run tests/openviking-host.spec.mjs tests/openviking-user-host.spec.mjs   # 4 通过；归档测试发出 3 次 grep
pnpm exec vitest run                                              # 2,818 通过，10 跳过
node scripts/verify-docs.mjs
```

新测试使用模拟 OpenViking grep 行为的 fixture 服务器，请求模型分别对应 0.4.16 与 0.5.1.1。覆盖的情形包括：

- 精确编号；
- 按字面匹配的版本号；
- 带引号的 Windows 路径；
- 完整单词；
- 中文；
- 按命中词数排序；
- 记忆根与系统文件的过滤；
- 结果上限；
- 空空间；
- 没有 `search/grep` 的服务器；
- 不变的语义模式。

## 限制

- 不带分数的结果在召回质量策略中算作 `unknown` 相关度。默认的 `strict-v1` 每次检索最多保留两条，模型召回每次尝试只放行一条。唯一的编号或版本号只需要一条；能匹配很多记忆的关键词会被这条策略截断，这正是 #454 讨论的问题。
- 没有录制 WebUI。直接检索页面本身没有变化，上面经 Source 的运行调用的是页面所用的同一个 `search` 操作。
