# Runtime 容量失败处理（#641）

**简体中文** | [English](./README.md)

验收日期：2026-11-15（Asia/Shanghai）。代码 revision：`e440b3a003a3bb647422c52bf4bd56b62174957a`；基于 main `36b341d7722efd2ceab80ba21e3f1c2c8924666b`，后续提交只添加证据。开发构建仍显示包版本 0.5.45；这里通过该代码 revision 和 [validation.json](./validation.json) 中的 bundle 摘要标识构建，不以版本标签作为证明。

## 发现与修改

普通 Source 容量 Error 会进入维护，但相同错误码变成普通对象后不会，因为 `sourceFailure` 要求 `instanceof Error`。普通 JSON 序列化还可能丢掉不可枚举的 `message`。修复按 Source 协议错误码识别普通对象和跨 realm 错误；必要时从校验过的容量数字重建说明，并在 Runtime 协调器及 RPC 保存入口返回可读错误。

路由失败与归档失败是两个结果。路由模型结束却未提交结构化结果时，仍使用原有的合格目标保底策略；成功回执保留解释。若后续归档步骤失败，错误会同时包含真实失败原因，以及最多三条有界、脱敏的路由诊断，不把失败或提交结果不确定的写入报成成功。

容量限制、存储格式、目标选择、Source 授权、回执校验、清理规则和模型预算均不变。不需要额外上下文时保留原有 Error 身份；聚合清理错误保留其原因和条目。不新增原始错误对象转储。

## 验证

- 完整 `pnpm run verify`：根测试 **2,801 通过、9 项条件跳过**；工作区插件测试 **899 通过、4 项条件跳过**。文档、类型、确定性构建、Headless 和打包验证通过。
- 官方 DSH **0.2.2-rc.1**：定向测试 **235 通过、1 项条件跳过**。
- 官方 DSH **0.2.2-rc.3**，完整已安装 Host 测试：**2,802 通过、8 项条件跳过**。
- 新增 21 项回归，覆盖带消息的序列化错误、普通 JSON Error 序列化、跨 realm Error、四种 Host 写入口、精确归档及待写数据提交、缺少路由结果、失败诊断、结构化取消，以及界面响应不转储额外私有字段。
- 真实官方 **0.2.2-rc.3 WebUI**，macOS arm64 / Node 24.22.2：5,625 字节的 USER 条目超过原有 4,096 字节上限，页面显示预计大小、当前大小、上限和维护原因，磁盘确认为零条记录。随后保存 93 字节的合成用户画像成功，磁盘中仅有这一条预期记录。

| 真实界面观察 | 证据 |
| --- | --- |
| 容量错误可读，未产生写入 | [截图](./capacity-error.jpg) |
| 后续正常保存成功 | [截图](./save-recovered.jpg) |

界面探针使用 USER 记忆验证共用的容量错误路径；自动化测试覆盖 MEMORY 超限时的命名工具、通用 Action、协调器回退及管理 RPC。这里没有复现报告者的确切 Windows Desktop 或模型环境，也未确认其模型为何漏交结果。Web 环境使用临时数据及本地模型 stub，此界面探针没有调用模型；未使用付费 API 或个人 Desktop 数据。

## 复现

```sh
VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=2 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=2 pnpm run verify
DSH_HOST_ROOT=<official-rc1-package> pnpm run test:installed-dsh tests/runtime-capacity-workflow.spec.ts tests/subagent.spec.ts --maxWorkers=2 --minWorkers=2
DSH_HOST_ROOT=<official-rc3-package> pnpm run test:installed-dsh --maxWorkers=2 --minWorkers=2
MNEMON_E2E_DSH=<official-rc3-bin> MNEMON_E2E_PORT=19641 node scripts/serve-e2e.mjs
```

使用可复用的 [serve-e2e.mjs](../../../scripts/serve-e2e.mjs)。在运行时记忆页向**用户画像**添加 `Synthetic capacity probe. ` 加 400 次 `durable-fact; `，观察拒绝后，再保存 `Synthetic verification: concise profile memory can be saved after a rejected oversized write.`。只检查隔离目录中的 `data/runtime/memories.json`，不直接编辑。最初的 12,625 字节探针被独立的 8,192 字节单条输入上限拒绝，不计作容量维护探针。
