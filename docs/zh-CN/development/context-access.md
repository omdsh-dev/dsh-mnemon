# 结构化上下文访问

默认仍使用 Runtime、Documents、Memory Spaces 三层组合，分别提供主动投影的有界上下文、按需文档访问、命名空间内的记忆服务。可选插件扩展这些访问机制；Core 不维护业务条目类型目录。

| 边界 | 沉淀的通用机制 | 插件继续负责 |
| --- | --- | --- |
| Core 契约 | 访问方式、结果形态、操作影响、资源版本、执行状态、续读和决策记录 | 资源含义和实际读写 |
| `dsh-mnemon/source-sdk` | 范围隔离、版本化记录、候选审核、有界文件和附件、具体计划比较、读取覆盖范围和游标 | 独立存储、业务结构、生命周期和外部适配 |
| `dsh-mnemon/extension-sdk` | 纯策略协议、选择范围交集、读取与操作预算分配 | 业务触发条件、阈值和指引 |
| `dsh-mnemon/client` | 条目编辑、搜索与操作面板、访问说明、资源版本、执行状态、组合依据 | 任务、图谱、技能、同步的专门交互 |
| DSH Host | 身份认证、具体操作授权、原生技能、会话与模型生命周期 | 外部影响所需的确认 |

兼容库保留 DSH 适配和业务事件类型，原有记录、文件及页面工具转为公共 SDK 的兼容导出。Provider 仍属于 Memory Spaces 内部扩展。

## 操作与资源

读取入口可声明 `access: { kinds: ['browse', 'read'], result: 'resources' }`。外部执行可声明 `operation: { effects: ['execute'], execution: 'deferred', requiresReadGrant: true }`，并指定独立的 `authority`。描述不授予权限；Core 继续检查实际能力、开放入口、输入结构、Source 授权、Host 权限和预算。

`management.operations` 单独说明人工管理流程，不注册接口，也不向模型开放操作。同步、技能发布继续使用已有管理流程，人工变更必须声明确认要求。

Runtime 没有检索授权，依赖投影文本和控制器的写入检查。不能把所有写入都变成“先拿检索授权”。提交候选、采纳版本、向外发送、发起执行和观察结果同样具有不同生命周期。

Evidence 的 `reference` 可以标明精确资源标识、版本、路径和媒体类型。`continuation` 只能指向同一 Source 已开放的入口，输入必须通过校验，续读继续消耗原有预算。游标本身不提供访问权限。

公共记录 Source 将游标绑定到本轮 View、范围、快照和查询，按 ID 读取可用 `startCharacter` 继续。`MemoryReadCoverage` 合并精确版本实际返回的字符范围；截断或存在缺口的读取不能解锁修订。候选被采纳前，原条目继续生效。

`assertMemoryOperationPlan` 使用规范化 JSON 比较计划：字段顺序不影响语义，命令、参数、范围、所有者或版本变化会被拒绝。Source 仍负责重新计算计划并持久记录请求；公共工具不承诺跨外部系统的“恰好执行一次”。

异步受理必须返回执行标识和状态。排队、运行不能冒充已完成，失败结果不能报告为成功。非记录类 Source 同样可以使用这些契约。

## Core 不承担业务触发判断

主策略可选择接受 `acceptedSourceCapabilities` 和 `acceptedContributionFormats: ['mnemon-context-policy/v1']`。原有显式角色、槽位协议继续有效。Workspace 使用公共策略协议，不再判断日志、复盘、经验整理和技能改进的具体时机。

`defineMemoryContextPolicy` 为纯贡献添加协议版本，贡献包含可选的 `selection` 和 `decisions`。决策说明目标 Source、是否满足条件、双语原因、所需读取与操作，以及可选权重和指引。Core 拒绝不存在的操作及没有来源决策的记录。独立命名的增强槽位无需修改 Workspace；同一排他槽位的冲突仍会被拒绝。

`composeMemoryContext` 对来源和写入范围取交集，分配操作预算，并记录已纳入、等待证据、未纳入选择、预算受限、来源不可用等状态。Core 等待可选 Source 成功投影后才绑定指引，来源不可用时不会留下要求模型使用它的提示。界面的“已纳入”表示提供了指引，不表示操作已经执行。

## 兼容与验收

这些 SDK 属于下一次 Core minor 发布，已发布的 0.5.x 包尚不包含；发布前使用配套工作区构建。原有三层配置和记录格式保持兼容，独立 Source 可指定自己的 `packageName`。

契约验收位于 `tests/context-contracts.spec.ts`、`tests/source-sdk.spec.ts`、`tests/client-context-access.spec.tsx` 和 `tests/client-collections.spec.tsx`，覆盖独立插件接入、分段读取与修订、具体计划、续读范围、执行回执及公共交互。仓库检查保证 SDK 不访问 Core 注册表和 Host 服务。

已有真实模型验收空间可通过 `scripts/serve-workspace.mjs --reuse --model configured` 启动，保留原有配置、模型设置及数据。独立开发服务使用有界的 32 KiB 请求头上限，容纳多个本地站点积累的 Cookie 与 DSH 批量插件 URL；正式启动和认证规则不变。
