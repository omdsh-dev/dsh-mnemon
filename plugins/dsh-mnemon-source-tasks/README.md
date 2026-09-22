# Tasks

The page combines task type, completion state, deadline, daily date and category filters. List and priority-matrix views use the same revision-fenced editor, approval, archive and completion controls. Completed or cancelled tasks are excluded from overdue results; completion records a timestamp.

页面支持类型、完成状态、截止范围、每日日期与分类的组合筛选。列表和重要与紧急矩阵共用版本校验、审核、编辑、归档和完成操作。已完成或已取消任务不计入逾期，完成时保留时间与历史。

Personal, work, project and daily tasks with review and deadlines.

This independently installed Source owns its records, scope, review state and management page. Its public routes return View-pinned evidence. Model suggestions remain pending; explicit management edits are revision-fenced. Archives and edits retain history. Disabling the plugin retains its data.

Install alongside `dsh-mnemon-strategy-workspace` in an explicit DSH profile. Configure `dataDir` to choose a storage root. Run `pnpm verify` for this package.

## 简体中文

个人、工作、项目和每日任务，支持审核与截止日期。 每个 Source 独立拥有数据、作用域、审核状态与管理页面。模型建议进入待审核队列，人工采纳后才生效；修改检查版本并保留历史。关闭插件不会删除数据。
