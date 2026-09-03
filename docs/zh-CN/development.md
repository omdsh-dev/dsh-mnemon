# 开发与验证

**简体中文** | [English](../en/development.md) | [文档中心](./README.md)

## 环境

发布的插件仍为较旧且兼容的 DSH Host 保留 Node.js 20 engine 下限。Registry-backed 开发基线现为稳定的 DSH 0.1.2-rc.1；所有直接使用的 DSH package 都精确固定到该版本，`dsh-invariants` 补齐必需的 peer 集合，`dsh-client-store` 则提供已发布 UI Slots 声明所引用的公共 selector 类型。CI 还会在 Node 24 上检出它的直接前身 DSH 0.1.2-alpha.5 tag，构建 Harness、链接同一组构建期 package，并运行 Mnemon 完整验证链。常规矩阵在 Node.js 22.19 和 24 上运行 Linux，并在 Node.js 24 上运行 Windows；Node 24 构建后还会切换 Node 20，导入全部 Node-compatible 发布子路径作为插件运行时兼容 smoke。

安装依赖：

```sh
pnpm install
```

## Session projection 兼容性

Mnemon 的 child-local token-usage projection 同时支持两代 DSH 契约：0.1.0 的 `schema` / `view`，以及 0.1.1 和受支持 0.1.2 预发布版的 `stateSchema` / `wire`。两组入口共用同一份 wire schema 和 view 函数。内部状态和 `stateVersion: 1` 保持不变，因此在这些 Host 之间升级或回滚时可以继续使用缓存状态。

```sh
pnpm exec vitest run tests/subagent-token-usage-host.spec.ts tests/subagent-token-usage.spec.ts tests/client-subagent-token-usage.spec.tsx
```

Host 测试使用真实 DSH Session，分别运行已发布的 0.1.0-rc.8 registry 和当前激活的 0.1.2-rc.1 registry，覆盖实时快照、离线重放、checkpoint 恢复、跨版本状态和变更通知。旧版 npm alias 仅用于测试，是开发依赖，不会替换实际 Host。源码验证会将当前 registry 直连替换为 alpha.5 构建期 package，并包括 Store 与 Invariants。

## DSH 0.1.2-alpha.5 源码兼容

`package.json` 与 lockfile 保持稳定的 0.1.2-rc.1 基线，只在构建完成的 alpha.5 Harness 检出上覆盖生成的 `node_modules` 直连。这样可以继续覆盖其直接前身的 alpha 契约，而不会把 alpha 重新变成 package 的依赖基线：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout dsh-v0.1.2-alpha.5
pnpm --dir deepseek-harness install --frozen-lockfile
pnpm --dir deepseek-harness run build:lib

pnpm install --frozen-lockfile
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness pnpm run dsh:link-source
pnpm_config_verify_deps_before_run=false pnpm run verify
```

链接命令会先校验每个 package 名称与 alpha 版本，在生成的 `node_modules` 中记录现有 registry 直连，然后才执行替换；它不会修改 `package.json` 或 `pnpm-lock.yaml`。对这一显式源码覆盖，应按上面的命令关闭 pnpm 11 的运行前自动依赖安装；否则它可能在验证前静默还原 registry 包。验证后运行 `pnpm_config_verify_deps_before_run=false pnpm run dsh:restore-registry` 即可精确恢复记录的链接。兼容工作覆盖已移除的 client runtime、由 controller/renderer 新归属的客户端服务、Store-backed selector 类型、可扩展 locale ID、Workspace snapshot 变化，以及无分支的双世代 Host RPC 注册。

### 兼容性研究结论

[上游 0.1.2-rc.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) 汇总了一条远超插件接口的 alpha 发布线；[完整比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-rc.1) 同时覆盖 Client、Host、SDK、profile、持久化、UI 与生成参考。与 Mnemon 直接相关的结论如下：

- `@deepseek-ai/dsh-client-runtime` 已删除。Session / Workspace 状态分别归属 API controller，可观察契约归属 `dsh-client-store`，`ctx.slots` 归属 UI renderer。
- `conversation.chat.turnTail` 等 Chat 专属 slot contract 已移出 target-neutral conversation package；Mnemon 现在只声明 selector 所需的最小边界，不再导入旧 owner。
- Workspace 列表不再提供 `recentWorkspaceId`；Mnemon 优先匹配当前 session 的 canonical cwd，否则选择首个可用 workspace。
- 第三方语言包可以扩展 locale ID；Mnemon 会把未知 active locale 原样传给日期格式化，自身词典仍经 DSH locale fallback 解析。
- `HostConnectionRpc.handle()` 不再接受逐方法 authority 选项；0.1.2 的所有 RPC 与 stream 统一要求由启动 token 建立的浏览器会话。Mnemon 仍保留旧 rc.2 的 `remoteAccess` 配置，并始终传入 rc.2 所需的末尾 authority 对象：rc.2 会使用它，0.1.2 的双参数 JavaScript 实现会忽略它。整个过程不解析版本、不检查函数参数数量，也没有 capability 分支。
- 旧 ApiProxy transport 已由 Remote/gateway API 取代；Mnemon 使用的 generic Connection channel 仍受支持。Headless 进度改写 stderr，不影响插件对 stdout 结果的断言。
- DSH 新增 subagent 模型配置并调整 token 统计，但官方 lineage 行仍读取通用的完整日志 projection；Mnemon 因此保留 child-local projection wrapper，并针对 rc.1 与 alpha.5 两套 slot ledger 验证。
- DSH 0.1.1-rc.2 通过 `session.events` 暴露完整日志；alpha.4 及之后版本（包括 0.1.2-rc.1）改用 `snapshotEvents()` 与 `eventAt()`。Mnemon 通过能力检测读取该接口，优先使用 snapshot，并回退到旧 rc 属性，无需解析版本字符串。

仓库将精确的 0.1.2-rc.1 依赖闭包作为稳定 registry 基线提交；专用的源码覆盖 CI job 继续作为 alpha.5 兼容性的可复现事实源。[隔离 WebUI 证据](../pr-assets/dsh-rc1-compat/README.md)记录了 rc.1 工作流以及对上一版 rc.2 的向后回归验证。

## 标准命令

```sh
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest run
pnpm run build      # declarations + host/client bundles
pnpm run verify     # typecheck + tests + reproducible build + package validation
```

## 目录结构

```text
packages/
+-- contracts/                 # 纯 JSON/wire 记忆契约
+-- kernel/                    # Catalog、Topology、Plan/Receipt、Guard
+-- layer-runtime/             # 默认 Runtime Layer
+-- layer-documents/           # 默认 Documents Layer
+-- layer-memory-spaces/       # 默认 Memory Spaces Layer
+-- strategy-default-three-tier/ # 默认兼容策略与拓扑
+-- strategy-sdk/              # Strategy manifest 与 replay
+-- provider-sdk/              # Adapter Factory Registry
+-- extension-sdk/             # Host 扩展生命周期
src/
+-- index.ts                  # Host composition root
+-- config.ts                 # settings schema
+-- process.ts / runner.ts    # local CLI execution
+-- service.ts                # durable-memory facade
+-- memory-bodies.ts          # Memory Space registry
+-- runtime-memory.ts         # hot-memory authority
+-- documents.ts              # managed Documents
+-- subagent.ts               # bounded workers
+-- lifecycle.ts              # root 钩子与子 Agent 权限所有权
+-- agent-memory-turn.ts      # 回合 pin 与子 Agent 委托保留
+-- review-activity.ts        # activity score
+-- tools.ts / commands.ts    # model and human interfaces
+-- rpc.ts / settings.ts      # Web bridges
+-- storage-scope.ts          # storage inventory
+-- shared/contracts.ts       # Host/Client wire contract 唯一事实源
+-- client/                   # React workspace and locales
tests/                        # Vitest suites
scripts/                      # 确定性构建与发布包检查
lib/                          # 生成且忽略的发布产物
docs/zh-CN/                   # Chinese documentation
docs/en/                      # English mirror
cordis.patch.yml              # DSH profile bundle patch
```

## 构建产物

```text
tsdown（读取 src/ 与 packages/）
  -> lib/index.js             Node ES2024 ESM Host
  -> lib/client.js            DSH browser module wrapper
  -> lib/contracts.js         wire-safe contracts
  -> lib/kernel.js            composable memory kernel
  -> lib/{extension,provider,strategy}-sdk.js
  -> lib/layers/*.js          default Layer entries
  -> lib/strategy-default-three-tier.js

tsc -p tsconfig.types.json
  -> lib/types/src/**/*.d.ts
  -> lib/types/packages/**/*.d.ts

lightningcss plugin
  -> CSS Modules compiled and injected as scoped <style>
```

Host 将所有 package dependency 保持为 external。Client 将 React、ReactDOM、JSX runtime、Cordis 和 DSH UI primitives 保持为 external；来自 `node_modules` 的依赖只允许打入 `markdown-to-jsx`。

`lib/` 是发布输入，但已被 Git 忽略，禁止手工编辑。`pnpm run verify:build` 会连续构建两次并比较每个输出文件的 hash；CSS export 顺序或其他非确定性变化会直接失败。

`packages/contracts` 是可组合记忆插件边界的纯 JSON 事实源，不得依赖 Cordis、DSH、React、Node-only 数据面或 Provider SDK。`src/shared/contracts.ts` 仍是配置结构、RPC 通道、设置协议和 Client 可见 DTO 的唯一事实源；它可以引用纯记忆契约。`src/client/` 下的文件只能通过这些 contract 导入父级模块。Host 模块可以为兼容性 re-export 类型，但不应重新定义 wire DTO。

## Workspace 与发布策略

内部 workspace 全部保持 `private`，不单独发布。版本、构建与回退以根 `dsh-mnemon` 为原子单位；公开兼容承诺只针对 `package.json#exports` 中的 `dsh-mnemon/*` 子路径。增加公共入口时必须同时更新 tsdown entry、声明 include、package exports、发布包白名单、publint / attw 与双语扩展文档。

默认 Layer 与 Strategy 不应依赖根 Host 组合。现有 Runtime、Documents、Memory Spaces 控制器继续位于 `src/`，作为兼容数据面由 Host 组装；新扩展通过 Catalog 注册，不得修改硬编码前端 enum。组件注册必须返回 disposer，并覆盖重复 ID、运行中注册、卸载与旧 Plan 失效测试。

## 测试层次

现有 Vitest 套件覆盖：

- 配置解析、CLI 查找、进程串行；
- Catalog/Topology generation、参与模式、Strategy 越权、Guard 变化、Plan/Receipt 与 stale plan；
- Extension Host 的预注册、运行中注册、热卸载、Cordis 生命周期和 Strategy replay；
- Memory Space 发现、激活、路由与合并；
- recall payload 兼容和图谱解析；
- Runtime JSON/Markdown 一致性、锁、容量、UTF-8 和 revision；
- Documents 路径、frontmatter、搜索、LRU、归档与冲突；
- worker 工具隔离、schema 子集、结构化回执；
- 生命周期 cue、评分、idle debounce、取消和水位保留；
- 异步子 Agent 的 View / 运行图保留、逐回合预算、缓存隔离、嵌套委托、取消、回收和销毁；
- 真实 rc.1 / alpha.5 Connection 注册、旧 rc.2 RPC authority、认证、只读行为和设置 revision；
- Web 工作台、双语文案和关键交互；
- 不依赖 Web 专有服务的核心激活，以及 Headless 按 Agent cwd 路由；
- Client/Host 源码边界、确定性构建 hash、发布包内容、exports 和 TypeScript 解析。

这些主要是临时目录、fake runner 和 mock Host 集成测试。`async-subagent-host.spec.ts` 额外使用真实 DSH Agent loop、scoped event、工具流水线、continuable subagent manager 和 JSONL 持久化，仅把模型与记忆 Provider 替换为脚本模拟；验证父回合结束并切换运行图后的延迟 Recall，以及冷恢复后的新权限与预算。其 DSH 直接测试依赖保持既有已发布基线，并纳入 alpha 源码链接覆盖。`verify:headless` 会构建包、安装到隔离的真实 DSH Headless profile、启动本地模拟模型，并断言代表性 Mnemon 工具进入模型请求。真实 DSH + Mnemon WebUI 的自动化端到端测试仍是独立工作。

## v0.3 发布 Benchmark

`scripts/evaluation/v0.3` 提供隔离的 mock/真实 Provider harness、跨版本数据兼容、direct retrieval 和可恢复 release suite。完整参数、evidence 结构与安全边界见[评测 Harness 说明](../../scripts/evaluation/v0.3/README.md)。正式 A/B 必须固定 baseline/current commit、DSH、模型、场景配置和输出目录；真实 Provider 的 token 与 wall 只表示该环境下的观测，不是普遍性能承诺。

```sh
node scripts/evaluation/v0.3/release-suite.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-release

node scripts/evaluation/v0.3/release-suite.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-recall-gates \
  --only recall-gate-natural,recall-gate-fault \
  --versions current

node scripts/evaluation/v0.3/compatibility.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --output /private/tmp/dsh-mnemon-v03-compatibility.json

node scripts/evaluation/v0.3/retrieval-benchmark.mjs \
  --baseline-root /path/to/clean/v0.2.16-worktree \
  --repetitions 5 \
  --output /private/tmp/dsh-mnemon-v03-retrieval.json
```

[v0.3.0 发布说明中的 Benchmark 表格](./releases/v0.3.0.md#benchmark-与行为验证)是 2026-08-24 冻结结果的公开发布记录。公开的[评测 Harness 说明](../../scripts/evaluation/v0.3/README.md)记录场景、方法、安全边界与复跑命令；每次运行会把机器可读指标和运行证据写入调用者指定的输出目录。含合成对话的原始 request/session trace 与本机路径刻意不提交。这样，公开发布结论保持自包含，不链接私有工作归档。

## 真实 WebUI 验证

npm 页面切换与 CLI 状态的隔离回归脚本见 [npm 发布版 Web UI 回归](./testing-npm-regressions.md)。

发布前使用隔离环境，避免污染个人记忆：

```text
temporary DSH_HOME
temporary MNEMON_DATA_DIR or custom storageScope
temporary workspace
independent Web port
local link installation
```

建议场景：

1. 空根：UI 不报错，能够创建第一个 Memory Space。
2. 普通对话：只出现短 cue，不强制 recall 或写入。
3. 历史问题：Agent 自主 recall，并返回正确 space provenance。
4. 显式沉淀：worker 查重、选择范围并可被再次召回。
5. 多空间：读取只覆盖 active，写入 inactive 后自动激活。
6. Runtime：USER / MEMORY add、replace、remove 和投影一致。
7. Documents：创建、检索、更新、人工归档和原项目文件不变。
8. 评分审查：轻任务不触发；达标后等待 idle；新 turn 能取消并保留水位。
9. 只读：写工具、写命令和写 RPC 被拒绝，读取仍可用。
10. Sidebar：四个一级标签、记忆体四个二级标签、固定页头、筛选与加载更多均正常。
11. 对话内交互：本回合记忆只在已完成且有活动的回合出现；跳转目标正确；存入记忆取消不写入。
12. 设置：存储范围、`displayMode` 与两个对话开关保存后实时生效；`tabEnabled` 控制所选入口，Sidebar 与 Builtin 不会同时挂载。Builtin 共用所有页面与弹窗、隐藏范围控件，按所属会话映射全局/工作区/自定义读写，并在切换会话时清理旧数据与编辑器。
13. ZIP：导出后可预检，并能在隔离 custom 根完成合并恢复；损坏 checksum 必须拒绝。
14. 版本：检查不会安装；link / 手工来源不显示不安全更新；更新完成后自动重新检查状态。
15. 状态和浏览器控制台：无未处理错误或警告。

容量极限、CLI 超时、revision 冲突和 Host 重启应在专用故障注入环境验证。

## 维护文档视觉素材

公开 UI 截图统一位于 `docs/assets/screenshots/`，中英文文档复用同一组实机画面；语言相关架构图分别保存在 `docs/assets/diagrams/zh-CN/` 与 `docs/assets/diagrams/en/`。界面结构、主要文案或默认行为变化时：

1. 使用真实 DSH Web profile，但先检查画面中没有 token、凭据或不应公开的个人数据；
2. 主截图与视频以 1600×900 标准宽屏为基线，不再使用窄视口作为发布主素材；
3. 完整录制页面向下与向上滚动，并覆盖筛选、重复点击、切换、展开、弹窗和精确跳转等按钮状态；
4. 写入、更新组件和保存设置停在最终确认前；使用公开测试数据的只读 Agent 查询可以真实执行，并应录到等待和结果；
5. 覆盖同职责截图，避免按版本不断累积文件名；只有新增用户任务时才增加素材；
6. 同步 README 海报、GIF / MP4 演示和 `ui-guide.md`；
7. 检查 PNG / JPEG 扩展名与真实编码一致，并在原始分辨率下确认文字可读；
8. 删除已无引用、展示过时布局或术语过时的截图；
9. 运行链接与图片检查，再人工打开中英文 README 和 UI 指南。

README 演示资源位于 `docs/assets/media/dsh-mnemon-memory-system-demo.*`。演示顺序应覆盖状态、运行时、档案、记忆体、Provider 与弹窗交互；既要展示整体上下滑动，也要展示关键按钮的两种状态。自动化不得真正提交记忆、更新组件或保存设置，但可以执行安全的只读 Agent 查询。

## 修改 subagent schema

Mnemon 的一次性结果工具采用 DSH 工具参数支持的紧凑 JSON Schema 子集：

```text
type, oneOf, properties, required, additionalProperties,
items, enum, const, and annotation keywords
```

不要加入 `maxItems` 等不受支持关键字。`assertDshOutputSchema()` 会在注册结果工具前递归拒绝未知 schema 键；结果数量等限制由 persona 和 Host parser 双重实现。

## 修改存储格式

Runtime、Documents 和 Memory Space registry 都带版本字段或固定结构。修改时需要：

1. 明确旧格式解析策略；
2. 增加迁移或拒绝路径；
3. 保证临时文件与原子 rename；
4. 补充并发和损坏输入测试；
5. 更新中英文存储、运维和 Roadmap 文档；
6. 在复制的数据根上完成升级/回退验证。

当前没有正式 schema migration 框架，不应静默改变持久格式。

## 文档国际化维护

`docs/zh-CN` 与 `docs/en` 应保持同名文件和相同章节职责。修改默认值、流程或限制时：

- 同步两种语言；
- 保持命令、配置键、路径和代码符号完全一致；
- 使用相对路径互链对应语言页面；
- 架构总览优先使用可访问、无脚本和无外部资源的 SVG；目录树、命令、公式与短协议仍使用可复制的 `text` / ASCII；
- 根 README 只保留摘要，把细节放到单一权威 docs 页面；
- 所有用户可感知界面变化同步检查 `ui-guide.md`、`getting-started.md`、`configuration.md` 与 `operations.md`。

Web locale 变更时，中文键集合仍是类型事实源；英文词典必须满足 `Record<MnemonKey, string>`，并保持占位符一致。

## 发布检查

```text
[ ] pnpm run verify
[ ] 确认 worktree 中没有生成的 lib diff
[ ] 确认发布包只包含运行时、声明、根文档和 cordis.patch.yml
[ ] 从打包产物导入每个公开 `dsh-mnemon/*` 子路径
[ ] 验证运行中注册/卸载扩展会更新 generation，且旧 Plan 被拒绝
[ ] install the built/local bundle into an isolated Web profile
[ ] confirm `verify:headless` activates the built bundle in an isolated Headless profile
[ ] run real Mnemon CLI and WebUI smoke tests
[ ] verify Chinese and English workspaces
[ ] verify global/workspace/custom paths as applicable
[ ] record tested DSH and Mnemon versions
[ ] record the evaluated product/baseline commits, model, scenario matrix, and release-gate result
[ ] distinguish behavioral gates from environment-specific token and latency observations
[ ] back up any data root used for upgrade testing
```

`package.json.files` 当前发布 `lib`、patch、两份根 README、`SECURITY.md` 和 License。文档站点与媒体继续保留在 GitHub，不进入 npm 包。

## 发布到 npm

发布后 `dsh plugin --profile web add dsh-mnemon` 即按 registry 名称解析（与 dsh-better-sidebar 同路径）。发布步骤：

```sh
pnpm run verify
npm pack --ignore-scripts
npm publish dsh-mnemon-<version>.tgz --access public --ignore-scripts
```

发布已经打好的 tarball，能确保 npm 收到的就是人工检查过的制品。GitHub release workflow 会在核对 tag 与 `package.json` 后执行同一流程。

凭据约定：NPM_TOKEN 只写入用户级 `~/.npmrc`（`npm config set "//registry.npmjs.org/:_authToken" "${NPM_TOKEN}" --userconfig ~/.npmrc`），发布后删除。**不要**把凭据行提交进仓库 `.npmrc`：pnpm 11 出于安全会忽略项目级 `.npmrc` 中未展开的环境变量凭据并告警，且该文件会随仓库传播。

2FA 注意：若 npm 账号开启发布级两步验证，交互发布直接执行 `pnpm publish --access public`，按提示输入 OTP；脚本/CI 发布需改用 Classic **Automation** 令牌或允许 bypass 2FA 的 Granular 令牌（`npm login` 生成的普通令牌无法发布，会报 403 Two-factor authentication required）。

发布前核对 `package.json` 的 `repository`/`homepage`/`bugs` 指向 `omdsh-dev/dsh-mnemon`（npm 页面与 GitHub 保持一致），并确认版本号已递增。
