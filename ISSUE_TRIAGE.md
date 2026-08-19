# ISSUE_TRIAGE — Issue 分类标准与处理流程

本文件定义 dsh-mnemon 的 Issue 标签体系、分类、补充信息和关闭流程。目标是让每个 Open Issue 可检索、可验证、可认领、可追溯。

## 标签体系

| 标签 | 含义 | 何时使用 |
| --- | --- | --- |
| `bug` | 功能不符合预期、报错、回归或兼容性问题 | 有明确现象、复现和证据 |
| `enhancement` | 新能力或现有能力改进 | 有清楚场景、约束和验收结果 |
| `documentation` | README、docs 或注释缺失、过时、不一致 | 不改变运行时行为 |
| `question` | 使用或设计疑问 | 需要回答“怎么用 / 为什么” |
| `good first issue` | 适合新贡献者 | 范围小、验收明确、不依赖深层安全或存储上下文 |
| `help wanted` | 已确认接受社区实现 | 维护者认可方案且暂无内部排期 |
| `duplicate` | 与已有 Issue 重复 | 现象、根因或目标与现有 Issue 高度重叠 |
| `invalid` | 非本仓库问题、公开安全报告或信息长期不足 | 无法按模板继续分类 |
| `wontfix` | 经讨论不做 | 超出职责、破坏安全边界或收益不足 |

标签使用 GitHub 默认命名。新增长期标签时应同步更新 Issue Forms、自动化和本文档，不创建一次性临时标签。

## 分类流程

新 Issue 按以下顺序处理：

1. **安全检查**：若包含漏洞、token、凭据、私有记忆或敏感日志，立即移除公开内容并引导至 `SECURITY.md`。
2. **模板检查**：确认必填段落存在且非空；Bug 必须包含证据、冒烟测试、代码引用和补丁草案。
3. **查重**：搜索 open/closed Issue 和已合并 PR；重复项标记 `duplicate`，评论原 Issue 后关闭。
4. **定类型**：根据目标标记 `bug`、`enhancement`、`documentation` 或 `question`。
5. **验证当前状态**：以当前 `main` 和最新发布版本复现；已经由其他 PR 或版本解决的 Issue 直接注明 commit / PR / 版本并关闭。
6. **确认范围**：需要修改 DSH 核心或上游 Provider 的问题转交上游；本仓库只保留兼容层或绕过方案的明确任务。
7. **开放认领**：范围清楚且接受外部实现时添加 `help wanted`；适合入门时再添加 `good first issue`。

## 关闭标准

满足任一条件即可关闭，关闭时必须留下可追溯说明：

- **已实现**：改动已进入 `main`，注明 PR / commit；发布后再注明最低修复版本；
- **被取代**：已有更完整或更安全的实现，注明 superseding PR；
- **重复**：链接原 Issue；
- **已回答**：给出结论和权威文档链接；
- **过时**：依赖、接口或设计已经变化；
- **超范围**：需要上游 DSH、Mnemon 或 Provider 修改，说明转交位置；
- **长期缺信息**：作者未补齐模板所需证据，标记 `invalid`。

关闭理由使用 GitHub 的 `completed` 或 `not_planned`，不要无说明关闭。作者补充新证据后可以请求重开。

## PR 关联规则

- 修复 PR 应使用 `Fixes #<n>` 或 `Closes #<n>` 关联已确认 Issue；
- PR Review 必须对照当前 `main`，确认没有被历史提交或更完整方案取代；
- 仅证明旧版本存在问题，不足以证明当前 PR 应合并；
- Issue 在修复进入 `main` 后即可关闭，最低发布版本在 release 后补充。

## 维护者操作速查

```sh
gh issue edit <n> -R omdsh-dev/dsh-mnemon --add-label "bug,good first issue"
gh issue comment <n> -R omdsh-dev/dsh-mnemon --body "说明"
gh api -X PATCH repos/omdsh-dev/dsh-mnemon/issues/<n> \
  -f state=closed -f state_reason=completed

gh issue list -R omdsh-dev/dsh-mnemon --state open \
  --json number,title,labels --jq '.[] | select(.labels|length==0)'
```

## 自动化

- `.github/workflows/issue-template-enforcer.yml`：缺少 Issue Form 必填段落或 Bug 证据时，评论并以 `not_planned` 自动关闭；
- `.github/workflows/issue-dedup.yml`：标题与已有 open Issue 高度相似时，标记疑似重复、附原 Issue 并关闭；
- `.github/workflows/pr-contribution-rules.yml`：校验 PR 标题、模板、AI 披露、本地验证、兼容说明和用户可见证据；
- `.github/workflows/reject-docs-pr.yml`：自动关闭外部贡献者的仅文档 PR；具有仓库写权限的维护者不受该规则限制。

自动化只执行初筛。作者可以通过评论说明差异并请求重开，最终决定由维护者作出。
