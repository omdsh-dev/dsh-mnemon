# 兼容性与升级

**简体中文** | [English](../../en/reference/compatibility.md) | [文档中心](../README.md)

Starter 固定经过测试的官方插件组合。下表记录验证范围，不承诺所有上游版本或账号配置都已验证。

| 组件 | 基线 | 已验证的范围 |
|---|---|---|
| DSH 开发基线 | `0.1.5-rc.1` | 正式发布的契约、WebUI 与隔离 Headless 激活 |
| DSH Client 兼容 | `0.1.5-rc.2`、`0.1.6-alpha.2` | 完整生产公开类型、正常 npm 制品安装、真实 WebUI 回合插件组合／开关／重载与 Sidebar/Builtin 跳转、制品 Headless 持久化及禁用 Root |
| 历史 DSH Headless 证据 | `0.1.2-rc.1` | 较早 revision 在隔离 Headless 中激活并重启；合成会话经副本修复后由 0.1.5 公开加载器完成迁移 |
| 历史 DSH 证据 | `0.1.1-rc.2` | 早期 Sidebar/Builtin 记录保留各自 revision；本次未重跑 |
| Node.js | `22.19`、`24` | 分别用于源码 CI 与打包制品 CI；开发要求 `^22.19.0 || >=24.0.0` |
| Node.js 20 | 仅公开包入口导入 | 不代表 DSH Host 能在 Node 20 运行 |
| Mnemon Native CLI | `0.2.8` | 显式启用的真实 CLI 与临时数据测试；CLI 需要另外安装 |
| 三方 Provider | 适配契约与夹具 | 不代表真实云账号一致性或上游服务可用性已验证 |

开发锁文件仍使用 `0.1.5-rc.1`。“本回合记忆”以稳定 ID 注册到 alpha 的 list 插槽，同时保留 RC 的 chain selector；组件也会在读取或展示活动前检查回合是否已完成。Sidebar 与设置页跟随 DSH 公开的默认／主会话 binding；Builtin 和 Better Sidebar 保留显式所属会话。

当前 Client 依赖公开的 UI Session 服务。Root 的两个 DSH peer 范围均为 `^0.1.5-rc.1 || ^0.1.6-alpha.2`；官方插件的 peer 与版本均未改动。较旧的 Headless 和 WebUI 记录仅保留为历史证据。回滚旧版 DSH 时，应同时使用之前针对该宿主验证过的 Mnemon 版本。此兼容修复无需迁移配置或已存数据。

参见[RC/alpha 验证与前后对比截图](../../pr-assets/issue-261-dsh-slots/README.zh-CN.md)、[DSH 0.1.5 验证](../../pr-assets/issue-223-dsh-015/README.zh-CN.md)、[宿主兼容证据](../../pr-assets/dsh-rc1-compat/README.md)、[升级证据](../../pr-assets/main-rebase-20260904/README.md)与[当前开发检查](../development/README.md)。机制测试通过不是 LLM 质量评测通过；特定 OS 与真实 CLI 检查在没有对应环境时可能跳过。

历史 v0.5.2 采集发现 390px 设置布局不可用，[失败证据](../../pr-assets/documentation-refresh/README.md)保留原版本身份。[v0.5.4 浅色采集](../../assets/webui-v0.5.4/README.md)覆盖双语桌面浏览，以及 390 × 844 下的记忆空间导航、创建与版本维护。长卡片名称和部分指标会截断；本次没有复测所有 Host 设置页或真实手机，因此不将早期设置限制标为已解决。

## 升级默认安装

1. 导出 Mnemon Pack；需要保留 Provider 连接时，按[运维指南](../guides/operations.md#备份与恢复)保护额外备份。
2. 在每个使用它的 DSH Profile 中升级 `dsh-mnemon`。Starter 安装精确的插件版本；不要单独更新其子包后，就假定混合组合已经验证。
3. 安装新包代码后重启 DSH。检查“记忆系统 → 状态”，再读取一条已有 Runtime、档案及已激活记忆空间。
4. 写入前确认存储范围。切换范围只是选择另一份数据权威，不会迁移数据。

v0.5 保留默认 v0.4 的存储、配置与 Sidebar 工作流。可选的 `builtin` 使用同一组 Source 页面，旧 `buildin` 拼写会规范化。三个记忆增强默认关闭；本版没有 View 页或通用记忆插件管理器。

独立插件作者使用声明的 peer 范围与公开出口；旧的私有控制器导入不属于受支持的升级表面。自定义组合需要独立于 Starter 验证，参见[插件开发](../development/extensions.md)与[v0.5.0 发布边界](../releases/v0.5.0.md)。
