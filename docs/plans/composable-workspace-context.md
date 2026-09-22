# Composable workspace context

## Contract and ownership

Each data authority is an independently installable Source. Sources own persistence, revision checks, proposed changes, read grants, operations and bilingual management pages. Providers remain private children of Memory Spaces. A workspace Strategy selects public Source capabilities and emits one bounded View; its enhancements contribute pure policies in explicitly owned slots. No policy gains filesystem, network, process or cross-session authority through composition.

The original three-tier Starter remains the default. The workspace composition is explicit, and disabling any optional plugin retains its data. Reusable implementation utilities must be published through declared package exports and tested outside this repository; no plugin may import a sibling's implementation.

## Capability and acceptance inventory

| Area | Owner | Acceptance evidence required |
|---|---|---|
| User preferences, global facts, branch-aware context, revisions | Runtime Source; project context Source | Scope and branch isolation; archive/restore; only approved context appears |
| Project/day journals, feedback, timestamps, date search | Journal Source | Durable entries, filtered retrieval, next-turn visibility |
| Personal/work/project/day tasks, priorities, deadlines, history | Tasks Source | Propose/edit/approve, status transitions, due view, project isolation |
| Reusable skills, prompt library, categories, enablement, schedules | Playbooks Source; prompt policy enhancement | Review before activation, bounded discovery, scheduled use, stop and persistence |
| Review proposals, deduplication, repeated signals, archive | Owning Sources; review policy enhancement | Candidates never enter active context; revision-fenced decisions |
| Evidence-based learning, feedback, usage attribution and reviewed revisions | Learning Source; learning cycle enhancement; Core operation observations | Independent human signals, sticky due state, exact evidence windows, explicit negative feedback, unchanged active originals, destination status and atomic batch decisions |
| File name/content search and imported session history | Files and session Sources | Explicit roots, bounded reads, cancellation, malformed input and path rejection |
| Bookmarks, turn navigation, session branching and names | Session Source and DSH adapter | Real session integration, correct selected turn and scoped history |
| Session teams, messages, presence, file reservations | Collaboration Source and DSH adapter | Directed recipients, room membership, wake behavior and conflicts |
| External agent adapters, async jobs, logs, cancellation, attachments | Agent Jobs Source | No shell interpolation; bounded jobs; accurate completion and resumability |
| Independent conversation review and layered constraints | Review Source and review enhancement | Visible conversation only; provenance-preserving feedback; reset and history |
| Notes, files, media and spatial board | Canvas Source | Scope filtering, placement, pan/zoom, registered asset reads and invalid-file display |
| Local and configured channel notifications | Notifications Source and DSH adapter | Unread state, session navigation, explicit send authority and attachment checks |
| Cross-device memory snapshots and conflict resolution | Sync Source and explicit export/import coordination | Three-way merge, project identity, no automatic push, local/remote/both resolution |
| Model metadata, context usage, session filters, responsive layout | DSH public UI integration | Existing model configuration remains authoritative; desktop/mobile screenshots |
| Plugin discovery, compatibility, dependency previews, installation and activation | Host plugin management; shared browser SDK | Actual peer versions, explicit dependency choices, stale-plan rejection, profile-owned install and separately confirmed activation |

## Delivery and verification

1. Create an independent worktree from committed `main`, install its dependencies, and boot a retained DSH profile with an isolated Mnemon binary and data directory.
2. Add Source utilities, plugin packages and the explicit workspace Strategy in reviewable commits. Exercise real Core composition, source isolation, stale revisions, denial and unload/reload.
3. Connect lifecycle and DSH services only through published interfaces. External operations require separate authorization; automated review remains attributed to the reviewer.
4. Build the package graph, run complete repository verification and isolated artifact verification, then exercise meaningful WebUI workflows with synthetic data and retained screenshots.
5. Record actual results and limitations in bilingual documentation. A deterministic local model validates orchestration mechanics, not model accuracy or real third-party service availability.

## Development instance

`scripts/serve-workspace.mjs` accepts `--state-dir`, `--mnemon`, `--port` and `--model fixture|configured`. It copies the selected executable into the independent state directory, isolates `DSH_HOME` and `MNEMON_DATA_DIR`, retains logs and data on shutdown, and supports a DSH restart via `SIGUSR2`. The default fixture model listens on loopback; configured mode uses the caller's existing model environment without copying credentials into files.

Mnemon Native executes the real `mnemon` CLI on demand. It does not require a permanent daemon. Native store operations and WebUI access must both be verified.

## Learning and feedback acceptance

The optional learning composition captures actual human turns, explicit feedback, task/job outcomes and completed independent reviews. Assistant reports retain their attribution and never count as extra human corroboration. A completed review advances only the inspected evidence window; late arrivals remain due. Facts and preferences can be opted into separately, while procedures and replacements require review. Original and candidate versions are checked together at adoption. Transfers to another Source are idempotent; Core reports only bounded operation metadata so the learning Source can track target adoption, archive and replacement without accessing another Source's storage.

The real Flash checkpoint is documented in [the validation report](../pr-assets/learning-feedback-flash-20260914/validation.json). It exercises the published DSH agent loop and native Mnemon; main WebUI interaction and screenshots are a separate acceptance gate.

## 中文补充

默认保持原始三层记忆组合。经验学习 Source 与周期增强为可选组件，分别处理人类轮次、显式反馈、任务与后台作业结果、独立审阅结果；模型自述保留来源，不增加人类独立信号。复盘只推进实际检查的证据窗口，迟到数据仍保留待处理状态。事实与偏好可分别选择自动处理，方法和替换始终经过审核；采纳时同时校验候选与原版本。跨 Source 移交幂等，Core 仅提供有界操作元信息，用于跟踪目标的采纳、归档和替换。

插件管理区分发现、安装和激活，使用实际 peer 版本校验兼容性，并在应用前预览依赖影响。Core SDK 提供统一主题色、页面控件与 Markdown 编辑器。真实 Flash 集成测试与主 WebUI 截图各自记录验收结果，不相互替代。
