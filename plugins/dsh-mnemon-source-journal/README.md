# Activity journal

`captureJobResults` optionally consumes the public workspace activity event. A completed job produces one project result and one daily result, deduplicated by Source and event identity. No job implementation or directory is accessed. Automatic turn, feedback and job captures resolve actual Git branch provenance through the same Source preparation as manual records. The page filters by type, inclusive date range, branch and category.

`captureJobResults` 可选订阅公开工作区活动事件。任务完成后生成项目和每日两条成果，按发布 Source 和事件标识去重，不读取任务插件的实现或目录。轮次、反馈和任务结果均通过 Source 自己的准备流程记录真实 Git 分支。页面支持类型、包含边界的日期范围、分支和分类筛选。

Project progress, daily activity and feedback with durable history.

This independently installed Source owns its records, scope, review state and management page. Its public routes return View-pinned evidence. Model suggestions remain pending; explicit management edits are revision-fenced. Archives and edits retain history. Disabling the plugin retains its data.

Install alongside `dsh-mnemon-strategy-workspace` in an explicit DSH profile. Configure `dataDir` to choose a storage root. Run `pnpm verify` for this package.

## 简体中文

项目进展、每日活动与反馈的持久记录。 每个 Source 独立拥有数据、作用域、审核状态与管理页面。模型建议进入待审核队列，人工采纳后才生效；修改检查版本并保留历史。关闭插件不会删除数据。

`captureTurns` explicitly enables completed human-turn excerpts; `captureFeedback` captures text from DSH's public `/feedback` records. Feedback without a text remark remains in DSH's native log and does not create an invented journal quotation. Both use stable session-event references to prevent duplicate capture and exclude private reasoning and injected plugin messages. Source-owned timestamps and truncation markers describe what was captured.

`captureTurns` 显式开启用户轮次完成记录；`captureFeedback` 记录 DSH 公开 `/feedback` 事件中的文字。没有文字说明的反馈保留在 DSH 原生日志中，不生成虚构的日志引文。稳定的会话事件引用防止重复写入，私有推理及注入消息不进入日志，保留时间、来源与截断标记。

`writeReminderTurns` (0–1000, default 0) counts completed human turns without an actual journal write. The count is durable and scoped to workspace and session. Duplicate events, plugin-only turns and subagents do not advance it. Accepted journal writes reset it; a pending suggestion does not. The page shows the current gap. The Journal capture enhancement consumes the Source's public due hint; Workspace only includes that reminder when the same Source has an actual writable action in the current View.

`writeReminderTurns`（0–1000，默认 0）记录连续未写日志的已完成人类轮次，按工作区和会话持久保存。重复事件、纯插件轮次与子代理不会增加计数；实际采纳的日志写入会清零，待审核建议不会。页面可读取当前间隔。日志增强策略仅消费 Source 公开的到期提示，且该 Source 在当前 View 中确实可写时，Workspace 才加入记录提醒。
