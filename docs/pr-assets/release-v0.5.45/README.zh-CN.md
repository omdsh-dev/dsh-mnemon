# v0.5.45 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-13（Asia/Shanghai）**在独立 macOS arm64 / Node 24.22.2 Web profile 中使用合成数据验证。**全部 12 个场景通过**：六个正式发布的 DSH 版本（含 **0.2.2-rc.2**）均完成全新安装和真实 npm **0.5.44 → 0.5.45** 升级。没有调用付费模型，也没有使用个人 Desktop 数据。

| DSH | 全新安装 | 升级 | 完整重启后 |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-memory-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-memory-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-memory-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-memory-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |
| 0.2.2-rc.2 | [Add](./022rc2-fresh-add.png) / [Ready](./022rc2-fresh-status.png) | [Before](./022rc2-upgrade-memory-before.png) / [Offer](./022rc2-upgrade-offered.png) / [Updated](./022rc2-upgrade-updated.png) | [Version](./022rc2-upgrade-restarted.png) / [Retained](./022rc2-upgrade-retained.png) |

新 profile 使用**插件 → 添加插件 → 立即启用**安装。升级 profile 先安装 npm 0.5.44，通过 UI 添加一条工作记忆、一条用户画像，并固定工作记忆。**状态 → 检查版本 → 更新**提供 0.5.45 和 Skills 组件更新；完整重启 Host 后，六个升级 profile 均显示 0.5.45、两条原有记忆与固定状态。

每个最终安装均匹配 **19 个精确包版本、103 个候选文件的字节内容与可执行位**。12 个 profile 共完成 **228 次版本检查、1,236 次文件/权限检查**。六次升级中，`memories.json`、`MEMORY.md`、`USER.md` 在升级前、安装后和重启后的哈希完全一致。详见 [validation.json](./validation.json)、各 Host 记录、[候选清单](./candidate-manifest.json)与[候选文件](./candidate-files.json)。

## 验证结果

- Workspace 测试 **897 通过 / 4 条件跳过**；根测试 **2,739 通过 / 9 条件跳过**。文档、类型、确定性构建、Headless 激活和包校验通过。
- 正式 DSH 0.2.2-rc.2 完整套件 **2,740 通过 / 8 条件跳过**。
- **18 个独立插件仓库、19 个打包产物**通过验证，覆盖仅使用公共 SDK 的组合、Client 测试、Starter 激活和可选策略。
- 初次并发根测试遇到已有的虚拟时钟回测期限测试 5 秒超时。原样单独运行该文件 **77/77 通过**，将并发降至两个 worker 后完整根测试通过；没有修改断言或超时。
- **42 张真实 UI 截图**记录安装、升级和保留状态；已目视检查 rc.2 与最旧 Host 的状态/保留页面，浏览器断言覆盖全部六个版本和保留条目。
- Starter：**71 个文件、压缩后 558,454 字节、解压后 2,336,866 字节**，占现有 3,000,000 字节上限的 77.9%，无需提高上限。

候选 revision：`dc9e03176632a282c76c7faee0e1518312018ec2`；上一版本：`455dd1c017d82c4f75af1b9510d383c059b0690e`。发布分支对齐合并后的 main 后，两份实测 tarball 的字节完全相同；后续提交仅补文档和证据。发布时固定最终 main，并将产物与该实测候选比较。

## 范围与复现

验收针对 Web profile，不代表原生 Desktop OS 集成或云端模型质量验证，也不承诺兼容任意 master/alpha。回环 Registry 提供不可变候选 tarball，仅调整候选元数据发布时间，不验证真实 npm 的最短发布年龄规则。旧 Host 的可选 API Key 引导通过**稍后配置**跳过；用完即停止浏览器和 Host 测试实例。

空闲审查的新默认预算可配置，但 Host 不一定按模型输出上限自动裁剪。较小输出上限的模型需显式设置支持的 `idleReview.maxTokens`，本版本没有新增自动适配。

```sh
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-state>
node scripts/serve-release-acceptance.mjs --dsh <official-dsh-bin> --artifacts <frozen-candidates> --state <empty-upgrade-state> --previous dsh-mnemon@0.5.44
python3 docs/pr-assets/release-v0.5.43/audit-installed.py --state <state> --artifacts <frozen-candidates> --baseline <before.json> --output <after.json>
```
