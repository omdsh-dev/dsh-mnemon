# v0.5.46 发布验收

**简体中文** | [English](./README.md)

验收日期：**2026-11-15（Asia/Shanghai）**。使用隔离的 macOS arm64 / Node 24.22.2 Web Profile 和合成数据。**14 个场景全部通过**：七个已发布 DSH 版本的全新安装，以及从真实 npm **0.5.45 升级到 0.5.46**，包含 **0.2.2-rc.3**。未调用付费模型，也未使用个人 Desktop 数据。

| DSH | 全新安装 | 升级 | 完整重启后 |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [添加](./020-fresh-add.jpg) / [就绪](./020-fresh-status.jpg) | [升级前](./020-upgrade-memory-before.jpg) / [更新提示](./020-upgrade-offered.jpg) / [更新完成](./020-upgrade-updated.jpg) | [版本](./020-upgrade-restarted.jpg) / [保留数据](./020-upgrade-retained.jpg) |
| 0.2.1-rc.2 | [添加](./rc2-fresh-add.jpg) / [就绪](./rc2-fresh-status.jpg) | [升级前](./rc2-upgrade-memory-before.jpg) / [更新提示](./rc2-upgrade-offered.jpg) / [更新完成](./rc2-upgrade-updated.jpg) | [版本](./rc2-upgrade-restarted.jpg) / [保留数据](./rc2-upgrade-retained.jpg) |
| 0.2.1-rc.3 | [添加](./rc3-fresh-add.jpg) / [就绪](./rc3-fresh-status.jpg) | [升级前](./rc3-upgrade-memory-before.jpg) / [更新提示](./rc3-upgrade-offered.jpg) / [更新完成](./rc3-upgrade-updated.jpg) | [版本](./rc3-upgrade-restarted.jpg) / [保留数据](./rc3-upgrade-retained.jpg) |
| 0.2.1-rc.5 | [添加](./rc5-fresh-add.jpg) / [就绪](./rc5-fresh-status.jpg) | [升级前](./rc5-upgrade-memory-before.jpg) / [更新提示](./rc5-upgrade-offered.jpg) / [更新完成](./rc5-upgrade-updated.jpg) | [版本](./rc5-upgrade-restarted.jpg) / [保留数据](./rc5-upgrade-retained.jpg) |
| 0.2.2-rc.1 | [添加](./rc1-fresh-add.jpg) / [就绪](./rc1-fresh-status.jpg) | [升级前](./rc1-upgrade-memory-before.jpg) / [更新提示](./rc1-upgrade-offered.jpg) / [更新完成](./rc1-upgrade-updated.jpg) | [版本](./rc1-upgrade-restarted.jpg) / [保留数据](./rc1-upgrade-retained.jpg) |
| 0.2.2-rc.2 | [添加](./022rc2-fresh-add.jpg) / [就绪](./022rc2-fresh-status.jpg) | [升级前](./022rc2-upgrade-memory-before.jpg) / [更新提示](./022rc2-upgrade-offered.jpg) / [更新完成](./022rc2-upgrade-updated.jpg) | [版本](./022rc2-upgrade-restarted.jpg) / [保留数据](./022rc2-upgrade-retained.jpg) |
| 0.2.2-rc.3 | [添加](./022rc3-fresh-add.jpg) / [就绪](./022rc3-fresh-status.jpg) | [升级前](./022rc3-upgrade-memory-before.jpg) / [更新提示](./022rc3-upgrade-offered.jpg) / [更新完成](./022rc3-upgrade-updated.jpg) | [版本](./022rc3-upgrade-restarted.jpg) / [保留数据](./022rc3-upgrade-retained.jpg) |

新 Profile 通过 **插件 → 添加插件 → 立即启用** 安装。升级 Profile 先安装真实 npm 0.5.45，再通过界面分别写入一条工作记忆和用户画像，并固定工作记忆。**状态 → 检查版本 → 更新** 提供 0.5.46 和三个组件更新。完整重启 Host 后，七个版本都显示 0.5.46，且两条记忆和固定状态保持。

每个最终安装核对 **19 个精确包版本、169 个候选文件内容及执行位**；14 个 Profile 共 **266 次版本核对、2,366 次文件与执行位核对**。七次升级在安装前、安装后及重启后，`memories.json`、`MEMORY.md`、`USER.md` 的哈希全部一致。参见 [validation.json](./validation.json) 及其逐 Host 记录、[候选清单](./candidate-manifest.json)、[候选文件](./candidate-files.json)。

## 验证

- 完整 `pnpm run verify`：根测试 **2,801 通过、9 项条件跳过**；工作区插件测试 **899 通过、4 项跳过**。文档、类型、确定性构建、Headless 激活及打包检查通过。
- 最终带发布版本的代码在官方 **DSH 0.2.2-rc.3** 上：**2,802 通过、8 项条件跳过**。
- **18 个独立插件仓库、19 个打包制品**通过独立构建与测试、公开 SDK 组合、Client 测试、Starter 激活和可选策略验收。
- **49 张真实界面截图**覆盖该矩阵；目视检查了最新 Host 数据保留、最早 Host 状态等代表性截图，浏览器断言验证所有七个 Host 的版本、健康状态、条目和固定状态。
- Starter：**71 个文件，压缩后 564,675 字节，解包后 2,361,512 字节**，占原有 3,000,000 字节上限的 78.7%，无需提高上限。

冻结候选为 `b523b603a4ee3756c23478d2629255ae8f7800d2`；对齐已合并 main 至 `242ddd0fe58334edc433250b95a4a2e072a5e6f3` 并重新构建后，**四个 tarball 逐字节一致**。后续只有发布文档、证据和验收夹具隔离修改。发布流程冻结最终 main，其制品摘要必须匹配这批已测候选。

## 范围与复现

这是 Web Profile 验收，不覆盖原生 Desktop 操作系统集成或云模型质量，也不承诺兼容 alpha 或任意 master。回环 registry 将冻结候选与真实 npm 包组合，仅调整候选元数据的发布时间；真实 npm 新发布包的年龄策略不在该界面验收范围内。首次可选 API Key 引导通过**稍后配置**或**关闭**跳过。

夹具在 HOME 和 Mnemon 数据之外，也隔离 Documents 与 agents-home。最初的升级夹具将补丁追加在带注释的空 YAML 列表之后，启动失败；修正夹具后重建了失败环境，再执行验收。最终夹具均在验证后停止。

```sh
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-state>
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-upgrade-state> --previous dsh-mnemon@0.5.45
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state <state> --artifacts <frozen-candidates> --baseline <before.json> --output <after.json>
```
