# 运维、安全与故障排查

**简体中文** | [English](../en/operations.md) | [文档中心](./README.md)

## 健康检查

先检查二进制，再查看工作台“状态”：

```sh
command -v mnemon
mnemon --version
```

Windows PowerShell：

```powershell
Get-Command mnemon -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"
```

```text
/mnemon status
```

[![状态页：组件版本、三层数据与实际存储目录](../assets/screenshots/status-overview.png)](../assets/screenshots/status-overview.png)

状态页显示 Mnemon / dsh-mnemon 版本、Runtime、Memory Spaces、Documents 和当前实际目录。`mnemon status` 会打开有效 Store，上游 CLI 可能初始化数据或执行迁移，因此不是完全无副作用的只读探测。

## 版本检查与更新

状态页的“检查版本”打开“检查与更新版本”面板：

[![检查与更新 Mnemon CLI 和 dsh-mnemon](../assets/screenshots/version-check.png)](../assets/screenshots/version-check.png)

- **Mnemon CLI**：本地版本来自 `mnemon --version`，最新版本来自 Mnemon GitHub Releases。
- **dsh-mnemon**：运行版本来自当前插件包，最新版本来自 npm registry。

检查只读，不会自动安装。只有发现更高版本并安全识别安装来源时才显示“更新”：Mnemon 支持 Homebrew Cask / Formula 与 `go install`；dsh-mnemon 支持当前 DSH Profile 中由 pnpm 管理的 npm 安装。`link:` / `file:` 开发版本与无法识别的手工安装只显示说明，避免覆盖源码。

更新命令由 Host 固定选择：浏览器不能传入命令或参数，执行禁用 shell，并限制时间与输出。更新完成后界面自动重新检查两个组件并刷新状态。Mnemon CLI 从下一次调用起生效；dsh-mnemon 仍需重启 `dsh web` 才能加载新插件代码。

DSH rc.8 首次说明的可选 SQLite 不兼容性在 DSH 0.1.1-rc.2 中仍然存在。它只针对 `@deepseek-ai/dsh-session-persistence-sqlite`，内置 profile 默认不启用。rc.2 后端使用 schema 17，会拒绝旧 schema，且不提供迁移路径；手工挂载过它的部署应先备份，再重建 DSH 会话数据库。dsh-mnemon 的 Runtime、Documents、Memory Spaces 与 Provider 数据位于独立存储根，不受影响。

## 备份与恢复

### 推荐：设置页 ZIP

“设置 → 记忆系统 → 备份与迁移”针对**当前有效根**工作：

- **导出 ZIP**：包含 Runtime、Documents 和全部 Mnemon Native Memory Spaces；三方连接、本地外部 Store 与远程数据不进入包；
- **导入 ZIP**：先预检，再合并到当前有效根；
- 包内包含 `manifest.json`、SHA-256 清单和三类数据摘要；
- 导出与导入持有组件锁，Memory Space 仍有未 checkpoint 的 WAL 时会拒绝；
- 导入检查路径、数量、压缩 / 展开大小、JSON schema、Document 哈希、registry 与 SQLite 头；
- 合并先写 staging，再替换目标组件；提交失败会恢复导入前目录。

当前 UI 只提供安全合并，不做“覆盖一切”：

- Runtime 按目标与内容去重；
- 相同 Document ID + 相同内容跳过，ID 冲突且内容不同则生成新 ID；
- 相同 Memory Space ID + 相同数据库跳过，内容不同则生成新 ID。

导入受 `writeEnabled` 控制，只读部署会拒绝。ZIP 包含私有记忆，应加密、限制访问并验证恢复。Provider 凭据保存在 `state/memory-providers.json`（`0600`），不会进入 ZIP。已保存的值只经认证后的管理通道返回，绝不进入普通脱敏读目录；若要备份连接，需要按下述离线快照保护整个 `state/`。

### 恢复演练

1. 先选择一个隔离的 `custom` 目录并保存。
2. 确认设置页显示的“当前目录 ZIP”正是隔离根。
3. 选择备份，阅读预检摘要后执行导入。
4. 在状态页检查 Runtime、Documents、Memory Spaces 与目录。
5. 用一个聚焦查询验证直接检索，再阅读一份档案。
6. 验证无误后再决定是否切换正式范围。

不要在没有备份时把恢复直接指向唯一生产根。

### 文件系统级快照

需要保留预留 `state` 或做离线完整快照时，可以停止所有使用该根的 DSH / Mnemon 进程后复制：

```text
<storageRoot>/runtime
<storageRoot>/documents
<storageRoot>/data
<storageRoot>/state    # 若存在；不在内置 ZIP 的三类数据组件中
```

复制完成后生成文件清单或校验和，并在隔离路径演练恢复。不要在多个进程仍写入时把普通目录复制当作一致快照。

## 切换存储范围

保存 `global` / `workspace` / `custom` 后，Host 先初始化新运行图，再原子切换；页面自动重新读取，但**不会迁移数据**：

```text
旧范围 -- 保存设置 --> 新的空目录或既有目录

不自动复制
不自动合并
不自动删除
```

推荐迁移流程：在旧范围导出 ZIP → 切换到新范围并确认显示目录 → 导入 ZIP → 验证。工作区模式下先确认查看工作区与会话执行工作区是否是预期目标。

现有回合和已委托的子 Agent activation 可能仍使用旧运行图。迁移或停用其数据前，应等待它们结束或取消这些任务。父回合结束本身不会释放异步子任务的委托；新创建或冷恢复的 activation 会捕获自己获准使用的 generation。

## 安全边界

### 进程

- CLI 使用 `spawn(command, args, { shell: false })`，不拼接 shell。
- stdout + stderr 默认合计限制 2 MiB。
- 每次调用受 `timeoutMs` 与 AbortSignal 控制；取消先 `SIGTERM`，1.5 秒后 `SIGKILL`。
- 单个 Runner 内调用串行；跨 DSH 进程仍依赖 Mnemon / SQLite 并发语义。

### 文件

- Runtime、Documents 和 Pack 操作使用进程内队列或组件锁。
- lock 默认等待 5 秒，超过 30 秒才视为 stale。
- 写入使用临时文件、staging 与 rename。
- Runtime revision 阻止过期压缩覆盖；Document revision 阻止移动已更新原文。
- `sourcePaths` 不能逃出发起会话工作区，也不能指向受管 Documents 目录。

### Web 与模型

- DSH 0.1.1-rc.2 中，读与激活使用 `trusted-host`；写、设置和备份默认保持 `loopback`，只有 Host 本地 `remoteAccess: trusted-host` 才会将三者整体提升。
- DSH 0.1.2-alpha.1 中，所有 RPC 与 stream 都要求同一个已认证浏览器会话；保留的 `remoteAccess` 不影响 transport。
- 普通 Provider 目录始终脱敏；已保存凭据只会经当前版本对应的受保护管理通道返回。
- WebUI 依据 Host 返回的可写 settings snapshot 判断产品能力，不再根据传输位置猜测权限；设置通道不可用时会显示明确诊断，而不是空白页。
- WebUI 不直接读取 SQLite、启动进程、调用远程 Provider 或指定任意更新命令；Provider 网络访问只发生在 Host。
- worker 使用 persona、工具白名单、经过 schema 校验的一次性结果工具与 `maxDepth: 1`。
- 查询、候选、档案正文与历史记忆全部按不可信数据处理。

这些边界不是秘密扫描器。当前没有确定性的凭据检测；不要提交密钥、token、私钥和原始敏感日志。

### 安全问题报告

按 [SECURITY.md](../../SECURITY.md) 私下报告漏洞，不要创建公开 issue。数据丢失、路径穿越、锁 / revision 绕过、子 Agent 隔离破坏和 WebUI 记忆内容注入都在范围内。

## 故障排查

`mnemon.cliPath` 接受显式路径，也接受按 Host 的 PATH 查找的命令名。DSH 运行时，若二进制安装或恢复到既有搜索目录，点击“重新检查”即可刷新可用状态，无需重启；Host 进程环境变量的变化仍需重启。状态与版本检查解析同一个配置命令。

| 现象 | 检查与处理 |
|---|---|
| Mnemon 不可用 | macOS/Linux 运行 `command -v mnemon`、`mnemon --version`；Windows PowerShell 运行 `Get-Command mnemon`、`Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`。设置 `MNEMON_CLI_PATH` 或 `mnemon.cliPath` 后重启 |
| Headless Agent 没有 Mnemon 工具 | 插件按 profile 独立安装；运行 `dsh plugin --profile headless add dsh-mnemon`，Web profile 的安装不会自动带入 |
| 找不到“记忆系统”入口 | 检查 `tabEnabled=true`；`displayMode=sidebar` 使用侧边栏，`displayMode=builtin` 使用已打开会话的标签页。本地 link 先 `pnpm run build` 再重启 profile |
| 状态正常但召回为空 | 检查 active 记忆体、存储范围、查看目录、会话实际目录和查询是否足够聚焦 |
| 顶部提示目录未对齐 | 工作台正在查看另一个工作区；点击一键对齐，或有意保留只读查看；Agent-backed 操作在未对齐时拒绝 |
| 设置保存后无变化 | 查看保存错误；成功保存应实时切换并自动重新读取，不需要刷新 |
| 自定义目录被拒绝 | 使用绝对路径、`~` 或 `~/...` |
| `memoryBodyId is required...` | active 数量不是恰好 1；显式选择目标 |
| `memory body is not active for reading` | 在概览激活目标；写入 inactive 可以，读取不行 |
| Provider 错误 | 普通语义任务需要完整隔离能力；后台审查另需 `fork + inheritsParentContext` |
| Runtime replace 超容量 | 缩短 replacement 或先显式整理；自动维护只处理 add 溢出 |
| Document source path 被拒绝 | 路径必须在会话工作区内，且不能引用受管 Documents 目录 |
| CLI timeout | 增大 `timeoutMs`；大 Store 的状态与图谱可能超过 10 秒 |
| lock timeout | 检查其他写进程，不要删除仍属于活跃进程的 lock |
| 记忆系统白屏并提示 `refreshSnapshot` 或 settings store 错误 | 将 dsh-mnemon 升级到 v0.4.1 并重启所属 DSH profile；设置回调会保留宿主 store 的 `this` 绑定 |
| ZIP 导出提示 `date not in range 1980-2099` | 将 dsh-mnemon 升级到 v0.4.1；固定本地 ZIP 日期字段后，UTC 以西时区可以正常导出，相同导出的归档字节也不再因时区变化 |
| ZIP 导出提示 WAL busy | 等待 Memory Space 写入完成并重试；不要绕过未 checkpoint WAL 检查 |
| ZIP 导入 checksum / schema 失败 | 备份损坏或格式不兼容；保留当前根，不要手工解压覆盖 |
| 更新按钮不出现 | 当前已是最新、远程检查失败，或安装来源是 link / 手工模式；按面板提示沿原方式更新 |
| rc.2 远程页面能切换记忆体，但不能执行其他写操作 | 默认安全设计；仅在入口已有可靠认证时，本地设置 `remoteAccess: trusted-host`、配置 DSH `trustedHosts` 并重启 Host |
| alpha 中 DSH 重启或 authority 改变后 Mnemon RPC 返回 401 | 打开 `dsh web` 输出的启动 URL，让一次性 token 建立新的、与 authority 绑定的浏览器 Cookie |

## 已知限制

### 功能只读不等于磁盘只读

`writeEnabled=false` 禁用语义 mutation 与 Pack 导入，但启动可能初始化 / 修复 Runtime 投影，Document 搜索更新 `lastAccessedAt`，Mnemon 读命令也可能迁移数据库。

### Documents 的共享范围

`global` 与 `custom` 可能让多个工作区共享同一 Document index；记录没有独立 workspace ownership 字段。`sourcePaths` 只在写入时相对发起会话 cwd 校验。

### 跨系统事务

“先冷索引、后移动”保护 active 原文，但不是跨 Mnemon SQLite 与文件系统的可回滚分布式事务。索引后发生 revision 冲突时可能保留重复引用；系统选择保留数据。

### 后台水位

活动评分、最近 checkpoint 与重试状态未持久化；Host 重启会清空未处理活动。失败退避、熔断和人工重试入口尚未实现。

### 版本与国际化

尚无正式固定的 DSH / Mnemon 支持矩阵。主要 Web 界面为中英文双语，但命令、工具卡、兼容元数据和部分错误仍未完全国际化。
