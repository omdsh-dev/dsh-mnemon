# v0.5.43 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-09（Asia/Shanghai）**使用独立 profile 和合成数据验证。**十二个场景全部通过**：五个官方 Host 与 #554 指定源码 commit 的全新安装，以及真实 npm **0.5.42 → 0.5.43** 升级。未调用付费模型，未使用个人 Desktop 数据。

| DSH | 全新安装 | 记忆基线 | 更新提示 | 安装完成待重启 | 重启后 | 保留记忆 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add-plugin.jpg) / [Status](./020-fresh-status.jpg) | [Before](./020-upgrade-memory-before.jpg) | [Offer](./020-upgrade-offered.jpg) | [Updated](./020-upgrade-updated.jpg) | [Restarted](./020-upgrade-restarted-status.jpg) | [Retained](./020-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add-plugin.jpg) / [Status](./rc2-fresh-status.jpg) | [Before](./rc2-upgrade-memory-before.jpg) | [Offer](./rc2-upgrade-offered.jpg) | [Updated](./rc2-upgrade-updated.jpg) | [Restarted](./rc2-upgrade-restarted-status.jpg) | [Retained](./rc2-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add-plugin.jpg) / [Status](./rc3-fresh-status.jpg) | [Before](./rc3-upgrade-memory-before.jpg) | [Offer](./rc3-upgrade-offered.jpg) | [Updated](./rc3-upgrade-updated.jpg) | [Restarted](./rc3-upgrade-restarted-status.jpg) | [Retained](./rc3-upgrade-memory-preserved.jpg) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add-plugin.jpg) / [Status](./rc5-fresh-status.jpg) | [Before](./rc5-upgrade-memory-before.jpg) | [Offer](./rc5-upgrade-offered.jpg) | [Updated](./rc5-upgrade-updated.jpg) | [Restarted](./rc5-upgrade-restarted-status.jpg) | [Retained](./rc5-upgrade-memory-preserved.jpg) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add-plugin.jpg) / [Status](./rc1-fresh-status.jpg) | [Before](./rc1-upgrade-memory-before.jpg) | [Offer](./rc1-upgrade-offered.jpg) | [Updated](./rc1-upgrade-updated.jpg) | [Restarted](./rc1-upgrade-restarted-status.jpg) | [Retained](./rc1-upgrade-memory-preserved.jpg) |
| `fcc0ad4` (source) | [Add](./master-fresh-add-plugin.jpg) / [Status](./master-fresh-status.jpg) | [Before](./master-upgrade-memory-before.jpg) | [Offer](./master-upgrade-offered.jpg) | [Updated](./master-upgrade-updated.jpg) | [Restarted](./master-upgrade-restarted-status.jpg) | [Retained](./master-upgrade-memory-preserved.jpg) |

全新环境通过**插件 → 添加插件 → 立即启用**安装。升级环境先安装真实 npm 0.5.42，再通过 Runtime 页面分别创建一条工作记忆和一条用户画像；**状态 → 检查版本 → 更新**提供 0.5.43 与七个组件更新。每次完整重启后都运行 0.5.43，两个记录均可见。

每个最终安装都匹配 **19 个锁定版本及 199 个候选文件的字节与执行位**；十二个环境合计核对 **228 个版本、2,388 次文件及执行位**。六个升级环境的 `memories.json`、`MEMORY.md`、`USER.md` 在升级前、安装后、重启后三个阶段哈希均相同。见[机器记录](./validation.json)、六份逐 Host 记录、[候选文件清单](./candidate-files.json)及[只读安装数据核验脚本](./audit-installed.py)。

## 验证与包体

- 完整 `pnpm run verify`：根测试 **2,671 通过 / 8 条条件跳过**；工作区测试 **869 通过 / 4 条条件跳过**。文档、类型、确定性构建、Headless 激活、公开入口和制品检查通过。
- `MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build`：**18 个独立插件仓库、19 个打包制品**完成独立验证及真实 Host 激活，包含可选策略。
- 未修改的源码 commit **fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159** 同样通过 **2,671 项根测试 / 8 条条件跳过**，源码工作树保持干净。
- Starter **69 个文件，压缩后 550,305 字节、解包后 2,303,047 字节**，占 3,000,000 字节上限的 76.8%，无需调整上限。
- **43 张截图**记录操作过程；每个关键状态均核对了实时 DOM，并目视检查六张全新安装状态图与 RC1 记忆保留图。RC1 保留图裁剪至两个记录所在区域。

候选包 revision 为 `601e4cb7f941dc102f6cf58d7f1a8ef8d6ee1691`，比较基线为 `ee080a7371759928c97c581621713819f31507d4`。后续整合只对齐合并关系并加入发布文档、验收记录，发布包源文件保持一致。发布流程再冻结最终 main，重跑必需检查，先发布选中的组件，最后发布 Starter。

## 边界

本记录覆盖 macOS arm64、Node 24.22.2 的 Web profile，未重新测量云端模型质量、提供方缓存命中率、原生 Desktop OS 集成，也不覆盖任意 master/alpha。回环夹具只调整候选元数据发布时间，因此不覆盖真实 npm 最小发布年龄策略。未修改用户 Desktop 或已有预览；自有夹具及浏览器标签已关闭。复现命令见[英文记录](./README.md#scope-and-reproduction)。
