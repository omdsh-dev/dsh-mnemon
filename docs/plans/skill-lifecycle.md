# Reviewed skill lifecycle

Skills use the DSH registry and native tool runtime. The optional Playbooks Source owns candidate bundles, evidence, publication and feedback. Learning owns observed experience. A separate Skill refinement Strategy extension decides when to inspect experience and propose a reusable skill or a revision. The default three-tier composition remains unchanged.

## Acceptance contract

- Inspect existing skills before proposing a change. New candidates and revisions remain inactive until reviewed; publishing a revision must check the exact original version.
- Produce a standard `SKILL.md` with optional scripts, references and tests. Validate names, paths, metadata and referenced resources. Keep each published resource directory tied to its content digest.
- Review and edit candidate files, inspect the version difference, execute explicitly selected checks through DSH's tool pipeline, and retain the actual results. Editing invalidates the previous validation.
- Publish, disable, re-enable and archive skills through the native Provider. Retain history and offer a reviewed restoration of an earlier version.
- Browse the native catalog and manage explicitly configured skill directories. Show provider, scope, enabled state and resource files clearly.
- Separate actual skill loading, execution results, model-reported use and explicit human feedback. Negative feedback remains visible until addressed by a reviewed revision; results flow back to Learning as attributed observations.
- Keep Source state private and communicate through public contracts and optional events. Strategy extensions own guidance and scheduling, not files or processes.
- Use shared Core SDK UI, semantic theme colors, keyboard access and responsive layouts.

## Verification

Use meaningful unit and integration tests for stale reads, scope isolation, proposal/publication boundaries, file traversal, invalidation, native execution and feedback attribution. Verify package and plugin artifacts. In the real DSH WebUI, use Flash to turn a reusable procedure into a skill with a working script, review and validate it, publish it, load it natively, record failure feedback, generate and publish a corrected version, and inspect retained history. Capture each capability, including light/dark and narrow layouts, then update the PR with reproducible evidence.

Completed on September 14: [live acceptance report and 29 screenshots](../skill-lifecycle-validation-20260914.md). The real script lifecycle passed 11 initial and 19 revised subprocess tests, with native failure/success feedback, reviewed replacement, directory management and cancellation evidence. The report distinguishes executed checks from structural review and model reports.

## 简体中文

技能复用 DSH 注册表与原生工具运行时。可选工作方法 Source 拥有候选资源、证据、发布与反馈；经验整理由 Learning Source 管理。独立技能改进策略增强负责判断何时检查经验、提出新技能或修订。默认三层记忆组合保持不变。

### 验收约定

- 提案前检查已有技能。新候选和修订必须审核后才生效，替换时校验原版本。
- 生成标准 `SKILL.md` 及必要脚本、参考资料和测试，校验名称、路径、元数据与引用资源。发布目录绑定内容摘要。
- 支持资源编辑和版本对比，经 DSH 工具管线显式运行检查，保留真实结果；编辑使旧验证失效。
- 通过原生 Provider 发布、停用、重新启用和归档；历史恢复创建新的待审核版本。
- 浏览原生目录、管理明确接入的资源根目录，并展示 Provider、作用域、启用状态和资源。
- 区分真实技能加载、执行结果、模型自述和显式人工反馈。负反馈在审核修订处理前保持可见，结果带归属回流至 Learning。
- Source 私有状态通过公开契约和可选事件协作。策略负责规则与调度，不持有文件或执行进程。
- 采用 Core SDK 共用界面、语义主题配色、键盘访问与响应式布局。

### 验证结果

2026-09-14 已完成[真实验收与 29 张截图](../skill-lifecycle-validation-20260914.md)。测试覆盖过期读取、作用域隔离、提案与发布边界、路径校验、验证失效、原生执行和反馈归属，完成独立插件与打包制品验证。真实 Flash 在主 WebUI 生成脚本技能，初版 11 项、修订版 19 项子进程测试通过，并完成失败反馈、审核替换、目录管理和取消回流。报告明确区分实际执行、结构审核和模型自述。
