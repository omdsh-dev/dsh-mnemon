# 在 OpenViking 0.5.1 及更高版本上存入记忆：issue #455

[English](./README.md) | [Issue #455](https://github.com/omdsh-dev/dsh-mnemon/issues/455) | [验证记录](./verification.json)

Issue #455 报告：升级到 OpenViking 0.5.1.1 后，所有写入 OpenViking 记忆空间的操作都失败，报错为 `body.timeout: Extra inputs are not permitted`；而用服务端自带的 MCP `write` 工具写同一路径却正常。

基线为 main `a7e3bc54`。验证于 2026-10-23（Asia/Shanghai）进行，环境如下：

- macOS arm64，Node 24.19.0，pnpm 10.13.1；
- OpenViking 0.5.1.1，取自 PyPI，运行于 Python 3.12.13，dev 认证模式，仅监听本机回环地址；
- OpenViking v0.4.21，取自其 Docker 镜像，API Key 认证，仅监听本机回环地址。

两台服务端都使用 `text-embedding-ada-002` 向量（1,536 维），记忆均为合成数据。

## 原因

OpenViking 0.5.1 有两处改动影响到 Provider 的写入：

1. **去掉了 `timeout` 字段。** 自 0.4.16 起，每个版本的 `WriteContentRequest` 都拒绝未声明的字段，而 0.5.1 从中去掉了 `timeout`。Provider 发送的是 `uri, content, mode, wait, timeout`，因此每次写入都被 HTTP 400 拒绝。
2. **`written_bytes` 不再只算正文。** 0.5.1 会在每个记忆文件末尾追加一段保留的 `MEMORY_FIELDS` 尾注，并把它计入回复里的 `written_bytes`，公开读取接口仍只返回正文。Provider 要求 `written_bytes` 恰好等于正文的 UTF-8 长度，所以即使只发送已声明的字段，写入仍会被判为“未验证”。例如 26 字节的正文被报为 69 字节，其中 43 字节是尾注。

| 版本 | 写入接口声明的字段 | `written_bytes` 计入 |
|---|---|---|
| 0.4.16 | `uri content mode wait timeout telemetry processing_mode` | 正文 |
| 0.4.21 | 同上，另加 `tags tag_mode` | 正文 |
| 0.5.0 | 同上，另加 `acl` | 正文 |
| 0.5.1.1、0.5.2 | 不含 `timeout`；0.5.2 另加 `edit_source` | 正文加 `MEMORY_FIELDS` 尾注 |

## 修复

- **只发四个字段。** 写入只发送 `uri, content, mode: "create", wait: true`，这是 0.4.16 至 0.5.2 每个版本都声明的四个字段。等待时长由请求本身的期限（`requestTimeoutMs`）限定，与以前相同。0.4.x 在不带 `timeout` 时会等到索引完成，这与 0.5.x 的行为一致。超过期限仍不会给出已提交回执，报错中会附上需要检查的 URI。
- **放宽字节数校验。** `written_bytes` 从“必须等于正文长度”改为“不得少于正文长度”；少于正文仍按写入不完整处理。随后的精确读回必须返回所请求的原文，所以任何规范化或截断仍会像以前一样被拒绝。

## 结果

插件自带的可选回环集成测试会依次完成以下步骤：创建一条 137 字节的中英双语记忆，精确读回，通过检索和浏览找到它，然后删除并确认它已不存在。

| OpenViking | main | 只去掉 `timeout` | 修复 |
|---|---|---|---|
| 0.5.1.1 | 失败：`OpenViking refused the write … body.timeout: Extra inputs are not permitted` | 失败：`content API did not confirm this exact memory and completed indexing` | 通过：已存入，`vectorStatus: complete`，`tagsApplied: true`，已删除 |
| 0.4.21 | 通过 | — | 通过 |

中间一列是 issue 中提出的单独改法。正因为有尾注，这一步还不够。

Provider 的单元测试现在覆盖两代服务端：

- 一个按各版本已声明字段构造的严格服务端，分别模拟 0.4.16 和 0.5.1.1；后者连同其回复一起模拟，包括尾注字节、`queue_status` 与 `overview_status`；
- 一个计入尾注的字节数，只有在精确读回时才能通过；
- 配置的超时仍然限制请求，而请求体中不含 `timeout`。

在 main 上其中 4 项失败，修复后 85 项全部通过。

## 自动化检查

```text
pnpm --filter dsh-mnemon-provider-openviking exec vitest run     # 85 通过，1 跳过（集成测试需要服务端地址）
MNEMON_OPENVIKING_TEST_ENDPOINT=http://127.0.0.1:<port> \
  pnpm --filter dsh-mnemon-provider-openviking exec vitest run tests/integration.spec.ts   # 在 0.5.1.1 与 0.4.21 上通过
node scripts/verify-docs.mjs
```

## 限制

- 没有录制 WebUI。界面没有变化，Host 调用 Provider 时用的是与集成测试相同的 `remember`。
- OpenViking 0.5.2 只核对了源码（`WriteContentRequest` 声明同样的四个字段），没有实际运行。
