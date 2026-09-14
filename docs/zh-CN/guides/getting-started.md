# 快速开始

**简体中文** | [English](../../en/guides/getting-started.md) | [文档中心](../README.md)

本页从空白环境走到第一次可验证召回，默认采用 Sidebar、全局存储和保留原使用体验的 `default-three-tier` 组合。普通使用不需要配置 View、Strategy 或 generation 概念。

安装完成后可直接跳到[首次验证](#6-完成第一次验证)。已有安装先看[兼容性与升级](../reference/compatibility.md)；特定旧版本的迁移细节保留在对应发布记录中。

## 1. 前置条件

你需要：

- DSH 0.1.5-rc.1 基线所需的 Node.js `^22.19.0 || >=24.0.0`；
- 一个可以启动的 DSH Web 或 Headless profile；
- 本地可执行的 `mnemon` CLI；
- 一个能够创建独立任务 Agent 的 DSH 模型路由。

普通语义任务优先使用名为 `spawn` 的 Provider，并要求 `toolFilter`、`persona` 与 `depthLimit`。Mnemon 固定注册一个 `mnemon_subagent_result` 工具，并为每个子任务签发可撤销的 `requestId`。子任务返回 `{ requestId, result }`；Host 按该操作的 schema 校验 `result`，拒绝过期或其他子任务提交的结果，不依赖 Provider 的 `outputSchema` 路径。可选的评分后台审查还要求名为 `fork`、且 `inheritsParentContext=true` 的 Provider。缺少 `fork` 不影响确定性页面读取和普通手动操作。

Composable v0.5.6 精确固定经过验证的十六个官方插件组合。请阅读[补丁说明](../releases/v0.5.6.md)和[兼容性矩阵](../reference/compatibility.md)。DSH 基线为 0.1.5-rc.1，完整 profile 需要 Node `^22.19.0 || >=24.0.0`；Mnemon 的 Node 20 公开入口检查不代表完整 Host 兼容。当前界面示例来自 v0.5.4 浅色模式，先将备份导入隔离存储再采集；旧发布记录保留原版本身份。

安装并核对已验证的 DSH 版本：

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.1
dsh --version
npm view @deepseek-ai/dsh dist-tags
```

## 2. 安装 Mnemon

macOS、Linux 和 Windows 均推荐使用 npm（Node.js 22+）。在运行 DSH 的宿主机器上执行：

```sh
npm install --global @mnemon-dev/mnemon@latest
mnemon --version
```

后续通过 `mnemon update` 更新；状态页识别到所属 npm 安装时，也可使用“检查版本”中的更新操作。若从 Homebrew、Go 或下载的二进制迁移，请让 npm 全局命令目录在 PATH 中优先于旧命令，并同步调整 `MNEMON_CLI_PATH` / `mnemon.cliPath`。改变宿主环境后重启 DSH，再在状态页核对可执行文件路径。

macOS 也可选择 Homebrew Cask：

```sh
brew install --cask mnemon-dev/tap/mnemon
```

macOS 和 Linux 可通过 Go 安装：

```sh
go install github.com/mnemon-dev/mnemon@latest
```

验证二进制：

```sh
mnemon --version
```

如果选择在 Windows 手工安装，官方发行包同时提供 AMD64 与 ARM64 ZIP。下面的 PowerShell 会把 v0.2.3 安装到可自动发现的用户 Programs 目录，并使用官方 checksum 校验下载内容：

```powershell
$version = '0.2.3'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$archiveName = "mnemon_${version}_windows_${arch}.zip"
$releaseBase = "https://github.com/mnemon-dev/mnemon/releases/download/v${version}"
$archive = Join-Path $env:TEMP $archiveName
$checksumFile = Join-Path $env:TEMP "mnemon_${version}_checksums.txt"
Invoke-WebRequest "${releaseBase}/${archiveName}" -OutFile $archive
Invoke-WebRequest "${releaseBase}/checksums.txt" -OutFile $checksumFile
$line = Get-Content $checksumFile | Where-Object { $_.EndsWith("  $archiveName") } | Select-Object -First 1
if (-not $line) { throw "Checksum entry not found for $archiveName" }
$expected = (($line -split '\s+')[0]).ToLowerInvariant()
$actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch for $archiveName" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\mnemon'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Expand-Archive -Path $archive -DestinationPath $installDir -Force
$mnemon = Join-Path $installDir 'mnemon.exe'
& $mnemon --version
```

如果已经安装 Go 工具链，也可以继续使用 Go：

```powershell
go install github.com/mnemon-dev/mnemon@latest
$mnemonBin = go env GOBIN
if (-not $mnemonBin) {
  $mnemonBin = Join-Path (((go env GOPATH) -split ';')[0]) 'bin'
}
$mnemon = Join-Path $mnemonBin 'mnemon.exe'
& $mnemon --version
```

Windows 上，dsh-mnemon 会从 `PATH`、导出的 `GOBIN` 或 `GOPATH`、默认 `%USERPROFILE%\go\bin`、`%LOCALAPPDATA%\Programs\mnemon` 和 Program Files 中发现原生 `mnemon.exe`。同时支持官方 npm 的 `mnemon.cmd` 启动器：验证包身份后通过 Node 调用其 JavaScript 入口，全程不使用 shell。其他 `.cmd` 与 `.bat` wrapper 仍不受支持。

DSH 内嵌在 Electron 桌面主进程时，经过验证的 npm 启动器会在子进程中以 `ELECTRON_RUN_AS_NODE=1` 运行，覆盖记忆命令、版本检查和 npm 更新，并保留已保存的 embedding 设置。桌面应用自身的环境变量不变。如果桌面壳关闭了 Electron 的 `runAsNode` fuse，请将 `mnemon.cliPath` 指向当前平台的 Mnemon 原生二进制，详见[故障排查](./operations.md#故障排查)。

如果 DSH 仍无法找到二进制，请设置 `MNEMON_CLI_PATH`，或在用户 settings 中写入绝对路径；不要为此整体替换插件的 profile patch：

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

`mnemon status` 会打开有效 Store，可能初始化数据或执行上游迁移，不要把它当作完全无副作用的安装探测。

## 3. 安装 dsh-mnemon

需要完整工作台时安装到 Web profile：

```sh
dsh plugin --profile web add dsh-mnemon
```

开发检出使用绝对路径：

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-mnemon"
```

然后启动或重启 profile：

```sh
dsh --profile web
```

如果需要通过云端域名访问 Web profile，不要直接发布 3080 端口。DSH 0.1.5-rc.1 通过 Host 启动时输出的一次性 URL 建立浏览器会话，并用它认证全部 Mnemon RPC 与 stream。请按[云端 WebUI](./operations.md#cloud-hosted-webui)同时配置 HTTPS 反向代理或访问网关与可信 authority，再打开该启动 URL；同一节也保留了回滚到 DSH 0.1.1-rc.2 时所需的另一套 `remoteAccess` 步骤。

升级与卸载：

```sh
dsh plugin --profile web update dsh-mnemon
dsh plugin --profile web remove dsh-mnemon
```

卸载只移除插件注册，不删除全局、工作区或自定义目录中的记忆数据。

不同 profile 的插件清单彼此独立。一次性任务也需要记忆时，应另行安装到 Headless：

```sh
dsh plugin --profile headless add dsh-mnemon
dsh --profile headless "回答前先检查持久化的项目上下文。"
```

开发检出时把包名替换为 `"link:/absolute/path/to/dsh-mnemon"`。Headless 会挂载与 Web Agent 相同的运行时上下文、档案、记忆空间工具、生命周期提示和受监督写入路径，但不会挂载工作台、对话按钮、RPC 通道或交互式斜杠命令界面。

`storageScope=workspace` 时，Headless 直接解析 `<启动命令 cwd>/.mnemon`，不需要 Web 工作区目录。一次性 runner 会在 Agent 进入 idle 后退出，因此尚未开始的评分后台审查会在关闭时取消；任务内已经完成的显式或模型引导写入仍会持久化。

## 4. 选择入口与存储位置

打开“设置 → 记忆系统”：

[交互指南](./ui-guide.md)展示当前设置与可选增强。

### 工作台入口

默认点击 DSH 侧边栏中的“记忆系统”打开独立工作台。在设置中选择 Builtin，或配置 `displayMode: builtin`，可将同一组 Source 页面放入会话 Tab。保存后入口实时切换，不改变记忆数据。

### 存储位置

| 范围 | 根目录 | 适合场景 |
|---|---|---|
| **全局**（默认） | `MNEMON_DATA_DIR` 或 `~/.mnemon` | 多个工作区共享同一套记忆 |
| **工作区** | `<workspace>/.mnemon` | 项目隔离，并允许在工作台切换查看其他工作区 |
| **自定义** | `dataDir` | 专用磁盘、挂载卷或明确的数据目录 |
| **集中工作区** | `<集中根>/workspaces/<工作区路径哈希>/` | 在统一目录集中备份，同时按项目隔离 |

如需集中管理且按项目隔离，选择 `storageScope: workspaces` 并按需设置 `dataDir`；数据保存为 `<集中根>/workspaces/<工作区路径哈希>/`。目录设置位于范围选择器旁；切换模式时保留旧根。


点击保存后会先初始化新运行图，再原子切换 Host；页面自动清理旧状态并重新读取，无需刷新浏览器。切换范围不会自动迁移、合并或删除旧数据。

### 默认记忆层

首次安装应看到 Runtime、Documents、Memory Spaces 三个默认 Source，且均已启用。每层只有一个总开关；开启只是允许系统按需使用，不会强制每回合召回。关闭会一起停止该层的上下文、工具、后台处理和数据面 Web/RPC，但不会删除数据；Sidebar Tab 会标记“已关闭”，重新开启即可恢复。第一次使用建议保持默认值。

在工作区模式下，对话 Agent、工具与生命周期使用当前会话的实际根；从 Sidebar 启动的独立任务 Agent 会显式使用正在查看的工作区，即使没有选中主 session 也一样。两者不一致时顶部会提示并提供一键对齐。Builtin 的读写和任务使用所属会话的范围，因此不显示存储模式、工作区选择器或对齐控件。

## 5. 打开 Sidebar 工作台

点击左侧栏“记忆系统”，先查看“状态”：

![当前状态、Native 就绪情况与记忆数量](../../assets/webui-v0.5.4/zh-CN/status.jpg)

确认：

- 右上角显示“已连接”；
- Mnemon 与 dsh-mnemon 能显示当前版本；
- 存储根与刚才选择的范围一致；
- 运行时、档案、记忆空间与设置中启用的记忆层一致；
- Runtime、Documents 和 Memory Spaces 没有错误提示。

全局或自定义存储下，档案仍需要 DSH 工作区身份。先为当前会话选择工作区，或在工作区存储下选择查看对象。“等待工作区”表示缺少项目上下文，并非 CLI 未安装。

如果 Mnemon 不可用，macOS/Linux 先运行 `command -v mnemon` 与 `mnemon --version`；Windows PowerShell 运行 `Get-Command mnemon` 与 `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`。更多症状见[故障排查](./operations.md#故障排查)。

## 6. 完成第一次验证

<a id="创建记忆体"></a>

### 创建记忆空间

1. 打开“记忆空间 → 概览”。
2. 点击“创建记忆空间”。
3. 人工选择已启用的 Provider。保留 **Mnemon Native** 即使用官方本地优先默认；三方服务需先在设置中启用。
4. 使用主题明确的名称，例如“项目决策”。
5. 在说明中写清“哪些内容属于这里，以及什么任务应召回它”，然后开启读取激活开关。

空存储根的第一个记忆空间会使用 Mnemon 原生 `default` Store ID，但仍显示你填写的名称与说明；激活开关只影响 DSH。

**智能选择属于“记忆空间 → 沉淀策略”，不是创建弹窗的另一种模式。** 它先由 Host 强制执行候选白名单、数据边界和能力要求。只剩一个候选时直接按规则确定；仍有多个候选时，独立任务 Agent 才会参考软偏好与策略 Prompt。Provider 凭据不会进入模型上下文，最终卡片会保留选择来源、理由与置信度。

连接外部服务或 CLI 前先阅读[长期记忆 Provider](./memory-providers.md)。

### 沉淀一条测试信息

点击右上角“沉淀记忆”，填写一条稳定、自包含、未来仍有用且不含秘密的信息。默认不要展开高级选项，让独立任务 Agent 自己选择目标、查重与提炼。

只有点击确认才会启动独立任务 Agent 执行写入；取消弹窗不会改变状态。

### 验证召回

1. 打开“记忆空间 → 检索”。
2. 输入一个能命中刚才内容的具体问题。
3. 先用“直接检索”检查原始证据。
4. 确认结果包含记忆空间来源、分类、重要性、分数和 ID。

也可以在对话中运行：

```text
/mnemon status
/mnemon recall <聚焦查询>
```

## 7. 验证对话内记忆

在一个确实依赖历史信息的问题中，让 Agent 自主判断是否需要召回。完成后：

- 若本轮调用了记忆工具，回复下方会出现“本回合记忆”；
- 展开后可以看到具体工具名，并点击跳到对应页面；
- “存入记忆”会先打开可编辑确认弹窗，取消不会写入。

普通聊天不应强制召回。当前请求、现有源文件和实时工具结果应优先于历史内容。

## 8. 下一步

- 用 [Sidebar 与对话交互指南](./ui-guide.md) 认识全部页面。
- 用[存储模型](../reference/storage-model.md)决定信息应进入运行时、档案还是记忆空间。
- 用[配置参考](../reference/configuration.md)设置工作区范围、只读模式或生命周期开关。
- 用[运维指南](./operations.md)导出第一份 ZIP 备份并建立升级前检查流程。

## 可选工作区服务

独立 Source、策略、启用方式、数据职责及验收证据见[可组合的工作区服务](workspace-services.md)。
