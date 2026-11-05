# 官方 DSH rc.1 与新版 master 的 Agent 验收

**简体中文** | [English](./README.md)

验收日期：2026-11-05。截图来自本 PR 构建的包，版本标签仍为 `0.5.40`，运行在两个隔离 Host 和虚构 Lumen 数据上；不代表兼容更新已经发布。[验证记录](./verification.json)。

## 范围与行为

- 官方 npm `@deepseek-ai/dsh@0.2.2-rc.1` 的 tag commit 是 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，仍保留注册表归属、Provider 枚举、嵌套 activation 请求和隐藏独立任务，继续使用原分支。
- 单独构建、未经修改的 master 固定为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。它显示相同版本号，但接口不同：改用 `subagents.rootOf()`、扁平 activation 请求及普通任务根。
- 两个 Host 的测试与 WebUI 验收均使用 Node 24.22.2。源码使用完整 Node 25.6.1 发行版通过全部 10 项构建检查。官方 npm/旧版 CI 目标保留；未发布源码快照单独本地检查，不承诺所有 master 或 alpha。
- 子 Agent 首步前完成守卫安装，模型、推理等级、preset、工作目录、固定记忆权限、结果归属、取消和释放均有回归覆盖。真实 Host 测试还覆盖运行时压缩、档案创建/归档、Provider 选择、元数据维护，以及 spawn/fork、native/PTC 下的 Team 暂停/作用域策略。
- 自定义 Provider 的已解析配置在 Mnemon 启动前、重建后和改名/移除后都能发现。注册名未公开在 `providerName` 中的 Provider，可填写 `subagentProviderNames`；实时注册与隔离检查不变。该配置不选择 Memory Space Provider。

## 实际可见性

master 的任务根保留 `mnemon-task-v1-…` 标识和 `Mnemon · …` 标题，完成后 ACP 可以列出。标准 WebUI 会隐藏 `sessionListMetadata.blank` 为 true 且不是当前项的根会话。本次实测六个任务根均有标题和子任务目录，但没有根对话轮次：**两个实际侧栏都只显示两个用户会话**。工作区按显式成员关系归组，不按 cwd 相同自动归组。缺少列表元数据、使用其他客户端或主动打开时仍可能显示，因此不能保证 master 始终静默。没有人为插入用户轮次来制造截图差异。

两版的已完成 idle review 都可从父会话的子智能体菜单查看，这与独立任务根是两种情况。普通读取、直接检索不启动 Agent，也不创建任务会话。持久任务/运行标识使重开的已完成记录不参与对话自动化。用户直接发送新消息可获得新的记忆轮次；自动消息不能恢复记忆权限，原任务及结果回调保持结束。

| 场景 | 固定 master | 官方 rc.1 |
|---|---|---|
| 普通对话召回与档案检索 | [截图](./master-live-recall.jpg) | [截图](./rc1-live-recall.jpg) |
| 存入记忆：真实 AI 写入回执 | [截图](./master-live-save.jpg) | [截图](./rc1-live-save.jpg) |
| 独立读取实际落库记录 | [截图](./master-stored-memory.jpg) | [截图](./rc1-stored-memory.jpg) |
| Ask Agent：回答与匹配的记忆引用 | [截图](./master-live-ask-agent.jpg) | [截图](./rc1-live-ask-agent.jpg) |
| 真实模型 idle review 完成 | [截图](./master-live-idle-review.jpg) | [截图](./rc1-live-idle-review.jpg) |
| Skills 草案 | [截图](./master-live-skills.jpg) | [截图](./rc1-live-skills.jpg) |
| 回测结果（含 rc.1 失败） | [截图](./master-live-backtest.jpg) | [截图](./rc1-live-backtest-error.jpg) |
| 实际默认侧栏 | [截图](./master-session-list.jpg) | [截图](./rc1-session-list.jpg) |
| 整个 Host 进程重启后的保存记录 | [截图](./master-after-restart-memory.jpg) | [截图](./rc1-after-restart-memory.jpg) |

保留浏览器的正常窗口尺寸。源码 Host 与 npm Host 自身存在上游 UI 差异；截图证明真实行为，不表示布局逐像素相同。

**旧策略的历史探测：**整个进程重启后，master 的 23 条和 rc.1 的 21 条会话记录全部保留，重开/读取没有创建新的任务会话；每个 Host 均保留唯一一条验收记忆。重开 master 已完成的 idle review 并实际调用 `mnemon_remember`，返回任务已结束的守卫错误；所有 Native insights 表中都没有测试标记。最初的 `mnemon_runtime_memory` 探测因工具未暴露而未发起调用，不计作守卫调用。[真实拒绝截图](./master-after-restart-guard.jpg)。该截图早于用户批准的续办方案，不代表现在人工发送新请求时的行为。

## 重启后的人工续办

在已完成任务历史中直接发送人工消息，现在会按当前配置、工作区与 Memory Space 策略获得新的 View，可查询、写入及重新委派，包括归档 Document。新委派以当前持久化/运行时深度为起点允许一层子任务，不放宽自动 worker 的递归限制。单纯查看历史、重启、Agent 自动消息或完成通知均不会恢复记忆权限。原结果回调始终关闭；完成、取消或准备失败后释放本轮权限。

第二组真实模型验收复用两版 Host 已完成的写入子会话。装入最终运行时代码后完整重启，双方各五条会话全部保留。Host 要求先加载父会话才能向冷启动的子会话发消息：rc.1 显示只读提示，固定 master 返回暂时无法投递。先打开父会话再进入子会话即可恢复发送，无须向父会话发新请求。

人工新请求要求先查询原记忆 `CONT-57A`，再新增 `CONT-AFTER-RESTART-88`。Native 数据库只读查询与内容页均确认新记录存在，原记录内容保持不变。续办后父会话没有新的模型步骤，没有新建会话。最终六次模型请求（每版三次）均返回 HTTP 200。

| 证据 | 固定 master | 官方 rc.1 |
|---|---|---|
| 完整进程重启后，在原任务历史中人工续办 | [截图](./master-task-user-continuation.jpg) | [截图](./rc1-task-user-continuation.jpg) |
| 独立读回已存储记录 | [截图](./master-task-continuation-readback.jpg) | [截图](./rc1-task-continuation-readback.jpg) |

真实预演还发现了一个问题：隔离通知前，rc.1 的旧父会话把子会话的新人工写入视为不符合旧请求，随后将其软删除。最终实现只消费 Mnemon 任务的完成通知，保留并发人工输入及原任务等待中的结果；真实 Host 回归与重启后读回共同验证修复。预演中那条记录即使模型报告成功，也不算成功保留的数据。

实际 Host 上的受控模型测试覆盖冷恢复后的自动消息拒绝、根/子任务读写、存储切换、禁写策略、过期回调、取消、新委派/归档、较晚步骤首次人工 steer、旧子任务历史与父会话并发人工输入。自动消息拒绝属于测试证据，没有伪造成真实 UI 对话；独立 review 还验证了两版 Host 的并发工作区隔离。无新标识的历史子任务必须同时具有自身持久化 Mnemon descriptor、首条任务提示与 Host 记录的完成协议，仅凭 origin 不足以识别；缺少这些持久标记的旧隐藏根无法识别为 Mnemon 续办，不在冷恢复续办的保证范围内；保留其既有 Host 分类与行为。

续办 relay 共转发 38 次请求，最终上限为 64，包含早期预演。排查旧父会话行为时曾触及临时 32 次上限；被本地拒绝的尝试不算上游模型故障，也不计作成功。下方原有 53 次能力验收单独保留。凭据和原始会话不进入证据目录。

## 首轮真实模型结果与限制

本地转发记录了 53 次 HTTP 200 模型请求，低于 64 次上限；HTTP 成功包含下文格式不完整的输出，不能等同于用例成功。具体 token 用量见验证记录。

用户授权的 `deepseek-flash`（UI 为 DeepSeek-V4.1-Flash、High）在两个 Host 上均完成对话召回、档案检索、保存、带引用的 Ask Agent、idle review 和技能建议/草案生成。合成写入包含 API 180ms 目标、5/25/100% 灰度、20 分钟观察、0.5% 回滚阈值、48 小时镜像保留；随后 Ask Agent 找回并引用同一条新记忆。

回测执行能力与生成内容质量分开记录。master 的四个基线/草案用例执行均取得评分，草案总分提高，但个别事实标准仍未通过，没有采纳生成技能。官方 rc.1 的四个用例执行中，**一个取得评分，三个失败**，错误为 `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`。既有每用例两次尝试策略留下六个失败执行器会话；六份工具参数均缺最外层结尾 `}`，其中五份还缺必需的 `result.answer`。完成协议、schema、High 推理等级和 16,384 token 上限均保留，没有修补输入或把失败算作成功。

独立审查将保存的六份输入离线交给两版真实 Host 解析器，均得到相同拒绝；对应 translation/SSE/adapter/replay 编译代码一致。这支持“不完整工具输入导致失败，而非兼容分支退化”的判断，**不意味着 rc.1 实模型回测完整通过**。证据边界是 Host 保存的流，并非独立抓取的上游原始 HTTP 流。受控模型兼容测试另行覆盖有效执行、评分、守卫和取消，不等于认证全部模型或第三方 Memory Space Provider 账号。

本地转发服务原样传递模型请求和响应，只保留调用计数、模型与用量元数据。早期四次验收环境请求因 endpoint 配置返回 404，修正为 DeepSeek Anthropic endpoint 后再验收；这四次没有成功模型结果。密钥及原始会话不进入证据目录。

## 复现 Host 检查

使用有权限访问的独立 DSH checkout，固定到上述 commit，按冻结依赖安装并构建，不修改源码。`DSH_SOURCE` 指向该 checkout，`RC_INSTALL` 指向安装精确官方 npm 包的独立目录，`NODE24` 是 Node 24.22.2 可执行文件。在 Mnemon checkout 运行：

```sh
pnpm run verify
DSH_HOST_ROOT="$RC_INSTALL/node_modules/@deepseek-ai/dsh" "$NODE24" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
DSH_HOST_ROOT="$DSH_SOURCE/apps/cli" "$NODE24" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
```

测试解析器按源码 workspace 包名解析，阻止 `NODE_PATH` 意外回退到旧开发包。验收不修改 DSH，也不为公共 CI 增加私有源码拉取要求。上游独立后台任务接口诉求见 [dsh-external/issues#681](https://github.com/dsh-external/issues/issues/681)。
