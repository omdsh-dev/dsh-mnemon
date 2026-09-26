# 兼容性与升级

**简体中文** | [English](../../en/reference/compatibility.md) | [文档中心](../README.md)

Starter 固定经过测试的官方插件组合。下表记录验证范围，不承诺所有上游版本或账号配置都已验证。

| 组件 | 基线 | 已验证的范围 |
|---|---|---|
| DSH 开发基线 | `0.1.5-rc.1` | 正式发布的契约、WebUI 与隔离 Headless 激活 |
| DSH Client 兼容 | `0.1.5-rc.2`、`0.1.6-alpha.2` | 完整生产公开类型、正常 npm 制品安装、真实 WebUI 回合插件组合／开关／重载与 Sidebar/Builtin 跳转、制品 Headless 持久化及禁用 Root |
| DSH profile 设置 | `0.1.7-alpha.1` | 正常 npm 制品安装；真实 WebUI 激活、核心/UI 连续保存、Strategy 选择、旧设置恢复与完整 Host 重启 |
| DSH Session 消息 | `0.1.5-rc.2`、`0.1.6-alpha.2`、`0.1.7-alpha.1` | 相同 Mnemon 制品完成真实 Runtime/状态工具调用，并在 Session V3/V4 中持久化生产者专属来源；alpha.7 在 Host 重启后恢复对话及 Builtin Runtime 数据 |
| 历史 DSH Headless 证据 | `0.1.2-rc.1` | 较早 revision 在隔离 Headless 中激活并重启；合成会话经副本修复后由 0.1.5 公开加载器完成迁移 |
| 历史 DSH 证据 | `0.1.1-rc.2` | 早期 Sidebar/Builtin 记录保留各自 revision；本次未重跑 |
| Node.js | `22.19`、`24` | 分别用于源码 CI 与打包制品 CI；开发要求 `^22.19.0 || >=24.0.0` |
| Node.js 20 | 仅公开包入口导入 | 不代表 DSH Host 能在 Node 20 运行 |
| Mnemon Native CLI | `0.2.8` | 显式启用的真实 CLI 与临时数据测试；CLI 需要另外安装 |
| 三方 Provider | 适配契约与夹具 | 不代表真实云账号一致性或上游服务可用性已验证 |

开发锁文件仍使用 `0.1.5-rc.1`。“本回合记忆”以稳定 ID 注册到 alpha 的 list 插槽，同时保留 RC 的 chain selector；组件也会在读取或展示活动前检查回合是否已完成。Sidebar 与设置页跟随 DSH 公开的默认／主会话 binding；Builtin 和 Better Sidebar 保留显式所属会话。

当前 Client 依赖公开的 UI Session 服务。Root 的两个 DSH peer 范围均为 `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.1`；官方插件的 peer 与版本均未改动。较旧的 Headless 和 WebUI 记录仅保留为历史证据。回滚旧版 DSH 时，应同时使用之前针对该宿主验证过的 Mnemon 版本。DSH 0.1.7 将动态设置移入 profile Config；Mnemon 将现有设置页接入该写入器，并按下述流程恢复保留的旧偏好。记忆数据和 Provider 格式不变。

参见[DSH 0.1.7 设置验证](../../pr-assets/issue-267-settings-migration/README.zh-CN.md)、[RC/alpha 验证与前后对比截图](../../pr-assets/issue-261-dsh-slots/README.zh-CN.md)、[DSH 0.1.5 验证](../../pr-assets/issue-223-dsh-015/README.zh-CN.md)、[宿主兼容证据](../../pr-assets/dsh-rc1-compat/README.md)、[升级证据](../../pr-assets/main-rebase-20260904/README.md)与[当前开发检查](../development/README.md)。机制测试通过不是 LLM 质量评测通过；特定 OS 与真实 CLI 检查在没有对应环境时可能跳过。

历史 v0.5.2 采集发现 390px 设置布局不可用，[失败证据](../../pr-assets/documentation-refresh/README.md)保留原版本身份。[v0.5.4 浅色采集](../../assets/webui-v0.5.4/README.md)覆盖双语桌面浏览，以及 390 × 844 下的记忆空间导航、创建与版本维护。长卡片名称和部分指标会截断；本次没有复测所有 Host 设置页或真实手机，因此不将早期设置限制标为已解决。

## Desktop profile generation

Desktop 可能删除插件 generation 内的私有 `@deepseek-ai/*` 包，改用宿主自己的框架版本。Mnemon 在导入动态设置 schema 前检查宿主公开的 Volatile API；携带 Cosmokit `1.8.3` 的宿主沿用普通 Config 和 Settings 路径，提供动态 API 的宿主继续使用检查 revision 的 profile 设置。

受影响的 `0.5.13` 安装中，Desktop 的回退分支会将缺少 `createVolatile` 导出的真实错误隐藏为 `Cannot find package 'dsh-mnemon'`。平铺 `mnemon-bundle` 不能修复该导入失败。Starter 保留 group、根停用总开关、独立 Source/Strategy 选择、私有 Provider 子项和已有设置命名空间。在所属 profile 更新 Mnemon 后重启即可；本修复不需要迁移记忆或配置。

参见[原版 Desktop 复现与验收记录](../../pr-assets/issue-274-profile-generation/README.zh-CN.md)。

## DSH 0.1.7 bundle 组件列表

DSH `0.1.7-rc.2` 的“插件 → dsh-mnemon”详情页会把 `cordis:group` / `mnemon-bundle` 内部容器列为“已关闭”的组件。即使 8 个实际组件全部运行，计数也可能显示“共 9 个 · 8 运行中 · 1 已停用”。点击容器开关会返回 `unknown-plugin`，中文界面提示“组件启用失败：找不到该插件”。参见[原始截图](../../pr-assets/sidebar-native-20260926/before-bundle-toggle-error.jpg)与[上游问题 #649](https://github.com/dsh-external/issues/issues/649)。

这是宿主的展示与管理清单不一致：bundle 声明列表包含原生 group，但可管理插件清单明确排除了 group。该行的“已关闭”不代表 Mnemon 核心或其子插件已停用，也不能据此判断记忆读写是否正常。

遇到这一现象时：

1. 查看“记忆系统 → 状态”以及实际 Source、Strategy 组件的状态。如果只有内部容器误显示关闭，而所需组件和读写正常，可以继续使用；实际组件报错或读写失败仍需单独排查。
2. 停用或恢复整套组合时，使用顶层 `dsh-mnemon` bundle 开关，或对应 `mnemon` 条目的核心组件开关；不要使用 `cordis:group` 行的开关。
3. 保留已有配置和记忆。此显示问题不需要重置数据，也不需要迁移配置或记忆。

Starter 保留稳定的 group ID 和已有 `mnemon` 配置目标。停用核心会停止其 Source、Strategy 和私有 Provider 子项；重新启用后，各组件恢复各自的独立选择。移除 group 会让仍启用的依赖项等待缺失的核心；将 group 改为匿名条目则可能在 profile 重载后留下旧实例。不要通过删除容器、稳定 ID 或修改分组声明来隐藏这一行。[正式宿主生命周期回归](../development/README.md#测试归属与覆盖)在不修改已安装宿主的前提下，验证管理器持久化、重启及旧版字面值／表达式停用标志。

已在独立环境验证的[上游候选补丁](../../pr-assets/sidebar-native-20260926/upstream-fix.patch)会过滤容器展示并保留实际子插件；它未包含在正式 DSH `0.1.7-rc.2` 或 Mnemon `v0.5.16` 中。本地管理适配器方案需要接管 DSH 全局插件管理服务，把它内置于 Mnemon 会影响 Mnemon 的独立停用，因此未随插件提供。修复进展以 [#649](https://github.com/dsh-external/issues/issues/649) 及后续 DSH 发布说明为准；候选环境的截图不代表正式宿主已修复。

## DSH 0.1.7 设置恢复

DSH `0.1.7-alpha.1` 用基于 Config 的表单替代了 `settings.register()` 和 `settings-file`。Mnemon 提供动态 Config 字段，现有界面操作通过宿主检查 revision 的 profile 写入器持久化；修改传输权限仍需正常重载插件。DSH `0.1.5-rc.2` 和 `0.1.6-alpha.2` 继续沿用原设置路径。

Mnemon 消息使用 Session V3、V4 均接受的生产者专属来源 `dsh-mnemon`。过滤和去重仍识别历史包装，以及 DSH 迁移后的 `plugin:dsh-mnemon` 消息；本改动不会重写已有 Session 文件。

启动时，Mnemon 可将 `<profile home>/settings.yaml.imported` 中保留的备份恢复到可编辑的根 `mnemon` 条目，包括根设置、`mnemon-ui` 对话开关，以及仅属于当前 profile 的精确 `mnemon-view-*` / `mnemon-plugins-*` 命名空间。当前 profile 的显式值优先，包括显式清空的插件选择；已有 Source 和 Strategy 条目保持原样；Strategy 条目使用动态表达式时，会保留原表达式并跳过该条目的旧覆盖值，避免将当前求值固定下来。恢复后会在根 Config 中记录 `legacySettingsImported: true`，备份文件保持不变。

若 Mnemon 启动时原 `settings.yaml` 仍存在，由 DSH 执行导入；完成后再重启一次该 profile，恢复 Mnemon 专属偏好。DSH 未公开导入完成信号，因此 Mnemon 等待新宿主进程，避免并发写入。只读或归属不明确的根条目不会被修改；相关旧设置节损坏时，不做部分导入，也不标记完成。请保留备份，参考启动诊断后再修复；不会猜测自定义根 ID 或其他 profile 的 hash。

回滚 DSH 时，保留 profile patch 和旧设置备份。0.1.7 上后来修改的设置不会自动反向导出到旧设置文件，需要恢复对应备份或在旧宿主重新设置；Runtime、档案、记忆空间与 Provider 数据不受影响。

## 升级默认安装

1. 导出 Mnemon Pack；需要保留 Provider 连接时，按[运维指南](../guides/operations.md#备份与恢复)保护额外备份。
2. 在每个使用它的 DSH Profile 中升级 `dsh-mnemon`。Starter 安装精确的插件版本；不要单独更新其子包后，就假定混合组合已经验证。
3. 安装新包代码后重启 DSH。检查“记忆系统 → 状态”，再读取一条已有 Runtime、档案及已激活记忆空间。
4. 写入前确认存储范围。切换范围只是选择另一份数据权威，不会迁移数据。

v0.5 保留默认 v0.4 的存储、配置与 Sidebar 工作流。可选的 `builtin` 使用同一组 Source 页面，旧 `buildin` 拼写会规范化。三个记忆增强默认关闭；本版没有 View 页或通用记忆插件管理器。

独立插件作者使用声明的 peer 范围与公开出口；旧的私有控制器导入不属于受支持的升级表面。自定义组合需要独立于 Starter 验证，参见[插件开发](../development/extensions.md)与[v0.5.0 发布边界](../releases/v0.5.0.md)。
