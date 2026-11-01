# v0.5.38 发布验收

**简体中文** | [English](./README.md)

验收日期为 **2026-11-02（Asia/Shanghai）**，候选提交为 `53c00f6963bfc46738aa523e968c58a90f351805`，基于 main `5a5c5f8909d68f520110d271d566b77bbcf94b70` 完成版本准备。候选包在本次证据文件加入前已打包。环境为 macOS arm64、Node 22.22.0、pnpm 10.13.1 和独立的无头 Chrome 上下文。各宿主使用独立的一次性主目录、工作区、Profile、包缓存和记忆目录；未使用模型凭据或用户私有数据，未改动用户的 Desktop Profile 或现有浏览器。

本次六个候选包为 Starter **0.5.38**、Documents **0.5.12**、Memory Spaces **0.5.25**、Runtime **0.5.17**、Skills **0.5.5** 和 ByteRover **0.5.6**，其余十三个组件保留原有 npm 精确版本。[结构化记录](validation.json) 包含全部十九个版本、候选包 SHA-256/SHA-512 摘要、包体积、截图哈希及验收结果。六次安装均匹配全部十九个版本，六份 tarball 中的 **191 个文件**逐字节一致，可执行权限位也一致。Starter 压缩体积为 **528,306 字节**，解包后为 **2,220,816 字节**，占未调整的 2,500,000 字节上限的 88.8%。

## 真实 WebUI 安装与升级

现有[验收服务器](../../../scripts/serve-release-acceptance.mjs) 在隔离主目录中运行已发布的 DSH。回环 Registry 在真实 npm 元数据上覆盖六个候选包；仅对候选包生效的版本查询预加载器和测试发布时间让现有 UI 能发现未发布的版本，未改变生产环境的发布等待规则。

对 DSH **0.2.0-rc.2**、**0.2.1-rc.2** 和 **0.2.1-rc.3** 分别执行：

1. 在空白宿主中，通过 **Plugins → Add plugin** 安装 `dsh-mnemon@0.5.38`，核对安装版本，选择 **Enable now**，打开记忆系统。状态显示 **dsh-mnemon 0.5.38 / System nominal（系统正常）**。
2. 在另一份隔离 Profile 中，通过 DSH 插件安装器初始化真实 npm **0.5.37**。使用运行时记忆的 **Add memory** 对话框写入一条合成事实，等待写入完成后保存保留检查基线。
3. 打开 **Check versions**，确认 **0.5.37 → 0.5.38** 和五个组件更新。点击 **Update**，确认 **0.5.38 / Restart needed**，随后重启宿主一次并重新连接。
4. 状态显示正在运行 **0.5.38 / System nominal**。三个宿主均能读回合成事实，`memories.json`、`MEMORY.md`、`USER.md` 的 SHA-256 均与升级前一致；全部十九个版本及候选包文件字节均匹配。六组最终浏览器验收没有页面错误，所有验收进程均已停止。

| DSH | 全新安装 | 全新状态 | 提供更新 | 更新完成 | 重启后 | 记忆保留 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.0-rc.2 | [安装](fresh020-install.png) | [状态](fresh020-status.png) | [候选](upgrade020-offered.png) | [完成](upgrade020-updated.png) | [运行](upgrade020-status.png) | [合成记忆](upgrade020-memory-preserved.png) |
| 0.2.1-rc.2 | [安装](fresh021-install.png) | [状态](fresh021-status.png) | [候选](upgrade021-offered.png) | [完成](upgrade021-updated.png) | [运行](upgrade021-status.png) | [合成记忆](upgrade021-memory-preserved.png) |
| 0.2.1-rc.3 | [安装](freshrc3-install.png) | [状态](freshrc3-status.png) | [候选](upgraderc3-offered.png) | [完成](upgraderc3-updated.png) | [运行](upgraderc3-status.png) | [合成记忆](upgraderc3-memory-preserved.png) |

## 复现与验证

构建并打包六个选定候选包，针对每种官方 DSH 二进制和新的空白状态目录运行：

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <candidate-tarballs> \
  --state <empty-disposable-state>
```

升级场景增加 `--previous dsh-mnemon@0.5.37`。从夹具私有元数据读取连接地址，不将地址加入证据。在界面显示 **Restart needed** 后向夹具父进程发送 SIGUSR2，再用新的私有元数据重新连接；最后发送 SIGTERM 停止夹具。核对安装的 Starter 及其精确依赖与清单一致，再逐个核对选中 tarball 文件的安装字节和可执行权限位。

发布主任务单独执行了以下检查。整理本记录时读取了其日志中的完成信息和测试总数，[validation.json](validation.json) 保留对应日志摘要：

- `pnpm run verify`：文档、类型检查、确定性构建、**2,387 项根测试**（7 项条件跳过）、**745 项组件测试**（3 项条件跳过）、Headless 激活、旧设置保留/恢复与幂等重启、包内容及公共入口检查均通过。
- `pnpm run verify:plugins --skip-build`：**18 个独立插件仓库 / 19 份打包产物**、仅消费公共 SDK 的外部使用方、可选策略组合，以及打包 Starter 的激活和升级均通过。外层并发为四，每个独立包使用一个 Vitest worker。
- `pnpm run release:check`：完整精确版本组合、稳定版 `latest` 通道及六个选定包的版本提升均通过。

这些 UI 场景覆盖安装、升级、重启，以及每个升级宿主的一条合成运行时记忆，不穷举历史数据迁移，也不评估真实模型效果。未调用真实模型 API 或外部 Provider 服务。未人工验收 Windows、Linux 的交互式 Desktop 安装，未重新测量问题报告中的 Windows 耗时。

正式发布会另行冻结合并后的 main 提交，重复工作区和独立插件验证，比较冻结产物，验证 Registry 完整组合及真实升级，最后创建 GitHub Release。
