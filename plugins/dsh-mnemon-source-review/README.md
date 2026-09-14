# Conversation review Source

An independent Source for session review cycles, global/project/session constraints, reviewer conversations and structured findings. Configure optional provider/model overrides and installation constraints in this plugin. Otherwise it uses the target session's existing model selection through the public DSH LLM service.

The reviewer receives a bounded visible transcript, explicit constraints and its own previous findings. It receives no tools, private reasoning, tool results, injected memory, or other sessions. Its conversation identity and history belong to this Source; it does not create a tool-enabled DSH agent. Findings use `info`, `nit`, `concern` and `blocker`. Results permit at most two durable proposals and one reusable skill; suggestions are not automatically activated.

Admitted human rounds advance a persistent counter once. Due state stays set until `complete-cycle`, even when a model review finishes. Automatic review must be enabled explicitly and runs once per due cycle. Manual questions continue the reviewer conversation. Reset replaces that conversation identity while retaining earlier results. Cancellation and unload drain active requests; failures retain their response for inspection. Result delivery uses this plugin's provenance and does not wake the target session.

## 中文

会话审核 Source 独立保存审核周期、分层约束、审核者上下文和结构化结果。可使用目标会话当前模型，或配置单独的提供方、模型以及实例级约束。

审核输入仅包含有界的用户可见对话、明确配置的约束以及审核者自己的历史发现，不提供工具、私有推理或注入的记忆。审核者上下文保存在本 Source 中，不创建具有工具权限的 DSH Agent。结果分为提示、小问题、需关注和阻塞，最多包含两条长期建议与一项技能建议，均不会自动生效。

用户轮次只累计一次。到期标记需要显式完成，自动审核需单独开启，每个待完成周期只自动运行一次。可以追问，也可以重置审核上下文并保留历史。反馈始终标注本插件来源，不伪装成用户输入。

The management page can explicitly transfer a selected finding to a chosen project-context or playbooks instance. It reads that target's current revision and creates a pending proposal through the target's public management interface. The target owns validation, deduplication and approval. No review worker reads or writes another Source's store.

管理页面可将选定的发现转为指定项目笔记或工作方法实例中的待审核建议。操作先读取目标当前版本，再调用其公开管理接口；校验、去重与采纳仍由目标 Source 负责，审核工作线程不访问其他 Source 的存储。
