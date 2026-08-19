> 提交 PR 前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [开发和验证指南](../docs/en/development.md)。
> PR 标题和提交信息使用 Conventional Commits（`type(scope): subject`），禁止 emoji。
> 本仓库接受 Bug 修复、兼容性适配、现有能力增强、性能 / 体验优化和维护类 PR。全新能力、Provider、持久化格式或安全边界变更必须先提 Issue 并获得维护者确认。
> 外部贡献者的仅文档类 PR 不直接接受；请先提 Issue 讨论。维护者的发布说明与文档维护不受此限制。

## 摘要（Summary）

<!-- 用一两句话说明改了什么、为什么改，以及用户或系统行为如何变化。 -->

## 关联 Issue / 背景（Related Issue / Context）

<!-- 优先使用 Closes #123 / Fixes #123。没有 Issue 时填写 N/A 并解释为什么可以直接提交。 -->

## 涉及区域（Affected Areas）

<!-- 至少勾选一项。 -->

- [ ] Host 激活 / Headless / bundle
- [ ] Runtime Memory
- [ ] Project Documents
- [ ] Memory Spaces / Providers
- [ ] 子 Agent / Agent 工作流
- [ ] Web UI / 对话交互
- [ ] 设置 / 存储 / 安全
- [ ] CLI / RPC / 命令 / 工具
- [ ] 安装 / 更新 / 发布
- [ ] 测试 / 构建 / 文档
- [ ] 其他（请说明）

## PR 类型（PR Type）

<!-- 至少勾选一项。仅文档类 PR 的限制见文件顶部说明。 -->

- [ ] 面向用户的功能或行为变更
- [ ] Bug 修复
- [ ] 增强 / 优化
- [ ] 兼容性适配
- [ ] 维护 / 重构
- [ ] 测试 / 构建

## 最新代码确认（Latest Codebase Confirmation）

- [ ] 我已基于最新 `main` 分支开发，或在提交前已 rebase / 合并最新 `main`。

同步命令：

<!-- 示例：git fetch origin && git rebase origin/main -->

## AI 编码披露（AI Coding Disclosure）

<!-- 必填。勾选且仅勾选一项；模型和工具字段不得留空。 -->

- [ ] 完全 AI 编码：全部编程改动由 AI 产出，并由贡献者接受和审查。
- [ ] 部分 AI 辅助：AI 帮助编写或修改了部分内容。
- [ ] 未使用 AI 编码辅助。

使用的 AI 模型：

<!-- 使用 AI 时填写具体模型；未使用时填 N/A。 -->

使用的编码 Agent 工具：

<!-- 使用 AI 时填写 Codex、Claude Code、Cursor 等；未使用时填 N/A。 -->

## 仓库规范检查（Repo Rules）

<!-- 本仓库硬性规范，请逐项确认。 -->

- [ ] 未修改 DSH 官方源码，未让 tsconfig 指向 DSH 源码 checkout，仅使用正式的 `@deepseek-ai/*` NPM 契约。
- [ ] Client / Host 边界仍以 `src/shared/contracts.ts` 为准，没有在两侧重复定义 wire DTO。
- [ ] 持久化格式、RPC 权限、路径或凭据处理的变更包含兼容 / 拒绝路径、安全分析和相应测试。
- [ ] 没有提交 token、密钥、私有记忆、未脱敏日志或生成的 `lib/` 文件。
- [ ] 用户可见文案和长期文档已同步维护中文与英文版本，命令、配置键和路径保持一致。
- [ ] 新增和修改的代码、注释、文档、提交信息不含 emoji。

## 兼容性与数据安全（Compatibility and Data Safety）

<!-- 必填。说明对 DSH、Mnemon、Provider、配置、存储格式、升级/回滚和现有数据的影响。没有影响时填 N/A 并说明理由。 -->

## 本地验证（Local Validation）

执行的命令：

```bash
pnpm run verify
```

结果摘要：

<!-- 写明通过、跳过或失败的项目和原因，不要留空。 -->

## 用户可见变更证据（Local Feature Evidence）

<!--
面向用户的功能或行为变更必填。
附截图或短视频，展示：
- 使用的是本 PR / 最新代码
- 功能已启用或配置
- 操作成功并出现可见结果
- 没有泄露凭据、私有记忆或敏感路径
纯内部改动可填 N/A 并解释。
-->

证据：
