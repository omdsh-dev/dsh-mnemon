# 文档中心

**简体中文** | [English](../en/README.md) | [项目首页](../../README.zh-CN.md)

从默认三层工作流开始即可。实现是可组合的，日常使用不要求管理插件。

## 使用记忆系统

| 要完成的事 | 指南 |
|---|---|
| 安装并验证第一条记忆 | [快速开始](./guides/getting-started.md) |
| 了解现有行为与能力边界 | [能力地图](./guides/capabilities.md) |
| 使用 Sidebar、档案与设置 | [UI 指南](./guides/ui-guide.md) |
| 选择长期记忆后端 | [Provider 指南](./guides/memory-providers.md) |
| 备份、恢复或排查故障 | [运维指南](./guides/operations.md) |
| 升级已有安装 | [兼容性与升级](./reference/compatibility.md) |

## 查阅具体约定

| 问题 | 参考 |
|---|---|
| 哪些配置与范围会生效？ | [配置参考](./reference/configuration.md) |
| 数据保存在哪，怎样共享和归档？ | [存储模型](./reference/storage-model.md) |
| 读取、写入和整理何时发生？ | [生命周期与流程](./reference/workflows.md) |
| 对模型与用户提供哪些工具和命令？ | [接口参考](./reference/interfaces.md) |

## 制作扩展

| 要完成的事 | 开发文档 |
|---|---|
| 理解 Source、Strategy、View 与归属 | [架构设计](./development/architecture.md) |
| 开发 Source、Strategy 或 Provider | [插件开发](./development/extensions.md) |
| 构建、测试与真实 WebUI 截图 | [开发与验证](./development/README.md) |
| 为独立包管理版本和发布 | [发布流程](./development/releasing.md) |

Source 拥有记忆及其操作，Strategy 组合选中的 Source，Core 为执行回合校验出一个不可变 View。默认三层是一种组合，不是 Core 强制的记忆类型。Memory Spaces Provider 是这个 Source 内部的子模块。

[发布历史](./releases/README.md) · [Roadmap](./roadmap.md) · [历史验收证据](../pr-assets/README.md)

当前指南描述当前实现；带日期的截图、旧 benchmark 与 PR 报告只证明其标注的 revision 和环境。内部 Host RPC 不属于对外插件 SDK。
