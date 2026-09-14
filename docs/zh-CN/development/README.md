# 开发与验证

**简体中文** | [English](../../en/development/README.md) | [文档中心](../README.md)

## 环境与命令

插件的 Node engine 下限为 20；锁定的完整 DSH 开发 Profile 使用已发布的 npm 0.1.5-rc.1 版本，需要 Node `^22.19.0 || >=24.0.0`，建议开发使用 Node 24。Root 及显式配置的 Source/消费者 Client 测试使用该 rc.1 依赖族；`dsh-invariants` 闭合 peer 图，`dsh-client-store` 则提供子 Agent projection 适配器使用的公开 selector 类型。CI 另在 Node 20 冒烟导入公开 Node 入口；源码覆盖工具保留用于明确请求的调查。

DSH 0.1.5 UI primitives 在制品中导入 Markdown/高亮依赖，但其已发布 manifest 将这些包列为开发依赖。Root、三个 Source 与外部消费者显式声明完整依赖族，使独立 Client 测试可执行；Host 制品仍使用 DSH 提供的 UI 模块。测试同步使用公开的异步 Agent 工厂及持久化 `assistant/message` 事件。`tests/legacy-session-repair.spec.ts` 对普通和压缩格式的合成历史日志执行已发布 v0 → v3 迁移，检查显式副本修复、冷启动重读和带时间戳的 stream 回放。审计用例覆盖三个旧 Mnemon summary、兼容 v2 descriptor、packed 占位值展开、null→空字符串 delta name，以及具有已记录 provider ID 的闭合工具链；另验证多调用 provenance、owner 引用拒绝、原件及其他插件保留。`pnpm e2e:serve --legacy-session-replay` 还要求实际 WebUI 的回环续写服务器核对历史 wire call/result ID 与正文，匹配后才返回成功。

pnpm 11 可能在 rc.1 仍处于发布时间隔离窗口时安装这组已审核制品，因此 `minimumReleaseAgeExclude` 逐项列出精确版本。组合测试要求该列表与 lockfile 中的 rc.1 包完全一致，并拒绝 scope 通配符，使后续发布的 `@deepseek-ai` 包仍受隔离策略约束。

使用 DSH Agent/Session API 的插件项目还在 `devDependencies` 中以精确版本声明所需的间接 DSH peer，确保新的预发布版本出现后，独立 npm 安装仍使用已验证的开发依赖族。公开 `peerDependencies` 保留声明的兼容范围；精确版本只用于开发和测试。

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` 包含类型检查、根包确定性构建、独立插件构建、完整测试集、真实隔离 DSH Headless 和包出口/内容验证。独立插件检查在所有公开制品构建完成后分阶段执行。不要用 `pnpm -r verify` 同时清理重建制品和运行读取它们的测试；整个工作区使用 `pnpm verify`。`verify:plugins` 在工作区**外部**，基于 semver 安装的 tarball 重复验证，并测试外部 Source/Strategy/Provider/Client 消费者；还向真实 DSH 仅安装根包 tarball，从 loopback registry 解析全部十六个官方插件，不使用工作区链接或改写 manifest，再单独验证三个随附增强从默认停用到同时启用。外部消费者还通过完整 Strategy 的打包 SDK 编译自己实现的策略贡献。

全新 checkout 中，Root 声明只以自身源码为编译根并跟随导入的契约，不把独立插件实现列为声明入口。`verify` 与 CI 先构建 Root，再按公开依赖顺序构建全部插件，最后进行集成类型检查，使可选 SDK 的首次构建不依赖旧的 `lib/` 文件。

## 仓库归属

```text
src/
  core/       contracts, View compilation, generations, turn leases
  sdk/        installMemory, validation, test fixtures
  host/       DSH lifecycle, settings, tools, RPC, worker coordination
  client/     shared workspace, settings, Source-page SDK
plugins/
  dsh-mnemon-source-runtime/
  dsh-mnemon-source-documents/
  dsh-mnemon-source-memory-spaces/
  dsh-mnemon-strategy-default-three-tier/
  dsh-mnemon-strategy-scoped/         # 随附、默认关闭的选择贡献
  dsh-mnemon-strategy-light-context/  # 随附、默认关闭的投影贡献
  dsh-mnemon-strategy-auto-capture/   # 随附、默认关闭的对话内记录贡献
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

根包拥有 Core/SDK、DSH Host 和默认 Starter，不拥有 Source 存储实现。`plugins/` 下每个目录都是可独立发布的项目。默认发行包按公开 semver 依赖全部十六个官方插件；三个增强包由 Starter 安装但其 Entry 默认停用。Source/Strategy 通过 peer 使用 Core SDK，策略贡献使用其完整 Strategy 的公开 SDK，Provider 使用 Memory Spaces SDK。peer/开发关系会产生包管理器环依赖提示；生产代码导入边界另有独立检查。

不再保留私有工作区包、控制器转发文件、业务 binding 或 compatibility 目录。兼容指用户配置、数据与使用流程，不是延续历史内部符号。

插件 Client 测试需要根包的公开浏览器制品时，先构建根包：

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm --filter dsh-mnemon-source-runtime verify
```

声明的 peer 版本可用后，任意插件可复制到新仓库，运行自己的 `pnpm install && pnpm verify`。未发布开发使用打包制品及本地 registry 验收，不以仓库源码路径代替公开依赖。

## 测试归属与覆盖

| 边界 | 测试 |
|---|---|
| Core/SDK | 不可变 View、预算、Strategy 校验、并发回合、grant、租约、换代、清理与性能 |
| 策略贡献 | 独立槽、组合/顺序、卸载、冲突、只读范围、共享配额与真实 Host 激活 |
| Source | 自己的控制器/存储、修订、快照、JSON 操作、Client 点击与实例隔离 |
| Provider | 驱动、凭据、真实能力与故障响应 |
| Memory Spaces | Provider 子节点生命周期、跨 Provider conformance、合并/路由/召回质量、Native 进程串行化 |
| Host | 默认组合、配置/数据范围、工具、监督流程、RPC 权限、回执与体验 |
| 制品 | 所有公开入口、独立安装/构建/测试、外部组合与浏览器制品 |

远程 Provider 使用可控 HTTP 响应；Native 进程测试使用可控命令 runner，另有可选 Windows 二进制冒烟。额外的 opt-in 测试接受经过官方 checksum 校验的 Native 二进制，创建临时记忆空间，通过 View 写入、召回并删除：

```sh
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run tests/native-integration.spec.ts
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm exec vitest run tests/runtime-capacity-workflow.spec.ts -t 'two same-View Native'
```

该测试不会发现个人数据根或安装二进制。这些检查不等于验证过所有真实远端服务或账号配置。Provider Lab 是需要明确启动的独立集成环境。

Runtime 用例在 View 固定后，通过真实 Host 工具创建并激活两个 Native 空间，归档两条完整检查点并验证待新增内容。路由决策由本地脚本固定，不调用模型 API。

可选的 Flash 压力测试使用四个真实 DSH 会话、委派写入者、独立维护任务和临时 Native 存储，保留默认 10 KiB 上限，验证反复归档后的精确原文、命名空间路由和无会话 Web 管理。通过 `DEEPSEEK_API_KEY` 提供 DeepSeek 凭据，通过 `MNEMON_NATIVE_TEST_CLI` 提供已验证的 CLI，然后运行：

```sh
MNEMON_RUN_FLASH_STRESS=1 MNEMON_FLASH_STRESS_ROUNDS=8 MNEMON_FLASH_STRESS_REPORT=/tmp/mnemon-flash-stress.json pnpm exec vitest run tests/runtime-capacity-flash-stress.spec.ts
```

测试逐一核对出站请求与返回模型均为 `deepseek-v4-flash`，使用非思考模式，始终不选择 Pro。模型提交前的文本变化与存储后的变化分别计数，所有项目事实均为合成数据，临时存储和会话在完成后清理。目标授权范围是硬性断言，主题归类匹配度单独作为模型质量指标报告。设置 `MNEMON_FLASH_STRESS_JSON_PROMPT=1` 可重跑带引号 JSON 输入诊断。普通 CI 默认跳过，需要明确授权使用真实 API。

另一组自动记忆验收在四个并发 DSH 会话中模拟后端、前端、Android 和运维工作。开发提示包含已确定的决策、纠正和临时诊断，由模型自行选择记忆操作。开发任务实际读写临时 JSON 文件，默认生命周期真实执行空闲审阅；新的召回会话无法访问开发会话历史或配置文件。提供相同的凭据和 CLI 环境变量后运行：

```sh
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_WAVES=24 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality-long.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts -t 'four preconfigured'
```

默认每会话 12 轮，扩展工作负载为 24 轮。两者均使用关闭思考的 Flash、guided 召回与写回，以及默认 10,240 字节记忆上限。只将空闲防抖从 30 秒缩短为 5 秒，审阅资格规则不变。测试记录保留事实、临时标记、纠正后的回答、模块归属、禁止写入回合、工具错误和归档。Vitest 成功仅表示实验执行完成：应检查 `finalEvaluation.automatedVerdict`，并逐条审阅过期文档、重复与归属错误，才能判断质量是否验收通过。[2026-09-09 验收报告](../../pr-assets/runtime-memory-quality-flash-20260909/README.zh-CN.md) 同时记录失败发现与通过项。普通 CI 跳过两个真实 API 用例。该模拟不能替代完整应用构建、真人半天工作流或 Windows 验证。

生成的真实运行数据放在仓库外，上述命令已采用这种方式。遵循[证据存放规范](../../pr-assets/README.md)：提交摘要、复现输入与最小样例，完整脱敏数据作为 PR 附件保存，并注明 revision 和 SHA-256。

性能回归对 100 次三 Source View 组合约束 wall/CPU 时间；确定性构建比较所有生成文件 hash。二者不承诺生产网络延迟或 LLM 质量。

默认组合和三插件组合均运行上述性能门槛。
[2026-09-01 策略贡献验证](../../pr-assets/strategy-extensions-20260901/README.md)
记录了共存、独立制品、真实 Headless 激活结果及其边界。

## 真实 WebUI

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

夹具输出临时工作区及 loopback URL，隔离 `DSH_HOME`、`MNEMON_DATA_DIR`、工作区和模型端点。会话选择 **Mnemon E2E**：该测试自有 preset 去除 Shell 依赖，保留 Host 记忆工具。模型固定回复，因此这里只检查 UI/传输，不评价真实模型沉淀质量。Ctrl-C 停止并清理合成测试数据。

`pnpm e2e:serve --review-evidence --strategy-extensions` 添加按 Agent 注册的合成概览工具及固定的父会话 / 审查调用，检查五个完整分块的继承，并在修复前后尝试相同的外部工具读取；见 [Issue #211 验证记录](../../pr-assets/issue-211-20260911/README.zh-CN.md)。`tests/review-evidence-host.spec.ts` 还覆盖真实 DSH native 与 Code Mode 中，在 Provider 的 start Promise 返回前发生的工具执行。

检查无会话 Sidebar、所有一级/二级页面、Runtime 增改删与清空分支、Documents 创建/搜索/读取、Provider 设置与发现、激活、故障态、取消弹窗、存入记忆、布局切换、locale、返回聊天后交互恢复。读写/删除使用临时 Provider 或受控夹具，不能对个人记忆做实验。

验证内嵌 Electron Host 时，使用 `pnpm e2e:serve --electron=/absolute/path/to/electron`（macOS 指向 `Electron.app/Contents/MacOS/Electron`）。单独安装测试用 Electron，并通过 `MNEMON_CLI_PATH` 和 `npm_config_prefix` 指定隔离的 npm 安装。夹具将正式发布的 DSH Web 栈运行在 Electron 主进程内，Host 不设置 `ELECTRON_RUN_AS_NODE`。它为正式 Cordis loader 开放 Node internals，无需重新编译或修改 DSH 包。照常用 Ctrl-C 停止。

另检查 `displayMode` 实时切换：Sidebar 与 Builtin 不得同时挂载，二者使用同一组 Source 页面。Builtin 的全局/工作区/集中工作区/自定义范围读写及任务遵循所属会话，隐藏范围控件，切换会话时清理旧数据与编辑器。验证旧 `buildin` 规范化，以及原生 Sidebar 皮肤和已支持布局插件下的折叠图标。

[2026-09-04 main rebase 验证记录](../../pr-assets/main-rebase-20260904/README.md)列明精确的 v0.4.7/DSH rc.1 revision、registry 与源码覆盖完整测试、独立制品、插件组合重启持久化和真实双入口验证及其限制。

[2026-08-30 npm 回归记录](../../pr-assets/npm-sidebar-cli/README.md#简体中文)保留了旧 Taskboard/SSH 与 CLI 调查。已移除的历史夹具不是当前 checkout 的命令；当前 WebUI 验证使用 `pnpm e2e:serve`。

上一条 DSH 0.1.1-rc.2 版本线对 Bundle 变化的 Client 卸载并不完整；验证该回滚目标并修改 Client 包/locale 注册后应刷新页面。Mnemon 普通设置仍实时生效。区分上游 Profile/传输告警与 Mnemon 故障，不隐藏控制台。

文档归档回归使用 `pnpm e2e:serve --document-archive`：创建并启用临时的精确写入记忆空间，新建档案后从工作台归档。标题包含 `REJECT` 时夹具故意选择无效目标，检查档案仍为 active 且没有新增索引，再改名重试。在 Mnemon E2E 对话的三个回合中依次发送 `archive-tool-222 prepare`、`archive-tool-222 update`、`archive-tool-222`，会驱动真实的新建 → 更新 → 归档工具调用，并断言返回的 lineage。只有模型决策由脚本控制，存储、工具、传输和浏览器均为真实实现。搭配旧 Host 构建时，同一夹具可复现旧的回执序号不匹配错误。

Runtime 写入范围回归使用 `MNEMON_CLI_PATH=/absolute/path/to/mnemon pnpm e2e:serve --runtime-write-scope --strategy-extensions`，并启动全新临时夹具。在 Mnemon E2E 中发送 `archive-scope-250`。脚本模型先保存两条检查点，在已固定的 View 内创建并激活两个真实 Native 空间，再新增一条越限检查点。基线版本会在空间已激活的情况下拒绝新增；修复后的 Host 会把原文归档到两个有权限的目标，再提交新增内容。发送 `archive-scope-250 retry` 可在新回合重试同一份待新增输入。夹具限制子 Agent 调用次数，且必须收到真实 create/update 回执才完成调用。

## 可选 DSH 源码覆盖

默认使用 registry 制品，本次 0.1.5 验证也全部使用已发布包。维护者明确要求调查源码版时，可通过 `DSH_SOURCE_ROOT` 指定独立构建的 Harness checkout，使用 `pnpm dsh:link-source` 链接，结束后用 `pnpm dsh:restore-registry` 恢复原始链接。工具只更改生成的 `node_modules`，不改已发布依赖版本或 tsconfig 源码路径。目标 checkout 必须提供当前依赖族，再按该目标选择适用检查。

历史 0.1.2-alpha.5 的完整测试流程只属于原记录对应的 revision；当前夹具需要 0.1.5 的会话迁移和消息契约，不能将旧流程当成本 checkout 的验证命令。参见[早期 registry/源码记录](../../pr-assets/main-rebase-20260904/README.md)与[当前 0.1.5 验证](../../pr-assets/issue-223-dsh-015/README.zh-CN.md)。

## 发布

官方包采用独立版本，Starter 固定经过验证的组合。Changeset、冻结制品、Registry 验证与失败恢复见[发布流程](./releasing.md)。

## 文档、存储与历史证据

保持中英文页面一致、公开示例可执行。Mermaid 表达归属和流程；真实截图位于 `docs/assets`。不保留空目录占位或历史转发文件。

没有明确迁移方案与测试前，保留持久格式及配置键。存储改动须验证锁、原子 rename、修订、损坏输入和复制数据根上的升级/回退。

v0.3 benchmark 是冻结的历史结果，不是本架构的性能证明。失效的可执行评估框架已移出工作树；[发布记录](../releases/v0.3.0.md) 链接到固定版本历史源码。当前验收入口为上述脚本。
