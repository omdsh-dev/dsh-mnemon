# Roadmap

**简体中文** | [English](../en/roadmap.md) | [文档中心](./README.md)

Roadmap 记录当前实现之外的工作，不是已交付能力承诺。优先级以数据安全、可恢复性和可验证性为先。

## 版本边界

- **v0.4：Sidebar 优先。** 保留 v0.3 架构与记忆数据格式。v0.4.0 最初移除了 builtin 展示；当前开发恢复可选 `displayMode: builtin`，只改变入口位置并共用 Sidebar 界面，不维护独立布局。[v0.4.0 发布说明](./releases/v0.4.0.md)仍保留为历史发布记录。
- **v0.5：计划中的完整 view-based 升级。** 在共用工作台基础上独立开发和验证架构升级。这项工作不包含在 v0.4.0 中，发布 v0.4 不代表新架构已就绪。

## P0：可靠性与可恢复调度

- [ ] **持久化后台审查水位**：按 root session 保存活动信号、最近处理 checkpoint、评分版本和运行状态；重启或 resume 后恢复未处理活动。
- [ ] **幂等 checkpoint**：为一次审查输入建立稳定标识，避免超时、重试或重复 hook 产生重复 Document。
- [ ] **退避、熔断和人工重试**：连续失败后有上限地退避，状态页展示原因并允许显式恢复。
- [ ] **确定性敏感信息防线**：在 LLM 准入之外增加秘密/凭据模式检测、大小限制和审计回执。
- [ ] **自动化真实 WebUI E2E**：隔离 DSH_HOME、storageRoot、workspace 和端口，覆盖轻任务、评分审查、取消和失败无半写入。
- [ ] **修正冷引用路径**：所有 storage scope 都写入与实际托管路径一致的可解析引用。

## P1：长期维护与数据运维

- [ ] **动态 Memory Space Provider Catalog**：把 Provider 描述符、连接 schema、凭据脱敏、发现与 Factory 一起注册，使新 Provider 插件无需修改内置 union 或 WebUI。
- [ ] **全路径 Kernel 化与持久回执**：把现有兼容 controller 流逐步收敛到统一 Plan/Execute/Receipt，并为审计、重试和跨重启比较持久化有界回执。
- [ ] **Strategy 制品晋级流水线**：提供 schema/类型检查、golden replay、shadow、canary、签名、版本回退和指标比较，让模型生成策略只能通过受控制品进入 active 拓扑。
- [ ] **跨 session 长期整理**：基于时间和新增 session 数触发独立整理，而不是复用逐 turn 审查。
- [ ] **Mnemon GC / forget 审阅**：生成衰减、冲突、过时内容和孤立关系候选，展示证据后再执行删除。
- [ ] **一致性备份与恢复**：为 registry、多个数据库、Runtime 和 Documents 提供统一快照、校验和恢复演练。
- [ ] **修复与重建工具**：检测损坏 JSON、缺失投影、孤儿 Document、缺失 DB 和 registry/磁盘不一致。
- [ ] **schema migration**：为 Runtime、Documents index 和 Memory Space registry 增加显式升级与回滚策略。
- [ ] **兼容矩阵**：记录并自动测试支持的 DSH、Mnemon CLI、Node 和数据格式组合。
- [ ] **Cordis / DSH 能力契约测试**：围绕服务注入、热重载与 dispose、延迟注册工具建立宿主集成测试；特别验证 Mnemon 经过 schema 校验的一次性结果工具在子 Agent 中保持可达，同时 `toolFilter` 仍隐藏所有未列入白名单的能力，并以 [issue #14](https://github.com/omdsh-dev/dsh-mnemon/issues/14) / [PR #17](https://github.com/omdsh-dev/dsh-mnemon/pull/17) 作为回归场景。
- [ ] **显式宿主能力声明**：由 Cordis / DSH 提供可写性、受信任控制面、目录选择和结构化输出等权威能力，逐步替代插件根据 loopback、服务名或传输位置推断权限的做法。
- [ ] **明确 Documents workspace ownership**：在共享 storage scope 中记录来源工作区或提供可配置隔离策略。

## P2：可观测性、体验与发布工程

- [ ] **后台审查历史**：展示最近评分、checkpoint、等待/运行/失败、worker 回执和产生的变更。
- [ ] **切换到 DSH 通用目录选择器**（等待 [dsh-external/issues#603](https://github.com/dsh-external/issues/issues/603)）：当前自定义存储暂用手动填写 Host 路径，以避开远端 `browse` 部署无法调用 `native` picker 的问题；DSH 暴露插件可复用的 directory-picker 服务后，改用由能力提供方统一选择 native / browse 的流程，并仅在必要时保留手动输入作为兜底。
- [ ] **完整国际化**：覆盖命令、工具卡、Host 错误、兼容默认元数据和确认文案。
- [ ] **多记忆体 E2E**：覆盖自动建空间、跨空间召回、一次迁移分流、多种边、合并和受控 forget。
- [ ] **URL 子路径部署矩阵**：为 `/prefix/` 下的 DSH 外壳、静态资源、插件资源、RPC/API 和 WebSocket 建立真实反代 E2E；dsh-mnemon 客户端继续只通过宿主 `connection` 通信，宿主则需提供统一 base URL，避免根路径资源导致“页面可开、插件请求失败”的半可用状态。
- [ ] **容量与故障注入**：真实触发 USER/MEMORY 边界、Document LRU、revision 冲突、CLI 超时和 Host 中途重启。
- [ ] **文档一致性检查**：相对链接、外链、双语文件镜像、配置键和代码块一致性进入 CI。
- [ ] **发布收口**：稳定版本号、变更日志、升级/卸载/数据保留指南、artifact 校验和最小支持策略。

## 当前明确不在范围内

- 模型生成代码后立即在 Host 内自动执行；当前只提供 manifest、权限封装、replay 与 Kernel 校验原语。
- 把 Cordis isolate 当作不可信插件的安全沙箱；第三方 executor 和 Strategy 仍须来自受信任包。
- Runtime `daily` target；当前只维护 `user` 和 `memory`。
- 没有明确触达语义的主动通知守护进程；Mnemon 仍是按需拉取系统。
- 把内部 RPC 或 `MnemonClient` 宣布为稳定公共 SDK。
- 自动删除来源 Memory Space 数据库；当前 merge 保留来源文件。
