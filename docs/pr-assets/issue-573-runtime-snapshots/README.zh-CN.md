# Runtime 快照历史验证

**简体中文** | [English](./README.md)

Issue：[#573](https://github.com/omdsh-dev/dsh-mnemon/issues/573)。基线：`0db25213d128dfeb420163de20fd41a787366c87`，dsh-mnemon 0.5.41。2026-11-06 使用 Node 24.22.2 执行。全部数据为合成数据，适配器只脚本化模型选择，不调用外部模型或付费 API。

## 观察结果

修复前，真实 DSH 适配器在首轮、一次投影更新、一次不变回合和 JSONL 会话恢复中，收到的快照数量依次为 `1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3`。回归测试因每次请求应只有一份完整快照而失败。

修复后，三次投影修订、一个不变回合和 JSONL 恢复共生成 15 次请求，每次恰好一份完整快照；追加式审计日志恰好保留三份完整快照。内容不变时，包括恢复后，不再追加快照。工具续步维持同一个已固定的 View。

另一个旧快照积压恢复测试，逐字保留用户文本、普通 Mnemon 召回、指导和其他生产者的完整快照，只淘汰三份符合条件的 Mnemon 快照；每份对应一个带 `sourceEventSeqs` 的单节点替换。实际适配器请求中没有 Mnemon developer 消息。单元测试还覆盖不完整或被引用的旧文本保持原样，以及当前投影超过 13,000 个字符时仍完整保留字面内容。

## 公开 Host 契约

实现使用已发布的 Session `append()`、`surfaceOp: { op: 'replace', startSeq, endSeq }` 和 `sourceEventSeqs`；每个替换范围只包含一个属于本插件的快照。空内容 `developer/message` 是公开 Session 支持的、不会派生出模型消息的表示。这些记录不含指导、记忆文本或工具变更；当前完整快照仍是 user 角色的数据。

淘汰记录在公开 `agent/request` waterfall 中提交，位于 `step/start` 之后、请求构建之前。这个顺序满足持久 Session codec 对 developer 记录必须属于已打开 step 的要求。实现不改写请求对象或上游源码。恢复时，Host 先从 JSONL 重建替换结果，再发出下一次适配器请求。

新快照使用 `source.kind: dsh-mnemon`、`source.form: memory-snapshot`。旧 `recall` 消息只有在相同生产者的单个文本块中包含完整内置 Runtime 格式时才可被淘汰，包括 0.5.34 的 revision/容量标题和当前标题。任意召回及无法识别的历史格式保持原样。记忆存储、投影预算、grant 和工具权限不变。

## 验证

| Host | 命令范围 | 结果 |
|---|---|---|
| 已发布 0.2.1-rc.5 | `pnpm run verify` | 通过；根测试 2557 通过、8 项条件跳过；工作区测试、确定性构建、Headless 激活/重启及发布包检查通过 |
| 已发布 0.2.0-rc.2 | 经 `scripts/installed-dsh.config.ts` 运行 `tests/memory-snapshot.spec.ts`、`tests/turn-view-host.spec.ts` | 14 通过 |
| 已发布 0.2.1-rc.3 | 同一组已安装 Host 测试 | 14 通过 |
| 已发布 0.2.2-rc.1 | 同一组已安装 Host 测试 | 14 通过 |
| 已有 master 构建 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | 对其已构建包运行相同验收测试 | 14 通过；源码 checkout 未修改 |

Vite 对已发布包输出缺失 source-map 警告；PTC 夹具还输出 Node TypeScript stripping 实验性警告。这些是已有依赖诊断，测试没有失败。需要外部服务、凭据、原生 CLI 或特定平台行为的条件测试仍按原有开关跳过。

没有使用生产记忆、用户预览 profile 或外部 API。此测试验证真实 JSONL codec 的卸载/重新加载，不声称完成 Windows Electron 进程重启，也没有复刻报告者私有的 1,206 回合会话。历史审计文件及空 surface 节点仍是追加式记录。回滚插件后，Host 仍可读取日志，但旧插件可能再次积累快照。
