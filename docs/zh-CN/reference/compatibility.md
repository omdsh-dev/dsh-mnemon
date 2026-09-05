# 兼容性与升级

**简体中文** | [English](../../en/reference/compatibility.md) | [文档中心](../README.md)

Starter 固定经过测试的官方插件组合。下表记录验证范围，不承诺所有上游版本或账号配置都已验证。

| 组件 | 基线 | 已验证的范围 |
|---|---|---|
| DSH | `0.1.2-rc.1` | 正式发布的契约、WebUI 与隔离 Headless 激活 |
| 上一条 DSH 版本线 | `0.1.1-rc.2` | 定向回滚与 Sidebar/Builtin 回归证据；不是默认开发依赖 |
| Node.js | `22.19`、`24` | 分别用于源码 CI 与打包制品 CI；开发要求 `^22.19.0 || >=24.0.0` |
| Node.js 20 | 仅公开包入口导入 | 不代表 DSH Host 能在 Node 20 运行 |
| Mnemon Native CLI | `0.2.5` | 显式启用的真实 CLI 与临时数据测试；CLI 需要另外安装 |
| 三方 Provider | 适配契约与夹具 | 不代表真实云账号一致性或上游服务可用性已验证 |

参见[宿主兼容证据](../../pr-assets/dsh-rc1-compat/README.md)、[升级证据](../../pr-assets/main-rebase-20260904/README.md)与[当前开发检查](../development/README.md)。机制测试通过不是 LLM 质量评测通过；特定 OS 与真实 CLI 检查在没有对应环境时可能跳过。

当前文档录制通过了中英文桌面浏览和增强开关持久化，但发现 390px 设置布局不可用。参见[明确记录的窄屏限制](../../pr-assets/documentation-refresh/README.md)；旧版弹窗响应式证据不代表当前 Host 所有界面均已通过。

## 升级默认安装

1. 导出 Mnemon Pack；需要保留 Provider 连接时，按[运维指南](../guides/operations.md#备份与恢复)保护额外备份。
2. 在每个使用它的 DSH Profile 中升级 `dsh-mnemon`。Starter 安装精确的插件版本；不要单独更新其子包后，就假定混合组合已经验证。
3. 安装新包代码后重启 DSH。检查“记忆系统 → 状态”，再读取一条已有 Runtime、档案及已激活记忆体。
4. 写入前确认存储范围。切换范围只是选择另一份数据权威，不会迁移数据。

v0.5 保留默认 v0.4 的存储、配置与 Sidebar 工作流。可选的 `builtin` 使用同一组 Source 页面，旧 `buildin` 拼写会规范化。三个记忆增强默认关闭；本版没有 View 页或通用记忆插件管理器。

独立插件作者使用声明的 peer 范围与公开出口；旧的私有控制器导入不属于受支持的升级表面。自定义组合需要独立于 Starter 验证，参见[插件开发](../development/extensions.md)与[v0.5.0 发布边界](../releases/v0.5.0.md)。
