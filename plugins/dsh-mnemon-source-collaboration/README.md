# Collaboration

An independent Source for project rooms, session membership, directed messages, presence and expiring file reservations. Install it with the workspace Strategy. Each instance owns its records and revision-fenced management page; no other Source's store is accessed.

Room creators invite or remove sessions, allow open joining, and close rooms while retaining history. Messages require current membership and one to eight other members. Only sender and recipients can read a message or its assets. Delivery uses DSH's public session and attachment APIs with plugin provenance. Sending and waking are explicit actions; model-initiated delivery requires the Host's external-action approval. Per-recipient receipts retain partial failures without automatic retries. Admission is not a completed model response.

The message page supports search, unread filtering, 25-item pagination, receipts, sender archive/restore/delete, previews and downloads. Up to eight files (5 MiB each, 20 MiB combined) are copied from allowed project paths, configured URL origins, browser uploads or native session images. Copies survive changes to the original. Manual cleanup retains unreferenced assets for 30 days.

Members declare existing or future files, service URLs and notes, with owners, descriptions, type/search filters and pagination. File reservations expire after 1–120 minutes. `captureWrites` registers successful native writes. `writeConflictPolicy` is `off`, `warn` (default) or `deny`; the latter rejects conflicting DSH writes before its normal file-version check. These controls do not lock external editors. Leaving, removal, room closure and native agent disposal release file ownership. Public status events update presence and can publish activity notifications.

Configure `dataDir`, `attachmentRoots`, `attachmentUrlOrigins`, `writeConflictPolicy`, `captureWrites` and `notifyPresence`. The server uses published agents, sessionQuery, workspaceRegistry, attachments and filesystem services. `pnpm verify` covers isolation, approval, immutable assets, pagination, membership, reservations, cleanup and the actual Cordis filesystem hook order.

## 简体中文

独立 Source 提供项目协作空间、成员管理、定向消息、在线状态和文件预约。创建者可邀请或移除会话、开放加入、关闭空间；关闭后保留历史。模型只能读取自己发送或收到的消息。发送前检查当前成员关系，投递使用 DSH 公开会话接口并保留插件来源；唤醒需显式选择，模型发起的投递需通过宿主的外部操作审批。逐个收件人的结果单独保留，部分失败不会自动重发。

附件从允许的项目路径、配置的 URL 来源、浏览器上传或原生会话图片复制，最多 8 个，每个 5 MiB、合计 20 MiB；原文件变化不影响副本，手动清理保留 30 天内的无引用文件。只有发送者和收件人能读取消息及附件。消息页支持搜索、未读筛选、每页 25 条、已读、发送者归档与恢复、软删除、附件预览和下载。

成员可声明现有或未来文件、服务地址和备注，按类型、名称筛选。文件预约有效期为 1–120 分钟。公开文件事件可在原生写入成功后自动登记；冲突策略支持不检查、提醒（默认）和阻止。阻止发生在 DSH 原有文件版本检查之前，两者都保留；它不会锁住外部编辑器。退出、移除、关闭空间及原生 agent 释放会清除文件占用。成员状态可发出活动通知。模型修改预约时检查 View 中的记录版本，插件独立持久化。
