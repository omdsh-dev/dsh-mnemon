# dsh-mnemon 文档中心

**简体中文** | [English](../en/README.md) | [项目首页](../../README.zh-CN.md)

这里按“你现在要完成什么”组织文档。第一次使用从快速开始进入；需要理解页面时看 UI 指南；已有 v0.2.x 用户可以直接查看 v0.3.0 发布说明；只有在部署、集成或开发时才需要进入参考文档。

## 新用户路径

1. [能力地图](./capabilities.md)：用 30 秒理解三层记忆、九种 Provider，以及哪些点击会启动独立任务 Agent。
2. [约 55 秒宽屏实机演示](../assets/media/dsh-mnemon-memory-system-demo.mp4)：看带停留的完整上下滑动、Provider 与弹窗操作，以及一次完成的只读 Agent 查询。
3. [快速开始](./getting-started.md)：安装 Mnemon 与插件，选择存储范围，完成第一次验证。
4. [Sidebar 与对话交互指南](./ui-guide.md)：认识状态、运行时、档案、记忆体和对话内入口。
5. [项目介绍](./project-overview.md)：理解三层模型、跨 Agent 共享边界、读写边界与完整流转。

## 按任务查找

| 我想要…… | 文档 |
|---|---|
| 一次看懂当前产品范围与可组合架构 | [能力地图](./capabilities.md) · [架构设计](./architecture.md) |
| 决定一条信息应放在哪一层 | [存储与三层记忆模型](./storage-model.md) |
| 选择、配置或比较记忆体 Provider | [长期记忆 Provider](./memory-providers.md) |
| 让 DSH 与其他 Mnemon-enabled Agent 共享长期记忆 | [项目介绍：跨 Agent 共享边界](./project-overview.md#跨-agent-共享边界) · [配置参考：共享范围](./configuration.md#选择跨-agent-共享范围) |
| 了解每轮注入、召回、沉淀和归档何时发生 | [生命周期与核心流程](./workflows.md) |
| 配置全局 / 工作区 / 自定义目录、入口位置与显示 | [配置参考](./configuration.md) |
| 理解工作区“查看目录”与 Agent“实际生效目录” | [UI 指南：工作区模式](./ui-guide.md#工作区模式查看与执行分离) |
| 检查或更新 Mnemon 与 dsh-mnemon | [运维指南：版本检查与更新](./operations.md#版本检查与更新) |
| 备份、恢复或迁移完整记忆目录 | [运维指南：备份与恢复](./operations.md#备份与恢复) |
| 通过云端域名发布 WebUI | [运维指南：云端 WebUI](./operations.md#cloud-hosted-webui) |
| 排查召回为空、目录未对齐、CLI 或 Provider 问题 | [运维、安全与故障排查](./operations.md#故障排查) |
| 使用模型工具、`/mnemon` 命令或内部 RPC | [接口参考](./interfaces.md) |
| 理解 Host、worker、控制面与数据面 | [架构设计](./architecture.md) |
| 开发 Source、Strategy 或 Memory Spaces Provider 插件 | [记忆扩展开发](./extensions.md) |
| 修改代码、截图、测试或发布 | [开发与验证](./development.md) |
| 升级到当前稳定版本 | [v0.5.2 发布说明](./releases/v0.5.2.md) |
| 查阅上一版 RC 记录 | [v0.5.0-rc.1 范围与升级说明](./releases/v0.5.0-rc.1.md) |
| 查看下一阶段计划 | [Roadmap](./roadmap.md) |

## 核心术语

| 中文 | 英文 / 代码名 | 含义 |
|---|---|---|
| 记忆系统 | Memory System | dsh-mnemon 在 DSH 中的完整入口 |
| 运行时记忆 | Runtime Memory | 每轮注入的 USER / MEMORY 热记忆 |
| 档案 | Project Documents | 受管、可检索、保留完整 Markdown 叙事的项目知识 |
| 记忆体 | Memory Space | 独立、可激活、按需召回、由 Mnemon 或三方 Provider 支撑的长期记忆实例 |
| 跨 Agent 共享 | Cross-agent memory sharing | 多个 Mnemon-enabled Agent 使用同一根和 Store，共享长期记忆而非完整 DSH 上下文 |
| 沉淀 | Remember / Distill | 启动独立任务 Agent 判断、查重与写入 |
| 召回 | Recall | 从已激活记忆体按需取回有界证据 |
| 归档 | Archive | 先建立冷引用，再把不常用档案迁出 active 层 |

## 文档边界

- 用户文档以 Sidebar 优先体验、可选的共用 Builtin 入口和可组合 View 架构为主；旧 `buildin` 偏好会规范化，无需手动清理。
- 架构图表达稳定执行边界，不是实时监控面板；实时数量与版本以“状态”页为准。
- RPC 是 Host 与插件客户端之间的内部协议，不承诺稳定外部 API。
- 当前没有正式固定的 DSH / Mnemon 版本矩阵；升级前应备份并在隔离目录验证。
