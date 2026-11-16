# v0.5.47 发布验收

**简体中文** | [English](./README.md)

于 **2026-11-16–17（Asia/Shanghai）** 使用隔离的 macOS arm64 / Node 24.22.2 Web Profile 与合成数据验证。七个已发布 DSH 版本最终均完成健康的新装和保留数据的 **0.5.46 → 0.5.47** 升级，并完整重启宿主。未调用付费模型，也未使用个人 Desktop 数据。

| DSH | Fresh / 全新安装 | Upgrade / 升级 | Restart / 重启后 |
| --- | --- | --- | --- |
| 0.2.0-rc.2 | [Add](./020-fresh-add.png) / [Ready](./020-fresh-status.png) | [Before](./020-upgrade-before.png) / [Offer](./020-upgrade-offered.png) / [Updated](./020-upgrade-updated.png) | [Version](./020-upgrade-restarted.png) / [Retained](./020-upgrade-retained.png) |
| 0.2.1-rc.2 | [Add](./rc2-fresh-add.png) / [Ready](./rc2-fresh-status.png) | [Before](./rc2-upgrade-before.png) / [Offer](./rc2-upgrade-offered.png) / [Updated](./rc2-upgrade-updated.png) | [Version](./rc2-upgrade-restarted.png) / [Retained](./rc2-upgrade-retained.png) |
| 0.2.1-rc.3 | [Add](./rc3-fresh-add.png) / [Ready](./rc3-fresh-status.png) | [Before](./rc3-upgrade-before.png) / [Offer](./rc3-upgrade-offered.png) / [Updated](./rc3-upgrade-updated.png) | [Version](./rc3-upgrade-restarted.png) / [Retained](./rc3-upgrade-retained.png) |
| 0.2.1-rc.5 | [Add](./rc5-fresh-add.png) / [Ready](./rc5-fresh-status.png) | [Before](./rc5-upgrade-memory-before.png) / [Offer](./rc5-upgrade-offered.png) / [Updated](./rc5-upgrade-updated.png) | [Version](./rc5-upgrade-restarted.png) / [Retained](./rc5-upgrade-retained.png) |
| 0.2.2-rc.1 | [Add](./rc1-fresh-add.png) / [Ready](./rc1-fresh-status.png) | [Before](./rc1-upgrade-before.png) / [Offer](./rc1-upgrade-offered.png) / [Updated](./rc1-upgrade-updated.png) | [Version](./rc1-upgrade-restarted.png) / [Retained](./rc1-upgrade-retained.png) |
| 0.2.2-rc.2 | [Add](./022rc2-fresh-add.png) / [Ready](./022rc2-fresh-status.png) | [Before](./022rc2-upgrade-before.png) / [Offer](./022rc2-upgrade-offered.png) / [Updated](./022rc2-upgrade-updated.png) | [Version](./022rc2-upgrade-restarted.png) / [Retained](./022rc2-upgrade-retained.png) |
| 0.2.2-rc.3 | [Add](./022rc3-fresh-add.png) / [Ready](./022rc3-fresh-status.png) | [Before](./022rc3-upgrade-before.png) / [Reinstall](./022rc3-upgrade-reinstall.png) / [Installed](./022rc3-upgrade-installed.png) | [Version](./022rc3-upgrade-restarted.png) / [Retained](./022rc3-upgrade-retained.png) |

新装通过 DSH **插件 → 添加插件** 完成，再启用 Starter。六组升级使用 **状态 → 检查版本 → 更新**。RC3 的旧版 0.5.46 状态页在原生 Safari 自动化中持续加载，因此使用文档已有的 **插件 → 卸载 → 添加插件** 路径安装候选版，保留原数据目录；这组记录为重装升级成功，不记为原地更新成功。

先在 0.2.1-rc.5 的旧版 UI 创建一条 Runtime 工作记忆并置顶，再将这份合成数据复制到其余六个隔离升级环境。所有最终 UI 均显示同一条记忆及置顶状态。升级前、安装后和重启后的 `memories.json`、`MEMORY.md`、`USER.md` 摘要完全一致；本样例的 `USER.md` 为空。

每个最终环境均匹配 **19 个精确版本和 274 个候选文件的内容及可执行位**，14 个环境共 **266 次版本核对和 3,836 次文件/权限核对**。详见 [validation.json](./validation.json)、各宿主记录与[冻结清单](./candidate-manifest.json)。**54 张截图**记录真实 UI 状态；目视检查了最早宿主状态页和较新宿主的记忆保留截图，辅助功能断言核对版本、健康状态与置顶记忆。

## 验证

- 完整 `pnpm run verify`：根测试 **2,835 通过 / 10 条件跳过**，插件测试 **966 通过 / 4 跳过**；文档、类型、确定性构建、Headless 激活和包检查通过。
- 已发布 DSH **0.2.2-rc.3** 的安装宿主测试：**2,836 通过 / 9 跳过**。
- **18 个独立插件仓库、19 个打包制品**通过，包括独立编译与测试、公共 SDK 组合、Client 测试、Starter 激活与可选策略。
- Starter 为 **74 个文件、599,347 压缩字节、2,524,347 解压字节**，占现有 3 MB 上限的 84.1%，不需要提高上限。

RC2 候选版的一次重启也在后台原生 UI 自动化中持续加载。临时的读取通道及 HTTP 计时诊断在后续重启中记录到正常请求。移除全部诊断后，未修改的候选包完成前台窗口下的完整重启验收，记忆完好。旧版与候选版均会按设计暂停隐藏页面的读取；初次现象本身不能证明产品回归，也不能证明某个原因已被修复。本记录保留该现象、恢复步骤及最终验证结果。

候选提交为 `a257a77c20077858288a2d5c56662be53db435a2`，后续仅修改发布文档与证据；发布制品的 integrity 必须与候选一致。本验收不覆盖原生 Desktop 的系统集成、真实云账号、任意 master 构建或 alpha。回环 Registry 同时提供冻结候选和不可变 npm 版本，候选元数据回溯日期，因此不验证真实 npm 的发布年龄策略。验收后停止全部临时环境。

复现使用 `scripts/serve-release-acceptance.mjs` 和 `docs/pr-assets/release-v0.5.43/audit-installed.py`，升级场景指定 `--previous dsh-mnemon@0.5.46`。进行 UI 断言时保持原生浏览器窗口在前台。
