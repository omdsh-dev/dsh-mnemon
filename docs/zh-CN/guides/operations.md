# 运维、安全与故障排查

**简体中文** | [English](../../en/guides/operations.md) | [文档中心](../README.md)

## 健康检查

打开记忆系统的“状态”页。使用 Mnemon Native 时再检查它的二进制，其他 Provider 不需要：

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

![状态页：每个记忆组件、Provider 与存储区域](../../assets/webui-v0.5.32/zh-CN/memory-status.jpg)

状态页显示 dsh-mnemon 与 Mnemon 的版本、每个记忆组件一张卡片、各个 Provider，以及当前实际目录。`mnemon status` 会打开有效 Store，上游 CLI 可能初始化数据或执行迁移，因此不是完全无副作用的只读探测。

如果 OpenViking 提示 `/api/v1/admin/*` access restrictions，在**插件 → 可组合记忆**的记忆空间页面填写 **User Key 所属用户（跳过 Admin）**（`discoveryUser`）、账号标识、服务地址与 user API key。这会用数据 API 验证所选记忆根；根目录被拒绝或不存在时保留原配置。此校验不证明写入权限，也不改变 key 绑定的身份。留空仍使用 admin 发现。参见 [Provider 边界与降级步骤](./memory-providers.md#运维边界)。

## 版本检查与更新

状态页的“检查版本”打开“检查与更新版本”面板：

- **dsh-mnemon**：当前版本是所属 Profile 记录的版本（状态页显示正在运行的版本），更新查询 npm `latest`；已安装的 beta/alpha/rc 同时查询自身通道，也可升级到更高的正式版。稳定版用户不会自动进入预发布通道。
- **Mnemon CLI**：本地版本来自 `mnemon --version`，最新版本来自官方 `@mnemon-dev/mnemon` npm 包。只有 Mnemon Native 需要它，未安装时显示为可选并给出安装命令。

检查只读，不会自动安装。只有发现更高版本并安全识别安装来源时才显示“更新”：Mnemon 支持官方 npm 启动器、Homebrew Cask / Formula 与 `go install`；dsh-mnemon 支持当前 DSH Profile 中的 npm 安装。`link:` / `file:` 开发版本与无法识别的手工安装只显示说明，避免覆盖源码。

dsh-mnemon 通过 DSH 自己的插件安装器更新，效果与 `dsh plugin add dsh-mnemon@<版本>` 相同；Profile 单独安装的可选 Strategy 也是如此。安装器使用 Profile 自己的包管理器，桌面版中即应用自带的 pnpm，因此 PATH 上不需要 pnpm；同时沿用 Profile 的安装源设置与备用源，并等待 Profile 的锁。保留新版本之前，DSH 会检查它声明支持的 DSH 版本。安装失败时，DSH 恢复 Profile 的 `package.json` 与锁文件，面板显示 pnpm 的错误行和 DSH 的日志路径，已启用的插件保持不变；安装已下载的文件可能留下，“检查版本”仍显示 Profile 记录的版本。通过 DSH 的安装器，Host 只更新自己所运行的 Profile。DSH 未提供插件安装器时，Host 在所属 Profile 中运行 PATH 上的 pnpm。既没有应用自带的 pnpm、PATH 上也没有 pnpm 时，面板会提示安装 pnpm 并重启 DSH。dsh-mnemon 0.5.21 及更早的版本只有 pnpm 这一种方式：在桌面版中从这些版本更新时，需要在插件页**卸载** dsh-mnemon，再通过**添加插件**以 `dsh-mnemon@<版本>` 重新安装一次，记忆数据与设置都会保留。在 DSH 0.2.1 上，安装器不再覆盖安装 Profile 中已有的插件，0.5.30 及更早的版本会停在 `already-installed`；在桌面版中从这些版本更新，也用同样的方法。

npm 更新要求当前启动器属于现有 npm 所报告的全局安装目录；不同 Node/npm 环境或启动器故障会显示修复指引。首次安装或迁移使用 `npm install --global @mnemon-dev/mnemon@latest`，后续使用 `mnemon update`。命令在 DSH 宿主运行，需要 Node.js 22+。修改 PATH 或 CLI 配置后，重新检查并核对面板中的可执行文件路径。

在 Windows 桌面宿主中，记忆操作和版本检查会直接调用已识别的官方 Mnemon npm 安装所锁定的原生程序，避免 npm 启动器额外弹出控制台窗口，并保留隐藏子进程、超时、取消和已保存的嵌入设置。界面显示的安装路径和 npm 更新归属仍指向原启动器。对于未知包布局或缺失的原生依赖，继续使用启动器回退路径及其修复诊断。

展开 dsh-mnemon 子包列表，可按 Source、Strategy、Provider 查看版本。主包固定的依赖随主包更新，仅当前所属 Profile 中独立安装的包支持单独更新；源码链接保持原维护方式。包更新串行执行，重新检查或重开面板仍保留待重启提示。只读连接可检查版本与复制命令；页面更新需要管理权限且开启 `writeEnabled`。

Go 更新还要求当前执行文件确实位于本机 Go 的安装输出位置（`GOBIN`，或 `GOPATH` 第一项的 `bin` 目录），且未配置交叉编译目标。不能仅因下载的二进制包含 Go 构建信息就认定它由 Go 管理。CLI 更新后还会核验当前执行文件已达到所检查的版本，才报告成功。

更新命令由 Host 固定选择：浏览器不能传入命令或参数，执行禁用 shell，并限制时间与输出。插件更新在所属 profile 中安装已检查的精确版本，确认实际安装版本后才报告成功，避免固定 beta 版本未变却提示已更新。更新完成后界面自动重新检查两个组件并刷新状态。Mnemon CLI 从下一次调用起生效；dsh-mnemon 在 DSH 重启后才加载新插件代码：停止并重新运行 `dsh web`，或完全退出桌面版（macOS 上按 `Cmd+Q`）后重新打开。在此之前 Host 仍运行之前的版本，而 DSH 会在文件变化后立即载入新的记忆系统页面；该页面会重新打开**检查版本**，显示这次更新以及需要的重启。DSH 重启之前，记忆系统每个页面的顶部都会提示已安装的版本和仍在运行的版本，无论更新来自检查版本还是 `dsh plugin`；单独更新的子包也会列出。状态页显示的是正在运行的版本，**检查版本**显示已安装的版本，不会再次提供这次更新。

## 备份与恢复

<a id="推荐设置页-zip"></a>

### 推荐：插件页 ZIP

**插件 → 可组合记忆**页面“存储”组中的“备份与迁移”针对**当前有效根**工作：

- **导出 ZIP**：包含 Runtime、Documents 和全部 Mnemon Native Memory Spaces；三方连接、本地外部 Store 与远程数据不进入包；
- 包中只有 dsh-mnemon 随附的记忆来源：运行时记忆、项目档案与记忆空间。从其他插件包安装的记忆来源既不会导出也不会导入，它的数据由它自己保存；
- **导入 ZIP**：先预检，再合并到当前有效根；
- 包内包含 `manifest.json`、SHA-256 清单和三类数据摘要；
- 导出与导入持有组件锁，Memory Space 仍有未 checkpoint 的 WAL 时会拒绝；
- 导入检查路径、数量、压缩 / 展开大小、JSON schema、Document 哈希、registry 与 SQLite 头；
- 合并先写 staging，再替换目标组件；提交失败会恢复导入前目录。

当前 UI 只提供安全合并，不做“覆盖一切”：

- Runtime 按目标与内容去重；
- 相同 Document ID + 相同内容跳过，ID 冲突且内容不同则生成新 ID；
- 记忆空间按其中的记忆与关联比较，召回时改写的计数和之后补齐的向量不参与比较。一条关联由它连接的两条记忆及其类型确定：合并空间或重新关联会改写它的权重、备注和时间，值不同的同一条关联仍是同一条关联，保留本机的值。因此在一台设备上改过的权重或备注只留在那台设备上，分支保存的是最后一次同步的设备的值。记忆的更新时间也不参与比较：嵌入服务恢复响应后用嵌入设置里的**补齐**或 `mnemon embed` 补齐向量，或用 `mnemon gc --keep` 让记忆免于清理，都会改写这个时间，记忆本身并没有变。相同 ID 的空间会并入只有传入版本才有的记忆，因此两台设备都新增了记忆时，结果仍是一个同时包含两边记忆的空间；本机已有的行、召回计数、读取日志和表结构保持不变。同一条记忆在两边不同（一边编辑或遗忘了它）时，传入版本以新 ID 保留在本机版本旁边，只保留一份，它之后的版本会更新这份副本，而不是再添加一份。新 ID 的空间：本机已有同名空间包含其全部记忆时跳过。比较时用 `node:sqlite` 读取数据库（Node 22.13、23.4 及以上）；更早的 Node、无法读取的数据库、含虚拟表的数据库或超过 50 万行的数据库比较字节。

导入受 `writeEnabled` 控制，只读部署会拒绝。ZIP 包含私有记忆，应加密、限制访问并验证恢复。Provider 凭据保存在 `state/memory-providers.json`（`0600`），不会进入 ZIP。已保存的凭据值也不会经管理通道返回；若要备份连接，需要按下述离线快照保护整个 `state/`。

![安全导入前经过校验的备份预览](../../assets/webui-v0.5.32/zh-CN/plugin-backup-preview.jpg)

### Git 仓库同步

**存储 → Git 同步**把与 ZIP 备份完全相同的载荷发布到 Git 仓库，供另一台机器拉取。该开关默认关闭；关闭时这一行只显示标题与开关，不读取状态，也不执行 Git 命令。打开后这一行展开为一张卡片，按设置的先后顺序排列：**仓库**、**同步**、**自动同步**、**备份历史**与**高级设置**。远端存放可读文件；存储根永远不会被变成 Git 工作树。

与 ZIP 一样，Git 同步只携带运行时记忆、项目档案与 Mnemon Native 记忆空间。从其他插件包安装的记忆来源不会被同步，它的数据由它自己保存。

远端位于所配置的分支与目录下（默认分支 `mnemon-sync`、目录 `mnemon/`）：

```text
<branch>:<subdir>/
+-- manifest.json       # Mnemon Pack manifest 加同步扩展字段
+-- checksums.json      # 与 ZIP 相同的逐文件 SHA-256 清单
+-- payload/
    +-- runtime/{memories.json,USER.md,MEMORY.md}
    +-- documents/{index.json,active/<id>.md,archived/<id>.md}
    +-- data/{.dsh-memory-bodies.json,<bodyId>/mnemon.db}
```

**连接仓库。** **仓库**提供两种方式：

- **GitHub 账号**走 GitHub 的 OAuth 设备码流程。**复制并打开 GitHub** 一次点击即复制一次性设备码并打开 `https://github.com/login/device`，页面随后按 GitHub 要求的间隔询问浏览器步骤是否完成。登录后，同一处列出该账号的仓库并提供搜索框：私有与公开仓库分别标注，没有推送权限的无法选择；输入的名称没有匹配的仓库时，可以当场新建为私有仓库。选择公开仓库前会先确认，因为之后任何人都能看到同步的记忆。以这种方式选择的仓库用登录凭据认证，因此之前保存的访问令牌会被移除；如果设置了环境变量 `MNEMON_SYNC_GIT_TOKEN`，它仍然优先。
- **仓库地址**接受 `https://` 或 `ssh://` 地址、`git@主机:路径`，或 Host 上的绝对路径，并在发送前检查：其他形式，或把密码、令牌写进地址的（无论是否经过转义），都会在表单里直接提示。HTTPS 地址可以写明主机要求令牌搭配的用户名，例如 `https://x-token-auth@bitbucket.org/<workspace>/<repository>.git`；何时需要，见下文**凭据**。**访问令牌**一栏只在 HTTPS 地址时出现，因为只有它需要令牌。

连接后，这一行显示仓库、它是否有响应，以及认证方式：GitHub 登录、访问令牌、环境变量 `MNEMON_SYNC_GIT_TOKEN` 或 SSH 密钥。读不到仓库时，这一行说明原因：没有凭据、凭据被主机拒绝、找不到的地址（GitHub 对未提供凭据的私有仓库同样回答“找不到”）、到不了主机的网络，或 20 秒内没有响应。因凭据被拒绝、或被报告为找不到（凭据无权访问时 GitHub 也这样回答）的 HTTPS 仓库会提供**设置凭据**；没有任何凭据也能读到的 HTTPS 仓库会先标注推送需要凭据，而不是等第一次推送失败：`github.com` 上提示用 GitHub 登录或令牌，其他主机提示填写令牌。**更改**重新打开上述两种方式。**断开**会先确认，然后忘掉这个仓库、它保存的令牌与自动同步间隔，本机与仓库里的内容都不会删除。

**同步。**

- **立即同步**是唯一的主操作。它先把分支合并到本机，再把完整包导出到 `<storageRoot>/state/sync/git`，在其中提交并推送分支。这一行随后说明结果（合并进了多少条远端记忆、推送了哪个提交，或仓库已是最新，或推送为什么没有完成）以及上次同步的时间。这个时间保存在 `state/sync/last-run.json`，重启后仍在。
- **检查远端**只读取一次同步会带来的变化，不写入任何内容：每个组件两边是否有差异；对运行时记忆，还给出远端独有、本机独有与两边写法不同的条数。其中的**只合并到本机**只合并分支、不发布任何内容；**立即同步**与这一行的按钮做同样的事。
- **自动同步**提供间隔（关闭、每小时、每 3/6/12 小时、每天、每 3/7 天），选择即保存。开着时 Host 在后台重复同样的同步，每次都从 `state/sync-git.json` 读取间隔，因此改完立即生效、不需要重启。这一行说明下一次何时运行，或上一次为什么失败。定时器除了同步自带的那次合并，不写入任何记忆。
- 两个方向都要求 `writeEnabled`；只读部署会以与“导入 ZIP”相同的提示拒绝。

**同步通道的保证。**

- **一个镜像只对应一个仓库。** 镜像记录它从哪个仓库取得内容，换成另一个仓库时会重建；远端没有的分支从新的历史开始。因此换到一个空仓库，或在远端分支被删除后再同步，都不会把之前的载荷重新发布到那里。
- **设备之间不会互相覆盖。** 每次推送前都先合并分支；如果推送因其他设备刚好发布而被 Git 拒绝，会再合并一次并重试一次。只有第二次仍被拒绝才会报告，再同步一次即可。
- **每处分歧只保留一份副本。** 两边内容不同的项目档案会以新 id 保留在本机版本旁边；再次合并同一版本（例如重试的同步）不会再多出一份。记忆空间则直接合并：两边新增的记忆都进入同一个空间，召回写入的计数不会产生副本。只有某条记忆在一边被编辑或遗忘时，才会把另一边的版本保留为一份副本，之后那一边的新版本会继续更新这份副本。
- **不会卡在锁上。** 同步锁会记录持有者，因此中途停止的 Host 不会让之后的同步一直被拒绝：持有进程已不存在的锁立即接管，旧版本留下的无记录锁 15 分钟后接管，任何锁超过一小时都会接管。它遗留的单次命令凭据文件也会被清除。
- **同步的是修改，不是副本。** 对项目档案来说，只有两边在上次一致之后都改动过，才算两边不同。
  - 每次合并和每次发布之后，设备会记下此时它与分支一致的每份项目档案的版本，以及达成一致时的提交（`state/sync/base.json`）。版本包括正文、标题、描述、归档状态和关联，但不包括上次读取的时间。
  - 此后只有分支改动过的档案，会替换本机的旧版本；只有本机改动过的档案，会按本机的版本发布。因此两次同步之间编辑、重命名或归档档案，都不会产生副本。
  - 两边都改动过的档案，本机的版本保留原 id，修订号高于两边，分支的版本作为副本保留在旁边，即使只有标题或归档状态不同也是如此。分支上修订号比本机低的版本也会保留为副本，较旧的 dsh-mnemon 可能发布这样的版本。
  - 只有分支仍从达成一致时的提交延续下来，这份记录才会被使用。没有这份记录的设备（例如从不保存它的 dsh-mnemon 0.5.28 升级上来的设备），会改用它上次同步那个提交里的档案（`state/sync/last-run.json`），也就是本机发布或合并之后分支上的版本，前提是分支仍从那个提交延续下来。仓库、分支或目录一改变，这条记录就会被丢弃；修订号高于本机的分支版本也不会按它处理。
  - 两者都没有时，正文不同的档案都会像以前一样各保留一份副本。从 0.5.28 之前的版本升级后的第一次同步、换到另一个仓库、分支或目录后的第一次同步，以及分支被删除后重新发布时，都属于这种情况。
- **Git 2.20 或更高版本即可**：初始化镜像时不再使用更晚版本才引入的选项。
- **合并前先校验。** 合并先读取远端 manifest 与 SHA-256 清单；manifest 或校验和不匹配属于硬失败，不会导入任何内容。推送前也会按导入时的同一套规则校验即将发布的载荷：项目档案索引中的摘要或大小与档案本身不符时，推送会停止并说明是哪份档案，分支上不会写入任何内容。ZIP 导出仍能下载这样的数据，以便修复前先做备份。
- **备份体积。** Git 为每次推送写入全新的 blob，而载荷是整包，因此每次推送成功后会把镜像的零散对象收进一个 pack（`git repack -adf`）。收拢失败只在推送结果中以警告回报，不会让已经成功的推送失败。
- 载荷就是既有的 Mnemon Pack 载荷：同一个收集器、同一个校验器、同一个导入器。包内包含 `manifest.json`、SHA-256 清单与组件摘要，同步扩展字段记录通道、分支、目录与推送时间；不认识同步的读取方仍能读到合法的 Mnemon Pack manifest。
- 载荷只承载记忆内容：runtime、documents 与 memory-spaces，用户画像包含在 runtime 中。配置属于 profile 层，不会随载荷传递，因此第二台机器保留自己的设置，不会继承本机的设置。同步总是携带完整的包，原因见[同步通道](../reference/interfaces.md#同步通道)。
- `state/sync/git` 下的镜像是可丢弃的，且不属于任何数据组件，因此镜像不会同步自己；删除它只多一次 fetch。每次同步（包括检查远端与备份历史）都会把镜像中的同步目录恢复为分支的内容，所以 Git 不跟踪的文件（例如在原地打开数据库时 SQLite 留下的 `-wal` 与 `-shm`）会被删除，而不会被当作载荷读取；不要在那里存放自己的文件。无论这台设备有什么忽略规则（例如全局的 `*.db`），载荷中的每个文件都会被发布。较早版本因此漏掉文件后发布的分支，在每台设备上都通不过校验：在远端删除该分支，或在**高级设置**中换一个目录，再同步一次即可。

**高级设置**包含这台电脑的名称、分支、仓库内目录与提交者，每项都显示当前使用的值；保存新的分支或目录时会说明下次同步会写到那里。**这台电脑的名称**会显示在备份历史与**检查远端**的“来自 …”里，并随每次同步一起发布：**主机名**使用这台电脑当前的主机名，主机名改变时跟着改变；**自定义**填写不超过 120 个字符、只占一行的名称。新名称从下一次同步起使用，那次同步会为它留下一个版本；之前的版本保留发布时的名称。提交者是明确的选择：**默认**以 `dsh-mnemon sync <mnemon@localhost>` 提交；**本机 Git** 使用这台机器 Git 配置的 `user.name` 与 `user.email`，没有配置时使用默认身份，而不是让提交失败，或发布 Git 根据账号与主机名猜出的身份；**自定义**填写姓名与邮箱。

**凭据。** 凭据不进入载荷、DSH profile 配置、浏览器、响应、错误信息与日志；它们按什么顺序解析、由哪些字段描述，见[同步通道](../reference/interfaces.md#同步通道)。

- GitHub 登录保存在 DSH 的凭据存储中，只用于 `https://github.com` 上的仓库。申请的 scope 是 `repo`，因此可以访问私有仓库；其他主机上的仓库需要自己的令牌。GitHub 不再认可的凭据会被如实提示，并提供**重新登录**。退出登录会删除已保存的凭据。未挂载凭据 provider 的 Host 只提供地址表单。
- 保存的令牌放在 `state/sync-git.json`（权限 `0600`）中，只属于保存它时的主机：把仓库换到另一个主机时，除非同时提供新令牌，旧令牌会被丢弃。设置了环境变量 `MNEMON_SYNC_GIT_TOKEN` 时，它优先于这两者。
- 令牌以一个用户名交给 Git：地址中写明的用户名；没有写明时，`gitee.com` 用 `oauth2`，因为它拒绝 `x-access-token`（Gitee 要求 `oauth2` 或账户名），其他主机都与以前一样用 `x-access-token`。GitHub 为 github.com、GitHub Enterprise Server 与 `*.ghe.com` 上的令牌说明的都是 `x-access-token`，GitLab、Gitea 与 Azure DevOps 也接受它。要求其他用户名的主机，在地址中写明即可：自建的 Gitee 接受 `oauth2` 或你的账户名，例如 `https://oauth2@gitee.example.com/<owner>/<repository>.git`；Bitbucket Cloud 的 access token 与 API token 都以 `x-token-auth` 为用户名。不论这台电脑为该主机配置了什么，例如 Git Credential Manager 设置的 `credential.<url>.username` 与 `credential.useHttpPath`，Git 都按这个用户名查找令牌；主机名写成大写或带端口的地址也能找到令牌。更早的 dsh-mnemon 会拒绝读取写明了用户名的已保存地址，连更改或断开也做不到，因此回退到旧版本前请先去掉地址中的用户名。
- 主机拒绝了交给它的凭据时，页面会如实说明，并指出被拒绝的是哪一个：GitHub 登录的凭据，重新登录即可更新；保存的令牌，在**访问令牌**中填写新令牌即可替换；或 `MNEMON_SYNC_GIT_TOKEN`，它优先于前两者，只能在环境中更改。github.com 以外的主机，保存的令牌被拒绝时，这一行还会提示地址中的用户名。只有在没有任何凭据时，页面才提示登录或填写令牌。
- 启动器没有下发代理策略时也能登录：Host 会通过自己发现的代理重试一次，一个都找不到时会提示设置 `HTTPS_PROXY`。回退方式见[同步通道](../reference/interfaces.md#同步通道)。
- 读不到远端时，同步会在提交任何内容之前失败；提交之后才被远端拒绝的推送（例如没有写权限）会把提交留在镜像中并说明原因。两种情况都不会丢失数据，远端恢复后再同步一次即可。

### 查看每台设备的备份与差异

**备份历史**由新到旧列出分支上的各个版本，每条按该提交携带的 manifest 说明：同步时间、来自哪台设备、各组件包含多少内容，以及人工写下的提交说明（如果有）。远端是共享分支，因此这就是各台设备的备份清单。分支为空时显示空历史；某次提交的 manifest 读不出来时跳过它，其余照常显示。历史一次读 20 条，**读取更早的版本**会继续追加下一页，最多列出最近 100 个版本。

**检查远端**按条目比较，而不是按字节：条目身份是「目标层 + 内容」，因此两条一样的记忆无论在哪台机器写入都算同一条。运行时记忆分为以下几类：

- **两边写法不同**：目标层相同、文字高度相似的两条，例如「Prefer concise answers in every reply」与「Prefer concise answers for all replies」。相似度按字符二元组重合度计算，不低于 `0.6` 才算同一主题，因此互不相干的记忆不会因为同属一层就被判成冲突。同步会保留两种写法；**查看**并排列出这些条目，**去记忆整理**通往合并它们的唯一入口。
- **远端独有**：远端有、本机没有的条目。合并会新增它们，并尊重分支记录过的删除。本机以前删掉、而分支仍持有的条目会单独计数：合并时不会加回，**恢复这些记忆**由你一次性推翻自己的删除，被推翻的墓碑随后从本机状态里移除，弹窗随后说明实际写入了几条。
- **本机独有**：本机有、远端没有的条目，同步后即可共享。
- **本机尚未执行的删除**：分支记录过、而本机还没照做的删除，同步时会执行。分支会保留双方记录过的每一条删除，因此本机已经执行过、或此后又写回同内容的删除不会重复计入。

冲突两侧计为冲突本身，不计入按侧统计的条数。两份列表都受上限保护，差异多于统计时弹窗会说明。

检查远端与查看备份历史都是只读：不会导入任何内容，也不会改动本机记忆。会写入的只有**立即同步**、**只合并到本机**、**恢复这些记忆**与**执行**；合并响应里的 `runtime` 回报本次写入了几条、又有几条因为本机记录过删除而留在原处。

### 记忆整理

整理复用既有的审查账本，唯一的入口是**存储**中**记忆整理**那一行的**整理记忆**：

- 它把差异（包括冲突两侧的写法）作为证据交给 agent，同时交给它同步分支持有而本机没有的条目，以及待审查建议上已经记录的意见（按时间从早到晚），因此可以直接对着建议补充要求再整理一次。
- **整理要求**说明这次整理要达成什么，例如“保留短句风格，别合并同义项”。它只描述目标，不会放宽权限：一条操作能包含什么仍由 Host 决定。整理完成后页面会说明是否参考了你的要求，以及参考了远端多少条本机没有的记忆。
- 方案以待审查建议的形式出现，不会自动写入。它列出每条操作与理由，可以**接受**后**执行**，也可以拒绝，或先留下意见。
- 已拒绝的方案要先**重新打开**才能再整理：账本里已决定的建议由其决定回答，只有重新打开后，你的意见才会进入下一次 run 读到的证据，所以顺序是「写下意见 → 重新打开 → 再整理」。
- 接受后的方案可以只执行一部分：每条操作前有复选框，只列出还没执行过的位置，**全选**/**全不选**切换整组，按钮会显示本次执行几条；一条都没选时直接提示，而不是什么也不做。账本逐条记录执行过的位置（`appliedOperations`），并显示为「已执行 {count}/{total} 条」，因此只执行了一部分的方案仍留在列表里，直到它的每条操作都执行过为止。
- 全部执行完的方案离开列表，收进**已执行的历史方案**弹窗，只供回看；重新打开它不会撤销已经写入的改动，而是把整份方案恢复成待审查、可以重新决定。
- 只读 Host 依然可以读取和批注账本；需要可写部署的是“执行”。

### 恢复演练

1. 在“存储”中将“数据目录”设为“自定义”，填写一个隔离目录并应用。
2. 确认状态页显示的当前实际读写根正是该目录。
3. 在“备份与迁移”中选择备份，阅读预检摘要后执行导入。
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
<storageRoot>/state    # 若存在；不在内置 ZIP 的四类数据组件中
```

复制完成后生成文件清单或校验和，并在隔离路径演练恢复。不要在多个进程仍写入时把普通目录复制当作一致快照。

## 切换存储范围

保存 `global` / `workspace` / `custom` / `workspaces` 后，Host 先初始化新运行图，再原子切换；页面自动重新读取，但**不会迁移数据**：

```text
旧范围 -- 保存设置 --> 新的空目录或既有目录

不自动复制
不自动合并
不自动删除
```

推荐迁移流程：在旧范围导出 ZIP → 切换到新范围并确认显示目录 → 导入 ZIP → 验证。工作区模式下先确认查看工作区与会话执行工作区是否是预期目标。

使用 `workspaces` 时，备份整个集中目录可覆盖所有工作区，导出 Pack 则只覆盖所选工作区。移动或重命名工作区会产生新路径哈希；恢复旧数据需要操作者显式执行。

现有回合和已委托的子 Agent activation 可能仍使用旧运行图。迁移或停用其数据前，应等待它们结束或取消这些任务。父回合结束本身不会释放异步子任务的委托；新创建或冷恢复的 activation 会捕获自己获准使用的 generation。

## 停用完整 Starter

既有的 `mnemon` Entry 继续作为整个 Starter 的生命周期总开关。需要停用 Mnemon 时，在 profile patch 中加入以下配置并重启 DSH；不需要逐项停用 Source 或 Strategy：

```yaml
- id: mnemon
  disabled: true
```

该开关会同时停用 Core/Host、三个随附 Source、两个主策略和三个可选 Strategy 增强，不会卸载包或删除记忆数据。删除该覆盖项，或把它改为 `false`，再重启 DSH，即可重新启用完整 Starter。

<a id="cloud-hosted-webui"></a>

## 云端 WebUI

[兼容性矩阵](../reference/compatibility.md)列出的 DSH 版本是支持的 registry 安装目标。页面、每个 RPC 与每条 stream 都通过 Host 输出的启动 token URL 建立同一份、与 authority 绑定的浏览器会话。`--trusted-host` 仍只是 Host/Origin 防线，不能替代 HTTPS 或部署层访问控制。

1. 在反向代理或访问网关终止 HTTPS，并只向预期用户开放公网入口。把同源的 `/` 与 `/api` 流量（包括 stream）代理到 `http://127.0.0.1:3080`，同时保留外部 `Host` authority。
2. 使用外部 authority 启动回环服务。参数应为裸 `host[:port]`，不是 URL：

   ```sh
   dsh web --trusted-host memory.example.com --no-open
   ```

   公网入口使用非默认端口时，应传入准确 authority，例如 `memory.example.com:8443`。DSH 会刻意拒绝 `--host 0.0.0.0`；请让服务保持在回环地址，只由代理或 SSH tunnel 访问。
3. 如果浏览器还没有该公网 authority 的有效 Cookie，请使用终端里以 `dsh web: ...` 输出的启动 token URL。经过反向代理时，只把其中的回环 origin 替换成公网 HTTPS origin，保留 `/` 路径与 `?token=...` query。例如把 `http://127.0.0.1:3080/?token=...` 转为 `https://memory.example.com/?token=...`。该 URL 等同凭据，不要放入日志、Issue 或聊天。DSH 会把它交换为 HttpOnly、SameSite Cookie，再重定向到干净的 `/`；尚未过期且 authority 相同的 Cookie 可以跨 Host 重启继续使用。
4. 打开干净的公网 URL，确认“状态”和**插件 → 可组合记忆**页面都能加载，并且整页刷新后仍保持认证。远程设置默认只读；需要管理时，先应用[显式远程管理授权](#remote-management)、重启 DSH，再验证一次有意的小范围保存。

HTTP 403 可能来自 Host/Origin 不匹配，或旧远程 Client 仍调用独立通道。请检查 `--trusted-host`、公网 authority 与代理路由，再升级 dsh-mnemon、重启 DSH 并刷新浏览器；远程 Mnemon 调用使用已认证 API Gateway。HTTP 401 需要恢复 Host 浏览器认证或配对。若返回远程管理需要 `remoteAccess: trusted-host`，则是另一个 Mnemon 授权检查；浏览器认证成功本身不授予管理权限。

<a id="remote-management"></a>

### 远程管理

对于已认证的远程客户端，`remoteAccess: trusted-host` 授予管理操作；远程读取与小范围激活不需要该授权。没有该授权时，远程页面的记忆系统与插件设置会写明只读的原因。本机浏览器与 DSH 桌面版窗口不是远程客户端，不需要该授权。仅为预期的已认证用户配置远程管理权限。需要运行更早的 DSH 时，请配套使用针对它验证过的 Mnemon 版本及其升级前的会话备份，参见[兼容性矩阵](../reference/compatibility.md)。

1. 打开 `~/.dsh/profiles/web/cordis.patch.yml`；如果设置了 `DSH_HOME`，则路径为 `$DSH_HOME/profiles/web/cordis.patch.yml`。如果已经有顶层 `- id: mnemon`，请直接修改该项，不要添加重复项。如果初始化文件仍以 `[]` 结尾，请用下面的完整配置行替换它；否则把该行追加到现有顶层 YAML 列表：

   ```yaml
   - id: mnemon
     config:
       routingGuidance: true
       lifecycleEnabled: true
       recallMode: guided
       writebackMode: guided
       idleReviewMs: 30000
       tabEnabled: true
       writeEnabled: true
       remoteAccess: trusted-host
       timeoutMs: 10000
       defaultRecallLimit: 10
       embedding:
         enabled: false
         endpoint: http://localhost:11434
         model: nomic-embed-text
       recallQuality:
         policy: strict-v1
         lowScoreThreshold: 0.25
         highScoreThreshold: 0.6
         candidateMultiplier: 3
         maxMediumResults: 4
         maxUnknownResults: 2
         maxRankedResults: 2
   ```

   Profile patch 会替换目标行的完整 `config`，不会只深度合并一个字段。请保留已有自定义项；插件升级后用 `dsh web --dump-default-config` 对照它，避免遮蔽新增的包内默认值。
2. 运行 `dsh web --dump-config` 检查最终配置树。确认最后的 `mnemon` 行包含 `remoteAccess: trusted-host`，并且 stderr 没有报告无法匹配 `mnemon` 目标。
3. 使用同一条 `--trusted-host` 命令启动 DSH。每次修改 `remoteAccess` 后都要重启，因为 Mnemon 只在启动时捕获该策略。最后通过已认证远程连接验证“状态”、设置加载和一次有意的小范围保存。

## 安全边界

<a id="进程"></a>
<a id="文件"></a>
<a id="web-与模型"></a>

Host 调用 Mnemon CLI 时不经过 shell，限制每次调用的时间与输出，并通过锁与修订让写入串行。浏览器既拿不到凭据，也不能启动进程；每个任务 Agent 只拿到其任务需要的记忆工具。各项边界的细节见[架构设计](../development/architecture.md#安全边界)。

这些边界不是秘密扫描器。当前没有确定性的凭据检测；不要提交密钥、token、私钥和原始敏感日志。

从技能管理市场安装的技能是 Agent 会照着执行的指令，也可能带有脚本。dsh-mnemon 自身从不运行技能里的脚本：每次安装前都可预览，网站发布的压缩包必须与其公布的摘要一致，压缩包不得包含链接或技能文件夹之外的路径，大小与文件数也有上限。安装前请先审阅技能，见[技能管理指南](./skills.md#数据与信任)。

### 安全问题报告

按 [SECURITY.md](../../../SECURITY.md) 私下报告漏洞，不要创建公开 issue。数据丢失、路径穿越、锁 / revision 绕过、子 Agent 隔离破坏和 WebUI 记忆内容注入都在范围内。

## 故障排查

`mnemon.cliPath` 接受显式路径，也接受按 Host 的 PATH 查找的命令名。DSH 运行时，若二进制安装或恢复到既有搜索目录，点击记忆系统顶栏的**刷新**即可更新可用状态，无需重启；Host 进程环境变量的变化仍需重启。状态与版本检查解析同一个配置命令。

| 现象 | 检查与处理 |
|---|---|
| 插件详情中 `mnemon-bundle` 容器行（0.5.20 起名为 `dsh-mnemon/bundle`，此前为 `cordis:group`）显示“已关闭”，点击提示“找不到该插件” | DSH 0.2.0 的已知容器展示问题，与 0.1.7 相同；DSH 0.2.1 不再列出该行，配置页也随之不再显示相应说明。先检查“记忆系统 → 状态”和实际组件；正常时可继续使用。整套组合用顶层 bundle 或 `mnemon` 核心组件开关，不要重置数据或删除分组。参见[原因、处理步骤与修复边界](../reference/compatibility.md#dsh-020-上的-bundle-组件列表)和[上游 #649](https://github.com/dsh-external/issues/issues/649)。 |
| Windows 切换会话时终端窗口闪现 | 更新 Starter，或独立安装的 Runtime Source，然后重启 DSH Host。Runtime 的 Git 分支检测会隐藏控制台窗口；Git 失败、超时或 HEAD 分离时仍回退到不按分支筛选的 Runtime 视图。 |
| Mnemon 不可用 | macOS/Linux 运行 `command -v mnemon`、`mnemon --version`；Windows PowerShell 运行 `Get-Command mnemon`、`Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`。设置 `MNEMON_CLI_PATH` 或 `mnemon.cliPath` 后重启 |
| Electron 桌面 Host 无法运行 npm CLI 脚本 | 经过验证的 npm 启动器仅在子进程中设置 `ELECTRON_RUN_AS_NODE=1`。如果桌面壳关闭了 [Electron `runAsNode` fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode)，该变量会被忽略；请将 `mnemon.cliPath` 指向官方原生二进制（Windows 为 `mnemon.exe`）。npm 自动更新仍需要 Host 能够运行 JavaScript 启动器 |
| Headless Agent 没有 Mnemon 工具 | 插件按 profile 独立安装；运行 `dsh plugin --profile headless add dsh-mnemon`，Web profile 的安装不会自动带入 |
| 找不到“记忆系统”入口 | 检查 `tabEnabled=true`；`displayMode=sidebar` 使用侧边栏，`displayMode=builtin` 使用已打开会话的标签页。本地 link 先 `pnpm run build` 再重启 profile |
| 旧的 `buildin` 偏好打开了会话标签页 | 它会保存为 `builtin`；如需独立入口，请在**界面**中选择**侧边栏**。记忆范围与已存数据不变 |
| 状态正常但召回为空 | 检查 active 记忆空间、存储范围、查看目录、会话实际目录和查询是否足够聚焦 |
| 顶部提示目录未对齐 | 工作台正在查看另一个工作区；确认是否为预期范围。工作台任务在查看工作区执行，对话工具仍使用所属会话范围 |
| 设置看起来没有变化 | 开关与选择器立即生效，需要输入的值要点击**应用**；写入失败时控件旁会显示原因并恢复为已保存的值 |
| 自定义目录被拒绝 | 使用绝对路径、`~` 或 `~/...` |
| `memoryBodyId is required...` | active 数量不是恰好 1；显式选择目标 |
| `memory space is not active for reading` | 在概览激活目标；写入 inactive 可以，读取不行 |
| Provider 错误 | 审查需要受 guard 保护的本地子 Agent；默认有界 `spawn`，可选择 `fork`。安装了 Team 工具时如需继续审查，可选择 `idleReview.agentTeams: scoped`，默认仍为 `pause`；重试前核对部分写入回执 |
| 本地模型（例如 Ollama 上的 Qwen3.x）下空闲审查报 `no user query found in messages` | 工具结果填满模型的上下文窗口后，Ollama 截断时丢掉了子代理的任务提示。0.5.22 起，Mnemon 会给被拒的子代理步骤追加一条用户消息并重试（[#327](https://github.com/omdsh-dev/dsh-mnemon/issues/327)），请更新 dsh-mnemon。调大 Ollama 的上下文长度（`OLLAMA_CONTEXT_LENGTH` 或模型的 `num_ctx`）也能避免截断。审查可能在失败前已创建项目档案，请核对部分写入回执 |
| 侧栏“未分组”下出现空的“未命名”会话，每运行一次记忆任务就多一些 | dsh-mnemon 0.5.32 及更早版本没有给记忆任务（存入记忆、Agent 查询、档案归档、运行时记忆容量维护、记忆整理等）的任务 Agent 加上子代理来源标记，DSH 只要没有该会话的投影缓存记录，就把它当作对话列出（[#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)）。更新 dsh-mnemon 后，新的任务不再列出。已有的这些行会保留：dsh-mnemon 不会删除它们，记忆数据不受影响。想隐藏某一行，在该行上使用“归档会话”；DSH 会把它保留在已归档筛选中，“取消归档”即可恢复 |
| Runtime replace 超容量 | 缩短 replacement 或先显式整理；自动维护只处理 add 溢出 |
| Document source path 被拒绝 | 路径必须在会话工作区内，且不能引用受管 Documents 目录 |
| CLI timeout | 增大 `timeoutMs`；大 Store 的状态与图谱可能超过 10 秒 |
| lock timeout | 检查其他写进程，不要删除仍属于活跃进程的 lock |
| ZIP 导出提示 WAL busy | 等待 Memory Space 写入完成并重试；不要绕过未 checkpoint WAL 检查 |
| ZIP 导入 checksum / schema 失败 | 备份损坏或格式不兼容；保留当前根，不要手工解压覆盖 |
| 更新按钮不出现 | 当前已是最新、远程检查失败，或安装来源是 link / 手工模式；按面板提示沿原方式更新 |
| 已认证远程页面能读取或激活记忆空间，但不能保存设置或执行其他写入 | 默认管理限制；确需远程管理时，保留当前配置、在本地设置 `remoteAccess: trusted-host` 并重启 DSH |
| DSH 桌面版中运行时记忆、记忆空间与插件设置均为只读，而 Agent 工具仍能写入 | dsh-mnemon 0.5.18 及更早版本把桌面窗口当成远程页面（[#310](https://github.com/omdsh-dev/dsh-mnemon/issues/310)）；在桌面版插件页**卸载** dsh-mnemon，再通过**添加插件**重新安装，无需修改 `remoteAccess` |
| DSH 0.2 安装或启动时提示 dsh-mnemon 不兼容 | 安装到的是 0.5.19 之前的版本；更新 dsh-mnemon，新版本发布 24 小时内按[安装与启动](./installation.md#常见问题)安装带版本号的包 |
| Profile 中装有 dshmarket，DSH 启动时提示 `mkt-client-dsh-mnemon-source-memory-spaces` 未能激活（`Memory Spaces requires at least one explicit Provider child`），状态页的运行时记忆或项目档案出现两次，或每轮对话都因 `found ambiguous working-context Sources` 失败 | Profile 中另外单独安装了某个 Source 包，dshmarket 1.66 又把它作为仅客户端挂载加载了一次（[#359](https://github.com/omdsh-dev/dsh-mnemon/issues/359)）。将 dsh-mnemon 更新到 0.5.27 或更高版本。记忆空间由 Profile 独立维护时，还要把它更新到 0.5.18 或更高版本：宿主的 PATH 上有 pnpm 时可在**检查版本**中更新，否则运行 `dsh plugin --profile web add dsh-mnemon-source-memory-spaces@0.5.18`。然后重启 DSH。把单独安装的 Source 从 Profile 中移除也能消除这些问题，例如 `dsh plugin --profile web remove dsh-mnemon-source-memory-spaces`，因为 Starter 自带这些组件。记忆数据不受影响 |
| DSH 运行期间更新 dsh-mnemon 后，启用组件提示 `ERR_PACKAGE_PATH_NOT_EXPORTED`（`Package subpath './starter'` 或 `'./bundle'`） | 正在运行的进程仍按旧版本的包信息加载；完全退出并重新启动 DSH（桌面版按 `Cmd+Q`）。使用 0.5.18 或 0.5.19 时不要关闭 `dsh-mnemon/starter`，见[安装与启动](./installation.md#更新后启用时提示-err_package_path_not_exported) |
| `mnemon-bundle (cordis:group): pending (waiting for service: mnemonStarterReady)`，或桌面版启动失败并显示插件恢复页 | 0.5.18 或 0.5.19 的 `dsh-mnemon/starter` 被关闭；在**插件 → 可组合记忆**中打开它，或更新到 0.5.20（没有单独的就绪开关）。桌面版在恢复页卸载后重新添加 dsh-mnemon，见[安装与启动](./installation.md#dsh-提示waiting-for-service-mnemonstarterready) |
| 更新后提示 `mnemon-bundle (dsh-mnemon/bundle): pending (waiting for service: mnemonStarterReady)` | 更新到 0.5.20 后没有重启，正在运行的 DSH 仍保留旧的组件组；完全退出并重新启动 DSH，见[安装与启动](./installation.md#更新后启用时提示-err_package_path_not_exported) |
| 技能管理的**进化**一直是空的、回合下显示**复盘失败**，或市场提示 GitHub 拒绝列出仓库 | 自进化默认关闭；一次复盘需要几轮实际工作和一次停顿。GitHub 对未认证请求每小时限 60 次：在 DSH 的运行环境中设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 后重启。见[技能管理常见问题](./skills.md#常见问题) |
| DSH 重启或 authority 改变后 Mnemon RPC 返回 401 | 打开 `dsh web` 输出的启动 URL，让一次性 token 建立新的、与 authority 绑定的浏览器 Cookie |

<a id="dsh-015-兼容与旧会话恢复"></a>

## 旧会话恢复

错误 `source summary requires notice form; source v0 artifact remains unchanged` 来自旧版 Mnemon 写入的 DSH 会话消息。新消息已移除 recall/instructions 中不合法的 summary；更新插件不会改写现有会话。修复单个受影响日志时：

1. 停止所属 DSH 进程，单独备份完整会话存储根及全部 generation；Mnemon Pack 不包含这些会话。以 DSH 错误中的准确 `raw log` 路径为准，不扫描或改写其他会话。
2. 安装修复后的 Mnemon，对**备份副本**执行下面的预览命令。`.jsonl.zstd` 使用 Node `22.19+` 或 `24+`；普通 `.jsonl` 也支持 Node 20。
3. 将结果写入会话目录外的新路径，核对 `repairedMessages`、`repairedDescriptors`、`expandedToolChunkRows`、`expandedToolChunks`、SHA-256 报告和 `blockers`。预览计数表示候选修改；发现已知不支持的形状时退出码为 1，副本请求返回 `mode: "refused"` 且不生成输出。已有输出文件会被拒绝。
4. 先在一次性的 Profile 副本中，用修复副本替换对应 `session.jsonl` 或 `session.jsonl.zstd`，保留原始备份。让 DSH 加载、续写，重启后再验证会话。副本验证通过后，才在已停止的原 Profile 中执行同样的明确替换。命令本身绝不替换输入或正在使用的会话。

```sh
dsh-mnemon-repair-session --input /backup/session.jsonl.zstd
dsh-mnemon-repair-session --input /backup/session.jsonl.zstd --output /backup/repaired-session.jsonl.zstd
```

可执行命令随 `dsh-mnemon` 安装；Profile 内安装可在该目录使用 `pnpm exec dsh-mnemon-repair-session`。源码 checkout 使用 `node bin/repair-legacy-session.mjs`。下表两种 stream 规范化本身不改 ID；同一日志也可叠加经过证明的身份恢复。副本修复仅覆盖经过契约审计的历史形状：

| 历史形状 | 副本行为 |
|---|---|
| `dsh-mnemon` instructions summary 为 `Optional memory recall and remember reminder`；recall summary 为 `Memory View snapshot` 或 `Runtime memory snapshot` | 仅移除该 source 的 `summary` 成员，保留其他插件消息和陌生 summary。 |
| 严格符合旧版封闭字段集合且组合参数满足冻结 v3 契约的 subagent descriptor v2 | 仅将版本值改为 3，保留 provider、成对模型字段、persona、label 和 toolFilter；不添加默认值或 reasoning effort。多余字段、不成对模型和其他不支持的版本会被拒绝。 |
| 严格符合旧版结构、字符串 `id: ""` 或 `name: ""` 的 `tool-call-chunks` | 展开为原来的 raw delta 事件，保留 ID、name 是否存在、参数字符串、序号和时间戳。不丢弃 chunk，provenance 引用无需重编号。已经是 raw 的空字符串 delta 保持字节不变。 |
| 严格符合结构、自有成员为 `name: null` 的 raw 或 packed 工具 delta | 保留成员，将值改为 `""`；packed 行按原逻辑序号与时间展开。ID、参数和持久消息不变。两种值均不改变组装状态，保留成员可维持 token 计时。`normalizedToolChunkNames` 统计受影响的逻辑 delta 数。 |
| 完成的 `deepseek-official` stream 已记录唯一非空 provider ID，后续空 ID 覆盖了持久工具链身份 | 核对完整有序 chunk provenance、按 index 组装的 block、相同 name/参数和唯一 call/result 关联后，仅恢复该已记录 ID。保留首个候选之前的空占位值、消息 UUID、正文及其他插件内容；支持逐条证明的多工具，以及 text/reasoning block。不生成 ID。 |
| 没有已记录 ID、身份冲突、中断、待修 owner 对象结构未知，或 approval/dispatch/plugin/消息副本引用未闭合 | 报告 blocker 并拒绝输出。任意空 ID 历史及 owner replay state 仍需原写入方恢复。 |

ID 检查使用原 stream 完整的 `sourceEventSeqs`，包括 packed 逻辑成员。result provenance 必须精确指向对应 call；字段缺省时，仅允许没有其他 attempt 的唯一单调用 step。显式错误引用不能使用此回退。通过序号或消息 ID 关联的额外引用会跨 step 检查；普通 compaction 序号引用与无关插件仍可原样保留。`recoveredToolIdentityChains` 统计恢复的链，`recoveredToolIdentityFields` 统计逻辑身份字段，`toolIdentityRecoveryRefusals` 用有数量上限的位置样例解释无法证明的形状。

工具只接受 v0、合法 UTF-8 JSON 记录和完整的普通 Zstandard 帧；原始输入、解压输入和展开输出均限制为 128 MiB。格式损坏、不完整帧、修改或身份判断路径中的歧义重复键、无法安全表示的 delta 序号或时间会在发布输出前被拒绝。仅改写匹配的 summary/version/name/identity 成员和需要展开的 packed 行，其他解压字节均保留。诊断统计每类已知 blocker 的全部次数，并最多列出十个行号/事件/字段路径样例，不输出消息正文。`migrationValidated: false` 明确表示扫描器不会修复其他损坏，也不保证任意会话都能迁移；最终仍以安装的官方 DSH 加载器和 stream 回放为准。参见 [issue #251 契约审计与验证](../../pr-assets/issue-251-legacy-repair/README.zh-CN.md)。

DSH 以写权限打开旧会话时，会迁移为不可变的 v3 generation。Mnemon Runtime、档案与记忆空间维持原有格式。回滚 DSH 时，在独立旧版本 Profile 中恢复升级前会话备份；不要让旧 DSH 打开 v3 generation。参见[验证与截图](../../pr-assets/issue-223-dsh-015/README.zh-CN.md)。

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

支持的 DSH 版本见[兼容性矩阵](../reference/compatibility.md)。Web 界面为中英文双语，但命令、工具卡、兼容元数据和部分错误仍未完全国际化。

<a id="文档归档恢复"></a>
<a id="运行时归档恢复"></a>

## 归档失败时

归档失败或中断后会保留什么、重试前应检查什么，与各自的流程写在一起：见[项目档案归档恢复](../reference/workflows.md#项目档案归档恢复)与[运行时归档恢复](../reference/workflows.md#运行时归档恢复)。
