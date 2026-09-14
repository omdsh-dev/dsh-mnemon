# Notifications Source

A personal inbox, registered attachments and reviewed channel delivery. This package owns its ledger, transport adapters and UI. The Host only supplies authenticated Source operations, navigation and an additive shell slot.

## Use

Install and enable `dsh-mnemon-source-notifications`, then select the Workspace strategy or another strategy supporting the `notifications` role. The inbox and floating bell use the same Source instance. Notices can be searched, marked read/unread, archived, restored and removed after archival. The bell snaps to either window edge and retains its vertical position in the browser; its panel also offers a keyboard-accessible side switch.

```yaml
dataDir: /absolute/memory-directory
captureActivity: true
captureTurns: false
attachmentRoots: []
attachmentUrlOrigins: [https://assets.example.com]
channels:
  - id: team-inbox
    label: Team inbox
    target: configured-room-id
    endpoint: https://bridge.example.com/notifications
    bearerEnv: NOTIFICATION_BRIDGE_TOKEN
```

The current workspace is an allowed attachment root. Additional roots and URL origins are explicit configuration. Attachments accept a local path, an allowed URL, base64, the latest user image in the current native session, or an image attachment ID actually referenced by that session's user. Files are copied into this Source's private content-addressed store, limited to 5 MiB each, ten files and 25 MiB per message. Reads verify the hash and media type. Preview is lazy and supports images, audio, video and plain text; other files can be downloaded. Deleted records retain their attachments for at least 30 days before manual cleanup.

Local notices do not send externally. Preparing a delivery copies attachments and freezes the exact content, mode (`notification` or direct `message`), selected channels, targets and configuration digest. The management page shows the complete plan; model `send-delivery` requires the Host's `external-message` authority and the exact plan. Each draft is claimed durably once before transport starts. A timeout, interruption or uncertain response is never automatically retried. Channel acceptance means request acceptance, not a human read receipt.

## Channel bridge contract

The included adapter sends an HTTP POST with `Content-Type: application/json`, an optional bearer token from the configured environment variable, and `Idempotency-Key: <delivery-id>:<channel-id>`. Redirects are rejected. Any 2xx response acknowledges the request; response bodies and credentials are not stored in the inbox. Each channel receives:

```json
{
  "format": "mnemon-notification/v1",
  "deliveryId": "a-durable-id",
  "target": "configured-room-id",
  "mode": "message",
  "title": "Task complete",
  "content": "The requested check finished.",
  "sessionId": "the-originating-session",
  "attachments": [{"id":"sha256","name":"result.txt","mediaType":"text/plain","bytes":4,"base64":"dGVzdA=="}]
}
```

A bridge may adapt this contract to a chat or notification service. `createNotificationsSource(config, port)` also accepts a typed `ChannelSender` for separately packaged transport integrations. No channel account is connected implicitly, and this package does not depend on private DSH channel globals. The isolated development profile uses loopback HTTP receivers and synthetic recipients.

Sources may publish a completed `mnemon-workspace/activity` fact from `dsh-mnemon-workspace-kit`. Notifications keeps its own deduplicated records; optional turn capture uses the public DSH session event hook. Events confer no execution or external sending authority. Model queries remain scoped to the originating workspace, while the authenticated personal inbox can show activity across workspaces.

## 中文

独立的通知 Source，负责收件箱、内容寻址附件、发送计划、逐渠道回执和浮动通知按钮。Host 仅提供有权限约束的 Source 管理入口、会话导航和通用浮层插槽。通知按钮支持拖动吸附、浏览器位置记忆和未读计数。

收件箱支持搜索、已读/未读筛选、详情、关联会话、归档与恢复。附件可以来自工作区路径、明确配置来源的 URL、base64 或当前原生会话中用户实际提交的图片；每个附件最多 5 MiB，每条消息最多十个附件、合计 25 MiB。预览按需读取并校验内容，支持图片、音频、视频和文本。已删除条目的附件至少保留 30 天，再由管理页面手动清理。

本地通知仅写入收件箱。外部发送先生成包含具体目标、完整内容、附件和配置校验值的计划，再审核发送。可以选择单个、多个或全部已配置渠道，区分通知和直接消息。模型发送还须获得 Host 的 `external-message` 权限。每个草稿只领取一次发送资格；中断或结果不确定时不会自动重发。渠道接收回执不代表收件人已读。

内置通道使用上面的 HTTP 桥接协议，可由独立适配器接入聊天系统；不会隐式连接账户或读取私有 DSH 全局变量。开发环境使用本机回环地址和合成收件目标。其他 Source 通过公共活动事件提供已完成的事实，通知 Source 自行去重和存储，不获得事件发起方的执行权限。

Validation: `pnpm --filter dsh-mnemon-source-notifications verify`.
