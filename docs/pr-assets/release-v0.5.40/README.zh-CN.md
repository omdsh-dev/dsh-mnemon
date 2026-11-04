# v0.5.40 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-04（Asia/Shanghai）**使用官方已发布 DSH、隔离 Web profile、合成记忆和冻结候选验收。五个 Host 各执行全新“添加插件”安装及真实 npm **0.5.39 → 0.5.40** 升级，**十个场景全部通过**。

## 结果

| DSH | 全新安装 | 升级前 | 提供更新 | 安装完成、待重启 | 重启后 | 记忆保留 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [状态](./020-fresh-status.jpg) | [记忆](./020-upgrade-memory-before.jpg) | [更新提示](./020-upgrade-offered.jpg) | [已更新](./020-upgrade-updated.jpg) | [状态](./020-upgrade-restarted-status.jpg) | [记忆](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [状态](./rc2-fresh-status.jpg) | [记忆](./rc2-upgrade-memory-before.jpg) | [更新提示](./rc2-upgrade-offered.jpg) | [已更新](./rc2-upgrade-updated.jpg) | [状态](./rc2-upgrade-restarted-status.jpg) | [记忆](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [状态](./rc3-fresh-status.jpg) | [记忆](./rc3-upgrade-memory-before.jpg) | [更新提示](./rc3-upgrade-offered.jpg) | [已更新](./rc3-upgrade-updated.jpg) | [状态](./rc3-upgrade-restarted-status.jpg) | [记忆](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [状态](./rc5-fresh-status.jpg) | [记忆](./rc5-upgrade-memory-before.jpg) | [更新提示](./rc5-upgrade-offered.jpg) | [已更新](./rc5-upgrade-updated.jpg) | [状态](./rc5-upgrade-restarted-status.jpg) | [记忆](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [状态](./rc1-fresh-status.jpg) | [记忆](./rc1-upgrade-memory-before.jpg) | [更新提示](./rc1-upgrade-offered.jpg) | [已更新](./rc1-upgrade-updated.jpg) | [状态](./rc1-upgrade-status.jpg) | [记忆](./rc1-upgrade-memory-preserved.jpg) |

所有 UI 场景使用 **Node 24.22.2**；源码验证使用 **Node 22.22.0**，旧版 Host 继续由 CI 覆盖 Node 22.19。DSH 0.2.2 的支持目标现为官方 **RC1**，不再对 alpha 进行兼容。RC1 Host 要求 Node >=24.9.0，详见[兼容策略](../../zh-CN/reference/compatibility.md)。

- 完整工作区验证：根测试 **2498 通过、7 项按条件跳过**；组件测试 **753 通过、3 项按条件跳过**；构建、类型、文档、包内容和公开入口检查均通过。
- 独立制品：**18 个插件仓库、19 个制品**通过独立测试、构建以及实际 Host 安装和激活检查，包括同时启用全部可选策略。
- 收敛支持策略后，**20 项清单准入测试**通过。
- 每个 UI 安装的 **19 个固定版本**和四个变更候选中的 **126 个文件及可执行位**全部匹配。最后另行只读检查十个 profile，合计 **190 个包版本、1260 个候选文件**一致。
- 每次升级在安装前、安装后和重启后，`memories.json`、`MEMORY.md`、`USER.md` 的 SHA-256 均相同；重启后的页面实际运行 0.5.40，合成记忆可见。0.2.0-rc.2 与 0.2.1-rc.2 场景还验证了非空用户画像保留。
- Starter 共 **68 个文件**，压缩后 **533,063 字节**，解包后 **2,239,100 字节**，占 3,000,000 字节上限的 **74.6%**，无需提高上限。

## 候选与步骤

冻结候选为 Starter **0.5.40**、Documents **0.5.13**、Skills **0.5.7**、分层策略 **0.5.12**；其余十五个组件使用 npm 已发布的不可变版本。Documents 要求 Root **^0.5.40**，Starter 精确锁定十八个组件。[validation.json](./validation.json) 保存完整版本组合、候选 SHA-256/SHA-512、文件摘要和汇总结果。逐 Host 记录：[0.2.0-rc.2](./020-validation.json)、[0.2.1-rc.2](./rc2-validation.json)、[0.2.1-rc.3](./rc3-validation.json)、[0.2.1-rc.5](./rc5-validation.json)、[0.2.2-rc.1](./rc1-validation.json)。

1. 构建并冻结四个变更包。`scripts/serve-release-acceptance.mjs` 在临时 registry 中仅覆盖这四个候选，其余元数据来自真实 npm；每个场景使用独立工作区、数据目录和 DSH profile。
2. 全新 profile：经**插件 → 添加插件 → dsh-mnemon → 立即启用**，在**记忆系统 → 状态**确认运行 0.5.40。
3. 升级 profile：先安装真实 npm `dsh-mnemon@0.5.39`，通过 UI 写入合成 Runtime 记忆并记录文件摘要。执行**检查版本 → 更新**，确认待重启状态及安装文件，重启 fixture 后检查运行版本、记忆和文件摘要。
4. 使用 CUA 操作实际 UI，逐张检查三十张截图，然后关闭测试页面及所有 fixture；未使用个人 Desktop profile 或付费模型账号。

执行命令如下；`NODE24_BIN`、`DSH_BIN`、`ARTIFACTS`、`STATE` 指向隔离测试资源：

```sh
pnpm install --offline --frozen-lockfile
pnpm run verify
env -u NODE_PATH PATH="$NODE24_BIN:$PATH" MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 node scripts/verify-plugin-artifacts.mjs --skip-build --keep
pnpm exec vitest run tests/dsh-host-compatibility.spec.ts
pnpm release:check
node scripts/verify-docs.mjs
env -u NODE_PATH "$NODE24_BIN/node" scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$STATE"
# 升级场景使用另一空状态目录：
env -u NODE_PATH "$NODE24_BIN/node" scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$STATE" --previous dsh-mnemon@0.5.39
```

## 观察与边界

RC1 首次检查版本出现临时元数据请求错误，随后连接探测恢复，通过 UI **重新检查**正确提供更新并完成升级，没有修改产品代码。重启时出现预期的断连警告；最终浏览器控制台错误数为零。

本次验证覆盖官方已发布 Host 及隔离 Web UI，不代表原生 Desktop 系统集成、任意未发布源码构建或真实云 Provider 的服务质量。十项可选测试需要额外 CLI、模型或 Provider 环境，按条件跳过。旧 alpha 验收仅保留为历史记录，alpha 不再是兼容适配或 CI 目标。

候选的元数据时间仅在测试 registry 中提前，以便候选不被最短发布年龄策略隐藏；这些场景不验证该 npm 策略。此处摘要对应发布前的 UI 候选。发布流水线会另外冻结最终合并版本并校验制品，按依赖顺序发布变更包，完成真实 npm 安装和升级后才创建 Release。
