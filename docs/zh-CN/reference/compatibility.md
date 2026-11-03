# 兼容性与升级

**简体中文** | [English](../../en/reference/compatibility.md) | [文档中心](../README.md)

Starter 固定经过测试的官方插件组合。下表记录验证范围，不承诺所有上游版本或账号配置都已验证。

| 组件 | 基线 | 已验证的范围 |
|---|---|---|
| DSH 当前 RC | `0.2.1-rc.5` | 锁定的开发基线，同时进入已安装宿主 CI。2026-11-02 核对时 npm 的 `latest` 和 `next` 标签均指向此版本；它仍是预发布版。 |
| DSH 早期受支持宿主 | `0.2.0-rc.2`, `0.2.1-rc.3` | CI 在这些已安装包上运行全部根测试。版本差异见 [DSH 0.2.0 与 0.2.1](#dsh-020-与-021)；支持范围仍包含 0.2.1-rc.1 和 rc.2。 |
| DSH alpha 通道 | `0.2.2-alpha.2` | 独立的已安装宿主 CI 使用已验证的 Node 24.22.2，以满足构建工具要求；已发布 alpha Host 本身要求 Node 24.9.0 或以上。此版本是 2026-11-02 核对的 npm `alpha` 标签，不作为默认开发宿主，也不保证之后的 alpha 版本。 |
| Node.js | `22.19`、`24` | 分别用于源码 CI 与打包制品 CI；开发要求 `^22.19.0 \|\| >=24.11.0` |
| Node.js 20 | 仅公开包入口导入 | 不代表 DSH Host 能在 Node 20 运行 |
| Mnemon Native CLI | `0.2.9`；嵌入模型检测要求 `0.2.13+` | 用真实 CLI 和临时数据执行可选测试，CLI 单独安装。旧版的其他命令仍可使用，但“测试状态”会提示升级，因为旧版可用性字段只证明 Provider 可达 |
| 三方 Provider | 适配契约与夹具 | 不代表真实云账号一致性或上游服务可用性已验证 |

DSH 0.2.1-rc.3 及当前 RC/alpha 验证目标会联网获取官方 API Key 的模型目录。任务 Agent 模型选择列表为该 Provider 保留最多六秒，覆盖 DSH 默认的五秒请求预算；其他 Provider 仍为三秒。此调整仅影响目录加载，不改变模型选择、推理超时或已保存配置。

dsh-mnemon 支持 `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`：DSH 0.2.0 从 0.2.0-rc.2 起，DSH 0.2.1 及之后的 0.2 版本从 0.2.1-rc.1 起，正式版也在其中。DSH 0.2.1 从 Starter 的 `engines.dsh` 读取这个范围；DSH 0.2.0 从 Starter 的 DSH peer（可选的 `dsh-app-boot` 与 `dsh-typert-protocol`）读取，两者写的是同一个范围。DSH 在安装插件前，以及每次启动 profile 时，都会用自身版本检查这个范围，预发布版本也参与比较；不包含当前 DSH 的版本会被拒绝安装或停用。`tests/dsh-host-compatibility.spec.ts` 对全部 19 个包的清单执行 DSH 自己的检查，既覆盖受支持的版本，也覆盖已不再支持的版本。五个 Strategy 包使用新的扩展 SDK，要求 `dsh-mnemon ^0.5.17`；Documents、Memory Spaces 与 Runtime 三个 Source 要求 `^0.5.19`，Skills Source 要求 `^0.5.37`；Provider 则依赖记忆空间 Source。

DSH 0.2.2-alpha.2 将工具执行拆为独立的 native/PTC executor 插件，并将 `tools.execute()` 改为批量 API。Mnemon 根据已发布的 `setExecutor()` 能力提交一次关联调用，只接受调用 ID 匹配的最终结果。Host 仍负责 guard、执行前后策略及 PTC 调度。自动准入还依赖 [#541](https://github.com/omdsh-dev/dsh-mnemon/issues/541) 的轮内审计修复；[#542](https://github.com/omdsh-dev/dsh-mnemon/issues/542) 的 View 缺失问题独立修复。本次兼容适配使用已发布 npm 包和隔离的合成 profile，不修改 DSH 源码、存储格式或支持版本范围。验证范围与上游来源见[当前 DSH 证据](../../pr-assets/current-dsh-compat/README.zh-CN.md)。

Source 工具激活使用受支持的 0.2.0/0.2.1 Host 已发布的 `tools.register()` disposer 与作用域 `tools.get()` 契约。DSH 应用 `restrict()` 前，子 Agent 允许列表会剔除未注册的可选工具。首次通过 Loader 启动时，命名工具族在 `Loader.await()` 就绪后按原有目录顺序发布；后续恢复会追加工具族，不重新注册仍在运行的工具。DSH 默认独立排序请求中的工具 schema。Source 配置事务保留原有工具目录，直到发布最终提交状态。[合成 Host 证据](../../pr-assets/issue-522-source-tool-lifecycle/README.md)记录本地 schema 更新、Documents/Runtime 保留写入与 spawn/fork 审查覆盖；PR 当前 head 仍需远程兼容性 CI。存储格式、Provider 契约和既有 View 授权检查保持不变。

<a id="首次安装时的宿主行为"></a>

Git 同步保留原有设置与载荷格式。保存的默认提交者组合现在优先使用镜像中的 Git 身份，缺失时才使用占位值；其他自定义组合仍然优先。重试作者被拒绝的同步时，只从当前记忆重建镜像中未发布的提交，已发布历史保持不变。回滚到 0.5.38 或更早版本时，选择**本机 Git**（作者字段留空）或**自定义**以保留真实身份；这些版本会按默认组合的字面值提交。见 [Git 仓库同步](../guides/operations.md#git-仓库同步)。

第一次安装？DSH 如何选择安装源、安装结果卡片为什么显示软件包的英文简介，见[安装与启动](../guides/installation.md#3-安装并启用-dsh-mnemon)；发布不足 24 小时的版本为什么会装成较早的版本，见[常见问题](../guides/installation.md#常见问题)。

<a id="更早的-dsh"></a>

**更早的 DSH。** 升级宿主之前，请继续使用支持你的 DSH 的 dsh-mnemon 版本：

| DSH | dsh-mnemon |
|---|---|
| `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.1-alpha.2` | `0.5.30` |
| `0.2.1-alpha.3` 及之后的 alpha | 没有完全可用的版本：在 0.5.30 中记忆子 Agent 与**检查版本 → 更新**都会失败。请把 DSH 升级到 `0.2.1-rc.2` 或更新版本 |
| `0.1.5-rc.1` 至 `0.1.7-alpha.1` | `0.5.16` |

这些宿主需要的内容保留在[旧版 DSH 宿主](#旧版-dsh-宿主)。各版本如何验证，以及仅保留为历史证据的较早 Headless 和 WebUI 记录，见[验证与证据](#验证与证据)。

### DSH 0.2.2 源码版的归属兼容（#554）

`8bd073392eef6f54e921a093b95076248eb08cbb` 源码构建与 npm `0.2.2-alpha.3` 不同：已发布包仍提供 `agents.roots()` 和 `agents.isOwnedBy()`；源码版改为 `subagents.rootOf()`，展开 `startActivation()` 的任务参数，并移除了 Provider 枚举。Mnemon 按 Host 的确切存活实例归属接管根 Agent、启动带守卫的 spawn/fork 委派，不从 Session header 推断权限。提供 `lineageOf()` 的 Host 使用发布时的绑定；较早的 `rootOf()` 契约则在 prompt 入队前的 `subagent/start` 安装子级组合与守卫，安装失败会取消启动。没有 Provider 枚举时，仅探测官方 `spawn` 和 `fork` 名称。

**这是启动及对话委派的限定兼容修复，不代表 DSH 0.2.2 源码版的所有功能均已兼容。** 该源码 Host 没有 Mnemon 隐藏独立任务 Agent 的公开等效能力：它拒绝标为 subagent 的独立 Agent，而普通根 Agent 可能在历史列表留下不需要的会话。因此 Mnemon 在创建任何 Session 前明确拒绝独立管理任务。受影响入口包括独立 Skills 任务、记忆页面的证据回答和保存到记忆、Runtime 维护、Document 创建与归档、Provider 放置，以及记忆空间元数据维护。对话内记忆及带守卫的 spawn/fork 委派仍可使用。需要上述独立操作时，请使用已验证的正式发布包 `@deepseek-ai/dsh@0.2.1-rc.5`；现有已发布 Host 的任务行为和数据保持不变。

源码构建、合成模型验证、npm alpha.3 检查及尚未通过的完整测试和 Profile 检查见 [issue #554 验证记录](../../pr-assets/issue-554-agent-ownership/README.md)。本修复不修改 DSH 源码、开发依赖基线、配置格式或已存储的 Session。

## 升级默认安装

1. 导出 Mnemon Pack；需要保留 Provider 连接时，按[运维指南](../guides/operations.md#备份与恢复)保护额外备份。
2. 在每个使用它的 DSH Profile 中升级 `dsh-mnemon`，可以用**检查版本 → 更新**，也可以用[安装与启动中的命令](../guides/installation.md#更新与卸载)。Starter 安装精确的插件版本；不要单独更新其子包后，就假定混合组合已经验证。同时要换用另一个 DSH 版本时，请按[升级顺序](#升级顺序)操作。
3. 安装新包代码后重启 DSH。检查“记忆系统 → 状态”，再读取一条已有 Runtime、档案及已激活记忆空间。
4. 写入前确认存储范围。切换范围只是选择另一份数据权威，不会迁移数据。

### 升级顺序

先在现有 DSH 中更新 dsh-mnemon，再升级 DSH。在 DSH 0.1.7-rc.2 上，先把 dsh-mnemon 更新到 0.5.30（`dsh plugin --profile web add dsh-mnemon@0.5.30`），然后安装 DSH 0.2.0-rc.2 或 0.2.1-rc.2，再更新一次 dsh-mnemon。若先升级了 DSH，DSH 0.2 会停用 0.5.19 之前的版本，记忆数据不受影响，更新插件后即可恢复；在 DSH 0.2.1 上，0.5.30 及更早的版本仍会运行，但记忆子 Agent 与**检查版本 → 更新**都会失败，直到更新为止。不要用 `allow-version` 为不受支持的版本放行。

在 DSH 0.2.1 上，dsh-mnemon 0.5.30 及更早版本的**检查版本 → 更新**会停在 `already-installed`。请退出 DSH，运行 `dsh plugin --profile web add dsh-mnemon@<版本>`，再启动 DSH。命令行不管理桌面版的 `desktop` profile：在桌面版中，请在插件页**卸载** dsh-mnemon，再通过**添加插件**以 `dsh-mnemon@<版本>` 重新安装，然后完全退出并重新打开应用。记忆数据与设置都会保留。之后的更新照常通过**检查版本**完成。

### 从 v0.4 升级

v0.5 保留默认 v0.4 的存储、配置与侧栏工作流。可选的会话标签页入口（`builtin`）使用同一组 Source 页面，旧 `buildin` 拼写会规范化。通用策略与三个记忆增强默认关闭。插件页中的记忆组合负责列出、开关和配置已安装的组件；没有单独的 View 页。

### 独立插件

独立插件作者使用声明的 peer 范围与公开出口；旧的私有控制器导入不属于受支持的升级表面。自定义组合需要独立于 Starter 验证，参见[插件开发](../development/extensions.md)与[v0.5.0 发布边界](../releases/v0.5.0.md)。

<a id="dsh-02"></a>

## DSH 0.2.0 与 0.2.1

dsh-mnemon 在两个版本上运行方式相同，使用同一份记忆数据。

“本回合记忆”以稳定 ID 注册到 DSH 的 `conversation.chat.turnTail` list 插槽，并在读取或展示活动前检查回合是否已完成。侧栏入口与**插件 → 可组合记忆**页面跟随 DSH 公开的默认／主会话 binding；会话标签页入口和 Better Sidebar 保留显式所属会话。DSH 将动态设置保存在 profile Config 中，并在“插件”中每个插件的页面编辑其配置；Mnemon 的配置页通过它写入。记忆数据和 Provider 格式不变。

两者不同的地方，dsh-mnemon 走各自提供的路径：

- **记忆子 Agent。** DSH 0.2.0 用一次性的 `subagents.start` 启动子 Agent，它的 spawn 与 fork provider 从启动请求中接受子 Agent 的指令和工具过滤。DSH 0.2.1 把所有子 Agent 都作为托管 activation 启动（`startActivation`，[#356](https://github.com/omdsh-dev/dsh-mnemon/issues/356)），两者都不再接受：子 Agent 要么沿用父 Agent 的工具与指令，要么使用为它指定的 Agent 预设。在 DSH 0.2.1 上，dsh-mnemon 以 caller 方式交付每个记忆子 Agent 的结果，所以结果回到 Mnemon，对话不会收到完成通知；并在 DSH 发布子 Agent 时、它的第一步之前，也在其他插件看到它之前，把它的指令和工具清单注册在它自己的作用域里。无论哪个版本，子 Agent 都只看到记忆工具和结果工具。这涵盖存入记忆、`mnemon_remember` 等记忆空间写入、USER.md 压缩、工作记忆归档、空闲审查、项目档案归档以及 Git 同步的核对审查。在 DSH 0.2.1 上，只有由 DSH 在本进程中创建子 Agent 的 provider（例如它的 spawn 与 fork）才会这样使用；其他 provider 在启动前就被拒绝，所以记忆任务不会带着对话的工具运行。
- **DSH 0.2.1 上可续接的记忆任务。** 在那里所有本地子 Agent 都可以续接：
  - 在对话之下启动的子 Agent，例如委派写入或空闲审查，会以“可继续”出现在对话的子 Agent 列表中。之后模型发来的消息，或你在该列表中发给它的消息，会在 Mnemon 的委派之外续接它，并带着对话自己的工具和指令。任务结束后，Mnemon 拒绝它使用任何记忆工具，它只能回复（[#387](https://github.com/omdsh-dev/dsh-mnemon/issues/387)）。Mnemon 无法移除这些条目，请不要续接它们，有需要时直接在对话中提出；
  - 它运行期间会占用对话的一个子 Agent 名额（`maxActiveSubagents`，默认 8 个）。名额用满时，记忆任务会因 `subagent limit reached` 失败。

  在 DSH 0.2.0 上，记忆任务无法续接。
- **工作目录。** 每一步之前，如果当前目录已不存在，DSH 0.2.1 会把 Agent 退回会话的原始目录；原始目录也不存在时就停止该 Agent。因此工作区文件夹被删除或移动后，该工作区的后台记忆任务仍然以这个工作区为准（它操作的正是这个工作区的记忆），并在第一个仍存在的工作区或 DSH 的启动目录中运行。DSH 0.2.0 不为每个会话保存工作目录。
- **检查版本 → 更新。** DSH 0.2.0 用自己的安装器安装新版本。开启热重载时，DSH 0.2.1 不再覆盖安装 profile 中已有的插件：要换成另一个版本，只能先移除再安装，这会让 dsh-mnemon 在更新自己时中途停止，安装失败还会让 profile 失去它。因此在 DSH 0.2.1 上，dsh-mnemon 对新版本运行 DSH 自己的 `dsh plugin add`（[更新如何进行](../guides/operations.md#版本检查与更新)）：它持有 profile 的锁，使用 DSH 启动时的包管理器，并在安装任何东西之前拒绝与当前 DSH 不兼容的版本。DSH 没有提供这个命令时，错误信息会给出应在 DSH 停止时运行的 `dsh plugin` 命令。两个版本上更新都在重启后生效。dsh-mnemon 0.5.30 及更早版本在 DSH 0.2.1 上会停在 `DSH could not install dsh-mnemon@<版本>: already-installed`；请按[升级顺序](#升级顺序)中的方法更新一次。
- **不兼容的版本。** DSH 以不兼容为由拒绝更新时，错误信息会写明该版本的要求：DSH 0.2.1 报告版本的 requirements，显示为 `requires DSH ^0.3.0`；DSH 0.2.0 报告它的 peer，显示为 `requires @deepseek-ai/dsh ^0.3.0`。
- **插件页。** DSH 0.2.0 会把 Starter 的分组行列为已关闭的组件，见 [DSH 0.2.0 上的 bundle 组件列表](#dsh-020-上的-bundle-组件列表)。DSH 0.2.1 只列出各组件。

这些路径在代码中的位置，以及 DSH 0.2.0 一侧何时可以移除，与其他兼容代码一起列在[兼容登记表](../development/compatibility-register.md)中。

## 桌面版窗口

DSH 桌面版窗口从应用自己的 `dsh-app://app/` 地址加载，而不是回环地址。应用自己提供的页面（非 `http:` / `https:` 地址）使用 Mnemon 的本地通道；只有 DSH 为页面声明了不持有 Host 的传输方式时，才按远程页面处理。DSH 桌面版声明 `ownsHost: true`。从其他设备打开的页面继续经 API Gateway、默认只读，并在记忆系统与插件设置中写明需要 `remoteAccess: trusted-host` 与重启 DSH。本地通道与 `/api` 使用 DSH 相同的 Host/Origin 校验与浏览器会话认证。0.5.18 及更早版本在桌面窗口中显示的只读状态见 [DSH 0.1.7 上的桌面版窗口](#dsh-017-上的桌面版窗口)。

## 安装后直接启用 Starter

Desktop generation 目录和 pnpm 安装可能只在 profile 中暴露 `dsh-mnemon` 根包，最早见于 DSH `0.1.7-rc.2`。各组件已在它的依赖树中安装，但如果宿主启动时未选中该 bundle，首次启用仍可能使用启动时的包解析表，导致 Runtime、Documents、Memory Spaces 和默认 Strategy 抛出 `ERR_MODULE_NOT_FOUND`。

Starter 的组件组 `mnemon-bundle`（模块 `dsh-mnemon/bundle`）先准备依赖解析，再用 DSH 自己的 `cordis:group` 挂载子组件。它调用宿主公开的包解析服务，保留其他 bundle 启动时的依赖路径，并由宿主拒绝不兼容的模块重绑定；不平铺组件包、不改写 profile 链接、不修改 DSH。已有 Entry ID、核心停用总开关、各组件的独立选择和记忆数据均保持不变。0.5.18 与 0.5.19 由单独的就绪条目 `dsh-mnemon/starter`（`mnemon-starter`）完成这一步，组件组等它提供 `mnemonStarterReady`；0.5.20 起两者合为一个条目，插件页不再显示单独的就绪行，组件组也不会因为它被关闭而一直等待。

Mnemon 同时在自己的传输注入作用域内注册 Web RPC，已运行的官方 Connection 无需重启。使用 bundle 或核心开关控制整套组合。在 0.5.18 与 0.5.19 中关闭 `dsh-mnemon/starter`，`mnemon-bundle` 会一直等待 `mnemonStarterReady`：`dsh web` 照常启动但没有记忆系统，桌面版则按启动失败处理，见[安装与启动](../guides/installation.md#dsh-提示waiting-for-service-mnemonstarterready)。更新到 0.5.20 或之后的版本后，profile patch 中残留的 `- id: mnemon-starter` 不再对应任何条目，宿主会忽略它（桌面版日志提示 `patch: entry "mnemon-starter" not found`），可以删除这两行。

代价在 DSH 的配置 schema 导出：`dsh web --dump-config-schema` 只识别原生 `cordis:group` 与 `cordis:include`，会把 `mnemon-bundle` 报告为无法识别的树载体，并略去其中各组件的 schema，与 DSH 自带的 agent preset 相同。运行时配置、插件页与 profile patch 不受影响。

官方 WebUI 首次安装后，可以在同一宿主进程中点击“立即启用”；已安装但停用的 bundle 也可直接启动。更新或卸载 Node 已加载过的包时，仍须遵循 DSH 的正常重启要求，这一机制不替换已加载模块。例如原地更新后不重启就启用组件，会提示新版本才有的入口未导出（`ERR_PACKAGE_PATH_NOT_EXPORTED`）：从 0.5.17 或更早的版本更新时是 `./starter`，从 0.5.18 或 0.5.19 更新时是 `./bundle`。加载器不会为运行中的条目更换模块，因此从 0.5.18 或 0.5.19 更新时，也可能是运行中的旧组件组一直等待已移除的 `mnemonStarterReady`（`mnemon-bundle (dsh-mnemon/bundle): pending …`）。重启后两者都会恢复，见[升级验收记录](../../pr-assets/starter-group-upgrade/README.zh-CN.md)。参见[安装与启用验收记录](../../pr-assets/desktop-live-activation/README.zh-CN.md)与[组件组验收记录](../../pr-assets/starter-group-readiness/README.zh-CN.md)。

<a id="dsh-017-bundle-组件列表"></a>

## DSH 0.2.0 上的 bundle 组件列表

与 0.1.7 一样，DSH 0.2.0 的“插件 → 可组合记忆”详情页会把 `mnemon-bundle` 内部容器列为“已关闭”的组件（0.5.20 起显示为 `dsh-mnemon/bundle`，此前为 `cordis:group`）。9 个实际组件全部运行时，列表显示“共 10 个 · 9 运行中 · 1 已停用”。点击容器开关会返回 `unknown-plugin`，中文界面提示“组件启用失败：找不到该插件”。参见[原始截图](../../pr-assets/sidebar-native-20260926/before-bundle-toggle-error.jpg)与[上游问题 #649](https://github.com/dsh-external/issues/issues/649)。DSH 0.2.1 不再列出这个容器。

这是宿主的展示与管理清单不一致：bundle 声明列表包含原生 group，但可管理插件清单明确排除了 group。该行的“已关闭”不代表 Mnemon 核心或其子插件已停用，也不能据此判断记忆读写是否正常。

遇到这一现象时：

1. 查看“记忆系统 → 状态”以及实际 Source、Strategy 组件的状态。如果只有内部容器误显示关闭，而所需组件和读写正常，可以继续使用；实际组件报错或读写失败仍需单独排查。
2. 停用或恢复整套组合时，使用顶层 `dsh-mnemon` bundle 开关，或对应 `mnemon` 条目的核心组件开关；不要使用 `mnemon-bundle` 容器行的开关。DSH 列出该行时，可组合记忆配置页会在组件列表上方注明这一点。
3. 保留已有配置和记忆。此显示问题不需要重置数据，也不需要迁移配置或记忆。

Starter 保留稳定的 group ID 和已有 `mnemon` 配置目标。停用核心会停止其 Source、Strategy 和私有 Provider 子项；重新启用后，各组件恢复各自的独立选择。移除 group 会让仍启用的依赖项等待缺失的核心；将 group 改为匿名条目则可能在 profile 重载后留下旧实例。不要通过删除容器、稳定 ID 或修改分组声明来隐藏这一行。[正式宿主生命周期回归](../development/README.md#测试归属与覆盖)在不修改已安装宿主的前提下，验证管理器持久化、重启及旧版字面值／表达式停用标志。

<a id="dsh-017-设置恢复"></a>

## 来自旧宿主的设置

DSH 0.1.7 用基于 Config 的表单替代了 `settings.register()` 和 `settings-file`，之后的版本沿用这一方式。Mnemon 提供动态 Config 字段，现有界面操作通过宿主检查 revision 的 profile 写入器持久化；修改传输权限仍需正常重载插件。

Mnemon 消息使用 Session V3、V4 均接受的生产者专属来源 `dsh-mnemon`。过滤和去重仍识别历史包装，以及 DSH 迁移后的 `plugin:dsh-mnemon` 消息；本改动不会重写已有 Session 文件。委派的子 Agent 收到的任务则是一条用户消息，以它的首行标记；见[委派的子会话](./workflows.md#委派的子会话)。

旧宿主留下的 `settings.yaml` 会由 DSH 一次性导入 profile，并保留为 `<profile home>/settings.yaml.imported`。启动时，Mnemon 可将这份备份恢复到可编辑的根 `mnemon` 条目，包括根设置、`mnemon-ui` 对话开关，以及仅属于当前 profile 的精确 `mnemon-view-*` / `mnemon-plugins-*` 命名空间。当前 profile 的显式值优先，包括显式清空的插件选择；已有 Source 和 Strategy 条目保持原样；Strategy 条目使用动态表达式时，会保留原表达式并跳过该条目的旧覆盖值，避免将当前求值固定下来。恢复后会在根 Config 中记录 `legacySettingsImported: true`，备份文件保持不变。

若 Mnemon 启动时原 `settings.yaml` 仍存在，由 DSH 执行导入；完成后再重启一次该 profile，恢复 Mnemon 专属偏好。DSH 未公开导入完成信号，因此 Mnemon 等待新宿主进程，避免并发写入。只读或归属不明确的根条目不会被修改；相关旧设置节损坏时，不做部分导入，也不标记完成。请保留备份，参考启动诊断后再修复；不会猜测自定义根 ID 或其他 profile 的 hash。

回滚到这样的旧宿主时，保留 profile patch 和旧设置备份，并重新安装支持该宿主的 dsh-mnemon 版本（见[更早的 DSH](#更早的-dsh)）。此后修改的设置不会自动反向导出到旧设置文件，需要恢复对应备份或在旧宿主重新设置；Runtime、档案、记忆空间与 Provider 数据不受影响。参见 [DSH 0.1.7 设置验证](../../pr-assets/issue-267-settings-migration/README.zh-CN.md)。

<a id="ptc-idle-review-history-recovery"></a>

## PTC 空闲审查历史恢复

v0.5.38 的自动审查可能在 `turn/end` 之后执行 PTC 可用性探测。DSH v4 读取器随后会以 `tool/ptc-dispatch-start is outside an open turn` 拒绝整个会话。修复将检查及其收尾放在可等待的回合停止钩子内；升级可防止新增问题，但不会改写已经损坏的历史。

对于受影响的**未继承历史的 v4 根会话**，包内恢复 CLI 可以生成单独副本。先停止 DSH，备份整个会话目录，并在已存在的备份目录中选择新输出路径：

```bash
dsh-mnemon-repair-session --input /backup/session.v4.jsonl.zstd
dsh-mnemon-repair-session --input /backup/session.v4.jsonl.zstd --output /recovered/session.v4.jsonl.zstd
```

第一条命令仅预览。生成副本时只识别回合外成对出现、保留原始 UUID 关联且结果参数为空的 `mnemon_subagent_result` 探测，并将完整审计数据保留为可忽略的 Mnemon 恢复记录。所有事件位置、时间戳、对话消息和无关原始行均保留，不截断历史，也不修改记忆存储。支持普通 JSONL 和带校验和的 Zstandard；从不覆盖输入或已有输出。继承/子会话、孤立探测、写工具调用、非空结果、歧义字段及被其他事件引用的探测记录都会被拒绝。

`migrationValidated: false` 表示 CLI 不为会话的其余部分提供有效性保证。请先用同一 DSH 版本在隔离会话存储中加载恢复副本，验证后在 DSH 停止时替换这一代文件，并离线保留原件。若 DSH 仍拒绝读取或 CLI 提示形状不受支持，保留原件请求诊断，不要删除记录。[合成复现与验证记录](../../pr-assets/issue-541-idle-probe-history/README.zh-CN.md)覆盖正式读取器、消息保持和恢复拒绝场景。

## 旧版 DSH 宿主

以下内容只适用于[上表](#更早的-dsh)中由较早 dsh-mnemon 版本支持的宿主。

### DSH 0.1.7 上的桌面版窗口

DSH 0.1.7 桌面版不为 `dsh-app://app/` 页面声明传输方式。dsh-mnemon 0.5.18 及更早的版本因此把桌面窗口当成远程页面：所有调用经 API Gateway，默认的 `remoteAccess: read-only` 使运行时记忆、记忆空间与插件设置在界面中只读，而 Agent 工具仍可写入（[#310](https://github.com/omdsh-dev/dsh-mnemon/issues/310)）。0.5.19 起这样的页面使用本地通道，见[桌面版窗口](#桌面版窗口)。

验证方式：模拟桌面壳的 Electron 窗口注册与官方桌面版相同的 `dsh-app` 标准安全协议，把请求代理到只监听 127.0.0.1 的 Host。已发布的 0.5.18 在 DSH 0.1.7-rc.2 上复现了只读（13 次 Mnemon 调用全部经 API Gateway）；修复后在 DSH 0.1.7-rc.2 与 0.2.0-rc.1（`ownsHost: true`）上均可添加运行时记忆，写入经本地 `/dsh-mnemon-write`，记忆空间与插件设置可编辑；通过可信 authority 打开的远程页面仍然只读并显示原因。

### 桌面版的 Profile generation

Desktop 可能删除插件 generation 内的私有 `@deepseek-ai/*` 包，改用宿主自己的框架版本。Mnemon 使用宿主公开的 Volatile API 构建动态设置 schema，DSH `0.1.7-rc.2` 通过 Cosmokit `1.8.5` 提供这些 API。宿主若携带不含这些 API 的旧版 Cosmokit（例如 `1.8.3`），即属于不受支持的宿主，请在该环境继续使用 dsh-mnemon `v0.5.16`。

受影响的 `0.5.13` 安装中，Desktop 的回退分支会将缺少 `createVolatile` 导出的真实错误隐藏为 `Cannot find package 'dsh-mnemon'`。平铺 `mnemon-bundle` 不能修复该导入失败。Starter 保留 group、根停用总开关、独立 Source/Strategy 选择、私有 Provider 子项和已有设置命名空间。在所属 profile 更新 Mnemon 后重启即可；本修复不需要迁移记忆或配置。参见[原版 Desktop 复现与验收记录](../../pr-assets/issue-274-profile-generation/README.zh-CN.md)。

## 验证与证据

### 受支持的宿主

根测试在锁定的 0.2.1-rc.2 上运行，CI 还会在从 npm 安装的 DSH 0.2.0-rc.2 上运行（`pnpm run test:installed-dsh`，见[开发指南](../development/README.md#环境与命令)）；真实宿主测试组合的是它所运行的那个 DSH。在两个版本上，启用与不启用可选策略的 Headless、Starter 的激活契约以及 Git 同步检查都通过；只有 `--check-declared-rows` 在 0.2.0-rc.2 上因分组行列表失败。[DSH 0.2.1-rc.2 记录](../../pr-assets/dsh-021-rc2/README.zh-CN.md)包含 0.2.1-rc.2 上的检查，[DSH 0.2.1-rc.1 记录](../../pr-assets/dsh-021-rc1/README.zh-CN.md)包含 0.2.1-rc.1 与 0.2.0-rc.2 上的 WebUI 检查。更早的记录：[0.2.0-rc.2 发布验收](../../pr-assets/release-v0.5.22/README.zh-CN.md)、[activation（#356）](../../pr-assets/issue-356-subagent-activation/README.zh-CN.md)、[0.2.1-alpha.2](../../pr-assets/dsh-021-alpha2/README.zh-CN.md)与 [0.2.1-alpha.3](../../pr-assets/dsh-021-alpha3/README.zh-CN.md)。

另见[升级证据](../../pr-assets/main-rebase-20260904/README.md)与[当前开发检查](../development/README.md)。机制测试通过不是 LLM 质量评测通过；特定 OS 与真实 CLI 检查在没有对应环境时可能跳过。

### 产品素材

[v0.5.32 浅色图集](../../assets/webui-v0.5.32/README.md)在 DSH 0.2.1-rc.2 上截取，覆盖双语桌面页面、DSH 的插件页与可组合记忆的页面，以及 390 × 844 下的对话、记忆空间与记忆组合面板；该宽度下较长的名称会截断，英文界面中当前的记忆系统标签可能位于屏幕之外。它没有复测所有 Host 设置页、DSH 0.2.0 或真实手机，因此不宣称完整支持手机；历史 v0.5.2 在 390px 下的布局问题保留[原版本证据](../../pr-assets/documentation-refresh/README.md)。

<a id="其他记录"></a>

### 旧版宿主

[DSH 0.1.5 验证](../../pr-assets/issue-223-dsh-015/README.zh-CN.md)、[RC/alpha 验证与前后对比截图](../../pr-assets/issue-261-dsh-slots/README.zh-CN.md)、[宿主兼容证据](../../pr-assets/dsh-rc1-compat/README.md)与 [DSH 0.2.0-rc.1 安装图集](../../assets/install-v0.5.19/README.md)记录了这些宿主。已在独立环境验证的 bundle 组件列表[上游候选补丁](../../pr-assets/sidebar-native-20260926/upstream-fix.patch)会过滤容器展示并保留实际子插件；它从未包含在正式发布的 DSH 0.1.7 中。
