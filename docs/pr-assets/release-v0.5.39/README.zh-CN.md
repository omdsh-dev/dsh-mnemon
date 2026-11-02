# v0.5.39 发布验收

**简体中文** | [English](./README.md)

验收日期：**2026-11-02（Asia/Shanghai）**。冻结候选为 `9dd950228e34fb08467d0ec1f3ae591f04ee3c79`，基于 main `75d9ab175250376b2bdbd12316da55c90cf8486b` 准备；产物在本次证据文档加入前已完成打包。环境为 macOS arm64、**Node 24.22.2**、pnpm 10.13.1、Google Chrome 156.0.8078.74。每个场景均使用独立的临时 home、工作区、DSH profile、包存储、记忆目录及浏览器用户数据目录。未使用模型凭据或私人用户数据，也未改动用户的 Desktop profile 和既有浏览器。

[冻结清单](candidate-manifest.json)只选择 Starter **0.5.39** 和 Skills **0.5.6**。其余十七个组件直接使用 npm 上已发布的不可变版本；验收 Registry 没有覆盖重新构建的未改动包。每次安装的 **十九个锁定版本**均匹配，两个候选 tarball 的全部 **98 个文件**逐字节及可执行权限位均一致。[validation.json](validation.json)记录包摘要、安装结果、Runtime 哈希和截图摘要；[installed-file-digests.json](installed-file-digests.json)记录在每次安装中核对过的候选文件摘要。

Starter 为 **531,612 字节压缩包 / 2,233,414 字节解包内容**。本次发布按开发指南将大小上限从 2,500,000 调整为 3,000,000 字节，见独立的[验证记录](verification.json)。

## 真实 WebUI 安装与升级

[验收服务](../../../scripts/serve-release-acceptance.mjs)在隔离目录中运行 npm 官方 DSH。本机回环 Registry 仅在真实 npm 元数据上覆盖两个候选包；限定候选包的版本检查 preload 和旧发布时间让现有界面可以发现未发布候选，不改变生产环境的发布等待规则。

对 **0.2.0-rc.2**、**0.2.1-rc.2**、**0.2.1-rc.3**、**0.2.1-rc.5** 和 **0.2.2-alpha.2** 分别执行：

1. 在全新 Host 中，通过 **Plugins → Add plugin** 安装 `dsh-mnemon@0.5.39`，确认安装版本，点击 **Enable now** 后打开 Memory System。状态显示 **dsh-mnemon 0.5.39 / System nominal**。
2. 在另一份隔离 profile 中，通过 DSH 插件安装器安装 npm 上真实的 **0.5.38**。用 Runtime 的 **Add memory** 对话框添加一条合成事实，等待保存完成且条目可见后，记录保留基线。
3. 打开 **Check versions**，确认 **0.5.38 → 0.5.39** 及一个组件更新。点击 **Update**，确认 **0.5.39 / Restart needed**，核对已安装组合与文件，并确认三个 Runtime 文件哈希仍与基线相同。
4. 重启 Host 一次并重新连接。状态显示运行中的 **0.5.39 / System nominal**。合成事实仍可见，`memories.json`、`MEMORY.md`、`USER.md` 的 SHA-256 哈希均未变化；十九个版本和候选文件再次核对一致。

十个最终浏览器场景均无页面错误。全部验收 Host 和测试浏览器进程均已停止。

| DSH | 全新安装 | 全新运行状态 | 发现升级 | 完成更新 | 重启后状态 | 保留记忆 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [安装](fresh020-install.jpg) | [状态](fresh020-status.jpg) | [可升级](upgrade020-offered.jpg) | [已更新](upgrade020-updated.jpg) | [运行](upgrade020-status.jpg) | [合成事实](upgrade020-memory-preserved.jpg) |
| 0.2.1-rc.2 | [安装](fresh021-install.jpg) | [状态](fresh021-status.jpg) | [可升级](upgrade021-offered.jpg) | [已更新](upgrade021-updated.jpg) | [运行](upgrade021-status.jpg) | [合成事实](upgrade021-memory-preserved.jpg) |
| 0.2.1-rc.3 | [安装](freshrc3-install.jpg) | [状态](freshrc3-status.jpg) | [可升级](upgraderc3-offered.jpg) | [已更新](upgraderc3-updated.jpg) | [运行](upgraderc3-status.jpg) | [合成事实](upgraderc3-memory-preserved.jpg) |
| 0.2.1-rc.5 | [安装](freshrc5-install.jpg) | [状态](freshrc5-status.jpg) | [可升级](upgraderc5-offered.jpg) | [已更新](upgraderc5-updated.jpg) | [运行](upgraderc5-status.jpg) | [合成事实](upgraderc5-memory-preserved.jpg) |
| 0.2.2-alpha.2 | [安装](freshalpha2-install.jpg) | [状态](freshalpha2-status.jpg) | [可升级](upgradealpha2-offered.jpg) | [已更新](upgradealpha2-updated.jpg) | [运行](upgradealpha2-status.jpg) | [合成事实](upgradealpha2-memory-preserved.jpg) |

CUA 内置浏览器在当前后台聊天中不可用，因此浏览器自动化改用本地 Playwright，每个场景独立创建临时 Chrome 用户数据目录。视觉复核发现第一张 alpha.2 更新截图处于 Host 客户端刷新过渡状态，因此只重跑了该隔离升级场景，并在截图后额外核验 **Restart needed**。补跑通过相同的安装、重启及记忆保留检查，上表中的四张 alpha.2 升级图来自补跑。候选代码未变化。收录的三十张 JPEG 均经过视觉复核，只包含页面视口和合成夹具数据。

## 独立验证

发布主流程的[验证记录](verification.json)包含完整工作区验证（**2,463 个根包测试通过 / 7 个跳过**，**749 个组件测试通过 / 3 个跳过**）、**18 个独立插件仓库 / 19 个开发验证产物**、规范路径下已安装 **0.2.1-rc.2** 的完整测试（**2,463 / 7 个跳过**）、包检查和发布意图。这些开发验证与上述只覆盖两个候选包的发布验收分别记录。

[rc.5](packed-web-rc5.json) 和 [alpha.2](packed-web-alpha2.json) 的公开 Web profile 验证使用相同的两个冻结候选与真实 npm 组合。官方 **standard** 与 **PTC** preset 均收到 guide 和 memory snapshot，完成状态与文档读取，未出现工具错误，并完成合成回合。每个 preset 发出三次合成模型请求，**没有调用外部模型**。

## 复现与边界

使用准确的官方 DSH 二进制、Node 24.22.2、所选发布 tarball 和全新的空目录：

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <selected-release-tarballs> \
  --state <empty-disposable-state>
```

升级场景增加 `--previous dsh-mnemon@0.5.38`。读取夹具的私有连接元数据时，不要将连接地址写入证据。出现 **Restart needed** 后向夹具父进程发送 SIGUSR2，使用新的私有元数据重连；结束时发送 SIGTERM。核对十九个安装版本、每个候选 tarball 文件及可执行权限位，并分别比较安装后、重启后的 Runtime 基线哈希。

这些场景覆盖安装、更新、重启和每次升级的一条合成 Runtime 记忆，并非穷尽历史数据迁移，也不衡量真实模型质量。未使用外部 Provider 账号；未手工验收 Windows 或 Linux Desktop 安装，也未复测反馈中的 Windows 延迟。正式发布仍需独立验证冻结版本和 Registry 组合，最后创建 GitHub Release。
