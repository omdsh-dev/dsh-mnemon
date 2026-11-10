# v0.5.44 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-11（Asia/Shanghai）**使用 macOS arm64、Node 24.22.2、隔离 Web profile 与合成数据验证。**十个场景全部通过**：五个正式发布 DSH Host 上的全新安装，以及真实 npm **0.5.43 → 0.5.44** 升级。未调用付费模型，未使用个人 Desktop 数据。

| DSH | 全新安装 | 升级 | 完整重启后 |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-memory-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-memory-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-memory-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-memory-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |

全新环境通过**插件 → 添加插件 → 立即启用**安装。升级环境先安装真实 npm 0.5.43，通过界面创建一条工作记忆并固定，再创建一条用户画像。**状态 → 检查版本 → 更新**提供 0.5.44 与两个组件更新。每个重启后的环境都运行 0.5.44，两条原有记忆与固定标记均可见。

每个最终安装都匹配 **19 个精确版本及 148 个候选文件的内容和执行位**；十个环境共核对 **190 个版本、1,480 次文件内容与执行位**。五个升级环境中的 `memories.json`、`MEMORY.md` 和 `USER.md` 在安装前、安装后、重启后三个阶段哈希一致。见[机器记录](./validation.json)、五份逐 Host 记录、[候选清单](./candidate-manifest.json)、[候选文件](./candidate-files.json)及已有的[只读核验脚本](../release-v0.5.43/audit-installed.py)。

## 检查与制品

- `pnpm run verify`：**2,706 项根测试通过 / 8 项条件跳过**；**895 项工作区测试通过 / 4 项条件跳过**。文档、类型、确定性构建、Headless、公开入口与包检查通过。
- `MNEMON_PLUGIN_VERIFY_CONCURRENCY=2 pnpm run verify:plugins --skip-build`：**18 个独立插件仓库、19 个打包制品**通过，覆盖外部组合、真实 Starter 安装和可选策略激活。
- 一次整合六个 PR 的中间检查触发既有虚拟时钟回测截止用例的 5 秒超时；原样单独重跑该文件 **77/77 通过**，最终完整验证也通过，未放宽超时。最后两个整合后的 PR head 在合并前均通过完整 CI。
- Starter **71 个文件，压缩后 557,190 字节、解包后 2,331,737 字节**，占现有 3,000,000 字节上限的 77.7%，无需提高上限。
- **35 张截图**记录真实步骤，实时 DOM 核对版本、安装结果、两条记忆和固定标记；目视抽查 0.2.0-rc.2 和 0.2.2-rc.1 的状态及保留记忆截图。

候选 revision 为 `629bf040e1b8c22cde2663e33866c6c1f207f545`，上一发布 revision 为 `e9da7d1d717737defc088ac9afd32c4ca99ff9ef`。后续提交仅对齐合并关系并加入文档与验收证据，候选包源码保持不变。发布流程冻结最终 main，并在批准 `npm-release` 前比较 CI 制品与本候选。

## 边界

本次验证 Web profile，未重新验收原生 Desktop 系统集成、云端模型或 Provider 质量与缓存性能。此前的临时源码 checkout 已不可用，本次不重复较早的指定源码 commit 验收，也不宣称任意 master/alpha 兼容。回环夹具只调整候选元数据发布时间，不覆盖真实 npm 最小发布年龄策略。未修改用户 Desktop profile；验收后停止自有夹具并关闭标签页。复现命令见[英文记录](./README.md#scope-and-reproduction)。
