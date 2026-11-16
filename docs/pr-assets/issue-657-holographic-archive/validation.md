# Holographic duplicate archive / Holographic 重复归档

The regression uses the actual Holographic Provider and Memory Spaces Source, a 512-byte Runtime store, one already archived exact copy and 25 higher-scored related facts. An ordinary named Runtime tool call must archive the existing entry and finish its pending add without a model call or duplicate stored fact.

回归使用实际 Holographic Provider、Memory Spaces Source 和 512 字节 Runtime 存储，预存一份完全一致的副本及 25 条检索得分更高的相关事实。普通 Runtime 工具调用必须完成归档和待写入操作，不调用模型，也不产生重复事实。

Before the fix, both the Provider receipt regression and the complete Host workflow fail. The Host reports:

修复前，Provider 回执回归与完整 Host 写入流程均失败，Host 报告：

```text
Automatic capacity maintenance failed: runtime archive skipped an entry without exact durable recall evidence ... its search returned 20 results, none with that exact text
```

After the fix, the receipt includes the existing ID and actual stored content. The Host's existing exact-content guard accepts it, Runtime contains the pending entry, and browsing the durable store still finds exactly one copy of the original. A differently cased string remains a distinct write. Retrying an exact duplicate does not change the stored bytes, trust or timestamps.

修复后，回执携带已有 ID 和实际已存原文，由 Host 原有的原文一致性校验接收。Runtime 中成功写入待写条目，持久存储中原事实仍只有一份。大小写不同的原文仍作为不同事实写入；完全重复的重试不会改变存储字节、可信度或时间戳。

Targeted commands / 定向命令：

```sh
pnpm --filter dsh-mnemon-provider-holographic verify
pnpm exec vitest run tests/runtime-capacity-workflow.spec.ts
```

Provider: 16 passed. Host capacity workflow: 150 passed, one optional real Native CLI test skipped. All data is synthetic and local; no credentials, external service or model API is used. Ranked recall and its trust filters are unchanged. This verifies the reported archival failure, not semantic recall quality.

Provider：16 项通过。Host 容量工作流：150 项通过，1 项可选真实 Native CLI 测试跳过。数据全部为本地合成数据，未使用凭据、外部服务或模型 API。排名检索与可信度筛选保持不变；此处验证所报归档故障，不评价语义召回质量。

Full repository verification / 全仓验证：`pnpm run verify` passed: 3,734 tests passed and 14 optional tests skipped, including the package, documentation and Headless checks. / 全部通过，包括打包、文档和 Headless 检查。
