# Material board / 素材画布

An independent Source for arranging notes, live file references and uploaded media. It works with the workspace Strategy and owns its records, file read policy, asset ledger and WebUI. The Files Source remains responsible for file discovery: the board's search dialog uses that Source's public, scope-bound management client.

The board supports pointer dragging, resizing, pan/zoom, keyboard panning, numeric geometry controls, card lookup, a persistent browser viewport, session/project/all views, archive/restore, and copying IDs, titles, paths and `[material:id]` references. Images, audio, video and text are previewed on the board; other formats can be downloaded. Invalid or removed files show a visible error. Only visible file/media cards are loaded automatically.

File references retain the original path and read its current contents on demand. Uploads create a private content-addressed copy. Notes are durable records with an author marker; model-created notes never overwrite another card or a file. Each Source retains at most 500 active/archived cards. Unreferenced uploaded blobs can be pruned after 30 days, retaining the reference history and recently deleted cards. Each Source has a 256 MiB uploaded-asset quota.

## Configuration

Enable `dsh-mnemon-source-canvas` and select `dsh-mnemon-strategy-workspace`. The Starter leaves this optional Source disabled. Optional settings:

- `dataDir`: overrides the Host's selected storage directory.
- `roots`: additional absolute read directories; the current workspace is included automatically.
- `maxFileBytes`: per-file read/upload bound, default 5 MiB, maximum 32 MiB.
- `openLocalFiles`: default false. Enables an explicit human button to open supported documents/media with the default application **on the service host**, which may be a different computer from the browser. This operation uses argv, never a shell command.

Session view includes the current session, project and global cards. Project view also includes other sessions in the same project. All-materials view is an authenticated human management view. Model routes remain limited to the current operation scope and the card references admitted when composing their View. A newly registered or retargeted card requires a new View. The model can list/read existing cards and add attributed notes; it cannot read an arbitrary filesystem path through this Source. Binary media return metadata to the model and remain previewable in the UI.

Card bodies and file contents never enter automatic context. The Source contributes only a short availability cover. File reads resolve canonical paths each time, reject symlink escapes, credential paths and private configuration directories, and enforce a bounded stable read. Source exports contain card records; they are not an implicit grant to import paths or asset bytes elsewhere.

## 中文

素材画布是独立 Source，负责便签、实时文件引用、上传媒体及其管理界面，与工作区 Strategy 组合。文件检索继续由 Files Source 负责，画布通过其公开且限定范围的管理客户端调用检索。

支持拖动、缩放、调整尺寸、方向键平移、数值位置设置、卡片定位、浏览器视角保存、会话/项目/全部视角、归档与恢复，以及复制 ID、标题、路径和 `[material:id]` 引用。图片、音视频和文本可在卡片中预览，其他格式可下载。文件被删除或格式无效时显示提示。仅进入可见区域的文件/媒体卡片会自动加载。

文件引用保留原路径，按需读取最新内容；上传素材会保留独立副本。便签持久保存并标明人工或模型来源，模型只能新增便签。每个 Source 最多保留 500 张有效或归档卡片；上传素材总配额 256 MiB，未使用的副本可在 30 天后清理，保留历史引用和近期删除卡片所需的附件。

默认配置关闭此 Source，需显式启用并选择工作区策略。`dataDir` 可覆盖 Host 存储目录，`roots` 补充允许读取的绝对目录，当前工作区自动纳入；`maxFileBytes` 默认 5 MiB，最大 32 MiB。`openLocalFiles` 默认关闭，启用后允许人工在**服务主机**的默认应用中打开受支持文档或媒体；服务主机可能不是浏览器所在电脑。

会话视角包含当前会话、项目及全局卡片；项目视角额外包含同项目其他会话；全部视角仅供已认证的人类管理。模型读取同时受到当前操作范围和 View 中已登记卡片的限制，新增或改变引用的卡片需要重新组合 View。模型可读取文本，二进制媒体返回元数据，可在界面预览。画布正文不自动注入上下文。每次文件读取均检查规范路径、符号链接、敏感目录和大小限制。导出仅包含卡片记录，不会自动授权其他位置导入路径或附件。
