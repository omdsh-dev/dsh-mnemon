# v0.5.35 发布验收

[English](README.md) | [验证记录](validation.json)

验收日期为 **2026-10-26（Asia/Shanghai）**，基于 `main` 的 `36f3105e0d2a9c87316898328cdcf940360f957c`，加上发布版本与元数据变更。环境为 Node 22.22.0、pnpm 10.13.1、macOS arm64 和无头 Google Chrome。项目、用户目录、技能与记忆均为隔离测试数据；未提供真实模型凭据，未修改用户的 Desktop Profile。

九个候选包包括 Starter 0.5.35 与[发布说明](../../zh-CN/releases/v0.5.35.md)列出的八个变更组件。其余十个组件从 npm 安装原有固定版本。[validation.json](validation.json)记录候选包摘要和完整组合。四个安装的十九个包版本全部一致；每个安装中，九个候选包的 202 个文件均与 tarball 逐字节一致。

## 全新安装与更新

可复用的[发布验收服务器](../../../scripts/serve-release-acceptance.mjs)使用未修改的正式 npm DSH，在新用户目录和 Profile 中启动。回环 Registry 将真实 npm 元数据与选定候选包组合；仅测试使用的 fetch preload 将候选包版本查询指向该 Registry，不修改 DSH 或已安装的 Mnemon 包。候选包元数据使用较早的测试时间戳，避免 pnpm 的最短发布时间规则隐藏尚未发布的测试版本；生产环境规则不变。

在 **DSH 0.2.1-rc.2 与 0.2.0-rc.2** 上均完成：

1. 跳过首次模型配置，不填写密钥。在**插件 → 添加插件**输入 `dsh-mnemon@0.5.35`，从对话框显示的回环 Registry 安装。结果显示版本 0.5.35：[0.2.1](fresh021-install.png)、[0.2.0](fresh020-install.png)。
2. 点击**立即启用**，**记忆系统 → 状态**显示 **dsh-mnemon 0.5.35 / 系统正常**，五个页面和技能卡片均出现：[0.2.1](fresh021-status.png)、[0.2.0](fresh020-status.png)。
3. 在另一隔离 Profile 安装真实 npm `dsh-mnemon@0.5.34`。**检查版本**提供 0.5.35 与八个新版组件：[0.2.1](upgrade021-offered.png)、[0.2.0](upgrade020-offered.png)。
4. 点击**更新**，两个宿主均显示 **dsh-mnemon 已更新**并要求重启：[0.2.1](upgrade021-updated.png)、[0.2.0](upgrade020-updated.png)。
5. 重启宿主、重新连接 WebUI，读回 **dsh-mnemon 0.5.35 / 系统正常**：[0.2.1](upgrade021-status.png)、[0.2.0](upgrade020-status.png)。安装版本与文件字节均匹配候选组合。

构建并打包选定候选制品后，按以下命令复现全新宿主：

```sh
node scripts/serve-release-acceptance.mjs \
  --dsh <official-dsh>/lib/bin.js \
  --artifacts <candidate-tarballs> \
  --state <empty-disposable-directory> --port 19351
```

添加 `--previous dsh-mnemon@0.5.34` 可创建升级 Profile。连接地址保存在私有的 `private.json`；更新后向测试进程 PID 发送 SIGUSR2 可重启 DSH。日志与连接令牌保留在 Git 之外。

## 技能与图片依赖评测

在 DSH 0.2.1-rc.2 的技能页新建合成用户技能 `release-check`，添加勾选**依赖图片输入**的[评测用例](vision-case.png)。未配置模型账号时运行回测，完成后显示 **1 个未测**，用例显示**未测**，没有分数或通过率：[结果](vision-unmeasured.png)。现有 Host 回归测试另行确认这些用例的执行与评分模型调用均为零。

通过技能菜单及确认对话框移除该技能后，[回收站](skills-trash.png)显示其原始路径；点击**恢复**后技能重新出现在[技能页](skills-restored.png)，回收站条目消失。本轮发布验收未执行永久清空或真实 Provider 基准测试。

## 验证结果

- `pnpm run verify`：文档、类型、可复现构建、所有插件测试、**2,192 个根测试**（7 个条件跳过）、真实 Headless 激活及包检查全部通过。
- `pnpm run verify:plugins --skip-build`：**18 个独立插件仓库与 19 个打包制品**、外部 SDK 消费者、可选策略组合及从 v0.5.29 的 Headless 升级全部通过，升级保留 Runtime 文件字节。
- 使用文档规定的全局 prefix 安装 DSH 0.2.0-rc.2 后，`pnpm run test:installed-dsh`：**2,189 个通过、10 个条件跳过**。首次使用扁平 npm 安装未提供测试解析器所需的依赖布局；改用文档规定的全局 prefix 后，客户端模块导入问题解决，无需修改产品。
- `pnpm run release:check`：稳定 `latest` 组合，九个包版本提升，无待消费 changeset。变更组件未引用本次新增的工作区身份导出，原有运行时 peer 下限仍有效。
- Starter：**67 个文件，解压后 2,163,228 字节**，占 2,500,000 字节上限的 86.5%，无需调整上限。

截图仅证明以上候选包 WebUI 流程，不代表付费模型质量或全部外部 Provider 的兼容性。发布流水线会独立核对固定 revision、Registry 字节、全新安装与 Registry 升级，再创建 GitHub Release。
