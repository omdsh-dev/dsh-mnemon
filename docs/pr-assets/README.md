# Verification evidence

[Documentation](../en/README.md) · [文档中心](../zh-CN/README.md)

These are dated engineering records, not a gallery of current product features. Each report owns its tested revision, setup, results and limits. Do not replace historical screenshots or reinterpret old benchmark scores as evidence for a later implementation.

以下是工程验收记录，不是当前功能图集。每份报告只对应其注明的 revision、环境、结果与限制；不要替换历史截图，也不要将旧 benchmark 成绩用作新实现的证据。

For new evaluations, commit the reusable harness, workload generator, concise bilingual summary, aggregate metrics, reproduction parameters and minimal failure examples. Put expanded workloads, complete answers, memory snapshots and per-wave output in a sanitized archive attached to the PR. Before removing bulk evidence from the working tree, verify the archive download and record its URL, SHA-256, tested revision and file manifest. Keep reviewed acceptance separate from original automated scores. Routine CI outputs can remain CI artifacts; retain acceptance evidence in a downloadable PR attachment.

新的评测在仓库中保留可复用脚本、工作负载生成器、简短双语摘要、汇总指标、复现参数和最小失败样例。展开的输入、全部回答、记忆快照和逐轮输出先脱敏打包，作为 PR 附件保存；移出工作树前验证下载，并记录 URL、SHA-256、实测 revision 和文件清单。人工验收结论与原始自动评分分开记录。常规 CI 输出可作为 CI artifact，作为验收依据的数据另保留可下载的 PR 附件。

| Record / 记录 | Scope / 范围 |
|---|---|
| [DSH RC / alpha compatibility — issue #261](./issue-261-dsh-slots/README.md) / [中文](./issue-261-dsh-slots/README.zh-CN.md) | Published package types, real WebUI before/after, turn-tail peers, session isolation and packed Headless / 正式制品类型、真实 WebUI 前后对比、回合插件组合、会话隔离与制品 Headless |
| [Windows Git probe console — issue #259](./issue-259-windows-git-console/README.md) / [中文](./issue-259-windows-git-console/README.zh-CN.md) | Actual Windows before/after window observation, real WebUI, CLI and plugin composition / 真实 Windows 窗口前后观测、WebUI、CLI 与插件组合验证 |
| [OpenViking exact writes — issue #233](./issue-233-openviking-20260916/README.md) / [中文](./issue-233-openviking-20260916/README.zh-CN.md) | Controlled false-receipt reproduction, exact content writes and published OpenViking storage/search/delete / 受控错误回执复现、精确正文写入与正式 OpenViking 存储/检索/删除 |
| [Runtime archive write authority — issue #250](./issue-250-runtime-write-scope/README.md) / [中文](./issue-250-runtime-write-scope/README.zh-CN.md) | Same-View Native space creation, baseline next-turn recovery, fixed first-turn success and byte-exact CLI readback / 同 View 创建 Native 空间、基线下一回合恢复、修复后首回合成功与 CLI 逐字节核验 |
| [v0.5.8 release](./release-v0.5.8/README.md) / [中文](./release-v0.5.8/README.zh-CN.md) | Versioned package validation, Runtime persistence and real Native CLI / 版本化制品验证、Runtime 持久化与真实 Native CLI |
| [ORCA LINK sidebar — issue #232](./issue-232-orca-sidebar/README.md) | Real skin reproduction, visible/clickable entry, Runtime and Native CLI / 真实皮肤复现、侧栏入口、热记忆与 Native CLI |
| [Existing fixes — issues #225 and #230](./issues-225-230-20260911/README.md) / [中文](./issues-225-230-20260911/README.zh-CN.md) | Fresh strict-migration recovery, real CLI/WebUI and composed-strategy verification / 严格迁移恢复、真实 CLI/WebUI 与组合策略复验 |
| [Idle review tool composition — issue #211](./issue-211-20260911/README.md) / [中文](./issue-211-20260911/README.zh-CN.md) | Inherited overview reuse, own-scope execution guard, real Code Mode, CLI and WebUI / 继承概览复用、作用域执行限制、真实 Code Mode、CLI 与 WebUI |
| [v0.5.7 release](./release-v0.5.7/README.md) / [中文](./release-v0.5.7/README.zh-CN.md) | Versioned package checks and real DSH 0.1.5 archival / 版本化制品验证与真实 DSH 0.1.5 归档 |
| [DSH 0.1.5 compatibility — issue #223](./issue-223-dsh-015/README.md) / [中文](./issue-223-dsh-015/README.zh-CN.md) | HTTP 405, legacy Session copy recovery, real WebUI and restart / HTTP 405、旧会话副本修复、真实 WebUI 与重启 |
| [Documents archive — issue #222](./issue-222-document-archive/README.md) | Host-owned indexing and lineage, compensation, real WebUI and cross-turn tools / Host 索引与回执、补偿清理、真实 WebUI 与跨回合工具 |
| [Built-in centralized workspaces — issue #189](./issue-189-core-workspaces/README.md) / [中文](./issue-189-core-workspaces/README.zh-CN.md) | Core/Host storage scope, Source isolation, real WebUI and restart / 内置存储范围、Source 隔离、真实 WebUI 与重启 |
| [Automatic memory quality — 2026-09-09](./runtime-memory-quality-flash-20260909/README.md) / [中文](./runtime-memory-quality-flash-20260909/README.zh-CN.md) | Four concurrent developer sessions with real Flash; current facts, corrections, clutter and fresh recall / 四会话自动记忆质量验收 |
| [Runtime capacity — 2026-09-09](./runtime-capacity-flash-20260909/README.md) / [中文](./runtime-capacity-flash-20260909/README.zh-CN.md) | Real Flash, exact archival, concurrent and session-free writes / 真实 Flash 归档与并发写入 |
| [Creation-time ordering](./issue-202-created-order/README.md) | Issue #202 Runtime/Documents ordering, real WebUI writes and retained screenshots |
| [Electron npm CLI — issue #201](./issue-201-electron-cli/README.md) | Real Electron and Node Hosts, npm/native CLI paths, memory operations and version/update evidence |
| [Documentation refresh](./documentation-refresh/README.md) | Historical v0.5.2 bilingual media and an explicitly failed 390px resize check |
| [Architecture cleanup](./architecture-cleanup/README.md) | Public package boundaries, UI and independent artifact verification |
| [DSH rc.1 compatibility](./dsh-rc1-compat/README.md) | Published Host, Sidebar and Builtin |
| [Main rebase — 2026-09-04](./main-rebase-20260904/README.md) | v0.4.7 upgrade, v0.5 composition and Registry evidence |
| [Main rebase — 2026-09-03](./main-rebase-20260903/README.md) | Earlier default-Strategy integration baseline |
| [Main rebase — 2026-08-31](./main-rebase-20260831/README.md) | Earlier architecture transition |
| [Strategy extensions](./strategy-extensions-20260901/README.md) | Three additive contributions and independent packages |
| [View experiment](./view-20260901/README.md) | Retired View-tab experiment; not a shipped v0.5 page / 已撤销的 View 页实验 |
| [Sidebar composition](./better-sidebar-153/README.md) | Better Sidebar and Source-page mounting |
| [Builtin regression](./builtin-139/README.md) | Entry spelling, scope and existing data |
| [Session events](./session-events-156/README.md) | Projection lifecycle and retained sessions |
| [Dialog surfaces](./dialog-surfaces/README.md) | Responsive dialogs and theme integration |
| [Sidebar icon](./sidebar-icon/README.md) | Entry icon alignment |
| [npm Sidebar / CLI — 2026-08-30](./npm-sidebar-cli/README.md) | Historical npm control and fault-injection results |

Image-only files also have references from GitHub PR bodies. A missing repository-local link is not sufficient evidence to delete them. Current Light product media is indexed in [the asset directory](../assets/README.md); keep historical paths stable for external readers.

部分独立图片由 GitHub PR 正文引用，不能仅凭仓库内无引用就删除。当前浅色产品素材见[素材目录](../assets/README.md)，历史资源路径保留供外部引用。
