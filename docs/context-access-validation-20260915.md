# 结构化上下文脚手架验收 · 2026-09-15

本次把复用单位从业务条目类型推进到实际的访问、变更、执行和组合机制。Core 与公共 SDK 提供可校验的契约；Source 保留数据、存储实例和执行器；增强策略保留触发条件与业务指引。默认安装继续使用 Runtime、Documents、Memory Spaces 三层。

实现检查点为 `59f7299`，真实界面验收后的取消提示与人工操作描述修正为 `6f7633d`。分支基于 main `1363ebffaf19c9ab4badf0137f6fe87acacaf989`。下面的截图均来自这次构建的真实 DSH 主 WebUI，不以此前的模型回答或截图替代本轮验收。

## 机制与边界

| 真实区别 | 共享能力 | 仍由插件负责 |
| --- | --- | --- |
| 有界直接投影 | 上下文分配、View 范围与预算 | Runtime 内容和控制器 |
| 检索、浏览及关联探索 | 访问种类、返回形态、同 Source 续读校验 | 文件查询、Provider 图结构和证据 |
| 分段资源访问 | 版本引用、范围覆盖、游标绑定 | 资源格式、完整读取后的修订门槛 |
| 候选与生效版本 | 记录、审核和版本比较 SDK | 领域校验、原生技能发布 |
| 有实际结果的执行 | 计划比较、执行身份及终态契约 | 进程、模型、检查命令和持久执行声明 |
| 会话协作、发送及传输 | 操作影响、权限边界、管理操作说明 | 收件人、资源预约、同步目标与外部 I/O |
| 结果观察与反馈 | 来源可追溯的回执、反馈和决策说明 | 证据门槛、整理规则、采纳与修订政策 |

这些是可组合的机制，不是互斥的插件类别。多个业务 Source 可以共用记录存储，也可以同时具有资源读取、审核与执行能力。通用 Workspace Strategy 不再按业务角色维护分发清单；增强插件通过公开策略契约贡献判断。

能力描述不授予权限。Source 描述的操作必须真实存在；Core 仍检查当前 View、被提供的接口、预算和 Host 授权。人工管理清单也不会把发布、同步或执行入口自动提供给模型。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `pnpm run verify`，`59f7299` | 通过：文档、确定性构建、38 个插件构建与类型检查、集成测试、真实 Headless 启动及包检查 |
| 根测试 | 1,219 通过，7 跳过；98 个文件通过，3 个文件跳过 |
| 插件测试 | 470 通过 |
| `node scripts/verify-plugin-artifacts.mjs --skip-build`，`59f7299` | 38 个独立插件仓库与 39 个发布包通过；没有 workspace 或补救链接 |
| 外部公共 SDK 消费者 | 安装、类型检查、测试、构建通过，包含 Source SDK 的范围读取、游标和计划比较 |
| 真实打包 Starter | 安装与激活通过，三个可选策略插件可共同参与 |
| `6f7633d` 受影响插件 | Jobs 与 Learning 类型检查、构建通过，23 项测试通过 |
| 发布模拟 | Core 进入 0.6.0；依赖 Core 的 Source、Strategy 和支持包 peer 范围同步为 `^0.6.0`；未执行发布 |
| 包检查 | 73 个文件，365,187 字节压缩体积，1,634,955 字节解包体积；13 个 Node 公共入口及 43 个公开类型依赖通过；publint/attw 通过 |

测试包括：不熟悉的第三方 Source 角色通过能力组合；增强策略独立槽位；只读选择和预算；不可用 Source 不留下已纳入指引；跨 Source 续读拒绝；不完整或有间隙的读取不能替换版本；变更后的执行计划拒绝；后台任务受理与成功完成不混淆。

本地运行 Node 25.1.0。[PR CI](https://github.com/omdsh-dev/dsh-mnemon/actions/runs/34894958752) 已在 `999db67713cfe394bec92572147e848380661b8c` 通过：Node 22.19 源码验证、Node 20 公共入口兼容、Node 24 独立发布包验证。

## 真实主 WebUI

环境是独立 worktree、workspace 和数据目录，DSH `0.1.5-rc.1`、Mnemon `0.2.7`，地址端口为 5281。截图使用浏览器原有的 1280 × 720 视口。主侧边栏、原生设置对话框、浅色和跟随系统的深色主题均实际操作。未修改正式部署目录。

| 验收操作 | 观察结果 | 截图 |
| --- | --- | --- |
| 展开项目笔记访问说明 | 按检索、读取和提交审核分组；会话操作与人工发布分开；接口原文折叠 | [01](assets/context-access-20260915/01-source-access-light.png) |
| 查看当前会话组合 | 33 个读取路由、44 个操作、7 个决策；当时 3 项已纳入；显示真实冻结 View | [02](assets/context-access-20260915/02-current-composition.png) |
| 预览默认三层 | 3 个 Source、4 个读取路由、7 个操作；其余能力不参与。未保存，重新加载恢复原组合 | [03](assets/context-access-20260915/03-default-three-tier-preview.png) |
| 预览只读组合 | 写入来源为空后 0 个操作；依赖写入的日志决策被排除。预览不执行操作，未保存 | [04](assets/context-access-20260915/04-read-only-decisions.png) |
| 审阅并启动后台任务 | 显示具体程序、参数、目录、时限；启动后有持久运行身份和实际日志 | [05](assets/context-access-20260915/05-reviewed-execution-plan.png)、[06](assets/context-access-20260915/06-job-running.png) |
| 取消真实子进程 | 重启后保留已取消状态；中性提示；结果回流保留 cancelled | [07](assets/context-access-20260915/07-job-cancelled.png)、[08](assets/context-access-20260915/08-journal-execution-feedback.png) |
| 读取迁移前的技能资源 | 已有版本及脚本资源仍可打开 | [09](assets/context-access-20260915/09-skill-resources.png) |
| 创建并验证两文件候选 | 通过 UI 手工建立夹具；DSH 原生工具真实执行检查，退出码 0，返回字符数和摘要 | [10](assets/context-access-20260915/10-skill-check-output.png) |
| 审核发布候选 | 原生 DSH 技能目录发现 `context-fixture-check`，两个资源可读 | [11](assets/context-access-20260915/11-native-skill-discovery.png) |
| 提交具体使用反馈 | 反馈关联 v1，说明实际输出和改进要求，出现修订入口 | [12](assets/context-access-20260915/12-skill-feedback.png) |
| 文件检索及读取 | 查询返回两个文件位置，可打开真实 README 片段 | [13](assets/context-access-20260915/13-file-search-and-read.png) |
| 按操作机制查找插件 | 搜索“执行”找到具有对应会话或管理能力的插件 | [14](assets/context-access-20260915/14-plugin-mechanism-search.png) |
| 停用并恢复可选插件 | 先预览再应用；启用数 23 → 22 → 23，文件检索原配置保留 | [15](assets/context-access-20260915/15-plugin-change-preview.png)、[16](assets/context-access-20260915/16-plugin-reactivated.png) |
| 反馈改变策略触发 | 新预览 5 / 7 已纳入；经验整理显示轮次、反馈和结果；技能改进显示 1 条待跟进反馈 | [17](assets/context-access-20260915/17-feedback-policy-decisions.png) |
| 人工管理边界与回流 | 整理执行、采纳和反馈有独立说明；检查、发布、取消与反馈带出处回流 | [18](assets/context-access-20260915/18-managed-operation-boundaries.png)、[19](assets/context-access-20260915/19-evidence-feedback.png) |
| 完整服务及原生关系访问 | DSH 插件运行正常，Mnemon 本体连接正常；打开真实实体详情 | [20](assets/context-access-20260915/20-service-and-memory-status.png)、[21](assets/context-access-20260915/21-native-memory-relations.png) |
| 通过 Flash 请求反馈修订 | 180 秒后明确失败，未产生候选、未替换已发布 v1，反馈保持待跟进 | [22](assets/context-access-20260915/22-generation-timeout-retains-version.png) |
| 同步权限 | 同步为人工管理操作，不向模型开放变更；快照审阅与实际发送仍有区别 | [23](assets/context-access-20260915/23-human-managed-transfer.png) |
| 深色主侧边栏全景 | 使用 DSH 原生主题，访问机制、审核边界与导航可见；最终恢复跟随系统 | [24](assets/context-access-20260915/24-memory-sidebar-panorama-dark.png) |

技能夹具由自动化操作管理页面手工编写，不是本轮模型生成的产物，也不表示用户本人已作出确认。它仅计算传入文本的字符数和 SHA-256，不联网、不写项目文件。`hello` 的实际输出为 5 个字符、摘要 `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`。反馈文字明确标注验收用途。

## 本轮模型验收限制

已通过真实 DSH 模型设置页面保存用户授权的 Flash 凭据，使用 `deepseek-official / deepseek-flash`。初次主会话缺少凭据的错误已排除；随后主会话生成长时间没有返回可用内容，已主动停止。较小的独立生成请求同样超时；模型目录请求成功。不能由此判断全局服务故障。

后续最小流式请求在 227 毫秒收到 HTTP 200 和事件流响应头；60 秒内收到 4 条保活消息、56 字节，但生成数据帧、内容字符和推理字符均为 0，也未收到完成标记。请求已超时终止，没有仍待观察的后台请求。这排除了该次请求的凭据拒绝，但不证明模型完成过生成。

技能反馈修订请求通过原生 UI 发起，在 180 秒边界以超时终止，原版本与待跟进反馈保持完整。这验证了失败保护，**本轮尚未取得新一次 Flash 成功生成的证据**；之前的成功会话、历史技能与手工夹具不计入本轮模型生成通过项。

## 验收中修正的问题

- 统一访问说明原先重复展示接口文本。现在先显示本地化的实际机制，接口标识和原文按需展开。
- 日志增强原先可对多个支持 append 的 Source 重复贡献相同指引。它现在只对自身业务来源贡献一次记录决策，通用组合器保持独立。
- 任务取消原先显示红色错误文本。现在使用中性状态说明，并保留取消结果与日志。
- 本地回环域累积 Cookie 加上 DSH 批量脚本 URL 超过 Node 默认请求头限制。隔离开发启动器采用有界的 32 KiB 请求头；认证继续生效，未授权访问仍被拒绝。

接口定义和扩展方式见[结构化上下文访问](zh-CN/development/context-access.md)。此前完整业务流程的记录见[技能生命周期验收](skill-lifecycle-validation-20260914.md)与[结果回流验收](workspace-feedback-validation-20260914.md)，这些历史记录不替代本轮检查。
