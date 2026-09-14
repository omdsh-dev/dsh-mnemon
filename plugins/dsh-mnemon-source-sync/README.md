# Memory synchronization / 记忆同步

This independent Source owns sync targets, immutable merge plans, local bare Git repositories and import/push receipts. It exposes no model actions. Its page explicitly coordinates separately authenticated Source clients through `dsh-mnemon/client`; the server never reads another Source's directory or imports its implementation.

Enable the Source in an explicit workspace composition. Create a project or global target, choose a Git remote, a stable identity and the Source tracks to share. Git origin supplies a project identity suggestion; SSH and HTTPS forms of the same origin normalize to the same identity. Non-Git workspaces use an explicit identity. Every device uses the same identity and portable track names while selecting its own installed Source instance. Global targets require an explicit remote. Each target can be disabled without removing memory or snapshots; changing destination retains the old local repository.

The independent branch is `memory/<scope>-<identity hash>`. No code checkout, index or branch is changed. Configure `dataDir` to override the Host storage directory. `allowLocalRemotes` defaults to false; the isolated development profile enables it for synthetic local bare repositories. Normal destinations use HTTPS or SSH without embedded credentials. Git runs with literal arguments, a 30-second timeout, interactive credential prompts disabled and hooks disabled. No force push is used.

## Workflow

1. **Fetch and compare** reads the selected Sources, fetches the snapshot branch and compares current local data, the remote snapshot and their Git common ancestor. One-sided changes merge automatically. Overlapping changes expose all three values and explicit local, remote or both choices. The merged payload is inspectable before applying.
2. **Apply and commit locally** imports each selected track through that Source's own revision check. Source-normalized results are recorded separately and then written to a local Git commit with both parents. These imports are independent transactions: partial progress is retained and can be resumed, or cancelled without rolling back already imported records. If local data changed, prepare a fresh plan. A process interruption after the Git ref update recovers the same commit using its plan identity.
3. **Review push destination** displays the exact remote, branch and commit. A separate checked confirmation and button push that commit. Remote advancement rejects a non-fast-forward push and requires another comparison. Preparing or applying a plan never pushes.

The optional public transfer protocol uses `transfer-catalog`, `transfer-export` and confirmed `transfer-import`. Each Source defines its own tracks and payload validation. Project notes, tasks, journal and playbooks transfer their project/global/daily records where supported, including inactive and archived states. Their current state and creation identity transfer; local revision history remains local and imports create recovery history. Session state and process/channel credentials are excluded. Deleted record states are explicit tombstones; a missing record is not an erase command. Runtime Memory publishes separate working-memory and user-profile tracks; each document is one conflict unit and prior target contents are retained in `runtime/transfer-history` before import. Both choices retain both document contents, subject to the Source's capacity limits.

The page discovers supported tracks, not a fixed Source whitelist. Sources with unrelated export formats remain unavailable until they implement this optional protocol. Limits are 24 tracks per target, 4 MiB per track, 8 MiB per combined snapshot and 32 MiB per retained plan. Plans and local snapshots remain available after restart. A shared remote exposes the selected data to its readers; choose a private repository when appropriate.

## 中文

这是独立的同步 Source，负责同步目标、合并计划、独立 Git 裸仓库与导入/推送回执，不提供模型动作。页面通过公开、按作用域绑定的 Source 管理客户端协调操作；服务端不读取其他 Source 的目录或内部实现。

启用插件后，创建项目或全局目标，选择远端、稳定标识和同步轨道。项目标识可由 Git origin 生成，SSH 与 HTTPS 形式会规范化；普通目录需要显式填写。各设备使用相同标识和同步名称，但可以绑定不同的本机 Source 实例。全局目标要求显式远端。停用保留数据，切换地址保留旧仓库。每个目标使用 `memory/<scope>-<标识哈希>` 分支，不切换代码分支、不修改代码索引或 worktree。

操作分为三步：「拉取并对比」展示共同、本机与远端版本，冲突可选采用本机、采用远端或两者保留；「应用并保存本地快照」通过各 Source 的版本校验分别导入，并保留独立回执；「查看推送计划」展示精确地址、分支和提交，勾选确认后才推送。任何前置步骤都不会自动推送。远端已前进时，不强制覆盖，需要重新对比。多个 Source 的导入不是跨插件原子事务，中断后已完成部分保留，可继续或取消；本机内容变化时需重新准备计划。

项目笔记、任务、日志和技能按支持的项目、全局、每日范围提供轨道；会话状态和进程/渠道凭据不参与。同步当前内容、创建身份及归档等状态，本机版本历史保留，导入产生恢复历史。删除通过明确的墓碑状态传播，远端缺少条目不会抹除本机记录。Runtime 分别提供工作记忆和用户档案轨道，以单份文档为冲突单元，导入前将旧内容保存在 `runtime/transfer-history`；两者保留受该 Source 的容量限制。

`dataDir` 可覆盖 Host 存储目录。`allowLocalRemotes` 默认关闭，独立验收配置仅为合成本地裸仓库启用。Git 使用独立子进程和参数数组，禁用 Hook、交互式凭据提示及强制推送，30 秒超时。每目标最多 24 个轨道，单轨道 4 MiB，合并快照 8 MiB，保留计划 32 MiB。远端读者可以读取选中的记忆，请按需要选择私有仓库。
