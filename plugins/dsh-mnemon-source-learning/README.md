# Learning

An optional Source for evidence-backed learning. It counts real human turns, captures explicit feedback and Source-owned outcomes, and keeps review runs, proposals and their provenance in its own store. Install with the Workspace Strategy; the original three-tier default remains unchanged. The optional Learning cycle enhancement decides when in-turn reviews are due. Manual reviews use the selected session's actual model through the published DSH LLM service.

A review inspects a bounded evidence snapshot before submitting at most two memory proposals and one procedure. Replaying a token does not duplicate records. Stable preferences need two independent human observations; assistant reports do not count as independent human confirmation. Candidates stay inactive until approved. Automatic fact and preference adoption are separate opt-in policies; procedures and replacements always require review.

The page supports editing, adoption, rejection, archival, explicit feedback and idempotent transfers to Project notes or Playbooks. Transferring archives the local candidate and tracks the destination record. Reads, model-reported use and explicit helpfulness are separate measurements. Negative feedback requests another review without silently overwriting memory. Capture and adoption switches persist in the Source. Failures leave unreviewed evidence outstanding.

`dataDir` selects storage. `captureFeedback` and `captureOutcomes` default to true; `autoAcceptFacts` and `autoAcceptPreferences` default to false. `evidenceLimit` defaults to 1000 and accepts 100–5000. Evidence referenced by proposals is retained; unreferenced evidence and operation history are bounded. Credentials are redacted on capture and rejected in proposals. Disabled plugins retain data.

Run `pnpm verify` in this package. Validate model behavior through the actual DSH Web UI; the package tests exercise provenance, replay, scope, feedback and receipt boundaries.

## 简体中文

可选的经验整理 Source 独立保存真实用户轮次、明确反馈、任务结果、整理记录与建议证据。与工作区策略组合使用；默认三层记忆不变。经验整理周期增强负责决定何时在回合内整理，手动整理通过 DSH 公共 LLM 服务使用当前会话模型。

每次整理先检查受限证据快照，再提交最多两条记忆建议和一项可复用方法。重复令牌不产生重复记录。稳定偏好需要两条独立人工证据，助手自报结果不会增加人工确认次数。建议默认待审核，事实与偏好自动采纳分别显式开启；方法和替换建议始终需要审核。

页面支持编辑、采纳、拒绝、归档、明确反馈和转入项目笔记或技能库。转存后本地条目归档并关联目标，重试不会重复创建。读取、模型自报使用和人工评价分别记录。负面反馈要求重新审核，保留原记忆。回流与采纳开关持久化，失败时保留未完成证据。

`dataDir` 选择存储目录。`captureFeedback`、`captureOutcomes` 默认开启，`autoAcceptFacts`、`autoAcceptPreferences` 默认关闭。`evidenceLimit` 默认 1000，范围 100–5000；建议引用的证据会保留，未引用证据与操作历史有容量限制。采集时遮蔽凭据，建议不得包含凭据。关闭插件不会删除数据。包内运行 `pnpm verify`，模型行为通过真实 DSH 主 Web UI 验证。
