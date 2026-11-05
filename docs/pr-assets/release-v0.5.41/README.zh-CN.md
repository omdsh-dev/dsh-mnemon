# v0.5.41 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-05（Asia/Shanghai）**使用隔离 profile 与合成数据验证。**十二个场景通过：**五个官方 Host 各自全新安装及从真实 npm **0.5.40 → 0.5.41** 升级，另加 #554 报告的精确、未经修改的源码 commit。未调用付费模型，也未使用个人 Desktop 数据。

## 官方 Host 结果

| DSH | 全新安装 | 升级前 | 发现更新 | 安装完成、待重启 | 重启后 | 记忆保留 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [状态](./020-fresh-status.jpg) | [记忆](./020-upgrade-memory-before.jpg) | [更新提示](./020-upgrade-offered.jpg) | [已安装](./020-upgrade-updated.jpg) | [状态](./020-upgrade-restarted-status.jpg) | [记忆](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [状态](./rc2-fresh-status.jpg) | [记忆](./rc2-upgrade-memory-before.jpg) | [更新提示](./rc2-upgrade-offered.jpg) | [已安装](./rc2-upgrade-updated.jpg) | [状态](./rc2-upgrade-restarted-status.jpg) | [记忆](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [状态](./rc3-fresh-status.jpg) | [记忆](./rc3-upgrade-memory-before.jpg) | [更新提示](./rc3-upgrade-offered.jpg) | [已安装](./rc3-upgrade-updated.jpg) | [状态](./rc3-upgrade-restarted-status.jpg) | [记忆](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [状态](./rc5-fresh-status.jpg) | [记忆](./rc5-upgrade-memory-before.jpg) | [更新提示](./rc5-upgrade-offered.jpg) | [已安装](./rc5-upgrade-updated.jpg) | [状态](./rc5-upgrade-restarted-status.jpg) | [记忆](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [状态](./rc1-fresh-status.jpg) | [记忆](./rc1-upgrade-memory-before.jpg) | [更新提示](./rc1-upgrade-offered.jpg) | [已安装](./rc1-upgrade-updated.jpg) | [状态](./rc1-upgrade-restarted-status.jpg) | [记忆](./rc1-upgrade-memory-preserved.jpg) |

全新场景通过**插件 → 添加插件 → 立即启用**完成安装。升级场景先安装真实 npm 旧版，通过界面创建合成 Runtime 记忆，再用**状态 → 检查版本 → 更新**并重启 Host。每个最终 profile 均匹配 **19 个固定版本，以及两个变化包的 98 个文件和执行位**。每次升级的三个 Runtime 文件（`memories.json`、`MEMORY.md`、`USER.md`）在安装前、安装后及重启后哈希相同。

## 精确源码版故障恢复

额外 Host：**`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**，包版本 0.2.2-rc.1，界面版本 0.2.2-rc.1-fcc0ad4；源码工作树始终干净。

| 步骤 | 证据 |
| --- | --- |
| 通过添加插件全新安装 0.5.41，启用并正常运行 | [状态](./master-fresh-status.jpg) |
| 真实 npm 0.5.40 复现 `agents.roots` 启动错误及 HTTP 405 页面故障 | [故障页](./master-upgrade-before-failure.jpg) |
| 在全新界面创建合成工作记忆与用户画像，用于保留检查 | [合成数据](./master-canary-fixture.jpg) |
| 精确版本 CLI 更新及完整重启后恢复 0.5.41 页面 | [恢复后的状态](./master-upgrade-restarted-status.jpg) |
| 重启后两条记录可读，三个文件哈希不变 | [保留的记忆](./master-upgrade-memory-preserved.jpg) |

旧页面无法创建或读取记忆，因此将上述界面生成的两条合成记录对应的三个 v1 Runtime 文件，复制到隔离的故障 profile 后记录基线哈希。通过公开的 **`dsh plugin --profile web add dsh-mnemon@0.5.41`** 命令及夹具 registry 更新，随后完整重启。命令退出码 0，两条记录恢复可读，所有包、文件与哈希检查通过。这验证了报告者所指 commit 的恢复路径，未在其原 Windows 机器上复验。[详细源码记录](./master-validation.json)。

## 验证与制品

- Node **24.22.2**、macOS arm64：完整 `pnpm run verify` 通过，**根测试 2,550 passed / 8 条件跳过**，**工作区 759 passed / 3 条件跳过**；文档、类型、确定性构建、Headless 激活及包检查均通过。
- 独立制品：**18 个插件仓库及 19 个打包制品**通过独立类型、测试、构建与真实 Host 激活，包括可选策略。
- 最终合并代码在固定 master 上：**根测试 2,550 passed / 8 条件跳过**，170 个测试文件通过、2 个跳过。PR CI 继续保留官方 Host 与 Windows 工作区检查。
- **35 张截图**均经过视觉检查与 SHA-256 核对。各最终 profile 共核对 **228 个包版本、1,176 个候选文件及执行位**；六次升级均保留 Runtime 哈希。重新打开的应用页面控制台错误为零。
- Starter：**68 个文件，打包 539,290 字节，解包 2,262,379 字节**，占 3,000,000 字节上限的 **75.4%**，无需调整上限。

冻结 UI 候选来自 **`444473f839759961573a922474c9398c1bb42663`**：Starter **0.5.41** 与 Skills **0.5.8**。其余十七个组件采用不可变的 npm 版本；Starter 精确固定十八个组件。[validation.json](./validation.json)记录组合、摘要及汇总结果；逐 Host 记录：[020](./020-validation.json)、[rc2](./rc2-validation.json)、[rc3](./rc3-validation.json)、[rc5](./rc5-validation.json)、[rc1](./rc1-validation.json)。

复用夹具为 [`scripts/serve-release-acceptance.mjs`](../../../scripts/serve-release-acceptance.mjs)，以下路径变量均指向隔离资源：

```sh
pnpm run verify
MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build
DSH_HOST_ROOT="$DSH_SOURCE/apps/cli" pnpm run test:installed-dsh
pnpm release:check
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$FRESH_STATE"
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$UPGRADE_STATE" --previous dsh-mnemon@0.5.40
```

## 观察与边界

部分重启后，内置浏览器无法导航到新的 `127.0.0.1` 端口，但独立正常认证请求依次得到 HTTP 303、200；同一 Host 与 token 使用其支持的 `localhost` 地址后可正常打开。浏览器根因未确定，未修改认证设置或用户 cookie。所有夹具与 Host 进程均已停止，正常测试标签已关闭；浏览器工具的 URL 策略拒绝关闭四个自动生成的错误页标签，这些未标记标签依赖正常的回合结束清理。

本次覆盖 macOS 上的官方 Web profile 及额外精确源码 commit，不涵盖原生 Desktop 系统集成、报告者的 Windows 机器、任意 master/alpha 或云端模型质量。此前的真实模型证据及明确限制仍见[任务兼容记录](../dsh-master-agents/README.zh-CN.md)。

仅在夹具 registry 内调整候选版本发布时间，因此不验证 npm 的最短发布等待策略。这些是发布前候选：正式 workflow 会从最终合并 revision 重新冻结制品、按依赖层发布，并验证真实 npm 安装与升级后才创建 GitHub Release。
