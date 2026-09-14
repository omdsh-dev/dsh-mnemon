# Workspace context validation

This log retains dated implementation checkpoints and their evidence. The September 14 main WebUI acceptance is complete on published DSH `0.1.5-rc.1`, real Mnemon `0.2.7` and `deepseek-flash`. Opening the exact URL printed by DSH restored authentication. See the [current interaction gallery and panoramas](workspace-feedback-validation-20260914.md), [sanitized report](pr-assets/learning-feedback-flash-20260914/validation.json) and [capability inventory](plans/composable-workspace-context.md). Older sections, including [Final verification](#final-verification), apply only to their stated revisions.

## September 14 learning and plugin management

The automated live-model checkpoint `183fd9f` used the published DSH agent loop and returned `deepseek-flash` on all 11 calls, with no tool errors. It verified independent human evidence, pending proposals, explicit negative feedback retaining the active original, plugin-wake exclusion from human counts, actual task-outcome capture and manual review completion.

The later main WebUI checkpoint covers the implementation through `c4a439c`. Four human turns produced reviewed preferences, facts and procedures. Real interactions exercised negative feedback, compared revisions, atomic batch approval, pending transfer and destination approval, task completion, two real CLI Flash calls with session resume, cancellation, an independent Flash reviewer, Source file/history search, exact bookmarks, skill file creation/editing/recoverable removal, Markdown notes, plugin dependencies and compatibility, and switching between the original three tiers and the optional workspace composition. The final learning review completed four human rounds and nine outcomes; it explicitly excluded cancelled work and assistant reports as human confirmation or success evidence. A supervised Flash write created a native Mnemon decision that was subsequently read through the same WebUI.

Screenshots cover light/dark themes, 1440-pixel desktop layouts and 390 × 844 navigation and plugin settings with no document overflow. The original viewport and system-following theme were restored. Full panoramas and per-capability evidence are in the [current gallery](workspace-feedback-validation-20260914.md). The new packages are not published to npm; WebUI preflight checked actual peer versions and same-version prevention, while artifact tests verified installation, upgrade and activation of the independent tarballs.

The final code and test checkpoint `9ee284c` passed documentation, deterministic builds, all plugin type checks and tests, 1,042 root tests (6 opt-in skipped), real Headless activation/restart/legacy migration/whole-Starter disabling, and package validation. The first full run exposed two outdated presentation baselines after the reviewed responsive navigation change; after desktop and narrow-screen inspection, the baseline was updated and all root tests passed. The remaining Headless and package stages then passed. Package contents: 52 files, 310,405 packed bytes and 1,405,165 unpacked bytes; 12 Node entries, 30 public type dependencies, executable help, `publint` and `attw` passed.

`pnpm verify:plugins --skip-build` passed all 37 independent plugin repositories and 38 tarballs, including standalone type checks/tests/builds, rejection of workspace links, external SDK/Client consumers, the compiled shared editor, real DSH Starter installation/upgrade and simultaneous optional Strategy activation. Historical deterministic-model checks below retain their stated scope; they do not imply external account availability or model quality.

本轮主 WebUI 验收已完成，独立实例使用已发布 DSH `0.1.5-rc.1`、真实 Mnemon `0.2.7` 和 `deepseek-flash`。打开 DSH 输出的完整 URL 后认证恢复。真实模型自动化检查点 `183fd9f` 的 11 次请求均返回指定 Flash 模型，无工具错误；它与后续主 WebUI 证据分别记录。

界面验收覆盖至实现提交 `c4a439c`：4 轮人工输入、待审核建议、负反馈修订、批量采纳、方法转存与目标状态回传、任务结果、两次真实 CLI Flash 调用及会话续接、取消、独立审核、文件和会话检索、精确书签、技能文件创建/编辑/保留副本移除、Markdown 便签、插件依赖和兼容性，以及默认三层与可选组合切换。最终整理覆盖 4 个人工轮次和 9 条结果，明确排除取消任务和助手自述作为人工确认或成功证据。主页面还通过 Flash 向原生 Mnemon 写入决策，再读取同一数据库中的结果。深浅主题、桌面和 390 × 844 窄屏均保留截图，页面无水平溢出；测试后已恢复窗口尺寸和跟随系统主题。

代码与测试检查点 `9ee284c` 已通过确定性构建、文档、全部插件类型与测试、1,042 项根测试（6 项 opt-in 跳过）、真实 Headless 启动/重启/迁移/整体停用，以及发布包检查。首次整仓检查发现两项导航样式基线未更新，结合实际页面检查更新后，全部根测试及后续阶段通过。包体为 52 文件、压缩后 310,405 字节、解包后 1,405,165 字节；12 个 Node 入口、30 个类型依赖、命令帮助与包规范检查均通过。独立制品检查随后通过 37 个插件仓库、38 个 tarball、外部 SDK/Client、真实 DSH 安装升级和可选策略激活。新包未发布到 npm；页面验证真实兼容性与同版本防重复，安装流程由独立制品测试覆盖。下文保留旧阶段实际版本、固定模型和对应截图的边界。

## Isolated instance

The branch starts from committed `main` in a separate Git worktree. `scripts/serve-workspace.mjs` owns a separate DSH home, copied Mnemon executable, data directory, synthetic workspace, local model fixture and service logs. The original checkout and its uncommitted work are not used by this instance.

DSH is served on loopback port 5279 for this validation. The installed DSH release is `0.1.2-rc.1`; the real Mnemon executable reports `0.2.7`. The model fixture returns a deterministic response and validates service orchestration, not model quality. Native record writes and WebUI reads use the same isolated Mnemon database; embedding coverage is not implied by this check.

## Completed workflows

- Project notes: propose, approve, archive and restore a branch-scoped fact; pending proposals remain inactive.
- Tasks: create a project task with importance/urgency, edit its deadline, restart DSH, verify persistence, complete it and inspect history.
- Files: find actual text in the synthetic workspace README and read a line-numbered excerpt through the Source page.
- Conversations: search the original visible user message, read its neighboring assistant answer, save a bookmark, fork through completed turn 1, and open the actual child. The child preserves the two visible messages, workspace, preset and model/reasoning selection.
- Native memory: write a synthetic fact using the isolated Mnemon CLI, then read that same record in the Memory Spaces content page (`d44cf977-e2e9-4b25-a1ba-f7e783c6f403`).
- Package checks: workspace utilities (12 tests), files (2), conversations (2), tasks (2), plus type checking and separate client/server artifacts. The root build and type check pass at this checkpoint.

The WebUI caught two integration defects that unit composition alone did not expose: management operation names must use the Host's hyphenated identifier vocabulary, and newly created sessions must be attached through DSH's workspace registry. Both were fixed and retested in the running instance.

## Screenshots

- [File search and excerpt](assets/workspace-context/file-search.png)
- [Conversation search and neighboring messages](assets/workspace-context/conversation-history.png)
- [Completed-turn fork in its workspace](assets/workspace-context/conversation-fork.png)
- [Native memory record](assets/workspace-context/native-record.png)

## 中文

此日志保留各实施阶段及对应验收证据，早期测试数量表示当时的阶段结果。下文[最终验证](#final-verification)只对应其注明的旧版提交；9 月 14 日新增能力已通过真实模型集成与主 WebUI 交互验收，见[本轮截图索引](workspace-feedback-validation-20260914.md)。完整能力清单见[实施计划](plans/composable-workspace-context.md)。

开发分支从已提交的 `main` 建立，使用独立 worktree、DSH 主目录、Mnemon 可执行文件与数据目录。原检出目录及其中未提交的改动没有参与测试。当前验证服务监听本机 5279 端口，DSH 为 `0.1.2-rc.1`，实际 Mnemon 为 `0.2.7`。固定响应的本地模型验证编排流程，不代表真实模型质量；原生记忆验收覆盖实际数据库写入及 WebUI 读取，不代表已启用向量生成。

已通过的 WebUI 流程包括：项目笔记提交审核、采纳、归档与恢复；任务优先级和截止日期编辑、重启保留、完成及历史查看；真实文件检索与行号片段；可见对话检索、相邻消息阅读、保存书签、按已完成轮次分叉并打开子会话；以及同一原生数据库中验收事实的写入和读取。

会话分叉保留原始可见消息、工作目录、预设、模型与推理等级。真实页面测试发现并修正了管理操作命名及子会话工作区归属问题。上述截图保留了对应结果；完整仓库检查、独立安装产物检查和后续插件结果记录在下文各阶段及最终验收中。

## Background jobs checkpoint

The independent Jobs Source passed four process integration tests: literal argv and UTF-8 logs, stale/modified plans, scoped log access and duplicate execution, queued/running cancellation and unload, failures and timeout. Host authorization tests bind external actions to a live agent and per-call approval, and recheck cancellation and write permissions after approval.

The real WebUI created and saved a project job, displayed its complete execution plan, ran the local synthetic adapter, read its durable log and successful exit code, resumed the adapter's session reference, and cancelled a waiting process. A concurrent completion invalidated an editor revision; refreshing preserved the draft and allowed the save. Screenshots: `job-plan.png`, `job-completion.png`, `job-cancellation.png`. External model accuracy, account authentication and the model-initiated approval UI are not covered by this checkpoint.

后台任务已通过进程集成测试，并在真实 WebUI 验证了保存、计划确认、运行日志、继续外部会话及取消。并发更新使过期保存被拒绝，刷新后原草稿可以继续保存。测试仅使用本地合成适配器，不代表任何第三方模型或账号已验证。

The later input checkpoint saved one native PNG and a Runtime Source export into job `92600232-788a-44d2-a6f9-4f0c8855c571`. WebUI displayed the image and the Source revision. The fixture model read the plan through the actual View route and requested its external-authority action; DSH paused for human approval. After allowing once, the process succeeded and printed the exact snapshot plus 1,158 image bytes with SHA-256 `d78f97f5cc60842d1e5e74c3e7116bc9184595e1d8dabc3a527cc3722b2d0332`, matching the retained native image. A separate request for job `91403d1c-f855-4cb4-b8c2-54bf7b24380d` was rejected in WebUI; the record remained a draft with no run id or log.

Seven package tests passed, including real Core composition, stale-copy rejection, denied execution, immutable image/context inputs, tamper rejection, lifecycle cancellation and scoped 90-day cleanup. Integration testing found a capability mismatch after disabling raw execution-history import; the manifest and runtime facts now agree and a Core regression covers their composition. Cleanup was tested on synthetic expired records; current WebUI has zero eligible records, so its cleanup button remains disabled. Screenshots: [saved job inputs](assets/workspace-context/job-input-copies.png), [model approval](assets/workspace-context/job-model-approval.png), [retained-input execution log](assets/workspace-context/job-copied-input-result.png).

后续验收已在页面保存原生图片和 Runtime Source 快照，再由模型通过真实 View 路由读取计划并触发 DSH 审批。允许一次后任务成功，进程打印的上下文、图片字节数及哈希与副本一致；另一任务拒绝审批后仍为草稿，没有执行编号或日志。7 项测试覆盖 Core 组合、版本冲突、拒绝授权、输入固定、损坏拒绝、取消和按项目清理。清理使用合成过期记录测试；当前页面没有到期记录，按钮正确禁用。

The [job input mobile view](assets/workspace-context/job-input-mobile.png) was inspected at 390 × 844 with the saved context and image expanded. The document width and scroll width were both 390 pixels. 窄屏下快照内容正常折行，图片和操作按钮可达，页面没有横向溢出。

## Prompt, review and journal checkpoint

Prompt scheduling tests cover variable substitution, inactive-playbook rejection, session isolation, start/interval/count, duplicate-turn fencing and stopping a disabled playbook. The real WebUI scheduled a variable-expanded prompt for the next human round and verified exactly one use and zero remaining uses. The same real turn produced a Source-owned journal entry containing only visible user/assistant text.

Review tests cover sticky due state, replay fencing, proposal/severity validation, separate persistent reviewer identity, scoped constraints, follow-up history and reset. WebUI verification exercised a manual reviewer question, enabled a one-round automatic review, observed two persisted review results, confirmed the due flag remained set, completed the cycle, and reset reviewer context while retaining both results. The model adapter returned explicit synthetic review output; these checks establish workflow behavior, not review accuracy.

Screenshots: `prompt-schedule.png`, `review-cycle.png`, `review-history.png`, `journal-capture.png`.

提示词调度、独立审核和活动日志已组合运行。真实用户轮次消费一次提示词、生成可见对话日志并推进审核计数；自动审核后到期状态保留，显式完成与重置均保留历史。审核使用本地合成模型，仅验证流程，不评价模型审核质量。

## Collaboration, native skills and suggestion transfer checkpoint

The subsequent collaboration checkpoint added copied image delivery, addressed asset access, filtered message history and resource ownership. Native `read`/`write` tools registered a successful owner write. Another session's write was rejected while ownership was active; reading the actual file confirmed its contents were unchanged. After the owner released its declaration in WebUI, the second session wrote successfully. Future-file declarations were saved without creating the file. Resource type and name filters selected exactly one expected declaration. A native image was copied, admitted as an attributed image message, previewed by the recipient, marked read, archived by its sender and restored. The mobile page had no horizontal overflow at 390 × 844.

This test exposed two integration issues: the development preset lacked DSH's standard coding tools, and an appended filesystem listener ran after a terminal policy. The profile now copies the shipped standard preset into its isolated home, offering the native coding and memory tools. The Source wraps the public intent event with `prepend: true` and preserves the existing policy by awaiting the continuation. The conflict, release and successful-write checks passed after both fixes. Nine collaboration tests and 22 shared utility tests passed; final repository verification remains pending.

Screenshots: [automatic file registration](assets/workspace-context/collaboration-auto-file.png), [conflicting write rejection](assets/workspace-context/collaboration-write-conflict.png), [resource filters](assets/workspace-context/collaboration-resource-filter.png), [copied image](assets/workspace-context/collaboration-image-delivery.png), [mobile image history](assets/workspace-context/collaboration-mobile.png).

后续协作验收覆盖真实文件冲突、释放后写入恢复、未来文件声明、资源组合筛选、原生图片复制投递、收件预览、已读、归档与恢复。实测发现并修正了开发预设缺少编码工具、文件监听晚于终止型策略的问题；当前实例加载标准编码工具，协作 Source 在公开意图事件前检查，并继续执行原有文件版本策略。390 × 844 页面无横向溢出。图片回执不等同于模型已消费图片，固定模型也不代表视觉能力验证。

Real WebUI checks created a project room, invited existing test sessions, sent directed messages with an explicit wake, read addressed history, inspected presence and reserved a real project file. Core integration tests also reject unauthorized delivery, non-member recipients, stale membership, conflicting reservations and malformed imported receipts. Closed room history is retained.

The first cold-session wake exposed a missing model-options restoration: message delivery succeeded but the resumed agent failed during prompt assembly. The shared public DSH adapter now restores the last recorded model/reasoning configuration and serializes concurrent resume requests. A fresh UI test first observed another session as unloaded, sent an explicit wake and verified its new assistant response at 14:01. Delivery receipts describe message acceptance; they do not promise a successful model response.

The skills page listed and edited a configured SKILL.md, and the native DSH registry returned its updated body. A synthetic review supplied a fact and a skill; each was explicitly transferred to its selected Source's pending queue. The skill was absent from the native catalog before approval, appeared after approval, and disappeared after disabling. Source-owned skill records and configured directory skills share the native discovery interface. A native `/feedback` command was captured with its exact quote, without expansion or guessed sentiment. Session search excluded injected collaboration text and opened a selected native session through public navigation.

At this checkpoint the utility package has 13 passing tests, collaboration 4, playbooks 6, review 3, sessions 2 and the root Source-page integration 9. Root and all Source artifacts build. Full repository and isolated package verification remain part of final acceptance.

Screenshots: [directed message](assets/workspace-context/collaboration-message.png), [file reservation](assets/workspace-context/file-reservation.png), [native skills](assets/workspace-context/native-skill-catalog.png), [skill editor](assets/workspace-context/skill-file-editor.png), [review transfer](assets/workspace-context/review-proposals.png), [pending fact](assets/workspace-context/project-review.png), [pending skill](assets/workspace-context/skill-proposal.png), [exact feedback](assets/workspace-context/journal-feedback.png), and [successful cold-session wake](assets/workspace-context/cold-session-resume.png). The initial failure is retained in `cold-session-resume-before.png` for comparison.

真实页面已验证项目协作空间、成员邀请、定向消息、显式唤醒、历史阅读、在线状态与文件预约。首次唤醒未加载会话时发现模型配置未恢复，已在公开 DSH 适配层修复，并通过另一个未加载会话的新回复验证。投递回执仅表示消息被接收，不将其等同于模型成功完成。

技能文件读取与编辑、原生目录加载、审核建议转入目标待审核队列，以及技能采纳和停用对原生目录的影响均已验证。原生反馈命令被逐字记录；会话检索排除注入的协作内容，并能打开选定的原生会话。截图保存于上述路径，最终整体验收仍在继续。

## Notifications and attachments checkpoint

Notifications is an independent Source with its own inbox, attachment store and reviewed delivery plans. Six integration tests cover exact-plan and workspace checks, claims across independent engines, actual loopback HTTP delivery, corrupted attachments, configuration changes, partial or uncertain receipts, interrupted claims, event deduplication and unloading a transport that ignores abort. The shared utility package now has 18 tests, including path/URL/base64 bounds, redirects, tamper detection, asset retention and native image ownership. Root Source-page, client mounting and overlay binding tests total 21; the new binding tests reject a late catalog from the previous session and keep open UI state stable during revision refresh.

Real WebUI tests saved a local notice with a file, previewed text and PNG attachments, combined search with unread filters, marked a notice read, archived and restored a delivery, and opened its associated native session. A concrete direct-message plan selected two loopback receivers; each received exactly one request with the same delivery ID and attachment hash, confirmed independently in the receiver ledger. No third-party account or human recipient was contacted.

The floating bell was dragged from the left edge to the right, retained its position after reload, and remained usable at a 390 × 844 viewport. Both its popup and the full Source page were checked in the current dark theme. Real testing found and fixed a periodic catalog refresh that reset open forms, and a text contrast issue in the full page. A native image paste was correctly rejected by a text-only model; selecting the image-capable route in the same loopback model fixture accepted it. The Notifications Source then copied and previewed that actual user image through the public native attachment service.

Screenshots: [inbox](assets/workspace-context/notification-inbox.png), [file preview](assets/workspace-context/notification-attachment.png), [send plan](assets/workspace-context/notification-delivery-plan.png), [channel receipts](assets/workspace-context/notification-delivery-receipts.png), [PNG preview](assets/workspace-context/notification-image.png), [native user image](assets/workspace-context/notification-session-image.png), [retained position](assets/workspace-context/notification-position.png), [narrow viewport](assets/workspace-context/notification-mobile.png). The full native service status image was refreshed as well.

通知与附件已通过服务端集成测试和真实页面验收，涵盖本地收件箱、搜索与未读筛选、归档恢复、文件和图片预览、关联会话跳转、按钮拖动与刷新保留，以及 390 × 844 窄屏布局。两个本机接收器各收到一次相同发送计划中的消息，附件哈希一致；没有连接第三方账号或向实际人员发送消息。

页面测试发现并修正了轮询导致表单重置和深色主题文字对比度问题。原生会话先验证纯文本模型拒绝图片，再选用同一本机模型适配器中的图片路由，成功提交图片并由通知 Source 通过公开附件服务复制、预览。模型响应仍为固定合成结果；全仓库检查、独立制品安装、完整能力补齐与最终验收仍在进行。

## Material board and composition configuration checkpoint

The independent Canvas Source passed four integration tests covering live files, missing files, symlink and private-directory rejection, scope filtering, revision fences, asset integrity, persistence and real Core composition grants. Notes and registered file bodies remain outside the automatic projection. The real WebUI created session, project and global cards; dragged and resized a note; preserved pan and zoom after reload; copied a stable material reference; and archived and restored a card. File edits appeared on reload, a missing file retained its card, and an uploaded PNG remained readable after its original local file was moved. Actual audio and video controls reached their ended state; malformed media showed a recoverable error. Another session excluded the private note in its default view and included it only in the explicit project-wide human view.

The generic composition editor discovers installed Strategy descriptors without a business-plugin whitelist. Real preview reported 14 Sources, 26 routes and 29 actions. Enabling the independent Focus enhancement with Tasks and Canvas and an empty writable list produced 2 Sources, 3 routes and 0 actions. Saving and restoring the full composition both succeeded. Host route/action budgets now apply consistently to previews, new turns and pinned turns; positive limits and fair operation selection are covered by configuration, runtime and Strategy tests. The default budget remains 16 and the optional development profile uses 96.

Root client checks passed 52 tests, alongside root type checking/build, Focus tests and Canvas verification. A 390 × 844 viewport had a document width and scroll width of exactly 390 pixels, with a 282-pixel board after collapsing native navigation. Service-host file opening is opt-in and was not exercised; binary model reads return metadata, while the human page renders supported media. Screenshots: [material board](assets/workspace-context/canvas-media.png), [missing file](assets/workspace-context/canvas-missing-file.png), [narrow viewport](assets/workspace-context/canvas-mobile.png), [read-only composition](assets/workspace-context/focus-preview.png).

素材画布已通过文件边界、作用域、并发版本、持久化、附件完整性和真实 Core 组合测试。WebUI 实测了便签、实时文件和上传副本，拖动与尺寸修改，平移缩放的刷新保留，跨会话视角，归档恢复，以及真实音视频播放。文件更新可以重读，文件缺失保留卡片，上传副本不依赖原文件。窄屏下没有页面横向溢出；截图保留在上述路径。

通用策略配置界面根据独立插件声明展示字段，无业务插件白名单。默认预览含 14 个 Source；启用“专注上下文”并仅选择任务、画布及空写入集合后，预览变为 2 个 Source、3 条读取路由、0 个操作。保存与恢复完整组合均成功。Host 的预算同时约束预览和实际轮次，并保留旧轮次的原预算；默认值保持不变。服务主机打开文件功能没有在本轮测试中执行，模型读取二进制素材返回元信息，人类页面负责媒体展示。

## Reviewed synchronization checkpoint

The independent Sync Source passed seven integration tests: real divergent Git histories and three conflict decisions, persisted plans, stale/configuration/scope rejection, malformed records and destinations, explicit tombstones, an interrupted receipt after a successful ref update, foreign project identity rejection, and real Core composition with independent instances. It exposes no model routes or actions. Workspace utilities passed 19 tests and Runtime passed 41, including transfer scope rebinding, history preservation, idempotency, separate user storage, capacity rejection and Source-wide revision fencing.

The real WebUI created a project target with notes, tasks, journal and playbooks. The first local commit left the remote empty until the separate reviewed push. A synthetic second device then changed three records in the local bare remote. The page displayed the common/local/remote values; notes kept both versions, tasks kept the local value and feedback adopted the remote value. Actual Source pages confirmed both notes and retained history. The pushed merge has both the previous local commit and fetched remote commit as parents. The development code branch was unchanged.

A second UI target selected six global tracks. Its next import changed working memory and user preferences and added personal tasks, daily tasks and a daily journal entry. All six tracks returned receipts; the Runtime page displayed the imported content and both prior Runtime documents were retained in the transfer-history directory. Git independently confirmed a separate global branch with a two-parent merge. Destinations were local synthetic repositories; no account or production remote was contacted.

Screenshots: [three-way conflicts](assets/workspace-context/sync-conflicts.png), [both note versions](assets/workspace-context/sync-merged-notes.png), [global import receipts](assets/workspace-context/sync-global-receipts.png).

独立同步 Source 已通过真实 Git 分叉历史、三种冲突决策、计划持久化、作用域和版本拒绝、格式与地址校验、墓碑记录、中断恢复及真实 Core 多实例测试。它不提供模型动作；记录工具包与 Runtime 的同步校验分别包含在 19 项和 41 项测试中。

WebUI 实测了四类项目数据的首次快照，确认应用不会自动推送，再分别对笔记、任务与反馈使用两者保留、采用本机、采用远端。导入结果保留本机历史，Git 合并提交具有两个父提交，代码分支保持原样。另一个全局目标实测六条轨道，导入工作记忆、用户偏好、个人任务、每日任务和每日日志，回执全部完成，Runtime 旧内容保留于恢复目录。远端仅为本机合成裸仓库；没有向正式仓库发送数据。

## Task views and result capture checkpoint

Task checks cover all four priority groups, combined type/category/date/deadline filters, deterministic ordering and exclusion of completed work from overdue results. The WebUI populated four groups, filtered a single overdue task, marked it complete and observed zero overdue matches. Daily-only filtering returned exactly one task. At 390 × 844, document and scroll width were both 390 pixels and all filters remained reachable.

Journal tests use a real Git repository to confirm branch provenance and deduplication for feedback and project/daily job results. The WebUI ran a copied local job, observed successful exit 0 and its retained log, then filtered two new results by date and background-job category. Notifications independently recorded the completion. The fixture workspace has no Git branch, so those UI records have no invented branch.

Two React race tests reject a late read from a previous workspace and prevent an old pending save from overwriting the new workspace or restoring its draft. Workspace utilities passed 21 tests; Tasks and Journal passed four each, plus type checks and separate builds. Screenshots: [priority matrix](assets/workspace-context/tasks-priority-matrix.png), [mobile task filters](assets/workspace-context/tasks-mobile.png), [project and daily results](assets/workspace-context/job-journal-capture.png).

任务视图实测四个象限、组合筛选、每日任务，以及完成逾期任务后计数从 1 变为 0。390 × 844 窄屏下控件可达，页面没有横向溢出。日志测试使用真实 Git 仓库验证分支来源和去重；WebUI 中的新任务成功完成，随后实际生成项目、每日两份日志和独立站内通知。普通目录不伪造 Git 分支。

共享集合页面通过两个异步竞争测试，保证旧工作区的响应与草稿不会覆盖新页面。工具包共 21 项测试通过，任务与日志各 4 项通过，独立类型检查与构建完成。

## Independent artifacts and prompt scheduling checkpoint

All 35 independent plugin repositories passed standalone tarball installation, workspace-link rejection, type checking, tests and builds. The external consumer passed its public SDK composition and Client tests against 36 packed artifacts. Real DSH passed installation of only the packed Starter, upgrade from 0.4.7, and concurrent activation of three optional Strategy packages. The consumer now declares every tested plugin explicitly and derives the expected artifact set from that manifest, replacing an obsolete fixed package count.

WebUI created a continuous prompt schedule, used it in two consecutive human turns, stopped it, and completed a third turn. The durable record remained stopped with exactly two uses. A separate immediate invocation previewed its expanded variables and completed once with explicit wake; the native conversation produced another assistant response at 18:15. These checks validate delivery and turn accounting with the local deterministic model. Screenshots: [stopped after two uses](assets/workspace-context/prompt-schedule-stopped.png), [immediate invocation](assets/workspace-context/prompt-immediate.png).

35 个独立插件逐一通过制品安装、禁止工作区链接、类型检查、测试和构建；外部消费者用 36 个打包制品通过公开 SDK 组合与前端测试。真实 DSH 验证仅安装 Starter、从 0.4.7 升级，以及同时启用三个可选策略。消费者清单现在明确声明全部插件，制品数量随清单校验。

提示词持续调度在两个人类轮次中各触发一次；手动停止后的下一轮保持两次使用。另一次立即调用预览变量展开结果后完成一次，并显式唤醒会话，原生会话在 18:15 产生新回复。实际模型仍是本机固定响应，验证范围是投递、计数和停止行为。

## Ordinary conversations, presets and exact bookmarks checkpoint

The session Source now publishes separately authorized create, fork, rename and delivery actions, with durable request claims and receipts. Its metadata routes read the native model and preset registries, preserve unknown image capability, and resolve unlisted exact models without treating discovery as an allowlist. The public adapter mounts the selected preset during unpublished create and cold resume setup. A failed preset mount cannot publish a half-composed agent.

WebUI read the native catalog, including image capability, context capacity and four reasoning levels. A saved message at sequence 7 opened in the Source's focused reader, and its completed turn produced a native one-turn fork. The fork's model requested another ordinary conversation through the offered action; DSH paused for the exact request's approval. Allowing it created and woke a new session, which appeared in its workspace and produced a real fixture response. A subsequent Source action renamed it; native identity confirmed its parent, preset, model and idle status. Both new sessions' persisted request headers contained 42 tools, including read, write, edit, bash and skill. No native subagent was launched.

The exact reader locates an old message before budgeting its body, rejects missing or non-visible anchors, and focuses only Source-owned markup. It does not patch or inspect the native conversation DOM. The native conversation remains available through a separate navigation action. At 390 × 844 the controls remained reachable and document width equaled scroll width. Twenty-five utility tests and six session tests passed, followed by all 35 plugin builds.

Screenshots: [model capability](assets/workspace-context/session-model-capabilities.png), [exact bookmark](assets/workspace-context/bookmark-exact-location.png), [native fork](assets/workspace-context/bookmark-native-fork.png), [reviewed creation](assets/workspace-context/session-create-approval.png), [created conversation](assets/workspace-context/session-created-response.png), [native identity](assets/workspace-context/session-identity.png), [mobile actions](assets/workspace-context/session-actions-mobile.png).

会话 Source 提供独立授权的创建、分叉、改名和投递动作，执行前持久登记请求；中断结果不会静默重复执行。模型与预设目录来自 DSH 的公开注册表，未知图片能力保持未知。创建及恢复时通过公开 setup 挂载预设，避免仅保存名称而缺少工具。

WebUI 精确定位消息 7，并从该轮创建原生分支；分支中的模型请求经过原生审批后，创建并唤醒一个普通协作会话，实际产生回复。改名与身份读取确认了父会话、预设和模型。两个会话的持久请求头均包含 42 个工具，包含读取、写入、编辑、Shell 和技能；未启动原生子代理。书签定位使用 Source 自己的阅读区，原生对话通过独立按钮打开，没有改动宿主 DOM。25 项工具包测试、6 项会话测试以及 35 个插件构建通过，移动页面没有横向溢出。

## Durable reminders, capacity and reviewed prompt invocation

Journal passed five tests for persisted human-turn gaps, event deduplication, subagent and plugin-only exclusion, session isolation and actual-write resets. Workspace passed five tests, including rejection of reminders for Sources with no offered write action. The journal enhancement remained a pure consumer of public hints. Session checks passed seven tests including unknown, moderate and high capacity readings; Playbooks passed nine tests, including exact-version Core authorization, duplicate schedules, one-shot wake behavior and isolation of a failed variable expansion.

Real WebUI exercised synthetic 35% and 45% usage and then a low-usage round; the additive amber/red hint appeared and disappeared accordingly. After two human turns without a journal write, the Source reported due. The next native request's system instructions retained the reminder. Saving an actual progress record reset the count to zero. Usage numbers were explicitly injected by the loopback fixture and are not measurements of an external provider's billing.

The model read an approved prompt through a granted Source route, then requested use of exact version 5. Native DSH paused for `session-instructions` approval showing the prompt ID, version, variables and wake intent. One approval produced a committed receipt and attributed next-step injection in the same fifth human round. The durable schedule was completed with one use and zero remaining; no extra human round or continuous loop was created.

Screenshots: [moderate capacity](assets/workspace-context/context-capacity-moderate.png), [high capacity](assets/workspace-context/context-capacity-high.png), [journal due](assets/workspace-context/journal-reminder-due.png), [journal reset](assets/workspace-context/journal-reminder-cleared.png), [exact prompt approval](assets/workspace-context/prompt-model-approval.png), [attributed delivery](assets/workspace-context/prompt-model-delivery.png), [completed schedule](assets/workspace-context/prompt-model-completed.png).

日志通过持久计数、事件去重、子代理与纯插件轮次排除、作用域和实际写入清零测试。策略仅在同一 Source 确实提供写入动作时加入到期提醒。WebUI 实测了合成 35%、45% 和低用量下的提示变化；连续两个人类轮次未记录后保持到期，下一次原生请求仍含提醒，保存实际进展后清零。

模型先读取已采纳提示词，再以版本 5 请求原生授权。批准一次后，回执确认保存，并在第五个人类轮次的下一步以插件来源注入；调度记录显示完成、使用 1 次、剩余 0 次，没有额外用户轮次或循环。相关截图保存在上述路径。固定模型用于检验编排，合成 token 用量不代表外部服务计费。

## Project binding and library organization checkpoint

The actual isolated code worktree was registered through DSH's native Add workspace UI. Its first conversation used the copied standard preset and completed a fixture response. Native session storage independently confirms the code checkout as `cwd`, `workspace-validation` as preset, and 42 tools including read/write/edit/bash/skill and both View tools.

A real cross-project check exposed a hidden stale inspection selection in Global/Custom storage. Source records were scoped correctly on disk, but the sidebar sent its old inspection workspace. The host now follows the current conversation in those modes; Workspace mode keeps its visible inspection selector. Twenty-two sidebar tests passed, including both storage modes and preservation of explicit Workspace inspection. WebUI now shows zero project playbooks in the code checkout and the original two after returning to the synthetic project, with separate session schedules.

Playbooks passed ten tests, including Core-authorized partial metadata updates, four combined query filters, scoped category rename/removal and stale-version rejection. WebUI updated summary/tags, rejected an outdated category edit without losing its draft, renamed the category after refresh, and matched exactly one prompt with name/category/tag/description together. Removing the category retained the prompt and history; the example category was then restored. The 390 × 844 page had equal document and scroll widths. Native DSH settings exposed model display names and capacity controls without a duplicate plugin configuration store.

Screenshots: [isolated code conversation](assets/workspace-context/isolated-code-session.png), [project isolation](assets/workspace-context/workspace-project-isolation.png), [combined filters](assets/workspace-context/playbook-combined-filters.png), [mobile filters](assets/workspace-context/playbook-filters-mobile.png), [native model settings](assets/workspace-context/native-model-settings.png).

通过 DSH 原生“添加工作区”加入了实际代码 worktree，新会话使用标准编码预设并完成回复。原生持久记录确认工作目录、预设及 42 个工具。跨项目页面测试发现全局/自定义存储下隐藏的旧检查对象会影响管理请求，现已改为跟随当前会话；工作区模式保留显式检查选择。22 项侧栏测试通过，WebUI 实测代码目录为 0 条项目方法，切回测试目录恢复 2 条，调度按会话隔离。

方法库 10 项测试及真实页面验证涵盖局部元信息保留、四条件检索、过期修改拒绝、分类重命名/移除与历史。刷新后修改成功，删除分类保留方法正文；示例分类已恢复。窄屏无横向溢出。原生模型设置提供显示名称与容量入口，插件没有维护重复配置。

## Final verification

Final verification completed on 2026-09-09 in branch `codex/composable-workspace-context`, created from committed `main` at `0d5f5fa`. The separate worktree and its service profile remain available through the generated `../services/workspace.code-workspace`.

| Gate | Result |
|---|---|
| `pnpm verify` | Passed: bilingual documentation, types, deterministic builds, all plugin checks, 841 root tests across 79 files, real Headless activation, package contents, public imports, publint and declaration validation |
| `pnpm verify:plugins` | Passed: 35 independent packages installed without workspace links, each type checked, tested and built; 36 packed artifacts, external public SDK and Client consumer, real DSH Starter and optional Strategy activation |
| `pnpm release:intent` | Passed: changeset coverage for the expanded public package graph and changed existing components |
| Real WebUI | Passed: the desktop and mobile workflows recorded above, including project isolation, version conflicts, native approval, persistence and recovery |

The final isolated installation caught a missing public type augmentation in the Sessions capacity component. It now declares the DSH session UI, session controller and projection packages explicitly and imports the public session UI type augmentation. The standalone Sessions package and the entire artifact gate passed after this correction.

The retained complete composition contains 15 Sources, the Workspace Strategy and four enabled enhancements; Focus remains installed and disabled after its separate read-only check. Its final preview has 29 read routes, 40 actions and 2,992 context characters. The actual code-worktree conversation has the standard preset and 42 tools. The real Mnemon CLI and WebUI share the dedicated database containing the retained validation fact.

There are 73 retained PNGs in `docs/assets/workspace-context`, including the [complete composition](assets/workspace-context/complete-composition.png) and [native service status](assets/workspace-context/native-status.png). Command logs remain outside the code worktree in `../services/logs/verify-final.log`, `verify-plugin-artifacts-final.log` and `release-intent-final.log`. Service data and logs are retained for reopening and restart.

The local model and job adapter validate orchestration with deterministic responses. External model quality, third-party accounts and embedding availability were not claimed: the native status check reports zero embedded records out of one, with no reachable embedding service configured. Notification delivery used two loopback receivers and synchronization used local bare Git repositories. No external publication is part of this delivery.

最终验收于 2026-09-09 完成。分支 `codex/composable-workspace-context` 从已提交的 `main`（`0d5f5fa`）建立，独立 worktree、服务目录和生成的 workspace 文件均保留。`pnpm verify`、`pnpm verify:plugins` 与 `pnpm release:intent` 全部通过：841 项根测试、全部插件检查，以及 35 个独立包和 36 个制品的无工作区链接安装、类型、测试、构建及真实 DSH 集成。

独立安装发现会话容量组件缺少公开类型扩展依赖，已明确声明并导入 DSH 的公开会话 UI 类型；修正后该插件及全部制品再次通过。最终组合包含 15 个 Source、Workspace 主策略与四个已启用增强，专注增强在单独验收后保持关闭。预览为 29 条读取路由、40 个操作、2,992 个上下文字符；实际代码目录会话具有标准预设与 42 个工具，真实 Mnemon 数据库中的验收事实可由 CLI 和 WebUI 读取。

保留 73 张 PNG 截图，覆盖桌面、移动、跨项目、审批、冲突、持久化和恢复流程。检查日志、服务状态和测试数据保存在独立 services 目录，服务继续运行。本机固定模型与 CLI 程序检验编排；外部模型质量、第三方账号和嵌入服务未验证，当前原生状态为 1 条记忆、0 条已嵌入。通知只发往两个本机接收器，同步只使用本机裸仓库；本次没有对外发布。

## Settings UI follow-up — 2026-09-10

Settings now uses DSH theme tokens, public buttons and icons, compact preference rows, segmented choices and switches. Composition exposes compatible installed Strategy packages as expandable rows; each package still owns its configuration descriptor. Preview retains exact-draft and revision checks, with summary counts and expandable Source operations. The implementation uses published DSH APIs and only styles its own markup.

Real WebUI checks covered desktop dark and light themes, numeric validation, persistence, preview invalidation, reload and a 390 × 844 viewport. Review interval `0` was rejected; `6` was previewed, saved and retained after reload, then restored to the default `5` with its override removed. A draft Focus configuration previewed two Sources, three read routes and zero actions; reload discarded it and restored the complete 15-Source, 29-route, 40-action composition. The code-worktree conversation's preview contained 2,380 context characters. Focus remains disabled.

At 390 pixels, native navigation leaves a 98-pixel content column. The plugin offers a launcher there and opens its form in the public DSH dialog, providing 286 pixels of content. Form width matched scroll width, and document width matched its 390-pixel scroll width. The title and close button remain visible during long forms; the basic settings Save/Discard footer stays reachable. Returning and reopening retained a basic display draft, Discard restored the saved value, and Escape closed only the plugin dialog and restored focus. The viewport and original system-following theme were restored after testing.

The final `pnpm verify` passed 845 root tests across 80 files, all plugin checks and builds, Headless activation with 39 tools, package contents, public imports and package linting. Targeted tests cover preview/save fencing, read-only configuration, multiline list editing, narrow-dialog focus and parent-draft retention. Logs are retained in `../services/logs/settings-final-targeted.log` and `settings-verify-final.log`.

| Evidence | Capture |
|---|---|
| Desktop settings | [Dark](assets/workspace-context/settings-native-dark.png), [light](assets/workspace-context/settings-native-light.png) |
| Strategy rows | [Dark](assets/workspace-context/settings-composition-dark.png), [light](assets/workspace-context/settings-composition-light.png) |
| Exact composition preview | [Counts and Source details](assets/workspace-context/settings-composition-preview.png) |
| Narrow entry and full form | [Launcher](assets/workspace-context/settings-mobile-entry.png), [form](assets/workspace-context/settings-mobile.png) |
| Long form and pending draft | [Strategy fields](assets/workspace-context/settings-mobile-fields.png), [Save/Discard](assets/workspace-context/settings-mobile-draft.png) |

设置现采用 DSH 的主题变量、公开按钮与图标，以及紧凑设置行、分段选项和开关。兼容的独立策略插件按行展开参数，字段仍由各插件自己的描述符提供。组合预览保留草稿与版本校验，汇总数量后可逐层展开 Source 操作详情；实现仅使用 DSH 公开 API，并只为自身页面设置样式。

真实 WebUI 覆盖深色、浅色、数值校验、保存持久化、预览失效、重新加载及 390 × 844 窄屏。审查间隔 `0` 被拒绝，`6` 预览保存后重载仍保留，随后恢复默认 `5` 并移除覆盖值。专注配置草稿预览得到 2 个 Source、3 条读取路由、0 个操作，重新加载后恢复完整 15 个 Source、29 条读取路由、40 个操作；实际代码目录会话的预览为 2,380 个上下文字符。专注增强保持关闭。

390 像素页面中，宿主导航后仅剩 98 像素。插件入口通过 DSH 公开弹窗打开完整表单，内容区为 286 像素；表单与页面均无横向溢出。长表单的标题、关闭按钮保持可见，基础设置的保存与放弃栏始终可达。返回后重开保留基础展示设置草稿，放弃修改恢复原值；Escape 仅关闭插件弹窗并恢复焦点。验收后恢复原有“跟随系统”主题与桌面视口。

最终 `pnpm verify` 通过 80 个文件中的 845 项根测试、全部插件检查和构建，以及 Headless、包内容、公开入口与包规范检查。定向测试覆盖预览与保存校验、只读字段、多行列表编辑、窄屏焦点和基础草稿保留。新增 9 张截图如上，检查日志保存在独立服务目录。

## Main synchronization and DSH 0.1.5 — 2026-09-10

Merged `main` at `2fa306b` (v0.5.7) into `codex/composable-workspace-context`. The upstream HTTP 405 and legacy-session fixes from PR #226 are retained. The expanded plugin graph uses the published `@deepseek-ai/*` 0.1.5-rc.1 development cohort, the npm `latest` version at this checkpoint; no DSH source checkout or source changes are involved.

The merge preserves default runtime capacity maintenance while keeping exact-call DSH approval for actions with external authority. Journal capture accepts category-only feedback without inventing a text record. Both workspace storage modes preserve the visible inspection selection; Global and Custom modes follow the active conversation. The centralized storage directory form wraps below the compact storage choices.

| Gate | Result |
|---|---|
| `pnpm verify` | Passed: 935 root tests, 5 opt-in skips; all 35 independent plugin checks/builds, deterministic Root builds, package and public-entry checks |
| `pnpm verify:plugins` | Passed: 35 standalone plugin repositories and 36 tarballs, external public SDK/Client consumer, real DSH Starter installation and optional Strategy activation |
| Real DSH Headless | Passed on 0.1.5-rc.1: 38 tools including 8 Mnemon tools, restart, canonical Builtin and disabled Starter checks |
| Real Mnemon | Passed with Mnemon 0.2.7: isolated space creation, View write, keyword recall and forget |

A fresh, separate `services-dsh-015` profile starts the released DSH Web stack with the complete workspace composition and the real Mnemon executable. The previous service profile and its synthetic history remain unchanged. Browser navigation was blocked by the client (`ERR_BLOCKED_BY_CLIENT`) in both the in-app browser and Chrome, so this checkpoint has no new WebUI acceptance or screenshots. The dated screenshots above document the earlier UI revisions and are not evidence of a visual recheck after this merge. Centralized storage layout and the combined settings flow still need a browser recheck when local navigation is available. The local model remains deterministic; external model quality is outside this validation.

Command logs remain outside the repository in `../services/logs/sync-main-verify.log`, `sync-main-plugin-artifacts.log` and `sync-main-native-integration.log`. Runtime logs and authentication links are not included in repository evidence.

CI now builds the complete plugin graph in dependency order before integrated type checking and tests; its previous four-package selection omitted the new public SDKs on a clean checkout.

The first PR CI run also exposed Root declaration compilation including every plugin implementation before their SDKs existed. Root now starts declaration emission only from its own sources and imported contracts; `verify` builds all public artifacts before integrated type checking. The follow-up `pnpm verify` passed after removing all 36 generated output directories, including 935 root tests, all plugin checks and the same 48-file public package. Cached SDK output could not hide this dependency error. Its log is retained outside the repository as `../services/logs/sync-main-clean-verify.log`.

Linux CI then exposed three lookups depending on a system `rg` command. The workspace utility package now declares `@vscode/ripgrep` 1.18.0 and lazily resolves its platform binary for file, skill and imported-session discovery. Explicit local command overrides remain supported. Nine focused tests passed, including real search with an empty child `PATH`; process deadlines, output bounds and directory authority are unchanged.

已将 `main` 的 `2fa306b`（v0.5.7）合入独立分支，保留 PR #226 中 HTTP 405 与旧会话副本修复。完整插件依赖图同步到当时 npm `latest` 的正式制品 0.1.5-rc.1，没有修改 DSH 源码或引用源码 checkout。

合并保留默认运行时容量维护，并让需要外部权限的动作继续经过逐次 DSH 审批。日志允许只有分类、没有文字的反馈事件，不生成虚构原文；两种工作区存储模式保留显式检查对象，全局与自定义模式跟随当前会话。集中式目录表单在紧凑选项下方独占一行。

`pnpm verify` 通过 935 项根测试（另 5 项 opt-in 跳过）、35 个独立插件检查与构建、确定性构建及包验证。真实 DSH 0.1.5 Headless 通过 38 个工具（其中 8 个 Mnemon 工具）、重启、内置工作区与停用 Starter 检查。真实 Mnemon 0.2.7 通过隔离空间创建、View 写入、关键词召回和删除。

`pnpm verify:plugins` 通过 35 个独立插件仓库、36 个制品、外部公开 SDK/Client 消费者，以及真实 DSH 的 Starter 安装和可选策略启用。CI 现在先按依赖顺序构建全部插件，再进行集成类型检查与测试，避免全新 checkout 缺少原来四包列表之外的公开 SDK。

首次 PR CI 还发现 Root 声明生成提前编译了所有插件实现，依赖尚不存在的 SDK。现已改为仅从 Root 源码及其导入契约生成声明，并让 `verify` 先构建全部公开制品，再做集成类型检查。清空 36 个生成物目录后，`pnpm verify` 再次通过 935 项根测试、全部插件检查及相同的 48 文件公开包，排除了旧 SDK 产物掩盖问题的可能。日志保存在仓库外的 `../services/logs/sync-main-clean-verify.log`。

Linux CI 随后发现三处检索依赖系统 `rg` 命令。工具包现明确声明 `@vscode/ripgrep` 1.18.0，并按需解析平台程序，用于文件、技能和导入会话检索；显式本地命令覆盖仍保留。9 项定向测试通过，其中包括子进程 `PATH` 为空时的真实检索。进程时限、输出上限和目录授权保持原有检查。

新的 `services-dsh-015` 独立环境已启动完整组合，之前的服务目录及合成历史保持原状。本轮内置浏览器和 Chrome 均以 `ERR_BLOCKED_BY_CLIENT` 阻止访问，因此没有新的 WebUI 验收或截图。上面的历史截图只对应其注明的版本；集中式存储布局及合并后的设置流程仍需在本机浏览器访问恢复后复查。固定响应模型只验证编排，不代表外部模型质量。命令日志保存在仓库外，运行日志和认证链接不进入验收材料。

## Main rebase — 2026-09-12

Rebased onto `main` at `8f3ce5e` (v0.5.8) with `git rebase --rebase-merges origin/main`, preserving the existing feature history and the manual DSH compatibility resolutions. The upstream review guards, stable result tool, runtime archive preflight, routing fallback and sidebar fixes are retained. Root and the artifact consumer now use 0.5.8; the independent plugin graph, published DSH 0.1.5-rc.1 dependencies, clean-build ordering and portable search dependency are preserved.

The reviewed bilingual copy baseline contains 983 keys per language: the prior settings copy plus the three upstream background-review warnings. The first focused run identified the stale baseline; no product copy was removed to satisfy it.

The initial CI source job passed, including Node 20 public imports. Independent installation exposed npm selecting a new DSH 0.1.5-rc.2 peer beside exact rc.1 development packages. Eight plugin manifests now explicitly declare their required transitive DSH development peers at rc.1. Public runtime peer ranges are unchanged; the lockfile adds importer entries without changing package resolutions or snapshots. The complete local verification and all independent artifact checks passed after this correction.

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed against the updated manifests and lockfile; resolved package versions unchanged |
| `pnpm verify` | Passed: 1,018 root tests, 5 opt-in skips; all 35 plugin builds, type checks and tests; deterministic builds and package validation |
| `pnpm test` | Passed: 1,446 tests, 7 opt-in skips across 177 files |
| `pnpm verify:plugins --skip-build` | Passed: 35 standalone plugin repositories and 36 tarballs, external SDK/Client consumer, real DSH Starter upgrade and optional Strategy activation; reused the already verified Root build |
| Real DSH Headless | Passed: 39 total tools, 8 representative Mnemon tools, canonical Builtin persistence, restart and disabled Starter checks |
| Real Mnemon | Passed: isolated space creation, View write, keyword recall and forget |
| Public package | Passed: 48 files, 1,347,922 unpacked bytes, 12 Node imports, 28 public type dependencies, executable help, publint and declaration checks |
| Release intent | Passed against `8f3ce5e` |

Logs are retained outside the repository under `../services/logs/rebase-main-20260912-*.log`. This checkpoint verifies the rebased code automatically; it does not add new WebUI screenshots. The browser recheck recorded above remains outstanding, and PR #229 remains a draft. Earlier screenshots retain their original revision and date.

已通过 `git rebase --rebase-merges origin/main` 将分支 rebase 到 `main` 的 `8f3ce5e`（v0.5.8），保留已有功能提交和此前手动解决的 DSH 兼容性调整。上游审阅保护、稳定结果工具、运行时归档预检、路由回退与侧栏修复均已纳入。Root 和制品消费者版本为 0.5.8，独立插件依赖图、DSH 0.1.5-rc.1 公开依赖、全新构建顺序及可移植搜索依赖均保留。

中英文文案基线各为 983 项，包括已有设置文案与上游新增的三条后台审查提示。首轮定向测试发现旧基线未涵盖这些提示，核对后更新基线，没有为了通过检查删除产品文案。

首次 CI 源码检查及 Node 20 公开入口已通过，独立安装则发现 npm 为部分间接 peer 选择了新的 DSH 0.1.5-rc.2，与固定 rc.1 的开发依赖冲突。八个插件的 manifest 现以 rc.1 显式声明所需的间接 DSH 开发 peer，公开运行时 peer 范围保持不变；lockfile 只新增显式导入条目，包版本、解析与快照均不变。修正后完整本机验证和全部独立制品检查通过。

冻结安装与更新后的 manifest、lockfile 一致。`pnpm verify` 通过 1,018 项根测试（另 5 项 opt-in 跳过）、35 个插件的构建、类型检查和测试，以及确定性构建与包验证；`pnpm test` 在 177 个文件中通过 1,446 项测试，另 7 项 opt-in 跳过。`pnpm verify:plugins --skip-build` 复用已验证的 Root 构建，通过 35 个独立插件仓库、36 个制品、外部 SDK/Client 消费者、真实 DSH Starter 升级与可选策略启用检查。真实 DSH Headless 验证 39 个工具（含 8 个代表性 Mnemon 工具）、内置模式持久化、重启和停用 Starter；真实 Mnemon 验证隔离空间创建、View 写入、关键词召回和删除。公开包为 48 个文件、1,347,922 字节，12 个 Node 入口、28 个公开类型依赖、命令帮助、publint 与声明检查均通过，changeset 覆盖检查基于 `8f3ce5e` 通过。

日志保留在仓库外的 `../services/logs/rebase-main-20260912-*.log`。本轮验证 rebase 后的自动化行为，没有新增 WebUI 截图；上文记录的浏览器复查仍待完成，PR #229 保持草稿状态。历史截图继续对应各自原有版本和日期。
