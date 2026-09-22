# Conversation Source

This Source owns project-scoped bookmarks and aliases and exposes bounded searches over visible DSH conversation messages and explicitly configured JSONL history directories. It uses the published DSH session-query and agent interfaces. It never edits imported logs.

Only original user messages and visible assistant text are searched. Tool calls/results, reasoning, injected plugin context and replacement summaries are excluded. Malformed imported lines are skipped. Imports require matching project metadata. Searches support relevance, newest/oldest ordering, native/imported origins and neighboring-message reads. One request scans at most 100 DSH sessions and 300 imported files (8 MiB per file); incomplete results are marked.

## Installation and operations

Install `dsh-mnemon-source-sessions` with `dsh-mnemon` and the compatible published DSH services. Use a Strategy supporting `session-history`. Optional configuration: `dataDir`, `historyRoots` (explicit absolute directories), and `rgPath`. An omitted or empty `rgPath` uses the declared platform binary without requiring system ripgrep; explicit paths and commands remain supported. Without history roots, only DSH and this Source's bookmark records are searched.

The Conversations page provides history search, bookmarks, aliases, a live-session filter, creation, message delivery and forks at completed-turn boundaries. Forks preserve the selected prefix and inherit the workspace, preset and model configuration. Human management actions require confirmation and the current Source revision. Session operations are not granted through ordinary memory-write actions. Standard DSH agent tools remain available for authorized model-driven orchestration.

Delivered messages retain `plugin` provenance. Default delivery waits for the target's next run; waking or steering is explicitly selected. Transcript-only search does not misrepresent these injected messages as human requests.

Run `pnpm verify` for type checking, project isolation/import tests and client/server builds.

## 中文

会话资料 Source 独立管理项目书签与别名，通过 DSH 公开接口检索可见对话，也支持管理员明确配置的 JSONL 历史目录。不会修改导入日志。

仅提取原始用户消息及助手可见正文；排除思考、工具调用与结果、插件注入内容和上下文替换摘要。损坏行可跳过，导入记录必须具有匹配的项目目录。支持来源筛选、相关性与时间排序、前后消息阅读及加载中会话筛选。每次最多扫描 100 个 DSH 会话、300 个导入文件，每个导入文件最多 8 MiB；达到边界会标记结果不完整。

可选配置为 `dataDir`、`historyRoots` 和 `rgPath`。`rgPath` 留空或省略时使用声明的平台程序，无需在系统中另装 ripgrep；显式路径和命令仍可使用。未设置历史目录时，不扫描外部应用数据。会话创建、分叉和消息投递通过带确认与版本检查的管理操作执行；已完成轮次才可成为分叉边界，并继承工作目录、预设与模型配置。

投递的消息始终保留插件来源；默认等待目标会话下一次运行，可显式选择唤醒或最近一步接收。常规 DSH 工具继续负责获得授权的模型会话操作。

Ordinary session actions require explicit native session authority. Each request ID records a durable claim before creating, forking, renaming or delivering; interrupted claims must be inspected before a new request is issued. Presets are mounted before session publication, and cold sessions recover their recorded model configuration. The model and preset routes expose native display metadata only.

Bookmarks open an exact Source-owned message reader with neighboring visible text and a native fork action. Old anchors are located before applying output limits; missing anchors fail explicitly. This does not replace the native conversation renderer.

普通会话动作需要明确授权，并在执行前留存请求回执。预设在会话发布前挂载；恢复会话继承自身已记录的模型配置。模型目录仅返回原生展示信息。书签在 Source 自己的阅读区精确定位消息，并提供按完成轮次分叉；不存在的锚点明确报错，不替换宿主的对话渲染器。

An additive native composer slot reads DSH's public `contextPressure` projection. It shows an amber hint at 30% and a red hint at 40%, and hides at lower usage or unknown capacity. It neither changes the native meter nor estimates missing model limits. The isolated fixture has explicit synthetic usage markers solely for validating these thresholds.

输入区的公开扩展插槽读取原生 `contextPressure` 投影：达到 30% 显示黄色提示，达到 40% 显示红色提示，低用量或未知容量时隐藏。不修改原生计量器，也不猜测缺失的模型上限。隔离测试服务的显式合成用量标记仅用于验证阈值。
