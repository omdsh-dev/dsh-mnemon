# v0.5.42 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-06（Asia/Shanghai）**使用独立 profile 和合成数据验证。**十二个场景通过：**五个官方 Host 及 #554 所指的未修改源码 commit，分别完成全新安装和从真实 npm **0.5.41 → 0.5.42** 升级。未使用个人 Desktop 数据或付费模型调用。

## 安装与升级结果

| DSH | 全新安装 | 升级前记忆 | 提供更新 | 已安装待重启 | 重启后 | 保留记忆 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [状态](./020-fresh-status.jpg) | [记忆](./020-upgrade-memory-before.jpg) | [更新](./020-upgrade-offered.jpg) | [安装](./020-upgrade-updated.jpg) | [状态](./020-upgrade-restarted-status.jpg) | [记忆](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [状态](./rc2-fresh-status.jpg) | [记忆](./rc2-upgrade-memory-before.jpg) | [更新](./rc2-upgrade-offered.jpg) | [安装](./rc2-upgrade-updated.jpg) | [状态](./rc2-upgrade-restarted-status.jpg) | [记忆](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [状态](./rc3-fresh-status.jpg) | [记忆](./rc3-upgrade-memory-before.jpg) | [更新](./rc3-upgrade-offered.jpg) | [安装](./rc3-upgrade-updated.jpg) | [状态](./rc3-upgrade-restarted-status.jpg) | [记忆](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [状态](./rc5-fresh-status.jpg) | [记忆](./rc5-upgrade-memory-before.jpg) | [更新](./rc5-upgrade-offered.jpg) | [安装](./rc5-upgrade-updated.jpg) | [状态](./rc5-upgrade-restarted-status.jpg) | [记忆](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [状态](./rc1-fresh-status.jpg) | [记忆](./rc1-upgrade-memory-before.jpg) | [更新](./rc1-upgrade-offered.jpg) | [安装](./rc1-upgrade-updated.jpg) | [状态](./rc1-upgrade-restarted-status.jpg) | [记忆](./rc1-upgrade-memory-preserved.jpg) |
| `fcc0ad4` (source) | [状态](./master-fresh-status.jpg) | [记忆](./master-upgrade-memory-before.jpg) | [更新](./master-upgrade-offered.jpg) | [安装](./master-upgrade-updated.jpg) | [状态](./master-upgrade-restarted-status.jpg) | [记忆](./master-upgrade-memory-preserved.jpg) |

全新安装通过**插件 → 添加插件 → 立即启用**完成。升级从真实 npm 旧版开始，先经 Runtime 界面创建工作记忆和用户画像各一条合成记录，再通过**状态 → 检查版本 → 更新**安装 Starter 与三个变化的组件。完整重启 Host 后均运行 **0.5.42**，两条记录均保留。master 也使用正常界面更新，没有复制 canary 文件或通过 CLI 恢复。

每个最终 profile 均核对 **19 个固定包版本及四个候选包的 138 个文件和执行位**。`memories.json`、`MEMORY.md`、`USER.md` 三个文件在升级前、安装后和重启后均存在，哈希完全一致。随后对十二个保留 profile 再做独立只读复核，**228 个版本、1,656 个候选文件和执行位**再次匹配，六次升级的数据均与各自基线一致。

## 验证与冻结产物

- Node **24.22.2**、macOS arm64：完整 `pnpm run verify` 通过；根测试 **2,625 通过 / 8 条件跳过**，工作区组件 **792 通过 / 3 条件跳过**。文档、类型、确定性构建、Headless 激活和包检查通过。
- **18 个独立插件仓库、19 个打包产物**通过独立类型、测试、构建和真实 Host 激活，包括可选策略。
- **40 张截图**由捕获代理逐张目视，核对 SHA-256 和尺寸，集成时再次抽查。应用来源的浏览器错误为零；第三方扩展错误另计，只保留数量，不记录扩展身份。
- Starter **68 文件、压缩后 543,227 字节、解包后 2,276,189 字节**，占 3,000,000 字节上限的 **75.9%**，无需调整上限。

候选冻结于 **`22357a693264ad88e50476e99af9c7ee60233bc3`**：Starter **0.5.42**、Documents **0.6.0**、Runtime **0.5.18**、Skills **0.5.9**。其余十五个组件使用不变的 npm 版本，Starter 精确锁定全部十八个组件。[validation.json](./validation.json)记录组合、包摘要、截图摘要和汇总结果；分 Host 记录：[020](./020-validation.json)、[rc2](./rc2-validation.json)、[rc3](./rc3-validation.json)、[rc5](./rc5-validation.json)、[rc1](./rc1-validation.json)、[master](./master-validation.json)。

额外源码为 **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**（UI `0.2.2-rc.1-fcc0ad4`），工作树保持未修改。Runtime 前缀与快照重建由独立的 [#573 记录](../issue-573-runtime-snapshots/README.zh-CN.md)覆盖，包含 native/PTC 请求及五种 Host 的快照测试；本次不测量云端 KV 缓存命中率。

可复用夹具为 [`scripts/serve-release-acceptance.mjs`](../../../scripts/serve-release-acceptance.mjs)，以下变量绑定独立测试资源：

```sh
pnpm run verify
MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build
pnpm release:check
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$FRESH_STATE"
node scripts/serve-release-acceptance.mjs --dsh "$DSH_BIN" --artifacts "$ARTIFACTS" --state "$UPGRADE_STATE" --previous dsh-mnemon@0.5.41
```

## 观察与边界

部分初始截图在 Chrome 原生视口下截断状态标题或记忆行，完整可访问性文本和实际文件已核对。RC3/RC5 最终版本面板和双记录截图，通过相同 Host 与已验证候选重新打开同一已升级 profile 后补录；各自记录说明了这次额外只读步骤。自有夹具、Host 和浏览器标签均已关闭，未使用用户现有预览。

#579 功能 CI 的既有子 Agent 测试清理 hook 曾达到十秒上限。该 fixture 不启动快照生命周期；同一 head 的该文件在本地 159 项通过，随后只重跑原 Linux/Node 22.19 RC3 任务并通过。未确定究竟哪个清理子步骤超时，没有为此修改产品代码或超时设置。

发布 PR 的基线独立插件任务在四包并行时触及验证脚本的 180 秒命令总时限。技能测试报告 111 项断言全部通过，但总耗时 187.92 秒，父进程被终止。CI 与发布现改为与本地验收一致的两包并行，保留全部测试、断言和超时设置；该调度调整不改变已冻结的 npm 制品。

这里验证的是 macOS Web profile，未覆盖原生 Desktop OS 集成或报告者的 Windows 环境；源码验收仅针对上述 commit，不代表任意 master/alpha。未重新评估云端模型质量或提供方的缓存持久性。夹具只对候选元数据调整发布时间，因此不覆盖真实 npm 最小发布年龄策略。正式发布另行冻结最终 main revision，按依赖层发布，验证真实 Registry 安装与升级，全部通过后才创建 GitHub Release。
