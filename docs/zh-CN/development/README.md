# 开发与验证

**简体中文** | [English](../../en/development/README.md) | [文档中心](../README.md)

## 环境与命令

插件的 Node engine 下限为 20；锁定的完整 DSH 开发 Profile 是已发布的 0.2.1-rc.5 候选版；该 Profile 与构建工具组合需要 Node `^22.19.0 || >=24.11.0`。DSH 0.2.2 RC/alpha 验收使用 Node 24.22.2。Root、Source Client 测试和外部制品消费者均使用该依赖族，`dsh-client-store` 提供子 Agent projection 适配器使用的公开 selector 类型。CI 另在 Node 20 冒烟导入公开 Node 入口。DSH 0.2.0-rc.2 同样受支持：`tests/dsh-host-compatibility.spec.ts` 对全部 19 个包的清单执行 DSH 自己的安装前兼容检查，覆盖受支持与不受支持的版本；CI 还会在 Node 22.19.0 上使用已安装的 0.2.0-rc.2、0.2.1-rc.3 和 0.2.1-rc.5 运行根测试。已发布的 0.2.2-rc.1 和独立的 0.2.2-alpha.3 CI 目标使用 Node 24.22.2；这些 Host 要求 Node 24.9.0 或以上。打包 Starter 同时在锁定基线与 RC1 上验收，覆盖安装、保留数据的升级、设置保存与重启、停用 Starter 以及同时启用所有可选策略。开发依赖仍锁定 0.2.1-rc.5，以保留 Node 22 和旧版宿主验证。要自己在另一个安装上运行：

```sh
npm install --global --prefix <目录> @deepseek-ai/dsh@0.2.0-rc.2
DSH_HOST_ROOT=<目录>/lib/node_modules/@deepseek-ai/dsh pnpm run test:installed-dsh
```

此时所有 `@deepseek-ai/*` 导入（包括子路径）都从该安装解析（`scripts/installed-dsh.config.ts`），真实宿主测试通过 `tests/helpers/installed-dsh.ts` 组合它。与 `pnpm run test` 一样，先完成构建。两个版本的差异见[兼容性说明](../reference/compatibility.md#dsh-020-与-021)。只有 DSH 0.2.1 才有的行为，其测试通过该辅助模块的 `dsh021` 在 0.2.0 上跳过，例如 `tests/task-agent-cwd-host.spec.ts`（工作区文件夹已不存在时的任务 Agent）与 `tests/resumed-memory-task-host.spec.ts`（会话恢复已结束的记忆任务）。

DSH 的 UI primitives 在制品中导入 Markdown/高亮依赖，但其已发布 manifest 将这些包列为开发依赖。Root、四个 Source 与外部消费者显式声明完整依赖族，使独立 Client 测试可执行；Host 制品仍使用 DSH 提供的 UI 模块。测试同步使用公开的异步 Agent 工厂及持久化 `assistant/message` 事件。

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` 包含类型检查、根包确定性构建、独立插件构建、完整测试集、真实隔离 DSH Headless 和包出口/内容验证。独立插件检查在所有公开制品构建完成后分阶段执行。不要用 `pnpm -r verify` 同时清理重建制品和运行读取它们的测试；整个工作区使用 `pnpm verify`。`verify:plugins` 在工作区**外部**，基于 semver 安装的 tarball 重复验证，并测试外部 Source/Strategy/Provider/Client 消费者；还向真实 DSH 仅安装根包 tarball，从 loopback registry 解析全部十八个官方插件，不使用工作区链接或改写 manifest，再单独验证三个随附增强从默认停用到同时启用。外部消费者还通过完整 Strategy 的打包 SDK 编译自己实现的策略贡献。

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
  dsh-mnemon-strategy-default-three-tier/  # 分层策略，默认主策略
  dsh-mnemon-strategy-general/        # 随附的另一种主策略
  dsh-mnemon-strategy-scoped/         # 随附、默认关闭的选择贡献
  dsh-mnemon-strategy-light-context/  # 随附、默认关闭的投影贡献
  dsh-mnemon-strategy-auto-capture/   # 随附、默认关闭的对话内记录贡献
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

根包拥有 Core/SDK、DSH Host 和默认 Starter，不拥有 Source 存储实现：Host 复制或统计 Source 的文件时，从该 Source 的 `./contracts` 读取其文件名、锁文件与解析器（见[内置存储范围](./architecture.md#内置存储范围)）。`plugins/` 下每个目录都是可独立发布的项目。默认发行包按公开 semver 依赖全部十八个官方插件。Starter 安装通用策略与三个增强，其 Entry 默认停用；`memoryView.strategyTypeId` 记录由哪个主策略组合 View，各组件开关由 DSH 插件管理器记录。Source/Strategy 通过 peer 使用 Core SDK，策略贡献使用其完整 Strategy 的公开 SDK，Provider 使用 Memory Spaces SDK。peer/开发关系会产生包管理器环依赖提示；生产代码导入边界另有独立检查。

不再保留私有工作区包、控制器转发文件、业务 binding 或 compatibility 目录。兼容指用户配置、数据与使用流程，不是延续历史内部符号。[兼容登记表](./compatibility-register.md)列出为此保留的代码、保留原因，以及每一项可以移除的条件。

较大改动之前写成的设计计划及其状态见 [docs/plans](../../plans/README.md)（英文）。[scripts/README.md](../../../scripts/README.md)（英文）列出每个脚本与夹具，以及它们的输入和环境变量。[Provider Lab](../../../provider-lab/README.md) 在本机回环地址上运行各第三方 Provider；[tests/fixtures/upgrade](../../../tests/fixtures/upgrade/README.md) 保存 `tests/upgrade.spec.ts` 用来升级的拆分前存储数据。

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

工作区身份、Client 平台边界和委派工作区范围测试还会在 Windows 的 Node 22.19 与 24 上运行。它们覆盖真实文件系统错误和 junction 别名，并包含模拟 Windows 对文件后代返回 `ENOENT` 的跨平台回归；该模拟不能替代真实 Windows 运行。

`tests/bundle-activation.spec.mjs` 用正式发布的 DSH Loader 启动临时激活计数器，覆盖 Starter 的全部十九个包。它验证旧版 `mnemon` 配置／停用目标及组件独立选择，再调用正式插件管理器：真实组件和 bundle 开关必须在重载、重启后保持，核心总开关必须停止全部运行中的子项，任何包都不能留下重复实例。两组用例都在锁定的宿主上运行；设置 `MNEMON_BUNDLE_TEST_PROFILE=/absolute/profile` 可改为检查另一份安装。夹具子进程不继承 `pnpm exec` 注入的 `NODE_PATH`：DSH 0.2 通过 Node 的搜索路径（包括 `NODE_PATH`）为插件包选路，继承它会解析到本仓库的真实插件而不是夹具包。夹具创建自己的临时 profile，不修改所提供的安装。它验证生命周期契约；真实 Mnemon 行为仍由制品 Headless 和 WebUI 检查负责。最后它核对 DSH 的配置 schema 收集器只把 Starter 的组件组报告为无法识别的树载体（已知取舍，见[兼容性说明](../reference/compatibility.md#安装后直接启用-starter)），不允许出现其他错误。执行 `node --expose-internals tests/fixtures/bundle-activation.mjs /absolute/profile manager --check-declared-rows` 可额外要求每个声明的 bundle 组件都可由管理器操作；该诊断会在 DSH 0.2.0 已知的原生 group 列表缺陷处失败，见[兼容性说明](../reference/compatibility.md#dsh-020-上的-bundle-组件列表)。

远程 Provider 使用可控 HTTP 响应；Native 进程测试使用可控命令 runner，另有可选 Windows 二进制冒烟。额外的 opt-in 测试接受经过官方 checksum 校验的 Native 二进制，创建临时记忆空间，通过 View 写入、召回并删除：

```sh
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run tests/native-integration.spec.ts
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm exec vitest run tests/runtime-capacity-workflow.spec.ts -t 'two same-View Native'
```

该测试不会发现个人数据根或安装二进制。这些检查不等于验证过所有真实远端服务或账号配置。[Provider Lab](../../../provider-lab/README.md) 是需要明确启动的独立集成环境。

OpenViking 提供显式启用的回环集成测试：`MNEMON_OPENVIKING_TEST_ENDPOINT=http://127.0.0.1:1933 pnpm --filter dsh-mnemon-provider-openviking exec vitest run tests/integration.spec.ts`。只使用临时后端。测试对唯一的中英文合成资料执行创建、精确读回、搜索、浏览和精确删除；普通 CI 跳过该测试。正式发布的 v0.4.20 服务配合本地确定性 embedding 可验证 HTTP、存储和索引契约，不能证明语义模型质量。

Runtime 用例在 View 固定后，通过真实 Host 工具创建并激活两个 Native 空间，归档两条完整检查点并验证待新增内容。路由决策由本地脚本固定，不调用模型 API。

Agent Teams 矩阵只通过包出口加载正式发布的 DSH 包，并随常规测试在锁定的宿主上运行；`MNEMON_TEAM_TEST_PROFILE=/absolute/profile pnpm exec vitest run tests/agent-team-review-host.spec.ts` 可检查同一 DSH/Teams 版本的另一份安装。测试执行真实 fork/spawn、原生/Code Mode 工具、全部三个 Strategy 增强、子代理执行限制、Runtime 提交与父 Team 工具。[Issue #275 记录](../../pr-assets/issue-275-agent-teams/README.zh-CN.md)提供复现 profile、制品 WebUI 夹具与人工验收证据。

可选的 Flash 压力测试使用四个真实 DSH 会话、委派写入者、独立维护任务和临时 Native 存储，保留默认 10 KiB 上限，验证反复归档后的精确原文、命名空间路由和无会话 Web 管理。通过 `DEEPSEEK_API_KEY` 提供 DeepSeek 凭据，通过 `MNEMON_NATIVE_TEST_CLI` 提供已验证的 CLI，然后运行：

```sh
MNEMON_RUN_FLASH_STRESS=1 MNEMON_FLASH_STRESS_ROUNDS=8 MNEMON_FLASH_STRESS_REPORT=/tmp/mnemon-flash-stress.json pnpm exec vitest run tests/runtime-capacity-flash-stress.spec.ts
```

测试逐一核对出站请求与返回模型均为 `deepseek-v4-flash`，使用非思考模式，始终不选择 Pro。模型提交前的文本变化与存储后的变化分别计数，所有项目事实均为合成数据，临时存储和会话在完成后清理。目标授权范围是硬性断言，主题归类匹配度单独作为模型质量指标报告。设置 `MNEMON_FLASH_STRESS_JSON_PROMPT=1` 可重跑带引号 JSON 输入诊断。普通 CI 默认跳过，需要明确授权使用真实 API。

另一组自动记忆验收在四个并发 DSH 会话中模拟后端、前端、Android 和运维工作。开发提示包含已确定的决策、纠正和临时诊断，由模型自行选择记忆操作。开发任务实际读写临时 JSON 文件，默认生命周期真实执行空闲审查；新的召回会话无法访问开发会话历史或配置文件。提供相同的凭据和 CLI 环境变量后运行：

```sh
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts
MNEMON_RUN_FLASH_QUALITY=1 MNEMON_FLASH_QUALITY_WAVES=24 MNEMON_FLASH_QUALITY_REPORT=/tmp/mnemon-flash-quality-long.json pnpm exec vitest run tests/runtime-memory-flash-quality.spec.ts -t 'four preconfigured'
```

默认每会话 12 轮，扩展工作负载为 24 轮。两者均使用关闭思考的 Flash、guided 召回与写回，以及默认 10,240 字节记忆上限。只将空闲防抖从 30 秒缩短为 5 秒，空闲审查的资格规则不变。测试记录保留事实、临时标记、纠正后的回答、模块归属、禁止写入回合、工具错误和归档。Vitest 成功仅表示实验执行完成：应检查 `finalEvaluation.automatedVerdict`，并逐条审阅过期文档、重复与归属错误，才能判断质量是否验收通过。[2026-09-09 验收报告](../../pr-assets/runtime-memory-quality-flash-20260909/README.zh-CN.md) 同时记录失败发现与通过项。普通 CI 跳过两个真实 API 用例。该模拟不能替代完整应用构建、真人半天工作流或 Windows 验证。

生成的真实运行数据放在仓库外，上述命令已采用这种方式。遵循[证据存放规范](../../pr-assets/README.md)：提交摘要、复现输入与最小样例，完整脱敏数据作为 PR 附件保存，并注明 revision 和 SHA-256。

`tests/legacy-session-repair.spec.ts` 对普通和压缩格式的合成历史日志执行已发布 v0 → v3 迁移，检查显式副本修复、冷启动重读和带时间戳的 stream 回放。审计用例覆盖三个旧 Mnemon summary、兼容 v2 descriptor、packed 占位值展开、null→空字符串 delta name，以及具有已记录 provider ID 的闭合工具链；另验证多调用 provenance、owner 引用拒绝、原件及其他插件保留。WebUI 中的续写检查见[夹具选项](#夹具选项)里的 `--legacy-session-replay`。

性能回归对 100 次三 Source View 组合约束 wall/CPU 时间；确定性构建比较所有生成文件 hash。二者不承诺生产网络延迟或 LLM 质量。

`pnpm bench:algorithms` 在临时合成存储中测量 N=1/10/100/1000 的本地查询、存储、压缩与召回扩展性，默认写入 `.cache/algorithm-benchmark.json`；可用 `MNEMON_BENCH_OUTPUT` 指定输出，或用 `MNEMON_BENCH_SIZES=1,10,100` 运行小规模测试。运行时不要并行执行其他测试/构建。[算法审计报告](../../pr-assets/algorithm-performance-20261003/README.zh-CN.md)记录工作负载、前后对比、操作计数、复杂度和外部 Provider 边界。普通 CI 使用确定性的等价性/工作量上界测试，不使用该基准的延迟断言。

默认组合和三插件组合均运行上述性能门槛。
[2026-09-01 策略贡献验证](../../pr-assets/strategy-extensions-20260901/README.md)
记录了共存、独立制品、真实 Headless 激活结果及其边界。

## 真实 WebUI

皮肤作者的接入位置、稳定选择器、作用域、旧类名迁移与验收步骤见[皮肤开发与 Mnemon 适配](./skin-integration.md)。

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

夹具输出临时工作区及 loopback URL，隔离 `DSH_HOME`、`MNEMON_DATA_DIR`、工作区和模型端点，并把 DSH 创建首个工作区所在的“文稿”目录也指向夹具内部。会话选择 **Mnemon E2E**：该测试自有 preset 去除 Shell 依赖，保留 Host 记忆工具。模型固定回复，因此这里只检查 UI/传输，不评价真实模型沉淀质量。Ctrl-C 停止并清理合成测试数据；向输出的 PID 发送 `SIGUSR2` 会在保留数据的情况下重启 WebUI，设置 `MNEMON_E2E_PORT` 可让重启前后保持同一个地址。

检查无会话 Sidebar、所有一级/二级页面、Runtime 增改删与清空分支、Documents 创建/搜索/读取、Provider 设置与发现、激活、故障态、取消弹窗、存入记忆、布局切换、locale、返回聊天后交互恢复。在“插件 → 可组合记忆”页面中，还要检查主策略选择器、各组件开关与组件页面、DSH 组件行及其打开的页面、默认/自定义存储位置，以及备份导入预览。读写/删除使用临时 Provider 或受控夹具，不能对个人记忆做实验。

另检查 `displayMode` 实时切换：Sidebar 与会话标签页（`builtin`）不得同时挂载，二者使用同一组 Source 页面。会话标签页的全局/工作区/集中工作区/自定义范围读写及任务遵循所属会话，隐藏范围控件，切换会话时清理旧数据与编辑器。验证旧 `buildin` 规范化，以及原生 Sidebar 皮肤和已支持布局插件下的折叠图标。

区分上游 Profile/传输告警与 Mnemon 故障，不隐藏控制台。

要在另一个 DSH 版本上启动 WebUI，先用 `npm install -g --prefix <目录> @deepseek-ai/dsh@0.2.0-rc.2` 安装，再设置 `MNEMON_E2E_DSH=<目录>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。同一个变量也让 `node scripts/verify-headless-profile.mjs` 与 `node scripts/verify-sync-git.mjs` 改用该版本；请用 `node` 而不是 `pnpm` 运行，以免继承 `NODE_PATH`。要在该安装上运行根测试，按[环境与命令](#环境与命令)使用 `pnpm run test:installed-dsh`。

### 夹具选项

`--evolution-scroll` 生成十条合成技能建议，其中一条含长详情，用于验证宽屏和窄屏下的独立滚动与选择行为，不调用模型。

`--skills-scroll` 生成 24 个合成技能，其中两个含长文档，用于验证技能标签页的列表和详情滚动。桌面宽度下检查两栏分别响应滚轮、各自到边界后不带动外层滚动，以及切换技能时详情回到顶部；窄屏下检查列表高度受限、文档仍可完整阅读。不调用模型，可与 `--evolution-scroll` 一起使用。

`pnpm e2e:serve` 接受下列选项，分为两类：

- **准备类选项**改动 profile、模型桩或 WebUI 的运行方式：`--strategy-extensions`、`--live-model`、`--log-model-requests`、`--native-directory-picker`、`--plugin`、`--better-sidebar`、`--electron`、`--trusted-host`、`--remote-management`、`--without-mnemon-cli`、`--second-runtime`、`--review-failure`、`--runtime-archive` 与 `--archive-copies`。最后两个还会在回环地址上启动替身服务：一个 Hindsight 服务和一个响应缓慢的嵌入服务。
- **脚本化模型**决定模型在某项检查中做什么：`--document-protection`、`--review-evidence`、`--document-archive`、`--openviking-write`、`--runtime-routing`、`--result-tool-cache`、`--runtime-write-scope`、`--legacy-session-replay`、`--idle-review`、`--review-layers`、`--strict-template`、`--general-strategy`、`--exact-id`、`--save-action`、`--profile-compaction`、`--remember-target`、`--recall-budget` 与 `--docs-demo`。同一时间只运行一个脚本化模型，所以请一次只用一个：同时给出多个时，以 `scripts/serve-e2e.mjs` 中排在最前的为准；`--live-model` 会关闭全部脚本化模型。它们都可以与准备类选项组合。

除了这些替身服务，以及 `--openviking-write` 需要的 OpenViking 协议夹具，存储、工具、传输和浏览器都是真实运行，不使用个人凭据或记忆。每个夹具都以自己的前缀输出各步，前缀见表格。完整步骤以及修复前后的结果见对应记录；每个选项背后的文件见 [scripts/README.md](../../../scripts/README.md)（英文）。

| 选项 | 准备了什么 | Issue | 记录 |
|---|---|---|---|
| `--strategy-extensions` | 打开随附的三个增强：范围组合、轻量上下文与主动记录 | — | [策略贡献验证](../../pr-assets/strategy-extensions-20260901/README.md) |
| `--native-directory-picker` | 使用 DSH 正式发布的原生 Host/UI 目录选择器包，替代默认浏览式夹具；在宿主显示器打开系统目录选择器 | [PR #355](https://github.com/omdsh-dev/dsh-mnemon/pull/355) | — |
| `--live-model` | 改由 DeepSeek API 作答，而不是回环模型桩，脚本化模型随之关闭。密钥读取 `DEEPSEEK_API_KEY`，设置了 `DEEPSEEK_BASE_URL` 时也读取它作为端点，两者都不会保存 | — | — |
| `--log-model-requests` | 每行 `Fixture model request:` 还以 JSON 给出该请求所用的模型、由谁发出（`conversation` 为会话，`title` 为 DSH 的会话标题，`memory task` 为带有 Mnemon 完成协议的子 Agent）、工具数量，以及请求设定时的思考模式与推理强度。不能与替换模型桩的 `--live-model` 同用 | — | [测试工具](../../pr-assets/test-tooling-from-records/README.zh-CN.md) |
| `--docs-demo`（中文）、`--docs-demo=en` | 预置[文档截图集](../../assets/webui-v0.5.32/README.md)使用的虚构项目 Lumen：用户画像与工作记忆、六份项目档案和三个记忆空间；同时为[技能管理图集](../../assets/skills-v0.5.34/README.md)预置项目的技能：分布在四个技能目录中的六个技能、较早的复盘及其证据、测试用例、回测和一个团队技能目录，并开启自进化。先问结账（英文演示为 checkout），再让它记住新的目标（remember）；或者请它写 2.4 的版本说明（release notes），再发送 `/release-notes` 要求按包分组（group them by package），脚本化模型也会完成复盘、草案和回测。加上 `--live-model` 时由真实模型作答；界面变化后应以这种方式重新采集截图集。`Docs demo:` | — | [截图集](../../assets/webui-v0.5.32/README.md) · [技能管理图集](../../assets/skills-v0.5.34/README.md) |
| `--plugin=<包目录>` | 再把一个测试用插件链接进 profile，可重复使用以链接多个 | [#340](https://github.com/omdsh-dev/dsh-mnemon/issues/340) | [Slot 之外的设置](../../pr-assets/issue-340-settings-outside-slots/README.zh-CN.md) |
| `--better-sidebar=<包目录>` | 把一个布局或皮肤包（例如 Better Sidebar 或 ORCA LINK 皮肤）链接进 profile | [#232](https://github.com/omdsh-dev/dsh-mnemon/issues/232) | [ORCA LINK 侧栏](../../pr-assets/issue-232-orca-sidebar/README.md) |
| `--electron=<可执行文件>` | 将正式发布的 DSH Web 栈运行在真实的 Electron 主进程内，Host 不设置 `ELECTRON_RUN_AS_NODE`，也无需重新编译 DSH；macOS 上指向 `Electron.app/Contents/MacOS/Electron`。通过 `npm_config_prefix` 给测试用 Electron 指定隔离的 npm 安装，通过 `MNEMON_CLI_PATH` 指定 CLI | [#201](https://github.com/omdsh-dev/dsh-mnemon/issues/201) | [Electron npm CLI](../../pr-assets/issue-201-electron-cli/README.md) |
| `--trusted-host=<主机:端口>` | 把该授权主机（例如 `memory.test:4331`）加入 DSH 的浏览器信任边界，用于以远程页面身份检查 WebUI。同时把 `MNEMON_E2E_PORT` 设为同一端口，在测试浏览器中把该名称解析到 127.0.0.1（Chrome 可用 `--host-resolver-rules="MAP memory.test 127.0.0.1"` 并加 `--no-proxy-server`），再把打印出的启动 URL 中的回环地址换成该授权主机打开 | — | [插件配置](../../pr-assets/plugin-config-20260927/README.zh-CN.md) |
| `--remote-management` | 设置 `remoteAccess: trusted-host`，因此与 `--trusted-host` 一起使用时，“插件 → 可组合记忆”页面可以保存 | — | [插件配置](../../pr-assets/plugin-config-20260927/README.zh-CN.md) |
| `--without-mnemon-cli` | 把 `cliPath` 指向不存在的文件，即使 PATH 中有 Mnemon CLI，Host 也按未安装处理；请先连接另一个 Provider，例如 [Provider Lab](../../../provider-lab/README.md) 的服务 | — | [可选的 Mnemon CLI](../../pr-assets/optional-mnemon-cli-20260927/README.zh-CN.md) |
| `--document-protection` | 空闲审查等待缩短为 5 秒，审查会尝试覆盖一份已有档案。两轮用户文本合计至少 320 字。`Document protection:` | [PR #199](https://github.com/omdsh-dev/dsh-mnemon/pull/199) | [档案保护](../../pr-assets/pr199-document-protection/README.md) |
| `--review-failure` | 空闲审查等待缩短为 5 秒，每个委派子 Agent（例如审查）都会收到 HTTP 400 `CONTEXT_WINDOW_EXCEEDED`。发送一段超过 150 字符、带“Please remember”的长期决策，再确认一次。`Review fixture:` | [#210](https://github.com/omdsh-dev/dsh-mnemon/issues/210) | [空闲审查失败提示](../../pr-assets/issue-210-review-warning/README.md) |
| `--review-evidence` | 与 `--strategy-extensions` 一起使用：空闲审查等待缩短为 5 秒，加入按 Agent 注册的合成概览工具，以及读取它的脚本化父会话与审查调用。按记录发送两轮。`Review evidence:` | [#211](https://github.com/omdsh-dev/dsh-mnemon/issues/211) | [审查证据](../../pr-assets/issue-211-20260911/README.zh-CN.md) |
| `--document-archive` | 脚本决定归档选择；标题包含 `REJECT` 的档案会得到无效目标。在不同回合中依次发送 `archive-tool-222 prepare`、`archive-tool-222 update` 与 `archive-tool-222`。`Document archive:` | [#222](https://github.com/omdsh-dev/dsh-mnemon/issues/222) | [档案归档](../../pr-assets/issue-222-document-archive/README.md) |
| `--openviking-write` | 面向 OpenViking 的脚本化写入。另外运行 `node scripts/fixtures/openviking-protocol.mjs`，这是一个替身服务，其 `/__fixture` 端点会报告合成的请求和文件；把 OpenViking 配置为 `http://127.0.0.1:19335`，account/user 为 `default`，不设置 API key，然后发送 `openviking-write-233`。替身不能证明真实抽取的效果，后端验收需再对临时的真实服务执行同样流程。`OpenViking write:` | [#233](https://github.com/omdsh-dev/dsh-mnemon/issues/233)、[#353](https://github.com/omdsh-dev/dsh-mnemon/issues/353) | [OpenViking 写入](../../pr-assets/issue-233-openviking-20260916/README.zh-CN.md)、[#353](../../pr-assets/issue-353-openviking-write/README.zh-CN.md) |
| `--runtime-routing` | 工作记忆上限设为 1,600 字节，路由模型返回按分块计数的序号。创建并激活两个 Native 记忆空间，再添加超过上限的工作记忆条目。`Runtime routing:` | [#235](https://github.com/omdsh-dev/dsh-mnemon/issues/235) | [路由兜底](../../pr-assets/issue-235-runtime-routing/README.md) |
| `--result-tool-cache` | 与 `MNEMON_CLI_PATH` 和 `--strategy-extensions` 一起使用：脚本化的写入任务连续写入两次。依次发送 `cache-round-239 first` 与 `cache-round-239 second`。`Result tool cache:` | [#239](https://github.com/omdsh-dev/dsh-mnemon/issues/239) | [固定结果工具](../../pr-assets/issue-239-result-tool/README.md) |
| `--runtime-archive` | 一个记录所接收写入的回环 Hindsight 替身，以及 300 字节的工作记忆上限。在记忆空间页面用夹具输出的地址启用 Hindsight，再添加超过上限的工作记忆条目。`Runtime archive accepted writes:` | [#240](https://github.com/omdsh-dev/dsh-mnemon/issues/240) | [归档目标](../../pr-assets/issue-240-runtime-archive/README.md) |
| `--runtime-write-scope` | 与 `MNEMON_CLI_PATH` 和 `--strategy-extensions` 一起使用，并启动全新临时夹具：工作记忆上限 512 字节，脚本模型限制子 Agent 调用次数，且需要真实的 create/update 回执。发送 `archive-scope-250`；`archive-scope-250 retry` 在新回合重试。`Runtime write scope:` | [#250](https://github.com/omdsh-dev/dsh-mnemon/issues/250) | [Runtime 写入范围](../../pr-assets/issue-250-runtime-write-scope/README.zh-CN.md) |
| `--legacy-session-replay` | 与 `--strategy-extensions` 一起使用：只有修复后的旧会话重放出历史 call/result ID 与正文时，回环续写服务器才作答。`Legacy replay:` | [#251](https://github.com/omdsh-dev/dsh-mnemon/issues/251) | [旧会话修复](../../pr-assets/issue-251-legacy-repair/README.zh-CN.md) |
| `--idle-review` | 与 `--strategy-extensions` 一起使用：防抖与最小尝试间隔均为 5 秒，每会话审查一次，审查写入后故意失败。连续发送两个至少 150 字符的用户回合。`Idle review:` | [#100](https://github.com/omdsh-dev/dsh-mnemon/issues/100)、[#255](https://github.com/omdsh-dev/dsh-mnemon/issues/255) | [空闲审查限制](../../pr-assets/idle-review-agent-team/README.zh-CN.md) |
| `--review-layers` | 空闲窗口 5 秒、每个会话只审查一次，审查先把一条事实写成档案，再写入工作记忆。按记录中验证数据的两轮发送。`Review layers:` | [#319](https://github.com/omdsh-dev/dsh-mnemon/issues/319) | [每轮审查只写一层](../../pr-assets/issue-319-review-layers/README.zh-CN.md) |
| `--strict-template` | 回环模型的行为与 Ollama 0.33 运行“要求用户查询的聊天模板”时一致，空闲审查 5 秒后运行、每会话一次。连续发送两个至少 150 字符的用户回合。`Strict template:` | [#327](https://github.com/omdsh-dev/dsh-mnemon/issues/327) | [子 Agent 的用户消息](../../pr-assets/issue-327-subagent-user-turn/README.zh-CN.md) |
| `--general-strategy` | 选中通用策略并停用分层策略。先发送 `general-strategy-check remember`，再发送 `general-strategy-check recall`。`General strategy:` | — | [主策略选择](../../pr-assets/main-strategy-choice-20260927/README.zh-CN.md) |
| `--second-runtime` | 只能与 `--general-strategy` 一起使用：在 Starter 的运行时 Source 旁再挂载一个 `mnemon-source-runtime-global`，数据目录单独存放。发送 `general-strategy-check remember`；`General strategy:` 组合行会给出 `otherRuntimeOffer` | [#397](https://github.com/omdsh-dev/dsh-mnemon/issues/397) | [默认运行时实例](../../pr-assets/issue-397-default-runtime-instance/README.zh-CN.md) |
| `--exact-id` | 与 `MNEMON_CLI_PATH` 一起使用：脚本化的写入与遗忘工作 Agent。依次运行 `/mnemon remember <内容>`、用 `/mnemon recall <关键词>` 读到 id，再运行 `/mnemon forget <ID>`。`Exact id:` | [#337](https://github.com/omdsh-dev/dsh-mnemon/issues/337) | [按精确 id 操作](../../pr-assets/issue-337-exact-id-actions/README.zh-CN.md) |
| `--archive-copies` | 与 `MNEMON_CLI_PATH` 一起使用：工作记忆接近 640 字节上限，每个条目在一个 Native 记忆空间中都有逐字副本，嵌入替身 12 秒后才响应（`MNEMON_E2E_EMBEDDING_DELAY_MS`）。在运行时记忆页面添加夹具输出的那一条。`Archive copies:` | [#339](https://github.com/omdsh-dev/dsh-mnemon/issues/339) | [归档回执](../../pr-assets/issue-339-archive-receipt-evidence/README.zh-CN.md) |
| `--save-action` | 与 `MNEMON_CLI_PATH` 一起使用：每轮都会收到一条值得保存的回复，脚本化的任务 Agent 写入收到的内容。用**存入记忆**保存一条回复，再修改已有回执的候选内容后再次提交。`Save action:` | [#342](https://github.com/omdsh-dev/dsh-mnemon/issues/342) | [修改后再存入](../../pr-assets/issue-342-edited-save/README.zh-CN.md) |
| `--profile-compaction` | 把 USER.md 上限设为 100 字节，并关闭空闲审查。分三条消息发送 `记住：回答尽量简洁，不要冗长的开场白。`、`记住：回答使用简体中文。` 和 `记住：汇报时先列出阻塞项。`。`Profile compaction:` | [#356](https://github.com/omdsh-dev/dsh-mnemon/issues/356) | [子 Agent activation](../../pr-assets/issue-356-subagent-activation/README.zh-CN.md) |
| `--remember-target` | 预置中文 Lumen 项目（其中「调研归档」空间已停用），除非由 `--docs-demo` 预置。先发送 `remember-target-check`，再发送 `remember-archive-check`。`Remember target:` | [#387](https://github.com/omdsh-dev/dsh-mnemon/issues/387) | [指定的记忆空间](../../pr-assets/issue-387-explicit-space-target/README.zh-CN.md) |
| `--recall-budget` | 预置中文 Lumen 项目（除非由 `--docs-demo` 预置），并使用一个在同一回合内提出三个不同召回问题的模型。发送 `recall-budget-check`。`Recall budget:` | [#389](https://github.com/omdsh-dev/dsh-mnemon/issues/389) | [召回预算](../../pr-assets/issue-389-recall-budget/README.zh-CN.md) |

`--archive-copies` 的慢速嵌入服务也可以单独运行，供 Mnemon CLI 探测使用，或作为 Mnemon Native 嵌入设置中的 Endpoint。`node scripts/fixtures/fake-embeddings.mjs` 在 `http://127.0.0.1:<端口>` 提供 Ollama API，在 `http://127.0.0.1:<端口>/v1` 提供 OpenAI 兼容 API，为每段文本返回确定的向量，并为每个嵌入请求输出一行 `Fake embeddings:`：

- `--port <n>` 指定端口（默认取空闲端口），`--port-file <文件>` 写入实际使用的端口；
- `--delay-ms <毫秒>` 让每个嵌入响应延迟返回，模型列表不受影响，如同响应缓慢的服务；
- `--missing-model` 让服务保持可用但没有该模型：Mnemon 认为服务可用，而每个嵌入请求都返回 404；
- `--model <名称>` 指定它列出的模型，默认为 `nomic-embed-text`。

`MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm exec vitest run tests/fake-embeddings-fixture.spec.mjs` 还会用真实的 Mnemon CLI 通过两种协议检查它。

### 较早的记录

[2026-09-04 main rebase 验证记录](../../pr-assets/main-rebase-20260904/README.md)列明精确的 v0.4.7/DSH rc.1 revision、registry 与源码覆盖完整测试、独立制品、插件组合重启持久化和真实双入口验证及其限制。

[2026-08-30 npm 回归记录](../../pr-assets/npm-sidebar-cli/README.md#简体中文)保留了旧 Taskboard/SSH 与 CLI 调查。已移除的历史夹具不是当前 checkout 的命令；当前 WebUI 验证使用 `pnpm e2e:serve`。

## 发布

官方包采用独立版本，Starter 固定经过验证的组合。Changeset、冻结制品、Registry 验证与失败恢复见[发布流程](./releasing.md)。

## 文档、存储与历史证据

保持中英文页面一致、公开示例可执行。Mermaid 表达归属和流程；真实截图位于 `docs/assets`。不保留空目录占位或历史转发文件。

没有明确迁移方案与测试前，保留持久格式及配置键。存储改动须验证锁、原子 rename、修订、损坏输入和复制数据根上的升级/回退。

v0.3 benchmark 是冻结的历史结果，不是本架构的性能证明。失效的可执行评估框架已移出工作树；[发布记录](../releases/v0.3.0.md) 链接到固定版本历史源码。当前验收入口为上述脚本。
