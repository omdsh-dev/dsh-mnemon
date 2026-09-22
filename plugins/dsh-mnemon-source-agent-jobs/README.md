# Background jobs Source

An independent project-scoped Source for asynchronous CLI tasks. Install it beside `dsh-mnemon`; select it through a compatible Strategy such as Workspace. Configure each adapter with an absolute executable, an argument array and optional resume arguments. Supported placeholders are `{prompt}`, `{model}`, `{cwd}`, `{session}` and `{attachment}`. Input may use an argument or stdin. Shell parsing is never used.

Approved drafts have a concrete execution plan including the prompt, model, executable identity, arguments, attachments, working directory and timeout. The human page previews and confirms it. Model execution uses the Host's per-call DSH approval and rejects changed plans. Image paths must remain in the current workspace or configured attachment roots; configured URL images are downloaded to private copies before execution.

The input panel copies local images, browser uploads, configured URL downloads or native session images into Source-owned immutable storage. Up to eight raster images are retained (5 MiB each, 20 MiB total). Original image paths must be copied before execution. Byte hashes are checked again before queueing and execution. The user can also select up to eight Source export tracks through the public management directory; their exact content, source, track, revision and capture time are saved as reference context (20,000 characters total). Later source changes do not alter a reviewed job. Imported content remains reference data with its original states, not new execution authority. Raw execution-history import is unavailable; copying a finished job preserves its inputs in a new draft.

Runner statistics show concurrency, queue depth, host load, free memory and scoped job counts. `retentionDays` defaults to 90. The explicit cleanup action removes only older completed jobs and their logs in the current project, preserves running/queued/draft jobs and other projects, and retains unreferenced images for 30 days. Configure `attachmentUrlOrigins` to admit bounded downloads; URL credentials and redirects outside those origins are rejected. No URL is handed unchecked to a CLI adapter.

The Source owns its queue, concurrency limit, logs, cancellation, output limit, timeout and durable outcomes. Copy a finished job to retry, or resume when the adapter returned a `session_id` or `thread_id` and supports resume arguments. Interrupted work is never automatically replayed. Result delivery is attributed to this plugin and does not wake the owner by default. The published `mnemon-jobs/completed` event lets other plugins subscribe without accessing this Source's store.

## 中文

独立的项目级后台任务 Source，通过 Workspace 等兼容 Strategy 使用。适配器配置包括绝对路径程序、参数数组、可选的恢复参数，以及模型和附件能力。支持参数或标准输入，不经过 shell。默认并发为 2，上限 4；单任务最多 1 小时，输出最多 2 MiB。

已采纳的请求需要先展示并确认具体执行计划；模型执行还需要 Host 的 DSH 逐次授权，计划发生变化即拒绝。任务状态、日志、取消和恢复均由本 Source 持久管理。中断不会自动重试。重试复制为新任务，保留原执行历史。结果投递带插件来源，默认不会唤醒会话。

输入面板支持复制项目图片、浏览器上传、配置来源的 URL 图片及原生会话图片，最多 8 张、每张 5 MiB、合计 20 MiB。执行前须保存原路径的副本，排队与执行前再次检查内容哈希。用户还能通过公开管理目录选择最多 8 个 Source 导出范围，保存其完整内容、来源、版本及时间；上下文合计最多 20,000 字符，来源后续变化不会改变任务。快照保留原条目状态，只作为参考数据。执行记录不接受原始导入，复制已完成任务会保留输入并生成新草稿。

负载面板展示并发、队列、主机负载、空闲内存和当前项目计数。`retentionDays` 默认 90 天，清理按钮只删除本项目超过期限的已结束记录及日志，不清理排队、运行或草稿，也不影响其他项目；无引用图片继续保留 30 天。URL 下载须配置 `attachmentUrlOrigins`，遵循来源、重定向及大小限制。

The isolated development profile provides a deterministic local fixture adapter. It validates orchestration, not any third-party model's capabilities or authentication.
